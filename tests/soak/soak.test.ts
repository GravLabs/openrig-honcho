// T8d-2 item 2 (ADR-0006 S5 soak + R1/R2 at scale): the REAL server, scratch
// workspace only, REAL hook bins as child processes, THREE seats, 300
// messages, 2 mission switches, 1 compaction, 1 ~40-message outage created by
// stopping/starting a TCP forwarder in front of the server. HEAVY: runs only
// with HONCHO_HEAVY_TESTS=1, and nobody else must run integration tests at
// the same time (architect instruction).
//
// Reasoning note (probe 2026-10-28 23:00Z, scratch): the real v3.4.0 API does
// NOT echo message configuration back on messages/list or GET messages/{id}
// (the stored fields are content, created_at, id, metadata, peer_id,
// session_id, token_count, workspace_id). So "broadcast reasoning enabled exactly once"
// is asserted on the POST bodies that actually crossed the forwarder (its
// --log tee), which is what the server received. Deviation flagged to
// architect before the first run. T8d-3 (a2abdbd) refined that assertion:
// reasoning-true messages carry NO configuration; suppressions carry
// {reasoning:{enabled:false}} - and the scratch workspace itself is created
// with reasoning/summary/dream disabled, so the soak costs the model server nothing.
//
// Workspace: scratchName() only (honcho-bridge-scratch*), deleted at the end
// with the DELETE accepted; the gate does the final disappearance check.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  readFileSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { cleanupScratch, SCRATCH_DISAPPEAR_WINDOW_MS, scratchWorkspace, type Scratch } from "../support/scratch.ts";

const HEAVY = process.env.HONCHO_HEAVY_TESTS === "1";
if (!HEAVY) {
  console.log("SOAK SKIPPED (heavy): set HONCHO_HEAVY_TESTS=1 to run tests/soak");
}

const REPO = join(import.meta.dir, "..", "..");
const BIN = {
  "session-start": join(REPO, "plugin/bin/session-start.ts"),
  "user-prompt": join(REPO, "plugin/bin/user-prompt.ts"),
  stop: join(REPO, "plugin/bin/stop.ts"),
  mcp: join(REPO, "plugin/bin/mcp.ts") } as const;
const FORWARDER = join(REPO, "tests/support/forwarder.ts");

const BASE = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/+$/, "");
const AUTH = (): Record<string, string> => ({
  Authorization: `Bearer ${process.env.HONCHO_API_KEY ?? "local"}`,
  "Content-Type": "application/json" });

const LEADER = "lead-seat";
const SEATS = [LEADER, "dev-a", "dev-b"] as const;
type Seat = (typeof SEATS)[number];
const CLAUDE_ID: Record<Seat, string> = {
  "lead-seat": "claude-lead",
  "dev-a": "claude-a",
  "dev-b": "claude-b" };

// plan (writes; distinct client_ids; must sum to 300):
//   A general--1: dm 16 + owner 8 + reply 8 = 32/seat; lead +14 owner  -> 110
//   B auth-bug--1: dm 14 + owner 7 + reply 7 = 28/seat                 ->  84
//   C general--2: dm 10 + owner 4 + reply 6 = 20/seat; +1 broadcast copy each -> 63
//   outage prompts: lead 15, dev-a 13, dev-b 12                         ->  40
//   post-recovery drain: 1 owner each                                   ->   3
const OUTAGE: Record<Seat, number> = { "lead-seat": 15, "dev-a": 13, "dev-b": 12 };
const PLAN_SESSIONS: Record<string, number> = {
  "lead-seat--general--1": 46,
  "dev-a--general--1": 32,
  "dev-b--general--1": 32,
  "lead-seat--auth-bug--1": 28,
  "dev-a--auth-bug--1": 28,
  "dev-b--auth-bug--1": 28,
  "lead-seat--general--2": 37,
  "dev-a--general--2": 35,
  "dev-b--general--2": 34 };
const TOTAL_PLAN = Object.values(PLAN_SESSIONS).reduce((a, b) => a + b, 0);

// marker -> expected (peer_id, metadata.kind)
type Expect = { peer: string; kind: "peer" | "owner" | "reply" };
const PLAN_MARKS = new Map<string, Expect>();

// marker -> fixture transcript ts (F1 check on the real server)
const replyTs = new Map<string, string>();

let scratch: Scratch | undefined;
let ws = "";
let stateDir = "";
let wireLog = "";
let fwdPort = 0;
let fwd: ReturnType<typeof Bun.spawn> | undefined;
const summary = { runs: 0, maxMs: { "session-start": 0, "user-prompt": 0, stop: 0, mcp: 0 } as Record<string, number> };

const OTHERS: Record<Seat, [Seat, Seat]> = {
  "lead-seat": ["dev-a", "dev-b"],
  "dev-a": ["lead-seat", "dev-b"],
  "dev-b": ["lead-seat", "dev-a"] };

// ---------- forwarder ----------

async function startForwarder(port?: number): Promise<void> {
  const t = BASE.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); // host:port
  const proc = Bun.spawn(
    [process.execPath, FORWARDER, ...(port !== undefined ? ["--port", String(port)] : []), "--target", t, "--log", wireLog],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("forwarder died before binding");
    buf += dec.decode(value, { stream: true });
    const line = buf.split("\n")[0] ?? "";
    if (line.startsWith("LISTENING ")) {
      fwdPort = Number(line.slice("LISTENING ".length));
      break;
    }
  }
  void reader.cancel().catch(() => undefined);
  fwd = proc;
}

function stopForwarder(): void {
  fwd?.kill();
  fwd = undefined;
}

// ---------- bin runner ----------

const seatEnv = (seat: Seat): Record<string, string> => ({
  HOME: stateDir,
  HONCHO_STATE_DIR: stateDir,
  HONCHO_ENABLED: "1",
  HONCHO_URL: `http://127.0.0.1:${fwdPort}/v3`,
  HONCHO_WORKSPACE: ws,
  HONCHO_PEER: seat,
  HONCHO_LEADER_PEER: LEADER,
  HONCHO_OWNER_PEER: "owner",
  HONCHO_TIMEOUT_MS: "20000" });

type BinName = keyof typeof BIN;

async function runBin(
  bin: BinName,
  env: Record<string, string>,
  stdinLines: string[],
): Promise<{ code: number; out: string; err: string; ms: number }> {
  const t0 = Date.now();
  const p = Bun.spawn([process.execPath, BIN[bin]], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const sink = p.stdin as unknown as { write(d: string): void; end(): void };
  for (const l of stdinLines) sink.write(`${l}\n`);
  sink.end();
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  const code = await p.exited;
  const ms = Date.now() - t0;
  summary.runs += 1;
  if (ms > (summary.maxMs[bin] ?? 0)) summary.maxMs[bin] = ms;
  expect(err, `${bin} stderr must be silent`).toBe("");
  expect(code, `${bin} exit code`).toBe(0);
  return { code, out, err, ms };
}

// ---------- fixtures ----------

function envelope(from: string, to: string, body: string): string {
  return `From: ${from}\nTo: ${to}\nSent: 10-28 23:30Z\n---\n${body}\n---\n↩ Reply: rig send ${from} "..."`;
}

function dmPrompt(seat: Seat, phase: string, i: number): string {
  const author = OTHERS[seat][i % 2];
  const marker = `M${phase}-dm-${seat}-${i}`;
  PLAN_MARKS.set(marker, { peer: author, kind: "peer" });
  return envelope(
    `${author}@${ws}`,
    `${seat}@${ws}`,
    `${marker} by=${author} ${phase}-phase traffic to ${seat}, soak filler sentence ${i}.`,
  );
}

function ownPrompt(seat: Seat, phase: string, i: number): string {
  const marker = `M${phase}-own-${seat}-${i}`;
  PLAN_MARKS.set(marker, { peer: "owner", kind: "owner" });
  return `${marker} by=owner ${phase}-phase owner note for ${seat} ${i}.`;
}

const BCMARK = "MC-bcast-marker";

function bcastEnvelope(): string {
  PLAN_MARKS.set(BCMARK, { peer: "dev-a", kind: "peer" });
  return envelope(
    `dev-a@${ws}`,
    `broadcast to ${ws}`,
    `${BCMARK} by=dev-a broadcast kickoff: soak notes for every seat in the rig, one reasoning pass only.`,
  );
}

function replyTranscript(seat: Seat, phase: string, i: number): { path: string; ts: string; marker: string } {
  const marker = `M${phase}-rep-${seat}-${i}`;
  PLAN_MARKS.set(marker, { peer: seat, kind: "reply" });
  const ts = new Date(Date.parse("2026-10-28T21:25:00Z") + PLAN_MARKS.size * 1000).toISOString();
  replyTs.set(marker, ts);
  const path = join(stateDir, `tr-${marker}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "user",
        uuid: `uuid-${marker}`,
        timestamp: "2026-10-28T23:24:00.000000Z",
        message: { role: "user", content: [{ type: "text", text: `${marker} question ${i}` }] } }),
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: { role: "assistant", content: [{ type: "text", text: `${marker} by=${seat} ${phase}-phase answer ${i}` }] } }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  return { path, ts, marker };
}

// ---------- real-server reads ----------

interface SrvMsg {
  id: string;
  peer_id: string;
  content: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

async function serverMessages(session: string): Promise<SrvMsg[]> {
  const resp = await fetch(`${BASE}/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(session)}/messages/list?size=100`, {
    method: "POST",
    headers: AUTH() });
  expect(resp.ok, `messages/list ${session} HTTP ${resp.status}`).toBe(true);
  const page = (await resp.json()) as { items?: SrvMsg[]; pages?: number };
  expect(page.pages ?? 1, `${session}: more pages than size=100 can hold`).toBe(1);
  return page.items ?? [];
}

async function serverSessions(): Promise<string[]> {
  const resp = await fetch(`${BASE}/workspaces/${encodeURIComponent(ws)}/sessions/list?size=100`, { method: "POST", headers: AUTH() });
  expect(resp.ok, `sessions/list HTTP ${resp.status}`).toBe(true);
  const page = (await resp.json()) as { items?: { id: string }[] };
  return (page.items ?? []).map((s) => s.id);
}

async function scopeSessions(scope: string): Promise<string[]> {
  const resp = await fetch(`${BASE}/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/sessions/list?size=100`, {
    method: "POST",
    headers: AUTH() });
  expect(resp.ok, `scopes/${scope} HTTP ${resp.status}`).toBe(true);
  const page = (await resp.json()) as { items?: { id: string }[] };
  return (page.items ?? []).map((s) => s.id);
}

// ---------- the soak ----------

describe.skipIf(!HEAVY)("soak: 3 seats, 300 messages, real server (HEAVY)", () => {
  // T16i: the state dir is created at describe TOP LEVEL, never inside a
  // beforeAll: bun test 1.4.2 fires an afterAll registered inside a
  // beforeAll at the end of the beforeAll PHASE, so a dir made there is
  // deleted before the first test line (the v0.2.2 gate failure - every
  // seat freeN-minted an extra session against the missing state). At
  // collection scope the cleanup afterAll fires at file end, and the
  // skipped (non-HEAVY) case simply sweeps an unused dir away there.
  stateDir = makeTempDir("soak-state-");
  beforeAll(async () => {
    scratch = await scratchWorkspace();
    ws = scratch.name;
    wireLog = join(stateDir, "wire.log");
    await startForwarder();

    // seats come up: session-start startup per seat (not counted as messages)
    for (const seat of SEATS) {
      await runBin("session-start", seatEnv(seat), [
        JSON.stringify({ session_id: CLAUDE_ID[seat], source: "startup", cwd: stateDir }),
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    stopForwarder();
    // T8e-fix-3: soak runs only under HEAVY -> verify DELETE accepted and
    // leave disappearance to the gate's leftovers step (the authoritative proof).
    // The ceiling fits a light SCRATCH_DISAPPEAR_WINDOW_MS anyway (T13d), so
    // an accidental light run of this file cannot die on the hook timeout.
    if (scratch) await cleanupScratch([scratch.name]);
  }, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

  test("full soak run", async () => {
    // ---- Phase A (general--1) ----
    for (const seat of SEATS) {
      const env = seatEnv(seat);
      const extra = seat === LEADER ? 14 : 0;
      for (let i = 1; i <= 16; i++) {
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: dmPrompt(seat, "A", i) })]);
      }
      for (let i = 1; i <= 8 + extra; i++) {
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: ownPrompt(seat, "A", i) })]);
      }
      for (let i = 1; i <= 8; i++) {
        const tr = replyTranscript(seat, "A", i);
        await runBin("stop", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], transcript_path: tr.path })]);
      }
    }

    // ---- Mission switch 1 (real path: mcp bin tools/call mission) ----
    const sw1 = await runBin("mcp", seatEnv(LEADER), [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mission", arguments: { id: "auth-bug" } } }),
    ]);
    expect(sw1.out).toContain("auth-bug");

    // ---- Phase B (auth-bug--1) ----
    for (const seat of SEATS) {
      const env = seatEnv(seat);
      for (let i = 1; i <= 14; i++) {
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: dmPrompt(seat, "B", i) })]);
      }
      for (let i = 1; i <= 7; i++) {
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: ownPrompt(seat, "B", i) })]);
      }
      for (let i = 1; i <= 7; i++) {
        const tr = replyTranscript(seat, "B", i);
        await runBin("stop", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], transcript_path: tr.path })]);
      }
    }

    // ---- Compaction (session-start source=compact, new claude id): must NOT
    // start a new Honcho session (ADR-0002) ----
    await runBin("session-start", seatEnv(LEADER), [
      JSON.stringify({ session_id: "claude-lead-2", source: "compact", cwd: stateDir }),
    ]);

    // ---- Mission switch 2: back to general ----
    const sw2 = await runBin("mcp", seatEnv(LEADER), [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mission", arguments: { id: "general" } } }),
    ]);
    expect(sw2.out).toContain("general");

    // ---- Phase C (general--2) ----
    for (const seat of SEATS) {
      const env = seatEnv(seat);
      for (let i = 1; i <= 10; i++) {
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: dmPrompt(seat, "C", i) })]);
      }
      for (let i = 1; i <= 4; i++) {
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: ownPrompt(seat, "C", i) })]);
      }
      for (let i = 1; i <= 6; i++) {
        const tr = replyTranscript(seat, "C", i);
        await runBin("stop", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], transcript_path: tr.path })]);
      }
    }

    // ---- One broadcast (dev-a), delivered into all three panes ----
    for (const seat of SEATS) {
      await runBin("user-prompt", seatEnv(seat), [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: bcastEnvelope() })]);
    }

    // ---- Outage: forwarder down -> connect refused -> spooled (not sent) ----
    stopForwarder();
    for (const seat of SEATS) {
      const env = seatEnv(seat);
      const n = OUTAGE[seat];
      for (let i = 1; i <= n; i++) {
        // mixed DMs (odd) and owner prompts (even); exit 0 and silence are
        // checked inside runBin - the hooks must swallow the outage
        const prompt = i % 2 === 1 ? dmPrompt(seat, "O", i) : ownPrompt(seat, "O", i);
        await runBin("user-prompt", env, [JSON.stringify({ session_id: CLAUDE_ID[seat], prompt })]);
      }
    }

    // ---- Recovery on the SAME port; drain writes replay the spools ----
    await startForwarder(fwdPort);
    for (const seat of SEATS) {
      await runBin("user-prompt", seatEnv(seat), [
        JSON.stringify({ session_id: CLAUDE_ID[seat], prompt: ownPrompt(seat, "D", 1) }),
      ]);
    }

    // ---- Read the real server and assert ----
    const sessions = (await serverSessions()).sort();
    expect(sessions).toEqual(Object.keys(PLAN_SESSIONS).sort()); // 9 sessions, no compaction extra

    const generalScope = (await scopeSessions("general")).sort();
    expect(generalScope).toEqual(
      sessions.filter((s) => s.endsWith("--general--1") || s.endsWith("--general--2")),
    );
    expect((await scopeSessions("mission-auth-bug")).sort()).toEqual(
      sessions.filter((s) => s.includes("--auth-bug--")),
    );

    const seenCid = new Map<string, { session: string; rows: number; withReplayOf: number }>();
    const markersSeen = new Map<string, number>();
    let rows = 0;
    for (const session of sessions) {
      const msgs = await serverMessages(session);
      expect(msgs.length, `row count in ${session}`).toBe(PLAN_SESSIONS[session] ?? 0);
      for (const m of msgs) {
        rows += 1;
        const content = String(m.content ?? "");
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        const cid = String(meta.client_id ?? "");
        expect(cid, "every message carries client_id").not.toBe("");
        const mk = content.match(/\bM[A-Z0-9a-z-]+/)?.[0] ?? "";
        const exp = PLAN_MARKS.get(mk);
        expect(exp !== undefined, `unknown marker in stored message: ${mk}`).toBe(true);
        expect(m.peer_id, `peer_id for ${mk}`).toBe(exp?.peer);
        expect(meta.kind, `metadata.kind for ${mk}`).toBe(exp?.kind);
        markersSeen.set(mk, (markersSeen.get(mk) ?? 0) + 1);
        const prev = seenCid.get(cid) ?? { session, rows: 0, withReplayOf: 0 };
        prev.rows += 1;
        if (meta.replay_of !== undefined) prev.withReplayOf += 1;
        seenCid.set(cid, prev);
        // F1 on the real server: a reply's created_at is the transcript timestamp
        if (mk.includes("-rep-")) {
          const ts = replyTs.get(mk);
          if (ts !== undefined) expect(Date.parse(String(m.created_at)), `reply ${mk} created_at`).toBe(Date.parse(ts));
        }
      }
    }

    // every planned marker landed; distinct client_ids = exactly 300
    expect(PLAN_MARKS.size).toBe(TOTAL_PLAN - 2); // 297 logical writes, broadcast = 3 rows / 1 marker
    for (const [mk, n] of markersSeen) expect(PLAN_MARKS.has(mk), `stray marker ${mk}`).toBe(true);
    expect(markersSeen.get(BCMARK), "broadcast landed in all 3 panes").toBe(3);
    for (const mk of PLAN_MARKS.keys()) {
      const got = markersSeen.get(mk) ?? 0;
      const min = mk === BCMARK ? 3 : 1;
      expect(got >= min && got <= min * 2, `marker ${mk}: ${got} copies`).toBe(true);
    }
    expect(seenCid.size).toBe(TOTAL_PLAN);
    for (const [cid, v] of seenCid) {
      if (v.rows > 1) {
        expect(v.rows, `dup cap for ${cid}`).toBe(2);
        expect(v.withReplayOf >= 1, `duplicate without replay_of: ${cid}`).toBe(true);
      }
    }
    expect(rows >= TOTAL_PLAN).toBe(true);
    expect(rows - TOTAL_PLAN).toBeLessThanOrEqual(OUTAGE["lead-seat"] + OUTAGE["dev-a"] + OUTAGE["dev-b"]);

    // spools drained for every seat (live + replay residue)
    for (const seat of SEATS) {
      for (const f of [`${seat}.jsonl`, `${seat}.replay.jsonl`]) {
        let bytes = "";
        try {
          bytes = readFileSync(join(stateDir, ws, "spool", f), "utf8").trim();
        } catch {
          bytes = "";
        }
        expect(bytes === "", `spool ${f} must be empty at the end`).toBe(true);
      }
    }

    // ---- reasoning on the wire: the POST bodies that crossed the forwarder.
    // dev-a broadcasts (non-leader): exactly the LEADER's copy enables reasoning.
    // T8d-3 (ADR-0006 a2abdbd): reasoning-true sends NO configuration; only
    // suppressions send {reasoning:{enabled:false}}. Leader's copy = the one
    // without a configuration field; the other two explicitly suppress.
    const wire = readFileSync(wireLog, "utf8");
    const bodies = wire.match(/\{"messages":\[.*?\]\}/gs) ?? [];
    const bcastBodies = bodies.filter((b) => b.includes(BCMARK));
    expect(bcastBodies.length, "broadcast POST bodies on the wire").toBe(3);
    const suppressed = bcastBodies.filter((b) => b.includes('"reasoning":{"enabled":false}')).length;
    const unsuppressed = bcastBodies.filter((b) => !b.includes('"configuration"')).length;
    expect(suppressed, "broadcast: the 2 non-reasoning copies explicitly suppress").toBe(2);
    expect(unsuppressed, "broadcast: exactly one copy carries no configuration (the leader's)").toBe(1);
    // every planned write crossed the wire exactly once by client_id
    const wireCids = new Set<string>();
    for (const b of bodies) {
      const parsed = JSON.parse(b) as { messages: Array<{ metadata?: { client_id?: string } }> };
      for (const msg of parsed.messages) {
        const cid = msg.metadata?.client_id;
        if (typeof cid === "string") wireCids.add(cid);
      }
    }
    expect(wireCids.size).toBe(TOTAL_PLAN);

    const line =
      `SOAK SUMMARY ws=${ws} runs=${summary.runs} planned=${TOTAL_PLAN} rows=${rows} ` +
      `distinct=${seenCid.size} dups=${rows - seenCid.size} outage=${OUTAGE["lead-seat"] + OUTAGE["dev-a"] + OUTAGE["dev-b"]} ` +
      `maxMs[user-prompt]=${summary.maxMs["user-prompt"]} maxMs[stop]=${summary.maxMs.stop} ` +
      `maxMs[session-start]=${summary.maxMs["session-start"]} maxMs[mcp]=${summary.maxMs.mcp}`;
    console.log(line);
  }, 1_800_000);
});
