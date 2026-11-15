// v0.5.5: status says when the running rig_memory server is older than the
// installed plugin. Found 2026-11-14: every Claude-seat server on both pilots
// still ran pre-v0.5.1 code after four reinstalls, because a running MCP
// server keeps the code it started with. The bin test runs a server from a
// throwaway copy of plugin/, then "reinstalls" under it (bumps the copy's
// plugin.json) and asks for status - exactly the pilot sequence.

import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";
import { staleServerProblem } from "../../plugin/src/mcp.ts";

const REPO = join(import.meta.dir, "..", "..");

describe("v0.5.5 stale rig_memory server", () => {
  test("staleServerProblem: only a known, different installed version is a problem", () => {
    expect(staleServerProblem("0.5.4", "0.5.4")).toBeNull();
    expect(staleServerProblem(null, "0.5.5")).toBeNull();
    expect(staleServerProblem("0.5.4", null)).toBeNull();
    expect(staleServerProblem("0.5.0", "0.5.5")).toContain("running v0.5.0 code but v0.5.5 is installed");
  });

  test("a reinstall under a running server shows in status, unhealthy", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("mcp-stale-");
    const copy = join(dir, "plugin");
    cpSync(join(REPO, "plugin"), copy, { recursive: true });
    const env = { HOME: dir, HONCHO_STATE_DIR: dir, HONCHO_URL: fake.url, HONCHO_WORKSPACE: "ws", HONCHO_PEER: "build", HONCHO_TIMEOUT_MS: "2000" };
    const p = Bun.spawn([process.execPath, join(copy, "bin", "mcp.ts")], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const w = p.stdin as unknown as { write(s: string): void; end(): void };
    const rd = (p.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const next = async (): Promise<Record<string, any>> => {
      for (;;) {
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const l = buf.slice(0, i);
          buf = buf.slice(i + 1);
          return JSON.parse(l);
        }
        const { done, value } = await rd.read();
        if (done) throw new Error("closed");
        buf += dec.decode(value, { stream: true });
      }
    };
    const status = async (id: number): Promise<{ problems: string[]; healthy: boolean }> => {
      w.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "status", arguments: {} } })}\n`);
      const r = await next();
      const t = String(r.result.content[0].text);
      return JSON.parse(t.slice(t.indexOf("\n") + 1));
    };
    try {
      w.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
      await next();
      const before = await status(2);
      expect(before.problems.some((x) => x.includes("rig_memory server is running"))).toBe(false);
      const pj = join(copy, ".claude-plugin", "plugin.json");
      const j = JSON.parse(readFileSync(pj, "utf8"));
      const loaded = j.version;
      writeFileSync(pj, JSON.stringify({ ...j, version: "9.9.9" }));
      const after = await status(3);
      expect(after.problems).toContain(
        `this rig_memory server is running v${loaded} code but v9.9.9 is installed: restart the seat (keeping its conversation) to load it`,
      );
      expect(after.healthy).toBe(false);
    } finally {
      w.end();
      await p.exited;
      await fake.stop();
    }
  });
});
