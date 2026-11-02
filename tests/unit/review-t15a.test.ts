// T15a review (dev-review@openrig-honcho, qitem-20261031184834-7f662026, pin
// 86946b8, worktree wt-86946b8). Independent checks + findings for the
// once-guard (ADR-0010 decision 2). Findings are test.skip with the expected
// behaviour and the observed output. Fakes on 127.0.0.1 and temp dirs only;
// no Honcho calls.
//
// Complements build's once.test.ts / once-bins.test.ts (first/duplicate,
// takeover, key separation, 4 bins x 7 concurrent pairs, aged replay, prune,
// modes). These are the architect's extra targets: anything that makes
// takeOnce return false for a REAL event (identical stdin across events,
// clock skew, mtime granularity) and the stale-marker takeover race.
//
// NUL NOTE (same trap build hit in once.ts): a literal backslash-u NUL
// escape written through the agent Edit/Write tools lands in the file as a
// RAW NUL byte, which makes the file "binary" for further edits. All NULs
// here are built at runtime via String.fromCharCode(0); the source is pure
// ASCII except where quoted text needs otherwise.

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
import { createHash } from "node:crypto";
import { join } from "node:path";
import { takeOnce } from "../../plugin/src/once.ts";
import { scratchName } from "../support/scratch.ts";

const REPO = join(import.meta.dir, "..", "..");
const NUL = String.fromCharCode(0);

const mk = (): { stateDir: string; ws: string } => ({
  stateDir: makeTempDir("r15a-"),
  ws: scratchName("t15a") });

// same key formula as once.ts (hook, NUL, stdin), computed independently
const markerFile = (stateDir: string, ws: string, hook: string, stdin: string): string =>
  join(stateDir, ws, "once", createHash("sha256").update(hook + NUL + stdin, "utf8").digest("hex"));

describe("O1 key and window semantics (pure)", () => {
  test("O1.1 same stdin under a different hook, stdin or workspace is a different event", () => {
    const t = mk();
    try {
      const base = Date.now(); // the marker mtime is the real clock: inject real nows
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "SAME", base)).toBe(true);
      expect(takeOnce(t.stateDir, t.ws, "recall", "SAME", base + 1)).toBe(true); // same prompt, other hook
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "SAME ", base + 2)).toBe(true); // one byte more
      expect(takeOnce(t.stateDir, "other-ws", "user-prompt", "SAME", base + 3)).toBe(true);
      // and each of those re-deliveries IS suppressed
      expect(takeOnce(t.stateDir, t.ws, "recall", "SAME", base + 4)).toBe(false);
      expect(takeOnce(t.stateDir, "other-ws", "user-prompt", "SAME", base + 5)).toBe(false);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
  test("O1.2 window: 4999 ms duplicate; past 5 s the marker is taken over", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "stop", "S", base)).toBe(true);
      expect(takeOnce(t.stateDir, t.ws, "stop", "S", base + 4_999)).toBe(false);
      // "UNDER 5000 ms -> duplicate". The marker mtime is the real creation
      // instant, a few ms AFTER base, so the take side is sampled at +5100;
      // +5000 exactly would straddle the boundary on execution jitter. The
      // suppressed call above does not touch the marker.
      expect(takeOnce(t.stateDir, t.ws, "stop", "S", base + 5_100)).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
  test("O1.3 NUL-separator collision is real but unreachable (hook names are four constants)", () => {
    const t = mk();
    try {
      // informational pin: hook "a" with stdin NUL+"b" and hook "a"+NUL with
      // stdin "b" hash the SAME bytes (a + NUL + b). The separator only stops
      // collisions when neither side contains NUL. No bin passes a variable
      // hook name, so no real event pair can reach it; pinned so making hook
      // configurable is a known risk.
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "a", NUL + "b", base)).toBe(true);
      expect(takeOnce(t.stateDir, t.ws, "a" + NUL, "b", base + 1)).toBe(false);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
  // FINDING T15a-F2 (LOW). Observed 2026-10-31 at 86946b8: takeOnce returns
  // FALSE. A marker whose mtime is in the CALLER FUTURE (clock stepped back:
  // NTP correction, VM resume) computes negative elapsed, treated as fresh,
  // so a REAL event is suppressed for (5 s + rewind). Expected per ADR-0010
  // "the guard can drop a duplicate, never a real event": an mtime ahead of
  // now cannot be proven fresh - take the event (clamp: elapsed < 0 -> take).
  test("O1.4 clock rewind: a marker from the future must NOT suppress a real event", () => {
    const t = mk();
    try {
      const real = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", real)).toBe(true);
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", real - 10_000)).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

describe("O2 fail-open paths (pure)", () => {
  test("O2.1 stateDir a file / once path a file / parent read-only: always true", () => {
    const base = makeTempDir("r15a-");
    try {
      const asFile = join(base, "sa");
      writeFileSync(asFile, "x");
      expect(takeOnce(asFile, "ws", "stop", "x", Date.now())).toBe(true);
      const onceIsFile = join(base, "sb");
      mkdirSync(join(onceIsFile, "ws"), { recursive: true });
      writeFileSync(join(onceIsFile, "ws", "once"), "not a dir");
      expect(takeOnce(onceIsFile, "ws", "stop", "x", Date.now())).toBe(true);
      const ro = join(base, "sc");
      mkdirSync(ro, { recursive: true });
      chmodSync(ro, 0o500);
      expect(takeOnce(ro, "ws", "stop", "x", Date.now())).toBe(true);
      chmodSync(ro, 0o700);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("O2.2 a marker that is a directory: fresh suppresses (EEXIST), stale fail-opens true", () => {
    const t = mk();
    try {
      mkdirSync(join(t.stateDir, t.ws, "once"), { recursive: true });
      const key = createHash("sha256").update("stop" + NUL + "x", "utf8").digest("hex");
      mkdirSync(join(t.stateDir, t.ws, "once", key));
      // observed semantics (my first guess of EISDIR was wrong): O_EXCL on an
      // existing DIRECTORY is EEXIST, so a freshly planted dir marker
      // suppresses - plantable only from inside our 0700 once dir (same
      // trust domain). Past 5 s the takeover path hits EISDIR on touchMarker,
      // is caught, and fail-opens true. Pin both halves.
      expect(takeOnce(t.stateDir, t.ws, "stop", "x", Date.now())).toBe(false);
      const oldT = new Date(Date.now() - 6_000);
      utimesSync(join(t.stateDir, t.ws, "once", key), oldT, oldT);
      expect(takeOnce(t.stateDir, t.ws, "stop", "x", Date.now())).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
  test("O2.3 marker file mode 0600, dir 0700, marker content empty", () => {
    const t = mk();
    try {
      expect(takeOnce(t.stateDir, t.ws, "recall", "z", Date.now())).toBe(true);
      const f = markerFile(t.stateDir, t.ws, "recall", "z");
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(join(t.stateDir, t.ws, "once")).mode & 0o777).toBe(0o700);
      expect(readFileSync(f).length).toBe(0);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

describe("O3 prune", () => {
  test("O3.1 fresh stamp gates the sweep; aged stamp sweeps >1 h and spares fresh", () => {
    const t = mk();
    try {
      const dir = join(t.stateDir, t.ws, "once");
      mkdirSync(dir, { recursive: true });
      const oldM = join(dir, "deadbeef");
      writeFileSync(oldM, "");
      const past = new Date(Date.now() - 3_700_000);
      utimesSync(oldM, past, past);
      const stamp = join(dir, ".pruned");
      writeFileSync(stamp, "");
      const recent = new Date(Date.now() - 30_000);
      utimesSync(stamp, recent, recent);
      takeOnce(t.stateDir, t.ws, "stop", "trigger", Date.now()); // triggers maybePrune
      expect(existsSync(oldM)).toBe(true); // gated by the fresh stamp
      utimesSync(stamp, past, past); // stamp older than a minute
      takeOnce(t.stateDir, t.ws, "stop", "trigger2", Date.now());
      expect(existsSync(oldM)).toBe(false); // swept
      expect(existsSync(markerFile(t.stateDir, t.ws, "stop", "trigger2"))).toBe(true); // fresh kept
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- races
// Concurrent PROCESSES calling takeOnce directly (K=8); 7 rounds each.

const racerScript = (worktree: string): string => {
  const p = join(worktree, ".racer15a.ts");
  writeFileSync(
    p,
    'import { takeOnce } from "' + join(worktree, "plugin/src/once.ts") + '";\n' +
      "const [stateDir, ws, hook, stdin, now] = process.argv.slice(2);\n" +
      'console.log(takeOnce(stateDir, ws, hook, stdin, Number(now)) ? "TAKE" : "DUP");\n',
  );
  return p;
};

async function raceK(script: string, args: string[], k: number): Promise<string[]> {
  const runs = Array.from({ length: k }, () => Bun.spawn([process.execPath, script, ...args]));
  return Promise.all(runs.map(async (p) => (await new Response(p.stdout).text()).trim()));
}

describe("O4 concurrent takeOnce (kernel wx arbitration)", () => {
  test("O4.1 FRESH marker, K=8 concurrent: exactly one TAKE in each of 7 rounds", async () => {
    const script = racerScript(REPO);
    try {
      for (let round = 0; round < 7; round++) {
        const t = mk();
        try {
          const outs = await raceK(script, [t.stateDir, t.ws, "user-prompt", "SAME", String(Date.now())], 8);
          expect(outs.filter((o) => o === "TAKE").length).toBe(1);
        } finally {
          rmSync(t.stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(script, { force: true });
    }
  });
  // FINDING T15a-F1 (MEDIUM). Observed 2026-10-31 at 86946b8, 7 rounds, K=8:
  // takers = 2,2,1,2,2,2,2. The stale-marker takeover (touch "w" + utimes)
  // is NOT exclusive: the two fastest racers both stat the old marker before
  // either rewrites it and BOTH take. Expected (ADR-0010 "acts once per
  // event"): exactly one. Impact: in the two-installs shape, a prompt >5 s
  // after a byte-identical earlier one, delivered twice at one instant, runs
  // on BOTH copies - the exact double the guard exists for, at the >5 s
  // replay seam. Fix directions: arbitrate the takeover too - unlink then wx
  // retry, or rename the stale marker to a unique name (the rename winner
  // takes; the loser re-stats and finds the fresh marker).
  test("O4.2 STALE marker, K=8 concurrent: exactly one TAKE in each of 7 rounds", async () => {
    const script = racerScript(REPO);
    const dist: number[] = [];
    try {
      for (let round = 0; round < 7; round++) {
        const t = mk();
        try {
          expect(takeOnce(t.stateDir, t.ws, "user-prompt", "SAME", Date.now())).toBe(true);
          const aged = new Date(Date.now() - 6_000);
          utimesSync(markerFile(t.stateDir, t.ws, "user-prompt", "SAME"), aged, aged);
          const outs = await raceK(script, [t.stateDir, t.ws, "user-prompt", "SAME", String(Date.now())], 8);
          dist.push(outs.filter((o) => o === "TAKE").length);
        } finally {
          rmSync(t.stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(script, { force: true });
    }
    console.log(`O4.2 takeover race, takers per round (7 rounds, K=8): ${dist.join(",")}`);
    expect(Math.max(...dist)).toBe(1);
  });
});

describe("O5 bin-level guard ordering", () => {
  const BIN = join(REPO, "plugin/bin/recall.ts");
  const envBase = (stateDir: string, ws: string): Record<string, string> => ({
    HOME: stateDir,
    HONCHO_STATE_DIR: stateDir,
    HONCHO_URL: "http://127.0.0.1:9/v3", // never reached: these paths take no network
    HONCHO_WORKSPACE: ws,
    HONCHO_PEER: "build" });
  async function runRecall(env: Record<string, string>, stdin: unknown) {
    const p = Bun.spawn([process.execPath, BIN], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    p.stdin.write(JSON.stringify(stdin));
    p.stdin.end();
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, out, err };
  }
  test("O5.1 HONCHO_RECALL=off runs BEFORE the guard: no marker left", async () => {
    const t = mk();
    try {
      const stdin = { prompt: "hello", session_id: "s1" };
      const r = await runRecall({ ...envBase(t.stateDir, t.ws), HONCHO_RECALL: "off" }, stdin);
      expect([r.code, r.out, r.err]).toEqual([0, "", ""]);
      const dir = join(t.stateDir, t.ws, "once");
      expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0); // no marker consumed
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
  test("O5.2 kill switch runs BEFORE the guard: no marker, silent", async () => {
    const t = mk();
    try {
      const stdin = { prompt: "hello", session_id: "s1" };
      const r = await runRecall({ ...envBase(t.stateDir, t.ws), HONCHO_ENABLED: "0" }, stdin);
      expect([r.code, r.out, r.err]).toEqual([0, "", ""]);
      const dir = join(t.stateDir, t.ws, "once");
      expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
  test("O5.3 suppressed duplicate: silent exit 0, exactly one duplicate-run line, two log lines total", async () => {
    const t = mk();
    try {
      const stdin = { prompt: "hello", session_id: "s1" };
      await runRecall(envBase(t.stateDir, t.ws), stdin); // first run: not-peer line
      const b = await runRecall(envBase(t.stateDir, t.ws), stdin); // duplicate within 5 s
      expect([b.code, b.out, b.err]).toEqual([0, "", ""]);
      const log = join(t.stateDir, "log", `${t.ws}.log`);
      const lines = existsSync(log)
        ? readFileSync(log, "utf8").split("\n").filter((s) => s !== "").map((s) => JSON.parse(s) as Record<string, unknown>)
        : [];
      const dups = lines.filter((l) => l.event === "duplicate-run");
      expect(dups.length).toBe(1);
      expect(dups[0].ok).toBe(true);
      expect(dups[0].hook).toBe("recall");
      expect(lines.length).toBe(2); // one event, one line - not two per event
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});
