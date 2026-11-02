// T8d-1 + T8c-fix re-review attack suite (review seat, qitem
// -20261028215021, pin 95b1adb = cb32db5 T8c-fix + markers; T8d-1 cbe6765
// reviewed as its own change). Contract: ADR-0007 (scan zones + fake-secret
// marker), ADR-0006 O2 as amended (every loss counted; missing state CREATE,
// corrupt UNTOUCHED, busy silent no-op), T8d-1 item 0 (refused events).
//
// Attacks the qitem names: marker abuse (marker on another line, marker
// inside a string, marker outside tests/, code values, skills zone, "nothing
// printed"), counter paths under missing/corrupt/busy state, and the writer
// no-longer-folds-dropped double-count trap. The fuzz-can-fail and
// contract-catches-drift attacks are destructive (they plant a leak / rename
// a schema field) and run in throwaway copies OUTSIDE this file; their
// outputs are in the verdict note.
//
// Fixture secrets here are SHAPE-ONLY, built by runtime concatenation so no
// line of this file itself carries a secret-shaped match.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { execSync } from "node:child_process";
import {  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync  } from "node:fs";
import { dirname, join } from "node:path";
import { render, scanRepo } from "../../scripts/scan.ts";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { withLock } from "../../plugin/src/lock.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import { readSeatState, seatLockDir, seatStatePath } from "../../plugin/src/missions.ts";
import { statsFrom, updateStats } from "../../plugin/src/stats.ts";
import { recordBody } from "../../plugin/src/writer.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";
// shape-only values assembled at runtime; this file's own lines stay
// unmatchable by design (the concatenation is the point)
const SK_VAL = "sk-ant".concat("-ScanFix0123456789abcdefGHIJKLMN"); // anthropic shape
const ASSIGN_VAL = "ScanFixtureVal0123456789"; // 24 chars: assignment value, below opaque length

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A throwaway git repo whose index carries the given files, for scanRepo. */
const mkRepo = (files: Record<string, string>): string => {
  const dir = makeTempDir("rev-t8d-scan-");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, rel), body, { mode: 0o600 });
  }
  execSync("git init -q && git add -A", { cwd: dir, stdio: "pipe" });
  return dir;
};

describe("T8d-1 attack: ADR-0007 scan marker rule", () => {
  test("unmarked high-confidence shape under tests/ FAILS; the same line marked passes", () => {
    const secret = `const SK = ${JSON.stringify(SK_VAL)};`;
    const dirBad = mkRepo({ "tests/a.ts": `${secret}\n` });
    try {
      const bad = scanRepo(dirBad);
      expect(bad.ok).toBe(false);
      expect(bad.fails.length).toBe(1);
      expect(bad.fails[0]?.file).toBe("tests/a.ts");
      expect(bad.fails[0]?.line).toBe(1);
      expect(bad.fails[0]?.kind).toBe("anthropic");
    } finally {
      rmSync(dirBad, { recursive: true, force: true });
    }
    const dirGood = mkRepo({ "tests/a.ts": `${secret} // fake-secret\n` });
    try {
      const good = scanRepo(dirGood);
      expect(good.ok).toBe(true);
      expect(good.lists.some((l) => l.file === "tests/a.ts" && l.line === 1)).toBe(true);
    } finally {
      rmSync(dirGood, { recursive: true, force: true });
    }
  });

  test("marker on a DIFFERENT line does not mark the match (per-line rule)", () => {
    const dir = mkRepo({
      "tests/a.ts": `// fake-secret\nconst SK = ${JSON.stringify(SK_VAL)};\n` });
    try {
      const r = scanRepo(dir);
      expect(r.ok).toBe(false);
      expect(r.fails[0]?.line).toBe(2); // the secret line, not the marker line
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("marker INSIDE a string on the match line passes - ADR-0007 is a line-substring rule (documented weakness)", () => {
    // The ADR wording is "the line carries the substring fake-secret"; the
    // scan implements exactly that (scan.ts:133). This pins the behaviour so
    // an implementation drift either way is caught, and records that the
    // rule cannot tell a comment from a string.
    const dir = mkRepo({
      "tests/a.ts": `const SK = ${JSON.stringify(SK_VAL)}; const note = "fake-secret";\n` });
    try {
      const r = scanRepo(dir);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-code assignment value under tests/ fails unmarked; a CODE value is listed unmarked", () => {
    const dirBad = mkRepo({ "tests/b.ts": `const API_KEY = ${JSON.stringify(ASSIGN_VAL)};\n` });
    try {
      const bad = scanRepo(dirBad);
      expect(bad.ok).toBe(false);
      expect(bad.fails[0]?.kind).toBe("assignment");
    } finally {
      rmSync(dirBad, { recursive: true, force: true });
    }
    // a call/path/interp value is code: LISTED, marker not required
    const dirCode = mkRepo({ "tests/c.ts": "const API_KEY = loadFrom(process.env);\n" });
    try {
      const good = scanRepo(dirCode);
      expect(good.ok).toBe(true);
      expect(good.lists.some((l) => l.file === "tests/c.ts" && l.kind === "assignment")).toBe(true);
    } finally {
      rmSync(dirCode, { recursive: true, force: true });
    }
  });

  test("outside tests/ the marker does NOT rescue: docs stay strict", () => {
    const dir = mkRepo({
      "docs/d.md": `key: ${JSON.stringify(SK_VAL)} <!-- fake-secret -->\n` });
    try {
      const r = scanRepo(dir);
      expect(r.ok).toBe(false);
      expect(r.fails[0]?.file).toBe("docs/d.md");
      expect(r.fails[0]?.kind).toBe("anthropic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(".claude/skills/ is list-only: unmarked high-confidence there is LISTED, never failed", () => {
    const dir = mkRepo({ ".claude/skills/guide.md": `example key ${JSON.stringify(SK_VAL)}\n` });
    try {
      const r = scanRepo(dir);
      expect(r.ok).toBe(true);
      expect(r.fails.length).toBe(0);
      expect(r.lists.some((l) => l.file === ".claude/skills/guide.md")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("nothing printed: a FAIL line is file:line:kind + fixed phrase, never the matched value", () => {
    const dir = mkRepo({ "tests/a.ts": `const SK = ${JSON.stringify(SK_VAL)};\n` });
    try {
      const r = scanRepo(dir);
      const text = render(r);
      expect(text).toContain("FAIL tests/a.ts:1:anthropic");
      expect(text).not.toContain(SK_VAL); // the value itself never appears
      expect(text).not.toContain(ASSIGN_VAL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git-error tree FAILS the scan (T8d-2 ruling 22:45Z - was the NOTE pin, retargeted): a scan of nothing is not a pass", () => {
    const dir = makeTempDir("rev-t8d-nogit-"); // no git repo at all
    try {
      const r = scanRepo(dir);
      expect(r.ok).toBe(false);
      expect(r.fails.some((f) => f.kind === "git_ls_files" && f.file === "(scan)" && f.line === 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the REAL repo passes the full gate (permanent guard, from F-T8e-1)", () => {
    // Raised as F-T8e-1 at a6cea32: tests/soak/soak.test.ts:10 carried an
    // unmarked assignment-shaped match and FAILED the gate; build reworded
    // the comment. This test guards the gate permanently. (URL shape:
    // import.meta.url is .../tests/unit/<file>, so "../../" is the repo
    // root - my first version used ../../../ and scanned a non-git dir,
    // a bug of my own caught by build 00:33Z.)
    const root = new URL("../../", import.meta.url).pathname;
    const r = scanRepo(root);
    expect(r.fails.map((f) => `${f.file}:${f.line}:${f.kind}`)).toEqual([]);
  });

  test("EMPTY tracked repo FAILS with no_tracked_files (the other vacuous-scan door)", () => {
    const dir = makeTempDir("rev-t8d-empty-");
    try {
      execSync("git init -q", { cwd: dir, stdio: "pipe" }); // a repo, zero tracked files
      const r = scanRepo(dir);
      expect(r.ok).toBe(false);
      expect(r.fails.some((f) => f.kind === "no_tracked_files" && f.file === "(scan)")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T8c-fix attack: counters under missing / corrupt / busy seat state", () => {
  const mkDir = (): string => makeTempDir("rev-t8d-stats-");

  test("MISSING state: updateStats creates a minimal seat and keeps the counts", async () => {
    const dir = mkDir();
    try {
      await updateStats(dir, WS, "fresh", (s) => {
        s.written = 2;
      });
      const state = readSeatState(seatStatePath(dir, WS, "fresh")) as Record<string, unknown>;
      expect(state).not.toBeNull();
      expect(state.mission).toBe(""); // resolveSession treats "" as fresh
      expect(state.n).toBe(1);
      expect(state.counters).toEqual({});
      expect(statsFrom(state as never).written).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CORRUPT state: silent no-op, the file is never replaced", async () => {
    const dir = mkDir();
    try {
      const path = seatStatePath(dir, WS, "bad");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "{ this is not json", { mode: 0o600 });
      const before = readFileSync(path, "utf8");
      await updateStats(dir, WS, "bad", (s) => {
        s.written = 5;
      });
      expect(readFileSync(path, "utf8")).toBe(before); // untouched, not recreated
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BUSY lock with MISSING state: silent no-op - and it does NOT create the file", async () => {
    const dir = mkDir();
    try {
      const holder = withLock(seatLockDir(dir, WS, "busy"), () => sleep(2400)); // past WAIT_MS
      await sleep(50); // let the holder acquire
      const t0 = Date.now();
      await updateStats(dir, WS, "busy", (s) => {
        s.written = 7;
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1900); // waited out the lock
      expect(existsSync(seatStatePath(dir, WS, "busy"))).toBe(false);
      await holder;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 8000);

  test("BUSY lock with EXISTING state: counters unchanged afterwards", async () => {
    const dir = mkDir();
    try {
      await updateStats(dir, WS, "held", (s) => {
        s.written = 1;
      });
      const holder = withLock(seatLockDir(dir, WS, "held"), () => sleep(2400));
      await sleep(50);
      await updateStats(dir, WS, "held", (s) => {
        s.written = 99;
      });
      await holder;
      expect(statsFrom(readSeatState(seatStatePath(dir, WS, "held"))).written).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 8000);

  test("writer spool path counts a drop exactly ONCE (spoolAppend counts, writer does not fold it)", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("rev-t8d-w-");
    try {
      fake.failPattern("/messages", { status: 500 });
      const config: Config = {
        enabled: true,
        url: fake.url,
        workspace: WS,
        peer: SELF,
        observeOthers: false,
        ownerPeer: "owner",
        profileWorkspace: null,
        recordAutomation: false,
        apiKey: "sk-ant-RevT8dKeyFake0123456789abcdefGHIJ", // fake-secret
        stateDir: dir,
        timeoutMs: 2000 };
      const client = createClient({ url: fake.url, workspace: WS, apiKey: config.apiKey, timeoutMs: 2000 });
      // (1) the writer's spool fold: a normal write under outage counts
      // failed+spooled and NOTHING in dropped - the writer no longer folds
      // SendOutcome.dropped (double-count trap, spool.ts counts at the loss).
      const out = await recordBody(
        { content: "ordinary note", sender: SELF, kindTag: "decision", hookName: "rev-t8d" },
        config,
        { client, now: () => "2026-10-28T12:00:00.000Z" },
      );
      expect(out.action).toBe("spooled");
      let stats = statsFrom(readSeatState(seatStatePath(dir, WS, SELF)));
      expect(stats.failed).toBe(1);
      expect(stats.spooled).toBe(1);
      expect(stats.dropped).toBe(0); // the fold adds no drops
      // (2) the same seat's spool-append path loses one oversized message:
      // counted exactly once, at spoolAppend.
      const { spoolAppend } = await import("../../plugin/src/spool.ts");
      await spoolAppend({ stateDir: dir, workspace: WS, peer: SELF }, {
        session: "build--general--1",
        messages: [
          { peer_id: SELF, content: "small", metadata: { client_id: "s1" } },
          { peer_id: SELF, content: "y".repeat(300_000), metadata: { client_id: "big" } },
        ],
        maybe_sent: false,
        at: "2026-10-28T12:00:00.000Z" });
      stats = statsFrom(readSeatState(seatStatePath(dir, WS, SELF)));
      expect(stats.dropped).toBe(1); // once - a writer fold on top would show 2
      expect(stats.spooled).toBe(1); // spooled is the writer's fold only; direct appends count losses, not spooled
      expect(stats.written).toBe(0);
    } finally {
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T8d-1: refused events on the remember leader gate", () => {
  test("remember by a NON-LEADER logs event refused, error_class refused, ok false", async () => {
    const dir = makeTempDir("rev-t8d-r-");
    try {
      const config: Config = {
        enabled: true,
        url: "http://127.0.0.1:9", // never touched: refusal precedes any network
        workspace: WS,
        peer: SELF,
        observeOthers: false,
        leaderPeer: "someone.else",
        ownerPeer: "owner",
        profileWorkspace: null,
        recordAutomation: false,
        apiKey: "sk-ant-RevT8dRefFake0123456789abcdefGHIJKL", // fake-secret
        stateDir: dir,
        timeoutMs: 2000 };
      const deps = { config, client: createClient({ url: config.url, workspace: WS, apiKey: config.apiKey, timeoutMs: 2000 }), now: () => "2026-10-28T12:00:00.000Z" };
      const line = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "remember", arguments: { fact: "plain fact, no secret" } } });
      const res = JSON.parse((await handleLine(line, deps)) as string) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]?.text).toBe("remember is leader-only");
      const log = readFileSync(join(dir, "log", `${WS}.log`), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(log.length).toBe(1);
      expect(log[0]?.event).toBe("refused");
      expect(log[0]?.ok).toBe(false);
      expect(log[0]?.error_class).toBe("refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
