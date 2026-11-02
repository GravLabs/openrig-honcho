// dev.review battery for T5b (shape.ts, spool.ts) + T2b (fake-honcho.ts).
// Written at pin 681fdb9 (4 findings, all ruled FIX); REFRESHED at re-review
// pin 58bde75 (qitem-20261028132315-299d995a88551ed9): the F-T5b-1..4 tests
// now assert the fixed behaviour (verified green), and six assertions that
// encoded pre-fix behaviour were retargeted to the ruling (E1 rename-takeover
// per 20e0ce5, whole-text E5 acks per 3773077, fake auto-create per T6a).
// REFRESHED again at pin aa23a0b (T5b-fix-2): the strict ReplayResult toEqual
// sites gained dead: 0, deadDropped: 0; the poison matrix itself lives in
// review-t5b2.test.ts. Scope-list test retargeted at ed55995 (T6c fake mirrors
// the real server: unknown scope 404, size>100 422) - maintenance retarget,
// asked for by architect and build; T6c verdict rides its own pin.
// Contract: ADR-0005 E1/E2/E4/E5; ADR-0006 R1/R2/S1/S2/S3/X4.
// Local tmp dirs + 127.0.0.1 fakes only; no real server, no secrets.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunk, isAck, reasoningFor, clientId, MAX_CHUNK } from "../../plugin/src/shape.ts";
import {
  spoolAppend,
  replay,
  sendOrSpool,
  SPOOL_MAX_BYTES,
  type SpoolEntry } from "../../plugin/src/spool.ts";
import type { ErrorKind, HonchoClient, MessageInput } from "../../plugin/src/honcho.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const PLUGIN_DIR = fileURLToPath(new URL("../../plugin/src/", import.meta.url));

// ---------- helpers ----------

type Paths = { stateDir: string; workspace: string; peer: string };

const mkState = (): { dir: string; paths: Paths } => {
  const dir = makeTempDir("rev-t5b-");
  return { dir, paths: { stateDir: dir, workspace: "ws", peer: "p1" } };
};
const spoolPath = (p: Paths): string => join(p.stateDir, p.workspace, "spool", `${p.peer}.jsonl`);
const fileLines = (p: Paths): string[] => {
  try {
    return readFileSync(spoolPath(p), "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
};
// T5b-fix: the replay file (rename takeover), not the live file, holds the
// entries a running/stopped replay is working through.
const replayLines = (p: Paths): string[] => {
  try {
    return readFileSync(join(p.stateDir, p.workspace, "spool", `${p.peer}.replay.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l !== "");
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
  at: new Date().toISOString() });

type Call = { session: string; messages: MessageInput[] };
type Res = { ok: true; data: unknown } | { ok: false; error: string; kind: ErrorKind };

const stubClient = (
  behavior?: (n: number, call: Call) => Promise<Res>,
): { client: HonchoClient; calls: Call[] } => {
  const calls: Call[] = [];
  let n = 0;
  const client = {
    addMessages: async (session: string, messages: MessageInput[]): Promise<Res> => {
      n++;
      const call = { session, messages };
      calls.push(call);
      if (behavior) return behavior(n, call);
      return { ok: true, data: [] };
    } } as unknown as HonchoClient;
  return { client, calls };
};

const failWith = (kind: ErrorKind): Promise<Res> =>
  Promise.resolve({ ok: false, error: `fake ${kind}`, kind });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const HIGH = "[\uD800-\uDBFF]";
const LOW = "[\uDC00-\uDFFF]";
const LONE_HIGH = new RegExp(`${HIGH}(?!${LOW})`);
const LONE_LOW = new RegExp(`(^|[^${HIGH.slice(1, -1)}])${LOW}`);
const loneSurrogate = (s: string): boolean => LONE_HIGH.test(s) || LONE_LOW.test(s);

// ===========================================================================
// shape.ts - E2 chunking
// ===========================================================================

describe("R-T5b-1 chunk boundaries", () => {
  test("24000 stays one chunk; 24001 splits, every chunk <= max, rejoin equal", () => {
    const at = "z".repeat(MAX_CHUNK);
    expect(chunk(at).length).toBe(1);
    const over = "z".repeat(MAX_CHUNK + 1);
    const cs = chunk(over);
    expect(cs.length).toBe(2);
    expect(cs.every((c) => c.length <= MAX_CHUNK)).toBe(true);
    expect(cs.join("")).toBe(over);
  });

  test("60 000-char single line: hard cuts 24000/24000/12000, rejoin equal", () => {
    const t = "q".repeat(60_000);
    const cs = chunk(t);
    expect(cs.map((c) => c.length)).toEqual([24000, 24000, 12000]);
    expect(cs.join("")).toBe(t);
  });

  test("paragraph path falls to line path when one paragraph is oversized; then hard cut", () => {
    const bigPara = "l1\nl2\n" + "m".repeat(30_000); // one paragraph, big, has lines inside
    const text = "short para\n\n" + bigPara + "\n\nlast";
    const cs = chunk(text);
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.length <= MAX_CHUNK)).toBe(true);
    expect(cs.join("")).toBe(text);
    // no chunk contains an oversized unit intact: the 30 000 m-run is split
    expect(cs.some((c) => c.includes("m".repeat(24_001)))).toBe(false);
  });

  test("FINDING F-T5b-1: hard cut must not split a surrogate pair (E2: every chunk is a sendable message)", () => {
    // 23 999 code units, then a non-BMP emoji straddling the 24 000 cut.
    const text = "a".repeat(23_999) + "\u{1F642}" + "b".repeat(100);
    const cs = chunk(text);
    expect(cs.join("")).toBe(text);
    // Each chunk is sent as a standalone Honcho message (E2). A chunk that
    // ends with a lone high surrogate is not well-formed text: a JSON/UTF-8
    // consumer may reject the write outright, and a permanently-rejected
    // entry at the spool head blocks all later replays (R1 jam).
    expect(cs.some(loneSurrogate)).toBe(false);
  });

  test("fuzz 2000 randoms: rejoin equal, none over max, no empty chunks in a multi-chunk split", () => {
    const alpha = ["a", "bb", "\n", "\n\n", "\u{1F642}", "word ", "x".repeat(30)];
    let seed = 12345;
    const rnd = (): number => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
    for (let n = 0; n < 2000; n++) {
      const max = 1 + Math.floor(rnd() * 40);
      let text = "";
      const parts = 1 + Math.floor(rnd() * 60);
      for (let i = 0; i < parts; i++) text += alpha[Math.floor(rnd() * alpha.length)];
      if (text.length <= max) continue;
      const cs = chunk(text, max);
      expect(cs.join("")).toBe(text);
      expect(cs.every((c) => c.length <= max)).toBe(true);
      if (cs.length > 1) expect(cs.some((c) => c === "")).toBe(false);
    }
  });

  test("degenerate max values clamp to 1 and still rejoin", () => {
    const t = "a\n\nb";
    for (const bad of [0, -5, Number.NaN]) {
      const cs = chunk(t, bad);
      expect(cs.join("")).toBe(t);
      expect(cs.every((c) => c.length <= 1)).toBe(true);
    }
  });
});

// ===========================================================================
// shape.ts - E5 acks, E4 fan-out, R2 client_id
// ===========================================================================

describe("R-T5b-2 isAck (E5)", () => {
  test("ack forms are acks", () => {
    for (const t of ["ok", "OK.", "done", "ack", "Acked!", "thanks", "standing by", "ready", "noted", "T4-fix-2 ready", "T12 ready."])
      expect(isAck(t)).toBe(true);
  });

  test("length and sentence forms are not acks", () => {
    expect(isAck("a".repeat(40))).toBe(false); // >= 40 never acks
    expect(isAck("x".repeat(39) + "!")).toBe(false); // 40 after trim still >= 40
    expect(isAck("no, stop")).toBe(false);
    expect(isAck("done? check X")).toBe(false);
    expect(isAck("The migration failed, done?")).toBe(false);
    expect(isAck("T1 ready now")).toBe(false); // safe direction: reasoning stays on
    expect(isAck("")).toBe(false);
  });

  test("ruled E5 (obs a FIXED): a sentence ending in 'done' is not an ack; only 1-2 word '<x> done' reports are", () => {
    // Ruling 3773077 (whole-text acks): the retargeted assertion.
    expect(isAck("Auth bug is not done")).toBe(false);
    expect(isAck("the migration for the auth bug is done")).toBe(false);
    expect(isAck("T2b done")).toBe(true); // 1-2 word report still acks
    expect(isAck("migration done.")).toBe(true);
    expect(isAck("spool replay drain done")).toBe(false); // 3 words before done: ruled 1-2 only
    expect(isAck("ok")).toBe(true);
  });
});

describe("R-T5b-3 reasoningFor (E4)", () => {
  const C = "real content that is long enough";

  test("dm reasons unless ack", () => {
    expect(reasoningFor({ kind: "dm", to: ["b"], selfPeer: "b", content: C })).toBe(true);
    expect(reasoningFor({ kind: "dm", to: ["b"], selfPeer: "b", content: "ok" })).toBe(false);
  });

  test("multi: duplicate recipients still one winner; self outside To never reasons; empty/broken To false", () => {
    expect(reasoningFor({ kind: "multi", to: ["b", "a", "b"], selfPeer: "a", content: C })).toBe(true);
    expect(reasoningFor({ kind: "multi", to: ["b", "a", "b"], selfPeer: "b", content: C })).toBe(false);
    expect(reasoningFor({ kind: "multi", to: ["a", "b"], selfPeer: "c", content: C })).toBe(false);
    expect(reasoningFor({ kind: "multi", to: [], selfPeer: "a", content: C })).toBe(false);
    expect(reasoningFor({ kind: "multi", to: null as unknown as string[], selfPeer: "a", content: C })).toBe(false);
  });

  test("broadcast: leader only; leader-sent => everyone; unknown leader => nobody", () => {
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "L", leaderPeer: "L", senderPeer: "x", content: C })).toBe(true);
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "x", leaderPeer: "L", senderPeer: "x", content: C })).toBe(false);
    // leader is the sender: every recipient reasons
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "x", leaderPeer: "L", senderPeer: "L", content: C })).toBe(true);
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "L", leaderPeer: "L", senderPeer: "L", content: C })).toBe(true);
    // leader unset: cannot know => nobody reasons (safe)
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "L", leaderPeer: undefined, senderPeer: "L", content: C })).toBe(false);
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "x", leaderPeer: undefined, senderPeer: "L", content: C })).toBe(false);
  });

  test("ack kills reasoning in every kind; unknown kind false", () => {
    const ack = "ok";
    expect(reasoningFor({ kind: "multi", to: ["a"], selfPeer: "a", content: ack })).toBe(false);
    expect(reasoningFor({ kind: "broadcast", to: [], selfPeer: "L", leaderPeer: "L", senderPeer: "L", content: ack })).toBe(false);
    expect(
      reasoningFor({ kind: "carrier-pigeon" as "dm", to: [], selfPeer: "a", content: C }),
    ).toBe(false);
  });
});

describe("R-T5b-4 clientId (R2)", () => {
  test("64-hex, deterministic, each part matters", () => {
    const a = clientId("seat", "sess--1", "2026-10-28T12:00:00.000Z", "body");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(clientId("seat", "sess--1", "2026-10-28T12:00:00.000Z", "body")).toBe(a);
    expect(clientId("Seat", "sess--1", "2026-10-28T12:00:00.000Z", "body")).not.toBe(a);
    expect(clientId("seat", "sess--2", "2026-10-28T12:00:00.000Z", "body")).not.toBe(a);
    expect(clientId("seat", "sess--1", "2026-10-28T12:00:00.001Z", "body")).not.toBe(a);
    expect(clientId("seat", "sess--1", "2026-10-28T12:00:00.000Z", "body!")).not.toBe(a);
  });

  test("1000 pseudo-random tuples never collide", () => {
    let seed = 7;
    const rnd = (): number => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      set.add(clientId(`s${Math.floor(rnd() * 50)}`, `sess-${Math.floor(rnd() * 100)}`, `t${Math.floor(rnd() * 700)}`, `c${i}`));
    }
    expect(set.size).toBe(1000);
  });
});

// ===========================================================================
// spool.ts - E1 / R1 / R2
// ===========================================================================

describe("R-T5b-5 sendOrSpool", () => {
  test("success: no file, result sent", async () => {
    const { dir, paths } = mkState();
    try {
      const { client, calls } = stubClient();
      const r = await sendOrSpool(paths, client, "s1", [{ peer_id: "p1", content: "hi" }]);
      expect(r.result).toBe("sent");
      expect(calls.length).toBe(1);
      expect(calls[0].messages[0].metadata).not.toHaveProperty("replay_of");
      expect(fileLines(paths)).toEqual([]);
      expect(() => statSync(spoolPath(paths))).toThrow(); // never created
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maybe_sent mapping per ErrorKind (R2): connect/http false; timeout/parse/unknown true", async () => {
    for (const [kind, maybe] of [
      ["connect", false],
      ["http", false],
      ["timeout", true],
      ["parse", true],
      ["unknown", true],
    ] as [ErrorKind, boolean][]) {
      const { dir, paths } = mkState();
      try {
        const { client } = stubClient(() => failWith(kind));
        const r = await sendOrSpool(paths, client, "s1", [{ peer_id: "p1", content: "hi" }]);
        expect(r.result).toBe("spooled");
        if (r.result === "spooled") {
          expect(r.maybe_sent).toBe(maybe);
          expect(r.kind).toBe(kind);
          expect(r.dropped).toBe(0);
        }
        const lines = fileLines(paths);
        expect(lines.length).toBe(1);
        expect((JSON.parse(lines[0] as string) as SpoolEntry).maybe_sent).toBe(maybe);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("entry preserves session, messages byte-equal through JSON, ISO at", async () => {
    const { dir, paths } = mkState();
    try {
      const { client } = stubClient(() => failWith("connect"));
      const msgs: MessageInput[] = [
        { peer_id: "p1", content: "u\u{1F642}nicode é", created_at: "2026-10-28T12:00:00.000Z", metadata: { client_id: "cid-x", chunk: { id: "c1", i: 0, n: 2 } } },
        { peer_id: "p1", content: "second" },
      ];
      const before = structuredClone(msgs);
      await sendOrSpool(paths, client, "dev-review--general--1", msgs);
      const e = JSON.parse(fileLines(paths)[0] as string) as SpoolEntry;
      expect(e.session).toBe("dev-review--general--1");
      expect(e.messages).toEqual(before);
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FINDING F-T5b-4 (minor, S1): a circular metadata value must not throw out of spoolAppend", async () => {
    const { dir, paths } = mkState();
    try {
      const meta: Record<string, unknown> = { a: 1 };
      meta.self = meta;
      let threw = false;
      try {
        await spoolAppend(paths, { session: "s", messages: [{ peer_id: "p1", content: "x", metadata: meta }], maybe_sent: false, at: new Date().toISOString() });
      } catch {
        threw = true;
      }
      // spool.ts header + ADR-0006 S1: public functions never throw.
      expect(threw).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R-T5b-6 replay: R1/R2 semantics", () => {
  test("outage then recovery: all delivered once, in order, to their own sessions; spool empty; replay again sends nothing", async () => {
    const { dir, paths } = mkState();
    try {
      for (const s of ["e1", "e2", "e3"]) await spoolAppend(paths, entry(s));
      const { client, calls } = stubClient();
      const r = await replay(paths, client);
      expect(r).toEqual({ sent: 3, remaining: 0, failed: null, dead: 0, deadDropped: 0 });
      expect(calls.map((c) => c.session)).toEqual(["e1", "e2", "e3"]);
      expect(calls.map((c) => c.messages[0].content)).toEqual(["body-e1", "body-e2", "body-e3"]);
      expect(fileLines(paths)).toEqual([]);
      const second = stubClient();
      const r2 = await replay(paths, second.client);
      expect(r2).toEqual({ sent: 0, remaining: 0, failed: null, dead: 0, deadDropped: 0 });
      expect(second.calls.length).toBe(0); // no duplicate traffic once drained
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stops at first failure: failed entry and all after stay in the REPLAY file, in order (rename-takeover retarget)", async () => {
    const { dir, paths } = mkState();
    try {
      for (const s of ["e1", "e2", "e3", "e4"]) await spoolAppend(paths, entry(s));
      const { client } = stubClient((n) => (n === 2 ? failWith("http") : Promise.resolve({ ok: true, data: [] })));
      const r = await replay(paths, client);
      expect(r.sent).toBe(1);
      expect(r.remaining).toBe(3);
      expect(r.failed).toEqual({ kind: "http", error: "fake http" });
      // T5b-fix ruling: unsent entries live in <peer>.replay.jsonl; the live
      // file is never rewritten (and here was renamed away).
      expect(replayLines(paths).map((l) => (JSON.parse(l) as SpoolEntry).session)).toEqual(["e2", "e3", "e4"]);
      expect(fileLines(paths)).toEqual([]);
      // marker released even on the stopped path
      expect(existsSync(join(dir, "ws", "spool", "p1.replaying"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replay_of only on maybe_sent entries and only where client_id exists; absent entries pass through untouched", async () => {
    const { dir, paths } = mkState();
    try {
      const maybe = entry("m1");
      maybe.maybe_sent = true;
      const maybeNoCid: SpoolEntry = { session: "m2", messages: [{ peer_id: "p1", content: "no-cid" }], maybe_sent: true, at: new Date().toISOString() };
      const notMaybe = entry("m3");
      await spoolAppend(paths, maybe);
      await spoolAppend(paths, maybeNoCid);
      await spoolAppend(paths, notMaybe);
      const { client, calls } = stubClient();
      const r = await replay(paths, client);
      expect(r.sent).toBe(3);
      expect(calls[0].messages[0].metadata).toMatchObject({ client_id: "cid-m1", replay_of: "cid-m1" });
      expect(calls[1].messages[0].metadata).toBeUndefined(); // no client_id => no replay_of, no throw
      expect(calls[2].messages[0].metadata).not.toHaveProperty("replay_of");
      // original spool entries were not mutated in place by the replay
      expect(maybe.messages[0].metadata).not.toHaveProperty("replay_of");
      expect(fileLines(paths)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("budget: already-passed deadline sends nothing and is not a failure; mid-replay stop keeps the rest; default max is 50", async () => {
    const { dir, paths } = mkState();
    try {
      for (let i = 0; i < 5; i++) await spoolAppend(paths, entry(`b${i}`));
      const past = stubClient();
      const rPast = await replay(paths, past.client, { deadlineMs: Date.now() - 1 });
      expect(rPast).toEqual({ sent: 0, remaining: 5, failed: null, dead: 0, deadDropped: 0 });
      expect(past.calls.length).toBe(0);
      expect(fileLines(paths).length).toBe(5);

      const slow = stubClient(async () => {
        await sleep(40);
        return { ok: true, data: [] };
      });
      const rMid = await replay(paths, slow.client, { deadlineMs: Date.now() + 90 });
      expect(rMid.sent).toBeGreaterThanOrEqual(1);
      expect(rMid.sent).toBeLessThanOrEqual(4);
      expect(rMid.failed).toBeNull(); // a deadline stop is not a failure
      expect(rMid.remaining).toBe(5 - rMid.sent);
      // retarget (rename takeover): the stopped remainder is in the replay file
      expect(replayLines(paths).length).toBe(5 - rMid.sent);
      expect(fileLines(paths)).toEqual([]);
      expect(existsSync(join(dir, "ws", "spool", "p1.replaying"))).toBe(false); // released

      // 60 entries: default max 50
      const { dir: d2, paths: p2 } = mkState();
      try {
        for (let i = 0; i < 60; i++) await spoolAppend(p2, entry(`s${i}`));
        const c2 = stubClient();
        const r50 = await replay(p2, c2.client);
        expect(r50.sent).toBe(50);
        expect(r50.remaining).toBe(10);
        const rMax0 = await replay(p2, stubClient().client, { max: 0 });
        expect(rMax0.sent).toBe(0);
        expect(rMax0.remaining).toBe(10);
      } finally {
        rmSync(d2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R-T5b-7 spool file robustness", () => {
  test("S2: missing / corrupt / torn-last-line files are skipped, valid entries replay in order, never throws", async () => {
    const { dir, paths } = mkState();
    try {
      // missing file
      const r0 = await replay(paths, stubClient().client);
      expect(r0).toEqual({ sent: 0, remaining: 0, failed: null, dead: 0, deadDropped: 0 });

      // valid + garbage interleaved + torn (unterminated) last line
      mkdirSync(join(dir, "ws", "spool"), { recursive: true, mode: 0o700 });
      const good = (s: string): string => JSON.stringify(entry(s));
      writeFileSync(spoolPath(paths), `${good("g1")}\nnot json at all\n${good("g2")}\n{"session":"trunc","mess`, { mode: 0o600 });
      const { client, calls } = stubClient();
      const r = await replay(paths, client);
      expect(r.sent).toBe(2);
      expect(calls.map((c) => c.session)).toEqual(["g1", "g2"]);
      expect(r.remaining).toBe(0);

      // spool path is a directory: never throws
      rmSync(spoolPath(paths), { recursive: true });
      mkdirSync(spoolPath(paths), { mode: 0o700 });
      const r2 = await replay(paths, stubClient().client);
      expect(r2.failed).toBeNull();
      const dropped = await spoolAppend(paths, entry("x"));
      expect(dropped).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("12 concurrent appends: every line intact and present (no interleave, no lost line)", async () => {
    const { dir, paths } = mkState();
    try {
      await Promise.all(Array.from({ length: 12 }, (_, i) => spoolAppend(paths, entry(`c${i}`))));
      const lines = fileLines(paths);
      expect(lines.length).toBe(12);
      const sessions = lines.map((l) => (JSON.parse(l) as SpoolEntry).session).sort();
      expect(sessions).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("5 MB cap: never exceeded after a locked append, drops are oldest-first and reported, newest survives", async () => {
    const { dir, paths } = mkState();
    try {
      const content = "x".repeat(100_000);
      let droppedTotal = 0;
      for (let i = 0; i < 60; i++) droppedTotal += await spoolAppend(paths, entry(`cap-${i}`, content));
      expect(statSync(spoolPath(paths)).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES);
      const lines = fileLines(paths);
      expect(droppedTotal).toBe(60 - lines.length);
      expect(droppedTotal).toBeGreaterThan(0);
      // oldest-first: the file holds a contiguous suffix of the appends
      const sessions = lines.map((l) => (JSON.parse(l) as SpoolEntry).session);
      const lastIdx = Number(sessions[sessions.length - 1].split("-")[1]);
      expect(lastIdx).toBe(59);
      expect(sessions).toEqual(Array.from({ length: lines.length }, (_, k) => `cap-${59 - lines.length + 1 + k}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FINDING F-T5b-3: one entry larger than the cap must not push the file past 5 MB (E1 cap)", async () => {
    const { dir, paths } = mkState();
    try {
      const big: SpoolEntry = {
        session: "big",
        messages: [{ peer_id: "p1", content: "x".repeat(6_000_000) }],
        maybe_sent: false,
        at: new Date().toISOString() };
      const dropped = await spoolAppend(paths, big);
      expect(dropped).toBe(0);
      // E1: "Spool capped at 5 MB per seat." Today the file lands at 6,001,009
      // bytes with dropped=0 - the cap is not enforced for an oversized entry
      // (and such an entry also jams replay if the server ever rejects it).
      expect(statSync(spoolPath(paths)).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FINDING F-T5b-2 (R1): an append landing during a slow replay is erased by the post-accept rewrite", async () => {
    const { dir, paths } = mkState();
    try {
      await spoolAppend(paths, entry("e1"));
      // replay holds the seat lock across network calls (2.6 s here); a
      // second hook's spoolAppend waits the lock's 2 s and then bare-appends
      // (the blessed busy fallback - "never lose a message"). replay's
      // writeLines(all.slice(i+1)) then rewrites from its stale view and
      // erases that entry: it is neither on the server nor in the file.
      const slow = stubClient(async () => {
        await sleep(2600);
        return { ok: true, data: [] };
      });
      const rp = replay(paths, slow.client, { max: 5 });
      await sleep(150);
      const ap = spoolAppend(paths, entry("e2"));
      await rp;
      await ap;
      const file = readFileSync(spoolPath(paths), "utf8");
      const everSent = slow.calls.some((c) => c.messages[0].content === "body-e2");
      // R1: an outage delays memory, it doesn't lose it. e2 must be in the
      // file or delivered. Today: file is "" and e2 was never sent.
      expect(file.includes("e2") || everSent).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("crash between accept and replay-file rewrite: all entries survive in the replay file, a fresh marker makes the next replay skip, stale-marker takeover re-delivers the accepted entry once", async () => {
    // Retargeted for the rename-takeover ruling (20e0ce5). Crash point:
    // after c1 was accepted, before the unsent-rewrite of the replay file.
    const { dir, paths } = mkState();
    try {
      for (const s of ["c1", "c2", "c3"]) await spoolAppend(paths, entry(s));
      const childLog = join(dir, "child-sent.log");
      const helper = join(dir, "child.ts");
      writeFileSync(
        helper,
        [
          `import { replay } from ${JSON.stringify(join(PLUGIN_DIR, "spool.ts"))};`,
          `import { appendFileSync } from "node:fs";`,
          `const [stateDir, mk] = process.argv.slice(2);`,
          `let n = 0;`,
          `const client = { addMessages: async () => {`,
          `  appendFileSync(mk, "delivered\\n");`,
          `  if (++n === 1) process.exit(7); // crash between accept and rewrite`,
          `  return { ok: true, data: [] };`,
          `} };`,
          `await replay({ stateDir, workspace: "ws", peer: "p1" }, client as never, {});`,
        ].join("\n"),
      );
      const proc = Bun.spawn([process.execPath, helper, dir, childLog]);
      const code = await proc.exited;
      expect(code).toBe(7);
      // The child renamed live -> replay and died before the rewrite:
      // all three entries are still in the REPLAY file, live is gone.
      expect(replayLines(paths).length).toBe(3);
      expect(fileLines(paths)).toEqual([]);
      expect(readFileSync(childLog, "utf8").trim().split("\n").length).toBe(1); // c1 accepted once
      const marker = join(dir, "ws", "spool", "p1.replaying");
      expect(existsSync(marker)).toBe(true); // crashed holder left the marker

      // fresh foreign marker (< 60 s): the next replay SKIPS, never throws, loses nothing
      const skip = stubClient();
      const rSkip = await replay(paths, skip.client);
      expect(rSkip).toEqual({ sent: 0, remaining: 3, failed: null, dead: 0, deadDropped: 0 });
      expect(skip.calls.length).toBe(0);
      expect(replayLines(paths).length).toBe(3);

      // stale takeover (60 s path simulated by backdating the marker dir)
      const past = new Date(Date.now() - 61_000);
      utimesSync(marker, past, past);
      const { client, calls } = stubClient();
      const r = await replay(paths, client);
      expect(r).toEqual({ sent: 3, remaining: 0, failed: null, dead: 0, deadDropped: 0 });
      expect(calls.map((c) => c.session)).toEqual(["c1", "c2", "c3"]);
      // c1 delivered twice total (crash-duplicate: at-least-once); c2/c3 once
      const totalC1 = 1 + calls.filter((c) => c.session === "c1").length;
      expect(totalC1).toBe(2);
      // drained: replay file deleted, marker released, live re-created as an empty 0600 file
      expect(replayLines(paths)).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      expect(statSync(spoolPath(paths)).size).toBe(0);
      expect((statSync(spoolPath(paths)).mode & 0o077) >>> 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-only spool dir: append and replay degrade without throwing", async () => {
    const { dir, paths } = mkState();
    try {
      await spoolAppend(paths, entry("r1")); // creates dirs
      chmodSync(join(dir, "ws", "spool"), 0o500);
      const dropped = await spoolAppend(paths, entry("r2")); // cannot write
      expect(dropped).toBe(0); // no throw, message lost only because disk refused
      const { client } = stubClient();
      const r = await replay(paths, client); // sends ok, cannot rewrite the file
      expect(r.failed).toBeNull();
      expect(r.sent).toBeGreaterThanOrEqual(0);
      chmodSync(join(dir, "ws", "spool"), 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("X4: spool dir 0700, spool file 0600, no group/other bits anywhere under the state dir", async () => {
    const { dir, paths } = mkState();
    try {
      await spoolAppend(paths, entry("x1"));
      await replay(paths, stubClient().client);
      // every path created under the state dir (ws/...) carries no group/other bits
      const stack = [join(dir, "ws")];
      let seen = 0;
      while (stack.length > 0) {
        const p = stack.pop() as string;
        const st = statSync(p);
        seen++;
        expect((st.mode & 0o077) >>> 0).toBe(0);
        if (st.isDirectory()) for (const child of readdirSync(p)) stack.push(join(p, child));
      }
      expect(seen).toBeGreaterThanOrEqual(3); // ws, spool dir, live file
      // retarget (rename-takeover ruling): spool never touches the seat lock
      expect(existsSync(join(dir, "ws", "seats"))).toBe(false);
      expect(existsSync(join(dir, "ws", "spool", "p1.replaying"))).toBe(false); // released
      expect((statSync(join(dir, "ws", "spool")).mode & 0o777) >>> 0).toBe(0o700);
      expect((statSync(spoolPath(paths)).mode & 0o777) >>> 0).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// fake-honcho.ts - T2b
// ===========================================================================

describe("R-T2b-1 fake server behavior", () => {
  const mkClient = (fake: FakeHoncho, timeoutMs = 5000): ReturnType<typeof createClient> =>
    createClient({ url: fake.url, workspace: "ws", apiKey: "fake-not-a-secret", timeoutMs }); // fake-secret

  test("refuse -> ok -> refuse -> ok relistens on the same port each time; refused calls record nothing", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mkClient(fake, 800);
      const port1 = new URL(fake.url).port;
      for (const _cycle of [0, 1]) {
        fake.mode("refuse");
        const bad = await client.addMessages("s", [{ peer_id: "p", content: "x" }]);
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.kind).toBe("connect");
        fake.mode("ok");
        const created = await client.createSession("s", { scopes: ["general"] });
        expect(created.ok).toBe(true);
        expect(new URL(fake.url).port).toBe(port1);
      }
      // two refused calls never reached the server; the two ok ones did
      const paths = fake.requests.map((r) => r.path);
      expect(paths.filter((p) => p.includes("/messages")).length).toBe(0);
      expect(paths.filter((p) => p.endsWith("/sessions")).length).toBe(2);
    } finally {
      await fake.stop();
    }
  });

  test("hang -> client timeout kind; mode('ok') afterwards serves new requests; stop() releases the hung one", async () => {
    const fake = await startFakeHoncho();
    try {
      fake.mode("hang");
      const client = mkClient(fake, 250);
      const t0 = Date.now();
      const hung = await client.addMessages("s", [{ peer_id: "p", content: "x" }]);
      expect(hung.ok).toBe(false);
      if (!hung.ok) expect(hung.kind).toBe("timeout");
      expect(Date.now() - t0).toBeLessThan(2000);
      fake.mode("ok");
      const created = await client.createSession("s", { scopes: ["general"] });
      expect(created.ok).toBe(true); // hung waiter does not block the server
      const added = await client.addMessages("s", [{ peer_id: "p", content: "later" }]);
      expect(added.ok).toBe(true);
      await fake.stop(); // releases the abandoned waiter
      const again = await fake.stop(); // idempotent
      expect(again).toBeUndefined();
    } finally {
      /* already stopped */
    }
  });

  test("mode is sampled at arrival: a request already in flight completes, the next gets the new mode", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mkClient(fake, 3000);
      const created = await client.createSession("s", { scopes: ["general"] });
      expect(created.ok).toBe(true);
      fake.mode("slow", { delayMs: 250 });
      const inFlight = client.addMessages("s", [{ peer_id: "p", content: "was-slow" }]);
      await sleep(50);
      fake.mode("500");
      const after = await client.addMessages("s", [{ peer_id: "p", content: "is-500" }]);
      const first = await inFlight;
      expect(first.ok).toBe(true); // decided before the switch
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.kind).toBe("http");
    } finally {
      await fake.stop();
    }
  });

  test("slow(300) with client timeout 120 -> kind timeout; slow(120) with timeout 1500 -> ok", async () => {
    const fake = await startFakeHoncho();
    try {
      const created = await mkClient(fake).createSession("s", { scopes: ["general"] });
      expect(created.ok).toBe(true);
      fake.mode("slow", { delayMs: 300 });
      const to = await mkClient(fake, 120).addMessages("s", [{ peer_id: "p", content: "x" }]);
      expect(to.ok).toBe(false);
      if (!to.ok) expect(to.kind).toBe("timeout");
      fake.mode("slow", { delayMs: 120 });
      const okAgain = await mkClient(fake, 1500).addMessages("s", [{ peer_id: "p", content: "y" }]);
      expect(okAgain.ok).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("requests[] is complete for everything that reached the server: order, query, body, GET undefined", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mkClient(fake);
      await client.createSession("rq--general--1", { scopes: ["general"] });
      await client.addMessages("rq--general--1", [{ peer_id: "p", content: "one" }]);
      fake.mode("500");
      await client.addMessages("rq--general--1", [{ peer_id: "p", content: "boom" }]);
      fake.mode("ok");
      await client.listScopeSessions("general", { size: 5, reverse: true });
      const paths = fake.requests.map((r) => `${r.method} ${r.path}`);
      expect(paths[0]).toBe("POST /v3/workspaces/ws/sessions");
      expect(paths.filter((p) => p.includes("/messages")).length).toBe(2); // including the 500
      expect(paths.some((p) => p.startsWith("POST /v3/workspaces/ws/scopes/general/sessions/list?"))).toBe(true);
      // bodies recorded where the client sends them (messages batch), undefined where it doesn't (bodyless POST)
      const msgRec = fake.requests.find((r) => r.path.endsWith("/messages"));
      expect((msgRec?.body as { messages: unknown[] }).messages.length).toBe(1);
      const listRec = fake.requests.find((r) => r.path.includes("/list?"));
      expect(listRec?.body).toBeUndefined();
      expect(fake.requests.every((r) => typeof r.at === "number")).toBe(true);
      // a GET with no body is recorded too (path outside /v3 still lands in requests[])
      await fetch(`${fake.url.replace(/\/v3$/, "")}/healthz`);
      expect(fake.requests.some((r) => r.method === "GET" && r.body === undefined)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("undecodable path segment 404s without killing the server; stop is idempotent", async () => {
    const fake = await startFakeHoncho();
    const r = await fetch(`${fake.url}/workspaces/%ZZ/sessions`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
    const client = mkClient(fake);
    const ok = await client.createSession("s2", { scopes: ["general"] });
    expect(ok.ok).toBe(true); // server alive after the bad request
    await fake.stop();
    await fake.stop();
  });

  // RETARGETED at the T6c fake (ed55995): the real server (probed there)
  // answers an unknown/empty scope with 404 and size>100 with 422; the fake
  // now mirrors it. The writer reads the 404 as DEFINITE-EMPTY free-n; that
  // routing is the writer's contract (T6c), not the fake's - this test pins
  // the fake speaks the real shapes.
  test("scope list: creation order, reverse, size; unknown scope -> 404 and size>100 -> 422 (real-server parity, T6c)", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mkClient(fake);
      await client.createSession("sA", { scopes: ["general"] });
      await client.createSession("sB", { scopes: ["general"] });
      const l1 = await client.listScopeSessions("general");
      expect(l1.ok).toBe(true);
      if (l1.ok) expect(l1.data.items.map((s) => s.id)).toEqual(["sA", "sB"]);
      const base = fake.url;
      const rev = await fetch(`${base}/workspaces/ws/scopes/general/sessions/list?reverse=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}" }).then((r) => r.json() as Promise<{ items: Array<{ id: string }> }>);
      expect(rev.items.map((s) => s.id)).toEqual(["sB", "sA"]);
      const sz = await fetch(`${base}/workspaces/ws/scopes/general/sessions/list?size=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}" }).then((r) => r.json() as Promise<{ items: Array<{ id: string }> }>);
      expect(sz.items.map((s) => s.id)).toEqual(["sA"]);
      // unknown scope: 404 http error (not an empty page), carried as such
      const empty = await client.listScopeSessions("mission-none");
      expect(empty.ok).toBe(false);
      if (!empty.ok) {
        expect(empty.kind).toBe("http");
        expect(empty.status).toBe(404);
      }
      // the real server's page cap: >100 is a 422, not a silent narrowing
      const big = await fetch(`${base}/workspaces/ws/scopes/general/sessions/list?size=101`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}" });
      expect(big.status).toBe(422);
      // and 100 itself is accepted (the exact free-n page size)
      const at100 = await fetch(`${base}/workspaces/ws/scopes/general/sessions/list?size=100`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}" });
      expect(at100.status).toBe(200);
    } finally {
      await fake.stop();
    }
  });

  test("messages to a session the fake never created AUTO-CREATE it (probed real-server parity, T6a); writers must not rely on it (ADR-0002 - proven in review-t6a)", async () => {
    const fake = await startFakeHoncho();
    try {
      const r = await mkClient(fake).addMessages("ghost--general--1", [{ peer_id: "p", content: "x" }]);
      expect(r.ok).toBe(true); // retarget: 201 auto-created, like the real server
      const s = fake.state.sessions.get(`ws/ghost--general--1`);
      expect(s).toBeDefined();
      expect(s?.auto_created).toBe(true);
      expect((fake.state.messages.get("ws/ghost--general--1") ?? []).length).toBe(1);
    } finally {
      await fake.stop();
    }
  });
});
