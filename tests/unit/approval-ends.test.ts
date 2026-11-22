// v0.5.8 (ADR-0019 amended 2026-11-22): an approval may name the queue row it
// is for (`ends`); once that row is closed the approval is used and leaves
// every in-force view, by rule, with no retire and no owner turn. Fake
// server and fake daemon only; no real network.

import { describe, expect, test } from "bun:test";
import { rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { startFakeDaemon, deadDaemonUrl } from "../support/fake-daemon.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { fetchMissionDecisions } from "../../plugin/src/reader.ts";
import {
  currentLedger,
  endsToCheck,
  formatEntry,
  LEDGER_PEER,
  parseEntry,
  supersededMap,
  supersedeMarker,
  toEntries,
  usedApproval,
} from "../../plugin/src/ledger.ts";
import { CLOSED_LOOKUPS_MAX, HANDOFF_HOPS, RECHECK_DONE_MS, RECHECK_OPEN_MS, closedPath, closedRows, readClosed } from "../../plugin/src/closed.ts";

const Q1 = "qitem-20261122100000-aaaa0001";
const Q2 = "qitem-20261122100000-bbbb0002";
const T = "2026-11-22T10:00:00.000Z";

const appr = (id: string, fact: string, ends?: string, owner = "0a1b2c3d"): string =>
  formatEntry({ kind: "approval", id, scope: "mission", owner, ...(ends !== undefined ? { ends } : {}), fact });
const items = (...contents: string[]) =>
  contents.map((content, i) => ({ id: `c${i}`, content, session_id: "lead--m--1", created_at: T }));

describe("v0.5.8 ledger: the ends field", () => {
  test("format and parse round-trip; ends sits last in the header", () => {
    const c = appr("d-aaaa0001", "publish 0.13.0", Q1);
    expect(c).toBe(`[approval d-aaaa0001 · scope mission · owner 0a1b2c3d · ends ${Q1}] publish 0.13.0`);
    const p = parseEntry(c);
    expect(p.kind === "approval" && p.ends).toBe(Q1);
    expect(p.kind === "approval" && p.owner).toBe("0a1b2c3d");
  });

  test("headers without ends parse exactly as before", () => {
    const p = parseEntry("[approval d-aaaa0001 · scope rig · owner 0a1b2c3d] standing rule");
    expect(p).toEqual({ kind: "approval", id: "d-aaaa0001", scope: "rig", owner: "0a1b2c3d", fact: "standing rule" });
  });

  test("a malformed ends makes the header plain (never an entry)", () => {
    expect(parseEntry("[approval d-aaaa0001 · scope rig · ends qitem-bad] x").kind).toBe("plain");
  });

  test("a used approval leaves the in-force view only when its row is known closed", () => {
    const es = toEntries(items(appr("d-aaaa0001", "one-time", Q1), appr("d-aaaa0002", "standing")));
    expect(currentLedger(es).map((e) => e.id)).toEqual(["d-aaaa0001", "d-aaaa0002"]);
    expect(currentLedger(es, new Set()).map((e) => e.id)).toEqual(["d-aaaa0001", "d-aaaa0002"]);
    expect(currentLedger(es, new Set([Q1])).map((e) => e.id)).toEqual(["d-aaaa0002"]);
    expect(currentLedger(es, new Set([Q2])).map((e) => e.id)).toEqual(["d-aaaa0001", "d-aaaa0002"]);
  });

  test("only approvals are ever used; a decision with an ends-shaped header is untouched", () => {
    expect(usedApproval({ kind: "decision", ends: Q1 }, new Set([Q1]))).toBe(false);
    expect(usedApproval({ kind: "approval", ends: Q1 }, new Set([Q1]))).toBe(true);
    expect(usedApproval({ kind: "approval" }, new Set([Q1]))).toBe(false);
  });

  test("search marks a used approval; an explicit retire still wins", () => {
    const used = appr("d-aaaa0001", "one-time", Q1);
    const retired = appr("d-aaaa0003", "retired one", Q1);
    const es = toEntries(items("[retire d-aaaa0003] done", used, retired));
    const m = supersededMap(es, new Set([Q1]));
    expect(supersedeMarker(used, m)).toBe(` (used: ${Q1} closed)`);
    expect(supersedeMarker(retired, m)).toBe(" (retired)");
    expect(supersedeMarker(used, supersededMap(es))).toBe("");
  });

  test("endsToCheck names only rows of approvals no explicit end replaced", () => {
    const es = toEntries(items("[retire d-aaaa0003] done", appr("d-aaaa0001", "a", Q1), appr("d-aaaa0003", "b", Q2)));
    expect(endsToCheck(es)).toEqual([Q1]);
  });
});

describe("v0.5.8 closed rows: daemon lookup and the local file", () => {
  const H = 60 * 60 * 1000;
  const at = (ms: number): (() => string) => () => new Date(Date.parse(T) + ms).toISOString();
  const doneRow = { state: "done", closureReason: "no-follow-on" };

  test("a closed row is found, remembered 0600, and answered from the file with the daemon gone", async () => {
    const dir = makeTempDir("closed-");
    const d = await startFakeDaemon({ item: { qitemId: Q1, ...doneRow } });
    try {
      expect([...(await closedRows(dir, "ws", [Q1], d.url, { now: at(0) }))]).toEqual([Q1]);
    } finally { d.close(); }
    expect(statSync(closedPath(dir, "ws")).mode & 0o777).toBe(0o600);
    expect([...readClosed(dir, "ws")]).toEqual([Q1]);
    expect([...(await closedRows(dir, "ws", [Q1], await deadDaemonUrl(), { now: at(H) }))]).toEqual([Q1]);
  });

  test("open, unknown (404) and unreachable rows stay open", async () => {
    for (const opts of [{ item: { qitemId: Q1, state: "in-progress" } }, { itemStatus: 404 }]) {
      const dir = makeTempDir("closed-");
      const d = await startFakeDaemon(opts);
      try {
        expect((await closedRows(dir, "ws", [Q1], d.url)).size).toBe(0);
      } finally { d.close(); }
      expect(readClosed(dir, "ws").size).toBe(0);
    }
    const dir = makeTempDir("closed-");
    expect((await closedRows(dir, "ws", [Q1], await deadDaemonUrl())).size).toBe(0);
    expect((await closedRows(dir, "ws", [Q1], undefined)).size).toBe(0);
  });

  test("lookup:false reads the file only (the recall hot path)", async () => {
    const dir = makeTempDir("closed-");
    const asked: string[] = [];
    const d = await startFakeDaemon({ item: (id: string) => (asked.push(id), doneRow) });
    try {
      expect((await closedRows(dir, "ws", [Q1], d.url, { lookup: false })).size).toBe(0);
    } finally { d.close(); }
    expect(asked).toEqual([]);
  });

  test("R21 F-Q2: open rows never starve later ones - oldest answer is asked first", async () => {
    const dir = makeTempDir("closed-");
    const open = Array.from({ length: 5 }, (_, i) => `qitem-20261122100000-aaaa000${i}`);
    const done = Array.from({ length: 3 }, (_, i) => `qitem-20261122100000-dddd000${i}`);
    const d = await startFakeDaemon({ item: (id: string) => (done.includes(id) ? doneRow : { state: "in-progress" }) });
    try {
      const ids = [...open, ...done];
      expect((await closedRows(dir, "ws", ids, d.url, { now: at(0) })).size).toBe(0);
      // the five open answers are fresh, so the next read asks the other three
      expect([...(await closedRows(dir, "ws", ids, d.url, { now: at(1000) }))].sort()).toEqual(done);
    } finally { d.close(); }
  });

  test("R21 F-Q3: a fresh open answer is not asked again; an old one is", async () => {
    const dir = makeTempDir("closed-");
    let n = 0;
    let state = "in-progress";
    const d = await startFakeDaemon({ item: () => (n++, { state, closureReason: "no-follow-on" }) });
    try {
      await closedRows(dir, "ws", [Q1], d.url, { now: at(0) });
      await closedRows(dir, "ws", [Q1], d.url, { now: at(60_000) });
      expect(n).toBe(1);
      state = "done";
      expect([...(await closedRows(dir, "ws", [Q1], d.url, { now: at(RECHECK_OPEN_MS) }))]).toEqual([Q1]);
      expect(n).toBe(2);
    } finally { d.close(); }
  });

  test("R21 F-Q1: a row that reopens brings its approval back after the recheck", async () => {
    const dir = makeTempDir("closed-");
    let row: Record<string, unknown> = doneRow;
    const d = await startFakeDaemon({ item: () => row });
    try {
      expect((await closedRows(dir, "ws", [Q1], d.url, { now: at(0) })).size).toBe(1);
      row = { state: "in-progress" };
      expect((await closedRows(dir, "ws", [Q1], d.url, { now: at(H) })).size).toBe(1); // not due yet
      expect((await closedRows(dir, "ws", [Q1], d.url, { now: at(RECHECK_DONE_MS) })).size).toBe(0);
    } finally { d.close(); }
  });

  test("R21 F-R3: an answer dated far ahead is asked again", async () => {
    const dir = makeTempDir("closed-");
    mkdirSync(dirname(closedPath(dir, "ws")), { recursive: true });
    writeFileSync(closedPath(dir, "ws"), JSON.stringify({ version: 2, rows: { [Q1]: { done: true, at: "2099-01-01T00:00:00.000Z" } } }));
    const d = await startFakeDaemon({ item: { state: "in-progress" } });
    try {
      expect((await closedRows(dir, "ws", [Q1], d.url, { now: at(0) })).size).toBe(0);
    } finally { d.close(); }
  });

  test("R21 F-Q4: a hand-off is followed; only the end of the chain decides", async () => {
    const A = "qitem-20261122100000-aaaa000a", B = "qitem-20261122100000-bbbb000b", C = "qitem-20261122100000-cccc000c";
    const rows: Record<string, Record<string, unknown>> = {
      [A]: { state: "done", closureReason: "handed_off_to", closureTarget: B },
      [B]: { state: "in-progress" },
    };
    const d = await startFakeDaemon({ item: (id: string) => rows[id] ?? null });
    try {
      const dir = makeTempDir("closed-");
      expect((await closedRows(dir, "ws", [A], d.url, { now: at(0) })).size).toBe(0);
      rows[B] = { state: "done", closureReason: "handed_off_to", closureTarget: C };
      rows[C] = { state: "done", closureReason: "no-follow-on" };
      expect([...(await closedRows(dir, "ws", [A], d.url, { now: at(RECHECK_OPEN_MS) }))]).toEqual([A]);
      // a loop, a missing target and an over-long chain all count as open
      rows[C] = { state: "done", closureReason: "handed_off_to", closureTarget: A };
      expect((await closedRows(makeTempDir("closed-"), "ws", [A], d.url)).size).toBe(0);
      rows[C] = { state: "done", closureReason: "handed_off_to" };
      expect((await closedRows(makeTempDir("closed-"), "ws", [A], d.url)).size).toBe(0);
      const chain = Array.from({ length: HANDOFF_HOPS + 2 }, (_, i) => `qitem-20261122100000-eeee00${String(i).padStart(2, "0")}`);
      chain.forEach((id, i) => {
        rows[id] = i < chain.length - 1 ? { state: "done", closureReason: "handed_off_to", closureTarget: chain[i + 1] } : doneRow;
      });
      expect((await closedRows(makeTempDir("closed-"), "ws", [chain[0]!], d.url)).size).toBe(0);
    } finally { d.close(); }
  });

  test(`at most ${CLOSED_LOOKUPS_MAX} rows are asked per read, all within the lookup budget`, async () => {
    const dir = makeTempDir("closed-");
    const ids = Array.from({ length: 8 }, (_, i) => `qitem-20261122100000-cccc000${i}`);
    const d = await startFakeDaemon({ item: doneRow });
    try {
      expect((await closedRows(dir, "ws", ids, d.url, { now: at(0) })).size).toBe(CLOSED_LOOKUPS_MAX);
      expect((await closedRows(dir, "ws", ids, d.url, { now: at(1000) })).size).toBe(8);
    } finally { d.close(); }
    const slow = await startFakeDaemon({ delayMs: 900, item: doneRow });
    try {
      const t0 = Date.now();
      expect((await closedRows(makeTempDir("closed-"), "ws", [Q1], slow.url, { budgetMs: 200 })).size).toBe(0);
      expect(Date.now() - t0).toBeLessThan(700);
    } finally { slow.close(); }
  });

  test("a damaged, oversize or symlinked file is empty, never a throw", async () => {
    const dir = makeTempDir("closed-");
    const p = closedPath(dir, "ws");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json");
    expect(readClosed(dir, "ws").size).toBe(0);
    writeFileSync(p, JSON.stringify({ version: 2, rows: { "not-a-qitem": { done: true, at: T }, [Q1]: { done: true, at: T }, [Q2]: { done: "yes", at: T } } }));
    expect([...readClosed(dir, "ws")]).toEqual([Q1]);
    writeFileSync(p, JSON.stringify({ version: 2, rows: {}, pad: "x".repeat(1024 * 1024 + 10) }));
    expect(readClosed(dir, "ws").size).toBe(0);
    const other = makeTempDir("closed-other-");
    const target = join(other, "planted.json");
    writeFileSync(target, JSON.stringify({ version: 2, rows: { [Q1]: { done: true, at: T } } }));
    rmSync(p);
    symlinkSync(target, p);
    expect(readClosed(dir, "ws").size).toBe(0);
  });
});

describe("v0.5.8 the digest's ledger read", () => {
  test("an approval whose row is closed is not in force; standing approvals are", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = createClient({ url: fake.url, workspace: "ws", apiKey: "k", timeoutMs: 2000 });
      await client.createSession("lead--m--1", { peers: {} });
      for (const c of [appr("d-aaaa0001", "publish 0.13.0", Q1), appr("d-aaaa0002", "standing rule"), appr("d-aaaa0004", "still open work", Q2)])
        fake.addConclusion("ws", { content: c, observer_id: "lead", observed_id: LEDGER_PEER, session_id: "lead--m--1", created_at: T });
      const asked: string[][] = [];
      const got = await fetchMissionDecisions(client, "lead", "m", undefined, async (ids) => {
        asked.push(ids);
        return new Set([Q1]);
      });
      expect(asked.map((a) => a.slice().sort())).toEqual([[Q1, Q2]]);
      expect(got.map((d) => d.id).sort()).toEqual(["d-aaaa0002", "d-aaaa0004"]);
      // without closed-row knowledge nothing is used (the pre-v0.5.8 view)
      expect((await fetchMissionDecisions(client, "lead", "m")).length).toBe(3);
    } finally {
      await fake.stop();
    }
  });
});
