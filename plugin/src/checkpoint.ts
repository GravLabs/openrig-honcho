// V1 (ADR-0019 decision 1): the seat's local checkpoint. The Stop path saves
// ONE line per seat - the first non-empty line of the final reply through the
// same sanitizeVisible the pointer titles use (redact + invisible/control/
// bidi strip + collapse + trim), capped at 200 characters AFTER sanitizing,
// plus the time. Local only: never sent to Honcho, no model, no network.
// The continuity digest shows it first on a compact/resume start (V1 keeps
// the old HONCHO_DIGEST=off block byte-identical). A newer checkpoint
// replaces the older one; an empty or missing reply saves nothing and keeps
// the old line.
//
// Storage: the sibling file seats/<peer>.checkpoint.json next to the seat
// state file (precedent: held.ts's .held.jsonl). resolveSession rewrites the
// seat state file wholesale; this file is its own unit, so dedupe-token
// rewrites cannot touch it. writeJsonAtomic (lock.ts) gives the 0700 folder,
// 0600 file and atomic rename, returns false on any failure and never
// throws: the save is best-effort inside the hook by construction.

import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "./lock.ts";
import { seatStatePath } from "./missions.ts";
import { sanitizeVisible } from "./pointer.ts";

const CAP = 200;

export interface Checkpoint {
  line: string;
  at: string;
}

/** The sibling of seatStatePath: <state>/<ws>/seats/<peer>.checkpoint.json. */
export function seatCheckpointPath(stateDir: string, workspace: string, peer: string): string {
  return seatStatePath(stateDir, workspace, peer).replace(/\.json$/, ".checkpoint.json");
}

/**
 * Save `raw`'s first non-empty line as this seat's checkpoint. Returns true
 * only when a checkpoint was written; false (nothing touched, old kept) for
 * an empty/missing reply, a line that sanitizes to nothing, or a failed
 * write. Never throws.
 */
export function saveCheckpoint(
  stateDir: string,
  workspace: string,
  peer: string,
  raw: string,
  at: string,
): boolean {
  const first = raw.split("\n").find((ln) => ln.trim() !== "");
  if (first === undefined) return false;
  const line = sanitizeVisible(first).slice(0, CAP).trimEnd();
  if (line === "") return false;
  return writeJsonAtomic(seatCheckpointPath(stateDir, workspace, peer), { line, at });
}

/** The seat's checkpoint, or null when there is nothing usable (no file,
 * corrupt JSON, or a missing/empty field). Never throws. */
export function readCheckpoint(stateDir: string, workspace: string, peer: string): Checkpoint | null {
  try {
    const v = JSON.parse(readFileSync(seatCheckpointPath(stateDir, workspace, peer), "utf8")) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { line, at } = v as Record<string, unknown>;
    if (typeof line !== "string" || line === "" || typeof at !== "string" || at === "") return null;
    return { line, at };
  } catch {
    return null;
  }
}
