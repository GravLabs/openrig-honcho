// T19c (ADR-0014 decision 4): the ONE shared term definition. The novelty
// filter (plugin/src/recall.ts) and the use-metric (scripts/eval-use.ts)
// must agree on what a term is, so the definitions live here and both
// import them. The token grammar, the GENERIC set and the lowercasing are
// byte-moved from scripts/eval-use.ts on 2026-11-04 - the metric
// (METRIC_VERSION eval-use-v1.1) and its results are unchanged by the move.
//
// File access: readTranscriptTail is the ONLY fs touch here, on purpose -
// the pure string half (knownTermsFromTranscript, tokensOf) is what the
// render filter and the metric use; the hook calls the tail reader while the
// network queries are in flight and hands the render a plain Set.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Terms too generic to count as "new information" (from the v0.2.2
 * prototype; keep in sync with docs/EVALUATION.md section 4 if the
 * architect changes the list). */
export const GENERIC: ReadonlySet<string> = new Set(
  ("already current instead through against remaining states context summary records " +
    "version applied without command client issuing remove removed startup rejection " +
    "handoff reproduced deleted secret credential device awaiting mutation").split(" "),
);

/** A term: a word of 6+ chars (word start, then word chars and the
 * path/id punctuation), a hex-ish id of 7+ digits, or a dotted version
 * number. Lowercased on collection. Shared grammar by design (see header). */
export const TOKEN_RE = /[A-Za-z][A-Za-z0-9._/-]{5,}|[0-9a-f]{7,}|\b\d+\.\d+(?:\.\d+)?\b/g;

/** The set of terms in a string, lowercased (the metric's and the filter's
 * single term extractor). */
export function tokensOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of (typeof s === "string" ? s : "").matchAll(TOKEN_RE)) out.add(m[0].toLowerCase());
  return out;
}

// 1 MB, not the ADR's first 200 KB: a real transcript tail is mostly non-message records
// (request blobs, file history), so 200 KB held only ~29 messages (~300 terms); 1 MB gave
// ~850 terms in ~3 ms on a real transcript, ~9 ms worst case on pure message text
// (architect, T19c acceptance, ADR-0014 decision 4 amended)
export const TAIL_BYTES = 1_000_000;

/** T19c: the transcript tail the novelty filter reads - the LAST maxBytes
 * only, taken from the end. A missing or unreadable file returns undefined
 * (= no filter, the row's rule). Never reads the head of a big file. */
export function readTranscriptTail(path: string, maxBytes: number = TAIL_BYTES): string | undefined {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, Math.max(0, maxBytes));
      const buf = Buffer.allocUnsafe(len);
      if (len > 0) readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** The user/assistant message text of one transcript entry: a plain string
 * content, or the text parts of an array content. Tool results, tool
 * inputs, thinking and every metadata field are NOT text and never become
 * known terms (row: "the terms of the user and assistant text"). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const p of content) {
      if (
        p !== null && typeof p === "object" &&
        (p as Record<string, unknown>).type === "text" &&
        typeof (p as Record<string, unknown>).text === "string"
      ) {
        out += (p as Record<string, unknown>).text + "\n";
      }
    }
    return out;
  }
  return "";
}

/**
 * The known-term set of a transcript tail (as read by readTranscriptTail,
 * so possibly cut mid-line and mid-character) plus the incoming message's
 * own terms (row: "the incoming message's own terms count as known too").
 * Malformed or partial lines are skipped silently - a line that does not
 * parse as a user/assistant entry contributes nothing.
 */
export function knownTermsFromTranscript(tail: string, incoming: string): Set<string> {
  const known = new Set<string>();
  const add = (s: string): void => {
    for (const m of s.matchAll(TOKEN_RE)) known.add(m[0].toLowerCase());
  };
  for (const line of (typeof tail === "string" ? tail : "").split("\n")) {
    if (line === "") continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // the head cut and any garbage line
    }
    if (e === null || typeof e !== "object") continue;
    const type = (e as Record<string, unknown>).type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = (e as Record<string, unknown>).message;
    if (msg === null || typeof msg !== "object") continue;
    add(messageText((msg as Record<string, unknown>).content));
  }
  add(typeof incoming === "string" ? incoming : "");
  return known;
}
