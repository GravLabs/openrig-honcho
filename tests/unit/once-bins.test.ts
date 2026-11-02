// T15a (ADR-0010 decision 2): the four hook bins, spawned for real. Two
// concurrent copies of a bin with byte-identical stdin (the two-installs
// shape from pilot) must produce EXACTLY ONE effect - one stdout block
// for session-start and recall, one messages POST for user-prompt and stop -
// and exactly one duplicate-run log line. 7 iterations per bin, fresh state
// dir and scratch workspace each; the distribution is printed. Fakes on
// 127.0.0.1 only; no Honcho server touched.
//
// Stop runs its fake in slow mode (500 ms/request): the point of the RED run
// on main is that the SECOND copy really does double-write, not that E3's
// last_reply_hash happens to land before the late copy reads seat state.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import {  readFileSync, rmSync, utimesSync  } from "node:fs";
import { join } from "node:path";
import type { FakeHoncho } from "../support/fake-honcho.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";
import { scratchName } from "../support/scratch.ts";

const REPO = join(import.meta.dir, "..", "..");
const BIN = (name: string): string => join(REPO, "plugin/bin", `${name}.ts`);
const ITERATIONS = 7;

// Built, never written raw (same reason as once.ts).
const NUL = String.fromCharCode(0);

interface Run {
  code: number;
  out: string;
  err: string;
}

const runBin = async (
  bin: string,
  env: Record<string, string>,
  stdin: string,
): Promise<Run> => {
  const proc = Bun.spawn([process.execPath, bin], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
};

const baseEnv = (stateDir: string, ws: string, url: string): Record<string, string> => ({
  HOME: stateDir,
  HONCHO_STATE_DIR: stateDir,
  HONCHO_URL: url,
  HONCHO_WORKSPACE: ws,
  HONCHO_PEER: "build" });

const logLines = (stateDir: string, ws: string): Record<string, unknown>[] => {
  const file = join(stateDir, "log", `${ws}.log`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((s) => s !== "")
    .map((s) => JSON.parse(s) as Record<string, unknown>);
};

const countWhere = (
  lines: Record<string, unknown>[],
  pred: (l: Record<string, unknown>) => boolean,
): number => lines.filter(pred).length;

const messagePosts = (fake: FakeHoncho): number =>
  fake.requests.filter((r) => r.method === "POST" && r.path.includes("/messages")).length;

/** One iteration of the shared battery: byte-identical stdin, two spawns at
 * once, then the effect/dup/win tally. The caller supplies what counts as
 * one effect and the winner's normal event name. */
async function pair(
  bin: string,
  stateDir: string,
  ws: string,
  fake: FakeHoncho,
  stdin: string,
  effect: (r: Run) => boolean,
  winnerEvent: string,
): Promise<{ effects: number; dups: number; wins: number; lines: number }> {
  const [a, b] = await Promise.all([
    runBin(bin, baseEnv(stateDir, ws, fake.url), stdin),
    runBin(bin, baseEnv(stateDir, ws, fake.url), stdin),
  ]);
  for (const r of [a, b]) {
    expect(r.code).toBe(0);
    expect(r.err).toBe(""); // silence rules hold for the loser too
  }
  const lines = logLines(stateDir, ws);
  return {
    effects: [a, b].filter(effect).length,
    dups: countWhere(lines, (l) => l.event === "duplicate-run"),
    wins: countWhere(lines, (l) => l.event === winnerEvent),
    lines: lines.length };
}

// The daemon-stamped peer envelope (same shape recall-bin.test.ts pins).
const peerPrompt = (ws: string): string =>
  [
    `From: dev-x@${ws}`,
    `To: build@${ws}`,
    "Sent: 10-31 09:00Z",
    "---",
    "did the once-guard land?",
    "---",
    `↩ Reply: rig send dev-x@${ws} "..."`,
  ].join("\n");

describe("once-guard bin pairs (T15a, ADR-0010)", () => {
  test(
    "session-start x7: one stdout block and one duplicate-run per pair",
    async () => {
      const fake = await startFakeHoncho();
      const dist: string[] = [];
      try {
        for (let i = 0; i < ITERATIONS; i++) {
          const stateDir = makeTempDir("t15a-ss-");
          const ws = scratchName();
          try {
            fake.setPeerCard(ws, "build", ["ONCE-CARD"]);
            const stdin = JSON.stringify({ session_id: "c1", source: "startup" });
            const r = await pair(
              BIN("session-start"), stateDir, ws, fake, stdin,
              (x) => x.out.includes("ONCE-CARD"),
              "startup",
            );
            dist.push(`#${i + 1} block=${r.effects} dup=${r.dups} win=${r.wins}`);
            expect(r.effects).toBe(1);
            expect(r.dups).toBe(1);
            expect(r.wins).toBe(1);
            expect(r.lines).toBe(2);
          } finally {
            rmSync(stateDir, { recursive: true, force: true });
          }
        }
      } finally {
        console.log(`T15a session-start: one-effect ${dist.filter((d) => d.includes("block=1")).length}/${ITERATIONS} [${dist.join(", ")}]`);
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "recall x7: one stdout block and one duplicate-run per pair",
    async () => {
      const fake = await startFakeHoncho();
      const dist: string[] = [];
      try {
        for (let i = 0; i < ITERATIONS; i++) {
          const stateDir = makeTempDir("t15a-rec-");
          const ws = scratchName();
          try {
            // T16b fixture: recall now runs on /conclusions/query with the
            // 30-minute context floor, so the seeded conclusions must be
            // older than the floor (2 h) or nothing would render.
            const oldAt = new Date(Date.now() - 2 * 3600_000).toISOString();
            fake.addConclusion(ws, { content: "ONCE-FACT", observer_id: "build", observed_id: "dev-x", created_at: oldAt });
            fake.addConclusion(ws, { content: "ONCE-FACT-2", observer_id: "scope.general", observed_id: "dev-x", created_at: oldAt });
            const stdin = JSON.stringify({ prompt: peerPrompt(ws), session_id: "c1" });
            const r = await pair(
              BIN("recall"), stateDir, ws, fake, stdin,
              (x) => x.out.includes("ONCE-FACT"),
              "injected",
            );
            dist.push(`#${i + 1} block=${r.effects} dup=${r.dups} win=${r.wins}`);
            expect(r.effects).toBe(1);
            expect(r.dups).toBe(1);
            expect(r.wins).toBe(1);
            expect(r.lines).toBe(2);
          } finally {
            rmSync(stateDir, { recursive: true, force: true });
          }
        }
      } finally {
        console.log(`T15a recall: one-effect ${dist.filter((d) => d.includes("block=1")).length}/${ITERATIONS} [${dist.join(", ")}]`);
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "user-prompt x7: one messages POST and one duplicate-run per pair",
    async () => {
      const fake = await startFakeHoncho();
      const dist: string[] = [];
      try {
        for (let i = 0; i < ITERATIONS; i++) {
          const stateDir = makeTempDir("t15a-up-");
          const ws = scratchName();
          try {
            const before = messagePosts(fake);
            const stdin = JSON.stringify({ prompt: `note ${i}: remember the once-guard`, session_id: "c1" });
            const r = await pair(
              BIN("user-prompt"), stateDir, ws, fake, stdin,
              () => false, // effect counted via the fake, not stdout
              "sent",
            );
            const posts = messagePosts(fake) - before;
            dist.push(`#${i + 1} post=${posts} dup=${r.dups} win=${r.wins}`);
            expect(posts).toBe(1);
            expect(r.dups).toBe(1);
            expect(r.wins).toBe(1);
            expect(r.lines).toBe(2);
          } finally {
            rmSync(stateDir, { recursive: true, force: true });
          }
        }
      } finally {
        console.log(`T15a user-prompt: one-effect ${dist.filter((d) => d.includes("post=1")).length}/${ITERATIONS} [${dist.join(", ")}]`);
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "stop x7 (slow fake): one messages POST and one duplicate-run per pair",
    async () => {
      const fake = await startFakeHoncho();
      fake.mode("slow", { delayMs: 500 }); // keep the E3 window wide: on main the double-write must be real
      const dist: string[] = [];
      try {
        for (let i = 0; i < ITERATIONS; i++) {
          const stateDir = makeTempDir("t15a-stop-");
          const ws = scratchName();
          try {
            const before = messagePosts(fake);
            const stdin = JSON.stringify({
              session_id: "c1",
              last_assistant_message: `reply ${i} from the stop pair` });
            const r = await pair(
              BIN("stop"), stateDir, ws, fake, stdin,
              () => false,
              "sent",
            );
            const posts = messagePosts(fake) - before;
            dist.push(`#${i + 1} post=${posts} dup=${r.dups} win=${r.wins}`);
            expect(posts).toBe(1);
            expect(r.dups).toBe(1);
            expect(r.wins).toBe(1);
            expect(r.lines).toBe(2);
          } finally {
            rmSync(stateDir, { recursive: true, force: true });
          }
        }
      } finally {
        console.log(`T15a stop: one-effect ${dist.filter((d) => d.includes("post=1")).length}/${ITERATIONS} [${dist.join(", ")}]`);
        await fake.stop();
      }
    },
    120_000,
  );

  test(
    "same stdin again after the marker ages out (mtime back 5.1 s) runs normally",
    async () => {
      const fake = await startFakeHoncho();
      try {
        const stateDir = makeTempDir("t15a-age-");
        const ws = scratchName();
        try {
          const stdin = JSON.stringify({ prompt: "a prompt that repeats in six seconds", session_id: "c1" });
          const first = await runBin(BIN("user-prompt"), baseEnv(stateDir, ws, fake.url), stdin);
          expect(first.code).toBe(0);
          expect(first.out).toBe("");
          expect(messagePosts(fake)).toBe(1);
          const marker = join(
            stateDir,
            ws,
            "once",
            createHash("sha256").update("user-prompt" + NUL + stdin, "utf8").digest("hex"),
          );
          const t = new Date(Date.now() - 5_100);
          utimesSync(marker, t, t);
          const second = await runBin(BIN("user-prompt"), baseEnv(stateDir, ws, fake.url), stdin);
          expect(second.code).toBe(0);
          expect(second.out).toBe("");
          expect(messagePosts(fake)).toBe(2); // the repeated prompt is a real event
          const lines = logLines(stateDir, ws);
          expect(countWhere(lines, (l) => l.event === "duplicate-run")).toBe(0);
          expect(countWhere(lines, (l) => l.event === "sent")).toBe(2);
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );
});
