// T15a (ADR-0010 decision 2): the once-guard. Pure unit tests over temp
// dirs: take/duplicate by window, takeover of stale markers, per-hook and
// per-stdin key separation, never-throws on an unwritable stateDir, the
// 0700/0600 bits, and the once-a-minute prune sweep of >1 h markers.
// No network, no bins here - the bins get their own spawn tests
// (once-bins.test.ts).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import {  existsSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { takeOnce } from "../../plugin/src/once.ts";
import { scratchName } from "../support/scratch.ts";

// Built, never written raw: the same NUL the guard hashes with.
const NUL = String.fromCharCode(0);
const markerPath = (stateDir: string, ws: string, hook: string, stdin: string): string =>
  join(
    stateDir,
    ws,
    "once",
    createHash("sha256").update(hook + NUL + stdin, "utf8").digest("hex"),
  );

function fresh(fn: (stateDir: string, ws: string) => void): () => void {
  return () => {
    const stateDir = makeTempDir("t15a-once-");
    try {
      fn(stateDir, scratchName());
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

const backdate = (file: string, ms: number): void => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

describe("takeOnce (T15a, ADR-0010)", () => {
  test(
    "first take true; a second within 5 s false",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "user-prompt", "one")).toBe(true);
      expect(takeOnce(stateDir, ws, "user-prompt", "one")).toBe(false);
      expect(takeOnce(stateDir, ws, "user-prompt", "one")).toBe(false); // stays false until stale
    }),
  );

  test(
    "a marker past the 5 s window is taken over (injected now) and stays taken",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "stop", "s")).toBe(true);
      expect(takeOnce(stateDir, ws, "stop", "s", Date.now() + 5_001)).toBe(true);
      // the takeover refreshed the marker: back inside the window it duplicates again
      expect(takeOnce(stateDir, ws, "stop", "s")).toBe(false);
    }),
  );

  test(
    "a marker whose mtime is set back 5.1 s runs again (default clock)",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "recall", "r")).toBe(true);
      backdate(markerPath(stateDir, ws, "recall", "r"), 5_100);
      expect(takeOnce(stateDir, ws, "recall", "r")).toBe(true);
    }),
  );

  test(
    "a different hook or different stdin always takes",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "session-start", "same")).toBe(true);
      expect(takeOnce(stateDir, ws, "recall", "same")).toBe(true); // hook differs
      expect(takeOnce(stateDir, ws, "session-start", "same ")).toBe(true); // one byte differs
      expect(takeOnce(stateDir, ws, "session-start", "")).toBe(true); // empty stdin is its own key
    }),
  );

  test(
    "different workspaces do not share markers",
    fresh((stateDir) => {
      const a = scratchName();
      const b = scratchName();
      expect(takeOnce(stateDir, a, "stop", "x")).toBe(true);
      expect(takeOnce(stateDir, b, "stop", "x")).toBe(true);
      expect(takeOnce(stateDir, a, "stop", "x")).toBe(false);
    }),
  );

  test(
    "stateDir unusable (it is a file): true, never throws",
    fresh((stateDir, ws) => {
      const asFile = join(stateDir, "not-a-dir");
      writeFileSync(asFile, "I am a file, not a directory\n");
      expect(takeOnce(asFile, ws, "stop", "x")).toBe(true); // mkdir fails: run, never throw
    }),
  );

  test(
    "dir is 0700 and markers are 0600, contents empty",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "stop", "x")).toBe(true);
      const dir = join(stateDir, ws, "once");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const file = markerPath(stateDir, ws, "stop", "x");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toBe("");
    }),
  );

  test(
    "prune removes markers older than 1 h and keeps fresh ones",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "stop", "old")).toBe(true);
      expect(takeOnce(stateDir, ws, "stop", "fresh")).toBe(true);
      const dir = join(stateDir, ws, "once");
      backdate(markerPath(stateDir, ws, "stop", "old"), 3_600_000 + 60_000);
      backdate(join(dir, ".pruned"), 61_000); // unlock the once-a-minute stamp
      expect(takeOnce(stateDir, ws, "stop", "trigger")).toBe(true); // the call sweeps
      expect(statSync(markerPath(stateDir, ws, "stop", "fresh")).mode & 0o777).toBe(0o600);
      let gone = false;
      try {
        statSync(markerPath(stateDir, ws, "stop", "old"));
      } catch {
        gone = true;
      }
      expect(gone).toBe(true);
    }),
  );

  test(
    "the sweep runs at most once a minute (.pruned stamp)",
    fresh((stateDir, ws) => {
      expect(takeOnce(stateDir, ws, "stop", "old")).toBe(true); // also stamps .pruned now
      backdate(markerPath(stateDir, ws, "stop", "old"), 3_600_000 + 60_000);
      expect(takeOnce(stateDir, ws, "stop", "trigger")).toBe(true); // stamp is fresh: no sweep
      statSync(markerPath(stateDir, ws, "stop", "old")); // still there (throws if pruned)
      backdate(join(stateDir, ws, "once", ".pruned"), 61_000);
      expect(takeOnce(stateDir, ws, "stop", "trigger2")).toBe(true); // stamp expired: swept
      let gone = false;
      try {
        statSync(markerPath(stateDir, ws, "stop", "old"));
      } catch {
        gone = true;
      }
      expect(gone).toBe(true);
    }),
  );

  test(
    "T15c ruling: a stale marker pruned between EEXIST and the stat is TAKEN, and the retry marker is live",
    fresh((stateDir, ws) => {
      // Over-1 h marker (a prune candidate) vanishes at the exact prune-race
      // instant: after our first wx EEXIST, before the arbitration stat
      // (seam, architect 20:37Z). The retry-create must take the real
      // event, not stand down on a vanished marker.
      expect(takeOnce(stateDir, ws, "stop", "vanish")).toBe(true);
      backdate(markerPath(stateDir, ws, "stop", "vanish"), 3_700_000);
      const pruneHere = (): void => {
        unlinkSync(markerPath(stateDir, ws, "stop", "vanish"));
      };
      expect(takeOnce(stateDir, ws, "stop", "vanish", Date.now(), pruneHere)).toBe(true);
      // the retry left a live marker: the take stands, and a duplicate now
      // within the window is suppressed behind it
      expect(existsSync(markerPath(stateDir, ws, "stop", "vanish"))).toBe(true);
      expect(takeOnce(stateDir, ws, "stop", "vanish")).toBe(false);
    }),
  );

  test(
    "T15d ordering a: the sweep removes main at the claim-win seam, the winner restores it with wx - exactly one take",
    fresh((stateDir, ws) => {
      // Architect ruling 11-01 00:00Z: deterministic version of the first
      // fixed ordering. Seed a stale marker; this call wins the .gen- claim;
      // AT THE SEAM (claim won, before the generation re-check) the sweep
      // removes main. The winner re-creates it with ONE exclusive wx and
      // takes; its restored marker is live, so a later copy duplicates.
      expect(takeOnce(stateDir, ws, "stop", "sw-a", Date.now())).toBe(true);
      const marker = markerPath(stateDir, ws, "stop", "sw-a");
      backdate(marker, 6_000); // stale: the next call attempts a takeover
      const sweepAtSeam = (): void => {
        unlinkSync(marker); // the prune removes main right there
      };
      expect(
        takeOnce(stateDir, ws, "stop", "sw-a", Date.now(), undefined, sweepAtSeam),
      ).toBe(true);
      expect(existsSync(marker)).toBe(true); // restored by the exclusive re-create
      expect(takeOnce(stateDir, ws, "stop", "sw-a")).toBe(false); // exactly one take
    }),
  );

  test(
    "T15d ordering b: another copy re-creates main at the claim-win seam, the winner sees a new generation and stands down - exactly one take",
    fresh((stateDir, ws) => {
      // The other ordering: at the seam a different copy creates main (a new
      // generation, fresh mtime - that creator took the event). The claim
      // winner must NOT refresh or take; the fresh marker then suppresses
      // the later copy too, so exactly one take remains: the creator's.
      expect(takeOnce(stateDir, ws, "stop", "sw-b", Date.now())).toBe(true);
      const marker = markerPath(stateDir, ws, "stop", "sw-b");
      backdate(marker, 6_000);
      const recreateAtSeam = (): void => {
        unlinkSync(marker);
        writeFileSync(marker, "", { mode: 0o600 }); // a copy re-created: it took
      };
      expect(
        takeOnce(stateDir, ws, "stop", "sw-b", Date.now(), undefined, recreateAtSeam),
      ).toBe(false);
      expect(takeOnce(stateDir, ws, "stop", "sw-b")).toBe(false); // its take stands alone
    }),
  );
});
