// O2 (ADR-0006, T8c-fix amendment): the seat counters. Written into the seat
// state file under the per-seat lock by the writer/replay/spool paths, so an
// operator can read whether memory works without reading code. The existing
// `counters` field in SeatState is the per-mission session-n map (ADR-0002) -
// different thing, untouched; these live in `stats`. updateStats never
// throws. A MISSING seat file creates a minimal state holding the counters
// (T8c-fix item 2: a replay after state loss must not lose its counts); a
// CORRUPT state is never replaced, and a BUSY lock stays a silent no-op
// (architect constraint 20:59Z). resolveSession sees mission "" on such a
// minimal state and starts fresh exactly as it would with no file.

import { existsSync } from "node:fs";
import { readSeatState, seatLockDir, seatStatePath, type SeatState } from "./missions.ts";
import { withLock, writeJsonAtomic } from "./lock.ts";

export interface SeatStats {
  written: number;
  failed: number;
  spooled: number;
  replayed: number;
  dropped: number;
  dead: number;
  /** T8c-fix item 1: unserializable metadata keys dropped by the spool */
  sanitized: number;
  /** redaction counts per ADR-0003 kind */
  redactions: Record<string, number>;
  last_ok_at?: string;
  last_error_at?: string;
  last_error_class?: string;
}

export function zeroStats(): SeatStats {
  return {
    written: 0,
    failed: 0,
    spooled: 0,
    replayed: 0,
    dropped: 0,
    dead: 0,
    sanitized: 0,
    redactions: {},
  };
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

/** Read + sanitise stats out of a seat state; anything odd becomes zeros. */
export function statsFrom(state: SeatState | null | undefined): SeatStats {
  const s = (state as { stats?: Record<string, unknown> } | null | undefined)?.stats;
  if (s === null || typeof s !== "object" || Array.isArray(s)) return zeroStats();
  const redactions: Record<string, number> = {};
  const r = s.redactions;
  if (r !== null && typeof r === "object" && !Array.isArray(r)) {
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) redactions[k] = Math.floor(v);
    }
  }
  return {
    written: num(s.written),
    failed: num(s.failed),
    spooled: num(s.spooled),
    replayed: num(s.replayed),
    dropped: num(s.dropped),
    dead: num(s.dead),
    sanitized: num(s.sanitized),
    redactions,
    ...(typeof s.last_ok_at === "string" ? { last_ok_at: s.last_ok_at } : {}),
    ...(typeof s.last_error_at === "string" ? { last_error_at: s.last_error_at } : {}),
    ...(typeof s.last_error_class === "string" ? { last_error_class: s.last_error_class } : {}),
  };
}

/**
 * Read-modify-write the seat counters under the per-seat lock (same lock the
 * writer already uses). T8c-fix item 2 + architect constraint 20:59Z:
 *  - file MISSING: create a minimal seat state ({mission:"", n:1, ...}) and
 *    store the counters in it - counts are never lost to a missing file, and
 *    resolveSession's fresh path treats mission "" exactly like no file.
 *  - file CORRUPT (exists but unreadable): silent no-op, never replaced.
 *  - lock BUSY: silent no-op - counters are observability, never correctness.
 */
export async function updateStats(
  stateDir: string,
  workspace: string,
  peer: string,
  mutate: (s: SeatStats) => void,
): Promise<void> {
  try {
    await withLock(seatLockDir(stateDir, workspace, peer), () => {
      const path = seatStatePath(stateDir, workspace, peer);
      const state = readSeatState(path);
      if (state === null) {
        if (!existsSync(path)) {
          const fresh = zeroStats();
          mutate(fresh);
          return writeJsonAtomic(path, {
            mission: "",
            n: 1,
            session: "",
            counters: {},
            last_seen: new Date().toISOString(),
            stats: fresh,
          } satisfies SeatState);
        }
        return false; // corrupt, not missing: leave it alone (T8c-fix)
      }
      const stats = statsFrom(state as SeatState & { stats?: SeatStats });
      mutate(stats);
      return writeJsonAtomic(path, { ...state, stats });
    });
  } catch {
    // never fail a write over a counter
  }
}
