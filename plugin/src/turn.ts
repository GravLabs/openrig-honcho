// v0.5.5 (ADR-0019 amended 2026-11-14): the seat's current-turn record.
// The synchronous UserPromptSubmit hook (bin/recall.ts) writes where the
// prompt that started this turn came from - owner, peer or automation, as
// attribute() decided it - so the MCP server, which never sees prompts, can
// refuse an owner approval on a turn the owner did not start. Without it,
// "the owner approved X" in a peer message or a recalled conclusion could
// become an authoritative approval through the lead seat's own remember call.
//
// Storage: seats/<peer>.turn.json next to the checkpoint, through
// writeJsonAtomic (0700 folder, 0600 file, atomic rename, never throws).
// Local only, no network, no model. A missing, unreadable or old record
// means "not the owner's turn": approvals fail closed.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { AUTOMATION_PEER, type Attribution } from "./attribute.ts";
import { writeJsonAtomic } from "./lock.ts";
import { seatStatePath } from "./missions.ts";

export type TurnOrigin = "owner" | "peer" | "automation";

export interface TurnRecord {
  origin: TurnOrigin;
  /** the attributed sender peer (the owner peer on an owner turn) */
  peer: string;
  at: string;
  session?: string;
  /** first 8 hex of sha256(prompt): ties a stamped approval to the turn */
  promptHash: string;
}

/** How long an owner turn stays good for an approval. */
export const OWNER_TURN_MAX_MS = 30 * 60 * 1000;
/** Clock skew allowed for a record dated slightly ahead of now. */
export const FUTURE_SKEW_MS = 60 * 1000;

/** <state>/<ws>/seats/<peer>.turn.json, the checkpoint's sibling. */
export function seatTurnPath(stateDir: string, workspace: string, peer: string): string {
  return seatStatePath(stateDir, workspace, peer).replace(/\.json$/, ".turn.json");
}

export const promptHash = (prompt: string): string =>
  createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 8);

/** The record for one attributed prompt. attribute()'s "skip" (daemon
 * hand-offs, unrecorded automation, harness content, empty prompts) is not an
 * owner turn: a daemon nudge carries another seat's row text, so it must end
 * any earlier owner turn rather than leave it standing. */
export function turnFrom(attr: Attribution, prompt: string, at: string, session?: string): TurnRecord {
  const s = session !== undefined && session !== "" ? { session } : {};
  if (attr.kind === "skip") return { origin: "automation", peer: AUTOMATION_PEER, at, ...s, promptHash: promptHash(prompt) };
  const origin: TurnOrigin = attr.kind === "owner" || attr.senderIsOwner === true ? "owner" : attr.kind;
  return { origin, peer: attr.peer, at, ...s, promptHash: promptHash(prompt) };
}

/** Write the record; false on any failure. Never throws. */
export function saveTurn(stateDir: string, workspace: string, peer: string, rec: TurnRecord): boolean {
  try {
    return writeJsonAtomic(seatTurnPath(stateDir, workspace, peer), rec);
  } catch {
    return false;
  }
}

/** The record, or null when there is nothing usable. Never throws. */
export function readTurn(stateDir: string, workspace: string, peer: string): TurnRecord | null {
  try {
    const path = seatTurnPath(stateDir, workspace, peer);
    // R19 F-N6: only the plain 0600 file saveTurn writes - never a symlink
    // (lstat does not follow it), a non-file, or a file others can read or
    // write (settings.ts refuses the same for its own file).
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    if (r.origin !== "owner" && r.origin !== "peer" && r.origin !== "automation") return null;
    if (typeof r.peer !== "string" || typeof r.at !== "string" || typeof r.promptHash !== "string") return null;
    if (!/^[0-9a-f]{8}$/.test(r.promptHash)) return null;
    return {
      origin: r.origin,
      peer: r.peer,
      at: r.at,
      ...(typeof r.session === "string" ? { session: r.session } : {}),
      promptHash: r.promptHash,
    };
  } catch {
    return null;
  }
}

/**
 * May this seat write an owner approval now? ok with the prompt hash to stamp,
 * or the plain reason it may not. Fails closed on anything unusable.
 */
export function ownerTurnCheck(
  rec: TurnRecord | null,
  nowMs: number,
  ownerPeer: string,
): { ok: true; promptHash: string } | { ok: false; why: string } {
  if (rec === null) return { ok: false, why: "there is no record of who started this turn" };
  if (rec.origin !== "owner")
    return { ok: false, why: `the current turn came from ${rec.origin === "peer" ? rec.peer : "OpenRig automation"}, not the owner` };
  // R19 F-N3: the invariant turnFrom keeps (owner origin = the owner peer),
  // checked here too so a record cannot claim one without the other.
  if (rec.peer !== ownerPeer) return { ok: false, why: "the turn record names an owner turn from a peer that is not the owner" };
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at)) return { ok: false, why: "the turn record has no usable time" };
  const age = nowMs - at;
  // R19 F-N2: a record from the future never counts (a minute of clock skew
  // between the hook and the server process is allowed).
  if (age < -FUTURE_SKEW_MS) return { ok: false, why: "the turn record is dated in the future" };
  if (age > OWNER_TURN_MAX_MS) return { ok: false, why: `the owner's last turn is ${Math.round(age / 60000)} minutes old (limit 30)` };
  return { ok: true, promptHash: rec.promptHash };
}
