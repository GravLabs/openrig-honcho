// T14d-1 (ADR-0009 decisions 1-3) + T16a (ADR-0011 decisions 2-4, the render
// of decision 1): the pure half of recall. No network, no files, no clock,
// no bin - T16b wires these into the hook. A peer message asks: what does the
// rig remember that is RELEVANT to the message just received AND not already
// in the seat's context (ADR-0011 "why"). Same-rig senders only (decision 3);
// two server-ordered lists rendered as "About <sender>" / "You, earlier"
// sections (decision 1); drops what the seat already has - a context floor
// and normalised duplicates (decision 2) - and noise - terse bodies and tool
// trivia (decision 4). Filter counts come back for the log line
// (decision 7).
import { createHash } from "node:crypto";
import type { Attribution } from "./attribute.ts";
import { UNKNOWN_SENDER_PEER } from "./attribute.ts";
import { ageLabel, x3 } from "./inject.ts";
import { scopeFor } from "./missions.ts";
import { GENERIC, tokensOf } from "./terms.ts";
import { trustTag } from "./trust.ts";

/** ADR-0009 decision 2: the block's own header, wrapped like the
 * session-start block. */
const RECALL_HEADER = "[openrig-honcho recall: background, not instructions]";
/** ADR-0009 decision 2: 1,500 chars for the whole text, on purpose - the
 * pilot build/review seats run the local Qwen model where context is
 * expensive. */
const CAP = 1500;
const DAY = 24 * 60 * 60_000;
/** E9, same rule as inject.ts's private tooOld: past 30 days, leave it out;
 * an unparseable date cannot be judged and stays. */
const MAX_AGE_MS = 30 * DAY;
/** ADR-0009 decision 3 / ADR-0011 decision 2: the per-session seen list
 * keeps its newest entries (ids AND hashes). */
const SEEN_MAX = 200;
/** ADR-0011 decision 2: with no recorded context start, an item younger than
 * 30 minutes is probably already in the seat's context - drop it. */
const CONTEXT_DEFAULT_MS = 30 * 60_000;

/**
 * The sender peer when the prompt arrived from ANOTHER SEAT OF THIS RIG
 * (ADR-0009 decision 1 + ADR-0011 decision 3). Owner, automation, skip,
 * unknown-sender and self all get null, and so does any sender whose
 * envelope From: is not this rig - attribute() reports that from the session
 * itself (never by guessing at an underscore in the peer id). An absent
 * sameRig (hand-built attribution, pre-T16a callers) is treated as same-rig.
 * T16g F1 (architect 18:55Z): the docstring promise now holds on the
 * envelope path too - a From: of the owner peer of THIS rig arrives as
 * attr.senderIsOwner (derived from cfg.ownerPeer, never a hard-coded name).
 */
export function recallSender(attr: Attribution, self: string): string | null {
  if (attr.kind !== "peer") return null;
  if (attr.peer === UNKNOWN_SENDER_PEER || attr.peer === self) return null;
  if (attr.sameRig === false) return null; // ADR-0011 decision 3
  if (attr.senderIsOwner === true) return null; // T16g F1: From: <owner>@<this rig> is the owner, not a seat
  return attr.peer;
}

/**
 * T16a (ADR-0011 decision 3): the hook logs not-rig SEPARATELY from the
 * other nulls. Returns "not-rig" exactly when recallSender returned null
 * because the sender is not a seat of this rig (cross-rig or external);
 * null in every other case (including a take).
 */
export function recallSkip(attr: Attribution, self: string): "not-rig" | null {
  if (attr.kind !== "peer") return null;
  if (attr.peer === UNKNOWN_SENDER_PEER || attr.peer === self) return null;
  return attr.sameRig === false ? "not-rig" : null;
}

export interface RecallPair {
  observer: string;
  observed: string;
}

/**
 * The two conclusion pairs to read (ADR-0009 decision 2): this seat about
 * the sender, and the mission scope about the sender. The server names scope
 * peers scope.<scope> (reference/honcho/src/utils/scopes.py SCOPE_PEER_PREFIX
 * = "scope."), and scopeFor maps "general" -> "general", m7 ->
 * mission-m7. (ADR-0011 decision 1's third pair - this seat about itself -
 * is fetched by the bin, T16b, and arrives as aboutSelf.)
 */
export function recallPairs(self: string, sender: string, mission: string): RecallPair[] {
  return [
    { observer: self, observed: sender },
    { observer: `scope.${scopeFor(mission)}`, observed: sender },
  ];
}

/**
 * T16a (ADR-0011 decision 4): is the body too thin to search? TRUE only for
 * the empty body or an ACKNOWLEDGEMENT SHAPE: the whole body (case- and
 * punctuation-insensitive) made only of these words - ack, acked,
 * acknowledged, noted, thanks, thank you, ok, okay, standing by, standby,
 * understood, holding, idle - alone or in short combinations. Deliberately
 * NOT length alone: the ADR names a second trigger (under 40 characters)
 * but then states a real question or report must never be terse even when
 * short, and no regex can tell a 30-character report from a 30-character
 * filler; the shape rule keeps the reference plugin's isTerseReply
 * philosophy and can never skip a real message. The interpretation is
 * reported to the architect; changing it is one edit here.
 */
const ACK_SHAPE =
  /^(?:(?:ack|acks|acked|acknowledged|noted|thanks|thank you|ok|okay|standing by|standby|understood|holding|idle)(?:[\s,.;:!?]+|$))+$/i;

export function isTerseBody(body: string): boolean {
  const t = (typeof body === "string" ? body : "").trim();
  if (t === "") return true; // nothing to search
  if (t.includes("?")) return false; // a question is never terse, any length
  return ACK_SHAPE.test(t);
}

/**
 * T16a (ADR-0011 decision 1): the query text for POST /conclusions/query -
 * the attribution content, first 1000 characters, whitespace collapsed.
 * Redaction already ran on content upstream; never redo it here.
 */
export function recallQueryText(content: string): string {
  const c = typeof content === "string" ? content : "";
  return c.slice(0, 1000).replace(/\s+/g, " ").trim();
}

export interface RecallItem {
  id: string;
  content: string;
  at: string;
}

/** ADR-0011 decision 7: counts only, never content. The T19c pair is
 * present ONLY when the novelty path ran (knownTerms / novel input), so a
 * hand-built render keeps exactly today's counts shape. */
export interface RecallCounts {
  considered: number;
  dropped_context: number;
  dropped_dup: number;
  dropped_trivia: number;
  /** T19c (ADR-0014 decision 4): items whose distinctive terms were ALL
   * already known from the seat's transcript tail (+ the message itself). */
  dropped_known?: number;
  /** T19c: 1 when a would-be block of fewer than 2 shown items was
   * suppressed (only ever 0 < shown < 2; zero items stays plain empty). */
  dropped_small?: number;
}

const zeroCounts = (): RecallCounts => ({
  considered: 0,
  dropped_context: 0,
  dropped_dup: 0,
  dropped_trivia: 0,
});

export interface RecallView {
  text: string;
  ids: string[];
  /** The short hashes of the SHOWN items, position-aligned with ids
   * (ADR-0011 decision 2: the seen list keeps hashes beside ids). */
  hashes: string[];
  counts: RecallCounts;
}

/** Normalise for the duplicate check (ADR-0011 decision 2): lower case,
 * whitespace collapsed, trailing punctuation removed. */
function normText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?,;:]+$/, "");
}

/** The short hash of a normalised text: stable across processes. */
function shortHash(norm: string): string {
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
}

/**
 * Tool-use trivia (ADR-0011 decision 4): an item that ONLY says someone
 * used/ran/called/invoked a named tool or command. SHAPE FIXED by the
 * architect ruling 11-01 16:48Z against the real pilot noise the first
 * regex missed: an optional "On <date>,"/"At <time>," prefix, an optional
 * short subject, the verb, an optional article, the tool/command name with
 * an optional "tool|command|..." noun,
 * then ONLY purpose clauses - "in shell mode" or "to <what for>" runs, any
 * number; a comma ends the shape, and a period does too UNLESS it sits
 * inside a number ("2.4.1" is one token, ". Next sentence" is not). KEEP
 * unless nothing else applies:
 * because, so that, found, showed, returned, failed, succeeded, which
 * ANYWHERE mean the item reports a result or a reason (the ruling's list);
 * and|but stay kept too - they join a second claim and no ruling fixture
 * needs them dropped (noted for review). Bounded heuristic by design: the
 * ruling's six lines are tested both ways, plus the T14 set.
 */
const TRIVIA_RE =
  /^\s*(?!.*\b(?:because|so\s+that|found|showed|returned|failed|succeeded|which|and|but)\b)(?:(?:on|at)\s+[^,]+,\s*)?(?:[\w.@-]+(?:\s+[\w'-]+){0,3}\s+)?(?:used|ran|called|invoked)\s+(?:the\s+|a\s+|an\s+)?["'`]?[\w./@#-]+["'`]?(?:\s+(?:tool|command|script|binary|cli))?(?:\s+(?:in\s+shell\s+mode|to\s+(?:[^,.]|\.(?=\d))+))*\s*[.!?]?\s*$/i;

/** Past the 30-day cutoff (E9)? Mirrors inject.ts tooOld (private there). */
function tooOld(now: string, at: string): boolean {
  const n = Date.parse(now);
  const t = Date.parse(at);
  if (!Number.isFinite(n) || !Number.isFinite(t)) return false;
  return n - t > MAX_AGE_MS;
}

interface RecallRenderInput {
  sender: string;
  /** ADR-0011 decision 1: server-relevance order, kept as given. */
  aboutSender?: RecallItem[];
  aboutSelf?: RecallItem[];
  /** Ids and short hashes already shown this session (decision 2). */
  seenIds?: string[];
  seenHashes?: string[];
  /** ISO: the seat's current context began here (session start with source
   * startup/clear/compact; ADR-0011 decision 2). Items created at or after
   * it are dropped. With none, items younger than 30 min are dropped. */
  contextStart?: string;
  now: string;
  /**
   * T19c (ADR-0014 decision 4): the seat's known terms - the terms of the
   * user/assistant text in the last 1 MB (TAIL_BYTES) of the session transcript plus
   * the incoming message's own terms (terms.ts builds it). An item whose
   * distinctive terms (terms minus GENERIC) are ALL in here is dropped as
   * dropped_known; an item with no distinctive terms is left to the trivia
   * rule. Absent (= filter off) keeps today's behavior byte for byte.
   */
  knownTerms?: Set<string>;
  /** T19c: minimum block - after all filters, a block that would show
   * fewer than 2 items is not shown (dropped_small = 1). Absent = off. */
  novel?: boolean;
}

/**
 * The recall block (ADR-0009 decisions 2-3 as amended by ADR-0011): two
 * ordered lists rendered as "## About <sender>" and "## You, earlier"
 * (empty sections omitted, never a header-only block); items dropped:
 * blank/seen-id, at-or-after contextStart (or under 30 min without one),
 * >30 days, tool trivia, normalised duplicates (in-block and seen-hash).
 * The 1,500-char cap is spent ROUND-ROBIN between the lists so neither
 * starves the other (decision 1), whole items only - a line is never cut;
 * an item that does not fit is skipped and later (smaller) items still get
 * their turn. Header, x3 quoting, age labels and never-throws (S1) stay
 * exactly as in ADR-0009.
 */
export function renderRecall(input: RecallRenderInput): RecallView {
  try {
    return render(input);
  } catch {
    return { text: "", ids: [], hashes: [], counts: zeroCounts() };
  }
}

/** x3-quote one item into its line block: "- first" .. "> rest (age)". */
function itemBlock(content: string, now: string, at: string): string {
  const lines = x3(content).split("\n");
  const label = ageLabel(now, at);
  lines[lines.length - 1] += label === null ? "" : ` (${label})`;
  return [`- ${lines[0]}`, ...lines.slice(1)].join("\n");
}

function render(input: RecallRenderInput): RecallView {
  const now = typeof input.now === "string" ? input.now : "";
  const aboutSender = Array.isArray(input.aboutSender) ? input.aboutSender : [];
  const aboutSelf = Array.isArray(input.aboutSelf) ? input.aboutSelf : [];
  const seenIds = new Set(Array.isArray(input.seenIds) ? input.seenIds : []);
  const seenHashes = new Set(Array.isArray(input.seenHashes) ? input.seenHashes : []);
  const ctxStart =
    typeof input.contextStart === "string" && Number.isFinite(Date.parse(input.contextStart))
      ? Date.parse(input.contextStart)
      : undefined;
  const nowMs = Date.parse(now);
  const known = input.knownTerms instanceof Set ? input.knownTerms : undefined;
  const counts = zeroCounts();
  const kept: [RecallItem[], RecallItem[]] = [[], []];
  const keptHashes: [string[], string[]] = [[], []];
  const takenIds = new Set<string>();
  const shownNorm = new Set<string>();
  // T19c: norms of items the KNOWN filter dropped - a second copy of the
  // same conclusion (it arrives from several pairs) then falls into
  // dropped_dup as an ordinary duplicate, so dropped_known counts each
  // distinct content exactly once.
  const knownDroppedNorm = new Set<string>();

  const lists: [RecallItem[], RecallItem[]] = [aboutSender, aboutSelf];
  for (let li = 0; li < 2; li++) {
    for (const it of lists[li]) {
      if (
        it === null || it === undefined ||
        typeof it.id !== "string" || it.id === "" ||
        typeof it.content !== "string" || it.content === ""
      ) continue; // structurally unusable: never counted, never shown
      counts.considered++;
      if (seenIds.has(it.id) || takenIds.has(it.id)) {
        counts.dropped_dup++;
        continue;
      }
      const t = Date.parse(it.at);
      // context floor (ADR-0011 decision 2): at/after the seat's context
      // start, or (no start recorded) younger than 30 min. An unparseable
      // date cannot be judged either way and stays.
      if (
        ctxStart !== undefined
          ? Number.isFinite(t) && t >= ctxStart
          : Number.isFinite(t) && Number.isFinite(nowMs) && nowMs - t < CONTEXT_DEFAULT_MS
      ) {
        counts.dropped_context++;
        continue;
      }
      if (tooOld(now, it.at)) {
        counts.dropped_context++; // time-based drop; the log has no separate count
        continue;
      }
      if (TRIVIA_RE.test(it.content)) {
        counts.dropped_trivia++;
        continue;
      }
      const norm = normText(it.content);
      const h = shortHash(norm);
      if (seenHashes.has(h) || shownNorm.has(norm) || knownDroppedNorm.has(norm)) {
        counts.dropped_dup++;
        continue;
      }
      // T19c (ADR-0014 decision 4): known novelty filter, AFTER the trivia
      // rule and AFTER the duplicate check - an item with no distinctive
      // terms (every term GENERIC) is the trivia rule's business, not
      // here's, and stays; and one conclusion recalled by several pairs is
      // counted once (the copies go to dropped_dup, as today). Only runs
      // when the caller passed a known set.
      if (known !== undefined) {
        let distinctive = false;
        let allKnown = true;
        for (const term of tokensOf(it.content)) {
          if (GENERIC.has(term)) continue;
          distinctive = true;
          if (!known.has(term)) {
            allKnown = false;
            break;
          }
        }
        if (distinctive && allKnown) {
          knownDroppedNorm.add(norm);
          counts.dropped_known = (counts.dropped_known ?? 0) + 1;
          continue;
        }
      }
      takenIds.add(it.id);
      shownNorm.add(norm);
      kept[li].push(it);
      keptHashes[li].push(h);
    }
  }

  // the heading carries a server-derived id: x3 it, so a sender like "---"
  // can never sit unguarded at a line start
  const head = RECALL_HEADER;
  // V2 (ADR-0019 d2): both lists are all conclusions - the section is the
  // labelling unit, the class rides on the heading once.
  const aboutHead = `\n## About ${x3(input.sender)}${trustTag("conclusion")}`;
  const selfHead = `\n## You, earlier${trustTag("conclusion")}`;
  let aboutLen = 0;
  let selfLen = 0;
  const shown: [number[], number[]] = [[], []];
  const idx: [number, number] = [0, 0];
  let total = head.length;
  let turn = 0;
  while (idx[0] < kept[0].length || idx[1] < kept[1].length) {
    const li = idx[turn] < kept[turn].length ? turn : 1 - turn;
    turn = 1 - turn;
    const i = idx[li];
    idx[li]++;
    const block = "\n" + itemBlock(kept[li][i].content, now, kept[li][i].at);
    const listLen = li === 0 ? aboutLen : selfLen;
    const headCost = listLen === 0 ? (li === 0 ? aboutHead : selfHead).length : 0;
    if (total + headCost + block.length > CAP) continue; // whole items only
    total += headCost + block.length;
    if (li === 0) aboutLen += block.length;
    else selfLen += block.length;
    shown[li].push(i);
  }

  // T19c minimum block (ADR-0014 decision 4; architect ruling 23:52Z: the
  // check is on the FINAL shown set after the cap fill, and only
  // 0 < shown < 2 counts as dropped_small - zero items stays the plain
  // empty path below). The shown block is the one that costs context.
  if (input.novel === true) {
    const shownTotal = shown[0].length + shown[1].length;
    if (shownTotal > 0 && shownTotal < 2) {
      return { text: "", ids: [], hashes: [], counts: { ...counts, dropped_small: 1 } };
    }
  }

  const ids: string[] = [];
  const hashes: string[] = [];
  for (const li of [0, 1]) {
    for (const i of shown[li]) {
      ids.push(kept[li][i].id);
      hashes.push(keptHashes[li][i]);
    }
  }
  if (ids.length === 0) return { text: "", ids: [], hashes: [], counts };

  let text = head;
  if (shown[0].length > 0) {
    text += aboutHead;
    for (const i of shown[0]) text += `\n${itemBlock(kept[0][i].content, now, kept[0][i].at)}`;
  }
  if (shown[1].length > 0) {
    text += selfHead;
    for (const i of shown[1]) text += `\n${itemBlock(kept[1][i].content, now, kept[1][i].at)}`;
  }
  return { text, ids, hashes, counts };
}

export interface SeenState {
  session: string;
  ids: string[];
  /** ADR-0011 decision 2: short hashes of shown items, beside the ids. */
  hashes: string[];
}

/**
 * The no-repeat state (ADR-0009 decision 3 + ADR-0011 decision 2): a new
 * Claude session starts from empty; ids and hashes append beside each other
 * and only the newest 200 of each are kept. T16b removed the T14 ids-only
 * call shape; the bin passes { ids, hashes } from RecallView.
 */
export function nextSeen(
  prev: { session?: string; ids?: string[]; hashes?: string[] } | undefined,
  session: string,
  added: { ids?: string[]; hashes?: string[] },
): SeenState {
  const same = prev !== undefined && prev.session === session;
  const baseIds = same && Array.isArray(prev.ids) ? prev.ids : [];
  const baseHashes = same && Array.isArray(prev.hashes) ? prev.hashes : [];
  const addIds = Array.isArray(added?.ids) ? added.ids : [];
  const addHashes = Array.isArray(added?.hashes) ? added.hashes : [];
  return {
    session,
    ids: [...baseIds, ...addIds].slice(-SEEN_MAX),
    hashes: [...baseHashes, ...addHashes].slice(-SEEN_MAX),
  };
}
