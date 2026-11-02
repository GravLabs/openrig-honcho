// T5b: the write spool against the FAKE server only (ADR-0005 E1,
// ADR-0006 R1/R2). The fake is driven through the real client so the failure
// kinds sendOrSpool switches on are the real ones.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, mkdirSync, readFileSync, statSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { createClient, type HonchoClient } from "../../plugin/src/honcho.ts";
import { clientId } from "../../plugin/src/shape.ts";
import {
  SPOOL_DEAD_MAX_BYTES,
  SPOOL_MAX_BYTES,
  replay,
  sendOrSpool,
  spoolAppend,
  type SpoolEntry,
  type SpoolPaths } from "../../plugin/src/spool.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

/** Minimal client stub for replay-only tests (ensure calls succeed). */
const okStubClient = (
  onMessages: (session: string, msgs: Array<{ content?: unknown }>) => Promise<void>,
): HonchoClient =>
  ({
    createSession: async () => ({ ok: true, data: {} }),
    addSessionPeers: async () => ({ ok: true, data: {} }),
    addMessages: async (session: string, msgs: Array<{ content?: unknown }>) => {
      await onMessages(session, msgs);
      return { ok: true, data: [] };
    } }) as unknown as HonchoClient;

const tmp = (): string => makeTempDir("spool-test-");

const mkPaths = (dir: string): SpoolPaths => ({ stateDir: dir, workspace: "ws", peer: "build" });
const spoolFileOf = (dir: string): string => join(dir, "ws", "spool", "build.jsonl");
// rename-takeover: entries live in the live file or the taken-over replay file
const spoolFilesOf = (dir: string): string[] => [
  spoolFileOf(dir),
  join(dir, "ws", "spool", "build.replay.jsonl"),
];

const msg = (peerId: string, content: string, seat = "build", session = "s1") => ({
  peer_id: peerId,
  content,
  metadata: { client_id: clientId(seat, session, "2026-10-28T10:00:00Z", content) } });

const spoolEntries = (dir: string): SpoolEntry[] =>
  spoolFilesOf(dir).flatMap((f) => {
    let raw: string;
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as SpoolEntry);
  });

describe("sendOrSpool + replay (E1/R1/R2)", () => {
  test("outage (refuse): 5 spooled, maybe_sent false; after ok, replay delivers all 5 in order and empties the spool", async () => {
    const dir = tmp();
    const fake: FakeHoncho = await startFakeHoncho();
    try {
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      fake.mode("refuse");
      const paths = mkPaths(dir);
      for (let i = 0; i < 5; i++) {
        const out = await sendOrSpool(paths, client, "s1", [msg("build", `m${i}`)]);
        expect(out.result).toBe("spooled");
        if (out.result === "spooled") {
          expect(out.kind).toBe("connect");
          expect(out.maybe_sent).toBe(false);
        }
      }
      expect(spoolEntries(dir).length).toBe(5);

      fake.mode("ok");
      // recovery: the hook layer ensures the session exists before replaying
      expect((await client.createSession("s1", { peers: { build: { observe_me: true } } })).ok).toBe(true);
      const r = await replay(paths, client);
      expect(r.failed).toBeNull();
      expect(r.sent).toBe(5);
      expect(r.remaining).toBe(0);
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
      expect(spoolEntries(dir).length).toBe(0); // both spool files drained
    } finally {
      await fake.stop();
    }
  });

  test("500 then ok: spooled with maybe_sent false, replays in order", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      fake.mode("500");
      const paths = mkPaths(dir);
      for (let i = 0; i < 5; i++) {
        const out = await sendOrSpool(paths, client, "s1", [msg("build", `m${i}`)]);
        expect(out.result).toBe("spooled");
        if (out.result === "spooled") {
          expect(out.kind).toBe("http");
          expect(out.maybe_sent).toBe(false);
        }
      }
      fake.mode("ok");
      expect((await client.createSession("s1", { peers: { build: { observe_me: true } } })).ok).toBe(true);
      const r = await replay(paths, client);
      expect(r.sent).toBe(5);
      expect(r.remaining).toBe(0);
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
      // plain-failure replays carry NO replay_of (only maybe_sent entries do)
      expect(stored.every((m) => (m.metadata as Record<string, unknown>)?.replay_of === undefined)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("hang (timeout): spooled maybe_sent true; replay sends with metadata.replay_of = client_id", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      fake.mode("hang");
      const slow = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 300 });
      const out = await sendOrSpool(paths, slow, "s1", [msg("build", "hung")]);
      expect(out.result).toBe("spooled");
      if (out.result === "spooled") {
        expect(out.kind).toBe("timeout");
        expect(out.maybe_sent).toBe(true);
      }
      expect(spoolEntries(dir)[0].maybe_sent).toBe(true);

      fake.mode("ok");
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      expect((await client.createSession("s1", { peers: { build: { observe_me: true } } })).ok).toBe(true);
      const r = await replay(paths, client);
      expect(r.sent).toBe(1);
      expect(r.remaining).toBe(0);
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.length).toBe(1);
      const md = stored[0].metadata as Record<string, unknown>;
      expect(md.replay_of).toBe(clientId("build", "s1", "2026-10-28T10:00:00Z", "hung"));
      expect(md.client_id).toBe(md.replay_of); // original id kept alongside
    } finally {
      await fake.stop();
    }
  });

  test("replay stops at the first failure and keeps the rest in order", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      fake.mode("500"); // every write fails http -> spooled
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      for (let i = 0; i < 3; i++) await sendOrSpool(paths, client, "s1", [msg("build", `m${i}`)]);
      expect(spoolEntries(dir).length).toBe(3);

      // still failing (500 = http): replay stops at the FIRST entry, order kept.
      // (Since T6a the fake auto-creates like the real server, so a missing
      // session no longer fails; mode 500 is the http failure here.)
      const r = await replay(paths, client);
      expect(r.failed?.kind).toBe("http");
      expect(r.sent).toBe(0);
      expect(r.remaining).toBe(3);
      expect(spoolEntries(dir).map((e) => e.messages[0].content)).toEqual(["m0", "m1", "m2"]);

      // recovery, then everything lands in original order
      fake.mode("ok");
      await client.createSession("s1", { peers: { build: { observe_me: true } } });
      const r2 = await replay(paths, client);
      expect(r2.sent).toBe(3);
      expect(r2.remaining).toBe(0);
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["m0", "m1", "m2"]);
    } finally {
      await fake.stop();
    }
  });

  test("replay honours max and a later call drains the rest", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      fake.mode("500");
      for (let i = 0; i < 4; i++) await sendOrSpool(paths, client, "s1", [msg("build", `m${i}`)]);
      fake.mode("ok");
      await client.createSession("s1", { peers: { build: { observe_me: true } } });
      const r1 = await replay(paths, client, { max: 2 });
      expect(r1.sent).toBe(2);
      expect(r1.remaining).toBe(2);
      const r2 = await replay(paths, client);
      expect(r2.sent).toBe(2);
      expect(r2.remaining).toBe(0);
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3"]);
    } finally {
      await fake.stop();
    }
  });

  // Required by the architect's T5b-fix spec-change note (12:54Z):
  // single-replayer marker + never-write-live semantics.
  test("two concurrent replays: the marker winner sends each entry exactly once", async () => {
    const dir = tmp();
    const paths = mkPaths(dir);
    const calls: string[] = [];
    const client = okStubClient(async (_s, msgs) => {
      for (const m of msgs) calls.push(String(m.content));
      await new Promise((r) => setTimeout(r, 30));
    });
    for (let i = 0; i < 3; i++) {
      const d = await spoolAppend(paths, {
        session: "s1",
        messages: [msg("build", `c${i}`)],
        maybe_sent: false,
        at: "2026-10-28T10:00:00Z" });
      expect(d).toBe(0);
    }
    const [r1, r2] = await Promise.all([replay(paths, client, { max: 10 }), replay(paths, client, { max: 10 })]);
    expect(r1.sent + r2.sent).toBe(3);
    expect(calls.sort()).toEqual(["c0", "c1", "c2"]); // each once, none twice
    expect([r1.sent, r2.sent].some((s) => s === 0)).toBe(true); // the loser skipped, did not wait
    expect(existsSync(join(dir, "ws", "spool", "build.replaying"))).toBe(false); // marker released
    expect(existsSync(join(dir, "ws", "spool", "build.replay.jsonl"))).toBe(false);
  });

  test("crash leftover: an existing <peer>.replay.jsonl is drained before the live file is taken", async () => {
    const dir = tmp();
    const paths = mkPaths(dir);
    const spoolDir = join(dir, "ws", "spool");
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const leftover: SpoolEntry = {
      session: "s0",
      messages: [msg("build", "leftover")],
      maybe_sent: false,
      at: "2026-10-28T09:00:00Z" };
    writeFileSync(join(spoolDir, "build.replay.jsonl"), `${JSON.stringify(leftover)}\n`, { mode: 0o600 });
    expect(
      await spoolAppend(paths, { session: "s1", messages: [msg("build", "fresh")], maybe_sent: false, at: "2026-10-28T10:00:00Z" }),
    ).toBe(0);

    const calls: string[] = [];
    const client = okStubClient(async (s, msgs) => {
      for (const m of msgs) calls.push(`${s}:${String(m.content)}`);
    });
    const r1 = await replay(paths, client);
    expect(r1.sent).toBe(2);
    // leftover drained BEFORE the live file is taken: order preserved
    expect(calls).toEqual(["s0:leftover", "s1:fresh"]);
    expect(existsSync(join(spoolDir, "build.replay.jsonl"))).toBe(false);
    expect(readFileSync(join(spoolDir, "build.jsonl"), "utf8")).toBe(""); // stable empty path
    const r2 = await replay(paths, client);
    expect(r2).toEqual({ sent: 0, remaining: 0, failed: null, dead: 0, deadDropped: 0 });
  });
});

// T5b-fix-2 (qitem-20261028132301-7b95254fda552d16 item 4): HTTP status and
// poison entries. Permanent 400/413/422 dead-letter the ONE entry and keep
// going; every other failure stops the replay and keeps the backlog.
describe("poison entries and HTTP status (T5b-fix-2)", () => {
  const deadFileOf = (dir: string): string => join(dir, "ws", "spool", "build.dead.jsonl");
  const markerOf = (dir: string): string => join(dir, "ws", "spool", "build.replaying");
  const replayOf = (dir: string): string => join(dir, "ws", "spool", "build.replay.jsonl");
  const deadLines = (dir: string): SpoolEntry[] =>
    readFileSync(deadFileOf(dir), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as SpoolEntry);

  /** Stub whose addMessages always fails with a fixed http status. */
  const statusFailClient = (status: number): HonchoClient =>
    ({
      createSession: async () => ({ ok: true, data: {} }),
      addSessionPeers: async () => ({ ok: true, data: {} }),
      addMessages: async () => ({ ok: false, kind: "http", error: `forced ${status}`, status }) }) as unknown as HonchoClient;

  /** Spool n entries m0..m(n-1) through the fake by failing every write first. */
  const spoolThrough = async (
    paths: SpoolPaths,
    fake: FakeHoncho,
    n: number,
  ): Promise<void> => {
    fake.mode("500");
    const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
    for (let i = 0; i < n; i++) await sendOrSpool(paths, client, "s1", [msg("build", `m${i}`)]);
    fake.mode("ok");
  };

  test("(a) 422 on ONE message among 4: it lands in dead.jsonl, the other 3 deliver in order, replay file gone", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      await spoolThrough(paths, fake, 4);
      await client.createSession("s1", { peers: { build: { observe_me: true } } });
      fake.failPattern("/messages", { status: 422, bodyContains: "m2" });
      const r = await replay(paths, client);
      expect(r).toEqual({ sent: 3, remaining: 0, failed: null, dead: 1, deadDropped: 0 });
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["m0", "m1", "m3"]);
      expect(existsSync(replayOf(dir))).toBe(false);
      expect(existsSync(markerOf(dir))).toBe(false);
      expect(deadLines(dir).map((e) => e.messages[0].content)).toEqual(["m2"]);
      expect(statSync(deadFileOf(dir)).mode & 0o777).toBe(0o600);
    } finally {
      await fake.stop();
    }
  });

  test("(b) 404 on every request (base URL without /v3): nothing sent or dead, backlog byte-identical, marker released; fixed URL delivers all in order", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      await spoolThrough(paths, fake, 3);
      const broken = createClient({
        url: fake.url.slice(0, -"/v3".length), // the fake 404s anything not under /v3/
        workspace: "ws",
        apiKey: "k",
        timeoutMs: 2000 });
      const before = readFileSync(spoolFileOf(dir), "utf8");
      const r = await replay(paths, broken);
      expect(r.sent).toBe(0);
      expect(r.dead).toBe(0);
      expect(r.failed?.kind).toBe("http");
      expect(r.failed?.status).toBe(404);
      expect(r.remaining).toBe(3);
      expect(readFileSync(replayOf(dir), "utf8")).toBe(before); // backlog kept byte-identical
      expect(existsSync(deadFileOf(dir))).toBe(false); // 404 is NEVER a dead-letter
      expect(existsSync(markerOf(dir))).toBe(false); // released on the stop path
      expect((fake.state.messages.get("ws/s1") ?? []).length).toBe(0);

      const fixed = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      const r2 = await replay(paths, fixed);
      expect(r2.sent).toBe(3);
      expect(r2.remaining).toBe(0);
      const stored = fake.state.messages.get("ws/s1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["m0", "m1", "m2"]);
    } finally {
      await fake.stop();
    }
  });

  test("(c) 403 on every request: stop and keep, zero dead; cleared, a later replay delivers all", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      await spoolThrough(paths, fake, 3);
      fake.failPattern("/workspaces", { status: 403 });
      const r = await replay(paths, client);
      expect(r.sent).toBe(0);
      expect(r.dead).toBe(0);
      expect(r.failed?.status).toBe(403);
      expect(r.remaining).toBe(3);
      expect(existsSync(deadFileOf(dir))).toBe(false);
      expect(spoolEntries(dir).map((e) => e.messages[0].content)).toEqual(["m0", "m1", "m2"]);

      fake.failPattern(null);
      const r2 = await replay(paths, client);
      expect(r2.sent).toBe(3);
      expect(r2.remaining).toBe(0);
    } finally {
      await fake.stop();
    }
  });

  test("(d1) 413: every entry dead-letters and is counted; replay finishes with no failure", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      await spoolThrough(paths, fake, 2);
      fake.failPattern("/messages", { status: 413 });
      const r = await replay(paths, client);
      expect(r).toEqual({ sent: 0, remaining: 0, failed: null, dead: 2, deadDropped: 0 });
      expect(existsSync(replayOf(dir))).toBe(false);
      expect(deadLines(dir).map((e) => e.messages[0].content)).toEqual(["m0", "m1"]);
      expect((fake.state.messages.get("ws/s1") ?? []).length).toBe(0);
    } finally {
      await fake.stop();
    }
  });

  test("(d2) 429: stop and keep, nothing dead", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      await spoolThrough(paths, fake, 3);
      fake.failPattern("/messages", { status: 429 });
      const r = await replay(paths, client);
      expect(r.sent).toBe(0);
      expect(r.dead).toBe(0);
      expect(r.failed?.kind).toBe("http");
      expect(r.failed?.status).toBe(429);
      expect(r.remaining).toBe(3);
      expect(existsSync(deadFileOf(dir))).toBe(false);
      expect(spoolEntries(dir).map((e) => e.messages[0].content)).toEqual(["m0", "m1", "m2"]);
    } finally {
      await fake.stop();
    }
  });

  test("(e) dead cap: >1 MB of dead entries -> file <= 1 MB, oldest dropped and counted", async () => {
    const dir = tmp();
    const paths = mkPaths(dir);
    const big = (tag: string): SpoolEntry => ({
      session: "s1",
      messages: [{ peer_id: "build", content: `${tag}:${"q".repeat(150_000)}`, metadata: { client_id: `c-${tag}` } }],
      maybe_sent: false,
      at: "2026-10-28T10:00:00Z" });
    for (let i = 0; i < 8; i++) expect(await spoolAppend(paths, big(`e${i}`))).toBe(0); // ~1.2 MB, under the live cap
    const r = await replay(paths, statusFailClient(413));
    expect(r.dead).toBe(8);
    expect(r.deadDropped).toBeGreaterThan(0);
    expect(r.sent).toBe(0);
    expect(r.remaining).toBe(0);
    expect(statSync(deadFileOf(dir)).size).toBeLessThanOrEqual(SPOOL_DEAD_MAX_BYTES);
    const kept = deadLines(dir);
    expect(kept.length).toBe(8 - r.deadDropped);
    // newest entries survive the trim, in original order
    expect(kept[kept.length - 1].messages[0].content.startsWith("e7:")).toBe(true);
    expect(kept.map((e) => (e.messages[0].content as string).slice(0, 2))).toEqual(
      kept.map((_, k) => `e${8 - kept.length + k}`),
    );
  });
});

describe("spoolAppend cap (E1)", () => {
  test("past 5 MB the oldest lines drop; count > 0 and file stays <= 5 MB", async () => {
    const dir = tmp();
    const paths = mkPaths(dir);
    const file = spoolFileOf(dir);
    mkdirSync(join(dir, "ws", "spool"), { recursive: true, mode: 0o700 });

    const big: SpoolEntry = {
      session: "s1",
      messages: [{ peer_id: "build", content: "c".repeat(1000), metadata: { client_id: "x" } }],
      maybe_sent: false,
      at: "2026-10-28T10:00:00Z" };
    const lineBytes = Buffer.byteLength(`${JSON.stringify(big)}\n`, "utf8");
    // pre-fill ~6 MB so appending one more forces drops
    writeFileSync(file, Array.from({ length: Math.ceil((6 * 1024 * 1024) / lineBytes) }, () => JSON.stringify(big)).join("\n") + "\n", { mode: 0o600 });

    const dropped = await spoolAppend(paths, { ...big, messages: [{ peer_id: "build", content: "newest", metadata: { client_id: "n" } }] });
    expect(dropped).toBeGreaterThan(0);
    expect(statSync(file).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES);
    const tail = readFileSync(file, "utf8").trim().split("\n").pop() as string;
    expect((JSON.parse(tail) as SpoolEntry).messages[0].content).toBe("newest");
  });
});

describe("spool file hygiene (X4)", () => {
  test("spool file is mode 0600", async () => {
    const dir = tmp();
    const fake = await startFakeHoncho();
    try {
      const paths = mkPaths(dir);
      fake.mode("refuse");
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 500 });
      await sendOrSpool(paths, client, "s1", [msg("build", "x")]);
      expect(existsSync(spoolFileOf(dir))).toBe(true);
      expect(statSync(spoolFileOf(dir)).mode & 0o777).toBe(0o600);
    } finally {
      await fake.stop();
    }
  });
});
