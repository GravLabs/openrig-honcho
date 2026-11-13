#!/usr/bin/env bun
// V4 (ADR-0019 decision 4): the ON-DEMAND stale-proposal checker. Never
// called from a hook (the ADR rule - it calls a model). Run by a human or an
// agent on purpose, like outcomes.ts.
//   bun plugin/bin/stale-check.ts --url <OpenAI-compatible base, e.g.
//     http://host:port/v1> --model <name> --key-env <NAME>
//     [--workspace <ws>] [--state-dir <dir>] [--timeout-ms <n>]
// Honcho side: loadConfig from the environment like status.ts (--workspace /
// --state-dir override the resolved values). The model API key is read ONLY
// from process.env[<NAME>]: never printed, logged, stored or echoed in an
// error; an unset variable refuses the run. Reads the ledger read-only
// (fetchLedgerPair), computes in force with ledger.ts, and stores proposals
// plus rule-or-state classes in one local 0600 file. Prints COUNTS only.

import { loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { fetchLedgerPair } from "../src/reader.ts";
import { runStaleCheck, type ModelTarget } from "../src/stale.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const WS_RE = /^[A-Za-z0-9_-]{1,512}$/;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = flag(argv, "--url");
  const model = flag(argv, "--model");
  const keyEnv = flag(argv, "--key-env");
  const usage = (why: string): never => {
    process.stderr.write(`stale-check: ${why}\nusage: stale-check --url <base-url/v1> --model <name> --key-env <ENVVAR> [--workspace <ws>] [--state-dir <dir>] [--timeout-ms <n>]\n`);
    process.exit(2);
  };
  if (url === undefined || !/^https?:\/\//.test(url)) usage("--url <OpenAI-compatible base, e.g. http://host:port/v1> is required");
  if (model === undefined || model.trim() === "") usage("--model <name> is required");
  if (keyEnv === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) usage("--key-env must name an environment variable");
  const timeoutRaw = flag(argv, "--timeout-ms");
  let timeoutMs = 120000; // per model call; the eval allowed far more, a stuck local call should not hang the runner
  if (timeoutRaw !== undefined) {
    const n = Number(timeoutRaw);
    if (!Number.isFinite(n) || n < 1000) usage("--timeout-ms must be a number >= 1000");
    timeoutMs = n;
  }

  // the key: this one variable, this run only - never printed, stored or logged
  const key = (process.env[keyEnv] ?? "").trim();
  if (key === "") {
    process.stderr.write(`stale-check: the environment variable named by --key-env (${keyEnv}) is unset or empty; refusing\n`);
    process.exit(1);
  }

  const cfg = loadConfig(process.env);
  if (!cfg.enabled) {
    process.stderr.write("stale-check: memory config is missing, invalid or off; refusing\n");
    process.exit(1);
  }
  const ws = flag(argv, "--workspace");
  const sd = flag(argv, "--state-dir");
  if (ws !== undefined && !WS_RE.test(ws)) usage("--workspace must match [A-Za-z0-9_-]{1,512}");
  const config = {
    ...cfg,
    ...(ws !== undefined ? { workspace: ws } : {}),
    ...(sd !== undefined && sd.trim() !== "" ? { stateDir: sd.trim() } : {}),
  };
  if (config.leaderPeer === undefined) {
    process.stderr.write("stale-check: HONCHO_LEADER_PEER is unset, so the ledger has no known owner to read; refusing\n");
    process.exit(1);
  }

  const client = createClient({
    url: config.url,
    workspace: config.workspace,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
  const pair = await fetchLedgerPair(client, config.leaderPeer);
  if (pair.capped) {
    // a partial ledger read could mis-age candidates and the resumable
    // lastCheckedAt would then skip entries that were never seen: refuse.
    process.stderr.write("stale-check: the ledger read was partial; run again when the server answers completely\n");
    process.exit(1);
  }
  const target: ModelTarget = { url, model: model.trim(), key, timeoutMs };
  const r = await runStaleCheck(config, target, pair.items);
  if (r.error !== undefined) {
    process.stderr.write(`stale-check: ${r.error}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `entries classified: ${r.classified} | entries checked: ${r.checked} | proposals added: ${r.added} | model seconds: ${r.modelSeconds}\n`,
  );
}

main().catch(() => {
  // never a stack (it could carry an embedded value): one honest line
  process.stderr.write("stale-check: failed\n");
  process.exit(1);
});
