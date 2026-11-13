// V6 (ADR-0019 decision 6, amended 2026-11-13): suggest a lesson after rework.
// A seat that was the DESTINATION of a queue item that came back for rework,
// closed in the last 7 days and not yet suggested, is told at session start
// (one digest line, rendered by inject.ts) that a lesson may be worth writing.
// This module NEVER reads, writes or copies the seat's own lesson notes -
// only the owning seat writes those, by hand. Everything here is local:
// the outcome log file (outcomes.ts) plus this seat's own 0600 record of what
// was already suggested, so a line never repeats. No model calls, no network,
// nothing in a hook path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./lock.ts";
import { isMachineryRow, outcomesFile, readOutcomeLines, type OutcomeRecord } from "./outcomes.ts";

/** The four rework kinds (row brief point 1). */
export type ReworkKind = "reopened" | "denied" | "failed" | "sent back";

/**
 * The exact rule: a CLOSED row (closed !== null) counts as reworked when the
 * FIRST of these matches, in this order:
 * 1. reopenCount > 0                                   -> "reopened"
 * 2. closureReason === "denied"                        -> "denied"
 * 3. closureReason === "failed"                        -> "failed"
 * 4. a followOn id whose own row's destination equals THIS row's destination,
 *    whose source is a DIFFERENT seat from this row's source (both known - an
 *    unknown source never proves a different sender), and whose own row is
 *    not OpenRig machinery: source daemon@..., id starting qitem-recovery-,
 *    or any tag starting "stuck-sweep" or "wake-"  (architect ruling
 *    2026-11-13 15:29Z: sweep/recovery rows and a same-requester
 *    continuation are not a correction)  -> "sent back"
 * Anything else is not rework: an onward hand-off (follow-on to a DIFFERENT
 * destination), "canceled" or any other closure, and any row not yet closed.
 * Pure: reads only its arguments.
 */
export function reworkReason(
  r: OutcomeRecord,
  byId: Map<string, OutcomeRecord>,
): ReworkKind | null {
  if (r.closed === null) return null;
  if (r.reopenCount > 0) return "reopened";
  if (r.closureReason === "denied") return "denied";
  if (r.closureReason === "failed") return "failed";
  if (r.destination !== null) {
    for (const f of r.followOn) {
      const g = byId.get(f);
      if (g === undefined || g.destination !== r.destination) continue;
      // a real send-back (ruling 2026-11-13 15:29Z): another seat sent it,
      // and the follow-on itself is not OpenRig machinery
      if (r.source === null || g.source === null || g.source === r.source) continue;
      if (isMachineryRow(g)) continue; // F8 shared rule: one machinery test in outcomes.ts
      return "sent back";
    }
  }
  return null;
}

// --------------------------------------------------------------------- state

export interface LessonState {
  version: 1;
  /** qitemId -> when it was suggested and under which rework reason.
   * Once an item is in here it is never suggested again, whatever its row
   * says afterwards (brief: "at most once per item ... it never repeats"). */
  suggested: Record<string, { at: string; reason: string }>;
}

/** <state-dir>/lesson/<workspace>.json (0600 file, 0700 folder via
 * writeJsonAtomic - the stale.ts / checkpoint.ts idiom). */
export function lessonStatePath(stateDir: string, workspace: string): string {
  return join(stateDir, "lesson", `${workspace}.json`);
}

/** Read; absence or any damage is null (the next start begins fresh). */
export function readLessonState(stateDir: string, workspace: string): LessonState | null {
  try {
    const p = lessonStatePath(stateDir, workspace);
    if (!existsSync(p)) return null;
    const v = JSON.parse(readFileSync(p, "utf8")) as Partial<LessonState>;
    if (
      v === null || typeof v !== "object" || v.version !== 1 ||
      typeof v.suggested !== "object" || v.suggested === null
    )
      return null;
    const suggested: LessonState["suggested"] = {};
    for (const [k, e] of Object.entries(v.suggested)) {
      if (e !== null && typeof e === "object" && typeof e.at === "string" && typeof e.reason === "string")
        suggested[k] = { at: e.at, reason: e.reason };
    }
    return { version: 1, suggested };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the pick

const WINDOW_MS = 7 * 86_400_000;

const NO_MEMORY = {
  digestShown: 0, recallShown: 0, recallHeld: 0, search: 0, ask: 0,
  remember: 0, retire: 0, pointerShown: 0, pointerHeld: 0,
};

/** Parse one outcome-log line. Only the eight fields the rule reads are
 * validated (present-but-malformed skips the row; legitimately absent fields
 * take their null/[] defaults like outcomes.ts does); the fields this
 * feature never reads carry placeholders - nothing here is re-serialized
 * back to the log. */
function parseRecord(line: string): OutcomeRecord | null {
  let o: Record<string, unknown>;
  try {
    const p = JSON.parse(line) as unknown;
    if (p === null || typeof p !== "object") return null;
    o = p as Record<string, unknown>;
  } catch {
    return null; // a damaged line is not a row
  }
  if (typeof o.qitemId !== "string" || o.qitemId === "") return null;
  const nullableStr = (v: unknown): string | null | undefined =>
    v === undefined || v === null ? null : typeof v === "string" ? v : undefined;
  const source = nullableStr(o.source);
  const destination = nullableStr(o.destination);
  const closed = nullableStr(o.closed);
  const closureReason = nullableStr(o.closureReason);
  if (
    source === undefined || destination === undefined ||
    closed === undefined || closureReason === undefined
  )
    return null;
  const rawReopen = o.reopenCount;
  const reopenCount =
    rawReopen === undefined ? 0 : typeof rawReopen === "number" && Number.isFinite(rawReopen) ? rawReopen : -1;
  if (reopenCount < 0) return null;
  const followOn = Array.isArray(o.followOn) ? o.followOn.filter((f): f is string => typeof f === "string") : [];
  let tags: string[] = [];
  if (Array.isArray(o.tags)) tags = o.tags.filter((t): t is string => typeof t === "string");
  else if (o.tags !== undefined && o.tags !== null) return null; // present: must be a list
  return {
    qitemId: o.qitemId,
    source,
    destination,
    closed,
    closureReason,
    reopenCount,
    followOn,
    tags,
    // unused by the rule - placeholders:
    created: "",
    claimed: null,
    closeTransitionId: null,
    closureTarget: null,
    handoffFrom: null,
    handoffTo: null,
    memory: NO_MEMORY,
  };
}

/**
 * The one line this digest may show (brief points 1-2), fully local:
 * candidates are rows of THIS seat as destination (destination === the seat's
 * own session name, e.g. "build@myrig"), closed within the last 7 days, that
 * reworkReason() calls reworked, and that the local record has never
 * suggested. At most one per digest: the newest closed wins. On a pick the
 * item is recorded and persisted (0600, once per item forever). Any failure
 * (unreadable log, damaged state, broken clock) means no suggestion.
 * `seat` is only passed through for the render line.
 */
export function maybeLessonSuggestion(
  stateDir: string,
  workspace: string,
  selfSession: string,
  seat: string,
  now: string,
): { qitemId: string; reason: ReworkKind; seat: string } | undefined {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || selfSession === "") return undefined;
  const { lines } = readOutcomeLines(outcomesFile(stateDir, workspace));
  const recs: OutcomeRecord[] = [];
  for (const ln of lines) {
    const r = parseRecord(ln);
    if (r !== null) recs.push(r);
  }
  const byId = new Map(recs.map((r) => [r.qitemId, r]));
  const state = readLessonState(stateDir, workspace) ?? { version: 1 as const, suggested: {} };
  const cutoff = nowMs - WINDOW_MS;
  let best: { r: OutcomeRecord; reason: ReworkKind } | undefined;
  for (const r of recs) {
    if (r.destination !== selfSession) continue;
    if (r.closed === null) continue;
    const c = Date.parse(r.closed);
    if (!Number.isFinite(c) || c < cutoff) continue;
    if (state.suggested[r.qitemId] !== undefined) continue; // forever
    const reason = reworkReason(r, byId);
    if (reason === null) continue;
    if (best === undefined || r.closed > (best.r.closed as string)) best = { r, reason };
  }
  if (best === undefined) return undefined;
  state.suggested[best.r.qitemId] = { at: now, reason: best.reason };
  writeJsonAtomic(lessonStatePath(stateDir, workspace), state);
  return { qitemId: best.r.qitemId, reason: best.reason, seat };
}
