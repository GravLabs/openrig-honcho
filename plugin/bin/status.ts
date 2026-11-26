// O3 (ADR-0006): `rig`-side health check for one seat's memory.
//   plugin/bin/status.ts [--json]
//   plugin/bin/status.ts --harness codex --settings <path> [--json]  (C5j)
// Prints counters + the last structured log lines (projections only, never
// raw lines or secrets - F-T8-4). Exit code: 1 when unhealthy - config
// disabled, server unreachable, server version off the tested lines (3.5.x,
// 3.6.x - O9), or
// live+replay spool past 80% of its 10 MB budget; 0 otherwise. Unlike the
// hooks this bin DOES print (it is run by a human or an agent on purpose),
// but never the kill-switch reason and never the API key.
// C5j (L1 live finding): a Codex seat's config lives ONLY in its settings
// file, so the CLI needs the same --settings handling as mcp.ts - without
// it status on a Codex seat read no config and printed memory: DISABLED.
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { logConfigProblem } from "../src/log.ts";
import { autoMemoryState, collectStatus, type AutoMemoryState, type StatusReport } from "../src/status.ts";
import { resolveHarness } from "../src/harness.ts";
import { harnessUnknownWithSettings, readSettingsFile, settingsPath } from "../src/settings.ts";
import { findHookCoverage, type HookCoverage } from "../src/hookCoverage.ts";
import { isAbsolute, join, resolve } from "node:path";

// ADR-0021 decision 2: a seat whose config works but whose hooks never fire
// records nothing and is shown no memory - the plain-folder pods/ finding. Missing
// hooks make the seat unhealthy.
function humanLines(
  st: StatusReport,
  hooks: HookCoverage,
  auto: AutoMemoryState,
  harness: string,
  seatFolder: string,
): string[] {
  const s = st.server;
  const c = st.counters;
  const healthy = st.healthy && hooks.present;
  const sp = (v: { bytes: number; lines: number } | { error: string }): string =>
    "bytes" in v ? `${v.bytes} B/${v.lines} l` : v.error;
  const lines = [
    `memory: ${healthy ? "OK" : "UNHEALTHY"}`,
    hooks.present
      ? hooks.from !== undefined
        ? `hooks: ok - hooks come from ${hooks.from}` // F-B: a legitimate hook-skipped seat (Codex ancestor layer)
        : "hooks: ok"
      : `hooks: missing - this seat records nothing and is shown no memory; run the install in ${seatFolder}`,
    // ADR-0021 decision 6: informational - on does NOT make the seat unhealthy.
    // Codex has no equivalent on by default (probed 2026-11-26: features
    // memories=false), so the line says the key means nothing there.
    `auto-memory: ${harness === "codex"
      ? "n/a - Codex seat: no Claude auto-memory, and Codex memory is off by default"
      : auto.off ? `off - ${auto.detail}` : `on - ${auto.detail}`}`,
    `config: ${st.config.host} ws=${st.config.workspace} peer=${st.config.peer}` +
      ` leader=${st.config.leader ?? "-"} profile=${st.config.profile_workspace ?? "-"}`,
    `server: ${s.reachable ? `reachable ${s.version ?? "?"}` : `unreachable (${s.error_class ?? "?"})`}`,
    `mission: ${st.session.mission} session: ${st.session.session ?? "-"}`,
    `counters: written ${c.written} failed ${c.failed} spooled ${c.spooled}` +
      ` replayed ${c.replayed} dropped ${c.dropped} dead ${c.dead} sanitized ${c.sanitized}`,
    `redactions: ${Object.entries(c.redactions).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`,
    `last error: ${st.last_error_class ?? "none"}${st.last_error_at ? ` at ${st.last_error_at}` : ""}`,
    `spool: live ${sp(st.spool.live)} replay ${sp(st.spool.replay)} dead ${sp(st.spool.dead)}`,
    // O3 item 4 (ADR-0017 decision 4): the outcome collector runs on demand
    `outcomes: ${st.outcomes.last_run_at === null ? "never run" : `last run ${st.outcomes.last_run_at}, ${st.outcomes.records} records`}`,
  ];
  if (st.problems.length > 0) lines.push(`problems: ${st.problems.join("; ")}`);
  for (const l of st.log_tail) {
    lines.push(`log: ${l.ts} ${l.hook} ${l.event} ok=${l.ok ? "yes" : "no"}${l.error_class ? ` ${l.error_class}` : ""}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  // C5j: same Codex settings-file handling as mcp.ts - merge UNDER the
  // environment (env wins), a broken file or an unresolved --harness next
  // to --settings IS the cause and takes the disabled path below.
  const { harness, flagUnknown } = resolveHarness(process.argv.slice(2));
  let env: Record<string, string | undefined> = process.env;
  let problem: string | null = null;
  if (harness === "codex") {
    const s = readSettingsFile(process.argv.slice(2));
    if (s.problem !== null) problem = s.problem;
    else env = { ...s.vars, ...process.env };
  }
  if (problem === null) problem = harnessUnknownWithSettings(process.argv.slice(2), flagUnknown);
  const cfg = problem === null ? loadConfig(env) : { enabled: false as const, reason: problem };
  if (!cfg.enabled) {
    // the kill switch reason is never printed or logged (review T1 F2); a
    // broken config still gets its one shared config-log line
    if (!isKillSwitch(cfg.reason)) logConfigProblem(process.env, "status", cfg.reason);
    if (json) process.stdout.write(`${JSON.stringify({ enabled: false, healthy: false, problems: ["memory disabled"] })}\n`);
    else process.stdout.write("memory: DISABLED (config missing, invalid, or off)\n");
    process.exit(1);
  }
  const client = createClient({
    url: cfg.url,
    workspace: cfg.workspace,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  });
  // ADR-0021 decision 2: do our hooks actually run for this folder?
  const seatSettings = harness === "codex" ? settingsPath(process.argv.slice(2)) : null;
  const hooks = findHookCoverage({
    cwd: process.cwd(),
    home: process.env.HOME ?? "",
    harness,
    settingsPath:
      seatSettings !== null && seatSettings !== ""
        ? isAbsolute(seatSettings)
          ? seatSettings
          : resolve(seatSettings)
        : null,
    // F-B: the ancestor scan needs the root markers, read exactly as the
    // installer reads them (config.toml beside the seat's Codex home).
    ...(harness === "codex"
      ? { codexHome: process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex") }
      : {}),
    // item 5: plugin mode - this process's CLAUDE_PLUGIN_ROOT, when set.
    pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null,
  });
  try {
    const st = await collectStatus(cfg, client);
    const healthy = st.healthy && hooks.present;
    // ADR-0021 d6, not a health signal; N-R26-3: Claude's own precedence
    const auto = autoMemoryState(process.cwd(), process.env.HOME ?? "");
    if (json) process.stdout.write(`${JSON.stringify({ ...st, healthy, hooks, auto_memory: auto }, null, 2)}\n`);
    else process.stdout.write(`${humanLines(st, hooks, auto, harness, process.cwd()).join("\n")}\n`);
    process.exit(healthy ? 0 : 1);
  } catch {
    // a status tool that itself throws must still answer with the exit code
    if (json) process.stdout.write(`${JSON.stringify({ enabled: true, healthy: false, problems: ["status check failed"] })}\n`);
    else process.stdout.write("memory: UNHEALTHY (status check failed)\n");
    process.exit(1);
  }
}

void main();
