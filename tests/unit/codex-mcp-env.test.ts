// C5j (L1 live finding): Codex starts a stdio MCP server with ONLY its
// DEFAULT_ENV_VARS plus the names the server entry forwards (rust-v0.167.0
// rmcp-client/src/utils.rs:16-25 and :163) - on the live seat
// OPENRIG_SESSION_NAME/OPENRIG_URL never reached bin/mcp.ts (_config.log
// 12:30:15Z: "mcp: HONCHO_PEER is required (or set OPENRIG_SESSION_NAME)").
// These tests start the bins exactly the way Codex does: DEFAULT_ENV_VARS
// only, plus or minus the two forwarded names, the seat config living ONLY
// in the settings file. Same style for bin/status.ts, which before C5j read
// no settings and printed memory: DISABLED on a Codex seat. Local temp +
// fake server only; the ws name still comes from scratchName().

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { scratchName } from "../support/scratch.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const BUN = process.execPath;
const MCP = join(REPO, "plugin/bin/mcp.ts");
const STATUS = join(REPO, "plugin/bin/status.ts");

// the exact list Codex keeps by default (config default + entry env_vars
// are the ONLY sources; we pass nothing else, so a leak of real
// HONCHO_*/OPENRIG_* from this seat would show up as a false pass)
const DEFAULT_ENV_VARS = ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];

function codexLikeEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of DEFAULT_ENV_VARS) env[k] = k === "HOME" || k === "TMPDIR" ? home : "probe";
  env.PATH = "/usr/bin:/bin";
  return env;
}

function mkSeat(fake: FakeHoncho): { home: string; settings: string; env: Record<string, string> } {
  const home = makeTempDir("c5j-home-"); // settings live under the SEAT, not HOME
  const seat = makeTempDir("c5j-seat-");
  const dir = join(seat, ".codex", "openrig-honcho");
  mkdirSync(dir, { recursive: true });
  const settings = join(dir, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({ HONCHO_URL: fake.url, HONCHO_WORKSPACE: scratchName() }), // no HONCHO_PEER: on Codex the peer IS OPENRIG_SESSION_NAME
    { mode: 0o600 },
  );
  return { home, settings, env: codexLikeEnv(home) };
}

type Frame = Record<string, unknown>;
function startRpc(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn(cmd, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const rd = (p.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
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
  const write = (s: string): void => {
    (p.stdin as unknown as { write(data: string): void }).write(s);
  };
  const rpc = async (id: number, method: string, params?: unknown): Promise<Record<string, any>> => {
    write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    const l = await nextLine();
    expect(l, `no reply to ${method}`).not.toBeNull();
    return JSON.parse(l as string);
  };
  return {
    p,
    rpc,
    close: async (): Promise<number> => {
      (p.stdin as unknown as { end(): void }).end();
      return p.exited;
    },
  };
}

describe("C5j: the MCP server started Codex-style, with and without the forwarded names", () => {
  test("DEFAULT_ENV_VARS + the two forwarded names + settings file: tools/list works", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    const f = mkSeat(fake);
    const h = startRpc([BUN, MCP, "--harness", "codex", "--settings", f.settings], {
      ...f.env,
      OPENRIG_SESSION_NAME: "seat-a", // the only peer source on a real seat
      OPENRIG_URL: "http://127.0.0.1:9", // forwarded like the block now lists
    });
    try {
      const r = await h.rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      expect(r.result.serverInfo.name).toBe("rig_memory");
      const list = await h.rpc(2, "tools/list");
      const names = (list.result.tools as { name: string }[]).map((t) => t.name);
      expect(names).toEqual(["ask", "search", "mission", "status"]); // the enabled non-leader list
    } finally {
      expect(await h.close()).toBe(0);
      await fake.stop();
    }
  });

  test("without the forwarded names: the exact live failure - empty tools, exit 0, silent stderr", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    const f = mkSeat(fake);
    const h = startRpc([BUN, MCP, "--harness", "codex", "--settings", f.settings], f.env); // nothing forwarded
    try {
      await h.rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      const list = await h.rpc(2, "tools/list");
      expect((list.result.tools as unknown[]).length).toBe(0); // config off: no tools
    } finally {
      expect(await h.close()).toBe(0);
      await fake.stop();
    }
  });

});

describe("C5j: bin/status.ts reads the settings file the same way", () => {
  async function runStatus(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
    const p = Bun.spawn([BUN, STATUS, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout as ReadableStream).text()]);
    return { code, out };
  }

  test("with --settings and no HONCHO env: the config loads - memory OK, exit 0", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    const f = mkSeat(fake);
    // the peer still comes from the seat's own OPENRIG_SESSION_NAME (the
    // seat prints this command INTO that seat's terminal); no HONCHO_* here
    const r = await runStatus(["--harness", "codex", "--settings", f.settings], {
      ...f.env,
      OPENRIG_SESSION_NAME: "seat-a",
    });
    await fake.stop();
    expect(r.out).not.toContain("DISABLED"); // the exact pre-C5j symptom
    expect(r.out).toContain(`config: ${new URL(fake.url).host}`); // the URL came from the FILE
    expect(r.out).toContain("server: reachable");
    expect(r.code).toBe(0);
  });

  test("without --settings on a Codex seat: still DISABLED - the finding, pinned honest", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    const f = mkSeat(fake);
    const r = await runStatus([], f.env);
    await fake.stop();
    expect(r.out).toContain("memory: DISABLED");
    expect(r.code).toBe(1);
  });
});
