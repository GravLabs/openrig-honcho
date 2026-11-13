// T8c (ADR-0006 O1/O2/O3 + X1): the structured event log, the seat counters,
// and the status surfaces. All against the FAKE server and tmp dirs. The
// hygiene test synthesizes one fake secret of each ADR-0003 kind plus a
// marker and proves neither can ever reach a log file; the counters tests
// walk the written/spooled/replayed/dead paths through the real writer; the
// status tests pin the bin's exit codes and the report's exhaustive shape.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { errorClassFrom, logEvent, readLogTail, type LogTarget } from "../../plugin/src/log.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import { readRigMission, readSeatState, seatStatePath } from "../../plugin/src/missions.ts";
import { collectStatus, versionAccepted } from "../../plugin/src/status.ts";
import { statsFrom } from "../../plugin/src/stats.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";
const REPO = join(import.meta.dir, "..", "..");

// One synthetic fake per ADR-0003 kind (shapes only, never real values).
const MARKER = "PURPLE-ELEPHANT-7";
const SECRETS: Record<string, string> = { // fake-secret
  anthropic: "sk-ant-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6", // fake-secret
  strata: "strata_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q", // fake-secret
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", // fake-secret
  bearer: "Authorization: Bearer abcdef0123456789ABCDEFtail", // fake-secret
  pem: "-----BEGIN PRIVATE KEY-----\\nMIIsecretbodyline\\n-----END PRIVATE KEY-----", // fake-secret
  assignment: "HONCHO_API_KEY=SuperSecretValue12345", // fake-secret
  "json-secret": '{"api_key": "JsonSecretValue99999"}', // fake-secret
  hex64: "0123456789abcdef".repeat(4),
  opaque: "Abcdefghijklmnopqrstuvwxyz01234567890123456789", // fake-secret
};
const ALL_SECRETS = Object.values(SECRETS).join(" | ");

const mk = async (over: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("obs-test-");
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: true,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over };
  return { fake, dir, config, deps: { client, now: () => new Date().toISOString() } };
};

const seatStats = (dir: string) =>
  statsFrom(readSeatState(seatStatePath(dir, WS, SELF)));

// T19b (ADR-0014 d1): the digest adds moment + the per-part COUNTS to the
// session-start line - counts only, never content, same X1 discipline.
const LOG_KEYS = new Set([
  "ts",
  "hook",
  "peer",
  "event",
  "ok",
  "ms",
  "session",
  "n_msgs",
  "bytes",
  "error_class",
  "moment",
  "n_open",
  "n_decisions",
  "n_approvals",
  "n_away",
  "has_pointer",
]);

const readLogLines = (dir: string, ws = WS): Record<string, unknown>[] => {
  const file = join(dir, "log", `${ws}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const runBin = async (
  bin: string,
  env: Record<string, string>,
  stdin: string,
  argv: string[] = [],
): Promise<{ code: number; out: string; err: string }> => {
  const p = Bun.spawn([process.execPath, join(REPO, "plugin/bin", bin), ...argv], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe" });
  p.stdin.write(stdin);
  p.stdin.end();
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, out, err };
};

describe("log.ts logEvent (O1)", () => {
  test("one JSON line, only the allowed fields", () => {
    const dir = makeTempDir("obs-log-");
    const t: LogTarget = { stateDir: dir, workspace: WS, peer: SELF };
    logEvent(t, { hook: "user-prompt", event: "sent", ok: true, ms: 12.4, session: "build--general--1", n_msgs: 2 });
    logEvent(t, { hook: "mcp", event: "tool:ask", ok: false, ms: 0, error_class: "http_422" });
    const lines = readLogLines(dir);
    expect(lines.length).toBe(2);
    expect(Object.keys(lines[0]).sort()).toEqual(["event", "hook", "ms", "n_msgs", "ok", "peer", "session", "ts"]);
    expect(lines[0]).toMatchObject({ hook: "user-prompt", event: "sent", ok: true, ms: 12, peer: SELF });
    expect(lines[1]).toMatchObject({ hook: "mcp", event: "tool:ask", ok: false, ms: 0, error_class: "http_422" });
    expect(lines[1].session).toBeUndefined();
  });

  test("dir 0700, file 0600; never throws on a broken target", () => {
    const dir = makeTempDir("obs-log-");
    const t: LogTarget = { stateDir: dir, workspace: WS, peer: SELF };
    logEvent(t, { hook: "stop", event: "sent", ok: true, ms: 1 });
    expect((statSync(join(dir, "log")).mode & 0o777) === 0o700 || process.platform === "win32").toBe(true);
    expect((statSync(join(dir, "log", `${WS}.log`)).mode & 0o777) === 0o600).toBe(true);
    // a FILE where the state dir should be: mkdir fails, logEvent swallows
    const broken = join(makeTempDir("obs-log-"), "not-a-dir");
    writeFileSync(broken, "x");
    expect(() =>
      logEvent({ stateDir: broken, workspace: WS, peer: SELF }, { hook: "stop", event: "e", ok: true, ms: 0 }),
    ).not.toThrow();
  });

  test("rotation: >5 MB rotates .log -> .1 -> .2 -> .3, at most 3 kept", () => {
    const dir = makeTempDir("obs-log-");
    const t: LogTarget = { stateDir: dir, workspace: WS, peer: SELF };
    const file = join(dir, "log", `${WS}.log`);
    logEvent(t, { hook: "stop", event: "seed", ok: true, ms: 0 }); // creates dir
    writeFileSync(file, `${"x".repeat(1000)}\n`.repeat(5100)); // 5.1 MB > 5 MB
    writeFileSync(`${file}.1`, "OLD-1\n");
    writeFileSync(`${file}.2`, "OLD-2\n");
    writeFileSync(`${file}.3`, "OLD-3-SHOULD-DIE\n");
    logEvent(t, { hook: "stop", event: "after-rotate", ok: true, ms: 0 });
    expect(readFileSync(`${file}.1`, "utf8").startsWith("xxx")).toBe(true);
    expect(readFileSync(`${file}.2`, "utf8")).toBe("OLD-1\n");
    expect(readFileSync(`${file}.3`, "utf8")).toBe("OLD-2\n");
    expect(readFileSync(file, "utf8").trim().split("\n").length).toBe(1);
    expect(readdirSync(join(dir, "log")).filter((f) => f.startsWith(`${WS}.log.`)).length).toBe(3);
    expect(readFileSync(file, "utf8")).toContain("after-rotate");
  });

  test("readLogTail projects to exactly {ts,hook,event,ok,error_class}, skips junk", () => {
    const dir = makeTempDir("obs-log-");
    const t: LogTarget = { stateDir: dir, workspace: WS, peer: SELF };
    logEvent(t, { hook: "stop", event: "a", ok: true, ms: 0 }); // creates dir + file
    const file = join(dir, "log", `${WS}.log`);
    appendFileSync(file, "not json at all\n");
    appendFileSync(file, `${JSON.stringify({ ts: "t2", hook: "mcp", event: "b", ok: false, ms: 1, peer: SELF, secret_field: "LEAKME" })}\n`);
    const tail = readLogTail(t, 5);
    expect(tail.length).toBe(2);
    expect(tail[0].event).toBe("a");
    expect(tail[1]).toEqual({ ts: "t2", hook: "mcp", event: "b", ok: false });
    expect(JSON.stringify(tail)).not.toContain("LEAKME");
    expect(tail.every((l) => Object.keys(l).every((k) => LOG_KEYS.has(k)))).toBe(true);
  });

  test("errorClassFrom maps kinds only, never a string", () => {
    expect(errorClassFrom("connect")).toBe("connect");
    expect(errorClassFrom("timeout")).toBe("timeout");
    expect(errorClassFrom("parse")).toBe("parse");
    expect(errorClassFrom("http", 422)).toBe("http_422");
    expect(errorClassFrom("http")).toBe("other");
    expect(errorClassFrom("unknown")).toBe("other");
  });
});

describe("bins: one structured event per run, never content (O1 + X1)", () => {
  test("secrets + marker through all three hook bins never reach any log file", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("obs-hyg-");
    const env: Record<string, string> = {
      HOME: dir,
      HONCHO_STATE_DIR: dir,
      HONCHO_ENABLED: "true",
      HONCHO_URL: fake.url,
      HONCHO_WORKSPACE: WS,
      HONCHO_PEER: SELF };
    const up = await runBin("user-prompt.ts", env, JSON.stringify({ prompt: `${ALL_SECRETS} ${MARKER}`, session_id: "s-hyg" }));
    const st = await runBin("stop.ts", env, JSON.stringify({ last_assistant_message: `${SECRETS.assignment} ${SECRETS.hex64} ${MARKER}` }));
    const ss = await runBin("session-start.ts", env, JSON.stringify({ session_id: "s-hyg", source: "startup" }));
    expect([up.code, st.code, ss.code]).toEqual([0, 0, 0]);

    // every file under <stateDir>/log, including _config.log
    const logDir = join(dir, "log");
    const files = readdirSync(logDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(logDir, f), "utf8");
      expect(text).not.toContain(MARKER);
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
      expect(text).not.toContain("REDACTED"); // no content of any form lands here
    }

    const lines = readLogLines(dir);
    expect(lines.length).toBe(3); // exactly one event per run
    for (const l of lines) {
      expect(Object.keys(l).every((k) => LOG_KEYS.has(k))).toBe(true);
      expect(typeof l.ts).toBe("string");
      expect(typeof l.ms).toBe("number");
    }
    expect(lines.map((l) => l.hook).sort()).toEqual(["session-start", "stop", "user-prompt"]);
    const upLine = lines.find((l) => l.hook === "user-prompt");
    expect(upLine?.event).toBe("sent");
    expect(upLine?.ok).toBe(true);
    // fix 19:50Z #3: session-start logs the HONCHO session name (resolveSession
    // in buildInjection set it), never the Claude session id that was fed in
    const ssLine = lines.find((l) => l.hook === "session-start");
    expect(ssLine?.session).toBe("build--general--1");
    expect(ssLine?.session).not.toBe("s-hyg");
    await fake.stop();
  }, 15000);

  test("bin user-prompt against a refused server: spooled event carries error_class connect, log stays JSONL", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("obs-ref-");
    const env: Record<string, string> = {
      HOME: dir,
      HONCHO_STATE_DIR: dir,
      HONCHO_ENABLED: "true",
      HONCHO_URL: fake.url,
      HONCHO_WORKSPACE: WS,
      HONCHO_PEER: SELF };
    try {
      const first = await runBin("user-prompt.ts", env, JSON.stringify({ prompt: "healthy baseline write", session_id: "s-ref" }));
      expect(first.code).toBe(0);
      fake.mode("refuse");
      const second = await runBin("user-prompt.ts", env, JSON.stringify({ prompt: "write during outage", session_id: "s-ref" }));
      expect(second.code).toBe(0);
      const lines = readLogLines(dir); // every line MUST parse (fix #1)
      expect(lines.length).toBe(2);
      expect(lines[1]).toMatchObject({ hook: "user-prompt", event: "spooled", ok: false, error_class: "connect" });
      expect(lines[1].session).toBe("build--general--1");
      // and the counters see the same class (fix #2 end to end)
      expect(seatStats(dir).last_error_class).toBe("connect");
    } finally {
      await fake.stop();
    }
  }, 15000);
});

describe("seat counters (O2)", () => {
  test("written / spooled / replayed across an outage and its recovery", async () => {
    const { fake, dir, deps, config } = await mk();
    try {
      for (const c of ["note one", "note two", "note three"]) {
        expect((await recordPrompt({ prompt: c }, config, deps)).action).toBe("sent");
      }
      let s = seatStats(dir);
      expect(s.written).toBe(3);
      expect(s.failed).toBe(0);

      fake.mode("refuse"); // server down: both writes spool
      for (const c of ["note four", "note five"]) {
        const o = await recordPrompt({ prompt: c }, config, deps);
        // fix 19:50Z #2: the client kind is carried even through the
        // ensure-failed path (a refused connection classes as connect)
        expect(o).toMatchObject({ action: "spooled", error_class: "connect" });
      }
      s = seatStats(dir);
      expect(s.written).toBe(3);
      expect(s.failed).toBe(2);
      expect(s.spooled).toBe(2);
      expect(s.last_error_class).toBe("connect");
      expect(typeof s.last_error_at).toBe("string");
      // fix 19:50Z #1: the whole log stays pure JSONL through the outage
      const file = join(dir, "log", `${WS}.log`);
      if (existsSync(file)) {
        for (const l of readFileSync(file, "utf8").split("\n").filter((x) => x.trim() !== "")) {
          expect(() => JSON.parse(l)).not.toThrow();
        }
      }

      fake.mode("ok"); // recovery: the next run replays the spool, then writes
      expect((await recordPrompt({ prompt: "note six" }, config, deps)).action).toBe("sent");
      s = seatStats(dir);
      // DEVIATION (noted for the architect): the brief says "written 5"; the
      // triggering sixth write counts too, so the real number is 6.
      expect(s.written).toBe(6);
      expect(s.spooled).toBe(2);
      expect(s.replayed).toBe(2);
      expect(s.failed).toBe(2);
      expect(typeof s.last_ok_at).toBe("string");
    } finally {
      await fake.stop();
    }
  }, 15000);

  test("a permanent 422 at replay dead-letters: dead 1, http_422 class", async () => {
    const { fake, dir, deps, config } = await mk();
    try {
      fake.failPattern("/messages", { status: 422, bodyContains: "POISONENTRY-7" });
      expect((await recordPrompt({ prompt: "keep POISONENTRY-7 out" }, config, deps)).action).toBe("spooled");
      let s = seatStats(dir);
      expect(s.failed).toBe(1);
      expect(s.spooled).toBe(1);
      expect(s.last_error_class).toBe("http_422"); // status threaded through SendOutcome

      expect((await recordPrompt({ prompt: "a clean follow-up" }, config, deps)).action).toBe("sent");
      s = seatStats(dir);
      expect(s.dead).toBe(1);
      expect(s.written).toBe(1); // the clean follow-up; the poison went to dead
      expect(existsSync(join(dir, WS, "spool", `${SELF}.dead.jsonl`))).toBe(true);
    } finally {
      await fake.stop();
    }
  }, 15000);

  test("redactions counted per ADR-0003 kind, accumulating across writes", async () => {
    const { fake, dir, deps, config } = await mk();
    try {
      await recordPrompt(
        { prompt: `use ${SECRETS.anthropic} and ${SECRETS.assignment} plus ${SECRETS.hex64}` },
        config,
        deps,
      );
      let s = seatStats(dir);
      expect(s.redactions).toEqual({ anthropic: 1, assignment: 1, hex64: 1 });
      await recordPrompt({ prompt: `again ${SECRETS.anthropic}` }, config, deps);
      s = seatStats(dir);
      expect(s.redactions.anthropic).toBe(2);
      expect(s.written).toBe(2);
    } finally {
      await fake.stop();
    }
  }, 15000);
});

describe("status: MCP tool + bin (O3)", () => {
  test("mcp: one mcp log line per tool call; status projects the tail, no last_error", async () => {
    const { fake, dir, config } = await mk();
    try {
      const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      const call = (id: number, name: string, args: Record<string, unknown>) =>
        handleLine(
          JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
          { config, client },
        );
      const m = await call(1, "mission", { id: "t8c-log" });
      expect(m).not.toBeNull();
      await call(2, "mission", { id: SECRETS.anthropic }); // F-T8-3: refused, still logged
      const r = JSON.parse((await call(3, "status", {})) as string) as { result: { content: { text: string }[] } };
      const st = JSON.parse(r.result.content[0].text) as Record<string, any>;
      expect(st.last_error).toBeUndefined();
      expect(st.counters).toBeDefined();
      expect(st.log_tail.length).toBe(2); // mission, mission - the status call logs after answering
      expect(st.log_tail[0].event).toBe("tool:mission");
      expect(st.log_tail[1].event).toBe("refused"); // T8d-1 item 0
      expect(st.log_tail[1].ok).toBe(false); // the secret-shaped id
      expect(st.log_tail[1].error_class).toBe("refused");
      expect(st.log_tail.every((l: Record<string, unknown>) => Object.keys(l).every((k) => LOG_KEYS.has(k)))).toBe(true);
      // the secret-shaped id changed nothing (call 1 had set t8c-log)
      expect(readRigMission(dir, WS).mission).toBe("t8c-log");
      // and the refused id never reached the log file either
      const raw = readFileSync(join(dir, "log", `${WS}.log`), "utf8");
      expect(raw).not.toContain(SECRETS.anthropic);
      const lines = readLogLines(dir);
      expect(lines.length).toBe(3); // exactly one line per tools/call
      expect(lines.every((l) => l.hook === "mcp")).toBe(true);
    } finally {
      await fake.stop();
    }
  }, 15000);

  test("bin: healthy fake -> 0; --json parses; human says OK", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("obs-bin-");
    try {
      const env = {
        HOME: dir, HONCHO_STATE_DIR: dir, HONCHO_ENABLED: "true",
        HONCHO_URL: fake.url, HONCHO_WORKSPACE: WS, HONCHO_PEER: SELF };
      const human = await runBin("status.ts", env, "");
      expect(human.code).toBe(0);
      expect(human.out).toContain("memory: OK");
      const j = await runBin("status.ts", env, "", ["--json"]);
      expect(j.code).toBe(0);
      const st = JSON.parse(j.out) as Record<string, any>;
      expect(st.healthy).toBe(true);
      expect(st.server).toEqual({ reachable: true, version: "fake-3.5.0" });
      expect(st.counters.written).toBe(0);
      expect(st.problems).toEqual([]);
    } finally {
      await fake.stop();
    }
  }, 15000);

  // O9: the same bin contract next to the 3.5.0 pin, against a fake answering 3.6.1.
  test("bin: healthy 3.6.1 fake -> 0; --json healthy with the 3.6.1 version", async () => {
    const fake = await startFakeHoncho({ version: "fake-3.6.1" });
    const dir = makeTempDir("obs-bin-");
    try {
      const env = {
        HOME: dir, HONCHO_STATE_DIR: dir, HONCHO_ENABLED: "true",
        HONCHO_URL: fake.url, HONCHO_WORKSPACE: WS, HONCHO_PEER: SELF };
      const human = await runBin("status.ts", env, "");
      expect(human.code).toBe(0);
      expect(human.out).toContain("memory: OK");
      const j = await runBin("status.ts", env, "", ["--json"]);
      expect(j.code).toBe(0);
      const st = JSON.parse(j.out) as Record<string, any>;
      expect(st.healthy).toBe(true);
      expect(st.server).toEqual({ reachable: true, version: "fake-3.6.1" });
      expect(st.problems).toEqual([]);
    } finally {
      await fake.stop();
    }
  }, 15000);

  // O3 item 4 (ADR-0017 decision 4): status reports the outcome collector's
  // last run and its record count for THIS workspace, or that it never ran.
  test("O3 item 4: outcomes - never run is a fact, after a run it is mtime + count", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("obs-outc-");
    try {
      const env = {
        HOME: dir, HONCHO_STATE_DIR: dir, HONCHO_ENABLED: "true",
        HONCHO_URL: fake.url, HONCHO_WORKSPACE: WS, HONCHO_PEER: SELF };
      const never = await runBin("status.ts", env, "");
      expect(never.code, never.out + never.err).toBe(0);
      expect(never.out).toContain("outcomes: never run");
      const jn = JSON.parse((await runBin("status.ts", env, "", ["--json"])).out) as Record<string, any>;
      expect(jn.outcomes).toEqual({ last_run_at: null, records: 0 });
      expect(jn.healthy).toBe(true); // never-run is a fact, not a problem
      // three records at the collector's own path (one blank line between)
      const file = join(dir, "outcomes", `${WS}.jsonl`);
      mkdirSync(join(dir, "outcomes"), { recursive: true, mode: 0o700 });
      writeFileSync(file, '{"qitemId":"a"}\n{"qitemId":"b"}\n\n{"qitemId":"c"}\n', { mode: 0o600 });
      const human = await runBin("status.ts", env, "");
      expect(human.out).toMatch(/outcomes: last run \d{4}-\d{2}-\d{2}T\S+, 3 records/);
      const j = JSON.parse((await runBin("status.ts", env, "", ["--json"])).out) as Record<string, any>;
      expect(j.outcomes.records).toBe(3);
      // the time IS the file's mtime - the report invents no clock
      expect(j.outcomes.last_run_at).toBe(statSync(file).mtime.toISOString());
    } finally {
      await fake.stop();
    }
  }, 15000);

  test("bin: server down -> exit 1 with the problem", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("obs-bin-");
    try {
      fake.mode("refuse");
      const r = await runBin(
        "status.ts",
        {
          HOME: dir, HONCHO_STATE_DIR: dir, HONCHO_ENABLED: "true",
          HONCHO_URL: fake.url, HONCHO_WORKSPACE: WS, HONCHO_PEER: SELF },
        "",
        ["--json"],
      );
      expect(r.code).toBe(1);
      const st = JSON.parse(r.out) as Record<string, any>;
      expect(st.healthy).toBe(false);
      expect(st.problems).toContain("server unreachable");
      // F-T8-4: the failure leaves as a class, never a string
      expect(typeof st.server.error_class).toBe("string");
      expect(r.out).not.toContain("ECONNREFUSED");
    } finally {
      await fake.stop();
    }
  }, 15000);

  test("bin: disabled -> exit 1; kill switch prints and logs no reason", async () => {
    const dir = makeTempDir("obs-bin-");
    const bad = await runBin("status.ts", { HOME: dir, HONCHO_STATE_DIR: dir }, "");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("DISABLED");
    expect(bad.out).not.toContain("HONCHO_"); // the reason names no variable on stdout
    // a broken config DOES get its one shared config-log line
    expect(existsSync(join(dir, "log", "_config.log"))).toBe(true);
    // the kill switch, in a fresh state dir: silent, no config log at all
    const dir2 = makeTempDir("obs-bin-");
    const off = await runBin(
      "status.ts",
      { HOME: dir2, HONCHO_STATE_DIR: dir2, HONCHO_ENABLED: "false" },
      "",
      ["--json"],
    );
    expect(off.code).toBe(1);
    expect(JSON.parse(off.out)).toEqual({ enabled: false, healthy: false, problems: ["memory disabled"] });
    expect(existsSync(join(dir2, "log", "_config.log"))).toBe(false); // kill switch: silent
    expect(off.out).not.toContain("kill"); // and the reason never prints
  });

  const miniServer = (version: string) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/openapi.json") {
          return Response.json({ openapi: "3.1.0", info: { title: "mini", version } });
        }
        return Response.json({ total_work_units: 0 });
      } });

  test("collectStatus: wrong version is a problem, right version is not", async () => {
    const bad = miniServer("3.3.0");
    const dir = makeTempDir("obs-collect-");
    try {
      const config: Config = {
        enabled: true, url: `http://127.0.0.1:${bad.port}/v3`, workspace: WS, peer: SELF,
        observeOthers: false, ownerPeer: "owner", profileWorkspace: null, recordAutomation: true,
        apiKey: "k", stateDir: dir, timeoutMs: 2000 };
      const client = createClient({ url: config.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      const st = await collectStatus(config, client);
      expect(st.healthy).toBe(false);
      // O9 retarget (forced flip): the 3.5.0-only message is gone by design;
      // the tested-version wording is the new canonical phrase.
      expect(st.problems.some((p) => p.includes("is not a tested version"))).toBe(true);
    } finally {
      bad.stop();
    }
  });

  // O9 (qitem-...5f9e58): written FIRST, against the 3.5.0-only pin, to show
  // the live-3.6.1 UNHEALTHY bug as a test failure before the fix exists.
  test("O9 red-first: a 3.6.1 server is healthy", async () => {
    const good = miniServer("3.6.1");
    const dir = makeTempDir("obs-collect-");
    try {
      const config: Config = {
        enabled: true, url: `http://127.0.0.1:${good.port}/v3`, workspace: WS, peer: SELF,
        observeOthers: false, ownerPeer: "owner", profileWorkspace: null, recordAutomation: true,
        apiKey: "k", stateDir: dir, timeoutMs: 2000 };
      const client = createClient({ url: config.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      const st = await collectStatus(config, client);
      expect(st.problems).toEqual([]);
      expect(st.healthy).toBe(true);
    } finally {
      good.stop();
    }
  });

  test("O9: versionAccepted parses major.minor - the endsWith regressions stay dead", () => {
    expect(versionAccepted("3.6.1")).toBe(true);
    expect(versionAccepted("fake-3.6.1")).toBe(true); // test doubles answer this (pin)
    expect(versionAccepted("3.5.0")).toBe(true);
    expect(versionAccepted("fake-3.5.0")).toBe(true);
    expect(versionAccepted("3.6.14")).toBe(true);
    expect(versionAccepted("3.5.99")).toBe(true);
    expect(versionAccepted("3.7.0")).toBe(false);
    expect(versionAccepted("13.6.1")).toBe(false); // a suffix match would accept it (O9)
    expect(versionAccepted("13.5.0")).toBe(false); // the old endsWith("3.5.0") accepted this (O9)
    expect(versionAccepted("3.6")).toBe(false);
    expect(versionAccepted(null)).toBe(false);
    expect(versionAccepted(undefined)).toBe(false);
  });

  test("O9: off-line versions report the exact message naming the lines", async () => {
    for (const [version, accepted] of [["3.7.0", false], ["13.6.1", false], ["fake-3.6.1", true]] as [string, boolean][]) {
      const srv = miniServer(version);
      const dir = makeTempDir("obs-collect-");
      try {
        const config: Config = {
          enabled: true, url: `http://127.0.0.1:${srv.port}/v3`, workspace: WS, peer: SELF,
          observeOthers: false, ownerPeer: "owner", profileWorkspace: null, recordAutomation: true,
          apiKey: "k", stateDir: dir, timeoutMs: 2000 };
        const client = createClient({ url: config.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
        const st = await collectStatus(config, client);
        expect(st.healthy).toBe(accepted);
        const msg = st.problems.find((p) => p.includes("server version"));
        if (accepted) expect(msg).toBeUndefined();
        else expect(msg).toBe(`server version ${version} is not a tested version (3.5.x, 3.6.x)`);
      } finally {
        srv.stop();
      }
    }
  });

  test("collectStatus: live+replay spool past 8 MB is a problem", async () => {
    const good = miniServer("3.5.0");
    const dir = makeTempDir("obs-collect-");
    try {
      const spool = join(dir, WS, "spool");
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, `${SELF}.jsonl`), "y".repeat(8_100_000));
      const config: Config = {
        enabled: true, url: `http://127.0.0.1:${good.port}/v3`, workspace: WS, peer: SELF,
        observeOthers: false, ownerPeer: "owner", profileWorkspace: null, recordAutomation: true,
        apiKey: "k", stateDir: dir, timeoutMs: 2000 };
      const client = createClient({ url: config.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      const st = await collectStatus(config, client);
      expect(st.healthy).toBe(false);
      expect(st.problems.some((p) => p.includes("8 MB"))).toBe(true);
      expect(st.problems.some((p) => p.includes("3.5.0"))).toBe(false);
    } finally {
      good.stop();
    }
  });
});
