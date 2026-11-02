// The rig_memory MCP server entry point (T8, ADR-0004): wires the stdio
// JSON-RPC loop (src/mcp.ts) to the real env contract and client. Kill
// switch: silent, and the server still answers the protocol with an empty
// tool list - a Claude session must start with memory off, not fail to
// start. Bad config: same empty-tools server, plus the one shared config log
// line (review T1 F2). Nothing is ever written to stderr; the protocol loop
// never dies on input.
//
// HONCHO_ASK_TIMEOUT_MS (1..90000, default 90000) sets ONLY the ask tool's
// chat timeout; anything malformed or out of range keeps the default. The
// production value is 90 s per the ADR-0004 amendment (reasoning_level low
// measures 27-50 s on the model server; the old 60 s ceiling truncated real answers).
// The env var exists so tests can exercise the slow-chat path quickly.
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { logConfigProblem } from "../src/log.ts";
import { runStdio, type McpDeps } from "../src/mcp.ts";

function askTimeoutFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = (env.HONCHO_ASK_TIMEOUT_MS ?? "").trim();
  if (raw === "" || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 90_000 ? n : undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  let deps: McpDeps;
  if (!cfg.enabled) {
    if (!isKillSwitch(cfg.reason)) {
      logConfigProblem(process.env, "mcp", cfg.reason);
    }
    deps = { config: null, client: null };
  } else {
    deps = {
      config: cfg,
      client: createClient({
        url: cfg.url,
        workspace: cfg.workspace,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
      }),
      ...(askTimeoutFromEnv(process.env) !== undefined
        ? { askTimeoutMs: askTimeoutFromEnv(process.env) }
        : {}),
      now: () => new Date().toISOString(),
    };
  }
  try {
    await runStdio(deps);
  } catch {
    // the wire died (stdin closed oddly); off-path stays silent (ADR-0001)
  }
  process.exit(0);
}

void main();
