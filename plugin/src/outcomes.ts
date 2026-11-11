// O1 (ADR-0017 Part A): the outcome log collector. One JSONL record per
// CLOSED queue row of one rig, joining the OpenRig queue (read-only through
// daemon.ts, decision 1) with our own structured hook log. Pointers and
// counts only, never content (decision 2): no body, no summary, no prompt
// text can enter a record - the only text read is a qitem-id regex over
// other rows' bodies to build the follow-on index, and only the matched ids
// survive. Nothing here contacts Honcho and no hook calls this (decision 4);
// it runs on demand from bin/outcomes.ts.
//
// Idempotent (decision 3, corrected by F-C/R15): ONE record per qitem - a
// rerun adds nothing, and a row reopened and closed again REPLACES its line
// in place; --rebuild rewrites the whole file from the same inputs,
// byte-identically to the appended result (fixed key order, sorted ids).

import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fetchQueueListAll, fetchQueueListByState, fetchTransitions } from "./daemon.ts";
import { redact } from "./redact.ts";
import { sanitizeVisible } from "./pointer.ts";

/** Matches the daemon's qitem id shapes (qitem-<digits>-<hex>,
 * qitem-recovery-<hex>). Text that is not an id cannot pass this filter,
 * which is what keeps body content out of the follow-on index. */
export const QITEM_ID_RE = /\bqitem-[0-9]{14}-[0-9a-f]{16}\b|\bqitem-recovery-[0-9a-f]{16}\b/g;

export function extractQitemIds(text: string): string[] {
  return [...new Set(text.match(QITEM_ID_RE) ?? [])];
}

/* O4 M2/L4 (security pass on 90f2ae6): the vocabularies the pointer fields
 * may hold. The collector prints and stores these fields raw, so anything
 * outside them skips the row (M2) or nulls the field (L4) - a control-char
 * or prose payload (ESC/BEL/newline, injected headers, secrets) cannot pass
 * an anchored shape. Real-daemon vocabulary (read-only probe, 639 done rows
 * 2026-11-10): sourceSession/destinationSession are ALWAYS seat names;
 * handedOffFrom/handedOffTo and closureTarget additionally carry qitem ids,
 * including the legacy 8-hex-suffix shape that the link regex (16-hex)
 * does not match. */
const SEAT_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const ID_SHAPE_RE = /^(?:qitem-[0-9]{14}-[0-9a-f]{8,16}|qitem-recovery-[0-9a-f]{8,16})$/;

/** The daemon's own closure vocabulary (its dist CLOSURE_REASONS) plus the
 * legacy string values the same dist still emits (failed/stale/duplicate/
 * manual - badClosureShare reads "failed"). Anything else is not a reason:
 * null, not a guess. */
const CLOSURE_VOCAB = new Set([
  "handed_off_to", "blocked_on", "denied", "canceled", "no-follow-on",
  "escalation", "superseded", "failed", "stale", "duplicate", "manual",
]);

/** F-D (R15 Part 2): ABSENT (undefined/null - a field the daemon legitimately
 * omits) gives null and the row is KEPT; a PRESENT value outside the
 * vocabulary gives undefined, which skips the row. */
const seatField = (v: unknown): string | null | undefined => {
  if (v === undefined || v === null) return null; // legitimately absent
  const s = str(v);
  return s !== null && SEAT_RE.test(s) ? s : undefined; // present: must match
};
const seatOrIdField = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && (SEAT_RE.test(s) || ID_SHAPE_RE.test(s)) ? s : null;
};

export interface SeatMemory {
  digestShown: number;
  recallShown: number;
  recallHeld: number;
  search: number;
  ask: number;
  remember: number;
  retire: number;
  /** F-H (R15 Part 2): the claim pointer by holdout arm, from user-prompt
   * lines (ADR-0017 decision 11 - the pointer must be measurable per arm). */
  pointerShown: number;
  pointerHeld: number;
}

export interface OutcomeRecord {
  qitemId: string;
  /** F-D: null when the daemon omitted the field; a malformed value skips
   * the row instead, so null here always means "legitimately unknown". */
  source: string | null;
  destination: string | null;
  tags: string[];
  created: string;
  claimed: string | null;
  closed: string | null;
  closeTransitionId: number | null;
  closureReason: string | null;
  closureTarget: string | null;
  handoffFrom: string | null;
  handoffTo: string | null;
  reopenCount: number;
  followOn: string[];
  memory: SeatMemory;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The idempotence key (decision 3). Rows closed twice (after a reopen)
 * key on their LAST closing transition, matching `closed`. F-C superseded
 * this for the append path (one record per qitem, replaced in place); kept
 * exported because the key shape is part of the file's history. */
export function recordKey(r: OutcomeRecord): string {
  return `${r.qitemId}:${r.closeTransitionId ?? "none"}`;
}

/** Fixed key order - the byte-identity of --rebuild depends on it. */
export function serializeRecord(r: OutcomeRecord): string {
  return JSON.stringify({
    qitemId: r.qitemId,
    source: r.source,
    destination: r.destination,
    tags: r.tags,
    created: r.created,
    claimed: r.claimed,
    closed: r.closed,
    closeTransitionId: r.closeTransitionId,
    closureReason: r.closureReason,
    closureTarget: r.closureTarget,
    handoffFrom: r.handoffFrom,
    handoffTo: r.handoffTo,
    reopenCount: r.reopenCount,
    followOn: r.followOn,
    memory: {
      digestShown: r.memory.digestShown,
      recallShown: r.memory.recallShown,
      recallHeld: r.memory.recallHeld,
      search: r.memory.search,
      ask: r.memory.ask,
      remember: r.memory.remember,
      retire: r.memory.retire,
    },
  });
}

/** Rows that follow from this one: hand-off target, closure target, and the
 * ids whose bodies name this row (reverseIndex is built by the caller over
 * the corpus with extractQitemIds). Sorted + deduped for byte-identity. */
export function followOnIds(
  doc: Record<string, unknown>,
  reverse: Map<string, string[]>,
): string[] {
  const ids = new Set<string>();
  for (const v of [doc.closureTarget, doc.handedOffTo]) {
    const s = str(v);
    if (s !== null) for (const m of extractQitemIds(s)) if (m !== doc.qitemId) ids.add(m);
  }
  for (const back of reverse.get(String(doc.qitemId)) ?? []) if (back !== doc.qitemId) ids.add(back);
  return [...ids].sort();
}

/** One closed row -> the record. `transitions` as answered (append order).
 * doc.body is NEVER read here - that is structural: the record cannot hold
 * content it was never given. */
export function buildRecord(
  doc: Record<string, unknown>,
  transitions: Record<string, unknown>[],
  reverse: Map<string, string[]>,
): OutcomeRecord | null {
  const qitemId = str(doc.qitemId);
  if (qitemId === null) return null;
  let closing: Record<string, unknown> | null = null;
  let reopenCount = 0;
  let sawDone = false;
  let firstInProgressTs: string | null = null;
  for (const t of transitions) {
    const st = str(t.state);
    if (st === "done") {
      closing = t; // last done wins after a reopen
      sawDone = true;
    } else if (st === "in-progress") {
      if (firstInProgressTs === null && typeof t.ts === "string") firstInProgressTs = t.ts;
      if (sawDone) reopenCount += 1;
    }
  }
  const claimed = str(doc.claimedAt) ?? firstInProgressTs;
  // F-B (R15): a row the daemon says is done but whose transitions carry no
  // done (legacy rows, interrupted closes) still CLOSED at some point - fall
  // back to tsUpdated. An open-ended window credits every later tool call.
  const closed =
    closing !== null
      ? str(closing.ts)
      : str(doc.state) === "done"
        ? str(doc.tsUpdated)
        : null;
  const memory: SeatMemory = {
    digestShown: 0,
    recallShown: 0,
    recallHeld: 0,
    search: 0,
    ask: 0,
    remember: 0,
    retire: 0,
    pointerShown: 0,
    pointerHeld: 0,
  };
  // O4 M2 + F-D (R15 Part 2): a PRESENT value outside the vocabulary
  // (control chars, injected headers, prose) skips the ROW - counted by the
  // caller - never a silent empty string; an ABSENT field is the daemon
  // legitimately omitting it, so it becomes null and the row stays.
  const source = seatField(doc.sourceSession);
  const destination = seatField(doc.destinationSession);
  if (source === undefined || destination === undefined) return null;
  const optionalHandoff = (v: unknown): string | null | undefined => {
    if (v === undefined || v === null) return null; // legitimately absent
    return seatOrIdField(v) ?? undefined; // present: must match, or skip
  };
  const handoffFrom = optionalHandoff(doc.handedOffFrom);
  const handoffTo = optionalHandoff(doc.handedOffTo);
  if (handoffFrom === undefined || handoffTo === undefined) return null;
  // O4 L4: free text fields pass the vocabulary or the redactor.
  const reasonRaw = (closing !== null ? str(closing.closureReason) : null) ?? str(doc.closureReason);
  const targetRaw = (closing !== null ? str(closing.closureTarget) : null) ?? str(doc.closureTarget);
  return {
    qitemId,
    source,
    destination,
    tags: Array.isArray(doc.tags)
      ? doc.tags.filter((t): t is string => typeof t === "string").map((t) => redact(t).text)
      : [],
    created: str(doc.tsCreated) ?? "",
    claimed,
    closed,
    closeTransitionId: closing !== null && typeof closing.transitionId === "number" ? closing.transitionId : null,
    closureReason: reasonRaw !== null && CLOSURE_VOCAB.has(reasonRaw) ? reasonRaw : null,
    closureTarget: seatOrIdField(targetRaw),
    handoffFrom: handoffFrom ?? null,
    handoffTo: handoffTo ?? null,
    reopenCount,
    followOn: followOnIds(doc, reverse),
    memory,
  };
}

/** Memory use of `seat` in [claimed, closed] (inclusive). A missing `closed`
 * opens the top; a missing `claimed` means NEVER CLAIMED and yields all
 * zeros (see the guard below). From OUR structured log (O1 lines): the digest rides the
 * session-start events that carry `moment` (T19b); recall injected counts
 * held by arm and shown otherwise (an absent arm is the no-holdout default,
 * i.e. shown); tool counts ride mcp events tool:<name>. A line from another
 * seat or an unparseable line never counts.
 *
 * Seat naming (real pilot log, probe 2026-11-10): our O1 lines carry
 * `peer` = the LOCAL seat name (T16b), the queue names `seat@rig`. A line
 * matches when its peer equals the full destination or its local part; the
 * log file is per-workspace anyway, so no cross-rig confusion is possible.
 * A fixture peer may carry either spelling (full names match too). */
export function memoryWindow(
  logLines: unknown[],
  seat: string,
  claimed: string | null,
  closed: string | null,
): SeatMemory {
  const m: SeatMemory = {
    digestShown: 0,
    recallShown: 0,
    recallHeld: 0,
    search: 0,
    ask: 0,
    remember: 0,
    retire: 0,
    pointerShown: 0,
    pointerHeld: 0,
  };
  // No claim = no window. A row closed without ever being claimed has no
  // evidence of when work started; opening the bottom to the beginning of
  // time would credit it every tool call in the log (found on the real
  // pilot run: 3 searches lit up 14 never-claimed rows).
  if (claimed === null) return m;
  const from = Date.parse(claimed);
  if (!Number.isFinite(from)) return m;
  const to = closed !== null ? Date.parse(closed) : Number.POSITIVE_INFINITY;
  for (const raw of logLines) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as Record<string, unknown>;
    const local = seat.includes("@") ? seat.slice(0, seat.indexOf("@")) : seat;
    // L-A (R15): an MCP line carries the FULL seat name in `session`
    // (mcp.ts logs config.sessionName). When it is there it is authoritative:
    // a peer of the same local name on another rig must not be credited.
    // Older MCP lines (no session) and the hook lines - whose `session` is
    // the CLAUDE session id, not a seat - keep matching by peer.
    if (l.hook === "mcp" && typeof l.session === "string") {
      if (l.session !== seat) continue;
    } else if (l.peer !== seat && l.peer !== local) {
      continue;
    }
    const ts = typeof l.ts === "string" ? Date.parse(l.ts) : Number.NaN;
    if (!Number.isFinite(ts) || ts < from || ts > to) continue;
    // Architect 09:55Z: a held hand-off gets ordinary recall, and its OWN
    // line (injected, empty or timeout) carries pointer=held. Counted here,
    // apart from the event chain: an injected+arm=held line credits
    // recallHeld AND pointerHeld - two different questions. "shown"/"none"
    // never ride an ordinary recall line; the event=pointer branch below
    // owns those, and OLD user-prompt lines keep counting as before.
    if (l.hook === "recall" && l.event !== "pointer" && l.pointer === "held") {
      m.pointerHeld += 1;
    }
    if (l.hook === "session-start" && typeof l.moment === "string") m.digestShown += 1;
    else if (l.hook === "recall" && l.event === "injected") {
      if (l.arm === "held") m.recallHeld += 1;
      else m.recallShown += 1;
    } else if (l.hook === "recall" && l.event === "pointer") {
      // F-G (O6, architect ruling 08:18Z): the claim pointer moved onto the
      // SYNCHRONOUS recall line. Same arm rule as the old user-prompt lines:
      // "none" (silent or errored) is not an arm and is not counted. The
      // user-prompt branch below keeps OLD logs counting unchanged - a run
      // mixing old and new lines counts each pointer once (a fresh run logs
      // the pointer on the recall line only).
      if (l.pointer === "shown") m.pointerShown += 1;
      else if (l.pointer === "held") m.pointerHeld += 1;
    } else if (l.hook === "mcp") {
      const ev = typeof l.event === "string" ? l.event : "";
      if (ev === "tool:search") m.search += 1;
      else if (ev === "tool:ask") m.ask += 1;
      else if (ev === "tool:remember") m.remember += 1;
      else if (ev === "tool:retire") m.retire += 1;
    } else if (l.hook === "user-prompt") {
      // F-H (R15 Part 2): the claim pointer, split by holdout arm. "none"
      // (skipped or errored) is not the arm and is not counted.
      if (l.pointer === "shown") m.pointerShown += 1;
      else if (l.pointer === "held") m.pointerHeld += 1;
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// The file: <stateDir>/outcomes/<workspace>.jsonl, one record per line,
// 0700 dir / 0600 file like the log (O1 file rules).

export function outcomesFile(stateDir: string, workspace: string): string {
  return join(stateDir, "outcomes", `${workspace}.jsonl`);
}

/** F-C (R15): the append path keys on qitemId, not the closing transition -
 * one record per qitem, a newer close REPLACES the older line. Returns the
 * file's lines in order, a qitemId -> index map (first occurrence wins), and
 * how many legacy duplicate lines were dropped (the reopen bug on files
 * written before this fix; the rewrite repairs them). */
export function readOutcomeLines(
  file: string,
): { lines: string[]; index: Map<string, number>; dropped: number } {
  const out: string[] = [];
  const index = new Map<string, number>();
  let dropped = 0;
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { lines: out, index, dropped };
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let qid: string | null = null;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.qitemId === "string") qid = o.qitemId;
    } catch {
      // a damaged line is kept verbatim; a rebuild replaces it
    }
    if (qid !== null) {
      if (index.has(qid)) {
        dropped += 1;
        continue;
      }
      index.set(qid, out.length);
    }
    out.push(line);
  }
  return { lines: out, index, dropped };
}

export function readOutcomeKeys(file: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(file)) return keys;
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return keys;
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.qitemId === "string") {
        keys.add(`${o.qitemId}:${typeof o.closeTransitionId === "number" ? o.closeTransitionId : "none"}`);
      }
    } catch {
      // a damaged line is skipped; a rebuild replaces it
    }
  }
  return keys;
}

/* O4 L5 (security pass on 90f2ae6, probe-mode): creation modes apply only
 * when the file does not exist yet, so a PRE-EXISTING wide (or planted)
 * dir/file kept 0755/0644 across every run - and a planted SYMLINK there
 * would be written through. Every write now: lstat first (refuse symlinks,
 * an error not a silent skip) and chmod after (tighten whatever was there).
 * No path text in the message (the caller's error is printed). */
function refuseSymlink(path: string, what: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${what} is a symlink - refusing to write outcomes through it`);
    }
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return; // absent: fine
    throw e;
  }
}

function ensureOutcomesDir(stateDir: string): void {
  const dir = join(stateDir, "outcomes");
  refuseSymlink(dir, "outcomes dir");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error("outcomes dir is a symlink - refusing to write outcomes through it");
  }
  chmodSync(dir, 0o700); // a pre-existing wide dir is tightened
}

export function appendRecords(file: string, lines: string[]): void {
  if (lines.length === 0) return;
  refuseSymlink(file, "outcomes file");
  appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // creation mode does not apply to an existing file (L5)
}

/** Atomic full rewrite (tmp + rename in the same dir). */
export function writeRecordsAtomic(file: string, lines: string[]): void {
  refuseSymlink(file, "outcomes file");
  const tmp = `${file}.tmp-${process.pid}`;
  refuseSymlink(tmp, "outcomes tmp");
  writeFileSync(tmp, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600); // an existing tmp keeps its old mode without this
  renameSync(tmp, file);
  chmodSync(file, 0o600); // L5: tightened after EVERY write, old modes included
}

// ---------------------------------------------------------------------------
// The runner. Injectable so unit tests never open a socket: tests drive the
// pure functions above plus this one with stub fetchers.

export interface CollectDeps {
  daemonUrl: string;
  rig: string;
  stateDir: string;
  /** the plugin log's workspace part of <stateDir>/log/<workspace>.log */
  workspace?: string;
  rebuild?: boolean;
}

export interface CollectResult {
  file: string;
  closedRows: number;
  added: number;
  /** F-C: records rewritten in place - a reopen closed a qitem a second
   * time, or a legacy duplicate line was dropped. */
  replaced: number;
  total: number;
  records: OutcomeRecord[];
  daemonFailures: number;
  /** O4 M2: rows whose pointer fields failed the vocabulary (hostile or
   * corrupt) - skipped, counted, printed, never written. */
  skippedRows: number;
}

export async function collectOutcomes(deps: CollectDeps): Promise<CollectResult | { error: string }> {
  const done = await fetchQueueListByState(deps.daemonUrl, "done");
  if (!done.ok) return { error: `queue list: daemon ${done.kind}` };
  // probe 2026-11-10: state=all matches NOTHING; the all-states corpus is
  // the state-less list. If it fails, links fall back to closed rows only.
  const all = await fetchQueueListAll(deps.daemonUrl);
  const corpusForLinks = all.ok ? all.docs : done.docs; // follow-on links need open rows too
  const rows = done.docs.filter((d) => {
    const dest = str(d.destinationSession) ?? "";
    return dest.endsWith(`@${deps.rig}`);
  });
  // reverse index: rows of this rig whose BODY names a qitem id (bodies are
  // read here and nowhere else; only regex-matched ids are kept).
  const reverse = new Map<string, string[]>();
  for (const d of corpusForLinks) {
    const from = str(d.qitemId);
    const body = typeof d.body === "string" ? d.body : "";
    if (from === null) continue;
    if (!str(d.destinationSession)?.endsWith(`@${deps.rig}`) && !str(d.sourceSession)?.endsWith(`@${deps.rig}`)) continue;
    for (const mentioned of extractQitemIds(body)) {
      if (mentioned === from) continue;
      const list = reverse.get(mentioned) ?? [];
      if (!list.includes(from)) list.push(from);
      reverse.set(mentioned, list);
    }
  }
  // our own hook log for this workspace
  const ws = deps.workspace ?? deps.rig;
  let logLines: unknown[] = [];
  try {
    for (const line of readFileSync(join(deps.stateDir, "log", `${ws}.log`), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        logLines.push(JSON.parse(line));
      } catch {
        // legacy/garbage line: skip
      }
    }
  } catch {
    // no log yet: every memory count stays 0
  }

  const records: OutcomeRecord[] = [];
  let daemonFailures = 0;
  let skippedRows = 0;
  for (const doc of rows) {
    const tr = await fetchTransitions(deps.daemonUrl, String(doc.qitemId));
    if (!tr.ok) {
      daemonFailures += 1;
      continue; // a row whose history we cannot read is skipped, never guessed
    }
    const rec = buildRecord(doc, tr.transitions, reverse);
    if (rec === null) {
      skippedRows += 1; // M2: hostile or unrecognisable pointer fields
      continue;
    }
    if (rec.destination !== null) {
      rec.memory = memoryWindow(logLines, rec.destination, rec.claimed, rec.closed);
    } // F-D: no destination seat -> no memory can be attributed, all zeros
    records.push(rec);
  }

  const file = outcomesFile(deps.stateDir, ws);
  const lines = records.map(serializeRecord);
  let added = 0;
  let replaced = 0;
  let total = 0;
  // L5: a planted symlink here is an ERROR the operator sees (exit 1 from
  // the bin), not a silent pass - the writes below refuse before touching.
  try {
    ensureOutcomesDir(deps.stateDir);
    // L5, tightened further: EVERY run repairs the file mode, not just a
    // run that appends - the whole point is closing a window a release
    // before 0600 left open (probe: a pre-seeded 0644 file + a run whose
    // only row was M2-skipped would otherwise keep it). refuseSymlink also
    // runs BEFORE readOutcomeKeys, so a planted link is never read through.
    refuseSymlink(file, "outcomes file");
    if (existsSync(file)) chmodSync(file, 0o600);
    if (deps.rebuild === true) {
      writeRecordsAtomic(file, lines);
      added = lines.length;
      total = lines.length;
    } else {
      // F-C (R15): ONE record per qitem. A row reopened and closed again
      // replaces its line in place instead of adding a second one, so an
      // appended file and a --rebuild agree byte for byte. With nothing to
      // replace or repair this is the plain O1 append path: no rewrite, the
      // rerun-adds-0 pin keeps holding with the file untouched.
      const prev = readOutcomeLines(file);
      replaced += prev.dropped;
      let changed = prev.dropped > 0;
      const fresh: string[] = [];
      for (const [i, line] of lines.entries()) {
        const qid = records[i]!.qitemId;
        const at = prev.index.get(qid);
        if (at === undefined) {
          fresh.push(line);
          continue;
        }
        if (prev.lines[at] !== line) {
          prev.lines[at] = line;
          replaced += 1;
          changed = true;
        }
      }
      if (changed) writeRecordsAtomic(file, [...prev.lines, ...fresh]);
      else appendRecords(file, fresh);
      added = fresh.length;
      total = prev.lines.length + fresh.length;
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "outcomes write failed" };
  }
  return { file, closedRows: rows.length, added, replaced, total, records, daemonFailures, skippedRows };
}

// ---------------------------------------------------------------------------
// Summary print - counts only, per destination seat (what the owner asked:
// does the memory make the work better; the numbers come later).

export interface SeatSummary {
  seat: string;
  closed: number;
  /** F-A (R15): closed rows that were ever claimed - the denominator the
   * ADR defines the pull rate over (a never-claimed row cannot hold memory
   * use, so counting it in the denominator understates the rate). */
  claimedRows: number;
  medianClaimToCloseMs: number | null;
  badClosureShare: number; // denied / failed / canceled
  followOnShare: number;
  /** searched rows / claimed rows (ADR definition, not / closed rows). */
  searchedShare: number;
}

/** N-A (R15): even count = MEAN of the two middle spans, not the lower one. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarize(records: OutcomeRecord[]): SeatSummary[] {
  const bySeat = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    const seatKey = r.destination ?? "(no destination)"; // F-D: kept rows print here
    const list = bySeat.get(seatKey) ?? [];
    list.push(r);
    bySeat.set(seatKey, list);
  }
  const out: SeatSummary[] = [];
  for (const seat of [...bySeat.keys()].sort()) {
    const rs = bySeat.get(seat) as OutcomeRecord[];
    const spans = rs
      .map((r) => (r.claimed !== null && r.closed !== null ? Date.parse(r.closed) - Date.parse(r.claimed) : Number.NaN))
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
    const share = (pred: (r: OutcomeRecord) => boolean): number =>
      rs.length === 0 ? 0 : rs.filter(pred).length / rs.length;
    const claimedRows = rs.filter((r) => r.claimed !== null);
    out.push({
      seat,
      closed: rs.length,
      claimedRows: claimedRows.length,
      medianClaimToCloseMs: median(spans),
      badClosureShare: share((r) => r.closureReason === "denied" || r.closureReason === "failed" || r.closureReason === "canceled"),
      followOnShare: share((r) => r.followOn.length > 0),
      searchedShare:
        claimedRows.length === 0
          ? 0
          : claimedRows.filter((r) => r.memory.search > 0).length / claimedRows.length,
    });
  }
  return out;
}

export function summaryLines(summaries: SeatSummary[]): string[] {
  // M2 print path: the seat already passed the vocabulary in buildRecord;
  // this is the second lock - nothing printable ever rides an escape.
  return summaries.map(
    (s) =>
      `seat ${sanitizeVisible(s.seat)}: closed ${s.closed}` +
      ` | median claim->close ${s.medianClaimToCloseMs === null ? "-" : `${Math.round(s.medianClaimToCloseMs / 1000)}s`}` +
      ` | denied|failed|canceled ${(s.badClosureShare * 100).toFixed(0)}%` +
      ` | follow-on ${(s.followOnShare * 100).toFixed(0)}%` +
      ` | searched ${(s.searchedShare * 100).toFixed(0)}% of ${s.claimedRows} claimed`,
  );
}
