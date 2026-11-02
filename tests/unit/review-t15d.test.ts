// T15d recheck (dev-review@openrig-honcho, qitem-20261101003201-154f757ed8220600,
// pin c9ef6da, worktree ohr-t15d). Attacks from the item: (D1) the new
// afterClaimWin orderings interleaved deterministically, (D2) the abandoned-
// claim boundary, (D3) K=8 + pruner races against the retryCreate / gen-check
// paths with a fresh-stamp control, (D4) whether the abandoned branch can
// fire between two LIVE copies under pathological load. All real-clock
// (production parity, the T15c lesson); temp dirs only; no Honcho; no
// commits. Pure ASCII; NUL via String.fromCharCode(0).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {  cpus } from "node:os";
import { join } from "node:path";
import { takeOnce } from "../../plugin/src/once.ts";
import { scratchName } from "../support/scratch.ts";

const REPO = join(import.meta.dir, "..", "..");
const NUL = String.fromCharCode(0);
const HOUR = 3_600_000;

const mk = (): { stateDir: string; ws: string } => ({
  stateDir: makeTempDir("r15d-"),
  ws: scratchName("t15d") });

const markerFile = (stateDir: string, ws: string, hook: string, stdin: string): string =>
  join(stateDir, ws, "once", createHash("sha256").update(hook + NUL + stdin, "utf8").digest("hex"));

const age = (path: string, ms: number): void => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};

// plant a STALE (6 s) marker for the event, no claim
const staleMarker = (t: { stateDir: string; ws: string }, hook: string, stdin: string): string => {
  expect(takeOnce(t.stateDir, t.ws, hook, stdin, Date.now())).toBe(true);
  const m = markerFile(t.stateDir, t.ws, hook, stdin);
  age(m, 6_000);
  return m;
};

// ------------------------------------------------- D1 claim-win seam orders
describe("D1 the afterClaimWin orderings, one take per event", () => {
  test("D1.1 sweep removes main at the seam: winner restores with wx and takes; repeat DUPs", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "stop", "A");
      const claim = m + ".gen-" + String(statSync(m).mtimeMs);
      let nestedRan = false;
      const seam = (): void => {
        nestedRan = true;
        unlinkSync(m); // the sweep at the instant the seam defines
      };
      expect(takeOnce(t.stateDir, t.ws, "stop", "A", Date.now(), undefined, seam)).toBe(true);
      expect(nestedRan).toBe(true);
      expect(existsSync(m)).toBe(true); // restored by the winners retryCreate
      expect(Date.now() - statSync(m).mtimeMs).toBeLessThan(5_000); // fresh, not aged back
      expect(existsSync(claim)).toBe(true);
      // a real repeat now DUPs (marker fresh again)
      expect(takeOnce(t.stateDir, t.ws, "stop", "A", Date.now())).toBe(false);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("D1.2 sweep then another copy creates main at the seam: copy takes, winner stands down", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "stop", "B");
      let copyTook: boolean | undefined;
      const seam = (): void => {
        unlinkSync(m);
        copyTook = takeOnce(t.stateDir, t.ws, "stop", "B", Date.now()); // wx-creates and takes
      };
      const outer = takeOnce(t.stateDir, t.ws, "stop", "B", Date.now(), undefined, seam);
      expect(copyTook).toBe(true); // the copy that re-created first took
      expect(outer).toBe(false); // generation replaced -> stand down
      expect(existsSync(m)).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("D1.3 no sweep, second copy inside the seam: DUPs on the live claim; winner takes", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "stop", "C");
      let copyTook: boolean | undefined;
      const seam = (): void => {
        copyTook = takeOnce(t.stateDir, t.ws, "stop", "C", Date.now());
      };
      const outer = takeOnce(t.stateDir, t.ws, "stop", "C", Date.now(), undefined, seam);
      expect(copyTook).toBe(false); // claim live (just made) -> stand down
      expect(outer).toBe(true);
      expect(Date.now() - statSync(m).mtimeMs).toBeLessThan(5_000); // refreshed
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("D1.4 sweep removes main AND the claim at the seam, copy creates: copy takes, winner stands down", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "stop", "D");
      const claim = m + ".gen-" + String(statSync(m).mtimeMs);
      let copyTook: boolean | undefined;
      const seam = (): void => {
        unlinkSync(m);
        unlinkSync(claim);
        copyTook = takeOnce(t.stateDir, t.ws, "stop", "D", Date.now());
      };
      const outer = takeOnce(t.stateDir, t.ws, "stop", "D", Date.now(), undefined, seam);
      expect(copyTook).toBe(true);
      expect(outer).toBe(false);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("D1.5 sweep, then two copies at the seam: first creates and takes, other two stand down", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "stop", "E");
      let c1: boolean | undefined;
      let c2: boolean | undefined;
      const seam = (): void => {
        unlinkSync(m);
        c1 = takeOnce(t.stateDir, t.ws, "stop", "E", Date.now());
        c2 = takeOnce(t.stateDir, t.ws, "stop", "E", Date.now());
      };
      const outer = takeOnce(t.stateDir, t.ws, "stop", "E", Date.now(), undefined, seam);
      expect([c1, c2, outer].filter(Boolean).length).toBe(1); // exactly c1
      expect(c1).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------ D2 abandoned-claim edges
describe("D2 the abandoned-claim boundary (C1 branch)", () => {
  test("D2.1 claim aged 5.1 s: abandoned -> TAKE; claim aged 4.9 s: live racer -> DUP", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "user-prompt", "P");
      const claim = m + ".gen-" + String(statSync(m).mtimeMs);
      writeFileSync(claim, "");
      age(claim, 5_100);
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "P", Date.now())).toBe(true);
      // the take did not refresh main on purpose (C1.2): same gen -> same
      // claim name, still aged - still abandoned on the next replay (D2.3
      // pins replays keep taking; here we pin the name and then run the
      // LIVE half in a clean dir)
      const claim2 = m + ".gen-" + String(statSync(m).mtimeMs);
      const t2 = mk();
      try {
        const m2 = staleMarker(t2, "user-prompt", "P");
        const claimB = m2 + ".gen-" + String(statSync(m2).mtimeMs);
        writeFileSync(claimB, "");
        age(claimB, 4_900); // within one window: a racer won THIS gen ~now
        expect(takeOnce(t2.stateDir, t2.ws, "user-prompt", "P", Date.now())).toBe(false);
      } finally {
        rmSync(t2.stateDir, { recursive: true, force: true });
      }
      expect(claim2).toBe(claim); // same gen -> same claim name (pin)
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("D2.2 unstatable claim (dangling symlink): abandoned -> TAKE, no throw", () => {
    const t = mk();
    try {
      const m = staleMarker(t, "user-prompt", "Q");
      const claim = m + ".gen-" + String(statSync(m).mtimeMs);
      symlinkSync(join(t.stateDir, "nope-missing"), claim); // statSync -> ENOENT
      expect(() => takeOnce(t.stateDir, t.ws, "user-prompt", "Q", Date.now())).not.toThrow();
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "Q", Date.now())).toBe(true);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });

  test("D2.3 abandoned take never refreshes main (replays keep taking until the sweep)", () => {
    const t = mk();
    try {
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "R", Date.now())).toBe(true);
      const m = markerFile(t.stateDir, t.ws, "user-prompt", "R");
      age(m, 2 * HOUR); // age FIRST, then derive the claim name from the
      const claim = m + ".gen-" + String(statSync(m).mtimeMs); // aged gen (a real takeover would have)
      writeFileSync(claim, "");
      age(claim, 2 * HOUR);
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "R", Date.now())).toBe(true);
      // no refresh happened (main still the aged gen): a second replay also
      // takes - suppression would be the C1 drop again
      expect(takeOnce(t.stateDir, t.ws, "user-prompt", "R", Date.now())).toBe(true);
      expect(Date.now() - statSync(m).mtimeMs).toBeGreaterThan(HOUR);
    } finally {
      rmSync(t.stateDir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------- D3 races, real clock
const racerScript = (worktree: string, name: string): string => {
  const p = join(worktree, name);
  writeFileSync(
    p,
    'import { takeOnce } from "' + join(worktree, "plugin/src/once.ts") + '";\n' +
      "const [stateDir, ws, hook, stdin] = process.argv.slice(2);\n" +
      'console.log(takeOnce(stateDir, ws, hook, stdin) ? "TAKE" : "DUP");\n',
  );
  return p;
};

async function raceOnce(script: string, args: string[]): Promise<string> {
  const p = Bun.spawn([process.execPath, script, ...args]);
  return (await new Response(p.stdout).text()).trim();
}

describe("D3 K=8 + pruner against the retryCreate / gen-check paths", () => {
  // sweep ON: aged marker + aged stamp. The ruling accepts prune-race
  // DOUBLES (bounded in the committed C2 test); ZERO would be a dropped real
  // event - never allowed. So: assert min >= 1, report the full distribution.
  test("D3.1 sweep ON, 8 copies + pruner, aged marker, 7 rounds: never zero takers", async () => {
    const script = racerScript(REPO, ".racer15d1.ts");
    const dist: number[] = [];
    try {
      for (let round = 0; round < 7; round++) {
        const t = mk();
        try {
          expect(takeOnce(t.stateDir, t.ws, "user-prompt", "E", Date.now())).toBe(true);
          age(markerFile(t.stateDir, t.ws, "user-prompt", "E"), 2 * HOUR);
          age(join(t.stateDir, t.ws, "once", ".pruned"), 2 * HOUR);
          const outs = await Promise.all([
            ...Array.from({ length: 8 }, () => raceOnce(script, [t.stateDir, t.ws, "user-prompt", "E"])),
            raceOnce(script, [t.stateDir, t.ws, "user-prompt", "PRUNER"]),
          ]);
          dist.push(outs.slice(0, 8).filter((o) => o === "TAKE").length);
        } finally {
          rmSync(t.stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(script, { force: true });
    }
    console.log(`D3.1 sweep ON, takers of 8 per round (7 rounds): ${dist.join(",")}`);
    expect(Math.min(...dist)).toBeGreaterThanOrEqual(1);
  }, 180_000);

  // CONTROL sweep OFF (fresh stamp gates the sweep): the single-winner
  // promise must be exact - exactly one taker every round. A double here is
  // a NEW hole in retryCreate / the gen check, not the accepted residual.
  test("D3.2 sweep OFF (fresh stamp), 8 copies + pruner, aged marker, 7 rounds: exactly 1 taker", async () => {
    const script = racerScript(REPO, ".racer15d2.ts");
    const dist: number[] = [];
    try {
      for (let round = 0; round < 7; round++) {
        const t = mk();
        try {
          expect(takeOnce(t.stateDir, t.ws, "user-prompt", "E", Date.now())).toBe(true);
          age(markerFile(t.stateDir, t.ws, "user-prompt", "E"), 2 * HOUR); // stale+prunable, but stamp fresh gates the sweep
          const outs = await Promise.all([
            ...Array.from({ length: 8 }, () => raceOnce(script, [t.stateDir, t.ws, "user-prompt", "E"])),
            raceOnce(script, [t.stateDir, t.ws, "user-prompt", "PRUNER"]),
          ]);
          dist.push(outs.slice(0, 8).filter((o) => o === "TAKE").length);
        } finally {
          rmSync(t.stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(script, { force: true });
    }
    console.log(`D3.2 sweep OFF CONTROL, takers of 8 per round (7 rounds): ${dist.join(",")}`);
    expect(Math.max(...dist)).toBe(1);
    expect(Math.min(...dist)).toBe(1);
  }, 180_000);
});

// -------------------------------------------------- D4 live racers, overload
describe("D4 can the abandoned branch fire between LIVE copies? load probe", () => {
  // Two copies of one event diverging > 5 s needs pathological scheduling.
  // Probe: oversubscribe every core with spinners, then the O4.1 shape
  // (fresh marker, K=8 concurrent). Any take beyond the first is by a copy
  // that started >5 s late - indistinguishable from a real repeat by the
  // designs own window, so this MEASURES the accepted consequence; it never
  // asserts zero. A ZERO round would be a dropped event even under load.
  test("D4.1 CPU oversubscription, fresh marker, K=8 x 3 rounds: report takers, never zero", async () => {
    const spinPath = join(REPO, ".spin15d.ts");
    writeFileSync(spinPath, "const t = Date.now(); while (Date.now() - t < 30_000) { /* spin */ }\n");
    const spinners = Array.from({ length: cpus().length * 2 }, () => Bun.spawn([process.execPath, spinPath]));
    const script = racerScript(REPO, ".racer15d4.ts");
    const dist: number[] = [];
    try {
      for (let round = 0; round < 3; round++) {
        const t = mk();
        try {
          const outs = await Promise.all(
            Array.from({ length: 8 }, () => raceOnce(script, [t.stateDir, t.ws, "recall", "L"])),
          );
          dist.push(outs.filter((o) => o === "TAKE").length);
        } finally {
          rmSync(t.stateDir, { recursive: true, force: true });
        }
      }
    } finally {
      for (const s of spinners) s.kill();
      rmSync(spinPath, { force: true });
      rmSync(script, { force: true });
    }
    console.log(`D4.1 oversubscribed takers of 8 per round (3 rounds): ${dist.join(",")}`);
    expect(Math.min(...dist)).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
