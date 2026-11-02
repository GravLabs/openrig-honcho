// T9 (ADR-0006 O4): hook latency against the REAL server in a SCRATCH
// workspace (tests/support/scratch.ts is the only door; it is deleted at the
// end and its disappearance is polled out of workspaces/list). `bun run
// tests/latency.ts`.
//
// Methodology (recorded in the written table):
// - every row is the WALL TIME of one real child process, spawn to exit,
//   exactly as Claude Code would run the hook; 30 runs per row;
// - session-start seeds a seat that has sessions and a decision: the current
//   session plus two others and one conclusion (decision) in the general
//   mission, so the reader takes its real fetch paths;
// - user-prompt runs a real envelope DM (attribute -> kind peer); stop runs
//   a unique 2-line transcript each time (dedup never masks the write path);
// - recall (T14h, ADR-0009): the peer row is a real same-rig envelope DM
//   (From: mate@<this scratch workspace> -> sender "mate") with the seed
//   holding two conclusions bench-seat-about-mate and one
//   scope.general-about-mate - exactly the pairs recall asks; a NEW
//   session_id per run, so the seen file never suppresses the fetch, and at
//   least one run must carry additionalContext. The owner row is an
//   owner-typed prompt: silent stdout, no network path taken (not-peer).
// - MCP rows spawn plugin/bin/mcp.ts, speak initialize + one tools/call and
//   measure through the tool answer: mission (switching alternates) and
//   status. NOT ask - ask costs model-server time (HARD LIMIT discipline);
// - the last row is `bun -e 0`: pure process-start overhead, so hook rows
//   can be read net of it;
// - p50 = sorted[14] (median of 30), p95 = sorted[27] (28th smallest), max =
//   sorted[29]; times in ms.
// Output: prints the table and writes release/v<version>/LATENCY.md, the
// version read from plugin/.claude-plugin/plugin.json (T14h - it follows the
// release instead of hard-coding one; that file only; the architect owns
// README.md and rig-spec.example.yaml there).

import {  mkdirSync, readFileSync, writeFileSync  } from "node:fs";
import { makeTempDir } from "./support/tempdir.ts";
import {  hostname  } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { cleanupScratch, SCRATCH_DISAPPEAR_WINDOW_MS, scratchClient, scratchWorkspace } from "./support/scratch.ts";
import { redact } from "../plugin/src/redact.ts";

/** No output channel may carry an un-redacted fragment (review 03:13Z):
 * child stderr/stdout and client error objects are OUR bins/shapes, but the
 * belt goes on anyway. */
const safe = (s: string, n: number): string => redact(s.slice(0, n)).text;

const REPO = join(import.meta.dir, "..");
const BIN = ["session-start", "user-prompt", "recall", "stop", "mcp"] as const;
const RUNS = 30;
const BASE = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/+$/, "");
const WS_PEER = "bench-seat";
/** The recall DM sender (T14h): same-rig From: mate@<workspace> attributes
 * to plain "mate" - the observed_id the recall seed must use. */
const RECALL_SENDER = "mate";

/** T14h: the released version drives the heading and the output dir, so the
 * file follows the release instead of pinning one. Throws: a missing
 * version makes the whole run unprovenable, which is a hard stop. */
function pluginVersion(): string {
  const pj = JSON.parse(readFileSync(join(REPO, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof pj.version !== "string" || pj.version === "") {
    throw new Error("plugin/.claude-plugin/plugin.json carries no version string");
  }
  return pj.version;
}

interface Row {
  name: string;
  ms: number[];
}

/** Spawn-to-exit wall ms, exit 0 + empty stderr asserted; stdout returned
 * too (T14h: the recall rows read it, the others ignore it). */
async function runChildOut(
  argv: string[],
  env: Record<string, string>,
  stdin: string,
): Promise<{ ms: number; out: string }> {
  const t0 = Date.now();
  const p = Bun.spawn(argv, { cwd: REPO, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  (p.stdin as unknown as { write(d: string): void; end(): void }).write(stdin);
  (p.stdin as unknown as { end(): void }).end();
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  const code = await p.exited;
  if (code !== 0 || err !== "") {
    throw new Error(`${argv.slice(1).join(" ")}: exit ${code}, stderr: ${safe(err, 200)}, stdout: ${safe(out, 120)}`);
  }
  return { ms: Date.now() - t0, out };
}

async function runChild(argv: string[], env: Record<string, string>, stdin: string): Promise<number> {
  return (await runChildOut(argv, env, stdin)).ms;
}

function mcpStdin(toolCall: Record<string, unknown>): string {
  return (
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "latency", version: "0" } } }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: toolCall }) +
    "\n"
  );
}

const pct = (sorted: number[], idx: number): number => sorted[idx] as number;
const stats = (ms: number[]): { p50: number; p95: number; max: number } => {
  const s = [...ms].sort((a, b) => a - b);
  return { p50: pct(s, 14), p95: pct(s, 27), max: pct(s, 29) };
};

async function main(): Promise<void> {
  const scratch = await scratchWorkspace(); // the ONLY workspace ever touched
  const stateDir = makeTempDir("latency-");
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: stateDir,
    HONCHO_STATE_DIR: stateDir,
    HONCHO_URL: BASE,
    HONCHO_API_KEY: process.env.HONCHO_API_KEY ?? "local",
    HONCHO_WORKSPACE: scratch.name,
    HONCHO_PEER: WS_PEER,
    HONCHO_LEADER_PEER: WS_PEER };
  try {
    // ---- seed: three sessions + one decision, so the reader's paths are real
    const client = scratchClient(scratch.name);
    for (const [id, scopes] of [
      [`${WS_PEER}--general--1`, ["general"]],
      [`${WS_PEER}--auth-bug--1`, ["mission-auth-bug"]],
      ["mate--general--1", ["general"]],
    ] as const) {
      const r = await client.createSession(id, {
        peers: { [WS_PEER]: { observe_me: true, observe_others: false } },
        scopes: [...scopes],
        metadata: { rig_peer: WS_PEER, seeded_by: "latency" } });
      if (!r.ok) throw new Error(`seed session ${id}: ${safe(JSON.stringify(r.error), 160)}`);
    }
    const c = await client.createConclusion({
      content: "latency seed decision: the bench route holds",
      observer_id: WS_PEER,
      observed_id: WS_PEER,
      session_id: `${WS_PEER}--general--1` });
    if (!c.ok) throw new Error(`seed conclusion: ${safe(JSON.stringify(c.error), 160)}`);

    // T14h recall seed: what the rig remembers ABOUT the DM sender - two
    // conclusions this seat observed and one the general mission scope
    // observed: exactly the two pairs recallPairs asks (ADR-0009 decision 2).
    // The sender must exist as a peer first: the server 404s a conclusion
    // about an unknown peer (first v0.2.0 run).
    const ap = await client.addSessionPeers(`${WS_PEER}--general--1`, {
      [RECALL_SENDER]: { observe_me: true, observe_others: false } });
    if (!ap.ok) throw new Error(`seed recall sender peer: ${safe(JSON.stringify(ap.error), 160)}`);
    for (const content of [
      "latency recall note one about the sender",
      "latency recall note two about the sender",
    ]) {
      const rc = await client.createConclusion({
        content,
        observer_id: WS_PEER,
        observed_id: RECALL_SENDER,
        session_id: `${WS_PEER}--general--1` });
      if (!rc.ok) throw new Error(`seed recall conclusion: ${safe(JSON.stringify(rc.error), 160)}`);
    }
    const sc = await client.createConclusion({
      content: "latency recall scope note about the sender",
      observer_id: "scope.general",
      observed_id: RECALL_SENDER,
      session_id: `${WS_PEER}--general--1` });
    if (!sc.ok) throw new Error(`seed recall scope conclusion: ${safe(JSON.stringify(sc.error), 160)}`);

    const rows: Row[] = [];
    const timed = async (name: string, f: (i: number) => Promise<number>): Promise<void> => {
      const ms: number[] = [];
      for (let i = 0; i < RUNS; i++) ms.push(await f(i));
      rows.push({ name, ms });
      const s = stats(ms);
      console.log(`${name}: p50=${s.p50} p95=${s.p95} max=${s.max}`);
    };

    const bin = (n: (typeof BIN)[number]): string => join(REPO, "plugin/bin", `${n}.ts`);
    const ssStdin = (source: string): string =>
      JSON.stringify({ session_id: "claude-latency", source, cwd: stateDir });

    await timed("session-start startup", () => runChild([process.execPath, bin("session-start")], env, ssStdin("startup")));
    await timed("session-start resume", () => runChild([process.execPath, bin("session-start")], env, ssStdin("resume")));
    await timed("session-start compact", () => runChild([process.execPath, bin("session-start")], env, ssStdin("compact")));

    await timed("user-prompt (DM)", (i) =>
      runChild(
        [process.execPath, bin("user-prompt")],
        env,
        JSON.stringify({
          session_id: "claude-latency",
          prompt: `From: mate@benchrig\nTo: ${WS_PEER}@benchrig\n---\nlatency dm ${i} [L-${i}]\n---\n↩ Reply: rig send mate@benchrig "..."` }),
      ),
    );

    // ---- recall (T14h, ADR-0009): the sync UserPromptSubmit hook. Same-rig
    // envelope DM (From: mate@<this workspace> attributes to plain "mate",
    // the seed's observed_id); a fresh session_id per run so the seen file
    // never suppresses the fetch.
    const recallDm = (i: number): string =>
      JSON.stringify({
        session_id: `claude-latency-recall-${i}`,
        prompt: `From: ${RECALL_SENDER}@${scratch.name}\nTo: ${WS_PEER}@${scratch.name}\n---\nlatency recall dm ${i} [R-${i}]\n---\n↩ Reply: rig send ${RECALL_SENDER}@${scratch.name} "..."` });

    let recallInjected = 0;
    await timed("recall (peer, items)", async (i) => {
      const r = await runChildOut([process.execPath, bin("recall")], env, recallDm(i));
      if (r.out.includes("additionalContext")) recallInjected += 1;
      return r.ms;
    });
    if (recallInjected === 0) {
      throw new Error("recall (peer, items): no run carried additionalContext - the seed pairs produced no block");
    }

    await timed("recall (owner, no network)", async (i) => {
      const r = await runChildOut(
        [process.execPath, bin("recall")],
        env,
        JSON.stringify({ session_id: `claude-latency-owner-${i}`, prompt: `ship the latency table tonight ${i}` }),
      );
      if (r.out !== "") {
        // not-peer must print nothing: output here would mean the owner path
        // reached the network and injected
        throw new Error(`recall (owner, no network): owner-typed prompt printed: ${safe(r.out, 120)}`);
      }
      return r.ms;
    });

    await timed("stop (small transcript)", (i) => {
      const tp = join(stateDir, `lat-${i}.jsonl`);
      const t0 = new Date();
      writeFileSync(
        tp,
        [
          JSON.stringify({ type: "user", timestamp: t0.toISOString(), message: { role: "user", content: [{ type: "text", text: `latency stop question ${i}` }] } }),
          JSON.stringify({ type: "assistant", timestamp: new Date(t0.getTime() + 2000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `latency stop answer ${i} [S-${i}]` }] } }),
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      return runChild([process.execPath, bin("stop")], env, JSON.stringify({ session_id: "claude-latency", transcript_path: tp }));
    });

    await timed("mcp mission", (i) =>
      runChild(
        [process.execPath, bin("mcp")],
        env,
        mcpStdin({ name: "mission", arguments: { id: i % 2 === 0 ? "auth-bug" : "general" } }),
      ),
    );
    // leave the seat on general for a clean state
    await runChild([process.execPath, bin("mcp")], env, mcpStdin({ name: "mission", arguments: { id: "general" } }));

    await timed("mcp status", () => runChild([process.execPath, bin("mcp")], env, mcpStdin({ name: "status", arguments: {} })));

    await timed("bun -e 0 (start overhead)", () => runChild([process.execPath, "-e", "0"], env, ""));

    // ---- provenance for the file
    let commit = "";
    try {
      commit = execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
    } catch {
      commit = "unknown";
    }
    let serverVersion = "unknown";
    try {
      const o = (await (await fetch(`${BASE.replace(/\/v3$/, "")}/openapi.json`)).json()) as { info?: { version?: string } };
      if (typeof o.info?.version === "string") serverVersion = o.info.version;
    } catch {
      /* reported as unknown */
    }

    const version = pluginVersion();
    const lines = [
      `# Hook latency - v${version}`,
      "",
      `- Date: ${new Date().toISOString()}`,
      `- Commit: ${commit}`,
      `- Server: Honcho v${serverVersion} at ${BASE}`,
      `- Host: ${hostname()}`,
      `- Method: real bins as child processes, spawn-to-exit wall ms, ${RUNS} runs each, one scratch workspace (${scratch.name}) with 3 seeded sessions + 1 decision + 3 recall conclusions about the DM sender (2 bench-seat, 1 scope.general); scratch is deriver-disabled (T8d-3), so summary slots exist but stay empty on the read paths. recall peer rows use a fresh session_id per run so the seen file never suppresses the fetch. p50 = median of 30, p95 = 28th smallest, max = largest.`,
      "",
      "| hook | p50 (ms) | p95 (ms) | max (ms) |",
      "| --- | --- | --- | --- |",
      ...rows.map((r) => {
        const s = stats(r.ms);
        return `| ${r.name} | ${s.p50} | ${s.p95} | ${s.max} |`;
      }),
      "",
    ].join("\n");

    mkdirSync(join(REPO, "release", `v${version}`), { recursive: true });
    const outPath = join(REPO, "release", `v${version}`, "LATENCY.md");
    writeFileSync(outPath, `${lines}\n`);
    console.log(`\nwrote ${outPath}`);
    console.log(lines);
  } finally {
    // Teardown (review 03:13Z: delete AND disappearance proof). light rule
    // first: DELETE accepted (retried) + the full SCRATCH_DISAPPEAR_WINDOW_MS
    // disappearance window (900 s since the ADR-0006 amendment 2026-10-30,
    // T13d). Last night's purge lag exceeded 10 min, so on a window timeout
    // we keep polling the SAME list ourselves up to 15 more minutes and print
    // the verdict; a rejected DELETE rethrows - never swallowed.
    const list = async (): Promise<string[]> => {
      const resp = await fetch(`${BASE}/workspaces/list?size=100`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.HONCHO_API_KEY ?? "local"}` } });
      if (!resp.ok) throw new Error(`workspaces/list HTTP ${resp.status} - cannot prove deletion`);
      const page = (await resp.json()) as { items?: { id: string }[] };
      if (!Array.isArray(page.items)) throw new Error("workspaces/list had no items array");
      return page.items.map((x) => x.id);
    };
    const t0 = Date.now();
    try {
      await cleanupScratch([scratch.name], { listWorkspaces: list });
      console.log(`SCRATCH ${scratch.name}: DELETE accepted, DISAPPEARED after ${Date.now() - t0} ms`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("still listed after")) throw e; // rejected DELETE or broken list: honest hard stop
      console.log(`SCRATCH ${scratch.name}: DELETE accepted, still listed after ${SCRATCH_DISAPPEAR_WINDOW_MS / 1000} s (purge lag); waiting up to 15 more minutes`);
      const deadline = Date.now() + 900_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 15_000));
        if (!(await list()).includes(scratch.name)) {
          console.log(`SCRATCH ${scratch.name}: DISAPPEARED after ${Date.now() - t0} ms total`);
          break;
        }
        if (Date.now() >= deadline) {
          console.error(`SCRATCH ${scratch.name}: DELETE WAS ACCEPTED but still listed after 15 more minutes - check it manually (this workspace only)`);
          process.exitCode = 2;
          break;
        }
      }
    }
  }
}

await main();
