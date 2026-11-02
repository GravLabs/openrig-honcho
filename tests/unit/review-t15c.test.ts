// T15c recheck (dev-review@openrig-honcho, qitem-20261031224849-0dcd237ae25bbd94,
// pin c20281e, worktree ohr-t15c). Attack targets from the queue item: stale
// .gen- claim claims, prune racing a claim (can it DROP a real event?),
// fail-open completeness, String(mtimeMs) precision on this fs (tmpfs), and
// the mixed stale-seen/refreshed-seen racer shape. Findings are FAILING tests
// (unskipped, expected behaviour asserted); passing tests pin confirmed
// behaviour. Temp dirs only, fakes on 127.0.0.1 never reached, no Honcho,
// no commits. Pure ASCII; NUL via String.fromCharCode(0) (the raw-NUL trap).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  chmodSync,
  existsSync,
  mkdirSync,
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
const HOUR = 3_600_000;

const mk = (): { stateDir: string; ws: string } => ({
  stateDir: makeTempDir("r15c-"),
  ws: scratchName("t15c") });

const markerFile = (stateDir: string, ws: string, hook: string, stdin: string): string =>
  join(stateDir, ws, "once", createHash("sha256").update(hook + NUL + stdin, "utf8").digest("hex"));

const age = (path: string, ms: number): number => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
  return t.getTime();
};

// the claim name arbitrateExisting derives: <file>.gen-<String(st.mtimeMs)>
const claimName = (mainPath: string): string =>
  mainPath + ".gen-" + String(statSync(mainPath).mtimeMs);

// ------------------------------------------------------------- C1 aged claim
describe("C1 a .gen- claim older than prune age must not suppress a real event", () => {
  // FINDING T15c-C1 (candidate). Repro below at c20281e: returns FALSE.
  // A gen whose takeover happened once leaves a .gen- claim behind. If the
  // seat then goes quiet >1 h (no hook event, so no prune sweep), BOTH the
  // main marker and its .gen- claim age past 1 h together. The next genuine
  // byte-identical event (same prompt re-sent to the same session hours
  // later: recall stdin = raw Claude Code JSON, stable within a session)
  // stats the stale marker, tries the wx claim, gets EEXIST from the AGED
  // claim - a claim no concurrent racer can own (claims are made within one
  // event instant of their generation) - and stands down. ADR-0010: "the
  // guard can drop a duplicate, never a real event"; a byte-identical
  // prompt hours later is a real event (the ADR itself: markers older than
  // the window are overwritten so repeats still run). maybePrune runs only
  // AFTER the verdict is set, so the event is already lost. Fix directions:
  // run the sweep BEFORE arbitrating, or on claim-EEXIST stat the claim and
  // treat a claim older than DUP_WINDOW (its racer is long gone; the winner
  // refreshed main) as absent -> retry the takeover.
  test("C1.1 aged main + aged claim for that gen: the next replay must TAKE", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", base)).toBe(true);
      const main = markerFile(t.stateDir, t.ws, "user-prompt", "P");
      age(main, 2 * HOUR);
      const claim = claimName(main);
      writeFileSync(claim, "");
      age(claim, 2 * HOUR); // a takeover two hours ago left this claim
      // stamp left FRESH: prune gated (busy-dir shape) - verdict is set
      // before maybePrune anyway, so either stamp age shows the drop
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", Date.now())).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  // observed-shape pin: with an AGED stamp the drop is exactly one event -
  // the losing call's maybePrune sweeps main+claim, so the replay after
  // takes. If C1 is fixed, this still holds (both take).
  test("C1.2 aged stamp: drop is bounded to one event (second replay takes)", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", base)).toBe(true);
      const main = markerFile(t.stateDir, t.ws, "user-prompt", "P");
      age(main, 2 * HOUR);
      const claim = claimName(main);
      writeFileSync(claim, "");
      age(claim, 2 * HOUR);
      age(join(t.stateDir, t.ws, "once", ".pruned"), 2 * HOUR);
      takeOnce(t.stateDir, t.ws, "user-prompt", "P", Date.now()); // verdict: drop or take
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", Date.now())).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  // contrast: aged main WITHOUT a claim takes (the sweep-after still works
  // for the no-claim shape; the landmine is specifically the leftover claim)
  test("C1.3 aged main, no claim: replay TAKES", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", base)).toBe(true);
      age(markerFile(t.stateDir, t.ws, "user-prompt", "P"), 2 * HOUR);
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", Date.now())).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  // claim-name rotation: two back-to-back takeovers (injected now runs
  // ahead of the wall refresh) both take - generations strictly advance, so
  // live claims never collide by name
  test("C1.4 back-to-back takeovers at +6.1s and +12.1s: both TAKE", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "stop", "R", base)).toBe(true);
      expect(takeOnce(t.stateDir, t.ws, "stop", "R", base + 6_100)).toBe(true);
      expect(takeOnce(t.stateDir, t.ws, "stop", "R", base + 12_100)).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------- C2 prune race
// K=8 is O4.2 (fresh+stale, no prune). Here a THIRD event whose prune sweep
// fires mid-arbitration: pruner C (own fresh stdin, aged .pruned stamp, aged
// E marker) sweeps E's marker away between racer A's stale stat (A holds the
// gen claim, its utimes hits ENOENT - ignored - and A still TAKES with no
// marker present) and racer B's wx (succeeds on the absent path -> second
// TAKE). Code window: arbitrateExisting never re-creates main after a missed
// utimes; takeOnce main path is wx-only. Duplicate shape, not a drop; the
// queue item weighs drops heavier, but T15c claims the absence window is
// "gone by construction" and a pruner can still open one.
const racerScript = (worktree: string, name: string): string => {
  const p = join(worktree, name);
  writeFileSync(
    p,
    'import { takeOnce } from "' + join(worktree, "plugin/src/once.ts") + '";\n' +
      "const [stateDir, ws, hook, stdin] = process.argv.slice(2);\n" +
      // 4-arg form, default now = wall clock at spawn: production parity
      'console.log(takeOnce(stateDir, ws, hook, stdin) ? "TAKE" : "DUP");\n',
  );
  return p;
};

async function raceOnce(script: string, args: string[]): Promise<string> {
  const p = Bun.spawn([process.execPath, script, ...args]);
  return (await new Response(p.stdout).text()).trim();
}

// DRAFT TRAP (caught by control, kept as comment): injecting now = base + 2 h
// while the takeover refresh stamps WALL now makes every post-refresh arrival
// read the just-refreshed marker as stale under a fresh gen NAME (wall clock),
// so each takes - a test artifact, not a product race (11/15 doubles even
// with the sweep gated). Racers below pass the REAL Date.now(); staleness and
// prunability come from aging the marker on disk, exactly like production
// (bins use the default now).
describe("C2 prune sweep racing a stale takeover: doubles bounded over 175 rounds", () => {
  // Merged C2.1+C2.2 per the architect ruling 2026-11-01 00:00Z: a
  // zero-tolerance gate on an ACCEPTED residual cannot be a gate. The
  // accepted prune residual (once.ts, maybePrune docblock): the sweep stats
  // main, a claim winner refreshes it, the sweep unlinks on its stale stat,
  // and a later copy creates it - two TAKE for one event, the ADR-allowed
  // duplicate direction; unclosable without an unlink-if-unchanged the
  // ruling did not ask for. Measured: 49 double rounds per 175 pre-fix;
  // ~1 per 175 with the C1/C2 guards and the sweep re-stat. 175 rounds
  // assert at most 15 double rounds and print the count: the bound catches a
  // regression (dropping the guard fails at ~49) without flaking on the
  // accepted ~1/175. Raised from 5 (architect 00:35Z): a loaded machine gave
  // 4 in one run, and the gate is a loaded run.
  test("C2 two E-copies + one pruner, aged E marker, 175 rounds: doubles <= 15", async () => {
    const script = racerScript(REPO, ".racer15c.ts");
    const dist: number[] = [];
    try {
      for (let batch = 0; batch < 7; batch++) {
        for (let round = 0; round < 25; round++) {
          const t = mk();
          try {
            const base = Date.now();
            expect(takeOnce(t.stateDir, t.ws, "user-prompt", "E", base)).toBe(true);
            age(markerFile(t.stateDir, t.ws, "user-prompt", "E"), 2 * HOUR); // stale AND prunable
            age(join(t.stateDir, t.ws, "once", ".pruned"), 2 * HOUR); // stamp aged: C will sweep
            // C is a different event: its wx takes instantly, then maybePrune
            // sweeps the 2 h-old E marker (and any .gen- of it) mid-A/B
            const outs = await Promise.all([
              raceOnce(script, [t.stateDir, t.ws, "user-prompt", "E"]),
              raceOnce(script, [t.stateDir, t.ws, "user-prompt", "E"]),
              raceOnce(script, [t.stateDir, t.ws, "user-prompt", "PRUNER-C"]),
            ]);
            dist.push(outs.slice(0, 2).filter((o) => o === "TAKE").length);
          } finally {
            rmSync(t.stateDir, { recursive: true, force: true });
          }
        }
      }
    } finally {
      rmSync(script, { force: true });
    }
    const doubles = dist.filter((n) => n > 1).length;
    const zeros = dist.filter((n) => n === 0).length;
    console.log(
      `C2 merged prune-vs-claim race, 175 rounds: doubles=${String(doubles)} zeros=${String(zeros)} takers-per-round=${dist.join(",")}`,
    );
    expect(doubles).toBeLessThanOrEqual(15);
  }, 900_000);
});

// ------------------------------------------------------- C3 mixed stale/fresh
describe("C3 mixed: stale-seen racers and refreshed-seen copies, one event one take", () => {
  test("C3.1 race 8 on a stale marker, then 3 immediate copies, then a 6.1s-later copy", async () => {
    const script = racerScript(REPO, ".racer15c3.ts");
    const distA: number[] = [];
    const distB: number[] = [];
    const distC: number[] = [];
    try {
      for (let round = 0; round < 7; round++) {
        const t = mk();
        try {
          const base = Date.now();
          expect(takeOnce(t.stateDir, t.ws, "recall", "M", base)).toBe(true);
          age(markerFile(t.stateDir, t.ws, "recall", "M"), 6_000); // stale, no claim
          const outs = await Promise.all(
            Array.from({ length: 8 }, () => raceOnce(script, [t.stateDir, t.ws, "recall", "M"])),
          );
          distA.push(outs.filter((o) => o === "TAKE").length);
          // phase B: copies that land AFTER the winner's wall refresh - they
          // see a fresh marker (elapsed ~0, either sign) and must all DUP
          const b = [
            takeOnce(t.stateDir, t.ws, "recall", "M", Date.now()),
            takeOnce(t.stateDir, t.ws, "recall", "M", Date.now()),
            takeOnce(t.stateDir, t.ws, "recall", "M", Date.now()),
          ];
          distB.push(b.filter(Boolean).length);
          // phase C: a genuinely new event 6.1 s later (injected now ahead
          // of the wall refresh): stale gen, NEW gen name, unclaimed -> TAKE
          distC.push(takeOnce(t.stateDir, t.ws, "recall", "M", Date.now() + 6_100) ? 1 : 0);
        } finally {
          rmSync(t.stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(script, { force: true });
    }
    console.log(`C3.1 7 rounds - A (8 racers, stale): ${distA.join(",")} | B (post-refresh): ${distB.join(",")} | C (+6.1s new event): ${distC.join(",")}`);
    expect(Math.max(...distA)).toBe(1);
    expect(Math.max(...distB)).toBe(0);
    expect(Math.min(...distC)).toBe(1);
  }, 120_000);
});

// ------------------------------------------------------------ C4 fail-open
describe("C4 every error path fail-opens; takeOnce never throws", () => {
  test("C4.1 stale marker + unwritable dir: claim EACCES -> true; no throw on odd inputs", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "stop", "S", base)).toBe(true);
      const dir = join(t.stateDir, t.ws, "once");
      age(markerFile(t.stateDir, t.ws, "stop", "S"), 6_000); // stale -> takeover
      chmodSync(dir, 0o500); // claim wx -> EACCES -> must fail OPEN true
      expect(takeOnce(t.stateDir, t.ws, "stop", "S", Date.now())).toBe(true);
      chmodSync(dir, 0o700);
      // odd inputs never throw and key correctly
      expect(() => takeOnce(t.stateDir, t.ws, "h", "é🙂".repeat(1000), Date.now())).not.toThrow();
      expect(takeOnce(t.stateDir, t.ws, "h", "é🙂".repeat(1000), Date.now())).toBe(false); // second is a dup
      expect(() => takeOnce(t.stateDir, t.ws, "", "", Date.now())).not.toThrow();
      // fresh marker + unwritable dir: stat succeeds -> correct DUP, no throw
      expect(takeOnce(t.stateDir, t.ws, "stop", "FRESH", Date.now())).toBe(true);
      chmodSync(dir, 0o500);
      expect(takeOnce(t.stateDir, t.ws, "stop", "FRESH", Date.now())).toBe(false);
      chmodSync(dir, 0o700);
    } finally {
      chmodSync(join(t.stateDir, t.ws, "once"), 0o700);
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("C4.2 fresh claim file present (live racer): DUP, as designed", () => {
    const t = mk();
    try {
      const base = Date.now();
      expect(takeOnce(t.stateDir, t.ws, "stop", "X", base)).toBe(true);
      age(markerFile(t.stateDir, t.ws, "stop", "X"), 6_000);
      const main = markerFile(t.stateDir, t.ws, "stop", "X");
      const claim = claimName(main);
      writeFileSync(claim, ""); // FRESH claim: a racer took this gen this instant
      expect(takeOnce(t.stateDir, t.ws, "stop", "X", Date.now())).toBe(false);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------- C5 mtimeMs precision
describe("C5 String(mtimeMs) is one value per generation on this fs (tmpfs)", () => {
  test("C5.1 8 concurrent stats of one inode agree on String(mtimeMs); utimes round-trips ms exactly", async () => {
    const scriptPath = join(REPO, ".stat15c.ts");
    try {
      writeFileSync(
        scriptPath,
        "import { statSync } from 'node:fs';\n" +
          "console.log(String(statSync(process.argv[2]).mtimeMs));\n",
      );
      const t = mk();
      try {
        const base = Date.now();
        expect(takeOnce(t.stateDir, t.ws, "stop", "V", base)).toBe(true);
        const main = markerFile(t.stateDir, t.ws, "stop", "V");
        // fractional mtimeMs from native create would show here
        const frac = statSync(main).mtimeMs % 1;
        console.log(`C5.1 native-create mtimeMs fractional part: ${String(frac)}`);
        const outs = await Promise.all(
          Array.from({ length: 8 }, () =>
            (async () => {
              const p = Bun.spawn([process.execPath, scriptPath, main]);
              return (await new Response(p.stdout).text()).trim();
            })()),
        );
        expect(new Set(outs).size).toBe(1);
        // wall-ms utimes round-trips exactly (the refresh gen is always a
        // whole-ms string -> strict naming across a takeover)
        const ms = Date.now() + 123;
        const d = new Date(ms);
        utimesSync(main, d, d);
        expect(String(statSync(main).mtimeMs)).toBe(String(ms));
      } finally {
        rmSync(t.stateDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(scriptPath, { force: true });
    }
  });
});
