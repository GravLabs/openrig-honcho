// ADR-0022 decision 3 (B10): the shown/used id channel. Ids ONLY - every
// entry is kind:id under a strict grammar, never content (X1: the log keeps
// holding pointers and counts, never text). The injection sites record what
// a session was shown; the Stop hook matches its own turn text against that
// record and logs the ids that appeared as `used`. Local files only:
// <stateDir>/<workspace>/shown/<sha256(session)>.json, 0600 inside a 0700
// dir (X4), capped, pruned by age the way once.ts prunes its markers.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withLock } from "./lock.ts";

export const SHOWN_KINDS = ["decision", "approval", "lesson", "pointer", "conclusion"] as const;
export type ShownKind = (typeof SHOWN_KINDS)[number];

const ID_MAX = 100;
// decision/approval ids are ledger ids (d- + 8 hex); lesson and pointer ids
// are queue ids (qitem-<14 digits>-<16 hex>); conclusion ids are whatever
// the snapshot carries (a derived d- id or a server id) - charset-checked,
// never free text. Slash is out: it smells like a path.
const ID_GRAMMAR: Record<ShownKind, RegExp> = {
  decision: /^d-[0-9a-f]{8}$/,
  approval: /^d-[0-9a-f]{8}$/,
  lesson: /^qitem-[0-9]{14}-[0-9a-f]{16}$/,
  pointer: /^qitem-[0-9]{14}-[0-9a-f]{16}$/,
  conclusion: /^[A-Za-z0-9._:@-]{1,100}$/,
};

/** The one gate (X1): kind:id, both halves validated, or nothing. */
export function shownEntry(kind: unknown, id: unknown): string | undefined {
  if (typeof kind !== "string" || !SHOWN_KINDS.includes(kind as ShownKind)) return undefined;
  if (typeof id !== "string" || id.length > ID_MAX) return undefined;
  if (!ID_GRAMMAR[kind as ShownKind].test(id)) return undefined;
  return `${kind}:${id}`;
}

/** The id half of a validated entry, "" when the entry is not valid. */
export function shownId(entry: string): string {
  const i = entry.indexOf(":");
  return i > 0 ? entry.slice(i + 1) : "";
}

/** Validate a value that came off a log line or the state file: array of
 * valid entries, deduped, sorted, capped; undefined unless at least one. */
export function parseShownList(v: unknown, cap = 40): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const set = new Set<string>();
  for (const e of v) {
    if (typeof e !== "string") continue;
    const i = e.indexOf(":");
    if (i <= 0) continue;
    const valid = shownEntry(e.slice(0, i), e.slice(i + 1));
    if (valid !== undefined) set.add(valid);
    if (set.size >= cap) break;
  }
  if (set.size === 0) return undefined;
  return [...set].sort();
}

const SESSIONS_MAX = 40; // entries per session file, newest kept
const FILE_MAX_AGE_MS = 24 * 3_600_000; // a day without a write: drop
const PRUNE_STAMP_INTERVAL_MS = 60_000; // prune at most once a minute

function shownDir(stateDir: string, workspace: string): string {
  return join(stateDir, workspace, "shown");
}

function sessionFile(stateDir: string, workspace: string, session: string): string {
  return join(shownDir(stateDir, workspace), `${createHash("sha256").update(session, "utf8").digest("hex")}.json`);
}

/** Drop day-old session files; never throws, rate-limited by a stamp. */
function pruneShown(dir: string, now: number): void {
  try {
    const stamp = join(dir, ".pruned");
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < PRUNE_STAMP_INTERVAL_MS) return;
    writeFileSync(stamp, "", { mode: 0o600 });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > FILE_MAX_AGE_MS) unlinkSync(p);
      } catch {
        // vanished or unreadable: nothing to do
      }
    }
  } catch {
    // pruning is best-effort (S1)
  }
}

/** Order-preserving validated load of the file (B11 fix): the file keeps
 * INSERTION order, so unlike parseShownList this does not sort. */
function loadIds(file: string): string[] {
  const raw = readList(file);
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string") continue;
    const i = e.indexOf(":");
    if (i <= 0) continue;
    const v = shownEntry(e.slice(0, i), e.slice(i + 1));
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Record what this session was just shown. Merge + dedupe + cap (newest
 * kept); never throws - a failed write only loses the used-scan input.
 * The file keeps INSERTION order (B11 fix: sorting the stored list made the
 * cap keep the alphabetically last entries, not the newest); a re-shown
 * entry moves to the end, so slice(-cap) drops the oldest shown entries.
 * The log-line list still sorts (parseShownList) - canonical there.
 * F-V3 (review R27): the read-merge-write runs under the shared withLock,
 * so two hook processes recording for one session cannot lose a writer's
 * entries (session-start and recall race inside one turn). The lock lives
 * in the workspace's locks/ dir, NOT in shown/: readers readdir shown/ and
 * must keep seeing session files and the prune stamp only. Uncontended,
 * withLock runs this body synchronously before its first suspension, so
 * callers that do not await still see the file written; it never throws. */
export async function recordShown(
  stateDir: string,
  workspace: string,
  session: string,
  entries: string[],
): Promise<void> {
  if (session === "" || entries.length === 0) return;
  try {
    const dir = shownDir(stateDir, workspace);
    await withLock(join(dirname(dir), "locks"), () => {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        pruneShown(dir, Date.now());
        const file = sessionFile(stateDir, workspace, session);
        const merged: string[] = [];
        const gate = (e: unknown): void => {
          if (typeof e !== "string") return;
          const i = e.indexOf(":");
          if (i <= 0) return;
          const v = shownEntry(e.slice(0, i), e.slice(i + 1));
          if (v === undefined) return;
          const at = merged.indexOf(v);
          if (at >= 0) merged.splice(at, 1);
          merged.push(v);
        };
        for (const e of loadIds(file)) gate(e);
        for (const e of entries) gate(e);
        const kept = merged.slice(-SESSIONS_MAX);
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ids: kept }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        // best-effort (S1)
      }
    });
  } catch {
    // best-effort (S1): withLock itself never throws; this covers shownDir.
  }
}

function readList(file: string): unknown {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { ids?: unknown };
    return raw?.ids;
  } catch {
    return undefined;
  }
}

/** What this session was shown so far, validated; [] when unknown. */
export function readShown(stateDir: string, workspace: string, session: string): string[] {
  if (session === "") return [];
  return parseShownList(readList(sessionFile(stateDir, workspace, session))) ?? [];
}
