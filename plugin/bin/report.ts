#!/usr/bin/env bun
// v0.5.11 (ADR-0020): the memory report for ONE workspace.
//   bun plugin/bin/report.ts [--rig <name>] [--workspace <ws>] [--state-dir <dir>]
//     [--days <n, default 14>] [--counts-only] [--out <file>]
// Honcho side: loadConfig from the environment like stale-check.ts. Reads
// read-only: the ledger pair, the session total, the conclusion totals per
// seat. Local: the plugin's own log, the outcome log, the stale file and the
// closed-rows file. Writes ONE self-contained HTML page (0600, folder 0700),
// default <state dir>/report/<workspace>.html, and prints its path plus counts.
// Run on purpose (or by the daily timer), never from a hook. No model calls.

import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { fetchLedgerPair } from "../src/reader.ts";
import { toEntries } from "../src/ledger.ts";
import { readClosed } from "../src/closed.ts";
import { outcomesFile, readOutcomeLines, type OutcomeRecord } from "../src/outcomes.ts";
import { readStaleState } from "../src/stale.ts";
import { renderReport } from "../src/report.ts";

const WS_RE = /^[A-Za-z0-9_-]{1,512}$/;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function usage(why: string): never {
  process.stderr.write(`report: ${why}\n`);
  process.exit(2);
}

/** Atomic private write: folder 0700, temp file 0600, rename. */
function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg = loadConfig(process.env);
  if (!cfg.enabled) usage("memory config is missing, invalid or off");
  const ws = flag(argv, "--workspace");
  if (ws !== undefined && !WS_RE.test(ws)) usage("--workspace must match [A-Za-z0-9_-]{1,512}");
  const sd = flag(argv, "--state-dir");
  const config = { ...cfg, ...(ws !== undefined ? { workspace: ws } : {}), ...(sd !== undefined && sd.trim() !== "" ? { stateDir: sd.trim() } : {}) };
  const daysRaw = flag(argv, "--days");
  const days = daysRaw === undefined ? 14 : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 90) usage("--days must be a whole number from 1 to 90");
  const countsOnly = argv.includes("--counts-only");
  const rig = flag(argv, "--rig") ?? config.workspace;
  const out = flag(argv, "--out") ?? join(config.stateDir, "report", `${config.workspace}.html`);

  // local sources
  const logLines: unknown[] = [];
  try {
    for (const line of readFileSync(join(config.stateDir, "log", `${config.workspace}.log`), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        logLines.push(JSON.parse(line));
      } catch {
        /* a damaged line is skipped */
      }
    }
  } catch {
    /* no log yet */
  }
  const outcomes: OutcomeRecord[] = [];
  for (const line of readOutcomeLines(outcomesFile(config.stateDir, config.workspace)).lines) {
    try {
      outcomes.push(JSON.parse(line) as OutcomeRecord);
    } catch {
      /* skipped */
    }
  }
  const st = readStaleState(config.stateDir, config.workspace);
  const closedFile = readClosed(config.stateDir, config.workspace);

  // Honcho, read-only
  const client = createClient({ url: config.url, workspace: config.workspace, apiKey: config.apiKey, timeoutMs: Math.max(config.timeoutMs, 10_000) });
  let ledger = null;
  if (config.leaderPeer !== undefined) {
    const pair = await fetchLedgerPair(client, config.leaderPeer);
    ledger = pair.capped ? null : toEntries(pair.items);
  }
  const sessionsR = await client.listSessions({ size: 1 });
  const conclR = await client.listConclusions({ size: 1 });
  const seats = new Set<string>();
  for (const o of logLines) {
    const p = (o as Record<string, unknown>)?.peer;
    if (typeof p === "string" && p !== "") seats.add(p);
  }
  if (config.leaderPeer !== undefined) seats.add(config.leaderPeer);
  const byObserver: Record<string, number | null> = {};
  for (const s of [...seats].sort()) {
    const r = await client.listConclusions({ filters: { observer_id: s }, size: 1 });
    byObserver[s] = r.ok ? r.data.total : null;
  }
  const html = renderReport({
    rig,
    workspace: config.workspace,
    now: new Date().toISOString(),
    days,
    countsOnly,
    logLines,
    outcomes,
    ledger,
    closed: closedFile,
    stored: { sessions: sessionsR.ok ? sessionsR.data.total : null, conclusions: conclR.ok ? conclR.data.total : null, byObserver },
    stale: st === null ? null : { pending: st.proposals.length, kept: st.kept?.length ?? 0 },
  });
  writeTextAtomic(out, html);
  process.stdout.write(
    `report: ${out}\nlog lines ${logLines.length} | outcome rows ${outcomes.length} | ledger ${ledger === null ? "unreadable" : ledger.length} | seats ${seats.size}${countsOnly ? " | counts only" : ""}\n`,
  );
}

main().catch(() => {
  process.stderr.write("report: failed\n");
  process.exit(1);
});
