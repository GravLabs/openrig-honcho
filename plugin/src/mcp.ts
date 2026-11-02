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
import type { Conclusion, HonchoClient, SearchMessage } from "./honcho.ts";
import { ageLabel, x3 } from "./inject.ts";
import { logEvent } from "./log.ts";
import { missionIdIsSecretShaped, normalizeMission, readRigMission, readSeatState, resolveSession, scopeFor, seatStatePath, setRigMission } from "./missions.ts";
import { redact } from "./redact.ts";
import { fetchMissionDecisions } from "./reader.ts";
import { collectStatus } from "./status.ts";
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
      description: "Ask the rig's shared memory a question (Honcho workspace chat).",
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
    tools.push({
      name: "remember",
      description: "Record an explicit decision (leader only) into shared memory.",
      inputSchema: {
        type: "object",
        properties: { fact: { type: "string" } },
        required: ["fact"],
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
  // Scoped ask also appends the leader's recorded decisions for this mission
  // (the same conclusions query the session-start reader runs for E8): fresh
  // remembers are visible without waiting for the deriver. No leader, no
  // decisions part; a failed or empty fetch appends nothing (never fails ask).
  if (missionId !== undefined && config.leaderPeer !== undefined) {
    try {
      const decisions = await fetchMissionDecisions(client, config.leaderPeer, missionId);
      if (decisions.length > 0) {
        const now = (deps.now ?? (() => new Date().toISOString()))();
        const lines: string[] = ["Recorded decisions in this mission:"];
        for (const d of decisions) {
          lines.push(`- ${ageLabel(now, d.at) ?? "undated"}`);
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
  const total = jobs.length;
  const wallHit = !(await settledWithin(jobs, SEARCH_WALL_MS));
  const finishedMem = mem.filter((m): m is Conclusion[] => m !== undefined);
  const memories = finishedMem.flat();
  const messages = msgs ?? [];
  const unfinished = total - (finishedMem.length + (msgs !== undefined ? 1 : 0));
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
    lines.push(`- ${ageLabel(now, String(m.created_at ?? "")) ?? "undated"}`);
    lines.push(...x3(redact(m.content).text).split("\n"));
  }
  lines.push("Messages:");
  if (messages.length === 0) lines.push("(none)");
  for (const m of messages) {
    const age = ageLabel(now, String(m.created_at ?? "")) ?? "undated";
    lines.push(`- ${x3(String(m.peer_id))}, ${age}`);
    lines.push(...x3(redact(String(m.content ?? "")).text.slice(0, SEARCH_MSG_SNIPPET)).split("\n"));
  }
  let text = lines.join("\n");
  if (unfinished > 0) text += `\n(search incomplete: ${total - unfinished} of ${total} calls returned)`;
  return { res: textResult(text), refused: false, logExtra };
}

async function callRemember(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const config = deps.config;
  const client = deps.client;
  if (config === null || client === null) return textResult("memory unavailable: disabled", true);
  if (!isLeaderSeat(config)) return textResult("remember is leader-only", true);
  if (typeof args.fact !== "string" || args.fact.trim() === "") {
    return textResult("usage: remember {fact: string}", true);
  }
  const content = redact(args.fact).text;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  try {
    // the CURRENT session, exactly the writer's lifecycle (free-n when state
    // is missing, then ensure) - the server rejects conclusions for sessions
    // that do not exist (probed 2026-10-28), so ensure must precede create
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
    if (en.failed) return textResult("memory unavailable: could not ensure the session", true);
    const c = await client.createConclusion({
      content,
      observer_id: config.peer,
      observed_id: config.peer,
      session_id: resolved.session,
    });
    if (!c.ok) return textResult(`memory unavailable: ${c.kind}`, true);
    // ADR-0004 amendment: a conclusion created via the API lands only in the
    // (observer, observed) collection - it never reaches a SCOPE, which the
    // deriver feeds from member MESSAGES. So the same redacted fact also goes
    // through the writer's normal path (its own resolve/ensure/send-or-spool)
    // as a "decision" message with reasoning forced on. If the server is
    // down that write spools like any other; the conclusion already succeeded,
    // so the tool still reports success and only notes the spool.
    let note = "";
    try {
      const wr = await recordBody(
        {
          content,
          sender: config.peer,
          kindTag: "decision",
          hookName: "mcp-remember",
          reasoningOverride: true,
        },
        config,
        { client, now: deps.now ?? (() => new Date().toISOString()) },
      );
      if (wr.action === "spooled") note = " (decision message spooled)";
    } catch {
      note = " (decision message not recorded)";
    }
    return textResult(`remembered in ${resolved.session}${note}`);
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
  return textResult(JSON.stringify(await collectStatus(config, client), null, 2));
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
          logEvent(deps.config, {
            hook: "mcp",
            // T8d-1 item 0: the security refusals log event "refused" with
            // error_class "refused"; ordinary calls keep tool:<name>
            event: refused ? "refused" : `tool:${toolName}`,
            ok: !refused && res.isError !== true,
            ms: Date.now() - t0,
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
