// O3 (ADR-0006): the "is memory working?" report, shared by the status MCP
// tool and plugin/bin/status.ts. It reports facts an operator can act on:
// config (never the API key), server reachability + version, the seat's
// mission/session, the O2 counters, spool sizes, the last failure CLASS, and
// the last few structured log lines. F-T8-4 (ruling 2026-10-28 19:12Z): raw
// log lines and raw error strings are NEVER re-served - failures leave as
// error_class only (X1: no secrets, no echoed content).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./env.ts";
import type { HonchoClient } from "./honcho.ts";
import { readLogTail } from "./log.ts";
import { normalizeMission, readRigMission, readSeatState, seatStatePath } from "./missions.ts";
import { statsFrom, type SeatStats } from "./stats.ts";

/** The Honcho server version this plugin is built against (ADR-0006 O3). */
export const EXPECTED_VERSION = "3.5.0";

/** Unhealthy when live + replay spool pass 80% of their combined 10 MB. */
export const SPOOL_UNHEALTHY_BYTES = 8_000_000;

export interface StatusReport {
  config: {
    host: string;
    workspace: string;
    peer: string;
    leader: string | null;
    profile_workspace: string | null;
  };
  server: { reachable: boolean; version: string | null; error_class?: string };
  session: { mission: string; session: string | null };
  counters: SeatStats;
  spool: {
    live: { bytes: number; lines: number } | { error: string };
    replay: { bytes: number; lines: number } | { error: string };
    dead: { bytes: number; lines: number } | { error: string };
  };
  last_error_at: string | null;
  last_error_class: string | null;
  queue: unknown;
  log_tail: { ts: string; hook: string; event: string; ok: boolean; error_class?: string }[];
  problems: string[];
  healthy: boolean;
}

/** bytes + line count of a spool file (absent = zeros; unreadable = marker). */
function spoolStat(file: string): { bytes: number; lines: number } | { error: string } {
  try {
    if (!existsSync(file)) return { bytes: 0, lines: 0 };
    const bytes = statSync(file).size;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length;
    return { bytes, lines };
  } catch {
    // F-T8-4: even the read failure leaves as a class, not String(e)
    return { error: "unreadable" };
  }
}

const spoolBytes = (s: { bytes: number; lines: number } | { error: string }): number =>
  "bytes" in s ? s.bytes : 0;

/** A fetch failure's shape, never its text (a fetch TypeError can carry the URL). */
function fetchErrorClass(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
    if (e.name === "TypeError") return "connect";
  }
  return "other";
}

/**
 * Full report for an ENABLED config. Never throws: every section degrades to
 * its own error shape, and `problems` lists what makes this seat unhealthy
 * (the bin turns that into the exit code).
 */
export async function collectStatus(config: Config, client: HonchoClient): Promise<StatusReport> {
  const problems: string[] = [];

  let host: string;
  try {
    host = new URL(config.url).host;
  } catch {
    host = "?";
  }
  const report: StatusReport = {
    config: {
      host,
      workspace: config.workspace,
      peer: config.peer,
      leader: config.leaderPeer ?? null,
      profile_workspace: config.profileWorkspace,
      // the API key is never reported (E10)
    },
    server: { reachable: false, version: null },
    session: { mission: "general", session: null },
    counters: statsFrom(null),
    spool: { live: { bytes: 0, lines: 0 }, replay: { bytes: 0, lines: 0 }, dead: { bytes: 0, lines: 0 } },
    last_error_at: null,
    last_error_class: null,
    queue: null,
    log_tail: [],
    problems,
    healthy: true,
  };

  // server reachable + version: openapi.json sits at the ORIGIN (probed
  // 2026-10-28: http://host:8002/openapi.json, not under /v3)
  try {
    const origin = config.url.replace(/\/v3\/?$/, "");
    const resp = await fetch(`${origin}/openapi.json`, { signal: AbortSignal.timeout(3000) });
    let version: string | null = null;
    try {
      const doc = (await resp.json()) as { info?: { version?: string } };
      version = typeof doc?.info?.version === "string" ? doc.info.version : null;
    } catch {
      version = null;
    }
    report.server = { reachable: resp.ok, version };
  } catch (e) {
    report.server = { reachable: false, version: null, error_class: fetchErrorClass(e) };
  }
  if (!report.server.reachable) problems.push("server unreachable");
  else {
    const v = report.server.version;
    if (typeof v !== "string" || !v.endsWith(EXPECTED_VERSION)) {
      problems.push(`server version ${v ?? "unknown"} is not ${EXPECTED_VERSION}`);
    }
  }

  try {
    const seat = readSeatState(seatStatePath(config.stateDir, config.workspace, config.peer));
    report.session = {
      mission:
        seat?.mission ??
        normalizeMission(readRigMission(config.stateDir, config.workspace).mission),
      session: seat?.session ?? null, // null until a hook or remember first resolves one
    };
    report.counters = statsFrom(seat);
    // from the sanitised view only - never from the raw seat file (F-T8-4)
    report.last_error_at = report.counters.last_error_at ?? null;
    report.last_error_class = report.counters.last_error_class ?? null;
  } catch {
    report.session = { mission: "unknown", session: null };
  }

  const dir = join(config.stateDir, config.workspace, "spool");
  report.spool = {
    live: spoolStat(join(dir, `${config.peer}.jsonl`)),
    replay: spoolStat(join(dir, `${config.peer}.replay.jsonl`)),
    dead: spoolStat(join(dir, `${config.peer}.dead.jsonl`)),
  };
  if (spoolBytes(report.spool.live) + spoolBytes(report.spool.replay) > SPOOL_UNHEALTHY_BYTES) {
    problems.push("spool above 8 MB (80% of 10 MB)");
  }

  report.log_tail = readLogTail(config, 5);

  try {
    const q = await client.queueStatus();
    report.queue = q.ok ? q.data : { error_class: q.kind };
  } catch {
    report.queue = { error_class: "other" };
  }

  report.healthy = problems.length === 0;
  return report;
}
