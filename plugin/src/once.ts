// T15a (ADR-0010 decision 2): the runtime once-guard. Claude Code applies a
// parent folder's .claude/settings.local.json to a seat working in a
// subfolder, so two installs can register every hook twice; the two copies
// of one hook run with byte-identical stdin. takeOnce gives the first copy a
// marker (exclusive create) and tells the second to do nothing.
//
// Rules (ADR-0010, amended by review T15a-F1/F2 = T15c, ruling 22:32Z): a
// marker whose elapsed time is within one FULL window (either direction) of
// now means duplicate. A marker more than a full window AHEAD of now is the
// F2 clock rewind - never "fresh", it takes the event, because suppressing
// on an unprovable clock could drop a real event; a few ms of negative is
// normal spawn skew and stays fresh (O4.1). A stale one is taken over
// EXCLUSIVELY without ever removing the marker path: the same inode stat
// gives every racer that saw this generation the same mtime M, so they all
// compete for ONE derived claim name <file>.gen-<M> with an exclusive wx -
// the claim winner refreshes the main marker (utimes to wall now) and runs,
// the others get EEXIST on the claim and stand down. T15d (review T15c
// C1/C2): a claim older than one window is ABANDONED (a hook killed
// mid-takeover) - the next real event takes instead of standing down, and
// the prune sweep reaps the aged pair; and a claim winner takes only while
// main is still its generation, re-creating with one exclusive wx if a
// prune swept it mid-takeover, standing down against a copy that re-created
// first. Anything still left after that (a sweep between the winner's
// generation check and its refresh) leaks a DUPLICATE, never a real event.
// Markers and .gen- claims older than 1 h are pruned at
// most once a minute. ANY other error means run normally - the guard may
// drop a duplicate, never a real event. The whole module never throws (S1,
// same contract as lock.ts).

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const DUP_WINDOW_MS = 5_000;
const MARKER_MAX_AGE_MS = 3_600_000; // 1 h
const PRUNE_STAMP_INTERVAL_MS = 60_000; // prune at most once a minute
const STAMP_NAME = ".pruned";

/** <stateDir>/<workspace>/once/<sha256(hook + NUL + rawStdin)> */
const onceDir = (stateDir: string, workspace: string): string =>
  join(stateDir, workspace, "once");

// The NUL separator stops hook/stdin byte-boundary collisions (the E3 turn
// hash in stop.ts keeps its turn id on the same principle). Written as the
// \u0000 escape - never a raw NUL byte in source.
const markerKey = (hook: string, rawStdin: string): string =>
  createHash("sha256").update(`${hook}\u0000${rawStdin}`, "utf8").digest("hex");

/** Create (wx) or truncate (w) file 0600 with empty content. */
function touchMarker(file: string, flags: "wx" | "w"): void {
  const fd = openSync(file, flags, 0o600);
  try {
    writeSync(fd, "");
  } finally {
    closeSync(fd);
  }
}

/** ENOENT arbitration retry (architect ruling 20:37Z): the marker vanished
 * between our first wx-EEXIST and our stat - either a prune just deleted it
 * (>1 h old, and OUR event is the next real one: must take) or a racer
 * recreated it. One exclusive re-create decides: our wx succeeds (nothing
 * holds the marker - we take); EEXIST (a racer recreated and took) - we
 * stand down; any other error propagates -> caller fail-opens. Reused by the
 * T15d C2 sweep-restore after a won claim. */
function retryCreate(file: string): boolean {
  try {
    touchMarker(file, "wx");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
}

/** T15c (review T15a-F1/F2; ruling 22:32Z) + T15d (review T15c C1/C2): the
 * exclusive answer when the marker already exists. Only the prune sweep ever
 * removes the marker, and the takeover re-creates it exclusively (C2).
 * Unexpected errors throw - the caller fail-opens to true.
 * 1. stat: ENOENT -> vanished since our EEXIST (a prune) -> one exclusive
 *    retryCreate. Elapsed within one window of now (+/- 5 s) -> false
 *    (duplicate); a marker more than a full window AHEAD of now is the F2
 *    rewound clock, NOT fresh; a few ms of negative is ordinary skew and
 *    stays fresh (O4.1).
 * 2. stale (mtime M): the same inode stat gives every racer that saw this
 *    generation the same M, so they all compete for ONE derived claim name
 *    <file>.gen-<M> with an exclusive wx.
 * 3. claim EEXIST (C1): stat the claim. Within one window of now (+/- 5 s) a
 *    LIVE racer won this generation -> false. Aged, vanished, or unstatable:
 *    an ABANDONED claim (hook killed between claim and refresh, or a failed
 *    refresh) - take -> true: that error state may let duplicates through
 *    (allowed direction) but must never suppress a real event; the sweep
 *    reaps the aged pair. No refresh here on purpose: a fresh main would
 *    suppress every later replay against the abandoned state (C1.2 pins it).
 * 4. claim won (C2): take only while main is STILL generation M. Swept
 *    (ENOENT) -> one exclusive wx re-creates it: create -> take, EEXIST (a
 *    copy re-created and wx-took) -> false. mtime != M (pruned and re-created
 *    - that creator took) -> false. Else refresh main to wall now (a sweep
 *    right there re-runs the re-create; other refresh errors are ignored,
 *    the claim stands) -> true. The next genuine repeat sees the new mtime
 *    and competes for a NEW .gen- name. */
function arbitrateExisting(
  file: string,
  now: number,
  /** T15d seam (architect 00:00Z): test-only, fires only after THIS call
   * won the claim, before the generation re-check - where the sweep-vs-
   * takeover race lands. */
  afterClaimWin?: () => void,
): boolean {
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    // vanished between our EEXIST and this stat (a prune): the exclusive
    // retry-create decides (ruling 20:37Z)
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return retryCreate(file);
    throw err;
  }
  const elapsed = now - st.mtimeMs;
  // FRESH (suppress) = within one full window on either side of now. The
  // negative half is deliberate: a marker a few ms ahead of a caller's now
  // is normal skew (a racing copy creates it after the shared now was
  // sampled; review's O4.1 spawns exactly that way). Only a marker more
  // than one window AHEAD of now is the F2 clock rewind - take it over.
  // Deviation from the T15c brief step 1 (elapsed < 0 -> stale at any size)
  // is reported to the architect with this reasoning and O4.1 evidence.
  if (elapsed > -DUP_WINDOW_MS && elapsed < DUP_WINDOW_MS) return false; // duplicate (or small skew)
  const gen = st.mtimeMs;
  const claim = `${file}.gen-${String(gen)}`;
  let claimWon = true;
  try {
    touchMarker(claim, "wx"); // the exclusive claim on THIS generation
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err; // fail open
    claimWon = false;
  }
  if (!claimWon) {
    // T15d C1: live winner, or an abandoned claim (a hook killed between
    // its claim and its refresh, or a refresh that failed)?
    let cs;
    try {
      cs = statSync(claim);
    } catch {
      cs = undefined; // vanished or unstatable: abandoned
    }
    if (cs !== undefined) {
      const cElapsed = now - cs.mtimeMs;
      if (cElapsed > -DUP_WINDOW_MS && cElapsed < DUP_WINDOW_MS) return false; // a live racer won
    }
    // Abandoned: that error state may let duplicates through (the allowed
    // direction; the prune sweep reaps the aged pair) but must NEVER stand
    // a real event down - take. Deliberately NO refresh here: stamping main
    // fresh would suppress every later replay against the abandoned-claim
    // error, which review's C1.2 pins as wrong. (The brief said refresh; it
    // contradicts C1.2 - reported to the architect with the trace.)
    return true;
  }
  // T15d C2: we hold the claim - take only while main is STILL our
  // generation. A prune sweep can delete it between our stale stat and the
  // refresh; then a copy whose first wx hits the absent path has taken the
  // event. Take our generation back with ONE exclusive wx, or stand down
  // against whoever re-created first.
  afterClaimWin?.(); // T15d seam (architect 00:00Z, test only): the
  // sweep-vs-takeover race lands exactly here - won the claim, not yet
  // re-checked or refreshed. No production caller passes it.
  let st2;
  try {
    st2 = statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return retryCreate(file); // swept mid-takeover
    throw err; // fail open
  }
  if (st2.mtimeMs !== gen) return false; // generation replaced: its creator wx-took the event
  try {
    // Wall clock, NEVER the injected now (the accepted T15c deviation):
    // stamping a caller's test clock into shared state shifts every later
    // real-clock caller by the offset (the once.test takeover case). In
    // production (default arg) they are the same thing.
    const t = new Date();
    utimesSync(file, t, t); // refresh: the next repeat gets a new generation
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return retryCreate(file); // swept right after our stat
    // any other refresh error: ignore (ruling 22:32Z) - the claim stands, we take
  }
  return true;
}

/** Delete markers older than 1 h, at most once a minute (a .pruned stamp).
 * Every error is ignored: pruning must never break a hook. Accepted residual
 * (architect, T15d): the sweep can stat a marker, a takeover refreshes it,
 * then the sweep unlinks it on its stale stat and a third copy creates it -
 * two copies run that event; the leak is a duplicate, the allowed direction.
 * The per-entry re-check below shrinks that window to the last stat-to-unlink
 * pair (measurement in the T15d report). */
function maybePrune(dir: string, now: number): void {
  try {
    const stamp = join(dir, STAMP_NAME);
    try {
      if (now - statSync(stamp).mtimeMs < PRUNE_STAMP_INTERVAL_MS) return; // recent prune
    } catch {
      // no stamp (or unreadable): prune now
    }
    // (re)stamp BEFORE pruning: a crash mid-prune waits the minute before
    // trying again, so the sweep stays once-a-minute under any failure.
    try {
      touchMarker(stamp, "w");
      const t = new Date(now);
      utimesSync(stamp, t, t);
    } catch {
      // stamp unwritable: still sweep once; individual errors are ignored
    }
    for (const name of readdirSync(dir)) {
      if (name === STAMP_NAME) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > MARKER_MAX_AGE_MS) {
          // Second stat right before the unlink: a takeover can refresh a
          // marker between this sweeps first stat and its unlink, and
          // deleting a just-refreshed marker is what lets two copies take
          // one event (measured ~1.7 percent of K2+pruner rounds). The
          // re-check narrows that window to this stat-to-unlink pair.
          if (now - statSync(p).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(p);
        }
      } catch {
        // raced away or unreadable: skip this entry
      }
    }
  } catch {
    // pruning is opportunistic
  }
}

/**
 * Decide whether THIS hook run is the first for its event.
 * true = take the event (no marker, we won the stale-marker claim, the
 * claim was abandoned, a prune swept the marker, or any guard error);
 * false = a live copy within the last 5 s already took this exact event.
 */
export function takeOnce(
  stateDir: string,
  workspace: string,
  hook: string,
  rawStdin: string,
  now: number = Date.now(),
  /** T15c test seam (architect 20:37Z): fires between the first wx-EEXIST
   * and the arbitration stat - the instant a prune race lands. No production
   * caller passes it; the bins use the five-argument form. */
  afterEexist?: () => void,
  /** T15d test seam (architect 00:00Z): fires ONLY when this call won the
   * .gen- claim, right before the generation re-check and refresh - the
   * instant the sweep-vs-takeover race lands. No production caller
   * passes it. */
  afterClaimWin?: () => void,
): boolean {
  let take = true;
  try {
    const dir = onceDir(stateDir, workspace);
    const file = join(dir, markerKey(hook, rawStdin));
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return true; // cannot build the dir: run normally (the guard never loses a real event)
    }
    try {
      touchMarker(file, "wx"); // O_CREAT | O_EXCL, 0600: the kernel decides the race
      take = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return true; // read-only fs etc: run normally
      }
      afterEexist?.(); // seam: the prune lands exactly here (test only)
      take = arbitrateExisting(file, now, afterClaimWin); // T15c: .gen- claim takeover
    }
    maybePrune(dir, now);
  } catch {
    return true; // anything unexpected: run normally
  }
  return take;
}
