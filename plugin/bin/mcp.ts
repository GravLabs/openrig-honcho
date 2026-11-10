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
// C5a (ADR-0016 decision 9): a Codex server run names its owned settings
// file; --harness is accepted so the run resolves as codex, and the file's
// values merge under the environment like every other Codex entry point.
import { resolveHarness } from "../src/harness.ts";
import { harnessUnknownWithSettings, readSettingsFile } from "../src/settings.ts";

function askTimeoutFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = (env.HONCHO_ASK_TIMEOUT_MS ?? "").trim();
  if (raw === "" || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= 90_000 ? n : undefined;
}

async function main(): Promise<void> {
  // C5a: Codex-only merge of the settings file UNDER the environment (env
  // wins). A broken file keeps the server exactly as today's bad-config path:
  // empty tools + one _config.log line (the problem token, never a value).
  const { harness, flagUnknown } = resolveHarness(process.argv.slice(2));
  let env: Record<string, string | undefined> = process.env;
  let problem: string | null = null;
  if (harness === "codex") {
    const s = readSettingsFile(process.argv.slice(2));
    if (s.problem !== null) problem = s.problem;
    else env = { ...s.vars, ...process.env };
  }
  // C5a2 (review O2): an unresolved --harness next to --settings IS the
  // cause; the disabled path below logs it instead of blaming the URL.
  if (problem === null) problem = harnessUnknownWithSettings(process.argv.slice(2), flagUnknown);
  const cfg = problem === null ? loadConfig(env) : { enabled: false as const, reason: problem };
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
      // C5a: the ask timeout reads the MERGED env too - a HONCHO_* value in
      // the settings file must work the same as a real variable.
      ...(askTimeoutFromEnv(env) !== undefined
        ? { askTimeoutMs: askTimeoutFromEnv(env) }
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
