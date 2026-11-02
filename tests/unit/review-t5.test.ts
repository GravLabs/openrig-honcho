// Review T5 (dev.review): missions, seat state, session naming (ADR-0002,
// commit 3ebd5b0 + ruling f3270e3) and T4-fix-2 protocol-relative URLs,
// pinned at 88e1754. Contract: ADR-0002 (all), ADR-0006 S1/S2/S3/X4,
// ADR-0003 URL rulings. Local temp files only - no network, no Honcho.
//
// Expecting-fail cases are marked F-.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {
  GENERAL,
  normalizeMission,
  readRigMission,
  resolveSession,
  scopeFor,
  sessionName,
  setRigMission } from "../../plugin/src/missions.ts";
import { withLock, writeJsonAtomic } from "../../plugin/src/lock.ts";
import { redact } from "../../plugin/src/redact.ts";
import { 
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";

const W = "honcho-bridge-scratch-rev";
const O40 = "Ab1cDe2fGh3iJk4lAb1cDe2fGh3iJk4lAb1cDe2f"; // fake-secret

let d: string; // fresh tmp root per test
beforeEach(() => {
  d = makeTempDir("rev-t5-");
});
afterEach(() => {
  rmSync(d, { recursive: true, force: true });
});

const wsDir = () => join(d, W);
const seatFile = (peer: string) => join(wsDir(), "seats", `${peer}.json`);
const lockFile = (peer: string) => join(wsDir(), "seats", `${peer}.lockdir`, "lock");
const readState = (peer: string) => JSON.parse(readFileSync(seatFile(peer), "utf8"));

// ---------------------- 1. mission id normalisation ----------------------
describe("T5-1 mission ids (ADR-0002 'Mission ids')", () => {
  const cases: Array<[string | undefined, string]> = [
    ["Slice 07!", "slice-07"],
    ["../x", "x"],
    ["  ", GENERAL],
    ["", GENERAL],
    [undefined, GENERAL],
    ["--x--", "x"],
    ["Ünïcode X", "n-code-x"],
    ["UPPER-x", "upper-x"],
    ["a".repeat(65), "a".repeat(60)],
    ["a".repeat(60) + "x", "a".repeat(60)],
  ];
  for (const [input, want] of cases) {
    test(`normalises ${JSON.stringify(input)?.slice(0, 30)}`, () => {
      expect(normalizeMission(input)).toBe(want);
    });
  }

  test("output is always normalised, idempotent, never empty, <= 60", () => {
    for (const [input] of cases.concat([["a-".repeat(40)], ["-"], ["___"]] as Array<[string | undefined]>)) {
      const once = normalizeMission(input);
      expect(once.length).toBeGreaterThanOrEqual(1);
      expect(once.length).toBeLessThanOrEqual(60);
      expect(once).toMatch(/^[a-z0-9_-]+$/);
      expect(once).not.toMatch(/[-]$/);
      expect(normalizeMission(once)).toBe(once);
    }
  });

  test("DOCUMENTED: distinct long ids colliding past the 60-char cut share a scope", () => {
    // ADR caps ids at 60; the collision is a contract consequence, asserted
    // so a contract change must pass here.
    expect(normalizeMission("a".repeat(60) + "x")).toBe(normalizeMission("a".repeat(60) + "y"));
  });

  test("scope naming and worst-case session length < 512", () => {
    expect(scopeFor(GENERAL)).toBe("general");
    expect(scopeFor("slice-07")).toBe("mission-slice-07");
    const worst = sessionName("p".repeat(100), "a".repeat(60), 1e15);
    expect(worst.length).toBeLessThan(512);
  });
});

// ------------------------ 2. rig mission file ----------------------------
describe("T5-2 mission.json: read rules, atomic set, no lock", () => {
  test("missing / garbage / wrong-shape -> general with null provenance", () => {
    expect(readRigMission(d, W)).toEqual({ mission: GENERAL, set_by: null, set_at: null });
    const mp = join(wsDir(), "mission.json");
    mkdirSync(wsDir(), { recursive: true });
    for (const junk of ["", "   ", "not json", "[]", "{}", '{"mission": 42}', '{"mission": null}']) {
      writeFileSync(mp, junk);
      expect(readRigMission(d, W).mission).toBe(GENERAL);
    }
  });

  test("hand-edited mission string is normalised on read (no smuggling)", () => {
    mkdirSync(wsDir(), { recursive: true });
    writeFileSync(join(wsDir(), "mission.json"), '{"mission": "SLICE 07!", "set_by": 7, "set_at": 8}');
    expect(readRigMission(d, W)).toEqual({ mission: "slice-07", set_by: null, set_at: null });
  });

  test("mission.json that is a directory -> general", () => {
    mkdirSync(join(wsDir(), "mission.json"), { recursive: true });
    expect(readRigMission(d, W).mission).toBe(GENERAL);
  });

  test("setRigMission writes the normalised value atomically; no tmp residue", async () => {
    const r = await setRigMission(d, W, "Slice 07!", "design-architect", "2026-10-28T10:00:00Z");
    expect(r).toEqual({ ok: true, mission: "slice-07", scope: "mission-slice-07" });
    const onDisk = JSON.parse(readFileSync(join(wsDir(), "mission.json"), "utf8"));
    expect(onDisk).toEqual({ mission: "slice-07", set_by: "design-architect", set_at: "2026-10-28T10:00:00Z" });
    expect(readdirSync(wsDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("30 concurrent mission switches: all ok, final file parses, last writer wins", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m-${i}`);
    const results = await Promise.all(ids.map((id, i) => setRigMission(d, W, id, `peer-${i}`)));
    expect(results.every((r) => r.ok)).toBe(true);
    const final = JSON.parse(readFileSync(join(wsDir(), "mission.json"), "utf8"));
    expect(ids).toContain(final.mission); // exactly one winner, not a torn mix
    expect(typeof final.set_by).toBe("string");
    expect(readdirSync(wsDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("unwritable state dir -> {ok:false} with values, never throws", () => {
    mkdirSync(wsDir(), { recursive: true });
    chmodSync(wsDir(), 0o500);
    try {
      // writeJsonAtomic's mkdir sees an existing dir, then the tmp write hits
      // EACCES - 0500 blocks it.
      expect(writeJsonAtomic(join(wsDir(), "mission.json"), { a: 1 })).toBe(false);
    } finally {
      chmodSync(wsDir(), 0o700);
    }
  });

  test("symlinked mission.json is REPLACED, the external target is never written", () => {
    const outside = join(d, "outside.json");
    writeFileSync(outside, "CANNOTARY");
    mkdirSync(wsDir(), { recursive: true });
    symlinkSync(outside, join(wsDir(), "mission.json"));
    const ok = writeJsonAtomic(join(wsDir(), "mission.json"), { mission: "mine" });
    expect(ok).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("CANNOTARY");
    expect(lstatSync(join(wsDir(), "mission.json")).isSymbolicLink()).toBe(false);
  });
});

// ------------------- 3. resolveSession golden sequence -------------------
describe("T5-3 session sequence (architect transcript, ADR-0002)", () => {
  test("general--1, same, slice-07--1, general--2, slice-07--2, resume keeps, new id -> -3", async () => {
    const p = "dev-build";
    let r = await resolveSession(d, W, p, { rigMission: "general", claudeSessionId: "c1" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--general--1", true, 1]);
    r = await resolveSession(d, W, p, { rigMission: "general", claudeSessionId: "c1" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--general--1", false, 1]);
    r = await resolveSession(d, W, p, { rigMission: "slice-07", claudeSessionId: "c1" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--slice-07--1", true, 1]);
    r = await resolveSession(d, W, p, { rigMission: "general", claudeSessionId: "c1" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--general--2", true, 2]);
    r = await resolveSession(d, W, p, { rigMission: "slice-07", claudeSessionId: "c1" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--slice-07--2", true, 2]);
    r = await resolveSession(d, W, p, { rigMission: "slice-07", source: "resume", claudeSessionId: "c1" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--slice-07--2", false, 2]);
    r = await resolveSession(d, W, p, { rigMission: "slice-07", source: "startup", claudeSessionId: "c2" });
    expect([r.session, r.isNew, r.n]).toEqual(["dev-build--slice-07--3", true, 3]);
    r = await resolveSession(d, W, p, { rigMission: "slice-07", source: "startup", claudeSessionId: "c2" });
    expect([r.session, r.isNew]).toEqual(["dev-build--slice-07--3", false]); // same id, not new
    r = await resolveSession(d, W, p, { rigMission: "slice-07", source: "compact" });
    expect([r.session, r.isNew]).toEqual(["dev-build--slice-07--3", false]);
    const st = readState(p);
    expect(st.counters).toEqual({ general: 2, "slice-07": 3 });
    expect(st.session).toBe("dev-build--slice-07--3");
    expect(st.claude_session_id).toBe("c2");
  });

  test("writer-hook call (no source) with a new claude id does NOT start a new session", async () => {
    await resolveSession(d, W, "p1", { rigMission: "m", claudeSessionId: "c1" });
    const r = await resolveSession(d, W, "p1", { rigMission: "m", claudeSessionId: "c9" });
    expect([r.session, r.isNew]).toEqual(["p1--m--1", false]); // new session only on startup/clear
  });

  test("unknown source value behaves like a writer hook, never throws", async () => {
    await resolveSession(d, W, "p2", { rigMission: "m", claudeSessionId: "c1" });
    const r = await resolveSession(d, W, "p2", {
      rigMission: "m",
      source: "auto" as "startup",
      claudeSessionId: "zz" });
    expect([r.session, r.isNew]).toEqual(["p2--m--1", false]);
  });

  test("clock backwards: last_seen in the future does not affect continuation", async () => {
    await resolveSession(d, W, "p3", { rigMission: "m", now: "2999-01-01T00:00:00Z" });
    const r = await resolveSession(d, W, "p3", { rigMission: "m", now: "2020-01-01T00:00:00Z" });
    expect([r.session, r.isNew]).toEqual(["p3--m--1", false]);
    expect(readState("p3").last_seen).toBe("2020-01-01T00:00:00Z");
  });
});

// ------------------- 4. corrupt / hostile state files ---------------------
describe("T5-4 S2: corrupt or hostile seat state degrades safely", () => {
  test("corrupt states all behave as missing (n=1, fresh session)", async () => {
    mkdirSync(join(wsDir(), "seats"), { recursive: true });
    const junk = ["", "nope", "[]", '{"n": 0}', '{"n": "3"}', '{"mission": 7}', '{"mission": "m", "n": 2}', "{}"];
    for (const [i, body] of junk.entries()) {
      const peer = `junk${i}`;
      writeFileSync(seatFile(peer), body);
      const r = await resolveSession(d, W, peer, { rigMission: "m" });
      expect([r.session, r.isNew, r.n]).toEqual([`${peer}--m--1`, true, 1]);
      expect(readState(peer).counters).toEqual({ m: 1 });
    }
  });

  test("hand-edited unnormalised mission: new session, counters still carry", async () => {
    mkdirSync(join(wsDir(), "seats"), { recursive: true });
    writeFileSync(
      seatFile("p4"),
      JSON.stringify({ mission: "SLICE 07!", n: 5, session: "junk", counters: { "slice-07": 5 }, last_seen: "x" }),
    );
    const r = await resolveSession(d, W, "p4", { rigMission: "Slice 07!" });
    expect([r.session, r.isNew, r.n]).toEqual(["p4--slice-07--6", true, 6]);
  });

  test("seat file replaced by a DIRECTORY: same stable session every call, no throw, dir intact", async () => {
    mkdirSync(seatFile("p5"), { recursive: true });
    const a = await resolveSession(d, W, "p5", { rigMission: "m" });
    const b = await resolveSession(d, W, "p5", { rigMission: "m" });
    expect(a.session).toBe("p5--m--1");
    expect(b.session).toBe(a.session);
    expect(lstatSync(seatFile("p5")).isDirectory()).toBe(true);
  });

  test("seat file symlinked outside the state dir: outside never written, symlink replaced", async () => {
    const outside = join(d, "outside2.json");
    writeFileSync(outside, "CANNOTARY");
    mkdirSync(join(wsDir(), "seats"), { recursive: true });
    symlinkSync(outside, seatFile("p6"));
    const r = await resolveSession(d, W, "p6", { rigMission: "m" });
    expect(r.session).toBe("p6--m--1");
    expect(readFileSync(outside, "utf8")).toBe("CANNOTARY");
    expect(lstatSync(seatFile("p6")).isSymbolicLink()).toBe(false);
  });

  test("stateDir not a directory -> computed session returned, never throws (S1)", async () => {
    const notADir = join(d, "afile");
    writeFileSync(notADir, "x");
    const r = await resolveSession(notADir, W, "p7", { rigMission: "m" });
    expect(r.session).toBe("p7--m--1");
    expect(readRigMission(notADir, W).mission).toBe(GENERAL);
  });
});

// ------------------------- 5. locking (S3) --------------------------------
describe("T5-5 per-seat lockdir semantics", () => {
  test("fresh foreign lock -> busy fallback in ~2 s: computed session, no writes, lock untouched", async () => {
    mkdirSync(join(wsDir(), "seats", "p8.lockdir"), { recursive: true });
    writeFileSync(lockFile("p8"), "999 2026-10-28T00:00:00Z\n");
    const t0 = performance.now();
    const r = await resolveSession(d, W, "p8", { rigMission: "m" });
    const ms = performance.now() - t0;
    expect(r.session).toBe("p8--m--1");
    expect(r.isNew).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(1800);
    expect(ms).toBeLessThan(4000);
    expect(existsSync(seatFile("p8"))).toBe(false); // nothing persisted
    expect(existsSync(lockFile("p8"))).toBe(true); // foreign lock not stolen
  });

  test("stale lock (31 s old) is taken over: state written, lock released", async () => {
    mkdirSync(join(wsDir(), "seats", "p9.lockdir"), { recursive: true });
    writeFileSync(lockFile("p9"), "999 old\n");
    const old = (Date.now() - 31_000) / 1000;
    utimesSync(lockFile("p9"), old, old);
    const t0 = performance.now();
    const r = await resolveSession(d, W, "p9", { rigMission: "m" });
    expect(r.session).toBe("p9--m--1");
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(existsSync(seatFile("p9"))).toBe(true);
    expect(existsSync(lockFile("p9"))).toBe(false); // released
  });

  test("10-second-old lock is NOT stale: busy, lock survives", async () => {
    mkdirSync(join(wsDir(), "seats", "pa.lockdir"), { recursive: true });
    writeFileSync(lockFile("pa"), "999 held\n");
    const recent = (Date.now() - 10_000) / 1000;
    utimesSync(lockFile("pa"), recent, recent);
    const r = await resolveSession(d, W, "pa", { rigMission: "m" });
    expect(r.session).toBe("pa--m--1"); // fallback, unpersisted
    expect(existsSync(lockFile("pa"))).toBe(true);
    expect(existsSync(seatFile("pa"))).toBe(false);
  });

  test("per-seat isolation: peer B's held lock never delays peer A", async () => {
    mkdirSync(join(wsDir(), "seats", "pb.lockdir"), { recursive: true });
    writeFileSync(lockFile("pb"), "999 held\n");
    const tA = performance.now();
    const pA = resolveSession(d, W, "peerA", { rigMission: "m" });
    const pB = resolveSession(d, W, "pb", { rigMission: "m" });
    const ra = await pA;
    const aMs = performance.now() - tA;
    expect(ra.session).toBe("peerA--m--1");
    expect(existsSync(seatFile("peerA"))).toBe(true);
    expect(aMs).toBeLessThan(1500); // A never waited on B's lock (B still busy-waiting)
    const rb = await pB;
    expect(rb.session).toBe("pb--m--1"); // B degraded to the computed fallback
  });

  test("10 concurrent resolveSession on ONE seat keep every update (lock guards RMW)", async () => {
    await resolveSession(d, W, "pc", { rigMission: "seed" });
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => resolveSession(d, W, "pc", { rigMission: `m${i}` })),
    );
    expect(new Set(rs.map((r) => r.session)).size).toBe(10); // 10 distinct names
    const st = readState("pc");
    expect(Object.keys(st.counters).sort()).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "seed"]);
    expect(Object.values(st.counters).every((v) => v === 1)).toBe(true);
  });

  test("fn throwing inside the lock -> {ok:false,reason:'error'}, lock released", async () => {
    const dir = join(d, "L");
    const r1 = await withLock(dir, () => {
      throw new Error("boom");
    });
    expect(r1).toEqual({ ok: false, reason: "error" });
    expect(existsSync(join(dir, "lock"))).toBe(false);
    const r2 = await withLock(dir, () => 7);
    expect(r2).toEqual({ ok: true, value: 7 });
  });
});

// --------------------------- 6. X4 modes ---------------------------------
describe("T5-6 X4: state files are private", () => {
  test("workspace, seats, lockdir 0700-class; mission.json and seat json without group/other bits", async () => {
    await setRigMission(d, W, "m", "by");
    await resolveSession(d, W, "pd", { rigMission: "m" });
    for (const dir of [wsDir(), join(wsDir(), "seats"), join(wsDir(), "seats", "pd.lockdir")]) {
      expect(statSync(dir).mode & 0o077).toBe(0); // no group/other access
    }
    for (const file of [join(wsDir(), "mission.json"), seatFile("pd")]) {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  });
});

// --------------------- 7. T4-fix-2 protocol-relative URLs ----------------
describe("T5-7 protocol-relative URLs and prose edges (88e1754)", () => {
  test("//host/<token> redacted, host kept", () => {
    const r = redact(`see //host.example/${O40}`);
    expect(r.counts).toEqual({ opaque: 1 });
    expect(r.text).toBe("see //host.example[REDACTED:opaque]");
  });

  test("bare //host and short //host/path kept", () => {
    for (const input of ["//host.example", "//host.example/short/path"]) {
      const r = redact(input);
      expect(r.text).toBe(input);
      expect(Object.keys(r.counts).length).toBe(0);
    }
  });

  test("'a//b' prose is untouched", () => {
    const r = redact("see a//b and x//y");
    expect(r.text).toBe("see a//b and x//y");
  });

  test("'a//host/<token>': glued run is redacted whole (safe direction, documented)", () => {
    const r = redact(`see a//host.example/${O40}`);
    expect(r.counts.opaque).toBe(1);
    expect(r.text).not.toContain(O40);
  });

  test("./x/<token> stays kept by the written path rule (CONFIRM ONLY, not a finding)", () => {
    const r = redact(`./x/${O40}`);
    expect(r.text).toBe(`./x/${O40}`);
    expect(r.counts.opaque).toBeUndefined();
  });
});

// ------------------------------ 8. fuzz ----------------------------------
describe("T5-8 S1 fuzz: 2000 random mixed calls, never throw, invariants hold", () => {
  test("resolveSession/readRigMission/setRigMission fuzz", async () => {
    const missions: Array<string | undefined> = [
      "general", "Slice 07!", "../x", "a".repeat(80), "é/é", "--", "", undefined, "UPPER", "x".repeat(200),
    ];
    const sources = [undefined, "startup", "resume", "clear", "compact", "auto", ""] as const;
    let s = 987654321;
    const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

    for (let i = 0; i < 2000; i++) {
      const peer = `f${i % 5}`;
      const rm = pick(missions);
      let r: Awaited<ReturnType<typeof resolveSession>> | undefined;
      let threw = false;
      // sequential on purpose: fuzz the state machine, not the lock
      try {
        r = await resolveSession(d, W, peer, {
          rigMission: rm ?? "",
          source: pick(sources) as never,
          claudeSessionId: rnd() < 0.5 ? undefined : `c${Math.floor(rnd() * 3)}` });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      const mission = normalizeMission(rm ?? "");
      expect(r.session).toBe(sessionName(peer, mission, r.n));
      expect(r.scope).toBe(scopeFor(mission));
      expect(r.mission).toBe(mission);
      expect(Number.isInteger(r.n)).toBe(true);
      expect(r.n).toBeGreaterThanOrEqual(1);
      if (i % 50 === 0) {
        await setRigMission(d, W, rm ?? "", "fuzzer");
        expect([GENERAL, mission]).toContain(readRigMission(d, W).mission);
      }
    }
  });
});
