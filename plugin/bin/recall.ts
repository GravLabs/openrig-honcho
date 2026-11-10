// T14d-2 (ADR-0009) as rewired by T16b (ADR-0011 decisions 1, 2, 3, 7): the
// recall hook. A synchronous UserPromptSubmit hook that runs BEFORE the async
// writer: when the prompt is a same-rig peer message, QUERY what the rig's
// memory holds that is RELEVANT to the message body - three parallel
// conclusions queries inside a 2.5 s wall budget - and print it as
// additionalContext. Silent on every failure path (S1), exit 0 always,
// nothing on stderr, exactly one log event per run. Model: session-start.ts
// (prints additionalContext inside a budget) and user-prompt.ts (stdin,
// config, kill switch).
//
// Gate order (ADR-0011 decisions 3-4): not a peer sender -> "not-peer";
// sender of another rig -> "not-rig"; acknowledgement-shaped body -> "terse"
// - all three before any network. The context floor, the duplicate/trivia
// filters and the counts live in src/recall.ts; the counts reach the log
// line here (decision 7).
//
// HONCHO_RECALL: "off" (trimmed, case-insensitive) disables this hook only -
// exit 0, nothing logged, nothing fetched, like the kill switch. Any other
// value or unset is on. It lives here, not in env.ts Config: the flag means
// nothing to any other hook, and Config is the shared contract every hook
// fixture builds.
import { attribute } from "../src/attribute.ts";
import type { Config } from "../src/env.ts";
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { appendHeld, heldPath } from "../src/held.ts";
import { createClient } from "../src/honcho.ts";
import { bindEventFields, errorClassFrom, logConfigProblem, logEvent } from "../src/log.ts";
import { normalizeMission, readRigMission, readSeatState, seatStatePath } from "../src/missions.ts";
import { takeOnce } from "../src/once.ts";
import {
  isTerseBody,
  nextSeen,
  recallPairs,
  recallQueryText,
  recallSender,
  recallSkip,
  renderRecall,
  type RecallItem,
} from "../src/recall.ts";
import { knownTermsFromRollout, knownTermsFromTranscript, readTranscriptTail } from "../src/terms.ts";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
// C2 (ADR-0016): shared stdin seam + the one output writer. UserPromptSubmit
// fields are identical on both harnesses (probe C1 §1); --harness is accepted
// and needs no mapping here.
import { readStdin, resolveHarness, writeHookJson } from "../src/harness.ts";
import { harnessUnknownWithSettings, readSettingsFile } from "../src/settings.ts";

/** ADR-0009 decision 4: the whole fetch phase holds to 2.5 s of wall time -
 * the client caps its own timeout here AND the race is the outer wall.
 * ADR-0011 decision 1: the three queries share this ONE budget.
 * T16g (architect 18:55Z): at the wall the hook renders the queries that
 * already finished (partial count + timeout flag); silence only when none
 * did - see the fetch section below. */
const FETCH_BUDGET_MS = 2500;
const BUDGET: unique symbol = Symbol("recall-budget");

// C5a: takes the MERGED env - a Codex settings file can carry HONCHO_RECALL.
const recallOff = (env: Record<string, string | undefined>): boolean =>
  (env.HONCHO_RECALL ?? "").trim().toLowerCase() === "off";

const seenPath = (cfg: Config): string =>
  seatStatePath(cfg.stateDir, cfg.workspace, cfg.peer).replace(/\.json$/, ".recall.json");

interface SeenFile {
  session?: string;
  ids: string[];
  /** ADR-0011 decision 2 (T16b): hashes beside ids. An OLD ids-only file
   * still loads - absent hashes are simply "none". */
  hashes: string[];
}

/** Missing or bad file = no seen state (a first run, not an error). */
function readSeen(file: string): SeenFile | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw === "object" && raw !== null) {
      const o = raw as { session?: unknown; ids?: unknown; hashes?: unknown };
      if (Array.isArray(o.ids) && o.ids.every((x) => typeof x === "string")) {
        return {
          ...(typeof o.session === "string" ? { session: o.session } : {}),
          ids: o.ids as string[],
          hashes:
            Array.isArray(o.hashes) && o.hashes.every((x) => typeof x === "string")
              ? (o.hashes as string[])
              : [],
        };
      }
    }
  } catch {
    // unreadable or unparsable: start without seen state
  }
  return undefined;
}

/** 0600, written atomically (temp + rename). A separate file from the seat
 * state on purpose: the async writer hook rewrites that one at the same
 * moment, and two writers on one file lose updates. */
function writeSeen(file: string, state: { session: string; ids: string[]; hashes: string[] }): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(state));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // C2b (review F3): the flag; C4 (review F2): the harness selects which
  // transcript format the novelty filter reads. C2c (review F4): the flag
  // rides this run's ONE event line, bound here.
  const { harness, flagUnknown } = resolveHarness(process.argv.slice(2));
  if (flagUnknown) bindEventFields({ harness_unknown: 1 });
  // O1: exactly one structured event per hook run (see user-prompt.ts)
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    // C5a (ADR-0016 decision 9): settings file under the environment (see
    // session-start.ts); a broken file = plugin off for this run, exit 0.
    // The merge runs BEFORE the recall-off check: the flag can be set in the
    // file, and it reads the merged value exactly like a real variable.
    let env: Record<string, string | undefined> = process.env;
    if (harness === "codex") {
      const s = readSettingsFile(process.argv.slice(2));
      if (s.problem !== null) {
        logConfigProblem(process.env, "UserPromptSubmit", s.problem);
        process.exit(0);
      }
      env = { ...s.vars, ...process.env };
    }
    // C5a2 (review O2): an unresolved --harness next to --settings IS the
    // cause; name it instead of blaming the missing URL.
    const harnessProblem = harnessUnknownWithSettings(process.argv.slice(2), flagUnknown);
    if (harnessProblem !== null) {
      logConfigProblem(process.env, "UserPromptSubmit", harnessProblem);
      process.exit(0);
    }
    if (recallOff(env)) process.exit(0); // off for this hook only: silent, unlogged
    const loaded = loadConfig(env);
    if (!loaded.enabled) {
      if (!isKillSwitch(loaded.reason)) {
        logConfigProblem(process.env, "UserPromptSubmit", loaded.reason);
      }
      process.exit(0);
    }
    cfg = loaded;
    // T15a (ADR-0010 decision 2): the once-guard - a duplicate copy of this
    // event (two installs, byte-identical stdin) leaves silently. The
    // HONCHO_RECALL flag and the kill switch above are checked first: off
    // means off, unlogged, exactly as before.
    if (!takeOnce(cfg.stateDir, cfg.workspace, "recall", raw)) {
      logEvent(cfg, { hook: "recall", event: "duplicate-run", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    let input: { prompt?: unknown; session_id?: unknown; transcript_path?: unknown } = {};
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      // garbage stdin: nothing to recall
      logEvent(cfg, { hook: "recall", event: "error", ok: false, ms: Date.now() - t0, bytes: 0, n_items: 0, error_class: "parse" });
      process.exit(0);
    }
    // ADR-0009 decision 1: the same parser and context the writer uses.
    // T16b item 6: cfg.rig (loadConfig, from OPENRIG_SESSION_NAME) so writer
    // and recall always attribute the same rig; workspace only as fallback.
    const attr = attribute(typeof input.prompt === "string" ? input.prompt : "", {
      selfPeer: cfg.peer,
      ownerPeer: cfg.ownerPeer,
      rig: cfg.rig ?? cfg.workspace,
      recordAutomation: cfg.recordAutomation,
      isExistingPath: (p) => {
        try {
          return existsSync(p);
        } catch {
          return false;
        }
      },
    });
    const sender = recallSender(attr, cfg.peer);
    if (sender === null) {
      // not a same-rig peer message: no network at all (the writer records
      // it). ADR-0011 decision 3: another rig logs its own reason.
      logEvent(cfg, {
        hook: "recall",
        event: recallSkip(attr, cfg.peer) ?? "not-peer",
        ok: true,
        ms: Date.now() - t0,
      });
      process.exit(0);
    }
    if (attr.kind === "peer" && isTerseBody(attr.content)) {
      // ADR-0011 decision 4: an acknowledgement body has nothing to search.
      logEvent(cfg, { hook: "recall", event: "terse", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    const query = recallQueryText(attr.content);
    const queryChars = query.length;
    const mission = normalizeMission(readRigMission(cfg.stateDir, cfg.workspace).mission);
    // ADR-0011 decision 1: three pairs - self about sender, scope about
    // sender (both feed "About"), self about self (feeds "You, earlier").
    const pairs = [
      ...recallPairs(cfg.peer, sender, mission),
      { observer: cfg.peer, observed: cfg.peer },
    ];
    // ADR-0011 decision 2: the seat's recorded context start, if any; a
    // missing seat state or field leaves the 30-minute fallback in play.
    const seat = readSeatState(seatStatePath(cfg.stateDir, cfg.workspace, cfg.peer));
    const contextStart =
      typeof seat?.context_start === "string" ? seat.context_start : undefined;
    const client = createClient({
      url: cfg.url,
      workspace: cfg.workspace,
      apiKey: cfg.apiKey,
      timeoutMs: Math.min(cfg.timeoutMs, FETCH_BUDGET_MS),
    });
    // T16g item 2 (architect ruling 18:55Z): RENDER WHAT FINISHED. Each of
    // the three queries records its own result the moment it answers; when
    // the wall fires, the finished ones render and the unfinished are only
    // counted (partial = did not produce an answer, plus a timeout flag on
    // the event). Silence remains when NOTHING finished: one slow pair now
    // costs one section, not the whole block (replaces review's R1 premise -
    // the shared embedding host spiking can no longer switch recall off
    // exactly when it is busy).
    const results: (Awaited<ReturnType<typeof client.queryConclusions>> | undefined)[] =
      pairs.map(() => undefined);
    const allDone = Promise.all(
      pairs.map(async (p, i) => {
        results[i] = await client.queryConclusions({
          query,
          top_k: 4,
          distance: cfg.recallMaxDistance ?? 0.45,
          filters: { observer: p.observer, observed: p.observed },
        });
      }),
    );
    // T19c (ADR-0014 decision 4): the novelty filter's known set, built
    // while the three queries above are already in flight (the row: the
    // read+scan stays out of the network path). The LAST 1 MB (TAIL_BYTES) of the
    // transcript only, from the end; a missing, unreadable or absent
    // transcript_path gives an empty known set - which can never drop an
    // item (every drop needs >= 1 distinctive term in it), i.e. no filter.
    // The minimum block stays on regardless: it is the switch's rule.
    let knownTerms: Set<string> | undefined;
    // C4 (review F2): rollout read failures are reported once, as counts
    // only (no paths, no content), attached to this run's single event.
    const rolloutNote: Record<string, number> = {};
    if (cfg.novel === true) {
      const tp = typeof input.transcript_path === "string" ? input.transcript_path : "";
      const tail = tp !== "" ? readTranscriptTail(tp) : undefined;
      if (harness === "codex") {
        // the same 1 MB tail and grammar, the rollout record shape (C4):
        // user/assistant message text only. Unreadable or bad lines degrade
        // exactly like the Claude path (no terms, no crash).
        const r = knownTermsFromRollout(tail ?? "", attr.content);
        knownTerms = r.known;
        // Only when a path was actually given: with no transcript_path the
        // run had nothing to read, and an empty marker would be noise
        // (architect add-on from the C4 review, 00:51Z).
        if (tp !== "") rolloutNote.rollout_seen = 1; // the Codex novelty path ran at all (C4)
        if (tail === undefined && tp !== "") rolloutNote.rollout_unreadable = 1;
        else if (r.badLines > 0) rolloutNote.rollout_bad_lines = r.badLines;
      } else {
        knownTerms = knownTermsFromTranscript(tail ?? "", attr.content);
      }
    }
    const raced = await Promise.race([
      allDone,
      new Promise<typeof BUDGET>((resolve) => {
        setTimeout(() => resolve(BUDGET), FETCH_BUDGET_MS);
      }),
    ]);
    const wallHit = raced === BUDGET;
    const finished = results.filter(
      (r): r is NonNullable<(typeof results)[number]> => r !== undefined,
    );
    if (wallHit && finished.length === 0) {
      // the abandoned requests die with this process (session-start.ts note)
      logEvent(cfg, { hook: "recall", event: "timeout", ok: false, ms: Date.now() - t0, bytes: 0, n_items: 0, error_class: "timeout", query_chars: queryChars, partial: pairs.length });
      process.exit(0);
    }
    const failed = finished.find((r) => !r.ok);
    if (!wallHit && failed !== undefined && finished.every((r) => !r.ok)) {
      // all three answered, all failed: the error event (ADR-0011
      // decision 1). O1/X1: class only, never the error string
      logEvent(cfg, {
        hook: "recall",
        event: "error",
        ok: false,
        ms: Date.now() - t0,
        bytes: 0,
        n_items: 0,
        error_class: errorClassFrom(failed.kind, failed.status),
        query_chars: queryChars,
      });
      process.exit(0);
    }
    // some finished (or all answered, some failed): render from what is
    // here; unfinished and failed are only counted (T16g rule).
    const partial = results.filter((r) => r === undefined || !r.ok).length;
    const toItems = (i: number): RecallItem[] => {
      const r = results[i];
      return r !== undefined && r.ok
        ? r.data.map((c) => ({ id: c.id, content: c.content, at: c.created_at ?? "" }))
        : [];
    };
    const aboutSender = [...toItems(0), ...toItems(1)];
    const aboutSelf = toItems(2);
    const session = typeof input.session_id === "string" ? input.session_id : "";
    const prev = readSeen(seenPath(cfg));
    const sameSession = prev !== undefined && prev.session === session;
    const view = renderRecall({
      sender,
      aboutSender,
      aboutSelf,
      // ADR-0009 decision 3: the seen list belongs to one Claude session; a
      // new session sees the same conclusions again.
      seenIds: sameSession ? (prev.ids as string[]) : [],
      seenHashes: sameSession ? prev.hashes : [],
      ...(contextStart !== undefined ? { contextStart } : {}),
      // T19c: switch on -> the filter runs against the known set (which
      // exists whenever the switch is on) AND the minimum block applies.
      ...(knownTerms !== undefined ? { knownTerms, novel: true } : {}),
      now: new Date().toISOString(),
    });
    // decision 7: filter counts on every terminal event, never content.
    const counts = {
      considered: view.counts.considered,
      dropped_context: view.counts.dropped_context,
      dropped_dup: view.counts.dropped_dup,
      dropped_trivia: view.counts.dropped_trivia,
      // T19c: the two new counts ride ONLY the novelty path - with the
      // switch off the log lines keep today's exact shape. dropped_small
      // appears only on the run that actually suppressed a block (the
      // event is then "empty", bytes 0: nothing was injected).
      ...(cfg.novel === true
        ? {
            dropped_known: view.counts.dropped_known ?? 0,
            ...(view.counts.dropped_small !== undefined ? { dropped_small: view.counts.dropped_small } : {}),
          }
        : {}),
      query_chars: queryChars,
      ...(partial > 0 ? { partial } : {}),
      ...(wallHit ? { error_class: "timeout" } : {}), // T16g: the wall flag on the render event
      ...rolloutNote, // C4: rollout read failures, counts only, codex only
    };
    if (view.text === "") {
      // nothing new to show (or nothing came back): silence
      logEvent(cfg, { hook: "recall", event: "empty", ok: true, ms: Date.now() - t0, bytes: 0, n_items: 0, ...counts });
      process.exit(0);
    }
    // T18b (ADR-0013 decision 2): the deterministic arm. sha256 over the
    // Claude session id and the raw prompt, mapped to [0,1) via the first
    // 8 hex digits / 2^32, compared to the holdout share: the same session
    // and prompt always take the same arm, so a hook rerun cannot switch
    // groups. With the default share 0 NO arm field is added anywhere and
    // stdout is written exactly as before - today's logs stay
    // byte-identical.
    const holdout = cfg.recallHoldout ?? 0;
    const promptText = typeof input.prompt === "string" ? input.prompt : "";
    let arm: "shown" | "held" = "shown";
    if (holdout > 0) {
      const h = createHash("sha256").update(session + String.fromCharCode(0) + promptText, "utf8").digest("hex");
      arm = Number.parseInt(h.slice(0, 8), 16) / 0x1_0000_0000 < holdout ? "held" : "shown";
    }
    if (arm === "shown") {
      writeHookJson("UserPromptSubmit", view.text);
    } else {
      // Ruling 15:27Z (option c): the held text goes to the PRIVATE state
      // dir (0600, capped) for eval-use's baseline - never to stdout,
      // never to the log, never to the server. Measurement is
      // best-effort: a failed write loses baseline history, not silence.
      try {
        appendHeld(heldPath(cfg.stateDir, cfg.workspace, cfg.peer), {
          ts: new Date().toISOString(),
          session,
          prompt_sha256: createHash("sha256").update(promptText, "utf8").digest("hex"),
          n_items: view.ids.length,
          text: view.text,
        });
      } catch {
        // keep silence either way
      }
    }
    // A held block is marked seen exactly as a shown one: a withheld item
    // must not resurface on a later prompt of the same session (brief).
    try {
      writeSeen(seenPath(cfg), nextSeen(prev, session, { ids: view.ids, hashes: view.hashes }));
    } catch {
      // worst case without the seen file: a conclusion shows again later
    }
    logEvent(cfg, {
      hook: "recall",
      event: "injected",
      ok: true,
      ms: Date.now() - t0,
      bytes: Buffer.byteLength(view.text),
      n_items: view.ids.length,
      ...counts,
      ...(holdout > 0 ? { arm } : {}),
    });
  } catch {
    if (cfg !== null) {
      logEvent(cfg, { hook: "recall", event: "error", ok: false, ms: Date.now() - t0, bytes: 0, n_items: 0, error_class: "other" });
    }
    // degrade to nothing (ADR-0001): never stderr, never a nonzero exit
  }
  process.exit(0);
}

void main();
