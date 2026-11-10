// F11 (C5f): Codex Stop gets ONE 20 s budget for the whole hook, because
// HONCHO_TIMEOUT_MS bounds each REQUEST and one Stop makes two sequential
// requests (measured before the fix: 20000 -> 40 s, 60000 -> 120 s, and
// Codex killed the sync hook mid-write at its 30 s timeout). With the
// budget, a server that accepts and NEVER ANSWERS ends the run exactly like
// a dead server: exit 0, the reply spooled, under the brief's 25 s bar.
// The one event line carries budget_cut (F14, C5g): the requests that
// FAILED on a budget-reduced timeout - a reduction that still answered is
// health, not a cut (reviewer case b4 pinned below). The Claude line keeps
// its pre-C5f shape: no budget fields. Local fake only - no server is ever
// contacted, and the ws name still comes from scratchName().

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { scratchName } from "../support/scratch.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/stop.ts");
const BUN = process.execPath;

/** a local server that accepts and never answers: the promise never settles */
const neverServer = () => Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });

const url3 = (u: URL): string => `${u.toString().replace(/\/+$/, "")}/v3`;

async function runStop(
  harness: "codex" | "claude",
  url: string,
  ws: string,
  stateDir: string,
  timeoutMs: string,
): Promise<{ code: number; out: string; err: string; wall: number; ev: any }> {
  const env: Record<string, string> = {
    ...process.env,
    HONCHO_URL: url,
    HONCHO_WORKSPACE: ws,
    HONCHO_PEER: "seat-a",
    HONCHO_STATE_DIR: stateDir,
    HONCHO_TIMEOUT_MS: timeoutMs,
  };
  const proc = Bun.spawn([BUN, BIN, ...(harness === "codex" ? ["--harness", "codex"] : [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(
    JSON.stringify({
      session_id: "s1",
      turn_id: "t1",
      last_assistant_message: "a PLANTED reply",
      stop_hook_active: false,
    }),
  );
  proc.stdin.end();
  const t0 = Date.now();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const wall = Date.now() - t0;
  const logFile = join(stateDir, "log", `${ws}.log`);
  const lines = existsSync(logFile)
    ? readFileSync(logFile, "utf8").trim().split("\n").filter((l) => l !== "")
    : [];
  return { code, out, err, wall, ev: lines.length > 0 ? JSON.parse(lines[lines.length - 1]!) : null };
}

describe("F11: the Codex Stop budget against a server that never answers", () => {
  test(
    "codex: exit 0 under 25 s with HONCHO_TIMEOUT_MS 60000, reply spooled, the event line counts clamps",
    async () => {
      const server = neverServer();
      const ws = scratchName();
      const stateDir = makeTempDir("stop-deadline-");
      const r = await runStop("codex", url3(server.url), ws, stateDir, "60000");
      server.stop();
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      expect(r.wall, `wall=${r.wall}ms`).toBeLessThan(25_000); // the brief's bar
      // the message is spooled exactly like the dead-server path
      const spoolDir = join(stateDir, ws, "spool");
      expect(readdirSync(spoolDir)).toContain("seat-a.jsonl");
      expect(readFileSync(join(spoolDir, "seat-a.jsonl"), "utf8")).toContain("a PLANTED reply");
      // the ONE event line carries the budget and counts the cut-short calls
      expect(r.ev).not.toBe(null);
      expect(r.ev.hook).toBe("stop");
      expect(r.ev.event).toBe("spooled");
      expect(r.ev.stop_budget_ms).toBe(20_000);
      expect(r.ev.budget_cut).toBeGreaterThanOrEqual(1);
      expect(r.ev.error_class).toBe("timeout");
    },
    45_000,
  );

  test(
    "F14/b4: HONCHO_TIMEOUT_MS 20000 with a 4 s answering server: reductions happen, budget_cut stays 0",
    async () => {
      const fake = await startFakeHoncho();
      fake.mode("slow", { delayMs: 4_000 }); // answers every request after 4 s
      const ws = scratchName();
      const stateDir = makeTempDir("stop-b4-");
      const r = await runStop("codex", fake.url, ws, stateDir, "20000");
      await fake.stop();
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      // the budget DID reduce both timeouts (19.5 s < 20 s) - and both
      // requests answered in 4 s: wall about 8 s, nothing cut short.
      expect(r.wall, `wall=${r.wall}ms`).toBeLessThan(20_000);
      expect(r.ev).not.toBe(null);
      expect(r.ev.event).toBe("sent");
      expect(r.ev.stop_budget_ms).toBe(20_000);
      expect(r.ev.budget_cut).toBe(0);
    },
    35_000,
  );

  test(
    "claude: no budget fields - the event line keeps its pre-C5f shape",
    async () => {
      const server = neverServer();
      const ws = scratchName();
      const stateDir = makeTempDir("stop-deadline-claude-");
      // a per-request 3 s timeout: the run ends on the plain request
      // timeout, no deadline exists on this path at all.
      const r = await runStop("claude", url3(server.url), ws, stateDir, "3000");
      server.stop();
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      expect(r.ev).not.toBe(null);
      expect(r.ev.event).toBe("spooled");
      expect(r.ev.stop_budget_ms).toBeUndefined();
      expect(r.ev.budget_cut).toBeUndefined();
    },
    20_000,
  );
});
