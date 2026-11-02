// dev.review battery for T6a (writer.ts, user-prompt bin, T5b-fix spool) +
// the re-review plan agreed with the architect at pins 58bde75 (qitem
// -20261028132315). Contract: ADR-0005 E1/E2/E4/E5 + ADR-0002 (ensure-before-
// write, free-n, never implicit-create) + ADR-0006 S1/S2/R1/R2/X4.
// HTTP-status routing and poison -> dead (T5b-fix-2) are tested in
// review-t5b2.test.ts, not here.
// F-T6a-1 (leaderPeer never wired) was the deliberately-RED finding at pin
// 58bde75; the T6a-fix at aa23a0b wired env.ts leaderPeer through the writer
// and the test now asserts the FIXED behaviour (verified green at aa23a0b).
// Local tmp dirs + 127.0.0.1 fakes only; no real server, no secrets.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readSeatState, seatStatePath } from "../../plugin/src/missions.ts";
import { statsFrom } from "../../plugin/src/stats.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import {
  SPOOL_ENTRY_MAX_BYTES,
  replay,
  sendOrSpool,
  spoolAppend,
  type SpoolEntry } from "../../plugin/src/spool.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const BIN = fileURLToPath(new URL("../../plugin/bin/user-prompt.ts", import.meta.url));
const WS = "ws";
const FIXED_TS = "2026-10-28T12:00:00.000Z";
const FIXED_SEC = Math.floor(Date.parse(FIXED_TS) / 1000);
// fake shapes only (same as review-t4/t5)
const ANTH = "sk-ant-RevFake0123456789abcdefGHIJKL"; // fake-secret

type Paths = { stateDir: string; workspace: string; peer: string };
const livePath = (p: Paths) => join(p.stateDir, p.workspace, "spool", `${p.peer}.jsonl`);
const rPath = (p: Paths) => join(p.stateDir, p.workspace, "spool", `${p.peer}.replay.jsonl`);
const markerPath = (p: Paths) => join(p.stateDir, p.workspace, "spool", `${p.peer}.replaying`);
const linesOf = (f: string): string[] => {
  try {
    return readFileSync(f, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
};
const readLog = (dir: string): string => {
  try {
    return readFileSync(join(dir, "log", `${WS}.log`), "utf8");
  } catch {
    return "";
  }
};

const mkSpool = (): { dir: string; paths: Paths } => {
  const dir = makeTempDir("rev-t6a-");
  return { dir, paths: { stateDir: dir, workspace: WS, peer: "p1" } };
};

const entry = (session: string, content?: string): SpoolEntry => ({
  session,
  messages: [{ peer_id: "p1", content: content ?? `body-${session}`, metadata: { client_id: `cid-${session}` } }],
  maybe_sent: false,
  at: new Date().toISOString() });

type Res = { ok: true; data: unknown } | { ok: false; error: string; kind: never };
type Call = { op: string; arg: string };

const stub = (opts: { fail?: (op: string, n: number) => boolean; delayMs?: number; onCall?: Call[] } = {}) => {
  const calls: Call[] = opts.onCall ?? [];
  const n = { i: 0 };
  const step = async (op: string, arg: string): Promise<Res> => {
    n.i++;
    calls.push({ op, arg });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail?.(op, n.i)) return { ok: false, error: `stub ${op}`, kind: "connect" as never };
    return { ok: true, data: [] };
  };
  const client = {
    addMessages: (s: string) => step("messages", s),
    createSession: (s: string) => step("create", s),
    addSessionPeers: (s: string) => step("peers", s),
    listScopeSessions: () => step("list", "scope") };
  return { client: client as never, calls };
};

// ---------- writer harness ----------

const mkWriter = async (over: Partial<Config> = {}) => {
  const fake = await startFakeHoncho();
  const dir = makeTempDir("rev-t6a-w-");
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: "lead",
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: false,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over };
  return { fake, dir, config, deps: { client, now: () => FIXED_TS } };
};

const dm = (from: string, body: string) =>
  `From: ${from}@${WS}\nTo: lead@${WS}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;

const stored = (fake: FakeHoncho, session: string) => fake.state.messages.get(`${WS}/${session}`) ?? [];
const noAutoCreated = (fake: FakeHoncho) =>
  [...fake.state.sessions.values()].every((s) => s.auto_created === undefined);

// ===========================================================================
// spool: single-replayer marker + rename takeover (E1 as amended)
// ===========================================================================

describe("R-T6a-S spool protocol", () => {
  test("marker held: replay SKIPS promptly without touching any file (no wait, no rename)", async () => {
    const { dir, paths } = mkSpool();
    try {
      await spoolAppend(paths, entry("k1"));
      mkdirSync(markerPath(paths), { mode: 0o700 });
      const t0 = Date.now();
      const { client, calls } = stub();
      const r = await replay(paths, client);
      expect(Date.now() - t0).toBeLessThan(200); // skip, don't wait
      expect(r).toEqual({ sent: 0, remaining: 1, failed: null, dead: 0, deadDropped: 0 });
      expect(calls.length).toBe(0);
      expect(linesOf(livePath(paths)).length).toBe(1); // live untouched
      expect(existsSync(rPath(paths))).toBe(false); // not even renamed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stale marker (60 s) is taken over once; a fresh one never is; marker released after a full drain", async () => {
    const { dir, paths } = mkSpool();
    try {
      await spoolAppend(paths, entry("s1"));
      mkdirSync(markerPath(paths), { mode: 0o700 });
      const r1 = await replay(paths, stub().client);
      expect(r1.sent).toBe(0); // fresh foreign marker: skip
      expect(linesOf(livePath(paths)).length).toBe(1);
      const past = new Date(Date.now() - 61_000);
      utimesSync(markerPath(paths), past, past);
      const r2 = await replay(paths, stub().client);
      expect(r2.sent).toBe(1); // stale takeover
      expect(existsSync(markerPath(paths))).toBe(false); // released on success
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crash leftover drained BEFORE live is taken; single call delivers leftover-then-live in order", async () => {
    const { dir, paths } = mkSpool();
    try {
      // simulate the crash the architect asked about: rename happened, replay
      // file left behind; a newer entry then landed in a new live file.
      mkdirSync(join(dir, WS, "spool"), { recursive: true, mode: 0o700 });
      writeFileSync(rPath(paths), [entry("old1"), entry("old2")].map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
      writeFileSync(livePath(paths), JSON.stringify(entry("new1")) + "\n", { mode: 0o600 });
      const { client, calls } = stub();
      const r = await replay(paths, client);
      expect(r.sent).toBe(3);
      expect(calls.filter((c) => c.op === "messages").map((c) => c.arg)).toEqual(["old1", "old2", "new1"]);
      expect(existsSync(rPath(paths))).toBe(false);
      expect(linesOf(livePath(paths))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an append landing mid-replay survives untouched and is sent by the NEXT replay, exactly once", async () => {
    const { dir, paths } = mkSpool();
    try {
      await spoolAppend(paths, entry("m1"));
      const slow = stub({ delayMs: 400 });
      const rp = replay(paths, slow.client, { max: 5 });
      await new Promise((r) => setTimeout(r, 100));
      await spoolAppend(paths, entry("m2")); // lands while m1 is in flight
      const r1 = await rp;
      expect(r1.sent).toBe(1);
      expect(linesOf(livePath(paths)).map((l) => (JSON.parse(l) as SpoolEntry).session)).toEqual(["m2"]);
      const r2 = await replay(paths, slow.client);
      expect(r2.sent).toBe(1);
      expect(linesOf(livePath(paths))).toEqual([]);
      const sentSessions = slow.calls.filter((c) => c.op === "messages").map((c) => c.arg);
      expect(sentSessions).toEqual(["m1", "m2"]); // exactly-once each, old order
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("misconfiguration 404-everything: replay stops and KEEPS the backlog byte-for-byte; fixing the URL drains it (no dead file this pin)", async () => {
    const { dir, paths } = mkSpool();
    const fake = await startFakeHoncho();
    try {
      const broken = createClient({ url: fake.url.replace(/\/v3$/, ""), workspace: WS, apiKey: "k", timeoutMs: 1500 });
      for (const s of ["x1", "x2", "x3"]) {
        const out = await sendOrSpool(paths, broken, s, [{ peer_id: "p1", content: `body-${s}` }]);
        expect(out.result).toBe("spooled"); // every call 404s -> http -> kept
      }
      const before = linesOf(livePath(paths));
      expect(before.length).toBe(3);
      const r = await replay(paths, broken);
      expect(r.sent).toBe(0);
      expect(r.remaining).toBe(3);
      expect(r.failed?.kind).toBe("http");
      // backlog fully preserved (in the replay file after takeover), zero delivered
      expect([...linesOf(rPath(paths)), ...linesOf(livePath(paths))].sort()).toEqual([...before].sort());
      expect(existsSync(join(dir, WS, "spool", "p1.dead.jsonl"))).toBe(false); // dead is T5b-fix-2
      expect(noAutoCreated(fake)).toBe(true); // nothing reached the server at all
      const rFixed = await replay(paths, createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 1500 }));
      expect(rFixed.sent).toBe(3);
      expect(stored(fake, "x1").length + stored(fake, "x2").length + stored(fake, "x3").length).toBe(3);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("peer ids never reach the filesystem: append/replay/sendOrSpool all refuse and create nothing", async () => {
    const { dir } = mkSpool();
    try {
      for (const bad of ["../evil", "a/b", "p peer", "", "x".repeat(101), ".."]) {
        const paths = { stateDir: dir, workspace: WS, peer: bad };
        expect(await spoolAppend(paths, entry("v"))).toBe(0);
        const rr = await replay(paths, stub().client);
        expect(rr.failed?.kind).toBe("unknown");
        const out = await sendOrSpool(paths, {
          addMessages: async () => ({ ok: false, error: "x", kind: "connect" }) } as never, "s", []);
        expect(out.result).toBe("spooled");
        if (out.result === "spooled") expect(out.error).toContain("cannot spool");
      }
      // not a single file or dir was created under the state dir
      expect(existsSync(join(dir, WS))).toBe(false);
      expect(existsSync(join(dir, "spool"))).toBe(false);
      expect(existsSync(join(dir, "evil.jsonl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("256 KB split: multi-message writes split across entries, order contiguous, every line within budget", async () => {
    const { dir, paths } = mkSpool();
    try {
      const msgs = [1, 2, 3, 4, 5].map((i) => ({
        peer_id: "p1",
        content: `c${i}:` + "x".repeat(100_000),
        metadata: { client_id: `cid-${i}` } }));
      await spoolAppend(paths, { session: "sp", messages: msgs, maybe_sent: false, at: FIXED_TS });
      const lines = linesOf(livePath(paths));
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) expect(Buffer.byteLength(l + "\n")).toBeLessThanOrEqual(SPOOL_ENTRY_MAX_BYTES);
      const flat = lines.flatMap((l) => (JSON.parse(l) as SpoolEntry).messages.map((m) => m.content.slice(0, 2)));
      expect(flat).toEqual(["c1:", "c2:", "c3:", "c4:", "c5:"].map((s) => s.slice(0, 2)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one message over 256 KB is dropped, siblings survive in order; O1: no narration in the log", async () => {
    const { dir, paths } = mkSpool();
    try {
      const msgs = [
        { peer_id: "p1", content: "keep1", metadata: { client_id: "k1" } },
        { peer_id: "p1", content: "y".repeat(300_000), metadata: { client_id: "big" } },
        { peer_id: "p1", content: "keep2", metadata: { client_id: "k2" } },
      ];
      await spoolAppend(paths, { session: "sp", messages: msgs, maybe_sent: false, at: FIXED_TS });
      const flat = linesOf(livePath(paths)).flatMap((l) => (JSON.parse(l) as SpoolEntry).messages.map((m) => m.content));
      expect(flat).toEqual(["keep1", "keep2"]);
      // O1 silence (architect fix 19:50Z #1) is UNCHANGED: a pure spool
      // append writes NOTHING to the workspace log. T8c-fix changed O2:
      // drops are now COUNTED inside spoolAppend (every loss counted,
      // qitem -20261028215021 flip), creating missing seat state.
      expect(readLog(dir)).toBe("");
      const stats = statsFrom(readSeatState(seatStatePath(dir, WS, "p1")));
      expect(stats.dropped).toBe(1); // the 300 KB message, counted where lost
      expect(stats.sanitized).toBe(0);
      expect(stats.written).toBe(0); // a pure append never counts as written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sanitize: an unserializable metadata key is dropped, the message survives; O1: no narration in the log", async () => {
    const { dir, paths } = mkSpool();
    try {
      const meta: Record<string, unknown> = { client_id: "ok-1", good: 1 };
      meta.self = meta;
      await spoolAppend(paths, { session: "sm", messages: [{ peer_id: "p1", content: "hi", metadata: meta }], maybe_sent: false, at: FIXED_TS });
      const lines = linesOf(livePath(paths));
      expect(lines.length).toBe(1);
      const m = (JSON.parse(lines[0] as string) as SpoolEntry).messages[0];
      expect(m.content).toBe("hi");
      expect((m.metadata as Record<string, unknown>).good).toBe(1);
      expect((m.metadata as Record<string, unknown>).client_id).toBe("ok-1");
      expect(m.metadata).not.toHaveProperty("self");
      // O1 silence kept (fix 19:50Z #1); T8c-fix now COUNTS the sanitized
      // key: exactly one unserializable metadata key, nothing else.
      expect(readLog(dir)).toBe("");
      const stats = statsFrom(readSeatState(seatStatePath(dir, WS, "p1")));
      expect(stats.sanitized).toBe(1); // the self-referencing key, counted
      expect(stats.dropped).toBe(0); // the message itself survived
      expect(stats.written).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replay runs ensure BEFORE messages: createSession -> addSessionPeers -> addMessages; a failed create stops before any message", async () => {
    const { dir, paths } = mkSpool();
    try {
      const withEnsure: SpoolEntry = {
        ...entry("en1"),
        ensure: {
          create: { id: "en1", peers: { owner: { observe_me: true } }, scopes: ["general"] },
          addPeers: { sendx: { observe_me: true, observe_others: false } } } };
      await spoolAppend(paths, withEnsure);
      const { client, calls } = stub();
      const r = await replay(paths, client);
      expect(r.sent).toBe(1);
      expect(calls.map((c) => c.op)).toEqual(["create", "peers", "messages"]);

      const { dir: d2, paths: p2 } = mkSpool();
      try {
        await spoolAppend(p2, withEnsure);
        const bad = stub({ fail: (op) => op === "create" });
        const r2 = await replay(p2, bad.client);
        expect(r2.sent).toBe(0);
        expect(bad.calls.map((c) => c.op)).toEqual(["create"]); // no messages after a failed create
        expect(r2.remaining).toBe(1);
        expect(linesOf(rPath(p2)).length).toBe(1); // kept for retry
      } finally {
        rmSync(d2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// writer (recordPrompt) against the fake server
// ===========================================================================

describe("R-T6a-W writer pipeline", () => {
  test("replay runs BEFORE the new write: outage entries reach the server first, in order, none auto-created", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      fake.mode("refuse");
      await recordPrompt({ prompt: dm("dev-a", `first body ${"f".repeat(50)}`), claudeSessionId: "c1" }, config, deps);
      await recordPrompt({ prompt: dm("dev-a", `second body ${"s".repeat(50)}`) }, config, deps);
      fake.mode("ok");
      await recordPrompt({ prompt: dm("dev-a", `third body ${"t".repeat(50)}`) }, config, deps);
      // seat state was missing during the outage and list refused: n fell back
      // to unix(now) => the session id carries FIXED_SEC, not 1
      const session = `lead--general--${FIXED_SEC}`;
      const bodies = stored(fake, session).map((m) => m.content as string);
      expect(bodies.map((b) => b.slice(0, 5))).toEqual(["first", "secon", "third"]);
      expect(noAutoCreated(fake)).toBe(true);
      const firstMsgIdx = fake.requests.findIndex((r) => r.path.endsWith("/messages"));
      const createIdx = fake.requests.findIndex((r) => r.method === "POST" && r.path === `/v3/workspaces/${WS}/sessions`);
      expect(createIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeLessThan(firstMsgIdx);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mid-session sender is addSessionPeers-ed BEFORE its first message", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      await recordPrompt({ prompt: dm("dev-a", "alpha message content here"), claudeSessionId: "c1" }, config, deps);
      await recordPrompt({ prompt: dm("dev-b", "beta message content here") }, config, deps);
      const seq = fake.requests.map((r) => `${r.method} ${r.path.split("/").slice(4).join("/")}`);
      const peersIdx = seq.findIndex((s) => s.includes("/peers"));
      const betaMsgIdx = fake.requests.findIndex(
        (r) => r.path.endsWith("/messages") && JSON.stringify(r.body).includes("beta message"),
      );
      expect(peersIdx).toBeLessThan(betaMsgIdx);
      expect(peersIdx).toBeGreaterThanOrEqual(0);
      expect(stored(fake, "lead--general--1").map((m) => m.peer_id)).toEqual(["dev-a", "dev-b"]);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F-T6a-1 recheck: a leader seat given HONCHO_LEADER_PEER reasons on broadcasts (E4) - FIXED at aa23a0b", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("rev-t6a-leader-");
    try {
      const body = `From: dev-x@${WS}\nTo: broadcast to ${WS}\n---\nteam wide update body, long enough to reason\n---\n↩ Reply: rig send x "..."`;
      const stdinFile = join(dir, "in.json");
      writeFileSync(stdinFile, JSON.stringify({ prompt: body, session_id: "c1" }));
      const proc = Bun.spawn([process.execPath, BIN], {
        stdin: Bun.file(stdinFile),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HONCHO_ENABLED: "1",
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: WS,
          HONCHO_PEER: "lead",
          HONCHO_OWNER_PEER: "owner",
          HONCHO_API_KEY: "k",
          HONCHO_STATE_DIR: dir,
          HONCHO_LEADER_PEER: "lead" } });
      await proc.exited;
      const msgs = stored(fake, "lead--general--1");
      expect(msgs.length).toBe(1); // the write itself works
      const conf = msgs[0]?.configuration as { reasoning?: { enabled?: boolean } } | undefined;
      // ADR-0005 E4: on a broadcast, the LEADER's copy reasons. At 58bde75
      // this was RED (F-T6a-1: env.ts never parsed HONCHO_LEADER_PEER and
      // writer.ts never passed leaderPeer); the T6a-fix wires both ends.
      // T8d-3 retarget (qitem -20261029003356): reasoning-true now OMITS the
      // configuration entirely - only suppression rides the wire.
      expect(conf).toBeUndefined();
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multi fan-out wiring: only the sort-first recipient seat reasons (self first -> true, self second -> false)", async () => {
    const trailer = `\n---\n↩ Reply: rig send x "..."`;
    const a = await mkWriter();
    try {
      const prompt = `From: dev-x@${WS}\nTo: lead@${WS}, zzz@${WS}\n---\nshared fan-out content, long enough${trailer}`;
      await recordPrompt({ prompt, claudeSessionId: "c1" }, a.config, a.deps);
      const m = stored(a.fake, "lead--general--1")[0];
      expect(m).toBeDefined();
      expect(m.configuration).toBeUndefined(); // T8d-3: true omits configuration
    } finally {
      await a.fake.stop();
      rmSync(a.dir, { recursive: true, force: true });
    }
    const b = await mkWriter();
    try {
      const prompt = `From: dev-x@${WS}\nTo: aaa@${WS}, lead@${WS}\n---\nshared fan-out content, long enough${trailer}`;
      await recordPrompt({ prompt, claudeSessionId: "c1" }, b.config, b.deps);
      const m = stored(b.fake, "lead--general--1")[0];
      expect(m).toBeDefined();
      // suppression is the ONLY shape that rides the wire (T8d-3)
      expect((m.configuration as { reasoning: { enabled: boolean } }).reasoning.enabled).toBe(false);
    } finally {
      await b.fake.stop();
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  test("free-n with pre-seeded sessions: numeric max wins, junk ids ignored; the next new conversation comes from counters, not a re-list", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      const seed = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      for (const id of ["lead--general--1", "lead--general--9", "lead--general--7x", "zzz--general--500"]) {
        await seed.createSession(id, { peers: {}, scopes: ["general"] });
      }
      mkdirSync(join(dir, WS, "seats"), { recursive: true, mode: 0o700 });
      writeFileSync(seatStatePath(dir, WS, "lead"), "{ broken json", { mode: 0o600 }); // corrupt = missing
      await recordPrompt({ prompt: dm("dev-a", "free n body content here"), claudeSessionId: "c1" }, config, deps);
      expect(stored(fake, "lead--general--10").length).toBe(1); // max 9 (7x ignored, other peer ignored) + 1
      // a different claude_session_id WITHOUT a startup/clear source does NOT
      // mint a new session (ADR-0002: new-on-startup is the SessionStart hook's
      // source-tagged trigger; UserPromptSubmit never sources) - documented here
      await recordPrompt({ prompt: dm("dev-a", "second free n body"), claudeSessionId: "c2" }, config, deps);
      expect(stored(fake, "lead--general--10").length).toBe(2);
      expect(fake.state.sessions.has(`${WS}/lead--general--11`)).toBe(false);
      // mission change DOES mint one, from counters: general has 10, slice-07 starts at 1
      const { setRigMission } = await import("../../plugin/src/missions.ts");
      await setRigMission(dir, WS, "slice-07", "review");
      await recordPrompt({ prompt: dm("dev-a", "mission switched body here") }, config, deps);
      expect(stored(fake, "lead--slice-07--1").length).toBe(1);
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sessions/list failing: n = unix seconds of the injected now, session created with metadata.n_fallback, message lands", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      fake.failPattern("/sessions/list");
      await recordPrompt({ prompt: dm("dev-a", "fallback n body content here"), claudeSessionId: "c1" }, config, deps);
      const session = `lead--general--${FIXED_SEC}`;
      expect(stored(fake, session).length).toBe(1);
      const create = fake.requests.find((r) => r.method === "POST" && r.path === `/v3/workspaces/${WS}/sessions`);
      expect((create?.body as { metadata?: Record<string, unknown> })?.metadata).toMatchObject({ n_fallback: true });
      expect(readSeatState(seatStatePath(dir, WS, "lead"))?.n).toBe(FIXED_SEC);
      fake.failPattern(null);
      // with valid state now present, a later prompt does NOT re-run free-n
      await recordPrompt({ prompt: dm("dev-a", "follow up body content here") }, config, deps);
      expect(stored(fake, session).length).toBe(2);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ensure failure spools WITH creation params; the recovery replay creates properly - no auto-created session ever", async () => {
    const { fake, dir, config } = await mkWriter();
    try {
      const calls: Call[] = [];
      const brokenStub = {
        listScopeSessions: async () => ({ ok: true, data: { items: [], total: 0 } }),
        // T6c-fix: free-n now asks listSessions (metadata filter); empty pages
        // let it mint n=1 and reach the ensure stage, where this stub breaks
        listSessions: async () => ({ ok: true, data: { items: [], total: 0 } }),
        createSession: async (s: string) => {
          calls.push({ op: "create", arg: s });
          return { ok: false, error: "stub", kind: "connect" as const };
        },
        addSessionPeers: async (s: string) => {
          calls.push({ op: "peers", arg: s });
          return { ok: false, error: "stub", kind: "connect" as const };
        },
        addMessages: async (s: string) => {
          calls.push({ op: "messages", arg: s });
          return { ok: false, error: "stub", kind: "connect" as const };
        } };
      const out = await recordPrompt(
        { prompt: dm("dev-a", "body to recover later via replay"), claudeSessionId: "c1" },
        config,
        { client: brokenStub as never, now: () => FIXED_TS },
      );
      expect(out.action).toBe("spooled");
      expect(calls).toEqual([{ op: "create", arg: "lead--general--1" }]); // create attempted, never messages
      // recovery: a real replay against the fake
      const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      const r = await replay({ stateDir: dir, workspace: WS, peer: "lead" }, client);
      expect(r.sent).toBe(1);
      expect(noAutoCreated(fake)).toBe(true);
      // created via ensure.create (scoped), not implicitly by the message
      expect(fake.state.scopes.get(`${WS}/general`) ?? []).toContain("lead--general--1");
      expect(stored(fake, "lead--general--1").length).toBe(1);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two processes of one seat at once: both prompts land, one session, seat state stays valid", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("rev-t6a-2p-");
    try {
      const env = {
        HONCHO_ENABLED: "1",
        HONCHO_URL: fake.url,
        HONCHO_WORKSPACE: WS,
        HONCHO_PEER: "lead",
        HONCHO_OWNER_PEER: "owner",
        HONCHO_API_KEY: "k",
        HONCHO_STATE_DIR: dir };
      const run = async (body: string, id: string) => {
        const f = join(dir, `in-${id}.json`);
        writeFileSync(f, JSON.stringify({ prompt: dm("dev-a", body), session_id: "c1" }));
        const p = Bun.spawn([process.execPath, BIN], { stdin: Bun.file(f), stdout: "pipe", stderr: "pipe", env });
        return p.exited;
      };
      const [c1, c2] = await Promise.all([run(`race body alpha ${"a".repeat(80)}`, "1"), run(`race body beta ${"b".repeat(80)}`, "2")]);
      expect(c1).toBe(0);
      expect(c2).toBe(0);
      const msgs = stored(fake, "lead--general--1");
      expect(msgs.length).toBe(2); // both wrote, none lost
      expect(noAutoCreated(fake)).toBe(true);
      expect(readSeatState(seatStatePath(dir, WS, "lead"))).not.toBeNull();
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redaction runs on the WHOLE text before the chunk cut: a secret straddling the 24 000 boundary never reaches the server", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      // non-hex fillers: long a/b/e runs are themselves hex64-shaped and
      // would legitimately redact the padding (probed: 24k of 'a' -> [REDACTED:hex64])
      const body = dm("dev-a", "z".repeat(23_995) + ANTH + "y".repeat(60));
      await recordPrompt({ prompt: body, claudeSessionId: "c1" }, config, deps);
      const msgs = stored(fake, "lead--general--1");
      expect(msgs.length).toBeGreaterThan(1);
      for (const m of msgs) expect(String(m.content)).not.toContain(ANTH.slice(0, 20));
      const rejoined = msgs.map((m) => m.content).join("");
      expect(rejoined).toContain("[REDACTED:anthropic]");
      expect(rejoined.match(/\[REDACTED:anthropic\]/g)?.length).toBe(1);
      const ids = new Set(msgs.map((m) => (m.metadata as { chunk?: { id: string } }).chunk?.id));
      expect(ids.size).toBe(1); // one chunk id shared by all pieces
      const ns = new Set(msgs.map((m) => (m.metadata as { chunk?: { n: number } }).chunk?.n));
      expect(ns.size).toBe(1);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("S1 end to end: a client whose every call rejects yields action=skipped and a log line, never an exception", async () => {
    const { dir, config } = await mkWriter();
    try {
      const exploding = {
        listScopeSessions: async () => {
          throw new Error("boom list");
        },
        createSession: async () => {
          throw new Error("boom create");
        },
        addSessionPeers: async () => {
          throw new Error("boom peers");
        },
        addMessages: async () => {
          throw new Error("boom send");
        } };
      let threw = false;
      let action = "";
      try {
        const out = await recordPrompt({ prompt: dm("dev-a", "never throws body here") }, config, {
          client: exploding as never,
          now: () => FIXED_TS });
        action = out.action;
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(action).toBe("skipped");
      expect(readLog(dir)).toContain("unexpected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
