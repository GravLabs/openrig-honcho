// O3 (ADR-0006): `rig`-side health check for one seat's memory.
//   plugin/bin/status.ts [--json]
// Prints counters + the last structured log lines (projections only, never
// raw lines or secrets - F-T8-4). Exit code: 1 when unhealthy - config
// disabled, server unreachable, server version not the expected 3.4.0, or
// live+replay spool past 80% of its 10 MB budget; 0 otherwise. Unlike the
// hooks this bin DOES print (it is run by a human or an agent on purpose),
// but never the kill-switch reason and never the API key.
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { logConfigProblem } from "../src/log.ts";
import { collectStatus, type StatusReport } from "../src/status.ts";

function humanLines(st: StatusReport): string[] {
  const s = st.server;
  const c = st.counters;
  const sp = (v: { bytes: number; lines: number } | { error: string }): string =>
    "bytes" in v ? `${v.bytes} B/${v.lines} l` : v.error;
  const lines = [
    `memory: ${st.healthy ? "OK" : "UNHEALTHY"}`,
    `config: ${st.config.host} ws=${st.config.workspace} peer=${st.config.peer}` +
      ` leader=${st.config.leader ?? "-"} profile=${st.config.profile_workspace ?? "-"}`,
    `server: ${s.reachable ? `reachable ${s.version ?? "?"}` : `unreachable (${s.error_class ?? "?"})`}`,
    `mission: ${st.session.mission} session: ${st.session.session ?? "-"}`,
    `counters: written ${c.written} failed ${c.failed} spooled ${c.spooled}` +
      ` replayed ${c.replayed} dropped ${c.dropped} dead ${c.dead} sanitized ${c.sanitized}`,
    `redactions: ${Object.entries(c.redactions).map(([k, n]) => `${k}=${n}`).join(" ") || "none"}`,
    `last error: ${st.last_error_class ?? "none"}${st.last_error_at ? ` at ${st.last_error_at}` : ""}`,
    `spool: live ${sp(st.spool.live)} replay ${sp(st.spool.replay)} dead ${sp(st.spool.dead)}`,
  ];
  if (st.problems.length > 0) lines.push(`problems: ${st.problems.join("; ")}`);
  for (const l of st.log_tail) {
    lines.push(`log: ${l.ts} ${l.hook} ${l.event} ok=${l.ok ? "yes" : "no"}${l.error_class ? ` ${l.error_class}` : ""}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const cfg = loadConfig(process.env);
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
  try {
    const st = await collectStatus(cfg, client);
    if (json) process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
    else process.stdout.write(`${humanLines(st).join("\n")}\n`);
    process.exit(st.healthy ? 0 : 1);
  } catch {
    // a status tool that itself throws must still answer with the exit code
    if (json) process.stdout.write(`${JSON.stringify({ enabled: true, healthy: false, problems: ["status check failed"] })}\n`);
    else process.stdout.write("memory: UNHEALTHY (status check failed)\n");
    process.exit(1);
  }
}

void main();
