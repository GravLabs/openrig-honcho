// T19a (ADR-0014 decision 2 + 2026-11-04 amendment): the decision ledger.
// PURE module - no network, no files. The v3 server gives conclusions no
// metadata field, so a ledger entry is one conclusion whose content starts
// with a one-line header:
//
//   [decision d-1a2b3c4d · scope mission] <decision> (reason: <reason>)
//   [approval d-… · scope qitem-… · supersedes d-…] <text>
//   [status d-… · scope mission] <state report>   (V3, ADR-0019 d3)
//   [retire d-…] <reason>
//
// V3: for STATUS entries the newest one per (scope, mission) is the only one
// in force - a status is replaced by the next status for the same thing, with
// no model and no retire needed; older ones are history. Decisions and
// approvals are untouched by that rule (a status never ends a decision).
//
// The current ledger is every entry that no other entry supersedes and no
// retire entry names; supersession is transitive (A superseded by B, B by C,
// leaves only C). T24 (Amendment 2): plain conclusions are never decisions -
// only valid-header content on the ledger pair is; pre-ledger decisions stop
// showing in force unless migrated (scripts/migrate-ledger.ts). Hidden in
// "in force" views only (session start, ask); search still shows superseded
// entries, marked.

import { createHash } from "node:crypto";

/**
 * T24 (ADR-0014 Amendment 2): ledger entries live on their OWN pair -
 * observer the leader, observed this reserved peer. The peer never sends a
 * message, so the deriver never writes there, and provenance is structural:
 * an entry is what sits on this pair with a valid header, nothing else. The
 * writer refuses this peer as a message sender (attribute.ts) and as a
 * configured seat id (env.ts), like `openrig`.
 */
export const LEDGER_PEER = "openrig-ledger";

export type LedgerKind = "decision" | "approval" | "status";

/** An entry as parsed/stored; retire entries carry their target, nothing else. */
export type ParsedEntry =
  | { kind: "plain"; fact: string }
  | { kind: LedgerKind; id: string; scope: string; supersedes?: string; fact: string; reason?: string }
  | { kind: "retire"; target: string };

/** A ledger entry with its derived storage context (mission, time). */
export type LedgerEntry = {
  id: string;
  kind: LedgerKind | "retire";
  scope: string;
  supersedes?: string;
  /** the mission parsed from the session the conclusion lives in ("unknown" if untagged) */
  mission: string;
  fact: string;
  reason?: string;
  target?: string; // retire entries: the id they retire
  at: string;
};

/** d- + 8 lowercase hex. */
export const ID_RE = /^d-[0-9a-f]{8}$/;
/** the queue-item scope grammar (fixed point 5) */
const QITEM_RE = /^qitem-\d{14}-[0-9a-f]+$/;

export const validScope = (s: string): boolean =>
  s === "rig" || s === "mission" || QITEM_RE.test(s);

export const validId = (s: string): boolean => ID_RE.test(s);

const sha8 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);

/** A new entry's id: hash of peer, time and text (fixed point 2). */
export const newDecisionId = (peer: string, at: string, fact: string): string =>
  `d-${sha8(JSON.stringify([peer, at, fact]))}`;

/**
 * A pre-ledger plain conclusion's addressable id: hash of its server id.
 * T24: kept ONLY as the benchmark/test helper (scripts/bench.ts seeds its
 * dataset this way); no reader of real data uses it any more.
 */
export const derivedId = (conclusionId: string): string => `d-${sha8(conclusionId)}`;

// The header grammar. Fields after kind+id are optional but canonical in
// order (scope, then supersedes); format() always writes scope, so parse and
// format round-trip what the plugin itself wrote. Anything else stays plain.
const HEADER_RE =
  /^\[(decision|approval|status|retire) (d-[0-9a-f]{8})(?: · scope ([^\s·\]]+))?(?: · supersedes (d-[0-9a-f]{8}))?\][ \t]*([\s\S]*)$/;

/** " <fact>" plus " (reason: <r>)" - the body that follows the header. */
function formatBody(fact: string, reason?: string): string {
  return reason !== undefined && reason !== "" ? `${fact} (reason: ${reason})` : fact;
}

/** "[decision d-… · scope mission[ · supersedes d-…]] <fact>[ (reason: …)]" */
export function formatEntry(e: {
  kind: LedgerKind;
  id: string;
  scope: string;
  supersedes?: string;
  fact: string;
  reason?: string;
}): string {
  return (
    `[${e.kind} ${e.id} · scope ${e.scope}` +
    (e.supersedes !== undefined ? ` · supersedes ${e.supersedes}` : "") +
    `] ${formatBody(e.fact, e.reason)}`
  );
}

/** "[retire d-…] <reason>" */
export const formatRetire = (target: string, reason: string): string =>
  `[retire ${target}] ${reason}`;

/**
 * Parse a conclusion's content. A valid header yields the entry; everything
 * else - no header, a malformed one, unknown kind words, bad ids - is plain
 * (the amendment: old and odd content stays readable, never an error).
 * A trailing " (reason: …)" is read back as the reason; a fact that merely
 * ENDS in that shape round-trips as reason (documented, accepted).
 */
export function parseEntry(content: string): ParsedEntry {
  const m = HEADER_RE.exec(content);
  if (m === null) return { kind: "plain", fact: content };
  const [, kindWord, id, scope, supersedes, rest] = m as unknown as (string | undefined)[];
  const body = rest ?? "";
  if (kindWord === "retire") return { kind: "retire", target: id as string };
  let fact = body;
  let reason: string | undefined;
  const ri = body.lastIndexOf(" (reason: ");
  if (ri >= 0 && body.endsWith(")")) {
    const cand = body.slice(ri + " (reason: ".length, -1);
    if (cand !== "") {
      fact = body.slice(0, ri);
      reason = cand;
    }
  }
  return {
    kind: kindWord as LedgerKind,
    id: id as string,
    scope: scope ?? "mission",
    ...(supersedes !== undefined ? { supersedes } : {}),
    fact,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** `<peer>--<mission>--<n>` mission part; "unknown" for ids we did not mint. */
function missionOf(sessionId: string): string {
  const m = /^(.*)--(.*)--\d+$/.exec(sessionId);
  return m === null ? "unknown" : m[2];
}

/**
 * Conclusions (newest first, as listed) to ledger entries. T24 (Amendment
 * 2): ONLY a valid header makes an entry - a plain conclusion is not a
 * decision and is silently dropped here (it may be recall material, never
 * in-force). The legacy derivedId mapping survives only as a benchmark/test
 * helper (scripts/bench.ts); nothing on real data uses it.
 */
export function toEntries(
  items: { id: string; content: string; session_id?: string; created_at?: string }[],
): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const c of items) {
    const p = parseEntry(c.content);
    const at = typeof c.created_at === "string" ? c.created_at : "";
    const mission = missionOf(typeof c.session_id === "string" ? c.session_id : "");
    if (p.kind === "plain") continue;
    if (p.kind === "retire")
      out.push({ id: c.id, kind: "retire", scope: "mission", mission, fact: "", target: p.target, at });
    else
      out.push({
        id: p.id,
        kind: p.kind,
        scope: p.scope,
        ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
        mission,
        fact: p.fact,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
        at,
      });
  }
  return out;
}

/** (scope, mission) - the key a status entry is replaced within (V3). */
const statusKey = (e: LedgerEntry): string => `${e.scope} ${e.mission}`;

/**
 * V3 (ADR-0019 d3): the newest status per (scope, mission), by `at` among
 * ALL status entries (ties keep the earlier listed entry - the newest-first
 * fetch order). Chosen before explicit ends on purpose: when the winner is
 * retired or superseded, the key simply ends - older history never becomes
 * in force again. Decisions and approvals are never in this map.
 */
function statusWinners(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const win = new Map<string, LedgerEntry>();
  for (const e of entries) {
    if (e.kind !== "status") continue;
    const k = statusKey(e);
    const w = win.get(k);
    if (w === undefined || e.at > w.at) win.set(k, e);
  }
  return win;
}

/**
 * The current ledger: every non-retire entry that is not named by another
 * entry's supersedes or by a retire - directly named is enough, which makes
 * the closure transitive (A→B→C: A and B are both named, only C stands) -
 * and (V3) for status entries only the newest per (scope, mission).
 * Input order (newest first) is preserved.
 */
export function currentLedger(entries: LedgerEntry[]): LedgerEntry[] {
  const replaced = new Set<string>();
  for (const e of entries) {
    if (e.kind === "retire" && e.target !== undefined) replaced.add(e.target);
    if (e.supersedes !== undefined) replaced.add(e.supersedes);
  }
  const winners = statusWinners(entries);
  return entries.filter(
    (e) =>
      e.kind !== "retire" &&
      !replaced.has(e.id) &&
      (e.kind !== "status" || winners.get(statusKey(e))?.id === e.id),
  );
}

/**
 * id -> the (newest) entry that replaced it, for the search marker. Scan a
 * newest-first list and keep the FIRST replacer seen. Entries replaced by a
 * retire say so with the retire's own conclusion id (never a fake d-).
 */
export function supersededMap(entries: LedgerEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (e.kind === "retire" && e.target !== undefined && !out.has(e.target)) out.set(e.target, "retired");
    if (e.supersedes !== undefined && !out.has(e.supersedes)) out.set(e.supersedes, e.id);
  }
  // V3: a status the newer one replaced is history too - the search marker
  // says so. An explicit end seen first still wins (newest-first scan).
  const winners = statusWinners(entries);
  for (const e of entries) {
    if (e.kind !== "status") continue;
    const w = winners.get(statusKey(e));
    if (w !== undefined && w.id !== e.id && !out.has(e.id)) out.set(e.id, w.id);
  }
  return out;
}

/**
 * The in-force view for one mission: current entries scoped rig (every
 * mission sees them) plus entries WRITTEN in this mission - mission- and
 * item-scoped both show in their writing mission (fixed point 5). Newest
 * first, as fetched.
 */
export function inForceFor(entries: LedgerEntry[], mission: string): LedgerEntry[] {
  return currentLedger(entries).filter((e) => e.scope === "rig" || e.mission === mission);
}

/** The body an in-force view shows: the fact, plus its reason if any. */
export const entryBody = (e: LedgerEntry): string => formatBody(e.fact, e.reason);
