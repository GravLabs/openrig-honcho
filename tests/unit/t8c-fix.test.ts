// T8c-fix items 1 + 2 (qitem-20261028205803-e268faca12effc79): every spool
// loss counts in the seat stats (cap trim + oversized -> dropped,
// unserializable metadata keys -> sanitized), and updateStats with a MISSING
// seat file creates a minimal state holding the counters, while a CORRUPT
// state is never replaced and a BUSY lock stays a silent no-op (architect
// constraint 20:59Z). Local tmp dirs only - no network.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, mkdirSync, readFileSync, statSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { SPOOL_ENTRY_MAX_BYTES, SPOOL_MAX_BYTES, spoolAppend, type SpoolEntry } from "../../plugin/src/spool.ts";
import { statsFrom, updateStats } from "../../plugin/src/stats.ts";
import { readSeatState, seatLockDir, seatStatePath } from "../../plugin/src/missions.ts";
import type { MessageInput } from "../../plugin/src/honcho.ts";

const mkPaths = (): { stateDir: string; workspace: string; peer: string } => ({
  stateDir: makeTempDir("t8cfix-"),
  workspace: "ws",
  peer: "p1" });

const entry = (messages: MessageInput[]): SpoolEntry => ({
  session: "s1",
  messages,
  maybe_sent: false,
  at: "2026-10-28T00:00:00.000Z" });

const msg = (content: string, metadata?: Record<string, unknown>): MessageInput => ({
  peer_id: "p1",
  content,
  ...(metadata !== undefined ? { metadata } : {}) });

const seatStats = (p: { stateDir: string; workspace: string; peer: string }) =>
  statsFrom(readSeatState(seatStatePath(p.stateDir, p.workspace, p.peer)));

describe("T8c-fix item 1: every loss is counted", () => {
  test("oversized single message -> stats.dropped, entry never hits the file", async () => {
    const p = mkPaths();
    const big = msg("x".repeat(SPOOL_ENTRY_MAX_BYTES + 1024));
    const cap = await spoolAppend(p, entry([big]));
    expect(cap).toBe(0); // the return stays the cap-trim count (unchanged contract)
    const st = seatStats(p);
    expect(st.dropped).toBe(1);
    expect(st.sanitized).toBe(0);
    // the spool file itself must hold nothing
    const spoolFile = join(p.stateDir, p.workspace, "spool", "p1.jsonl");
    expect(readFileSync(spoolFile, "utf8")).toBe("");
  });

  test("ALL messages oversized -> counted before the empty-parts early return", async () => {
    const p = mkPaths();
    const big = () => msg("y".repeat(SPOOL_ENTRY_MAX_BYTES + 1024));
    await spoolAppend(p, entry([big(), big(), big()]));
    expect(seatStats(p).dropped).toBe(3);
  });

  test("unserializable metadata keys -> stats.sanitized, message kept", async () => {
    const p = mkPaths();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await spoolAppend(p, entry([msg("hello", { good: 1, bad: circular })]));
    const st = seatStats(p);
    expect(st.sanitized).toBe(1);
    expect(st.dropped).toBe(0);
    const lines = readFileSync(join(p.stateDir, p.workspace, "spool", "p1.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines.length).toBe(1);
    const kept = JSON.parse(lines[0] as string) as SpoolEntry;
    const meta = kept.messages[0]?.metadata as Record<string, unknown>;
    expect(meta.good).toBe(1);
    expect("bad" in meta).toBe(false);
  });

  test("cap trim counts once: stats.dropped === the function's return === lines removed", async () => {
    const p = mkPaths();
    const spoolFile = join(p.stateDir, p.workspace, "spool", "p1.jsonl");
    mkdirSync(spoolFile.slice(0, spoolFile.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    // pre-fill just under the cap with valid entries (~100 KB each)
    const pad = "z".repeat(100_000);
    let text = "";
    while (Buffer.byteLength(text, "utf8") < SPOOL_MAX_BYTES - 50_000) {
      text += `${JSON.stringify(entry([msg(pad)]))}\n`;
    }
    writeFileSync(spoolFile, text, { mode: 0o600 });
    const before = text.split("\n").filter((l) => l !== "").length;
    const dropped = await spoolAppend(p, entry([msg("after the fill")]));
    expect(dropped).toBeGreaterThan(0);
    expect(seatStats(p).dropped).toBe(dropped); // counted exactly once (no writer fold)
    expect(statSync(spoolFile).size).toBeLessThanOrEqual(SPOOL_MAX_BYTES);
    const after = readFileSync(spoolFile, "utf8").split("\n").filter((l) => l !== "").length;
    expect(after).toBe(before - dropped + 1);
  });

  test("writer spooled path adds nothing on top: a plain spoolAppend on a fresh seat yields dropped=cap-count only", async () => {
    // regression guard for the double count: writer.ts must NOT fold
    // SendOutcome.dropped any more (static check) and the spool-side count is
    // the only one (dynamic check above).
    const src = readFileSync(new URL("../../plugin/src/writer.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/s\.dropped \+= out\.dropped/);
    expect(src).toMatch(/s\.dropped \+= rep\.deadDropped/); // replay fold stays (separate loss)
  });
});

describe("T8c-fix item 2: counters without state", () => {
  test("MISSING seat file -> updateStats creates a minimal, READABLE state", async () => {
    const p = mkPaths();
    const seatFile = seatStatePath(p.stateDir, p.workspace, p.peer);
    expect(existsSync(seatFile)).toBe(false);
    await updateStats(p.stateDir, p.workspace, p.peer, (s) => {
      s.replayed += 2;
      s.dropped += 1;
    });
    const raw = JSON.parse(readFileSync(seatFile, "utf8")) as Record<string, unknown>;
    expect(raw.mission).toBe("");
    expect(raw.n).toBe(1);
    expect(raw.counters).toEqual({});
    // the whole point: readSeatState must accept it (mission/n/counters valid)
    const state = readSeatState(seatFile);
    expect(state).not.toBeNull();
    const st = statsFrom(state);
    expect(st.replayed).toBe(2);
    expect(st.dropped).toBe(1);
    // a second update accumulates on the created state
    await updateStats(p.stateDir, p.workspace, p.peer, (s) => {
      s.replayed += 1;
    });
    expect(seatStats(p).replayed).toBe(3);
  });

  test("CORRUPT seat file -> silent no-op, bytes untouched, never replaced", async () => {
    const p = mkPaths();
    const seatFile = seatStatePath(p.stateDir, p.workspace, p.peer);
    mkdirSync(seatFile.slice(0, seatFile.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    writeFileSync(seatFile, "{not json", { mode: 0o600 });
    await updateStats(p.stateDir, p.workspace, p.peer, (s) => {
      s.written += 1;
    });
    expect(readFileSync(seatFile, "utf8")).toBe("{not json");
  });

  test("BUSY lock -> updateStats is a silent no-op: no throw, no state created (20:59Z)", async () => {
    const p = mkPaths();
    const lockDir = seatLockDir(p.stateDir, p.workspace, p.peer);
    const seatFile = seatStatePath(p.stateDir, p.workspace, p.peer);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, "lock"), "999999 2026-10-28T21:00:00.000Z\n", { mode: 0o600 });
    // withLock polls ~2 s then gives up as busy; fn must never run
    const t0 = Date.now();
    await updateStats(p.stateDir, p.workspace, p.peer, (s) => {
      throw new Error("must not run under a busy lock");
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(existsSync(seatFile)).toBe(false); // busy != missing: no creation
  }, 30_000);

  test("BUSY lock -> spoolAppend still spools; only the count is skipped", async () => {
    const p = mkPaths();
    const lockDir = seatLockDir(p.stateDir, p.workspace, p.peer);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(lockDir, "lock"), "999999 2026-10-28T21:00:00.000Z\n", { mode: 0o600 });
    await spoolAppend(p, entry([msg("must still spool")]));
    const lines = readFileSync(join(p.stateDir, p.workspace, "spool", "p1.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines.length).toBe(1); // the append itself never needed the lock
    expect(existsSync(seatStatePath(p.stateDir, p.workspace, p.peer))).toBe(false);
  }, 30_000);

  test("replay after total state loss keeps its counts (motivating scenario)", async () => {
    // a seat whose state file was deleted mid-life: the next replay's
    // updateStats must not lose replayed/dropped - it creates the minimal
    // state and records them there.
    const p = mkPaths();
    await updateStats(p.stateDir, p.workspace, p.peer, (s) => {
      s.replayed += 5;
      s.dead += 1;
      s.dropped += 2;
    });
    const st = seatStats(p);
    expect(st.replayed).toBe(5);
    expect(st.dead).toBe(1);
    expect(st.dropped).toBe(2);
  });

  test("statsFrom carries sanitized through old files without it", () => {
    const legacy = { mission: "m", n: 1, session: "s", counters: {}, last_seen: "x", stats: { written: 3 } };
    const st = statsFrom(legacy as never);
    expect(st.written).toBe(3);
    expect(st.sanitized).toBe(0);
  });
});
