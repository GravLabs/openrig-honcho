// The rig_memory MCP server (T8, ADR-0004 tool table + ADR-0005 E10): a
// hand-written stdio JSON-RPC 2.0 server, newline-delimited, no SDK (ADR-0001
// zero dependencies). stdout carries ONLY JSON-RPC frames; every diagnostic
// goes to the log file, never to stdout/stderr. Never crash: a malformed line
// answers -32700 and the loop continues; an unexpected throw inside a handler
// answers -32603; notifications get no reply.
//
// Kill switch or bad config (config: null): the server still speaks the
// protocol but tools/list returns the empty list and tools/call knows no
// tools - "off means off" without killing the calling session (review T1 F2).

import type { Config } from "./env.ts";
import { fetchCurrentItem } from "./daemon.ts";
import type { Conclusion, HonchoClient, SearchMessage } from "./honcho.ts";
import { ageLabel, forScopeLabel, x3 } from "./inject.ts";
import { logEvent } from "./log.ts";
import { missionIdIsSecretShaped, normalizeMission, readRigMission, readSeatState, resolveSession, scopeFor, seatStatePath, setRigMission } from "./missions.ts";
import { redact } from "./redact.ts";
import { fetchLedgerPair, fetchMissionDecisions } from "./reader.ts";
import {
  currentLedger,
  formatEntry,
  formatRetire,
  LEDGER_PEER,
  newDecisionId,
  parseEntry,
  supersededMap,
  toEntries,
  validId,
  validScope,
  type LedgerEntry,
} from "./ledger.ts";
import { collectStatus } from "./status.ts";
import { classTag, trustClass, trustTag, type TrustClass } from "./trust.ts";
import { ensureSession, freeN, recordBody } from "./writer.ts";

export interface McpDeps {
  /** null = disabled by kill switch or bad config: no tools, protocol only. */
  config: Config | null;
  client: HonchoClient | null;
  now?: () => string;
  /** ask() chat timeout; default 90000 (ADR-0004 amendment), env override for tests. */
  askTimeoutMs?: number;
}

const SERVER_INFO = { name: "rig_memory", version: "0.1.0" };

// O1 (ADR-0017 decision 6): the seat's current in-progress item, best
// effort. A 2 s cache so a burst of tool calls is one localhost GET; any
// failure or absent daemon/session config reads as "unknown" (null), which
// simply omits the field. Never blocks a tool call beyond the shared 1 s
// daemon budget, and only on tools/call (protocol frames log nothing).
const CURRENT_ITEM_TTL_MS = 2_000;
let currentItemCache: { at: number; id: string | null } = { at: Number.NEGATIVE_INFINITY, id: null };
export function resetCurrentItemCache(): void {
  currentItemCache = { at: Number.NEGATIVE_INFINITY, id: null };
}
async function currentItemFor(cfg: Config): Promise<string | null> {
  const { sessionName, daemonUrl } = cfg;
  if (sessionName === undefined || daemonUrl === undefined) return null;
  const now = Date.now();
  if (now - currentItemCache.at < CURRENT_ITEM_TTL_MS) return currentItemCache.id;
  const id = await fetchCurrentItem(daemonUrl, sessionName);
  currentItemCache = { at: now, id };
  return id;
}
const DEFAULT_PROTOCOL = "2024-11-05";
const DEFAULT_ASK_TIMEOUT_MS = 90_000;

/** T16d (ADR-0011 decision 5): the search tool - one 3 s wall over all its
 * calls, top_k 5 per conclusions pair at distance 0.45 (the recall
 * constant), 5 messages, first 300 chars of each. */
const SEARCH_WALL_MS = 3_000;
const SEARCH_DISTANCE = 0.45;
const SEARCH_TOP_K = 5;
const SEARCH_MSG_LIMIT = 5;
const SEARCH_MSG_SNIPPET = 300;

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

const errFrame = (id: number | string | null, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

const okFrame = (id: number | string | null, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result });

/** MCP CallToolResult: content parts, plus isError only when true. */
interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const isId = (v: unknown): v is number | string => typeof v === "number" || typeof v === "string";

/**
 * F-T8-2 (architect ruling 2026-10-28 19:12Z): remember is gated on
 * LEADERSHIP (this seat is its own rig's leader peer), not on observeOthers,
 * which is about whose messages get recorded, not who may write decisions.
 */
const isLeaderSeat = (c: Config): boolean => c.leaderPeer !== undefined && c.leaderPeer === c.peer;

/** The tool list for this seat: remember is leader-only (ADR-0004 table). */
function toolList(deps: McpDeps): unknown[] {
  if (deps.config === null) return [];
  const tools: unknown[] = [
    {
      name: "ask",
      description:
        "Slow reasoning over everything the rig remembers (30-50 s, times out at 90 s). Use search first; ask only when a lookup was not enough.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          mission: { type: "string", description: "Restrict to one mission's scope." },
        },
        required: ["question"],
      },
    },
    // T16d (ADR-0011 decision 5): the fast lookup, every seat.
    {
      name: "search",
      description:
        "Fast lookup in the rig's shared memory (about a second): past decisions, work done, and what another seat found. Use it before guessing about past work. ask is slow (30-50 s) and reasons over everything; use ask for questions that need reasoning, not for lookups.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          about: {
            type: "string",
            description:
              "Optional peer id: also search what this seat and the mission scope remember about that peer.",
          },
        },
        required: ["query"],
      },
    },
  ];
  if (isLeaderSeat(deps.config)) {
    // T19a (ADR-0014 d2 + amendment): remember grows the ledger fields; a
    // plain remember {fact} stays valid and is a mission decision.
    tools.push({
      name: "remember",
      description:
        "Record an explicit decision, owner approval or status report (leader only) into shared memory. Optional: reason, scope (rig | mission | a qitem id; default mission), supersedes (an in-force d-id this replaces), kind (decision default | approval | status; the newest status per scope and mission is the one in force). The reply names the new decision id.",
      inputSchema: {
        type: "object",
        properties: {
          fact: { type: "string" },
          reason: { type: "string" },
          scope: { type: "string", description: "rig, mission (default), or a qitem id" },
          supersedes: { type: "string", description: "d-xxxxxxxx of an entry in the current ledger" },
          kind: { type: "string", enum: ["decision", "approval", "status"] },
        },
        required: ["fact"],
      },
    });
    tools.push({
      name: "retire",
      description:
        "Retire a decision, approval or status (leader only): it stays in memory for history but leaves every in-force view.",
      inputSchema: {
        type: "object",
        properties: {
          decision_id: { type: "string", description: "d-xxxxxxxx of an entry in the current ledger" },
          reason: { type: "string" },
        },
        required: ["decision_id", "reason"],
      },
    });
  }
  tools.push(
    {
      name: "mission",
      description: "Set the rig's active mission; returns the normalised id and scope.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "status",
      description: "Is memory working? Config, server, session, spool, last error, queue.",
      inputSchema: { type: "object", properties: {} },
    },
  );
  return tools;
}

async function callAsk(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const config = deps.config;
  const client = deps.client;
  if (config === null || client === null) return textResult("memory unavailable: disabled", true);
  if (typeof args.question !== "string" || args.question.trim() === "") {
    return textResult("usage: ask {question: string, mission?: string}", true);
  }
  const query = redact(args.question).text;
  // scope name via scopeFor (ADR-0002): general stays "general" - that is
  // where the writer puts general sessions; anything else is mission-<id>.
  const missionId =
    typeof args.mission === "string" && args.mission.trim() !== ""
      ? normalizeMission(args.mission)
      : undefined;
  const scope = missionId !== undefined ? scopeFor(missionId) : undefined;
  const r = await client.workspaceChat(
    { query, ...(scope !== undefined ? { scope } : {}), reasoning_level: "low" },
    { timeoutMs: deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS },
  );
  // ADR-0004 amendment: a scoped chat 404s when the mission's scope does not
  // exist yet - that is "nothing recorded", not an outage. Any other failure
  // stays the plain unavailable error.
  let base: string;
  if (r.ok) {
    const answer = r.data.content;
    base = typeof answer === "string" && answer !== "" ? answer : "(no answer)";
  } else if (r.kind === "http" && r.status === 404 && missionId !== undefined) {
    base = `No memory recorded for mission ${missionId} yet.`;
  } else {
    return textResult(`memory unavailable: ${r.kind}`, true);
  }
  // V2 (ADR-0019 d2): the answer is a model product - one label line under
  // it, set by the code path (ask/dialectic), whatever the text says. The
  // 404 "no memory yet" text is the same ask surface: labelled too.
  base = `${base}\n[${trustClass("ask")}]`;
  // Scoped ask also appends the leader's recorded decisions for this mission
  // (the same conclusions query the session-start reader runs for E8): fresh
  // remembers are visible without waiting for the deriver. No leader, no
  // decisions part; a failed or empty fetch appends nothing (never fails ask).
  if (missionId !== undefined && config.leaderPeer !== undefined) {
    try {
      // T24 F3 moved the cap out of fetchMissionDecisions; ask keeps its
      // exact newest-10 view.
      const decisions = (await fetchMissionDecisions(client, config.leaderPeer, missionId)).slice(0, 10);
      if (decisions.length > 0) {
        const now = (deps.now ?? (() => new Date().toISOString()))();
        const lines: string[] = ["Recorded decisions in this mission:"];
        for (const d of decisions) {
          // T20c rule 4: this view has no open-item list, so it LABELS:
          // approvals are marked as approvals and an item-scoped entry names
          // its item (for qitem-...). Entries with no item scope read
          // exactly as before.
          const label = [
            ageLabel(now, d.at) ?? "undated",
            d.kind === "approval" ? "approval" : d.kind === "status" ? "status" : "",
            forScopeLabel(d),
          ]
            .filter((x) => x !== "")
            .join(", ");
          lines.push(
            `- ${label}${d.kind === "approval" ? trustTag("approval") : d.kind === "status" ? trustTag("status") : trustTag("decision")}`,
          );
          lines.push(...x3(d.content).split("\n"));
        }
        base = `${base}\n\n${lines.join("\n")}`;
      }
    } catch {
      // decisions are a bonus section; the chat answer above already stands
    }
  }
  return textResult(base);
}

/** T19a (fixed point 4): the search marker for a superseded or retired
 * ledger entry's content; "" for anything else (plain, retire entries
 * themselves, unknown ids, no ledger knowledge). */
function supersedeMarker(content: string, superseded: Map<string, string> | undefined): string {
  if (superseded === undefined) return "";
  const p = parseEntry(content);
  if (p.kind === "plain" || p.kind === "retire") return "";
  const by = superseded.get(p.id);
  if (by === undefined) return "";
  return by === "retired" ? " (retired)" : ` (superseded by ${by})`;
}

/** True when every job settled within `ms`; jobs swallow their own errors.
 * The timer is cleared on settle so a green call never keeps the event loop
 * alive for the whole wall. */
function settledWithin(jobs: Promise<void>[], ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (all: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(all);
    };
    timer = setTimeout(() => finish(false), ms);
    for (const j of jobs) {
      void j.then(() => {
        done += 1;
        if (done === jobs.length) finish(true);
      });
    }
  });
}

/**
 * T16d (ADR-0011 decision 5): the fast lookup. The conclusions pairs and the
 * one message search run in parallel under ONE 3 s wall, and what rendered
 * is what finished (the recall T16g rule): unfinished or failed calls are
 * only counted and noted, never silently dropping the answers that did come
 * back. Output is plain text, two sections; every content line goes through
 * x3 and every displayed string through redact. Counts (never content)
 * reach the log line via logExtra.
 */

/**
 * O2 (architect ruling 2026-11-10 20:33Z): THE SHARED SEARCH RETRIEVAL.
 * The conclusions pairs + message search + ledger marks that the search
 * tool renders, all inside one wall - extracted verbatim from callSearch
 * so the claim-time pointer runs the SAME retrieval under its own budget:
 * the pointer's count is what the exact search(...) call it shows would
 * return (decision: share the function, do not copy it). A failed job
 * stays an empty slot and is counted unfinished; wallHit says the wall
 * fired. Behaviour is identical to the old inline block - callSearch is
 * now renderer only, and its pins (tests/unit/mcp.test.ts) cover both.
 */
/** V2 (ADR-0019 d2): a search hit with the trust class of the PAIR it came
 * from, attached at snapshot build (the code path), before any flattening. */
export type SearchMemory = Conclusion & { trust: TrustClass };

/** Entries live on the ledger pair: that pair's content grammar is written
 * by this plugin's remember/retire path (ledger.ts), so parseEntry's kind IS
 * the code path - an approval is the owner's (authoritative), everything
 * else on the pair (decision, status, plain, retire) is a seat's write
 * (recorded). */
const ledgerTrust = (content: string): TrustClass => {
  const k = parseEntry(content).kind;
  return k === "approval" ? trustClass("approval") : trustClass(k === "status" ? "status" : "decision");
};

export async function searchSnapshot(
  client: HonchoClient,
  config: Config,
  query: string,
  about: string | undefined,
  wallMs: number,
): Promise<{
  memories: SearchMemory[];
  messages: SearchMessage[];
  superseded: Map<string, string> | undefined;
  total: number;
  unfinished: number;
  wallHit: boolean;
}> {
  const mission = normalizeMission(readRigMission(config.stateDir, config.workspace).mission);
  // the server names scope peers scope.<scope> (missions.scopeFor, same as
  // recall's pairs); the no-about shape is self-about-self plus scope-about-
  // self (brief), the about shape adds scope-about-about and self-about-about
  const scopePeer = `scope.${scopeFor(mission)}`;
  const pairs =
    about === undefined
      ? [
          { observer: config.peer, observed: config.peer },
          { observer: scopePeer, observed: config.peer },
        ]
      : [
          { observer: config.peer, observed: config.peer },
          { observer: scopePeer, observed: about },
          { observer: config.peer, observed: about },
        ];
  // T24 #6 (Amendment 2): entries left the self pair, so search must query
  // the ledger pair too - decisions stay findable, marked below as today.
  if (config.leaderPeer !== undefined)
    pairs.push({ observer: config.leaderPeer, observed: LEDGER_PEER });
  // each job writes its own slot the moment it answers, so the snapshot at
  // the wall IS "what finished" (a late answer still lands, but this frame
  // is already on its way out)
  const mem: (Conclusion[] | undefined)[] = pairs.map(() => undefined);
  let msgs: SearchMessage[] | undefined;
  const jobs: Promise<void>[] = pairs.map(async (p, i) => {
    try {
      const r = await client.queryConclusions({
        query,
        top_k: SEARCH_TOP_K,
        distance: SEARCH_DISTANCE,
        filters: { observer: p.observer, observed: p.observed },
      });
      if (r.ok) mem[i] = r.data;
    } catch {
      // a failed pair stays an empty slot; the note counts it
    }
  });
  jobs.push(
    (async () => {
      try {
        const r = await client.searchMessages({ query, limit: SEARCH_MSG_LIMIT });
        if (r.ok) msgs = r.data;
      } catch {
        // ditto
      }
    })(),
  );
  // T19a (fixed point 4): search still shows superseded entries, MARKED.
  // T24: the map comes from the shared ledger-pair read (Amendment 2 - the
  // entries live there now) inside the same wall; late or failed means
  // simply no marks, never a worse answer.
  let superseded: Map<string, string> | undefined;
  if (config.leaderPeer !== undefined) {
    const leaderPeer = config.leaderPeer;
    jobs.push(
      (async () => {
        try {
          const pair = await fetchLedgerPair(client, leaderPeer);
          superseded = supersededMap(toEntries(pair.items));
        } catch {
          // no marks
        }
      })(),
    );
  }
  const total = jobs.length;
  const wallHit = !(await settledWithin(jobs, wallMs));
  // V2: tag per SLOT while the pair index is still known (finishedMem.flat()
  // would lose it): the ledger pair by entry kind, plain pairs are conclusions.
  let finishedPairs = 0;
  const memories: SearchMemory[] = [];
  mem.forEach((slot, i) => {
    if (slot === undefined) return;
    finishedPairs++;
    const onLedger = pairs[i].observed === LEDGER_PEER;
    for (const c of slot) {
      memories.push({ ...c, trust: onLedger ? ledgerTrust(String(c.content ?? "")) : trustClass("conclusion") });
    }
  });
  const messages = msgs ?? [];
  const unfinished = total - (finishedPairs + (msgs !== undefined ? 1 : 0));
  return { memories, messages, superseded, total, unfinished, wallHit };
}

async function callSearch(deps: McpDeps, args: Record<string, unknown>): Promise<CallOutcome> {
  const config = deps.config;
  const client = deps.client;
  if (config === null || client === null)
    return { res: textResult("memory unavailable: disabled", true), refused: false };
  if (typeof args.query !== "string" || args.query.trim() === "") {
    return { res: textResult("usage: search {query: string, about?: string}", true), refused: false };
  }
  const query = redact(args.query).text;
  const aboutRaw = typeof args.about === "string" ? args.about.trim() : "";
  const about = aboutRaw === "" ? undefined : redact(aboutRaw).text;
  const snap = await searchSnapshot(client, config, query, about, SEARCH_WALL_MS);
  const { memories, messages, superseded, total, unfinished, wallHit } = snap;
  const logExtra = {
    n_items: memories.length,
    n_msgs: messages.length,
    ...(unfinished > 0 ? { partial: unfinished } : {}),
  };
  if (unfinished === total) {
    // nothing at all came back: a clean failure, not an empty success
    return {
      res: textResult(wallHit ? "search timed out: nothing returned" : "search failed: nothing returned", true),
      refused: false,
    };
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const lines: string[] = ["Memories:"];
  if (memories.length === 0) lines.push("(none)");
  for (const m of memories) {
    lines.push(`- ${ageLabel(now, String(m.created_at ?? "")) ?? "undated"}${classTag(m.trust)}`);
    lines.push(...x3(redact(m.content).text + supersedeMarker(m.content, superseded)).split("\n"));
  }
  lines.push("Messages:");
  if (messages.length === 0) lines.push("(none)");
  for (const m of messages) {
    const age = ageLabel(now, String(m.created_at ?? "")) ?? "undated";
    lines.push(`- ${x3(String(m.peer_id))}, ${age}${trustTag("message")}`);
    lines.push(...x3(redact(String(m.content ?? "")).text.slice(0, SEARCH_MSG_SNIPPET)).split("\n"));
  }
  let text = lines.join("\n");
  if (unfinished > 0) text += `\n(search incomplete: ${total - unfinished} of ${total} calls returned)`;
  return { res: textResult(text), refused: false, logExtra };
}

/**
 * The CURRENT session, exactly the writer's lifecycle (free-n when state is
 * missing, then ensure) - the server rejects conclusions for sessions that do
 * not exist (probed 2026-10-28), so ensure must precede create. Shared by
 * remember and retire (T19a); behavior identical to the old inline block.
 */
/**
 * T24 (Amendment 2): ledger entries live on the pair (leader, openrig-ledger)
 * and the server needs the observed peer to EXIST (live probe, T24 row) -
 * get-or-create it before every ledger write. A failure refuses the write:
 * an entry that cannot land on the pair is not in force anywhere, and a
 * half-written ledger is exactly what Amendment 2 removes.
 */
async function ensureLedgerPeer(client: HonchoClient): Promise<{ ok: true } | { ok: false; why: string }> {
  const r = await client.createPeer(LEDGER_PEER);
  return r.ok ? { ok: true } : { ok: false, why: r.kind };
}

async function leaderSession(
  client: HonchoClient,
  config: Config,
  now: string,
): Promise<{ ok: true; session: string } | { ok: false; why: string }> {
  const mission = normalizeMission(readRigMission(config.stateDir, config.workspace).mission);
  const pre = readSeatState(seatStatePath(config.stateDir, config.workspace, config.peer));
  let initialN: number | undefined;
  let nFallback = false;
  if (pre === null) {
    const minted = await freeN(client, config.peer, mission);
    if (minted !== null) {
      initialN = minted;
    } else {
      const sec = Math.floor(Date.parse(now) / 1000);
      initialN = Number.isFinite(sec) && sec >= 1 ? sec : Math.floor(Date.now() / 1000);
      nFallback = true;
    }
  }
  const resolved = await resolveSession(config.stateDir, config.workspace, config.peer, {
    rigMission: mission,
    now,
    ...(initialN !== undefined ? { initialN } : {}),
  });
  const usedFallback = nFallback && initialN !== undefined && resolved.n === initialN;
  const en = await ensureSession(client, config, resolved, pre, config.peer, usedFallback);
  if (en.failed) return { ok: false, why: "could not ensure the session" };
  return { ok: true, session: resolved.session };
}

/**
 * The CURRENT ledger entries (T24, ADR-0014 Amendment 2): the shared paged
 * read of the LEDGER PAIR (observer the leader, observed the reserved ledger
 * peer; fixed point 5 kept - a superseder may live in another mission, so
 * the whole pair is read before anything is filtered). Only valid-header
 * content is an entry; plain conclusions there are ignored. Any failure
 * yields [] (validation treats that as "nothing known", never "current").
 */
async function ledgerFromServer(client: HonchoClient, leaderPeer: string): Promise<LedgerEntry[]> {
  const pair = await fetchLedgerPair(client, leaderPeer);
  return toEntries(pair.items);
}

const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/** remember's optional fields; an invalid one is a usage error before any write. */
function parseLedgerArgs(args: Record<string, unknown>):
  | { ok: true; reason?: string; scope: string; supersedes?: string; kind: "decision" | "approval" | "status" }
  | { ok: false; usage: string } {
  const reason = optStr(args.reason);
  if (args.reason !== undefined && reason === undefined)
    return { ok: false, usage: "remember: reason must be a non-empty string" };
  const scope = optStr(args.scope) ?? "mission";
  if (!validScope(scope))
    return {
      ok: false,
      usage: "remember: scope must be rig, mission, or a queue item id (qitem-<14 digits>-<hex>)",
    };
  const supersedes = optStr(args.supersedes);
  if (args.supersedes !== undefined && (supersedes === undefined || !validId(supersedes)))
    return { ok: false, usage: "remember: supersedes must be a decision id (d- plus 8 hex)" };
  const kindWord = optStr(args.kind);
  if (kindWord !== undefined && kindWord !== "decision" && kindWord !== "approval" && kindWord !== "status")
    return { ok: false, usage: "remember: kind must be decision, approval or status" };
  return {
    ok: true,
    ...(reason !== undefined ? { reason } : {}),
    scope,
    ...(supersedes !== undefined ? { supersedes } : {}),
    kind: kindWord ?? "decision",
  };
}

async function callRemember(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const config = deps.config;
  const client = deps.client;
  if (config === null || client === null) return textResult("memory unavailable: disabled", true);
  if (!isLeaderSeat(config)) return textResult("remember is leader-only", true);
  if (typeof args.fact !== "string" || args.fact.trim() === "") {
    return textResult("usage: remember {fact: string, reason?, scope?, supersedes?, kind?}", true);
  }
  const led = parseLedgerArgs(args);
  if (!led.ok) return textResult(led.usage, true);
  const content0 = redact(args.fact).text;
  const reason = led.reason !== undefined ? redact(led.reason).text : undefined;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  try {
    // supersedes must name an entry IN the current ledger; checked against
    // the server BEFORE anything is written - a bad id writes nothing.
    if (led.supersedes !== undefined) {
      const cur = currentLedger(await ledgerFromServer(client, config.peer));
      if (!cur.some((e) => e.id === led.supersedes))
        return textResult(`remember: supersedes ${led.supersedes} is not in the current ledger`, true);
    }
    const id = newDecisionId(config.peer, now, content0);
    const content = formatEntry({
      kind: led.kind,
      id,
      scope: led.scope,
      ...(led.supersedes !== undefined ? { supersedes: led.supersedes } : {}),
      fact: content0,
      ...(reason !== undefined ? { reason } : {}),
    });
    const sess = await leaderSession(client, config, now);
    if (!sess.ok) return textResult(`memory unavailable: ${sess.why}`, true);
    const lp = await ensureLedgerPeer(client);
    if (!lp.ok) return textResult(`memory unavailable: ${lp.why}`, true);
    // T24 (Amendment 2): the entry lands on the reserved ledger pair - that
    // is what makes it an entry. The decision MESSAGE below is unchanged.
    const c = await client.createConclusion({
      content,
      observer_id: config.peer,
      observed_id: LEDGER_PEER,
      session_id: sess.session,
    });
    if (!c.ok) return textResult(`memory unavailable: ${c.kind}`, true);
    // ADR-0004 amendment: a conclusion created via the API lands only in the
    // (observer, observed) collection - it never reaches a SCOPE, which the
    // deriver feeds from member MESSAGES. So the same redacted fact also goes
    // through the writer's normal path (its own resolve/ensure/send-or-spool)
    // as a "decision" message with reasoning forced on. If the server is
    // down that write spools like any other; the conclusion already succeeded,
    // so the tool still reports success and only notes the spool. T19a: the
    // message carries the ledger fields as metadata too (amendment).
    let note = "";
    try {
      const wr = await recordBody(
        {
          content,
          sender: config.peer,
          kindTag: "decision",
          hookName: "mcp-remember",
          reasoningOverride: true,
          extraMetadata: {
            decision_id: id,
            decision_kind: led.kind,
            decision_scope: led.scope,
            ...(led.supersedes !== undefined ? { decision_supersedes: led.supersedes } : {}),
            ...(reason !== undefined ? { decision_reason: reason } : {}),
          },
        },
        config,
        { client, now: deps.now ?? (() => new Date().toISOString()) },
      );
      if (wr.action === "spooled") note = " (decision message spooled)";
    } catch {
      note = " (decision message not recorded)";
    }
    return textResult(`remembered in ${sess.session} (${id})${note}`);
  } catch {
    return textResult("memory unavailable: unknown", true); // S1: never throw at the wire
  }
}

/**
 * T19a: retire {decision_id, reason} - leader-only, same refusal and logging
 * shape as remember. The target must be in the current ledger; a retired
 * entry stays in memory (history, search) but leaves in-force views. Writes
 * a "[retire d-…]" conclusion plus the decision message.
 */
async function callRetire(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const config = deps.config;
  const client = deps.client;
  if (config === null || client === null) return textResult("memory unavailable: disabled", true);
  if (!isLeaderSeat(config)) return textResult("retire is leader-only", true);
  const target = optStr(args.decision_id);
  const reason = optStr(args.reason);
  if (target === undefined || reason === undefined)
    return textResult("usage: retire {decision_id: d-xxxxxxxx, reason: string}", true);
  if (!validId(target)) return textResult("retire: decision_id must be d- plus 8 hex", true);
  const reasonR = redact(reason).text;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  try {
    const cur = currentLedger(await ledgerFromServer(client, config.peer));
    if (!cur.some((e) => e.id === target))
      return textResult(`retire: ${target} is not in the current ledger`, true);
    const content = formatRetire(target, reasonR);
    const sess = await leaderSession(client, config, now);
    if (!sess.ok) return textResult(`memory unavailable: ${sess.why}`, true);
    const lp = await ensureLedgerPeer(client);
    if (!lp.ok) return textResult(`memory unavailable: ${lp.why}`, true);
    // T24 (Amendment 2): retire entries live on the ledger pair too.
    const c = await client.createConclusion({
      content,
      observer_id: config.peer,
      observed_id: LEDGER_PEER,
      session_id: sess.session,
    });
    if (!c.ok) return textResult(`memory unavailable: ${c.kind}`, true);
    let note = "";
    try {
      const wr = await recordBody(
        {
          content,
          sender: config.peer,
          kindTag: "decision",
          hookName: "mcp-remember",
          reasoningOverride: true,
          extraMetadata: { decision_id: target, decision_op: "retire", decision_reason: reasonR },
        },
        config,
        { client, now: deps.now ?? (() => new Date().toISOString()) },
      );
      if (wr.action === "spooled") note = " (decision message spooled)";
    } catch {
      note = " (decision message not recorded)";
    }
    return textResult(`retired ${target}${note}`);
  } catch {
    return textResult("memory unavailable: unknown", true); // S1: never throw at the wire
  }
}

async function callMission(deps: McpDeps, args: Record<string, unknown>): Promise<CallOutcome> {
  const config = deps.config;
  if (config === null) return { res: textResult("memory unavailable: disabled", true), refused: false };
  if (typeof args.id !== "string" || args.id.trim() === "") {
    return { res: textResult("usage: mission {id: string}", true), refused: false };
  }
  // F-T8-3 (ruling 19:12Z): a secret-shaped id is refused BEFORE anything is
  // stored - normalizeMission would otherwise embed a masked-but-derived
  // fragment of the secret in mission.json forever. T8d-1 item 0: this is a
  // logged refusal (event "refused"), not an ordinary failed call. T16j: the
  // redact-visible test alone misses provider-token shapes under its 40-char
  // threshold (a ghp_-prefixed token), so both this tool and the queue-tag
  // paths share one predicate (missions.ts missionIdIsSecretShaped).
  if (missionIdIsSecretShaped(args.id)) {
    return { res: textResult("mission id looks like a secret; not stored", true), refused: true };
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const r = await setRigMission(config.stateDir, config.workspace, args.id, config.peer, now);
  return { res: textResult(JSON.stringify({ ok: r.ok, mission: r.mission, scope: r.scope })), refused: false };
}

async function callStatus(deps: McpDeps): Promise<ToolResult> {
  const config = deps.config;
  const client = deps.client;
  if (config === null || client === null) return textResult("memory unavailable: disabled", true);
  // O3: the same report the bin prints (src/status.ts). F-T8-4: no raw log
  // lines and no raw error strings anywhere in it.
  // V2 (ADR-0019 d2): one label line above the JSON - status reports OpenRig
  // state (authoritative); the JSON bytes and the bin (collectStatus) unchanged.
  return textResult(`[${trustClass("state")}]\n${JSON.stringify(await collectStatus(config, client), null, 2)}`);
}

interface CallOutcome {
  res: ToolResult;
  /**
   * T8d-1 item 0 (architect ruling 2026-10-28 20:06Z): the two SECURITY
   * refusals - remember from a non-leader, a secret-shaped mission id - are
   * logged as event "refused" + error_class "refused", not as ordinary
   * failed tool calls.
   */
  refused: boolean;
  /**
   * T16d: per-tool count fields merged into the tool:<name> log event
   * (n_items / n_msgs / partial - the fields the whitelist already has).
   */
  logExtra?: { n_items?: number; n_msgs?: number; partial?: number };
}

async function handleCall(deps: McpDeps, params: unknown): Promise<CallOutcome> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== "string") {
    return { res: textResult("usage: tools/call {name, arguments}", true), refused: false };
  }
  const args = (p.arguments ?? {}) as Record<string, unknown>;
  switch (p.name) {
    case "ask":
      return { res: await callAsk(deps, args), refused: false };
    case "search":
      return await callSearch(deps, args);
    case "remember": {
      // kill switch / bad config: "off means off" - the tool simply does not
      // exist (review T1 F2), so the generic refusal stays
      if (deps.config === null) return { res: textResult("unknown tool", true), refused: false };
      // T8-fix-2 F-T8-2: a NON-LEADER calling it by name gets the explicit
      // refusal (isError), not the generic "unknown tool"
      if (!isLeaderSeat(deps.config)) {
        return { res: textResult("remember is leader-only", true), refused: true };
      }
      return { res: await callRemember(deps, args), refused: false };
    }
    case "retire": {
      // same shape as remember: off means off; a non-leader by name gets the
      // explicit security refusal, logged as refused (T8d-1 item 0)
      if (deps.config === null) return { res: textResult("unknown tool", true), refused: false };
      if (!isLeaderSeat(deps.config)) {
        return { res: textResult("retire is leader-only", true), refused: true };
      }
      return { res: await callRetire(deps, args), refused: false };
    }
    case "mission":
      return await callMission(deps, args);
    case "status":
      return { res: await callStatus(deps), refused: false };
    default:
      return { res: textResult("unknown tool", true), refused: false };
  }
}

/**
 * One stdin line -> zero or one stdout frames. Exported for tests; the wire
 * loop (runStdio) is just this plus I/O. Never throws.
 */
export async function handleLine(line: string, deps: McpDeps): Promise<string | null> {
  let msg: RpcMessage;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errFrame(null, -32700, "parse error");
    }
    msg = parsed as RpcMessage;
  } catch {
    return errFrame(null, -32700, "parse error");
  }
  const id = isId(msg.id) ? (msg.id as number | string) : null;
  const isRequest = isId(msg.id);
  try {
    switch (msg.method) {
      case "initialize": {
        // F-T8-1 (ruling 19:12Z): a message without an id is a NOTIFICATION -
        // JSON-RPC receivers answer requests only. An id-less initialize/
        // tools/list/tools/call gets silence, never a result frame.
        if (!isRequest) return null;
        const params = (msg.params ?? {}) as { protocolVersion?: unknown };
        const protocolVersion =
          typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL;
        return okFrame(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      }
      case "ping":
        return isRequest ? okFrame(id, {}) : null;
      case "tools/list":
        return isRequest ? okFrame(id, { tools: toolList(deps) }) : null;
      case "tools/call": {
        if (!isRequest) return null;
        // O1: one structured event per tool call (config null = nothing to log to)
        const p = (msg.params ?? {}) as { name?: unknown };
        const toolName = typeof p.name === "string" ? p.name : "unknown";
        const t0 = Date.now();
        const { res, refused, logExtra } = await handleCall(deps, msg.params);
        if (deps.config !== null) {
          // O1 (ADR-0017 decision 6): MCP lines gain the seat's session name
          // and, when the daemon knows one, its current in-progress qitem -
          // pointers only, one line per run still (O1). The item lookup is
          // cached 2 s and never throws; unknown simply stays absent.
          const currentQitem = await currentItemFor(deps.config);
          logEvent(deps.config, {
            hook: "mcp",
            // T8d-1 item 0: the security refusals log event "refused" with
            // error_class "refused"; ordinary calls keep tool:<name>
            event: refused ? "refused" : `tool:${toolName}`,
            ok: !refused && res.isError !== true,
            ms: Date.now() - t0,
            ...(deps.config.sessionName !== undefined ? { session: deps.config.sessionName } : {}),
            ...(currentQitem !== null ? { qitem: currentQitem } : {}),
            ...(refused ? { error_class: "refused" } : {}),
            ...(logExtra ?? {}), // T16d: tool:search carries ms + result counts only
          });
        }
        return okFrame(id, res);
      }
      default:
        if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
          return null; // notifications/initialized and friends: no reply
        }
        return isRequest ? errFrame(id, -32601, `method not found: ${String(msg.method)}`) : null;
    }
  } catch {
    return isRequest ? errFrame(id, -32603, "internal error") : null;
  }
}

/** The stdio loop: lines in, frames out; exits when stdin closes. */
export async function runStdio(deps: McpDeps): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line !== "") {
        const reply = await handleLine(line, deps);
        if (reply !== null) process.stdout.write(`${reply}\n`);
      }
      nl = buffer.indexOf("\n");
    }
  }
}
