// T5: missions, state files and session naming (ADR-0002). Local temp dirs
// only; nothing here touches the network or any real state dir.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, mkdirSync, readFileSync, statSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import {
  GENERAL,
  normalizeMission,
  readRigMission,
  resolveSession,
  scopeFor,
  sessionName,
  setRigMission } from "../../plugin/src/missions.ts";
import { withLock } from "../../plugin/src/lock.ts";

const tmp = (): string => makeTempDir("missions-test-");
const NOW = "2026-10-28T10:00:00Z";

describe("normalizeMission (ADR-0002 mission ids)", () => {
  test('"Slice 07!" -> "slice-07"', () => {
    expect(normalizeMission("Slice 07!")).toBe("slice-07");
  });
  test('"" and undefined -> "general"', () => {
    expect(normalizeMission("")).toBe(GENERAL);
    expect(normalizeMission(undefined)).toBe(GENERAL);
  });
  test('"../x" -> "x"', () => {
    expect(normalizeMission("../x")).toBe("x");
  });
  test("80 chars -> 60", () => {
    expect(normalizeMission("a".repeat(80))).toBe("a".repeat(60));
  });
});

describe("scopeFor / sessionName", () => {
  test("scope: general or mission-<id>", () => {
    expect(scopeFor(GENERAL)).toBe("general");
    expect(scopeFor("slice-07")).toBe("mission-slice-07");
  });
  test("session: <peer>--<mission>--<n>", () => {
    expect(sessionName("dev-build", "slice-07", 3)).toBe("dev-build--slice-07--3");
  });
});

describe("setRigMission / readRigMission", () => {
  test("round trip writes the ADR shape; read returns it", async () => {
    const dir = tmp();
    const r = await setRigMission(dir, "w", "Slice 07!", "design-architect", NOW);
    expect(r).toEqual({ ok: true, mission: "slice-07", scope: "mission-slice-07" });
    expect(readRigMission(dir, "w")).toEqual({
      mission: "slice-07",
      set_by: "design-architect",
      set_at: NOW });
  });
  test("missing or corrupt mission.json -> general", () => {
    const dir = tmp();
    expect(readRigMission(dir, "w")).toEqual({ mission: "general", set_by: null, set_at: null });
    mkdirSync(join(dir, "w"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "w", "mission.json"), "{ not json", { mode: 0o600 });
    expect(readRigMission(dir, "w")).toEqual({ mission: "general", set_by: null, set_at: null });
  });
  test("two seats switching at once -> file is valid JSON naming one of them", async () => {
    const dir = tmp();
    const [a, b] = await Promise.all([
      setRigMission(dir, "w", "alpha", "seat-a", NOW),
      setRigMission(dir, "w", "beta", "seat-b", NOW),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, "w", "mission.json"), "utf8"));
    const read = readRigMission(dir, "w");
    expect(["alpha", "beta"]).toContain(read.mission);
    expect(raw.set_by).toBe(read.mission === "alpha" ? "seat-a" : "seat-b");
  });
});

describe("resolveSession (ADR-0002 new-session rule)", () => {
  test("first call -> n 1, isNew; second call same mission -> same session, not new", async () => {
    const dir = tmp();
    const first = await resolveSession(dir, "w", "dev-build", { rigMission: "alpha", now: NOW });
    expect(first).toEqual({
      session: "dev-build--alpha--1",
      mission: "alpha",
      scope: "mission-alpha",
      isNew: true,
      n: 1 });
    const second = await resolveSession(dir, "w", "dev-build", { rigMission: "alpha", now: NOW });
    expect(second.session).toBe("dev-build--alpha--1");
    expect(second.isNew).toBe(false);
    expect(second.n).toBe(1);
  });

  test("mission change -> new session; switching back continues its counter (a,b,a -> a--2)", async () => {
    const dir = tmp();
    await resolveSession(dir, "w", "dev-build", { rigMission: "alpha", now: NOW });
    const b = await resolveSession(dir, "w", "dev-build", { rigMission: "beta", now: NOW });
    expect(b).toEqual({
      session: "dev-build--beta--1",
      mission: "beta",
      scope: "mission-beta",
      isNew: true,
      n: 1 });
    const a2 = await resolveSession(dir, "w", "dev-build", { rigMission: "alpha", now: NOW });
    expect(a2.isNew).toBe(true);
    expect(a2.n).toBe(2);
    expect(a2.session).toBe("dev-build--alpha--2");
  });

  test("resume/compact continue; startup/clear with a new claude_session_id start new", async () => {
    const dir = tmp();
    const base = { rigMission: "m", now: NOW };
    const start = await resolveSession(dir, "w", "dev-build", {
      ...base,
      source: "startup",
      claudeSessionId: "A" });
    expect(start.session).toBe("dev-build--m--1");

    const resume = await resolveSession(dir, "w", "dev-build", {
      ...base,
      source: "resume",
      claudeSessionId: "B" });
    expect(resume.isNew).toBe(false);
    expect(resume.session).toBe("dev-build--m--1");

    const compact = await resolveSession(dir, "w", "dev-build", {
      ...base,
      source: "compact",
      claudeSessionId: "C" });
    expect(compact.isNew).toBe(false);
    expect(compact.session).toBe("dev-build--m--1");

    const startup = await resolveSession(dir, "w", "dev-build", {
      ...base,
      source: "startup",
      claudeSessionId: "D" });
    expect(startup.isNew).toBe(true);
    expect(startup.session).toBe("dev-build--m--2");

    const clear = await resolveSession(dir, "w", "dev-build", {
      ...base,
      source: "clear",
      claudeSessionId: "E" });
    expect(clear.isNew).toBe(true);
    expect(clear.session).toBe("dev-build--m--3");

    // writer hook (no source) with yet another id continues the session
    const hook = await resolveSession(dir, "w", "dev-build", { ...base, claudeSessionId: "F" });
    expect(hook.isNew).toBe(false);
    expect(hook.session).toBe("dev-build--m--3");
  });

  test("corrupt seat file is treated as missing", async () => {
    const dir = tmp();
    const seats = join(dir, "w", "seats");
    mkdirSync(seats, { recursive: true, mode: 0o700 });
    writeFileSync(join(seats, "dev-build.json"), '{ "mission": "x", tru', { mode: 0o600 });
    const r = await resolveSession(dir, "w", "dev-build", { rigMission: "alpha", now: NOW });
    expect(r.isNew).toBe(true);
    expect(r.n).toBe(1);
    expect(r.session).toBe("dev-build--alpha--1");
  });

  test("seat state file is mode 0600", async () => {
    const dir = tmp();
    await resolveSession(dir, "w", "dev-build", { rigMission: "alpha", now: NOW });
    const mode = statSync(join(dir, "w", "seats", "dev-build.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Ruling (architect 2026-10-28): the lock is per seat, so a third actor
  // holding peer A's lock must not affect peer B. withLock is a file lock
  // (O_EXCL + mtime), so contention is identical whether the holder runs in
  // this process or a spawned one (cross-process locking is proved in
  // lock.test.ts); the holder below holds it from a concurrent task.
  test("a third actor holding peer A's lock: B resolves fully, A waits, then both succeed", async () => {
    const dir = tmp();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const holder = withLock(join(dir, "w", "seats", "peerA.lockdir"), async () => hold);
    // wait until the holder actually owns the lock (lock file exists)
    while (!existsSync(join(dir, "w", "seats", "peerA.lockdir", "lock"))) {
      await new Promise((r) => setTimeout(r, 10));
    }

    let aDone = false;
    const pA = resolveSession(dir, "w", "peerA", { rigMission: "m", now: NOW }).then((r) => {
      aDone = true;
      return r;
    });
    const b = await resolveSession(dir, "w", "peerB", { rigMission: "m", now: NOW });
    expect(b).toEqual({
      session: "peerB--m--1",
      mission: "m",
      scope: "mission-m",
      isNew: true,
      n: 1 });
    // B finished while A's lock was still held; A must still be waiting
    await new Promise((r) => setTimeout(r, 100));
    expect(aDone).toBe(false);

    release();
    await holder;
    const a = await pA;
    expect(aDone).toBe(true);
    expect(a).toEqual({
      session: "peerA--m--1",
      mission: "m",
      scope: "mission-m",
      isNew: true,
      n: 1 });
  });
});
