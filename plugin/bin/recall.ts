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
import { createClient } from "../src/honcho.ts";
import { errorClassFrom, logConfigProblem, logEvent } from "../src/log.ts";
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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** ADR-0009 decision 4: the whole fetch phase holds to 2.5 s of wall time -
 * the client caps its own timeout here AND the race is the outer wall.
 * ADR-0011 decision 1: the three queries share this ONE budget.
 * T16g (architect 18:55Z): at the wall the hook renders the queries that
 * already finished (partial count + timeout flag); silence only when none
 * did - see the fetch section below. */
const FETCH_BUDGET_MS = 2500;
const BUDGET: unique symbol = Symbol("recall-budget");

async function readStdin(timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.stdin.resume();
  });
  return Buffer.concat(chunks).toString("utf8");
}

const recallOff = (): boolean => (process.env.HONCHO_RECALL ?? "").trim().toLowerCase() === "off";

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
  // O1: exactly one structured event per hook run (see user-prompt.ts)
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    if (recallOff()) process.exit(0); // off for this hook only: silent, unlogged
    const loaded = loadConfig(process.env);
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
    let input: { prompt?: unknown; session_id?: unknown } = {};
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
      now: new Date().toISOString(),
    });
    // decision 7: filter counts on every terminal event, never content.
    const counts = {
      considered: view.counts.considered,
      dropped_context: view.counts.dropped_context,
      dropped_dup: view.counts.dropped_dup,
      dropped_trivia: view.counts.dropped_trivia,
      query_chars: queryChars,
      ...(partial > 0 ? { partial } : {}),
      ...(wallHit ? { error_class: "timeout" } : {}), // T16g: the wall flag on the render event
    };
    if (view.text === "") {
      // nothing new to show (or nothing came back): silence
      logEvent(cfg, { hook: "recall", event: "empty", ok: true, ms: Date.now() - t0, bytes: 0, n_items: 0, ...counts });
      process.exit(0);
    }
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: view.text },
      })}\n`,
    );
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
