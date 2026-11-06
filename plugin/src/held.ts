// T18b (ADR-0013 decision 2, architect ruling 2026-11-04 15:27Z, option c):
// the local half of the recall holdout. A held block is never shown to the
// seat, but the holdout exists to measure against it, so its rendered text
// (already redacted - it is built from redacted conclusions) is kept in the
// PRIVATE state dir, the way the spool already keeps message text, for
// scripts/eval-use.ts to match to its transcript turn by session and
// prompt hash. The hook LOG stays counts-only (arm "held"); nothing here
// goes to the server or to the log.
//
// File: <stateDir>/<workspace>/seats/<peer>.held.jsonl, mode 0600 inside
// the 0700 seats dir (same idiom as the spool). Cap: newest 200 entries or
// 1 MB, pruning oldest first - the baseline needs recent turns only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { seatStatePath } from "./missions.ts";

export const HELD_MAX_ENTRIES = 200;
export const HELD_MAX_BYTES = 1_000_000;

export interface HeldEntry {
  /** ISO time of the hook run that held the block. */
  ts: string;
  /** The Claude session id from the hook input. */
  session: string;
  /** sha256 hex of the raw prompt string - the transcript join key. */
  prompt_sha256: string;
  n_items: number;
  /** The rendered block text, exactly as it would have been injected. */
  text: string;
}

export const heldPath = (stateDir: string, workspace: string, peer: string): string =>
  seatStatePath(stateDir, workspace, peer).replace(/\.json$/, ".held.jsonl");

/**
 * Append one held entry, then prune from the oldest end until both caps
 * hold; the newest entry is always kept (even one alone over the byte
 * cap). Whole-file atomic rewrite (temp + rename): the file is small by
 * construction, and this keeps a crash from leaving a half line.
 */
export function appendHeld(
  file: string,
  entry: HeldEntry,
  maxEntries: number = HELD_MAX_ENTRIES,
  maxBytes: number = HELD_MAX_BYTES,
): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    // first entry, or unreadable: start fresh - this file is measurement,
    // not state; losing old lines costs only baseline history
  }
  lines.push(JSON.stringify(entry));
  let start = Math.max(0, lines.length - maxEntries);
  const bytes = (from: number): number =>
    lines.slice(from).reduce((a, l) => a + Buffer.byteLength(l, "utf8") + 1, 0);
  while (start < lines.length - 1 && bytes(start) > maxBytes) start++;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.slice(start).join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
