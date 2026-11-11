#!/usr/bin/env bun
// O1 (ADR-0017 Part A): the outcome collector command for ONE rig.
//   bun plugin/bin/outcomes.ts --rig <name> [--daemon-url <url>]
//     [--state-dir <dir>] [--workspace <ws>] [--rebuild]
// Reads the queue (read-only) and the plugin's own hook log, appends one
// record per closed row to <state-dir>/outcomes/<workspace>.jsonl, and
// prints a per-seat summary of COUNTS ONLY. It never contacts Honcho and
// no hook calls it (decision 4). Like status.ts this bin DOES print - on
// purpose, run by a human or an agent - and prints no content, no ids of
// other rigs' rows beyond the summary counts, and no secrets.
//
// Defaults mirror the installed rig CLI and log.ts: the daemon URL is
// OPENRIG_URL else http://127.0.0.1:7433; the state dir is
// HONCHO_STATE_DIR else $HOME/.openrig-honcho.

import { existsSync } from "node:fs";
import { collectOutcomes, summarize, summaryLines } from "../src/outcomes.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const rig = flag(argv, "--rig");
  if (rig === undefined || rig === "") {
    process.stderr.write("outcomes: --rig <name> is required (the collector is per rig)\n");
    process.exit(2);
  }
  const daemonUrl = (flag(argv, "--daemon-url") ?? process.env.OPENRIG_URL ?? "http://127.0.0.1:7433")
    .trim()
    .replace(/\/+$/, "");
  const envState = (process.env.HONCHO_STATE_DIR ?? "").trim();
  const stateDir =
    flag(argv, "--state-dir") ?? (envState !== "" ? envState : `${process.env.HOME ?? ""}/.openrig-honcho`);
  const workspace = flag(argv, "--workspace");
  const rebuild = argv.includes("--rebuild");

  const r = await collectOutcomes({ daemonUrl, rig, stateDir, ...(workspace !== undefined ? { workspace } : {}), rebuild });
  if ("error" in r) {
    process.stderr.write(`outcomes: ${r.error}\n`);
    process.exit(1);
  }
  for (const line of summaryLines(summarize(r.records))) process.stdout.write(`${line}\n`);
  // F-I (R15 Part 2): a run that wrote nothing (every row rejected) has no
  // file - printing a phantom path contradicts `status`'s "never run".
  const wrote = existsSync(r.file);
  process.stdout.write(
    (wrote ? `file: ${r.file}\n` : "") + `closed rows: ${r.closedRows} | added: ${r.added} | total records: ${r.total}` +
      (r.replaced > 0 ? ` | replaced: ${r.replaced}` : "") +
      (r.daemonFailures > 0 ? ` | rows skipped (daemon ${r.daemonFailures})` : "") +
      // O4 M2: hostile pointer fields skip the row - say how many.
      (r.skippedRows > 0 ? ` | rows skipped (name/pointer shape ${r.skippedRows})` : "") +
      `${rebuild ? " | rebuilt" : ""}\n`,
  );
}

main().catch(() => {
  process.stderr.write("outcomes: failed\n");
  process.exit(1);
});
