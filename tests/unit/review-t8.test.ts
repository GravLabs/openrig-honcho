// T8 + T8-fix review (review seat, pin 7020d3c): the rig_memory MCP server
// (plugin/src/mcp.ts handleLine + plugin/bin/mcp.ts as a child process) and
// the remember/ask amendment (ADR-0004 "Amendment").
//
// The architect's own checks (stdio session happy path, leader vs non-leader
// tools/list, -32700/-32601, status sections, live probe) are already covered
// by build's tests/unit/mcp.test.ts. This file attacks the qitem list from the
// review seat: JSON-RPC robustness (huge lines, partial lines across chunks,
// pipelined requests, ids of every JSON type, notifications that expect no
// reply, stdin closing mid-request), remember only for the LEADER, redaction
// of question/fact/mission id, status leaking nothing secret, the timeout
// path, decision attribution, and "nothing ever reaches the profile
// workspace".
//
// DESIGNED REDS (my findings; architect rulings 2026-10-28 19:12Z):
//   F-T8-1  no-id request-shaped lines must get no reply. FIXED in T8-fix-2
//           (every method silent when id-less) - this file now pins the fix.
//   F-T8-2  remember was gated on observeOthers, not leader-ness. FIXED:
//           isLeaderSeat = leaderPeer === peer (mcp.ts); a non-leader by name
//           gets isError "remember is leader-only" (kill switch keeps
//           "unknown tool"). Retargeted at pin 9d055f9 per the ruling.
//   F-T8-3  mission tool did not redact. FIXED: a secret-shaped id is refused
//           BEFORE anything is stored (mcp.ts callMission). Retargeted to the
//           refuse contract at 9d055f9.
//   F-T8-4  status re-served the raw log line. FIXED by T8c: status is
//           collectStatus (src/status.ts) - projections only, failures leave
//           as error_class, never raw lines or strings (O3). Retargeted to
//           pin the projection contract at 9d055f9.
// The leader-case configs in this file now carry leaderPeer the way
// loadConfig normalises them (env.ts:162: observeOthers without
// HONCHO_LEADER_PEER means leaderPeer = peer) - the F-T8-2 gate made the
// unset-on-purpose shape a non-leader, so mk() applies the same normalisation
// the real loader does.
//
// Green tests pin the contract so a fix cannot regress the working parts.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, mkdirSync, readFileSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { handleLine, type McpDeps } from "../../plugin/src/mcp.ts";
import { readRigMission, readSeatState, seatStatePath } from "../../plugin/src/missions.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { LEDGER_PEER } from "../../plugin/src/ledger.ts";

const WS = "ws";
const SELF = "build";
const LEADER = "lead";
// fake values only, secret-SHAPED, never real (never print or commit a real one)
const APIKEY = "sk-ant-RevT8Fake0123456789abcdefGHIJKL"; // fake-secret
const NOW = "2026-10-28T12:00:00.000Z";
const REPO = join(import.meta.dir, "..", "..");
const BIN = join(REPO, "plugin/bin/mcp.ts");
// the fake records paths WITH the /v3 base prefix
const P = (p: string) => `/v3${p}`;

type Frame = Record<string, unknown>;

const frame = (id: unknown, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
const notif = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
const callLine = (id: unknown, name: string, args?: Record<string, unknown>): string =>
  frame(id, "tools/call", { name, arguments: args ?? {} });

interface H {
  fake: FakeHoncho;
  dir: string;
  deps: McpDeps;
  stop(): Promise<void>;
}

async function mk(cfgOver: Partial<Config> = {}, depsOver: { askTimeoutMs?: number } = {}, fakeOpts: { version?: string } = {}): Promise<H> {
  const fake = await startFakeHoncho(fakeOpts); // O9: optional answered version
  const dir = makeTempDir("rev-t8-");
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: false,
    apiKey: APIKEY,
    stateDir: dir,
    timeoutMs: 2000,
    ...cfgOver };
  // env.ts:162 - the real loader normalises an unset HONCHO_LEADER_PEER for a
  // seat that observes others to leaderPeer = peer. The T8-fix-2 leader gate
  // reads leaderPeer, so the harness must build the SAME shape loadConfig
  // produces, or every leader case is silently a non-leader.
  if (config.leaderPeer === undefined && config.observeOthers === true) {
    config.leaderPeer = config.peer;
  }
  const client = createClient({ url: fake.url, workspace: WS, apiKey: APIKEY, timeoutMs: 2000 });
  const deps: McpDeps = { config, client, now: () => NOW, ...depsOver };
  return {
    fake,
    dir,
    deps,
    // release any hang so stop() can close the server (T7 lesson)
    stop: async () => {
      fake.mode("ok");
      await fake.stop();
    } };
}

const parse = async (line: string, deps: McpDeps): Promise<Record<string, any> | null> => {
  const raw = await handleLine(line, deps);
  return raw === null ? null : (JSON.parse(raw) as Record<string, any>);
};
const textOf = (r: Record<string, any>): string => (r.result.content as { text: string }[])[0].text;
const toolNames = (r: Record<string, any>): string[] =>
  (r.result.tools as { name: string }[]).map((t) => t.name);

describe("T8 review: JSON-RPC wire (handleLine)", () => {
  test("ids of every legal JSON type round-trip exactly", async () => {
    const h = await mk();
    try {
      for (const id of [7, 0, -3, 1.5, "abc", "0", ""]) {
        const r = await parse(frame(id, "initialize", { protocolVersion: "2025-06-18" }), h.deps);
        expect(r).not.toBeNull();
        expect(r.id).toBe(id);
        expect(r.result.protocolVersion).toBe("2025-06-18");
        expect(r.result.serverInfo).toEqual({ name: "rig_memory", version: "0.1.0" });
      }
      // large integer: exact in the raw frame text (no float mangling)
      const raw = await handleLine('{"jsonrpc":"2.0","id":9007199254740991,"method":"ping"}', h.deps);
      expect(raw).toContain('"id":9007199254740991');
    } finally {
      await h.stop();
    }
  });

  test("ids that are NOT number|string are never requests (no reply to unknown methods)", async () => {
    const h = await mk();
    try {
      for (const id of [true, false, { a: 1 }, [], null]) {
        const r = await parse(JSON.stringify({ jsonrpc: "2.0", id, method: "bogus/method" }), h.deps);
        expect(r, `id ${JSON.stringify(id)} must not be answered`).toBeNull();
      }
    } finally {
      await h.stop();
    }
  });

  test("malformed lines get -32700 and the loop continues", async () => {
    const h = await mk();
    try {
      for (const line of ["{oops", "[1,2]", "42", '"str"', "null", "[] ", "}"]) {
        const r = await parse(line, h.deps);
        expect(r, line).not.toBeNull();
        expect(r.error.code, line).toBe(-32700);
        expect(r.id).toBeNull();
      }
      const after = await parse(frame(9, "tools/list"), h.deps);
      expect(after.id).toBe(9);
      // T16d (brief: the tool table gains the search tool for every seat)
      // moves this expectation; flagged to the architect in the T16d report
      expect(toolNames(after)).toEqual(["ask", "search", "mission", "status"]);
    } finally {
      await h.stop();
    }
  });

  test("notifications expect no reply", async () => {
    const h = await mk();
    try {
      expect(await parse(notif("notifications/initialized"), h.deps)).toBeNull();
      expect(await parse(notif("notifications/cancelled", { requestId: 1 }), h.deps)).toBeNull();
      expect(await parse(notif("ping"), h.deps)).toBeNull();
      expect(await parse(notif("bogus/method"), h.deps)).toBeNull();
    } finally {
      await h.stop();
    }
  });

  // F-T8-1 designed red. Current behaviour: tools/list and tools/call WITHOUT
  // an id answer okFrame(null) (mcp.ts:378/:380 reply unconditionally). JSON-RPC
  // 2.0 §4.1: a request lacking id is a notification and the server MUST NOT
  // reply; the emitted frame carries id null and desyncs a client that counts
  // replies. Low severity (MCP clients always send ids) - pinned so the
  // protocol rule is honoured; architect to rate.
  test("F-T8-1 request-shaped lines without id are notifications: no reply", async () => {
    const h = await mk();
    try {
      expect(await parse(notif("tools/list"), h.deps)).toBeNull();
      expect(await parse(notif("tools/call", { name: "status" }), h.deps)).toBeNull();
      // the fix is broader than the original red (build, 19:16Z): EVERY
      // method is silent without an id, initialize included
      expect(await parse(notif("initialize", { protocolVersion: "2025-06-18" }), h.deps)).toBeNull();
    } finally {
      await h.stop();
    }
  });

  test("unknown methods get -32601 when they are requests; junk params never crash", async () => {
    const h = await mk();
    try {
      const r = await parse(frame(3, "tools/shuffle"), h.deps);
      expect(r.error.code).toBe(-32601);
      expect(r.error.message).toContain("tools/shuffle");
      for (const params of ["a string", 42, null, [], { name: 7 }, {}]) {
        const c = await parse(frame(4, "tools/call", params), h.deps);
        expect(c.result.isError, JSON.stringify(params)).toBe(true);
        expect(textOf(c)).toContain("usage");
      }
    } finally {
      await h.stop();
    }
  });

  test("a huge single-line request parses and answers", async () => {
    const h = await mk();
    try {
      const big = frame(8, "tools/list", { blob: "x".repeat(200_000) });
      const r = await parse(big, h.deps);
      expect(r.id).toBe(8);
      // T16d adds the search tool (same expectation move as above)
      expect(toolNames(r)).toEqual(["ask", "search", "mission", "status"]);
    } finally {
      await h.stop();
    }
  });

  test("initialize: string protocolVersion echoed, non-string falls back to the default", async () => {
    const h = await mk();
    try {
      const d1 = await parse(frame(1, "initialize"), h.deps);
      expect(d1.result.protocolVersion).toBe("2024-11-05");
      const d2 = await parse(frame(2, "initialize", { protocolVersion: 123 }), h.deps);
      expect(d2.result.protocolVersion).toBe("2024-11-05");
    } finally {
      await h.stop();
    }
  });

  test("kill switch: protocol lives, tools vanish", async () => {
    const deps: McpDeps = { config: null, client: null };
    const init = await parse(frame(1, "initialize"), deps);
    expect(init.result.serverInfo).toBeDefined();
    const list = await parse(frame(2, "tools/list"), deps);
    expect(list.result.tools).toEqual([]);
    for (const name of ["ask", "mission", "status"]) {
      const r = await parse(callLine(3, name, { question: "q", id: "m", fact: "f" }), deps);
      expect(r.result.isError, name).toBe(true);
      expect(textOf(r), name).toBe("memory unavailable: disabled");
    }
    const rem = await parse(callLine(4, "remember", { fact: "f" }), deps);
    expect(rem.result.isError).toBe(true);
    expect(textOf(rem)).toBe("unknown tool");
  });
});

describe("T8 review: remember is leader-only", () => {
  test("tools/list: non-leader has no remember; the env-normalised leader has it", async () => {
    const h = await mk();
    try {
      // T16d adds the search tool (every seat), right after ask
      expect(toolNames(await parse(frame(1, "tools/list"), h.deps))).toEqual([
        "ask",
        "search",
        "mission",
        "status",
      ]);
    } finally {
      await h.stop();
    }
    // env.ts:162 normalises observeOthers=true without HONCHO_LEADER_PEER to
    // leaderPeer=peer - this is what a leader's real config looks like.
    const l = await mk({ peer: LEADER, observeOthers: true });
    try {
      // T16d adds the search tool (every seat), right after ask;
      // T19a adds retire (leader-only), right after remember.
      expect(toolNames(await parse(frame(1, "tools/list"), l.deps))).toEqual([
        "ask",
        "search",
        "remember",
        "retire",
        "mission",
        "status",
      ]);
    } finally {
      await l.stop();
    }
  });

  // F-T8-2 (ruling 19:12Z, fixed in T8-fix-2): the gate is LEADER-NESS
  // (isLeaderSeat: leaderPeer === peer), not observeOthers. This config -
  // a non-leader with observeOthers true, deployable per E8 - must get no
  // remember in tools/list and the explicit refusal by name. The kill switch
  // keeps the generic "unknown tool" (tool does not exist at all when off).
  test("F-T8-2 non-leader with observeOthers true must not list or run remember", async () => {
    const h = await mk({ peer: SELF, leaderPeer: LEADER, observeOthers: true });
    try {
      const names = toolNames(await parse(frame(1, "tools/list"), h.deps));
      expect(names).not.toContain("remember");
      const c = await parse(callLine(2, "remember", { fact: "we choose sqlite" }), h.deps);
      expect(c.result.isError).toBe(true);
      expect(textOf(c)).toBe("remember is leader-only");
      // the ruling's other side: leadership alone (observeOthers false) is
      // enough for remember - one signal, no conflation left either way
      const l = await mk({ peer: LEADER, leaderPeer: LEADER, observeOthers: false });
      try {
        expect(toolNames(await parse(frame(3, "tools/list"), l.deps))).toContain("remember");
      } finally {
        await l.stop();
      }
    } finally {
      await h.stop();
    }
  });

  test("usage errors: missing/blank fact and question answer usage, isError, never a wire call", async () => {
    const h = await mk({ peer: LEADER, observeOthers: true });
    try {
      for (const args of [{}, { fact: "   " }, { fact: 5 }]) {
        const r = await parse(callLine(1, "remember", args), h.deps);
        expect(r.result.isError, JSON.stringify(args)).toBe(true);
        expect(textOf(r)).toContain("usage: remember");
      }
      for (const args of [{}, { question: "" }]) {
        const r = await parse(callLine(2, "ask", args), h.deps);
        expect(r.result.isError, JSON.stringify(args)).toBe(true);
        expect(textOf(r)).toContain("usage: ask");
      }
      expect(h.fake.requests.filter((r) => r.path.includes("/conclusions")).length).toBe(0);
    } finally {
      await h.stop();
    }
  });
});

describe("T8 review: ask", () => {
  test("the question is redacted BEFORE it goes on the wire", async () => {
    const h = await mk();
    try {
      const r = await parse(
        callLine(1, "ask", { question: "rotate creds: API_KEY=sk-ant-AskFake0123456789abcdefGHIJK then deploy" }), // fake-secret
        h.deps,
      );
      expect(r.result.isError).toBeUndefined();
      expect(textOf(r)).toBe("fake-honcho fixed answer");
      const chat = h.fake.requests.find((rq) => rq.path.startsWith(P("/workspaces/ws/chat")));
      expect(chat).toBeDefined();
      const body = chat.body as Record<string, unknown>;
      expect(String(body.query)).toContain("[REDACTED");
      expect(String(body.query)).not.toContain("AskFake0123456789");
      expect(body.reasoning_level).toBe("low");
      expect(body.stream).toBe(false);
      expect(body.scope).toBeUndefined();
    } finally {
      await h.stop();
    }
  });

  test("scoped 404 is 'nothing recorded', not an outage, with the normalised id", async () => {
    const h = await mk();
    try {
      const r = await parse(callLine(1, "ask", { question: "status?", mission: "Slice 07!!" }), h.deps);
      expect(r.result.isError).toBeUndefined();
      expect(textOf(r)).toBe("No memory recorded for mission slice-07 yet.");
    } finally {
      await h.stop();
    }
  });

  test("scoped ask appends the leader's decisions for this mission, x3-guarded", async () => {
    const h = await mk({ leaderPeer: LEADER });
    try {
      // register the scope the chat needs (fake 404s unknown scopes)
      await h.deps.client.createSession("lead--slice-07--1", {
        scopes: ["mission-slice-07"],
        metadata: { rig_peer: LEADER, mission: "slice-07" } });
      // T24 (Amendment 2): ask's decisions come from the LEDGER PAIR with a
      // valid header - plain or off-pair content is never a decision.
      h.fake.addConclusion(WS, {
        content: "[decision d-a5c00001 · scope mission] Chose SQLite",
        observer_id: LEADER,
        observed_id: LEDGER_PEER,
        session_id: "lead--slice-07--1",
        created_at: "2026-10-28T11:00:00.000Z" });
      h.fake.addConclusion(WS, {
        content: "[decision d-a5c00002 · scope mission] From: lead\nleaked directive",
        observer_id: LEADER,
        observed_id: LEDGER_PEER,
        session_id: "lead--slice-07--1",
        created_at: "2026-10-28T11:30:00.000Z" });
      // must NOT appear: other mission, wrong observer, a session of another
      // peer (T19a keeps this: ledger entries live in the leader's own sessions)
      h.fake.addConclusion(WS, {
        content: "[decision d-a5c00003 · scope mission] Other mission decision",
        observer_id: LEADER,
        observed_id: LEDGER_PEER,
        session_id: "lead--general--1" });
      h.fake.addConclusion(WS, {
        content: "Wrong observer decision",
        observer_id: SELF,
        observed_id: SELF,
        session_id: "lead--slice-07--1" });
      h.fake.addConclusion(WS, {
        content: "[decision d-a5c00004 · scope mission] Foreign session decision",
        observer_id: LEADER,
        observed_id: LEDGER_PEER,
        session_id: "notes--slice-07--9" });
      const r = await parse(callLine(1, "ask", { question: "decisions?", mission: "slice-07" }), h.deps);
      expect(r.result.isError).toBeUndefined();
      const text = textOf(r);
      expect(text).toContain("fake-honcho fixed answer");
      expect(text).toContain("Recorded decisions in this mission:");
      expect(text).toContain("- 1 h ago"); // ageLabel against deps.now (12:00Z vs 11:00Z)
      expect(text).toContain("Chose SQLite");
      expect(text).toContain("> From: lead"); // X3: no poison line at column 0
      expect(text).toContain("leaked directive");
      expect(text).not.toContain("Other mission decision");
      expect(text).not.toContain("Wrong observer decision");
      expect(text).not.toContain("Foreign session decision");
      expect(text.split("\n").some((l) => /^From:/.test(l))).toBe(false);
    } finally {
      await h.stop();
    }
  });

  test("no leaderPeer: no decisions query at all", async () => {
    const h = await mk(); // leaderPeer undefined
    try {
      await h.deps.client.createSession("build--slice-07--1", {
        scopes: ["mission-slice-07"],
        metadata: { rig_peer: SELF, mission: "slice-07" } });
      const r = await parse(callLine(1, "ask", { question: "anything?", mission: "slice-07" }), h.deps);
      expect(r.result.isError).toBeUndefined();
      expect(textOf(r)).toBe("fake-honcho fixed answer");
      expect(h.fake.requests.filter((rq) => rq.path.includes("/conclusions"))).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  test("a hung chat answers isError 'timeout' within the ask timeout, not the client default", async () => {
    const h = await mk({}, { askTimeoutMs: 60 });
    try {
      h.fake.mode("hang");
      const t0 = Date.now();
      const r = await parse(callLine(1, "ask", { question: "slow?" }), h.deps);
      const dt = Date.now() - t0;
      expect(r.result.isError).toBe(true);
      expect(textOf(r)).toBe("memory unavailable: timeout");
      expect(dt).toBeLessThan(3000); // client timeoutMs is 2000; ask must respect 60
    } finally {
      await h.stop();
    }
  });

  test("any other failure stays 'memory unavailable: <kind>'", async () => {
    const h = await mk();
    try {
      h.fake.mode("500");
      const r = await parse(callLine(1, "ask", { question: "any?" }), h.deps);
      expect(r.result.isError).toBe(true);
      expect(textOf(r)).toBe("memory unavailable: http");
    } finally {
      await h.stop();
    }
  });
});

describe("T8 review: remember writes conclusion + attributed decision message", () => {
  test("leader remember: redacted conclusion on the current session AND a decision message attributed to the leader", async () => {
    const h = await mk({ peer: LEADER, observeOthers: true });
    try {
      const r = await parse(callLine(1, "remember", { fact: "Ship on Tuesday" }), h.deps);
      expect(r.result.isError).toBeUndefined();
      // T19a fixed point 6: the reply names the new ledger id
      const reply1 = textOf(r);
      expect(reply1).toMatch(/^remembered in lead--general--1 \(d-[0-9a-f]{8}\)$/);
      const id1 = /\((d-[0-9a-f]{8})\)/.exec(reply1)![1];

      const concl = h.fake.state.conclusions.get(WS) as Record<string, unknown>[];
      expect(concl.length).toBe(1);
      // T19a fixed point 1: the plain fact, led by its ledger header
      expect(concl[0].content).toBe(`[decision ${id1} · scope mission] Ship on Tuesday`);
      expect(concl[0].observer_id).toBe(LEADER);
      expect(concl[0].observed_id).toBe(LEDGER_PEER); // T24: entries ride the reserved pair
      expect(concl[0].session_id).toBe("lead--general--1");

      const msgs = h.fake.state.messages.get("ws/lead--general--1") as Record<string, any>[];
      expect(msgs.length).toBe(1);
      expect(msgs[0].peer_id).toBe(LEADER); // attributed to the leader, the writing seat
      expect(msgs[0].metadata.kind).toBe("decision");
      expect(msgs[0].metadata.mission).toBe("general");
      // T8d-3 retarget: reasoning-true (the remember override) OMITS the
      // configuration; only enabled:false suppression is ever sent.
      expect(msgs[0].configuration).toBeUndefined(); // reasoningOverride

      const session = h.fake.state.sessions.get("ws/lead--general--1") as Record<string, any>;
      expect(session.metadata.rig_peer).toBe(LEADER);
      expect(session.metadata.mission).toBe("general");

      const seat = readSeatState(seatStatePath(h.dir, WS, LEADER));
      expect(seat?.session).toBe("lead--general--1");

      // the fact is redacted on the way in, like the question
      const r2 = await parse(
        callLine(2, "remember", { fact: "rotate: API_KEY=sk-ant-RemFake0123456789abcdefGHIJK" }), // fake-secret
        h.deps,
      );
      expect(textOf(r2)).toMatch(/^remembered in lead--general--1 \(d-[0-9a-f]{8}\)$/);
      const concl2 = h.fake.state.conclusions.get(WS) as Record<string, unknown>[];
      expect(concl2.length).toBe(2);
      expect(String(concl2[1].content)).toContain("[REDACTED");
      expect(String(concl2[1].content)).not.toContain("RemFake0123456789");
    } finally {
      await h.stop();
    }
  });

  test("messages failing spools like any other write; remember still reports success", async () => {
    const h = await mk({ peer: LEADER, observeOthers: true });
    try {
      h.fake.failPattern("/messages", { status: 500 });
      const r = await parse(callLine(1, "remember", { fact: "Decision under outage" }), h.deps);
      expect(r.result.isError).toBeUndefined();
      expect(textOf(r)).toMatch(
        /^remembered in lead--general--1 \(d-[0-9a-f]{8}\) \(decision message spooled\)$/,
      );
      const concl = h.fake.state.conclusions.get(WS) as unknown[];
      expect(concl.length).toBe(1);
      expect(existsSync(join(h.dir, WS, "spool", "lead.jsonl"))).toBe(true);
    } finally {
      await h.stop();
    }
  });
});

describe("T8 review: mission", () => {
  test("normalises the id and answers ok with the scope", async () => {
    const h = await mk();
    try {
      const r = await parse(callLine(1, "mission", { id: "Slice 07!" }), h.deps);
      expect(r.result.isError).toBeUndefined();
      expect(JSON.parse(textOf(r))).toEqual({ ok: true, mission: "slice-07", scope: "mission-slice-07" });
      expect(readRigMission(h.dir, WS).mission).toBe("slice-07");
    } finally {
      await h.stop();
    }
  });

  // F-T8-3 (ruling 19:12Z, fixed in T8-fix-2): a secret-shaped mission id is
  // REFUSED before anything is stored - no echo, no mission.json, isError.
  // The fix uses redact(id) !== id as the detector, so every redaction kind
  // refuses, not just sk-ant shapes; review-t8c probes the other kinds.
  test("F-T8-3 a secret-shaped mission id is refused and nothing is stored", async () => {
    const h = await mk();
    try {
      const r = await parse(callLine(1, "mission", { id: "sk-ant-RevFake0123456789abcdefGHIJKL" }), h.deps); // fake-secret
      expect(r.result.isError).toBe(true);
      const text = textOf(r);
      expect(text).toBe("mission id looks like a secret; not stored");
      expect(text.toLowerCase()).not.toContain("revfake0123456789");
      expect(existsSync(join(h.dir, WS, "mission.json"))).toBe(false);
      // the refusal is not sticky: a clean id right after still works
      const ok = await parse(callLine(2, "mission", { id: "Slice 07" }), h.deps);
      expect(ok.result.isError).toBeUndefined();
      expect(JSON.parse(textOf(ok)).mission).toBe("slice-07");
    } finally {
      await h.stop();
    }
  });
});

describe("T8 review: status", () => {
  // O3 (T8c): the report is collectStatus (src/status.ts) - projections
  // only. Retargeted from the pre-T8c six-section shape at pin 9d055f9.
  test("O3 report: exact sections, zeros, healthy; never the API key", async () => {
    const h = await mk();
    try {
      h.fake.state.queue.set(WS, {
        total_work_units: 7,
        completed_work_units: 3,
        in_progress_work_units: 1,
        pending_work_units: 3 });
      const r = await parse(callLine(1, "status"), h.deps);
      expect(r.result.isError).toBeUndefined();
      const text = textOf(r);
      const out = JSON.parse(text);
      // O3 item 4: the report grew `outcomes` (collector state) - strict
      // list retargeted, same discipline as the T8c-fix note below.
      expect(Object.keys(out)).toEqual([
        "config", "server", "session", "counters", "spool",
        "last_error_at", "last_error_class", "queue", "outcomes", "log_tail", "problems", "healthy",
      ]);
      expect(out.config).toEqual({
        host: new URL(h.fake.url).host,
        workspace: WS,
        peer: SELF,
        leader: null,
        profile_workspace: null });
      // fake-3.5.0 ends on the tested line 3.5.x -> the version check passes (O9 wording)
      expect(out.server).toEqual({ reachable: true, version: "fake-3.5.0" });
      expect(out.session).toEqual({ mission: "general", session: null });
      // T8c-fix: SeatStats grew `sanitized` - strict toEqual, retargeted at
      // 95b1adb per qitem -20261028215021 (not loosened).
      expect(out.counters).toEqual({
        written: 0, failed: 0, spooled: 0, replayed: 0, dropped: 0, dead: 0, sanitized: 0, redactions: {} });
      expect(out.spool).toEqual({
        live: { bytes: 0, lines: 0 },
        replay: { bytes: 0, lines: 0 },
        dead: { bytes: 0, lines: 0 } });
      expect(out.last_error_at).toBeNull();
      expect(out.last_error_class).toBeNull();
      expect(out.queue.total_work_units).toBe(7);
      expect(out.outcomes).toEqual({ last_run_at: null, records: 0 }); // never run here
      expect(out.log_tail).toEqual([]);
      expect(out.problems).toEqual([]);
      expect(out.healthy).toBe(true);
      // E10: the key value is never reported, and the section never names the field
      expect(text).not.toContain(APIKEY);
      expect(text).not.toContain("apiKey");
    } finally {
      await h.stop();
    }
  });

  // O9: the 3.6.x line beside the O3 3.5.0 pin - same harness, version answer widened.
  test("O3 status: a 3.6.1 server is healthy and reported verbatim", async () => {
    const h = await mk({}, {}, { version: "fake-3.6.1" });
    try {
      const r = await parse(callLine(1, "status"), h.deps);
      expect(r.result.isError).toBeUndefined();
      const out = JSON.parse(textOf(r));
      expect(out.server).toEqual({ reachable: true, version: "fake-3.6.1" });
      expect(out.problems).toEqual([]);
      expect(out.healthy).toBe(true);
    } finally {
      await h.stop();
    }
  });

  test("O3 projections: stats drive last_error_*, log_tail projects allowed fields only", async () => {
    const h = await mk();
    try {
      // a seat state with stats (readSeatState needs mission/n/counters)
      mkdirSync(join(h.dir, WS, "seats"), { recursive: true });
      writeFileSync(
        join(h.dir, WS, "seats", `${SELF}.json`),
        JSON.stringify({
          mission: "general",
          n: 1,
          counters: {},
          session: "build--general--1",
          stats: {
            written: 3, failed: 1, spooled: 0, replayed: 0, dropped: 0, dead: 0,
            redactions: { key: 2 },
            last_error_at: "2026-10-28T11:00:00.000Z",
            last_error_class: "http_500" } }),
      );
      mkdirSync(join(h.dir, "log"), { recursive: true });
      const logLine = (o: Record<string, unknown>) => JSON.stringify(o);
      writeFileSync(
        join(h.dir, "log", `${WS}.log`),
        [
          "2026-10-28T12:00:00.000Z [stop] LEGACY free-text line, RevLogFake0123456789abcdef shaped like a secret",
          logLine({ ts: "2026-10-28T12:01:00.000Z", hook: "mcp", event: "tool:ask", ok: true, ms: 5, peer: SELF }),
          logLine({
            ts: "2026-10-28T12:02:00.000Z", hook: "stop", event: "spooled", ok: false, ms: 9,
            session: "RevLogFake0123456789abcdef-off-field", error_class: "http_500" }),
        ].join("\n") + "\n",
      );
      const text = textOf(await parse(callLine(1, "status"), h.deps));
      const out = JSON.parse(text);
      expect(out.session.session).toBe("build--general--1");
      expect(out.counters.written).toBe(3);
      expect(out.counters.redactions).toEqual({ key: 2 });
      expect(out.last_error_at).toBe("2026-10-28T11:00:00.000Z"); // from STATS, not the log
      expect(out.last_error_class).toBe("http_500");
      expect(out.log_tail.length).toBe(2); // the legacy line is skipped, never echoed
      for (const l of out.log_tail) {
        expect(Object.keys(l).sort()).toEqual(
          l.error_class !== undefined
            ? ["error_class", "event", "hook", "ok", "ts"]
            : ["event", "hook", "ok", "ts"],
        );
      }
      // nothing beyond the allowed fields leaves the log file - the secret in
      // a legacy line AND in an off-whitelist field of a JSON line both stay put
      expect(text).not.toContain("RevLogFake0123456789abcdef");
      expect(text).not.toContain("LEGACY");
      // (ms/peer absence in log_tail is pinned by the key-set check above;
      // config.peer legitimately carries "peer")
    } finally {
      await h.stop();
    }
  });

  // F-T8-4 (ruling 19:12Z, fixed by T8c): raw log lines and raw error strings
  // are never re-served. Retargeted to the projection contract: spool FILES
  // are reported as sizes only - their content can never ride into status.
  test("F-T8-4 spool content and off-field log values never ride into status", async () => {
    const h = await mk();
    try {
      mkdirSync(join(h.dir, WS, "spool"), { recursive: true });
      writeFileSync(
        join(h.dir, WS, "spool", `${SELF}.jsonl`),
        JSON.stringify({ session: "build--general--1", messages: [{ peer_id: SELF, content: "canary SpoolCanaryFake0123456789abcdef body" }] }) + "\n",
      );
      const text = textOf(await parse(callLine(1, "status"), h.deps));
      const out = JSON.parse(text);
      expect(out.spool.live.bytes).toBeGreaterThan(0); // the SIZE is reported...
      expect(out.spool.live.lines).toBe(1);
      expect(text).not.toContain("SpoolCanaryFake0123456789abcdef"); // ...never the body
    } finally {
      await h.stop();
    }
  });

  test("server down: server/queue carry the failure CLASS, no raw error string", async () => {
    const h = await mk();
    try {
      h.fake.mode("refuse");
      const r = await parse(callLine(1, "status"), h.deps);
      expect(r.result.isError).toBeUndefined();
      const text = textOf(r);
      const out = JSON.parse(text);
      expect(out.server).toEqual({ reachable: false, version: null, error_class: "connect" });
      expect(out.queue).toEqual({ error_class: "connect" });
      expect(out.problems).toContain("server unreachable");
      expect(out.healthy).toBe(false);
      expect(out.config.peer).toBe(SELF);
      expect(out.last_error_at).toBeNull();
      // never a raw fetch error text (it can carry the URL / cause chain)
      expect(text).not.toContain("TypeError");
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("fetch failed");
    } finally {
      await h.stop();
    }
  });
});

describe("T8 review: the profile workspace is never touched by these tools", () => {
  test("ask, remember, mission and status make zero profile-workspace requests", async () => {
    const h = await mk({ peer: LEADER, observeOthers: true, profileWorkspace: "prof" });
    try {
      await parse(callLine(1, "ask", { question: "anything?" }), h.deps);
      await parse(callLine(2, "ask", { question: "scoped?", mission: "general" }), h.deps);
      await parse(callLine(3, "remember", { fact: "A decision" }), h.deps);
      await parse(callLine(4, "mission", { id: "slice-07" }), h.deps);
      await parse(callLine(5, "status"), h.deps);
      const prof = h.fake.requests.filter((rq) => rq.path.includes("/workspaces/prof"));
      expect(prof.map((rq) => `${rq.method} ${rq.path}`)).toEqual([]);
      expect(h.fake.state.workspaces.has("prof")).toBe(false);
    } finally {
      await h.stop();
    }
  });
});

// ---- bin/mcp.ts: the real stdio loop ------------------------------------

const start = (env: Record<string, string>) => {
  const p = Bun.spawn([process.execPath, BIN], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe" });
  const rd = (p.stdout as ReadableStream<Uint8Array>).getReader();
  const errRd = (p.stderr as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  let errText = "";
  const pumpErr = (async () => {
    for (;;) {
      const { done, value } = await errRd.read();
      if (done) break;
      errText += dec.decode(value, { stream: true });
    }
  })();
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const i = buf.indexOf("\n");
      if (i >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        return l;
      }
      const { done, value } = await rd.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
    }
  };
  const drain = async (): Promise<string[]> => {
    const all: string[] = [];
    for (;;) {
      const l = await nextLine();
      if (l === null) break;
      if (l !== "") all.push(l);
    }
    return all;
  };
  // Bun.spawn stdin is a FileSink: .write(string) directly (build's pattern)
  const write = (s: string): void => {
    (p.stdin as unknown as { write(data: string): void }).write(s);
  };
  const close = async (): Promise<{ code: number; err: string }> => {
    (p.stdin as unknown as { end(): void }).end();
    const code = await p.exited;
    await pumpErr;
    return { code, err: errText };
  };
  return { write, nextLine, drain, close };
};

const binEnv = (dir: string, fake: FakeHoncho): Record<string, string> => ({
  HOME: dir,
  HONCHO_STATE_DIR: dir,
  HONCHO_URL: fake.url,
  HONCHO_WORKSPACE: WS,
  HONCHO_PEER: SELF,
  HONCHO_API_KEY: "sk-ant-RevT8BinFake0123456789abcdefGHIJ", // fake-secret
  HONCHO_TIMEOUT_MS: "2000" });

describe("T8 review: bin/mcp.ts stdio robustness", () => {
  test("a partial line arrives as one reply once the newline lands", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("rev-t8b-");
    const h = start(binEnv(dir, fake));
    try {
      const line = frame(1, "tools/list");
      h.write(line.slice(0, 24)); // no newline: nothing may be answered yet
      await Bun.sleep(60);
      h.write(`${line.slice(24)}\n`);
      const l = await h.nextLine();
      expect(l).not.toBeNull();
      expect(JSON.parse(l as string).id).toBe(1);
    } finally {
      const c = await h.close();
      expect(c.code).toBe(0);
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("stdin closing mid-request (no trailing newline): exit 0, no answer, no stderr", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("rev-t8b-");
    const h = start(binEnv(dir, fake));
    try {
      h.write(`${frame(1, "initialize")}\n`);
      const first = await h.nextLine();
      expect(JSON.parse(first as string).id).toBe(1);
      h.write('{"jsonrpc":"2.0","id":2,"meth'); // truncated request, then EOF
      const c = await h.close(); // ends stdin; exit must not answer the partial line
      expect(c.code).toBe(0);
      expect(c.err).toBe("");
      const extra = await h.drain(); // any stray frame (reply or -32700) would land here
      expect(extra).toEqual([]);
    } finally {
      await fake.stop();
    }
  });

  test("pipelined requests all answer, in order; notifications add nothing", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("rev-t8b-");
    const h = start(binEnv(dir, fake));
    try {
      h.write(
        [
          frame(1, "initialize", { protocolVersion: "2025-06-18" }),
          frame(2, "ping"),
          notif("notifications/initialized"),
          "not json at all",
          frame(3, "tools/list"),
          notif("ping"),
          frame(4, "bogus/method"),
        ].join("\n") + "\n",
      );
      const frames: Record<string, any>[] = [];
      for (let i = 0; i < 5; i++) {
        const l = await h.nextLine();
        expect(l, `reply ${i + 1}`).not.toBeNull();
        frames.push(JSON.parse(l as string));
      }
      const c = await h.close();
      expect(c.code).toBe(0);
      expect(c.err).toBe("");
      // the two notifications and the id-less ping must add NO sixth frame
      expect(await h.drain()).toEqual([]);
      expect(frames.map((f) => f.id)).toEqual([1, 2, null, 3, 4]);
      expect(frames[2].error.code).toBe(-32700);
      expect(frames[4].error.code).toBe(-32601);
    } finally {
      await fake.stop();
    }
  });
});
