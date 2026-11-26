// The Stop reply writer (T6b; ADR-0003 "Replies", ADR-0005 E3, ADR-0001
// hook table). Records the just-completed turn's assistant TEXT as this
// seat's peer, metadata.kind "reply", through the shared pipeline
// (writer.ts recordBody: replay-first, free-n, ensure, redact-before-chunk,
// send-or-spool) into the seat's CURRENT session (resolveSession with no
// source). Tool calls and tool results are never recorded. Never written to
// the profile workspace.
//
// Segment rule (same shape as claude-honcho's getCurrentTurnAssistantMessages,
// read-only reference): walk back to the last REAL user prompt - a user entry
// with text, a system wakeup, or a typed slash/skill entry; tool_result-only
// user entries are mid-turn, not boundaries - then collect assistant text
// blocks after it, joined with blank lines. If the last block does not match
// payload's last_assistant_message (Stop can fire before the transcript
// flush), the payload copy fills in.
//
// E3 dedupe (T6b-fix, ADR-0005 amendment 85e010c): sha256 over the TURN, not
// the bare text — the hash input is `<turn id>\n<text>` when the boundary
// entry that opened this turn carries a uuid (real transcripts do), and the
// text alone when there is no readable transcript or the boundary entry has
// no uuid. Same turn firing twice (Stop re-fires on wakeups) is skipped; the
// identical text on a genuinely different turn is a different turn id and is
// recorded. The hash is stored under the seat lock after a successful
// send/spool and survives resolveSession's state rewrites; the field name
// (last_reply_hash) is unchanged — it is an opaque dedupe token.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { saveCheckpoint } from "./checkpoint.ts";
import type { Config } from "./env.ts";
import { withLock, writeJsonAtomic } from "./lock.ts";
import { logEvent, modelFromInput } from "./log.ts";
import { readSeatState, seatLockDir, seatStatePath } from "./missions.ts";
import { shownId } from "./shown.ts";
import { recordBody, type WriterDeps, type WriterOutcome } from "./writer.ts";

export interface StopInput {
  transcript_path?: string;
  last_assistant_message?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  /**
   * C2b (review F1): Codex's own turn identity, forwarded by the Stop bin
   * ONLY under --harness codex (Codex has no transcript, so the segment
   * yields no turnId). Claude never sends it - the transcript uuid keeps
   * full control of the E3 hash there, byte-identically.
   */
  turn_id?: string;
}

interface TEntry {
  uuid?: string;
  type?: string;
  timestamp?: string;
  role?: string;
  isMeta?: boolean;
  promptSource?: string;
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown; model?: unknown };
  content?: unknown;
}

const entryKind = (e: TEntry): string => e.type ?? e.role ?? "";

/** text blocks of an entry joined; "" for string-less entries (tool_result,
 * tool_use, images...). String content (older transcripts) counts as text. */
function textOf(entry: TEntry): string {
  const c = entry.message?.content ?? entry.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string" && b.text !== "")
      .map((b) => b.text as string)
      .join("\n\n");
  }
  return "";
}

function isWakeup(entry: TEntry): boolean {
  return entry.promptSource === "system" || entry.origin?.kind === "task-notification";
}

/** True for entries that START a new segment: real prompts and wakeups.
 * isMeta entries (model-invoked skills) and tool_result-only user entries
 * stay inside the current turn. */
function isBoundary(entry: TEntry): boolean {
  if (entryKind(entry) !== "user" || entry.isMeta === true) return false;
  return textOf(entry).trim() !== "" || isWakeup(entry);
}

interface Segment {
  text: string;
  /**
   * The uuid of the boundary entry that opened this turn (T6b-fix), or
   * undefined when no readable transcript yielded a uuid'd boundary — the E3
   * hash then falls back to the text alone.
   */
  turnId: string | undefined;
  /**
   * F1 (ADR-0006 S5, architect 22:25Z): the transcript timestamp of the
   * turn's LAST non-empty assistant text block; the reply's created_at.
   * undefined when the transcript carries none for it - recordBody then
   * falls back to the hook wall clock.
   */
  ts: string | undefined;
}

/** B10 (architect note 2026-11-26): the transcript is read ONCE per Stop
 * run; the bin loads the lines here and shares them between segment,
 * transcriptModel and scanUsedIds. undefined = no readable transcript. */
export function readTranscriptLines(transcriptPath: string | undefined): string[] | undefined {
  if (transcriptPath === undefined || transcriptPath === "" || !existsSync(transcriptPath)) return undefined;
  try {
    return readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return undefined;
  }
}

/** The current turn: assistant text ("" when there is none) + turn id. */
function segment(
  transcriptPath: string | undefined,
  lastAssistantMessage: string | undefined,
  preLines?: string[],
): Segment {
  const blocks: string[] = [];
  let turnId: string | undefined;
  let lastBlockTs: string | undefined;
  const loaded = preLines ?? readTranscriptLines(transcriptPath);
  if (loaded !== undefined) {
    const lines = loaded.filter((l) => l.trim() !== "");
    let lastBoundary = -1;
    let lastBoundaryEntry: TEntry | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as TEntry;
        if (isBoundary(e)) {
          lastBoundary = i;
          lastBoundaryEntry = e;
          break;
        }
      } catch {
        continue; // corrupt line: skipped (S2-like)
      }
    }
    if (lastBoundary >= 0) {
      if (typeof lastBoundaryEntry?.uuid === "string" && lastBoundaryEntry.uuid !== "") {
        turnId = lastBoundaryEntry.uuid;
      }
      let blockTs: string | undefined; // F1: last assistant block's transcript ts wins
      for (let i = lastBoundary + 1; i < lines.length; i++) {
        try {
          const e = JSON.parse(lines[i]) as TEntry;
          if (entryKind(e) !== "assistant") continue;
          const t = textOf(e);
          if (t.trim() !== "") {
            blocks.push(t);
            blockTs = typeof e.timestamp === "string" && e.timestamp !== "" ? e.timestamp : undefined;
          }
        } catch {
          continue;
        }
      }
      lastBlockTs = blockTs;
    }
  }
  const last = lastAssistantMessage?.trim();
  if (last !== undefined && last !== "" && blocks[blocks.length - 1]?.trim() !== last) {
    blocks.push(last); // not a transcript line: lastBlockTs unchanged (F1)
  }
  return { text: blocks.join("\n\n"), turnId, ts: lastBlockTs };
}

/**
 * ADR-0022 decision 1 (Claude's Stop fallback — the probe of 2026-11-26
 * found no model key in ANY Claude hook input, while the transcript's newest
 * assistant entry carries `message.model`). Backwards scan: the NEWEST
 * assistant entry decides - its validated message.model or nothing (a
 * rejected or missing value is absent, never an older entry's). Reads the
 * same file the segment scan already reads; corrupt lines are skipped, a
 * missing or unreadable file is simply "cannot know". Only the one validated
 * id leaves - no entry text (X1).
 */
export function transcriptModel(transcriptPath: string | undefined, preLines?: string[]): string | undefined {
  const lines = preLines ?? readTranscriptLines(transcriptPath);
  if (lines === undefined) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let e: TEntry;
    try {
      e = JSON.parse(line) as TEntry;
    } catch {
      continue;
    }
    if (entryKind(e) !== "assistant") continue;
    return modelFromInput(e.message?.model);
  }
  return undefined;
}

/**
 * ADR-0022 decision 3 (B10, amended after review R27): which of this
 * session's shown ids appear in the turn the Stop hook is already reading,
 * split CITED / ACTED (the amendment's two counts). Cited: the segment's
 * assistant text blocks plus the harness's last_assistant_message - an id in
 * text can be a plain echo of the injected block. Acted: the JSON of every
 * tool_use input (an id passed to a rig_memory tool or a queue command) -
 * only acted counts as use in v0.6 evidence. Codex transcripts have no
 * Claude-shaped assistant entries, so there the message alone decides and
 * Codex has cited counts only.
 * Matching (R27 F-V1): an id matches only at token boundaries - no
 * [A-Za-z0-9_-] immediately before or after it, so d-ffff0001 never matches
 * inside d-ffff00011. Conclusion ids are free tokens, so ones shorter than
 * 8 characters or made only of letters (done, LEARNED) are never scanned.
 * Plain in-process match - no model, no network, no text leaves (X1).
 */
export interface UsedSplit {
  cited: string[];
  acted: string[];
}

/** R27 F-V1: is this shown entry ever scannable? Conclusion ids are free
 * text; short or all-letter ones collide with ordinary words. */
export function scannableEntry(e: string): boolean {
  const i = e.indexOf(":");
  if (i < 0) return false;
  if (e.slice(0, i) !== "conclusion") return true;
  const body = e.slice(i + 1);
  return body.length >= 8 && !/^[A-Za-z]+$/.test(body);
}

const regexEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** R27 F-V1: token-boundary presence. Ids only ever carry [A-Za-z0-9._:@-];
 * a word char, extra letter-run or hyphen on either side means the match is
 * a substring of a longer token, not a use of this id. */
function idPresent(haystack: string, id: string): boolean {
  if (id === "") return false;
  return new RegExp(`(?<![A-Za-z0-9_-])${regexEsc(id)}(?![A-Za-z0-9_-])`).test(haystack);
}

/** The cited/acted split for this turn (ADR-0022 d3, amended). */
export function scanUsedSplit(
  shown: string[],
  transcriptPath: string | undefined,
  lastAssistantMessage: string | undefined,
  preLines?: string[],
): UsedSplit {
  const cited: string[] = [];
  const acted: string[] = [];
  if (shown.length === 0) return { cited, acted };
  const textParts: string[] = [];
  const inputParts: string[] = [];
  const loaded = preLines ?? readTranscriptLines(transcriptPath);
  if (loaded !== undefined) {
    const lines = loaded.filter((l) => l.trim() !== "");
    let lastBoundary = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        if (isBoundary(JSON.parse(lines[i]) as TEntry)) {
          lastBoundary = i;
          break;
        }
      } catch {
        continue; // corrupt line: skipped (S2-like)
      }
    }
    if (lastBoundary >= 0) {
      for (let i = lastBoundary + 1; i < lines.length; i++) {
        try {
          const e = JSON.parse(lines[i]) as TEntry;
          if (entryKind(e) !== "assistant") continue;
          const t = textOf(e);
          if (t.trim() !== "") textParts.push(t);
          const c = e.message?.content ?? e.content;
          if (Array.isArray(c)) {
            for (const b of c as Array<{ type?: string; input?: unknown }>) {
              if (b !== null && typeof b === "object" && b.type === "tool_use") {
                try {
                  inputParts.push(JSON.stringify(b.input ?? ""));
                } catch {
                  // unserializable input: this block adds nothing
                }
              }
            }
          }
        } catch {
          continue;
        }
      }
    }
  }
  const last = lastAssistantMessage?.trim();
  if (last !== undefined && last !== "") textParts.push(last);
  const citedHay = textParts.join("\n");
  const actedHay = inputParts.join("\n");
  for (const e of shown) {
    if (!scannableEntry(e)) continue;
    const id = shownId(e);
    // acted first: a tool-call use is the stronger evidence, and an id in
    // both text and input lands in acted only - the union is unchanged.
    if (idPresent(actedHay, id)) acted.push(e);
    else if (idPresent(citedHay, id)) cited.push(e);
  }
  return { cited: cited.sort(), acted: acted.sort() };
}

/** used = cited plus acted, for compatibility (ADR-0022 d3 amendment). */
export function scanUsedIds(
  shown: string[],
  transcriptPath: string | undefined,
  lastAssistantMessage: string | undefined,
  preLines?: string[],
): string[] {
  const { cited, acted } = scanUsedSplit(shown, transcriptPath, lastAssistantMessage, preLines);
  return [...new Set([...cited, ...acted])].sort();
}

/** The current segment's assistant text, "" when there is none. */
export function turnAssistantText(
  transcriptPath: string | undefined,
  lastAssistantMessage: string | undefined,
): string {
  return segment(transcriptPath, lastAssistantMessage).text;
}

async function innerReply(
  input: StopInput,
  config: Config,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  if (input.stop_hook_active === true) return { action: "skipped" };

  const { text, turnId, ts } = segment(input.transcript_path, input.last_assistant_message, deps.lines);
  if (text.trim() === "") return { action: "skipped" };

  // E3 (T6b-fix): the same TURN with the same text -> nothing to do. A
  // turnId is a uuid (no newline), so a turn-hash and a fallback hash can
  // only collide if a reply's text itself began "<uuid>\n" — at worst one
  // extra skip of an identical-seeming reply, never a wrong write.
  // C2b (review F1): with no transcript (Codex) the harness-supplied
  // turn_id carries the turn identity; Claude input never has one.
  const identity = turnId ?? input.turn_id;
  const hash = createHash("sha256")
    .update(identity === undefined ? text : `${identity}\n${text}`, "utf8")
    .digest("hex");
  const seatFile = seatStatePath(config.stateDir, config.workspace, config.peer);
  if (readSeatState(seatFile)?.last_reply_hash === hash) {
    // O1: the E3 dedupe is a distinct structured outcome. The library emits
    // this run's single event itself (direct callers get it); the Stop bin
    // suppresses its own when reason === "duplicate".
    logEvent(config, { hook: "stop", event: "duplicate segment", ok: true, ms: 0 });
    return { action: "skipped", reason: "duplicate" };
  }

  // V1 (ADR-0019 d1): save the local checkpoint BEFORE the network work, so
  // a spool or a failed send cannot lose it; saveCheckpoint never throws.
  // The dup/empty/stop_hook_active paths above save nothing: old kept.
  saveCheckpoint(config.stateDir, config.workspace, config.peer, text, deps.now());
  const out = await recordBody(
    { content: text, sender: config.peer, kindTag: "reply", hookName: "stop", ...(ts !== undefined ? { createdAt: ts } : {}) },
    config,
    deps,
  );
  if (out.action !== "skipped") {
    await withLock(seatLockDir(config.stateDir, config.workspace, config.peer), () => {
      const cur = readSeatState(seatFile);
      if (cur === null) return false; // vanished: nothing to store into
      return writeJsonAtomic(seatFile, { ...cur, last_reply_hash: hash });
    });
  }
  return out;
}

/** Entry point: never throws (S1); any escape becomes a log line + skipped. */
export async function recordReply(
  input: StopInput,
  config: Config,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  try {
    return await innerReply(input, config, deps);
  } catch {
    // O1/X1: no String(e) (it could echo reply content). This IS the run's
    // single event on this path - the Stop bin suppresses its own when
    // reason === "unexpected".
    logEvent(config, { hook: "stop", event: "unexpected", ok: false, ms: 0, error_class: "other" });
    return { action: "skipped", reason: "unexpected" };
  }
}
