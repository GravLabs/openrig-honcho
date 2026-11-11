// T8: bin/mcp.ts as a child process against the FAKE server, spoken to with
// newline-delimited JSON-RPC 2.0 on its real stdio. Covers the qitem list:
// initialize echoes the requested protocolVersion; tools/list is
// ask/mission/status for a non-leader and gains remember for the leader;
// mission writes the state file with the normalised id; remember writes ONE
// redacted conclusion via the batch create form after ensuring the session;
// ask returns the fake's chat answer and passes mission-<scope> only when a
// mission is given; a hung chat answers isError within the ask timeout
// (HONCHO_ASK_TIMEOUT_MS override); malformed lines get -32700 and the server
// keeps answering; unknown methods get -32601; the kill switch yields an
// empty tool list. Nothing on stderr in any case.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, readFileSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import type { HonchoClient } from "../../plugin/src/honcho.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import { readRigMission } from "../../plugin/src/missions.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { startFakeDaemon } from "../support/fake-daemon.ts";
import { LEDGER_PEER } from "../../plugin/src/ledger.ts";

const WS = "ws";
const SELF = "build";
const REPO = join(import.meta.dir, "..", "..");
const BIN = join(REPO, "plugin/bin/mcp.ts");

type Frame = Record<string, unknown>;

const start = (env: Record<string, string>) => {
  const p = Bun.spawn([process.execPath, BIN], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
  // Bun.spawn stdin is a FileSink: .write(string) directly, never getWriter()
  const write = (s: string): void => {
    (p.stdin as unknown as { write(data: string): void }).write(s);
  };
  const send = (f: Frame | string): void => write(typeof f === "string" ? `${f}\n` : `${JSON.stringify(f)}\n`);
  const rpc = async (id: number, method: string, params?: unknown): Promise<Record<string, any>> => {
    send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    const l = await nextLine();
    expect(l, `no reply to ${method}`).not.toBeNull();
    return JSON.parse(l as string);
  };
  const init = async (id = 1): Promise<Record<string, any>> =>
    rpc(id, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const close = async (): Promise<{ code: number; err: string }> => {
    (p.stdin as unknown as { end(): void }).end();
    const code = await p.exited;
    await pumpErr;
    return { code, err: errText };
  };
  return { send, nextLine, rpc, init, close };
};

const baseEnv = (dir: string, fake: FakeHoncho, over: Record<string, string> = {}): Record<string, string> => ({
  HOME: dir,
  HONCHO_STATE_DIR: dir,
  HONCHO_URL: fake.url,
  HONCHO_WORKSPACE: WS,
  HONCHO_PEER: SELF,
  HONCHO_TIMEOUT_MS: "2000",
  ...over });

const toolNames = (resp: Record<string, any>): string[] => (resp.result.tools as { name: string }[]).map((t) => t.name);
const textOf = (resp: Record<string, any>): string => (resp.result.content as { text: string }[])[0].text;

describe("bin/mcp.ts rig_memory (T8)", () => {
  test("initialize echoes the protocolVersion; non-leader tools/list is ask, mission, status", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      const r = await h.init();
      expect(r.id).toBe(1);
      expect(r.result.protocolVersion).toBe("2025-06-18");
      expect(r.result.serverInfo).toEqual({ name: "rig_memory", version: "0.1.0" });
      expect(r.result.capabilities.tools).toBeDefined();
      // notification: NO reply - proven because the very next line is the pong
      h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const pong = await h.rpc(2, "ping");
      expect(pong.id).toBe(2);
      expect(pong.result).toEqual({});
      const list = await h.rpc(3, "tools/list");
      // T16d adds search (every seat) right after ask
    expect(toolNames(list)).toEqual(["ask", "search", "mission", "status"]);
    } finally {
      const c = await h.close();
      expect(c.code).toBe(0);
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("leader tools/list additionally offers remember", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      const list = await h.rpc(2, "tools/list");
      // T16d adds search (every seat) right after ask; T19a adds retire
      // (leader-only) right after remember
    expect(toolNames(list)).toEqual(["ask", "search", "remember", "retire", "mission", "status"]);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("tools/call mission normalises the id and writes the mission file", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "mission", arguments: { id: "Slice 07!" } });
      expect(r.result.isError).toBeUndefined();
      expect(JSON.parse(textOf(r))).toEqual({ ok: true, mission: "slice-07", scope: "mission-slice-07" });
      const stored = JSON.parse(readFileSync(join(dir, WS, "mission.json"), "utf8")) as { mission: string; set_by: string };
      expect(stored.mission).toBe("slice-07");
      expect(stored.set_by).toBe(SELF);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("remember: leader-only, redacts, ensures the session, one batched conclusion", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", {
        name: "remember",
        arguments: { fact: "ship gate is sk-ant-FAKETHISISNOTAREALSECRET01 only" }, // fake-secret
      });
      // T19a: the reply names the new ledger id
      expect(textOf(r)).toMatch(/^remembered in build--general--1 \(d-[0-9a-f]{8}\)$/);
      const concl = fake.state.conclusions.get(WS) ?? [];
      expect(concl.length).toBe(1);
      const c0 = concl[0] as Record<string, unknown>;
      // T19a: plain remember gains the ledger header (fixed point 6)
      expect(String(c0.content)).toMatch(
        /^\[decision d-[0-9a-f]{8} · scope mission\] ship gate is /,
      );
      expect(String(c0.content)).toContain("[REDACTED");
      expect(String(c0.content)).not.toContain("FAKETHISIS");
      expect(c0.observer_id).toBe(SELF);
      expect(c0.observed_id).toBe(LEDGER_PEER); // T24: entries ride the reserved pair
      expect(c0.session_id).toBe("build--general--1");
      // the session was ensured first (the real server 404s otherwise)
      expect(fake.state.sessions.has(`${WS}/build--general--1`)).toBe(true);
      // the create used the BATCH form the live route demands
      const post = fake.requests.find((q) => q.path === `/v3/workspaces/${WS}/conclusions`);
      expect(post).toBeDefined();
      expect(Array.isArray((post!.body as { conclusions?: unknown }).conclusions)).toBe(true);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  // --- T8-fix (ADR-0004 amendment) -------------------------------------

  test("remember ALSO writes the fact as a decision message in the mission session", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      await h.rpc(2, "tools/call", { name: "mission", arguments: { id: "auth" } });
      const r = await h.rpc(3, "tools/call", {
        name: "remember",
        arguments: { fact: "ship gate: redaction before chunking" } });
      expect(textOf(r)).toMatch(/^remembered in build--auth--1 \(d-[0-9a-f]{8}\)$/);
      // exactly one conclusion AND exactly one message
      const concl = fake.state.conclusions.get(WS) ?? [];
      expect(concl.length).toBe(1);
      const msgs = fake.state.messages.get(`${WS}/build--auth--1`) ?? [];
      expect(msgs.length).toBe(1);
      expect(msgs[0].peer_id).toBe(SELF);
      expect((msgs[0].metadata as Record<string, unknown>).kind).toBe("decision");
      // T19a (amendment): the decision message carries the ledger fields,
      // and its id is the one the reply named and the header carries
      const md = msgs[0].metadata as Record<string, unknown>;
      const id = /\((d-[0-9a-f]{8})\)$/.exec(textOf(r))![1];
      expect(md.decision_id).toBe(id);
      expect(md.decision_kind).toBe("decision");
      expect(md.decision_scope).toBe("mission");
      expect(String(concl[0].content)).toContain(`[decision ${id} · scope mission] ship gate`);
      expect(String(msgs[0].content)).toContain(`[decision ${id} · scope mission] ship gate`);
      // T8d-3 (ADR-0006 a2abdbd): reasoning true sends NO message
      // configuration at all (the workspace default decides); only
      // suppressions carry {reasoning:{enabled:false}}.
      expect(msgs[0].configuration).toBeUndefined();
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  // --- T19a (ADR-0014 d2 + amendment): the decision ledger tools ----------

  test("remember ledger fields: kind approval, scope rig, supersedes, redacted reason", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      const a = await h.rpc(2, "tools/call", { name: "remember", arguments: { fact: "run on 868" } });
      const idA = /\((d-[0-9a-f]{8})\)$/.exec(textOf(a))![1];
      const b = await h.rpc(3, "tools/call", {
        name: "remember",
        arguments: {
          fact: "run on 915",
          reason: "owner approved sk-ant-FAKETHISISNOTAREALSECRET02", // fake-secret
          supersedes: idA,
          scope: "rig",
          kind: "approval",
        },
      });
      expect(b.result.isError).toBeUndefined();
      const idB = /\((d-[0-9a-f]{8})\)$/.exec(textOf(b))![1];
      const concl = fake.state.conclusions.get(WS) ?? [];
      expect(concl.length).toBe(2);
      const c1 = String((concl[1] as Record<string, unknown>).content);
      expect(
        c1.startsWith(`[approval ${idB} · scope rig · supersedes ${idA}] run on 915 (reason: owner approved [REDACTED`),
      ).toBe(true);
      expect(c1).not.toContain("FAKETHISIS");
      const msgs = fake.state.messages.get(`${WS}/build--general--1`) ?? [];
      expect(msgs.length).toBe(2);
      const md = msgs[1].metadata as Record<string, unknown>;
      expect(md).toMatchObject({
        decision_id: idB,
        decision_kind: "approval",
        decision_scope: "rig",
        decision_supersedes: idA,
      });
      expect(String(md.decision_reason)).toContain("[REDACTED");
      expect(String(md.decision_reason)).not.toContain("FAKETHISIS");
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("supersedes an unknown or malformed id is refused; nothing is written", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      const r1 = await h.rpc(2, "tools/call", {
        name: "remember",
        arguments: { fact: "x", supersedes: "d-deadbeef" },
      });
      expect(r1.result.isError).toBe(true);
      expect(textOf(r1)).toContain("supersedes d-deadbeef is not in the current ledger");
      const r2 = await h.rpc(3, "tools/call", {
        name: "remember",
        arguments: { fact: "x", supersedes: "old-1" },
      });
      expect(r2.result.isError).toBe(true);
      expect(textOf(r2)).toContain("supersedes must be a decision id");
      expect((fake.state.conclusions.get(WS) ?? []).length).toBe(0);
      expect(fake.state.messages.get(`${WS}/build--general--1`) ?? []).toHaveLength(0);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("scope: rig, mission and qitem ids pass; anything else is a usage error", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      const bad = await h.rpc(2, "tools/call", { name: "remember", arguments: { fact: "x", scope: "global" } });
      expect(bad.result.isError).toBe(true);
      expect(textOf(bad)).toContain("scope must be rig, mission, or a queue item id");
      expect((fake.state.conclusions.get(WS) ?? []).length).toBe(0);
      const ok = await h.rpc(3, "tools/call", {
        name: "remember",
        arguments: { fact: "go", scope: "qitem-20261103024649-e25e8b91965dce3a" },
      });
      expect(ok.result.isError).toBeUndefined();
      const id = /\((d-[0-9a-f]{8})\)$/.exec(textOf(ok))![1];
      const concl = fake.state.conclusions.get(WS) ?? [];
      expect(String((concl[0] as Record<string, unknown>).content)).toContain(
        `[decision ${id} · scope qitem-20261103024649-e25e8b91965dce3a] go`,
      );
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("retire: unknown id refused, in-force id writes the retire entry and the message", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      const a = await h.rpc(2, "tools/call", { name: "remember", arguments: { fact: "use LoRa" } });
      const idA = /\((d-[0-9a-f]{8})\)$/.exec(textOf(a))![1];
      const bad = await h.rpc(3, "tools/call", { name: "retire", arguments: { decision_id: "d-00000000", reason: "never was" } });
      expect(bad.result.isError).toBe(true);
      expect(textOf(bad)).toContain("d-00000000 is not in the current ledger");
      expect((fake.state.conclusions.get(WS) ?? []).length).toBe(1); // still only A
      const usage = await h.rpc(4, "tools/call", { name: "retire", arguments: { decision_id: "d-11111111" } });
      expect(usage.result.isError).toBe(true);
      expect(textOf(usage)).toContain("usage: retire");
      const r = await h.rpc(5, "tools/call", { name: "retire", arguments: { decision_id: idA, reason: "replaced by hand" } });
      expect(r.result.isError).toBeUndefined();
      expect(textOf(r)).toBe(`retired ${idA}`);
      const concl = fake.state.conclusions.get(WS) ?? [];
      expect(concl.length).toBe(2);
      expect(String((concl[1] as Record<string, unknown>).content)).toBe(`[retire ${idA}] replaced by hand`);
      const msgs = fake.state.messages.get(`${WS}/build--general--1`) ?? [];
      expect(msgs.length).toBe(2);
      const md = msgs[1].metadata as Record<string, unknown>;
      expect(md).toMatchObject({ decision_id: idA, decision_op: "retire", decision_reason: "replaced by hand" });
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("retire from a non-leader is the explicit refusal, not unknown tool", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "retire", arguments: { decision_id: "d-1a2b3c4d", reason: "x" } });
      expect(r.result.isError).toBe(true);
      expect(textOf(r)).toBe("retire is leader-only");
      expect((fake.state.conclusions.get(WS) ?? []).length).toBe(0);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("ask with mission: chat answer, then 'Recorded decisions in this mission:' with the fact", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      await h.rpc(2, "tools/call", { name: "mission", arguments: { id: "auth" } });
      await h.rpc(3, "tools/call", { name: "remember", arguments: { fact: "auth is delegated to the gateway" } });
      const r = await h.rpc(4, "tools/call", { name: "ask", arguments: { question: "how is auth handled", mission: "auth" } });
      expect(r.result.isError).toBeUndefined();
      const text = textOf(r);
      expect(text.startsWith("fake-honcho fixed answer")).toBe(true);
      expect(text).toContain("Recorded decisions in this mission:");
      expect(text).toContain("auth is delegated to the gateway");
      expect(text).toContain("- just now"); // age label line (E9 format)
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("ask labels item scope and approvals (T20c rule 4); a mission decision's line is unchanged", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_OBSERVE_OTHERS: "true" }));
    try {
      await h.init();
      await h.rpc(2, "tools/call", { name: "mission", arguments: { id: "auth" } });
      await h.rpc(3, "tools/call", { name: "remember", arguments: { fact: "auth is delegated to the gateway" } });
      await h.rpc(5, "tools/call", {
        name: "remember",
        arguments: { fact: "publish build 4.2", kind: "approval", scope: "qitem-20260101000000-1234567890abcdef" },
      });
      const r = await h.rpc(4, "tools/call", { name: "ask", arguments: { question: "anything", mission: "auth" } });
      expect(r.result.isError).toBeUndefined();
      const text = textOf(r);
      // approval: marked AND named to its item (label, never filter here)
      expect(text).toContain("- just now, approval, for qitem-20260101000000-1234567890abcdef");
      // mission decision: the pre-T20c line exactly
      const labelLines = text.split("\n").filter((l) => l.startsWith("- "));
      expect(labelLines).toContain("- just now");
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("ask on a mission whose scope does not exist: the No-memory text, isError false", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "ask", arguments: { question: "anything yet", mission: "ghost" } });
      expect(r.result.isError).toBeUndefined();
      expect(textOf(r)).toBe("No memory recorded for mission ghost yet.");
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("remember on a NON-leader is refused even when called by name", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "remember", arguments: { fact: "sneaky" } });
      expect(r.result.isError).toBe(true);
      expect((fake.state.conclusions.get(WS) ?? []).length).toBe(0);
      // T8d-1 item 0: the refusal logs event "refused" + error_class "refused"
      const logLine = JSON.parse(
        readFileSync(join(dir, "log", `${WS}.log`), "utf8").trim().split("\n").at(-1) as string,
      ) as Record<string, unknown>;
      expect(logLine).toMatchObject({ hook: "mcp", event: "refused", ok: false, error_class: "refused" });
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("O1 (ADR-0017 decision 6): tool lines carry the seat session and the in-progress qitem", async () => {
    const fake = await startFakeHoncho();
    const ITEM = "qitem-20261110120000-0123456789abcdef";
    const d = await startFakeDaemon({
      queueList: [
        { qitemId: ITEM, destinationSession: "build@ws", state: "in-progress" },
        { qitemId: "qitem-20261110120001-0000000000000000", destinationSession: "other@ws", state: "in-progress" },
      ],
    });
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { OPENRIG_URL: d.url, OPENRIG_SESSION_NAME: "build@ws" }));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "mission", arguments: { id: "outcome-6" } });
      expect(r.result.isError).toBeUndefined();
      const line = JSON.parse(
        readFileSync(join(dir, "log", `${WS}.log`), "utf8").trim().split("\n").at(-1) as string,
      ) as Record<string, unknown>;
      expect(line).toMatchObject({ hook: "mcp", event: "tool:mission", session: "build@ws", qitem: ITEM });
      // still ONE line per run (O1): the second call appends one line, not two
      await h.rpc(3, "tools/call", { name: "mission", arguments: { id: "outcome-6b" } });
      const lines = readFileSync(join(dir, "log", `${WS}.log`), "utf8").trim().split("\n");
      expect(lines.filter((l) => (JSON.parse(l) as Frame).hook === "mcp")).toHaveLength(2);
      expect(JSON.parse(lines[1] as string)).toMatchObject({ session: "build@ws", qitem: ITEM });
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      d.close();
      await fake.stop();
    }
  });

  test("O1: unknown current item or no session config keeps the fields absent", async () => {
    const fake = await startFakeHoncho();
    const d = await startFakeDaemon({ queueList: [] });
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { OPENRIG_URL: d.url, OPENRIG_SESSION_NAME: "build@ws" }));
    try {
      await h.init();
      await h.rpc(2, "tools/call", { name: "mission", arguments: { id: "outcome-6" } });
      let line = JSON.parse(
        readFileSync(join(dir, "log", `${WS}.log`), "utf8").trim().split("\n").at(-1) as string,
      ) as Record<string, unknown>;
      expect(line.session).toBe("build@ws");
      expect("qitem" in line).toBe(false);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      d.close();
      await fake.stop();
    }
    // no OPENRIG_SESSION_NAME at all: no session field either, line otherwise normal
    const dir2 = makeTempDir("mcp-test-");
    const fake2 = await startFakeHoncho();
    const h2 = start(baseEnv(dir2, fake2));
    try {
      await h2.init();
      await h2.rpc(2, "tools/call", { name: "mission", arguments: { id: "outcome-6" } });
      const line2 = JSON.parse(
        readFileSync(join(dir2, "log", `${WS}.log`), "utf8").trim().split("\n").at(-1) as string,
      ) as Record<string, unknown>;
      expect(line2.hook).toBe("mcp");
      expect("session" in line2).toBe(false);
      expect("qitem" in line2).toBe(false);
    } finally {
      const c = await h2.close();
      expect(c.err).toBe("");
      await fake2.stop();
    }
  });

  test("ask returns the chat answer; mission adds the mission-<id> scope", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "ask", arguments: { question: "where did we leave the auth work" } });
      expect(textOf(r)).toBe("fake-honcho fixed answer");
      await h.rpc(3, "tools/call", { name: "ask", arguments: { question: "q", mission: "auth" } });
      const chats = fake.requests.filter((q) => q.path === `/v3/workspaces/${WS}/chat`);
      expect(chats.length).toBe(2);
      const first = chats[0].body as Record<string, unknown>;
      expect(first.query).toBe("where did we leave the auth work");
      expect(first.scope).toBeUndefined();
      expect(first.reasoning_level).toBe("low");
      const second = chats[1].body as Record<string, unknown>;
      expect(second.scope).toBe("mission-auth");
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("ask with the server hung: isError 'memory unavailable: timeout' within the ask timeout", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_ASK_TIMEOUT_MS: "700" }));
    try {
      await h.init();
      fake.mode("hang");
      const t0 = Date.now();
      const r = await h.rpc(2, "tools/call", { name: "ask", arguments: { question: "hello?" } });
      const ms = Date.now() - t0;
      expect(r.result.isError).toBe(true);
      expect(textOf(r)).toBe("memory unavailable: timeout");
      expect(ms).toBeLessThan(10_000); // well inside the 61 s ceiling the qitem sets
    } finally {
      fake.mode("ok"); // release the hung waiter
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("malformed line -> -32700 and the server keeps answering", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      h.send("{not json at all");
      const bad = JSON.parse((await h.nextLine()) as string) as Record<string, any>;
      expect(bad.error.code).toBe(-32700);
      expect(bad.id).toBeNull();
      const pong = await h.rpc(2, "ping");
      expect(pong.result).toEqual({}); // still alive
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("unknown method -> -32601", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake));
    try {
      await h.init();
      const r = await h.rpc(2, "audio/transcribe");
      expect(r.error.code).toBe(-32601);
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("kill switch: protocol alive, tools/list empty, nothing logged", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_ENABLED: "false" }));
    try {
      await h.init();
      const list = await h.rpc(2, "tools/list");
      expect(list.result.tools).toEqual([]);
    } finally {
      const c = await h.close();
      expect(c.code).toBe(0);
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("ask default timeout is 90 000 ms; deps.askTimeoutMs overrides it", async () => {
    // in-process (src/mcp.ts): the timeout is a client-side AbortSignal value,
    // invisible on the wire, so a stub client records what ask passed.
    const cfg: Config = {
      enabled: true,
      url: "http://127.0.0.1:1/v3",
      workspace: WS,
      peer: SELF,
      observeOthers: false,
      ownerPeer: "owner",
      profileWorkspace: null,
      recordAutomation: true,
      apiKey: "k",
      stateDir: makeTempDir("mcp-test-") };
    const seen: (number | undefined)[] = [];
    const client = {
      workspaceChat: async (_b: unknown, o?: { timeoutMs?: number }) => {
        seen.push(o?.timeoutMs);
        return { ok: true as const, data: { content: "a" } };
      } } as unknown as HonchoClient;
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask", arguments: { question: "q" } } });
    const r1 = JSON.parse((await handleLine(line, { config: cfg, client })) as string);
    expect(r1.result.content[0].text).toBe("a");
    const r2 = JSON.parse((await handleLine(line, { config: cfg, client, askTimeoutMs: 1234 })) as string);
    expect(r2.result.isError).toBeUndefined();
    expect(seen).toEqual([90_000, 1234]);
  });

  test("status: config/server/session/spool/queue JSON, no API key anywhere", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-test-");
    const h = start(baseEnv(dir, fake, { HONCHO_API_KEY: "sk-ant-FAKEDONOTLEAK000000" })); // fake-secret
    try {
      await h.init();
      const r = await h.rpc(2, "tools/call", { name: "status", arguments: {} });
      const text = textOf(r);
      const st = JSON.parse(text) as Record<string, any>;
      expect(st.config).toEqual({
        host: new URL(fake.url).host,
        workspace: WS,
        peer: SELF,
        leader: null,
        profile_workspace: null });
      expect(st.server).toEqual({ reachable: true, version: "fake-3.5.0" });
      expect(st.session.session).toBeNull(); // no hook has run in this state dir yet
      expect(st.spool.live).toEqual({ bytes: 0, lines: 0 });
      expect(st.queue).toMatchObject({ total_work_units: 0 });
      // T8c (O3): last_error (raw line, F-T8-4) is gone; class + counters + tail
      expect(st.last_error).toBeUndefined();
      expect(st.last_error_class).toBeNull();
      expect(st.last_error_at).toBeNull();
      expect(st.counters.written).toBe(0);
      expect(st.log_tail).toEqual([]);
      expect(st.healthy).toBe(true);
      expect(st.problems).toEqual([]);
      expect(text).not.toContain("FAKEDONOTLEAK");
      expect(text).not.toContain("sk-ant-");
    } finally {
      const c = await h.close();
      expect(c.err).toBe("");
      await fake.stop();
    }
  });

  test("F-T8-1: id-less messages are notifications - silent, and tools/call does not execute", async () => {
    const dir = makeTempDir("mcp-test-");
    const cfg: Config = {
      enabled: true,
      url: "http://127.0.0.1:1/v3",
      workspace: WS,
      peer: SELF,
      observeOthers: false,
      ownerPeer: "owner",
      profileWorkspace: null,
      recordAutomation: true,
      apiKey: "k",
      stateDir: dir };
    const client = {} as unknown as HonchoClient;
    expect(await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }), { config: cfg, client })).toBeNull();
    expect(
      await handleLine(
        JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "mission", arguments: { id: "should-not-run" } } }),
        { config: cfg, client },
      ),
    ).toBeNull();
    // not executed: mission.json not written, and no mcp log line either
    expect(readRigMission(dir, WS).mission).toBe("general");
    expect(existsSync(join(dir, "log", `${WS}.log`))).toBe(false);
    // with an id the same call behaves as before
    const r = JSON.parse(
      (await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }), { config: cfg, client })) as string,
    ) as { result: { tools: unknown[] } };
    expect(Array.isArray(r.result.tools)).toBe(true);
  });
});
