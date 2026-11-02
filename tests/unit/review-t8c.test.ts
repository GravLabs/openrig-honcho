// T8c + T8-fix-2 re-review (review seat, pin 9d055f9). Contract: ADR-0006
// O1-O3 + X1; ADR-0004 tool table (leader identity gate, secret-shaped
// mission ids); findings F-1..F-4. My retargeted review-t8/review-t6a tests
// cover the fixed surfaces; THIS file attacks the new machinery the qitem
// lists: log hygiene with every redaction kind through the MCP tools and the
// bins, rotation boundary, concurrent writers, counters under replay /
// dead-letter / lock-busy, status exit codes for each unhealthy condition,
// and "status output never contains a value from the spool or a log line
// beyond the allowed fields".
//
// Everything here is fake-driven; no live server, no scratch workspaces
// (the bins talk to the fake at 127.0.0.1).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { handleLine, type McpDeps } from "../../plugin/src/mcp.ts";
import { logEvent, errorClassFrom } from "../../plugin/src/log.ts";
import { readSeatState, seatLockDir, seatStatePath } from "../../plugin/src/missions.ts";
import { updateStats, statsFrom } from "../../plugin/src/stats.ts";
import { recordBody } from "../../plugin/src/writer.ts";
import { spoolAppend, type SpoolPaths } from "../../plugin/src/spool.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";
const REPO = join(import.meta.dir, "..", "..");
// fake values only, secret-SHAPED, never real
const S_KEY = "sk-ant-T8cFake0123456789abcdefGHIJKL"; // sk-ant rule — fake-secret
const S_BEARER = "Bearer t8cBearerFake0123456789abcdefGHIJ"; // bearer rule (16+ run) — fake-secret
const S_ASSIGN = "API_KEY=t8cAssignFake0123456789abcdefGHIJ"; // assignment rule — fake-secret
const S_OPAQUE = `Zk9${"x".repeat(43)}`; // opaque-run rule (mixed run; a single repeated char is NOT opaque-shaped by ADR-0003)
const SECRET_MARKS = [
  "T8cFake0123456789abcdef",
  "t8cBearerFake0123456789abcdef",
  "t8cAssignFake0123456789abcdef",
  S_OPAQUE,
];
const NOW = () => "2026-10-28T12:00:00.000Z";

interface H {
  fake: FakeHoncho;
  dir: string;
  config: Config;
  deps: McpDeps;
  paths: SpoolPaths;
  stop(): Promise<void>;
}

async function mk(cfgOver: Partial<Config> = {}): Promise<H> {
  const fake = await startFakeHoncho();
  const dir = makeTempDir("rev-t8c-");
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: false,
    apiKey: "sk-ant-RevT8cKeyFake0123456789abcdefGHIJ", // fake-secret
    stateDir: dir,
    timeoutMs: 2000,
    ...cfgOver };
  if (config.leaderPeer === undefined && config.observeOthers === true) {
    config.leaderPeer = config.peer; // env.ts:162 normalisation
  }
  const client = createClient({ url: fake.url, workspace: WS, apiKey: config.apiKey, timeoutMs: 2000 });
  return {
    fake,
    dir,
    config,
    deps: { config, client, now: NOW },
    paths: { stateDir: dir, workspace: WS, peer: SELF },
    stop: async () => {
      fake.mode("ok");
      await fake.stop();
    } };
}

const parse = async (line: string, deps: McpDeps): Promise<Record<string, any> | null> => {
  const raw = await handleLine(line, deps);
  return raw === null ? null : (JSON.parse(raw) as Record<string, any>);
};
const callLine = (id: unknown, name: string, args?: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args ?? {} } });
const textOf = (r: Record<string, any>): string => (r.result.content as { text: string }[])[0].text;

const logFile = (dir: string): string => join(dir, "log", `${WS}.log`);
const readAll = (dir: string): string => {
  let all = "";
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else all += readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return all;
};
/** every line of the workspace log parses as JSON (O1); returns the objects. */
const jsonLines = (dir: string): Record<string, unknown>[] => {
  let text = "";
  try {
    text = readFileSync(logFile(dir), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>; // throws -> red
      return o;
    });
};
const ALLOWED_LOG_KEYS = new Set([
  "ts", "hook", "peer", "event", "ok", "ms", "session", "n_msgs", "bytes", "error_class",
]);

const spawnBin = async (
  binRel: string,
  env: Record<string, string>,
  stdinText?: string,
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> => {
  const p = Bun.spawn([process.execPath, join(REPO, binRel), ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe" });
  const w = p.stdin as unknown as { write(s: string): void; end(): void };
  if (stdinText !== undefined) w.write(stdinText);
  w.end();
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  return { code, out, err };
};

const binEnv = (dir: string, url: string, over: Record<string, string> = {}): Record<string, string> => ({
  HOME: dir,
  HONCHO_STATE_DIR: dir,
  HONCHO_URL: url,
  HONCHO_WORKSPACE: WS,
  HONCHO_PEER: SELF,
  HONCHO_API_KEY: "sk-ant-RevT8cBinFake0123456789abcdefGH", // fake-secret
  HONCHO_TIMEOUT_MS: "2000",
  ...over });

describe("T8c review: O1 log hygiene through the MCP tools", () => {
  test("every redaction kind: refused/reddacted upstream, NOTHING shaped like a secret reaches the log", async () => {
    const h = await mk({ peer: SELF, observeOthers: true }); // leader (normalised)
    try {
      await parse(callLine(1, "ask", { question: `rotate ${S_KEY} now` }), h.deps);
      await parse(callLine(2, "ask", { question: `use ${S_BEARER} instead` }), h.deps);
      await parse(callLine(3, "remember", { fact: `creds: ${S_ASSIGN}` }), h.deps);
      await parse(callLine(4, "remember", { fact: `blob ${S_OPAQUE} stored` }), h.deps);
      for (const id of [S_KEY, S_BEARER, S_ASSIGN, S_OPAQUE]) {
        const m = await parse(callLine(5, "mission", { id }), h.deps);
        expect(m.result.isError).toBe(true); // F-T8-3 refuses EVERY redaction kind
        expect(textOf(m)).toBe("mission id looks like a secret; not stored");
      }
      await parse(callLine(6, "status"), h.deps);
      // an ORDINARY isError (not a security refusal): pins tool:<name>:false
      await parse(callLine(7, "bogus_tool", {}), h.deps);

      // O1: every line parses; only allowed fields; no secret shapes anywhere
      const lines = jsonLines(h.dir);
      expect(lines.length).toBeGreaterThanOrEqual(7); // one per tool call
      for (const l of lines) {
        for (const k of Object.keys(l)) {
          expect(ALLOWED_LOG_KEYS.has(k), `field ${k} not allowed`).toBe(true);
        }
      }
      const logText = readFileSync(logFile(h.dir), "utf8");
      for (const mark of SECRET_MARKS) expect(logText).not.toContain(mark);
      // events exist and carry ok the right way. T8d-1 item 0 (accepted
      // 20:26Z): the four secret-id mission calls are SECURITY refusals and
      // log event "refused" ok:false error_class "refused" - never
      // tool:mission:false. An ordinary isError keeps tool:<name>:false with
      // NO error_class, so both shapes are pinned here.
      const events = lines.map((l) => `${String(l.event)}:${String(l.ok)}`);
      expect(events).toContain("tool:ask:true");
      const refused = lines.filter((l) => l.event === "refused");
      expect(refused.length).toBe(4); // exactly the four secret-kind mission ids
      for (const r of refused) {
        expect(r.ok).toBe(false);
        expect(r.error_class).toBe("refused");
      }
      expect(events).not.toContain("tool:mission:false");
      const bogus = lines.find((l) => l.event === "tool:bogus_tool");
      expect(bogus?.ok).toBe(false); // ordinary isError: name kept, ok false
      expect(bogus?.error_class).toBeUndefined(); // error_class is refused-only
      // upstream: the wire got the REDACTED text, not the secret
      const chat = h.fake.requests.filter((r) => r.path.includes("/chat"));
      for (const c of chat) expect(JSON.stringify(c.body)).not.toContain("T8cFake0123456789abcdef");
      const concl = h.fake.state.conclusions.get(WS) as Record<string, unknown>[];
      for (const c of concl) expect(String(c.content)).not.toContain("t8cAssignFake0123456789abcdef");
    } finally {
      await h.stop();
    }
  });

  test("a spooled remember under outage carries only redacted text into the spool", async () => {
    const h = await mk({ peer: SELF, observeOthers: true });
    try {
      h.fake.failPattern("/messages", { status: 500 });
      const r = await parse(callLine(1, "remember", { fact: `rotate ${S_KEY} tonight` }), h.deps);
      expect(textOf(r)).toContain("(decision message spooled)");
      const spoolDir = join(h.dir, WS, "spool");
      const files = existsSync(spoolDir) ? readdirSync(spoolDir) : [];
      expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
      for (const f of files) expect(readFileSync(join(spoolDir, f), "utf8")).not.toContain("T8cFake0123456789abcdef");
      const logText = existsSync(logFile(h.dir)) ? readFileSync(logFile(h.dir), "utf8") : "";
      expect(logText).not.toContain("T8cFake0123456789abcdef");
    } finally {
      await h.stop();
    }
  });

  test("remember folds its write into the seat counters", async () => {
    const h = await mk({ peer: SELF, observeOthers: true });
    try {
      await parse(callLine(1, "remember", { fact: "we ship Tuesday" }), h.deps);
      const seat = readSeatState(seatStatePath(h.dir, WS, SELF));
      expect(seat).not.toBeNull();
      const stats = statsFrom(seat);
      expect(stats.written).toBe(1);
      expect(stats.failed).toBe(0);
      expect(typeof stats.last_ok_at).toBe("string");
    } finally {
      await h.stop();
    }
  });
});

describe("T8c review: rotation boundary", () => {
  test(">5 MB rotates .log -> .1 -> .2 -> .3 and drops the oldest .3", async () => {
    const h = await mk();
    try {
      const file = logFile(h.dir);
      mkdirSync(join(h.dir, "log"), { recursive: true });
      const pad = (sentinel: string): string =>
        JSON.stringify({ ts: NOW(), hook: "stop", event: sentinel, ok: true, pad: "P".repeat(5_100_000) }) + "\n";
      // four full rotations: P1..P4 each exceed the 5 MB threshold
      for (const s of ["sent-P1", "sent-P2", "sent-P3", "sent-P4"]) {
        writeFileSync(file, pad(s));
        logEvent(h.config, { hook: "mcp", event: `after-${s}`, ok: true, ms: 1 });
      }
      expect(readFileSync(file, "utf8")).not.toContain('"event":"sent-P4"'); // old body moved out...
      expect(readFileSync(file, "utf8")).toContain('"event":"after-sent-P4"'); // ...new event lands
      expect(readFileSync(`${file}.1`, "utf8")).toContain('"event":"sent-P4"');
      expect(readFileSync(`${file}.2`, "utf8")).toContain('"event":"sent-P3"');
      expect(readFileSync(`${file}.3`, "utf8")).toContain('"event":"sent-P2"');
      expect(existsSync(`${file}.4`)).toBe(false); // nothing lives past .3
      expect(readFileSync(`${file}.3`, "utf8")).not.toContain('"event":"sent-P1"'); // oldest dropped
    } finally {
      await h.stop();
    }
  });

  test("concurrent appenders: 50 parallel events, every line intact", async () => {
    const h = await mk();
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          Promise.all(
            Array.from({ length: 5 }, (_, j) =>
              Promise.resolve().then(() =>
                logEvent(h.config, { hook: "mcp", event: `c${i}-${j}`, ok: true, ms: 1 }),
              ),
            ),
          ),
        ),
      );
      const lines = jsonLines(h.dir); // every line parses - no interleaving
      expect(lines.length).toBe(50);
      expect(new Set(lines.map((l) => l.event)).size).toBe(50);
    } finally {
      await h.stop();
    }
  });
});

describe("T8c review: counters under real paths", () => {
  test("replay folds sent entries into written+replayed", async () => {
    const h = await mk();
    try {
      const client = createClient({ url: h.fake.url, workspace: WS, apiKey: h.config.apiKey, timeoutMs: 2000 });
      await client.createSession("build--general--1", { metadata: { rig_peer: SELF, mission: "general" } });
      // seed write kept after T8c-fix: counters CREATE missing state now, so
      // the fold is no longer lost without it - but the assertion counts the
      // seed too (written 3), and a dedicated create-missing test lives in
      // review-t8d.test.ts
      await recordBody({ content: "seed", sender: SELF, kindTag: "decision", hookName: "rev-t8c" }, h.config, { client, now: NOW });
      await spoolAppend(h.paths, {
        session: "build--general--1",
        messages: [{ peer_id: SELF, content: "queued during outage", metadata: { client_id: "q1" } }],
        maybe_sent: false,
        at: NOW() });
      const out = await recordBody(
        { content: "fresh note", sender: SELF, kindTag: "decision", hookName: "rev-t8c" },
        h.config,
        { client, now: NOW },
      );
      expect(out.action).toBe("sent");
      const stats = statsFrom(readSeatState(seatStatePath(h.dir, WS, SELF)));
      expect(stats.replayed).toBe(1);
      expect(stats.written).toBe(3); // seed + the replayed one + the fresh one
      expect(stats.failed).toBe(0);
      expect(typeof stats.last_ok_at).toBe("string");
    } finally {
      await h.stop();
    }
  });

  test("dead-letter (413) counts dead and moves the entry out of the live spool", async () => {
    const h = await mk();
    try {
      const client = createClient({ url: h.fake.url, workspace: WS, apiKey: h.config.apiKey, timeoutMs: 2000 });
      await client.createSession("build--general--1", { metadata: { rig_peer: SELF, mission: "general" } });
      await recordBody({ content: "seed", sender: SELF, kindTag: "decision", hookName: "rev-t8c" }, h.config, { client, now: NOW });
      await spoolAppend(h.paths, {
        session: "build--general--1",
        messages: [{ peer_id: SELF, content: "poison-body-never-resendable", metadata: { client_id: "pz" } }],
        maybe_sent: false,
        at: NOW() });
      h.fake.failPattern("/messages", { status: 413, bodyContains: "poison-body-never-resendable" });
      const out = await recordBody(
        { content: "healthy fresh note", sender: SELF, kindTag: "decision", hookName: "rev-t8c" },
        h.config,
        { client, now: NOW },
      );
      expect(out.action).toBe("sent"); // the fresh write is unaffected
      const stats = statsFrom(readSeatState(seatStatePath(h.dir, WS, SELF)));
      expect(stats.dead).toBe(1);
      expect(stats.replayed).toBe(0); // never sent
      expect(stats.written).toBe(2); // seed + fresh
      const deadPath = join(h.dir, WS, "spool", "build.dead.jsonl");
      expect(existsSync(deadPath)).toBe(true);
      expect(readFileSync(deadPath, "utf8")).toContain("poison-body-never-resendable");
    } finally {
      await h.stop();
    }
  });

  test("a busy seat lock makes updateStats a silent no-op", async () => {
    const h = await mk();
    try {
      mkdirSync(join(h.dir, WS, "seats"), { recursive: true });
      writeFileSync(seatStatePath(h.dir, WS, SELF), JSON.stringify({ mission: "general", n: 1, counters: {} }));
      // hold the lock through a contended updateStats (WAIT_MS = 2000 inside)
      let release!: () => void;
      const held = new Promise<void>((res) => {
        release = res;
      });
      const { withLock } = await import("../../plugin/src/lock.ts");
      const guard = withLock(seatLockDir(h.dir, WS, SELF), () => held);
      await Bun.sleep(50); // let the guard acquire
      const t0 = Date.now();
      await updateStats(h.dir, WS, SELF, (s) => {
        s.written += 1;
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1900); // it waited, then gave up
      const stats = statsFrom(readSeatState(seatStatePath(h.dir, WS, SELF)));
      expect(stats.written).toBe(0); // never threw, never wrote
      release();
      await guard;
    } finally {
      await h.stop();
    }
  });

  test("ten concurrent updateStats calls all land (per-seat lock serialises)", async () => {
    const h = await mk();
    try {
      mkdirSync(join(h.dir, WS, "seats"), { recursive: true });
      writeFileSync(seatStatePath(h.dir, WS, SELF), JSON.stringify({ mission: "general", n: 1, counters: {} }));
      await Promise.all(
        Array.from({ length: 10 }, () => updateStats(h.dir, WS, SELF, (s) => {
          s.written += 1;
        })),
      );
      const stats = statsFrom(readSeatState(seatStatePath(h.dir, WS, SELF)));
      expect(stats.written).toBe(10);
    } finally {
      await h.stop();
    }
  });

  test("errorClassFrom names shapes, never texts", () => {
    expect(errorClassFrom("http", 503)).toBe("http_503");
    expect(errorClassFrom("connect")).toBe("connect");
    expect(errorClassFrom("timeout")).toBe("timeout");
    expect(errorClassFrom("parse")).toBe("parse");
    expect(errorClassFrom("unknown")).toBe("other");
    expect(errorClassFrom("http")).toBe("other"); // kind without a status
  });
});

describe("T8c review: bin/status.ts exit codes", () => {
  test("healthy: exit 0, healthy true", async () => {
    const h = await mk();
    try {
      const r = await spawnBin("plugin/bin/status.ts", binEnv(h.dir, h.fake.url), undefined, ["--json"]);
      const j = JSON.parse(r.out) as Record<string, any>;
      expect(j.healthy).toBe(true);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
    } finally {
      await h.stop();
    }
  });

  test("server down: exit 1, problem + class only, no raw string", async () => {
    const h = await mk();
    try {
      h.fake.mode("refuse");
      const r = await spawnBin("plugin/bin/status.ts", binEnv(h.dir, h.fake.url), undefined, ["--json"]);
      expect(r.code).toBe(1);
      const j = JSON.parse(r.out) as Record<string, any>;
      expect(j.healthy).toBe(false);
      expect(j.problems).toContain("server unreachable");
      expect(j.server.error_class).toBe("connect");
      expect(r.out).not.toContain("ECONNREFUSED");
      expect(r.out).not.toContain("TypeError");
    } finally {
      await h.stop();
    }
  });

  test("version mismatch: exit 1 with the version problem", async () => {
    const h = await mk();
    try {
      // a stand-in server answering openapi with the WRONG version
      const wrong = Bun.serve({
        port: 0,
        fetch: (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/openapi.json") {
            return Response.json({ openapi: "3.1.0", info: { version: "3.3.0" } });
          }
          return Response.json({ detail: "no" }, { status: 404 });
        } });
      try {
        const r = await spawnBin(
          "plugin/bin/status.ts",
          binEnv(h.dir, `http://127.0.0.1:${wrong.port}/v3`),
          undefined,
          ["--json"],
        );
        expect(r.code).toBe(1);
        const j = JSON.parse(r.out) as Record<string, any>;
        expect(j.healthy).toBe(false);
        expect(j.problems.join(" ")).toContain("3.3.0");
        expect(j.server.reachable).toBe(true);
      } finally {
        wrong.stop();
      }
    } finally {
      await h.stop();
    }
  });

  test("spool past 8 MB: exit 1, sizes reported, content never printed", async () => {
    const h = await mk();
    try {
      mkdirSync(join(h.dir, WS, "spool"), { recursive: true });
      writeFileSync(
        join(h.dir, WS, "spool", `${SELF}.jsonl`),
        `{"canary":"SpoolBigFake0123456789abcdef"}\n${"x".repeat(8_000_001)}`,
      );
      const r = await spawnBin("plugin/bin/status.ts", binEnv(h.dir, h.fake.url), undefined, ["--json"]);
      expect(r.code).toBe(1);
      const j = JSON.parse(r.out) as Record<string, any>;
      expect(j.healthy).toBe(false);
      expect(j.problems.join(" ")).toContain("spool");
      expect(j.spool.live.bytes).toBeGreaterThan(8_000_000);
      expect(r.out).not.toContain("SpoolBigFake0123456789abcdef");
      expect(r.out).not.toContain("xxxxxxxx");
    } finally {
      await h.stop();
    }
  });

  test("kill switch: exit 1, the disabled shape, never a reason", async () => {
    const h = await mk();
    try {
      const r = await spawnBin(
        "plugin/bin/status.ts",
        binEnv(h.dir, h.fake.url, { HONCHO_ENABLED: "false" }),
        undefined,
        ["--json"],
      );
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toEqual({ enabled: false, healthy: false, problems: ["memory disabled"] });
      // human shape likewise carries no reason
      const hum = await spawnBin(
        "plugin/bin/status.ts",
        binEnv(h.dir, h.fake.url, { HONCHO_ENABLED: "false" }),
        undefined,
      );
      expect(hum.code).toBe(1);
      expect(hum.out).toContain("DISABLED");
      expect(hum.out).not.toContain("HONCHO_"); // no variable names, no reason text
    } finally {
      await h.stop();
    }
  });
});

describe("T8c review: the architect real-bin checks (reproduced against the fake)", () => {
  test("user-prompt vs a refused server: O1 holds, the spool event carries error_class connect, no secret reaches disk", async () => {
    const h = await mk();
    try {
      h.fake.mode("refuse");
      const env = binEnv(h.dir, h.fake.url);
      const r = await spawnBin(
        "plugin/bin/user-prompt.ts",
        env,
        JSON.stringify({ prompt: `remember that ${S_ASSIGN} is the deploy credential`, session_id: "cs-rev-1" }) + "\n",
      );
      expect(r.code).toBe(0); // degrade off-path, never crash
      expect(r.err).toBe("");
      const lines = jsonLines(h.dir); // O1: every line parses
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const spoolEvents = lines.filter((l) => l.event === "spooled");
      expect(spoolEvents.length).toBe(1);
      expect(spoolEvents[0].ok).toBe(false);
      expect(spoolEvents[0].error_class).toBe("connect");
      // the fake key in the prompt never reaches log/ or the spool - or anywhere
      expect(readAll(h.dir)).not.toContain("t8cAssignFake0123456789abcdef");
      const stats = statsFrom(readSeatState(seatStatePath(h.dir, WS, SELF)));
      expect(stats.last_error_class).toBe("connect");
    } finally {
      await h.stop();
    }
  });

  test("session-start logs the HONCHO session name, not the Claude id", async () => {
    const h = await mk();
    try {
      const r = await spawnBin(
        "plugin/bin/session-start.ts",
        binEnv(h.dir, h.fake.url),
        JSON.stringify({ source: "resume", session_id: "claude-cs-xyz" }) + "\n",
      );
      expect(r.code).toBe(0);
      const lines = jsonLines(h.dir);
      const ss = lines.filter((l) => l.hook === "session-start");
      expect(ss.length).toBe(1);
      expect(ss[0].event).toBe("resume");
      expect(ss[0].session).toBe("build--general--1"); // minted by the reader's resolve
      expect(JSON.stringify(ss[0])).not.toContain("claude-cs-xyz");
    } finally {
      await h.stop();
    }
  });
});
