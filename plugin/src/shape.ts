// Message shaping and deriver-load rules (ADR-0005 E2, E4, E5; ADR-0006 R2
// client_id). Pure: no env, no files, no network; never throws (S1).

import { createHash } from "node:crypto";

/** E2: Honcho caps message content at 25 000; chunk below it. */
export const MAX_CHUNK = 24000;

/**
 * Cut at `max`, never between a high and low surrogate (E2, F-T5b-1): a chunk
 * ending in a lone high surrogate is not well-formed text, a server may
 * reject it outright, and a permanently-rejected entry jams the spool head.
 * At max === 1 a split is unavoidable - take it rather than loop forever.
 */
function hardCut(text: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const prev = text.charCodeAt(end - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) end--;
    }
    if (end <= i) end = i + 1; // max === 1 on a surrogate: unavoidable
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Greedy pack of `text` split on `sep`, keeping every separator INSIDE the
 * chunks (so chunks.join("") === text). Returns null when a single unit
 * exceeds max (this separator cannot solve it - caller falls through).
 */
function chunkBy(text: string, sep: string, max: number): string[] | null {
  const units = text.split(sep);
  if (units.length < 2) return null;
  const chunks: string[] = [];
  let cur = "";
  for (const [i, unit] of units.entries()) {
    // every unit after the first arrives WITH its leading separator
    if (unit.length + (i > 0 ? sep.length : 0) > max) return null;
    if (i === 0) {
      cur = unit;
      continue;
    }
    const candidate = cur + sep + unit;
    if (candidate.length <= max) {
      cur = candidate;
    } else {
      chunks.push(cur);
      cur = sep + unit; // the boundary separator lives at the start of the next chunk
    }
  }
  if (cur !== "") chunks.push(cur);
  return chunks;
}

/**
 * E2 chunking: paragraph ("\n\n"), else line, else hard cut; every chunk
 * <= max; chunks.join("") === text. Redaction must run on the WHOLE text
 * before chunking (ADR-0005 E2) - that ordering lives in the hook layer.
 */
export function chunk(text: string, max: number = MAX_CHUNK): string[] {
  let m = Math.trunc(max);
  if (!Number.isFinite(m) || m < 1) m = 1;
  const t = String(text ?? "");
  if (t.length <= m) return [t];
  return chunkBy(t, "\n\n", m) ?? chunkBy(t, "\n", m) ?? hardCut(t, m);
}

// E5 ack patterns, applied to the WHOLE text trimmed and shorter than 40
// chars (trailing . ! ignored), case-insensitive: the single-word set,
// "T<n> ready" (incl. T4-fix-2), and a 1-2 word "<x> done" report. A sentence
// that merely ends in "done" ("Auth bug is not done") is NOT an ack (F-obs a).
const ACK_WORDS = /^(?:ok|yes|no|thanks|done|ack|acked|standing by|ready|noted)[\s.!]*$/i;
const ACK_T_READY = /^T\d+\S* ready[\s.!]*$/i;
const ACK_DONE_SUFFIX = /^(?:[\w][\w'.-]* +){1,2}done[\s.!]*$/i;

export function isAck(text: string): boolean {
  const t = String(text ?? "").trim();
  if (t === "" || t.length >= 40) return false;
  return ACK_WORDS.test(t) || ACK_T_READY.test(t) || ACK_DONE_SUFFIX.test(t);
}

export interface ReasoningInput {
  /** dm: one recipient; multi: a To: list; broadcast: "broadcast to <rig>", no list. */
  kind: "dm" | "multi" | "broadcast";
  /** Recipient peer ids in the To: list (empty for a broadcast). */
  to: string[];
  selfPeer: string;
  /** HONCHO_LEADER_PEER; unset = no leader known. */
  leaderPeer?: string;
  /**
   * The sender's peer id. REQUIRED to apply E4's leader-sent exception;
   * unset = the sender cannot be recognised as the leader (the given
   * interface had no sender - flagged to architect).
   */
  senderPeer?: string;
  content: string;
}

/**
 * E4/E5: should THIS recipient's copy enable deriver reasoning?
 * acks never do; DMs always do; a multi-recipient fan-out reasons only at
 * the recipient whose peer id sorts first; a broadcast reasons only for the
 * leader - except when the leader is the sender, where every seat reasons
 * (no seat can know the others' decisions).
 */
export function reasoningFor(i: ReasoningInput): boolean {
  if (isAck(i.content)) return false;
  switch (i.kind) {
    case "dm":
      return true;
    case "multi": {
      const to = Array.isArray(i.to) ? i.to : [];
      return to.length > 0 && i.selfPeer === [...to].sort()[0];
    }
    case "broadcast":
      if (i.senderPeer !== undefined && i.leaderPeer !== undefined && i.senderPeer === i.leaderPeer) {
        return true;
      }
      return i.leaderPeer !== undefined && i.selfPeer === i.leaderPeer;
    default:
      return false;
  }
}

/** R2: stable dedupe id - sha256 hex over seat, session, created_at, content. */
export function clientId(seat: string, session: string, createdAt: string, content: string): string {
  return createHash("sha256")
    .update([seat, session, createdAt, content].join("\u0000"), "utf8")
    .digest("hex");
}
