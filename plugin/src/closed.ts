// v0.5.8 (ADR-0019, amended 2026-11-22): which queue rows named by an
// approval's `ends` are finished. Nothing here ever writes to the ledger: an
// approval is "used" only in what a seat is shown, by rule, never by a model.
//
// A row is FINISHED when it is closed (daemon state "done") and its work did
// not move on: a hand-off (closureReason handed_off_to) is followed to the row
// it names, up to HANDOFF_HOPS rows, and the chain is finished only when its
// last row is closed for another reason (review R21 F-Q4: OpenRig work moves
// by hand-off, so a handed-off row is not the end of the work).
//
// Answers are kept in one local 0600 file per workspace with the time they
// were checked, and every row is asked again once its answer is old - open
// rows after RECHECK_OPEN_MS, finished ones after RECHECK_DONE_MS, so a row
// that reopens brings its approval back (R21 F-Q1). Each read asks at most
// CLOSED_LOOKUPS_MAX rows, oldest answer first, so open rows cannot starve the
// rest (F-Q2), and all lookups share one LOOKUP_BUDGET_MS wall (F-Q3). Any
// failure keeps the last answer, and no answer means open: the approval stays
// in force, the view before v0.5.8.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchQueueState } from "./daemon.ts";
import { writeJsonAtomic } from "./lock.ts";
import { validQitem } from "./ledger.ts";

/** The daemon's state for a closed row. */
export const CLOSED_STATE = "done";
/** At most this many rows are asked about per read (oldest answer first). */
export const CLOSED_LOOKUPS_MAX = 5;
/** A hand-off chain longer than this counts as not finished. */
export const HANDOFF_HOPS = 5;
/** Ask an open row again after this long. */
export const RECHECK_OPEN_MS = 10 * 60 * 1000;
/** Ask a finished row again after this long (a reopened row comes back). */
export const RECHECK_DONE_MS = 6 * 60 * 60 * 1000;
/** All lookups of one read share this wall; late answers wait for the next read. */
export const LOOKUP_BUDGET_MS = 600;
/** An answer dated further ahead than this is asked again. */
export const FUTURE_SKEW_MS = 60 * 1000;
/** A file bigger than this is ignored (and rebuilt). */
const FILE_MAX_BYTES = 1024 * 1024;

interface RowAnswer {
  done: boolean;
  at: string;
}

export function closedPath(stateDir: string, workspace: string): string {
  return join(stateDir, "closed", `${workspace}.json`);
}

/** Every remembered answer; damage, absence, a symlink or an oversize file is
 * an empty map (R21 N-Q1: a planted symlink is refused, like outcomes.ts). */
function readAnswers(stateDir: string, workspace: string): Map<string, RowAnswer> {
  const out = new Map<string, RowAnswer>();
  try {
    const p = closedPath(stateDir, workspace);
    if (!existsSync(p)) return out;
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || st.size > FILE_MAX_BYTES) return out;
    const v = JSON.parse(readFileSync(p, "utf8")) as { version?: unknown; rows?: unknown };
    if (v === null || typeof v !== "object" || v.version !== 2 || typeof v.rows !== "object" || v.rows === null)
      return out;
    for (const [k, a] of Object.entries(v.rows as Record<string, unknown>)) {
      if (!validQitem(k) || a === null || typeof a !== "object") continue;
      const { done, at } = a as { done?: unknown; at?: unknown };
      if (typeof done === "boolean" && typeof at === "string" && Number.isFinite(Date.parse(at))) out.set(k, { done, at });
    }
  } catch {
    /* empty */
  }
  return out;
}

/** The rows remembered as finished (file only, no network). */
export function readClosed(stateDir: string, workspace: string): Set<string> {
  const out = new Set<string>();
  for (const [k, a] of readAnswers(stateDir, workspace)) if (a.done) out.add(k);
  return out;
}

/** Follow one row's hand-off chain: true finished, false open, undefined unknown. */
async function finished(daemonUrl: string | undefined, id: string): Promise<boolean | undefined> {
  let cur = id;
  const seen = new Set<string>();
  for (let hop = 0; hop <= HANDOFF_HOPS; hop++) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    const r = await fetchQueueState(daemonUrl, cur);
    if (!r.ok) return undefined;
    if (r.state !== CLOSED_STATE) return false;
    if (r.closureReason !== "handed_off_to") return true;
    if (r.closureTarget === undefined || !validQitem(r.closureTarget)) return false;
    cur = r.closureTarget;
  }
  return false;
}

/**
 * The finished subset of `ids`. Remembered answers count at once; then up to
 * CLOSED_LOOKUPS_MAX rows whose answer is missing or old are asked, oldest
 * first, within LOOKUP_BUDGET_MS. New answers are written to the file. With
 * `lookup: false` (the recall hook's hot path) only the file is read.
 */
export async function closedRows(
  stateDir: string,
  workspace: string,
  ids: string[],
  daemonUrl: string | undefined,
  opts: { lookup?: boolean; now?: () => string; budgetMs?: number } = {},
): Promise<Set<string>> {
  const answers = readAnswers(stateDir, workspace);
  const result = (): Set<string> => new Set(ids.filter((i) => answers.get(i)?.done === true));
  if (opts.lookup === false || daemonUrl === undefined || daemonUrl === "") return result();
  const nowIso = (opts.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(nowIso);
  const due = [...new Set(ids)]
    .filter(validQitem)
    .filter((i) => {
      const a = answers.get(i);
      if (a === undefined) return true;
      const age = nowMs - Date.parse(a.at);
      // R21 F-R3: an answer dated ahead of now (beyond clock skew) is not
      // trusted to be fresh - the turn record's 60 s rule, same shape
      if (age < -FUTURE_SKEW_MS) return true;
      return age >= (a.done ? RECHECK_DONE_MS : RECHECK_OPEN_MS);
    })
    .sort((x, y) => {
      const ax = answers.get(x)?.at ?? "";
      const ay = answers.get(y)?.at ?? "";
      return ax < ay ? -1 : ax > ay ? 1 : 0;
    })
    .slice(0, CLOSED_LOOKUPS_MAX);
  if (due.length === 0) return result();
  const got = new Map<string, boolean>();
  const all = Promise.all(
    due.map(async (i) => {
      try {
        const f = await finished(daemonUrl, i);
        if (f !== undefined) got.set(i, f);
      } catch {
        /* unknown */
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((r) => {
      timer = setTimeout(r, opts.budgetMs ?? LOOKUP_BUDGET_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (got.size === 0) return result();
  for (const [i, done] of got) answers.set(i, { done, at: nowIso });
  const rows: Record<string, RowAnswer> = {};
  for (const [k, a] of answers) rows[k] = a;
  writeJsonAtomic(closedPath(stateDir, workspace), { version: 2, rows });
  return result();
}
