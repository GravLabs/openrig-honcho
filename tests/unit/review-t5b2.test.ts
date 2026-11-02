// dev.review battery for T5b-fix-2 (poison routing + HTTP status: spool.ts,
// honcho.ts, fake-honcho.ts at a25e418) and the T6a-fix leaderPeer env checks
// (env.ts at aa23a0b). Pin: aa23a0b (qitem-20261028141345-9029ae2957ac317d).
// Matrix (i)-(vi) as acked with the architect.
// Contract: ADR-0005 E1 poison entries ("permanent = 400/413/422 on a MESSAGE
// send; ensure failures never dead-letter, at any status") + ADR-0006 R1
// (order holds among DELIVERED; permanent rejects are dead and counted) +
// ADR-0001/E4 leaderPeer.
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
import { loadConfig } from "../../plugin/src/env.ts";
import {
  replay,
  sendOrSpool,
  spoolAppend,
  SPOOL_DEAD_MAX_BYTES,
  type SpoolEntry } from "../../plugin/src/spool.ts";
import type { ErrorKind, HonchoClient, MessageInput } from "../../plugin/src/honcho.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";

// ---------- helpers ----------

type Paths = { stateDir: string; workspace: string; peer: string };

const mkState = (): { dir: string; paths: Paths } => {
  const dir = makeTempDir("rev-t5b2-");
  return { dir, paths: { stateDir: dir, workspace: "ws", peer: "p1" } };
};
const livePath = (p: Paths): string => join(p.stateDir, p.workspace, "spool", `${p.peer}.jsonl`);
const rPath = (p: Paths): string =>
  join(p.stateDir, p.workspace, "spool", `${p.peer}.replay.jsonl`);
const markerPath = (p: Paths): string =>
  join(p.stateDir, p.workspace, "spool", `${p.peer}.replaying`);
const deadPath = (p: Paths): string =>
  join(p.stateDir, p.workspace, "spool", `${p.peer}.dead.jsonl`);
const linesOf = (path: string): string[] => {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
};

const entry = (session: string, content?: string): SpoolEntry => ({
  session,
  messages: [
    {
      peer_id: "p1",
      content: content ?? `body-${session}`,
      metadata: { client_id: `cid-${session}` } },
  ],
  maybe_sent: false,
  at: "2026-10-28T12:00:00.000Z" });

type Res =
  | { ok: true; data: unknown }
  | { ok: false; error: string; kind: ErrorKind; status?: number };

type Call = { session: string; messages: MessageInput[] };
type EnsureCall = { stage: "create" | "peers"; id: string };

/** Stub with all three ensure/send stages; each handler may return a failure. */
const mkClient = (h: {
  messages?: (session: string) => Res;
  create?: (id: string) => Res;
  addPeers?: (session: string) => Res;
}): { client: HonchoClient; calls: Call[]; ensureCalls: EnsureCall[] } => {
  const calls: Call[] = [];
  const ensureCalls: EnsureCall[] = [];
  const ok: Res = { ok: true, data: {} };
  const client = {
    createSession: async (id: string): Promise<Res> => {
      ensureCalls.push({ stage: "create", id });
      return h.create ? h.create(id) : ok;
    },
    addSessionPeers: async (session: string): Promise<Res> => {
      ensureCalls.push({ stage: "peers", id: session });
      return h.addPeers ? h.addPeers(session) : ok;
    },
    addMessages: async (session: string, messages: MessageInput[]): Promise<Res> => {
      calls.push({ session, messages });
      return h.messages ? h.messages(session) : ok;
    } } as unknown as HonchoClient;
  return { client, calls, ensureCalls };
};

const httpFail = (status: number): Res => ({
  ok: false,
  error: `server replied ${status}`,
  kind: "http",
  status });

// ---------- (i)+(v): message-stage poison ----------

describe("R-E1 poison routing: addMessages 400/413/422 (matrix i, v)", () => {
  for (const status of [400, 413, 422]) {
    test(`(i) ${status} dead-letters ONLY that entry; replay continues; deliveries stay in order`, async () => {
      const { dir, paths } = mkState();
      try {
        const entries = ["c1", "c2", "c3"].map((s) => entry(s));
        for (const e of entries) await spoolAppend(paths, e);
        // poison c2 only
        const { client, calls } = mkClient({
          messages: (s) => (s === "c2" ? httpFail(status) : { ok: true, data: {} }) });
        const r = await replay(paths, client);
        expect(r).toEqual({ sent: 2, remaining: 0, failed: null, dead: 1, deadDropped: 0 });
        // (v) ADR-0006 R1: attempts run strict spool order (calls include the
        // failed c2 attempt; the SENT set is c1,c3 — nothing reordered, nothing retried)
        expect(calls.map((c) => c.session)).toEqual(["c1", "c2", "c3"]);
        // dead file holds exactly the poisoned entry, byte-recoverable
        const dl = linesOf(deadPath(paths));
        expect(dl.length).toBe(1);
        expect(JSON.parse(dl[0] as string)).toEqual(entries[1]);
        // spool hygiene: replay file gone, live recreated empty, marker released
        expect(existsSync(rPath(paths))).toBe(false);
        expect(linesOf(livePath(paths))).toEqual([]);
        expect(existsSync(markerPath(paths))).toBe(false);
        // dead file modes like the rest of the spool
        expect((statSync(deadPath(paths)).mode & 0o777).toString(8)).toBe("600");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("(v) poisons in the MIDDLE of a 5-entry run then transient stop: kept suffix intact, dead holds only poisons", async () => {
    const { dir, paths } = mkState();
    try {
      const ids = ["m1", "m2", "m3", "m4", "m5"];
      for (const s of ids) await spoolAppend(paths, entry(s));
      const { client, calls } = mkClient({
        messages: (s) =>
          s === "m2" || s === "m3"
            ? httpFail(422)
            : s === "m5"
              ? httpFail(503)
              : { ok: true, data: {} } });
      const r = await replay(paths, client);
      expect(r).toEqual({
        sent: 2,
        remaining: 1,
        failed: { kind: "http", error: "server replied 503", status: 503 },
        dead: 2,
        deadDropped: 0 });
      // attempts in strict spool order (m2/m3/m5 attempts recorded, failures aside)
      expect(calls.map((c) => c.session)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
      // m5 (transient) stays as the ONLY leftover; m2/m3 are dead, not kept
      expect(linesOf(rPath(paths)).map((l) => (JSON.parse(l) as SpoolEntry).session)).toEqual(["m5"]);
      const dead = linesOf(deadPath(paths)).map((l) => (JSON.parse(l) as SpoolEntry).session);
      expect(dead).toEqual(["m2", "m3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("all-poison spool never wedges replay: dead counts everything, sent 0, failed null, spool drains", async () => {
    const { dir, paths } = mkState();
    try {
      for (const s of ["z1", "z2", "z3"]) await spoolAppend(paths, entry(s));
      const { client } = mkClient({ messages: () => httpFail(400) });
      const r = await replay(paths, client);
      expect(r).toEqual({ sent: 0, remaining: 0, failed: null, dead: 3, deadDropped: 0 });
      expect(linesOf(deadPath(paths)).length).toBe(3);
      expect(existsSync(rPath(paths))).toBe(false);
      expect(existsSync(markerPath(paths))).toBe(false);
      // and a second replay finds nothing (no re-sends of dead content)
      const again = mkClient({ messages: () => httpFail(400) });
      const r2 = await replay(paths, again.client);
      expect(r2).toEqual({ sent: 0, remaining: 0, failed: null, dead: 0, deadDropped: 0 });
      expect(again.calls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("budget + poison: a poison consumes its max slot; max:1 with a poison head drains nothing else, keeps the rest", async () => {
    const { dir, paths } = mkState();
    try {
      for (const s of ["b1", "b2", "b3"]) await spoolAppend(paths, entry(s));
      const { client, calls } = mkClient({
        messages: (s) => (s === "b1" ? httpFail(400) : { ok: true, data: {} }) });
      const r = await replay(paths, client, { max: 1 });
      expect(r).toEqual({ sent: 0, remaining: 2, failed: null, dead: 1, deadDropped: 0 });
      expect(calls.map((c) => c.session)).toEqual(["b1"]); // budget spent on the poison attempt
      expect(linesOf(rPath(paths)).length).toBe(2); // b2,b3 kept for the next hook
      expect(existsSync(markerPath(paths))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(i-contrast) 408 and 429 are TRANSIENT: stop and keep, nothing dead", async () => {
    for (const status of [408, 429]) {
      const { dir, paths } = mkState();
      try {
        for (const s of ["t1", "t2"]) await spoolAppend(paths, entry(s));
        const { client, calls } = mkClient({
          messages: (s) => (s === "t2" ? httpFail(status) : { ok: true, data: {} }) });
        const r = await replay(paths, client);
        expect(r).toEqual({
          sent: 1,
          remaining: 1,
          failed: { kind: "http", error: `server replied ${status}`, status },
          dead: 0,
          deadDropped: 0 });
        expect(calls.map((c) => c.session)).toEqual(["t1", "t2"]);
        expect(existsSync(deadPath(paths))).toBe(false);
        expect(linesOf(rPath(paths)).length).toBe(1); // t2 kept for later
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("documented: a first-send 400 SPOOLS now and dead-letters on the NEXT replay (no immediate loss)", async () => {
    const { dir, paths } = mkState();
    try {
      const out = await sendOrSpool(paths, {
        addMessages: async () => httpFail(400) } as unknown as HonchoClient, "s1", entry("s1").messages);
      expect(out.result).toBe("spooled"); // spooled, NOT silently dead-lettered at first send
      expect(linesOf(livePath(paths)).length).toBe(1);
      // next replay confirms the poison and dead-letters it (bounded delay, counted)
      const { client } = mkClient({ messages: () => httpFail(400) });
      const r = await replay(paths, client);
      expect(r.dead).toBe(1);
      expect(r.remaining).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- (ii): ensure-stage failures never dead-letter ----------

describe("R-E1 ensure failures (matrix ii): 400/413/422 keep + stop, dead stays empty", () => {
  for (const status of [400, 413, 422]) {
    test(`createSession ${status}: entry kept, replay stops, dead untouched even when a dead file pre-exists`, async () => {
      const { dir, paths } = mkState();
      try {
        const e = entry("e1");
        e.ensure = { create: { id: "e1", peers: { p1: {} } } };
        await spoolAppend(paths, e);
        // a pre-existing dead file must not gain a line
        mkdirSync(join(paths.stateDir, paths.workspace, "spool"), { recursive: true, mode: 0o700 });
        writeFileSync(deadPath(paths), `${JSON.stringify(entry("old"))}\n`, { mode: 0o600 });
        const { client, calls, ensureCalls } = mkClient({ create: () => httpFail(status) });
        const r = await replay(paths, client);
        expect(r).toEqual({
          sent: 0,
          remaining: 1,
          failed: { kind: "http", error: `server replied ${status}` },
          dead: 0,
          deadDropped: 0 });
        expect(calls.length).toBe(0); // never messages after a failed ensure
        expect(ensureCalls).toEqual([{ stage: "create", id: "e1" }]);
        expect(linesOf(rPath(paths)).length).toBe(1); // entry KEPT
        expect(linesOf(deadPath(paths)).length).toBe(1); // only the pre-existing line
        expect(existsSync(markerPath(paths))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`addSessionPeers ${status}: entry kept, replay stops, dead stays empty`, async () => {
      const { dir, paths } = mkState();
      try {
        const e = entry("e2");
        e.ensure = { create: { id: "e2", peers: {} }, addPeers: { p1: {} } };
        await spoolAppend(paths, e);
        const { client, calls, ensureCalls } = mkClient({ addPeers: () => httpFail(status) });
        const r = await replay(paths, client);
        expect(r).toEqual({
          sent: 0,
          remaining: 1,
          failed: { kind: "http", error: `server replied ${status}` },
          dead: 0,
          deadDropped: 0 });
        expect(calls.length).toBe(0);
        expect(ensureCalls).toEqual([
          { stage: "create", id: "e2" },
          { stage: "peers", id: "e2" },
        ]);
        expect(existsSync(deadPath(paths))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ---------- (iv): dead cap 1 MB, oldest-drop, counted, modes ----------

describe("R-E1 dead-letter cap (matrix iv): 1 MB, oldest dropped, counted, recoverable", () => {
  test("8 x ~200KB poisons: dead stays <= 1 MB, newest survive, dropped counted, modes 0600/0700", async () => {
    const { dir, paths } = mkState();
    try {
      // hand-write the replay file so each entry can exceed the 256KB APPEND cap
      mkdirSync(join(paths.stateDir, paths.workspace, "spool"), { recursive: true, mode: 0o700 });
      const lines: string[] = [];
      for (let i = 0; i < 8; i++) {
        lines.push(`${JSON.stringify(entry(`d${i}`, "z".repeat(200_000)))}\n`);
      }
      writeFileSync(rPath(paths), lines.join(""), { mode: 0o600 });
      const { client } = mkClient({ messages: () => httpFail(400) });
      const r = await replay(paths, client);
      expect(r.dead).toBe(8);
      expect(r.sent).toBe(0);
      expect(r.failed).toBeNull();
      const kept = linesOf(deadPath(paths));
      const size = statSync(deadPath(paths)).size;
      expect(size).toBeLessThanOrEqual(SPOOL_DEAD_MAX_BYTES);
      // every kept line is a parseable, byte-recoverable SpoolEntry
      const keptSessions = kept.map((l) => (JSON.parse(l) as SpoolEntry).session);
      // oldest dropped: kept sessions are a SUFFIX of d0..d7
      const start = 8 - kept.length;
      expect(keptSessions).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"].slice(start));
      // cap actually trimmed and the count is honest
      expect(kept.length).toBeLessThan(8);
      expect(r.deadDropped).toBe(8 - kept.length);
      expect(r.deadDropped).toBeGreaterThan(0);
      // modes: file 0600 inside the 0700 spool dir
      expect((statSync(deadPath(paths)).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(join(paths.stateDir, paths.workspace, "spool")).mode & 0o777).toString(8)).toBe("700");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- (vi): marker released on every route ----------

describe("R-E1 marker release (matrix vi)", () => {
  test("no-budget / bad-peer routes never CREATE a marker", async () => {
    const { dir, paths } = mkState();
    try {
      await spoolAppend(paths, entry("k1"));
      const rPast = await replay(paths, mkClient({}).client, { deadlineMs: Date.now() - 1 });
      expect(rPast.dead).toBe(0);
      expect(existsSync(markerPath(paths))).toBe(false);
      const bad = { ...paths, peer: "bad peer!" };
      const rBad = await replay(bad, mkClient({}).client);
      expect(rBad.failed).not.toBeNull();
      expect(existsSync(markerPath(bad))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every completing route releases the marker: transient stop, poison-continue, full drain, stale takeover", async () => {
    const { dir, paths } = mkState();
    try {
      // transient stop
      await spoolAppend(paths, entry("a1"));
      await replay(paths, mkClient({ messages: () => httpFail(503) }).client);
      expect(existsSync(markerPath(paths))).toBe(false);

      // poison-continue
      await spoolAppend(paths, entry("b1"));
      await replay(paths, mkClient({ messages: () => httpFail(400) }).client);
      expect(existsSync(markerPath(paths))).toBe(false);

      // full drain (ok)
      await replay(paths, mkClient({}).client);
      expect(existsSync(markerPath(paths))).toBe(false);

      // stale takeover: foreign marker older than 60 s
      mkdirSync(markerPath(paths), { mode: 0o700 });
      const past = new Date(Date.now() - 61_000);
      utimesSync(markerPath(paths), past, past);
      await spoolAppend(paths, entry("c1"));
      const r = await replay(paths, mkClient({}).client);
      expect(r.sent).toBe(1);
      expect(existsSync(markerPath(paths))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- (iii): status carried through honcho.ts for real ----------

describe("R-E1 status propagation (matrix iii): honcho.ts + fake server", () => {
  test("every poison/stop status arrives as kind='http' with its exact status", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = createClient({
        url: fake.url,
        workspace: "honcho-bridge-scratch",
        apiKey: "test-key", // fake-secret
        timeoutMs: 2000 });
      for (const status of [400, 401, 403, 404, 408, 413, 422, 429, 500]) {
        fake.failPattern("/messages", { status });
        const r = await client.addMessages("s1", [
          { peer_id: "p1", content: `s${status}` },
        ]);
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect(r.kind).toBe("http");
        expect(r.status).toBe(status);
      }
      fake.failPattern(null);
    } finally {
      await fake.stop();
    }
  });

  test("non-http failures carry NO status: connect on a dead port", async () => {
    const fake = await startFakeHoncho();
    const url = fake.url;
    await fake.stop(); // frees the port: the next call cannot connect
    const client = createClient({ url, workspace: "honcho-bridge-scratch", apiKey: "k", timeoutMs: 2000 });
    const r = await client.addMessages("s1", [{ peer_id: "p1", content: "x" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("connect");
      expect(r.status).toBeUndefined();
    }
  });

  test("replay classifies from the REAL client: 422 poisons via HTTP, 503 stops via HTTP", async () => {
    const fake = await startFakeHoncho();
    const { dir, paths } = mkState();
    try {
      await spoolAppend(paths, entry("real-poison", "body-poison"));
      await spoolAppend(paths, entry("real-stop", "body-stop"));
      const client = createClient({
        url: fake.url,
        workspace: "honcho-bridge-scratch",
        apiKey: "test-key", // fake-secret
        timeoutMs: 2000 });
      fake.failPattern("/messages", { status: 422, bodyContains: "body-poison" });
      const r = await replay(paths, client);
      expect(r.dead).toBe(1);
      expect(r.sent).toBe(1); // real-stop delivered
      expect(r.remaining).toBe(0);
      expect(r.failed).toBeNull();
      expect(linesOf(deadPath(paths)).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });
});

// ---------- T6a-fix: leaderPeer env (ADR-0001/E4) ----------

describe("R-E4 leaderPeer env (T6a-fix)", () => {
  const base = {
    HONCHO_URL: "http://127.0.0.1:8002/v3",
    HONCHO_WORKSPACE: "honcho-bridge-scratch",
    HONCHO_PEER: "build-1",
    HONCHO_STATE_DIR: "/tmp/rev-t5b2-state" };

  test("unset -> undefined (no broadcast reasoning anywhere by default)", () => {
    const c = loadConfig({ ...base });
    expect(c.enabled).toBe(true);
    if (c.enabled) expect(c.leaderPeer).toBeUndefined();
  });

  test("HONCHO_LEADER_PEER set -> that value", () => {
    const c = loadConfig({ ...base, HONCHO_LEADER_PEER: "lead" });
    if (!c.enabled) throw new Error(c.reason);
    expect(c.leaderPeer).toBe("lead");
  });

  test("HONCHO_OBSERVE_OTHERS=true without it -> HONCHO_PEER (observer is its own leader)", () => {
    const c = loadConfig({ ...base, HONCHO_OBSERVE_OTHERS: "true" });
    if (!c.enabled) throw new Error(c.reason);
    expect(c.leaderPeer).toBe("build-1");
  });

  test("explicit leader beats the observer default", () => {
    const c = loadConfig({ ...base, HONCHO_OBSERVE_OTHERS: "true", HONCHO_LEADER_PEER: "lead" });
    if (!c.enabled) throw new Error(c.reason);
    expect(c.leaderPeer).toBe("lead");
  });

  test("invalid value -> Disabled naming HONCHO_LEADER_PEER", () => {
    const c = loadConfig({ ...base, HONCHO_LEADER_PEER: "bad leader!" });
    expect(c.enabled).toBe(false);
    if (!c.enabled) expect(c.reason).toContain("HONCHO_LEADER_PEER");
  });

  test("empty string behaves as unset", () => {
    const c = loadConfig({ ...base, HONCHO_LEADER_PEER: "  " });
    if (!c.enabled) throw new Error(c.reason);
    expect(c.leaderPeer).toBeUndefined();
  });
});
