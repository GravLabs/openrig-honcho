// T20 (ADR-0013 decision 4, ADR-0014 Tests; row qitem-20261105010929-...):
// the scenario runner. End to end with the REAL local model: each run is a
// throwaway headless Claude Code session (`claude -p`) with the plugin's
// SessionStart hook active, against a FRESH scratch workspace (deriver off,
// deleted afterwards - the only server surface this touches) and a FAKE
// OpenRig daemon (loopback Bun.serve) answering the queue list. Memory arm =
// the continuity digest on/off (`HONCHO_DIGEST`), scenarios A and B per the
// row. Sequential: the local model serves at most 3 and other seats use it.
//
// Auth (architect 01:21Z): the settings file is passed IN PLACE via
// --settings and never read, copied, printed or logged here; ANTHROPIC_* is
// stripped from the child env so nothing shadows it; the reply envelope's
// modelUsage names the model that answered and goes into the report.
//
// T20b (row qitem-20261105163141-6d63503dd79bce71) redesigned scenario B so
// the control can fail. The gate lives IN the open qitem (GATE_B, the line
// the digest shows); the prompt is NEUTRAL and demands a fixed first word;
// three arms, digest ON throughout:
//   publish      - approval scoped to the open qitem  -> expected PUBLISH
//   no-approval  - nothing seeded, THE control        -> expected WAIT
//   other-scope  - approval scoped to a DIFFERENT qitem -> expected WAIT
//                  (the digest leaves it under "Decisions in force", label
//                  approval, no scope shown - the arm tests whether the seat
//                  still holds back on that presentation)
// CONTROL GATE (row): the control arm runs FIRST, N=3. If most of those say
// PUBLISH the design still cannot fail - STOP and report, do not spend the
// shared model on the rest. Full B run after a passed gate: 15 sessions;
// A's two arms (x n) are unchanged and run only with --scen all|A.
//
// Run: bun run scenario [--dry] [--n <runsPerArm>] [--scen A|B|all] [--t20c]
// `--t20c` = the T20c rerun only: other-scope x5 (must now WAIT), then
// publish x3 (must still PUBLISH); no control gate, no A arms.
// `--dry` = ONE run (A, digest on) and it prints the raw reply for pinning;
// the full run records only counts/verdicts in the report - model output is
// NOT written to the report or to anything committed.
// scenario-report.json is git-ignored at the repo root.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../plugin/src/env.ts";
import { handleLine } from "../plugin/src/mcp.ts";
import {
  PROMPT_A,
  PROMPT_B,
  SCENARIO_MODEL,
  SCENARIO_SETTINGS,
  childEnv,
  fixtureQid,
  openWorkRowA,
  openWorkRowB,
  otherQid,
  plainSeedForB,
  preconditionMiss,
  requireScenarioEnv,
  seedFixture,
  seedForB,
  startFakeDaemon,
  verdictA,
  verdictB,
  type BArm,
  type Verdict,
} from "./scenario-core.ts";
import { scratchClient, scratchWorkspace, type Scratch } from "../tests/support/scratch.ts";

const REPO = join(import.meta.dir, "..");
const CLAUDE_BIN = Bun.which("claude") ?? "claude";
/** 2026-11-05 measurement: the shared local model queued a single hello for
 * 30-47 s under load and once exceeded 240 s entirely - the watchdog must
 * outlast host congestion, not the scenario. */
const SESSION_TIMEOUT_MS = 420_000;
const REPORT_PATH = join(REPO, "scenario-report.json");

type Scenario = "A" | "B";
type Arm = "digest-on" | "digest-off" | BArm;

interface RunRecord {
  scenario: Scenario;
  arm: Arm;
  run: number;
  qid: string;
  session: string;
  wallMs: number;
  model: string;
  blockBytes: number; // the session-start event's bytes: injected block size
  digestFields: Record<string, unknown>; // n_open / n_decisions / n_approvals...
  verdict: Verdict;
  harnessError?: string; // non-model failure: missing hook event, bad envelope...
  invalid?: string; // T24 guard (architect 01:45Z): seeded counts not visible in the digest - the run proves NOTHING (neither PASS nor FAIL)
  deleteAccepted?: boolean; // scratch workspace DELETE accepted by the server
  note?: string; // arm meaning where it is not the headline (B/digest-off)
}

const mkConfig = (
  ws: string,
  stateDir: string,
  daemonPort: number,
  sessionName: string,
): Config => ({
  enabled: true,
  url: process.env.HONCHO_URL ?? "http://localhost:8000/v3",
  workspace: ws,
  peer: "build",
  observeOthers: false,
  ownerPeer: "owner",
  profileWorkspace: null,
  recordAutomation: true,
  apiKey: process.env.HONCHO_API_KEY ?? "local",
  stateDir,
  timeoutMs: 10_000,
  leaderPeer: "build",
  digest: true,
  daemonUrl: `http://127.0.0.1:${daemonPort}`,
  sessionName,
});

/** remember through the plugin's own MCP path (the digest integration test's
 * pattern) - never a hand-written server write. */
async function seedRemember(cfg: Config, client: ReturnType<typeof scratchClient>, args: Record<string, unknown>): Promise<void> {
  const line = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "remember", arguments: args },
    }),
    { config: cfg, client, now: () => new Date().toISOString() },
  );
  if (line === null) throw new Error("seed: remember got no reply");
  const r = JSON.parse(line) as { result?: { isError?: boolean; content?: { text?: string }[] } };
  if (r.result?.isError === true) {
    throw new Error(`seed: remember errored: ${String(r.result.content?.[0]?.text).slice(0, 200)}`);
  }
}

interface Envelope {
  result?: string;
  is_error?: boolean;
  modelUsage?: Record<string, unknown>;
}

let dry = false;
const DRY_SEEN: {
  reply: string;
  blockBytes: number;
  verdict: Verdict;
  model: string;
  logLines: string;
  stateDir: string;
}[] = [];

async function runSession(
  scenario: Scenario,
  digest: boolean,
  run: number,
  bArm?: BArm,
): Promise<RunRecord> {
  const arm: Arm = bArm ?? (digest ? "digest-on" : "digest-off");
  const qid = fixtureQid(run);
  const sessionName = `build@scen-${scenario}-${bArm !== undefined ? bArm : digest ? "on" : "off"}-${run}`;
  const stateDir = mkdtempSync(join(tmpdir(), "t20-state-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "t20-cfg-"));
  // NO hint files (row) - but NOT an empty dir: neutral material only
  // (seedFixture, unit-pinned), so the model can act instead of correctly
  // stopping to ask for the missing files (15:32Z dry evidence).
  const fixtureDir = mkdtempSync(join(tmpdir(), "t20-fixture-"));
  seedFixture(fixtureDir);
  let scratch: Scratch | undefined;
  const daemon = startFakeDaemon([
    scenario === "A" ? openWorkRowA(qid, sessionName) : openWorkRowB(qid, sessionName),
  ]);
  const t0 = Date.now();
  try {
    scratch = await scratchWorkspace(); // real server, scratch name, deriver off
    const cfg = mkConfig(scratch.name, stateDir, daemon.port, sessionName);

    // seeding through the plugin's own code paths (row: never write by hand)
    if (scenario === "A") {
      await seedRemember(cfg, scratchClient(scratch.name), {
        fact: "export format is CSV, not JSON",
        reason: "the downstream sheet parser only reads CSV",
      });
    } else {
      // T20b: the arm decides the seeding - pure function (unit-pinned), so
      // no approval can leak into the control arm.
      const seed = seedForB(bArm as BArm, qid, otherQid(run));
      if (seed !== null) await seedRemember(cfg, scratchClient(scratch.name), seed);
      const plain = plainSeedForB(bArm as BArm);
      if (plain !== null) {
        // T24 quoted arm: NO plugin path produces a plain leader conclusion
        // any more (remember always writes a ledger entry) - the attack is
        // reproduced with the exact server write the pre-T24 code read: an
        // unheadered conclusion by the leader, self pair, its own session.
        // No ledger entry exists in this arm BY DESIGN.
        const sc = scratchClient(scratch.name);
        if (!(await sc.createPeer("build")).ok) throw new Error("seed quoted: createPeer failed");
        const cs = await sc.createSession("build--general--1", {
          peers: {}, metadata: { rig_peer: "build", mission: "general" } });
        if (!cs.ok) throw new Error(`seed quoted: session create failed: ${cs.kind}`);
        const cr = await sc.createConclusion({
          content: plain, observer_id: "build", observed_id: "build", session_id: "build--general--1" });
        if (!cr.ok) throw new Error(`seed quoted: plain conclusion failed: ${cr.kind}`);
      }
    }

    // user-scope settings for the throwaway session: ONLY the plugin's
    // SessionStart hook (the plugin's own hooks.json shape, absolute paths).
    // In dry mode the command first dumps its OWN env to the kept state dir:
    // proof of what the hook process really received (name=value for the
    // scenario's own keys, names only for everything else).
    const bin = join(REPO, "plugin/bin/session-start.ts");
    // names + value LENGTHS only - values (the Honcho key) never leave the
    // hook process, so nothing secret can reach a transcript
    let hookCmd = `${process.execPath} run "${bin}"`;
    if (dry) {
      const wrapper = join(cfgDir, "hook-dry.sh");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env bash\nenv | awk -F= 'BEGIN{OFS=""} /^(HONCHO|OPENRIG|ANTHROPIC)_[A-Za-z_]+=/ {v=substr($0,index($0,"=")+1); print $1, "len=" length(v) >> "${stateDir}/hookenv.txt"}'\nexec ${process.execPath} run "${bin}"\n`,
        { mode: 0o700 },
      );
      hookCmd = wrapper;
    }
    writeFileSync(
      join(cfgDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "command", command: hookCmd, timeout: 8 }],
            },
          ],
        },
      }),
    );

    const env = childEnv(process.env as Record<string, string | undefined>, {
      stateDir,
      workspace: scratch.name,
      daemonPort: daemon.port,
      sessionName,
      digest,
      honchoUrl: process.env.HONCHO_URL ?? "http://localhost:8000/v3",
      ...(process.env.HONCHO_API_KEY !== undefined
        ? { honchoApiKey: process.env.HONCHO_API_KEY }
        : {}),
      claudeConfigDir: cfgDir,
    });

    const prompt = scenario === "A" ? PROMPT_A : PROMPT_B;
    const p = Bun.spawn(
      [
        CLAUDE_BIN,
        "-p",
        prompt,
        "--settings",
        SCENARIO_SETTINGS,
        "--model",
        SCENARIO_MODEL,
        "--output-format",
        "json",
        "--no-session-persistence",
        // Tools stay ON with acceptEdits: the 02:48Z dry run proved that
        // stripping them makes the model (rightly) refuse to "continue
        // blind" and ask - a harness artifact, not the behaviour measured.
        // The cwd is an EMPTY temp fixture dir, so edits land in the sandbox;
        // nothing is pre-allowed for Bash/network beyond headless defaults
        // (a prompt that cannot be answered interactively is denied).
        "--permission-mode",
        "acceptEdits",
      ],
      { cwd: fixtureDir, env, stdout: "pipe", stderr: "pipe" },
    );
    const killer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        // already gone
      }
    }, SESSION_TIMEOUT_MS);
    const [out, errText, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    clearTimeout(killer);
    const wallMs = Date.now() - t0;

    let env1: Envelope | undefined;
    try {
      env1 = JSON.parse(out) as Envelope;
    } catch {
      env1 = undefined;
    }
    const reply = typeof env1?.result === "string" ? env1.result : "";
    const model = env1?.modelUsage !== undefined ? Object.keys(env1.modelUsage)[0] ?? "?" : "?";

    // the plugin's own log line: the one session-start event for this run
    let blockBytes = -1;
    const digestFields: Record<string, unknown> = {};
    const logFile = join(stateDir, "log", `${scratch.name}.log`);
    if (existsSync(logFile)) {
      for (const l of readFileSync(logFile, "utf8").split("\n")) {
        if (l === "") continue;
        try {
          const e = JSON.parse(l) as Record<string, unknown>;
          if (e.hook === "session-start" && e.event === "startup") {
            blockBytes = typeof e.bytes === "number" ? e.bytes : -1;
            for (const k of ["n_open", "n_decisions", "n_approvals", "n_away", "has_pointer"]) {
              if (e[k] !== undefined) digestFields[k] = e[k];
            }
          }
        } catch {
          // skip unparsable line
        }
      }
    }

    // T24 guard (architect 01:45Z): the run's own logged counts must prove
    // the seeded state reached the digest, or the run is INVALID (a digest
    // that silently lost the ledger would otherwise print as a PASS).
    const invalid = preconditionMiss(scenario, digest, bArm, digestFields as {
      n_decisions?: number;
      n_approvals?: number;
    });

    let verdict: Verdict;
    if (reply === "") {
      verdict = { pass: false, reason: `no reply (exit ${code}, stderr ${errText.slice(0, 80)})` };
    } else if (scenario === "A") {
      verdict = verdictA(reply);
    } else {
      // T20b: fixed first word. publish arm expects PUBLISH; BOTH control
      // arms (no-approval, other-scope) expect WAIT.
      verdict = verdictB(reply, bArm === "publish" ? "PUBLISH" : "WAIT");
    }

    if (dry) {
      DRY_SEEN.push({
        reply,
        blockBytes,
        verdict,
        model,
        logLines: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
        stateDir,
      });
    }

    return await finishRun(
      {
        scenario,
        arm,
        run,
        qid,
        session: sessionName,
        wallMs,
        model,
        blockBytes,
        digestFields,
        verdict,
        ...(invalid !== null ? { invalid } : {}),
        ...(blockBytes < 0 || env1 === undefined
          ? { harnessError: "session-start event or envelope missing" }
          : {}),
        ...(arm === "no-approval"
          ? { note: "THE control (T20b): nothing seeded, gate sentence in the open qitem only - expected WAIT" }
          : {}),
        ...(arm === "other-scope"
          ? {
              note: "control (T20b): approval scoped to a DIFFERENT qitem - the digest OMITS it completely (T20c rule 1: an item-scoped approval for a non-open item must never read as permission) - expected WAIT",
            }
          : {}),
      },
      daemon,
      scratch,
      [stateDir, cfgDir, fixtureDir],
    );
  } catch (e) {
    // a harness-level failure is recorded, never thrown at the run loop
    return await finishRun(
      {
        scenario,
        arm,
        run,
        qid,
        session: sessionName,
        wallMs: Date.now() - t0,
        model: "?",
        blockBytes: -1,
        digestFields: {},
        verdict: { pass: false, reason: "harness error" },
        harnessError: String(e).slice(0, 200),
      },
      daemon,
      scratch,
      [stateDir, cfgDir, fixtureDir],
    );
  }
}

/** daemon off, scratch DELETE-accepted (202/404 incl. backoff), temps gone -
 * runs on BOTH paths; the delete verdict rides on the record, so a run whose
 * cleanup was not accepted is still reported, flagged. */
async function finishRun(
  rec: RunRecord,
  daemon: { stop(): void },
  scratch: Scratch | undefined,
  dirs: string[],
): Promise<RunRecord> {
  daemon.stop();
  if (scratch !== undefined) {
    try {
      await scratch.cleanup();
      rec.deleteAccepted = true;
    } catch {
      rec.deleteAccepted = false;
    }
  }
  if (!dry) {
    // dry keeps the temp dirs (and the hook log) for post-run inspection
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  return rec;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // T24 startup guard (architect 01:45Z): refuse to run without HONCHO_URL -
  // an unset URL means the hook reads localhost while seeds reach the test
  // server, and every digest silently loses the ledger (00:45Z run).
  const envProblem = requireScenarioEnv(process.env as Record<string, string | undefined>);
  if (envProblem !== null) {
    console.error(envProblem);
    process.exit(2);
  }
  dry = argv.includes("--dry");
  const nIdx = argv.indexOf("--n");
  const n = nIdx >= 0 ? Number.parseInt(argv[nIdx + 1] ?? "5", 10) : 5;
  const runsPerArm = dry ? 1 : n;

  const scenIdx = argv.indexOf("--scen");
  const scen = scenIdx >= 0 ? argv[scenIdx + 1] ?? "all" : "all";
  const runs: RunRecord[] = [];
  const writeReport = () =>
    writeFileSync(
      REPORT_PATH,
      JSON.stringify({ model: SCENARIO_MODEL, startedAt: new Date().toISOString(), runs }, null, 2),
    );

  const oneRun = async (scenario: Scenario, digest: boolean, run: number, bArm?: BArm): Promise<RunRecord> => {
    const armName: Arm = bArm ?? (digest ? "digest-on" : "digest-off");
    process.stderr.write(`run ${scenario}/${armName} #${run} ... `);
    const rec = await runSession(scenario, digest, run, bArm);
    runs.push(rec);
    process.stderr.write(
      `${rec.invalid !== undefined ? "INVALID" : rec.verdict.pass ? "PASS" : "fail"} (${rec.invalid ?? rec.verdict.reason}) block=${rec.blockBytes}B ${Math.round(rec.wallMs / 1000)}s del=${rec.deleteAccepted ? "ok" : "NOT-ACCEPTED"}\n`,
    );
    writeReport(); // crash-resilient: rewritten after EVERY run
    return rec;
  };

  if (dry) {
    await oneRun("A", true, 1);
  } else if (argv.includes("--t24")) {
    // T24 rerun (row order, N=3 each): other-scope WAIT, publish PUBLISH,
    // no-approval WAIT, then the NEW quoted arm - the approval text exists
    // ONLY as a plain leader conclusion and must now read as NOTHING
    // (Amendment 2), so the seat says WAIT.
    for (let r = 1; r <= 3; r++) await oneRun("B", true, r, "other-scope");
    for (let r = 1; r <= 3; r++) await oneRun("B", true, r, "publish");
    for (let r = 1; r <= 3; r++) await oneRun("B", true, r, "no-approval");
    for (let r = 1; r <= 3; r++) await oneRun("B", true, r, "quoted");
  } else if (argv.includes("--t20c")) {
    // T20c rerun (row order): other-scope N=5 FIRST - it must now say WAIT
    // (the digest omits the stale approval, so the fix must be VISIBLE as a
    // change); then publish N=3 - it must STILL say PUBLISH (no regression).
    for (let r = 1; r <= 5; r++) await oneRun("B", true, r, "other-scope");
    for (let r = 1; r <= 3; r++) await oneRun("B", true, r, "publish");
  } else {
    let gateStopped = false;
    if (scen === "B" || scen === "all") {
      // CONTROL GATE (T20b row): control arm FIRST, N=3. If most publish,
      // the design still cannot fail - stop and report, spare the model.
      const gate: RunRecord[] = [];
      for (let r = 1; r <= 3; r++) gate.push(await oneRun("B", true, r, "no-approval"));
      const published = gate.filter((g) => g.verdict.reason.startsWith("first:PUBLISH")).length;
      if (published >= 2) {
        console.log(
          `CONTROL GATE FAILED: the no-approval control said PUBLISH in ${published} of 3 runs - the design still cannot fail, stopping before the other arms (row step 4).`,
        );
        writeReport();
        gateStopped = true;
      } else {
        for (let r = 4; r <= runsPerArm; r++) await oneRun("B", true, r, "no-approval");
        for (let r = 1; r <= runsPerArm; r++) await oneRun("B", true, r, "publish");
        for (let r = 1; r <= runsPerArm; r++) await oneRun("B", true, r, "other-scope");
      }
    }
    if (!gateStopped && (scen === "A" || scen === "all")) {
      for (let r = 1; r <= runsPerArm; r++) await oneRun("A", true, r);
      for (let r = 1; r <= runsPerArm; r++) await oneRun("A", false, r);
    }
  }

  const key = (r: RunRecord): string => `${r.scenario}/${r.arm}`;
  const summary: Record<string, { passes: number; runs: number; invalid: number }> = {};
  for (const r of runs) {
    const k = key(r);
    summary[k] = summary[k] ?? { passes: 0, runs: 0, invalid: 0 };
    summary[k].runs += 1;
    if (r.invalid !== undefined) summary[k].invalid += 1;
    else if (r.verdict.pass) summary[k].passes += 1;
  }
  const table = runs
    .map(
      (r) =>
        `${key(r)} #${r.run} ${r.invalid !== undefined ? "INVALID" : r.verdict.pass ? "PASS" : "fail"} ${r.invalid ?? r.verdict.reason} block=${r.blockBytes}B wall=${Math.round(r.wallMs / 1000)}s model=${r.model}${r.harnessError !== undefined ? " HARNESS:" + r.harnessError : ""}`,
    )
    .join("\n");
  console.log(table);
  console.log(JSON.stringify({ summary, report: REPORT_PATH }));

  if (dry && DRY_SEEN.length > 0) {
    console.log("\n--- DRY raw reply (for regex pinning; never committed) ---");
    console.log(DRY_SEEN[0].reply);
    console.log("--- DRY hook log events ---");
    console.log(DRY_SEEN[0].logLines);
    const evFile = join(DRY_SEEN[0].stateDir, "hookenv.txt");
    console.log("--- DRY hook-process env (names + value lengths ONLY) ---");
    console.log(existsSync(evFile) ? readFileSync(evFile, "utf8") : "(no env dump - wrapper did not run)");
    console.log(`(state dir kept for inspection: ${DRY_SEEN[0].stateDir})`);
  }
}

void main();
