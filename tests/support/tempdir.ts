// T16h: the single door for test temp dirs. /tmp is a shared tmpfs with an
// inode limit and every rig on this host uses it; on 2026-11-01 it reached
// 100% inodes from ~31k leftover test dirs and the unit gate could not even
// mkdtemp (ENOSPC with gigabytes free). Every test temp dir therefore comes
// from makeTempDir() here: it registers the dir, removes it at the end of
// the test FILE that created it (afterAll registered per call - probes
// 2026-11-01 confirm file scope), and a process-exit sweep is the belt for
// standalone scripts (tests/latency.ts) and dirs still held when the file
// hooks ran. Children that create dirs INSIDE a dir we hand them are
// covered by the recursive removal.
//
// The gate's unit step counts new /tmp entries and fails above 20
// (scripts/gate.ts, T16h).

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = new Set<string>();
let exitHookInstalled = false;

const rmDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // a dir we cannot remove is caught by the gate's entry count, not fatal
  }
};

const sweep = (): void => {
  for (const d of [...live]) {
    live.delete(d);
    rmDir(d);
  }
};

const installExitHook = (): void => {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", sweep);
};

/**
 * mkdtempSync(`${tmpdir()}/ohr-<prefix>XXXXXX`), removed at the end of this
 * test file (or at process exit outside a test run). Returns the path, like
 * mkdtempSync. Keep the trailing "-" in the prefix like the old call sites.
 */
export function makeTempDir(prefix: string): string {
  // every name starts ohr-, so the gate counts only our own leftovers
  const dir = mkdtempSync(join(tmpdir(), `ohr-${prefix}`));
  live.add(dir);
  installExitHook();
  try {
    afterAll(() => {
      live.delete(dir);
      rmDir(dir);
    });
  } catch {
    // not inside a test file (tests/latency.ts under plain `bun run`): the
    // afterAll call throws there; the exit sweep is this dir's cleanup.
  }
  return dir;
}

/** Register an extra path (a dir created some other way, e.g. returned by a
 * child, or a symlink sitting beside a temp dir) so it is removed at the end
 * of this test file, with the exit sweep as the belt. Rare; makeTempDir is
 * the normal door. Safe on symlinks: rmDir's rmSync is lstat-based, so a
 * symlink is unlinked, never followed (probed on bun 1.4.4: the link goes,
 * the target survives), and force:true makes the afterAll and the exit
 * sweep idempotent. */
export function trackTempDir(path: string): string {
  live.add(path);
  installExitHook();
  try {
    afterAll(() => {
      live.delete(path);
      rmDir(path);
    });
  } catch {
    // not inside a test file: the exit sweep is this path's cleanup.
  }
  return path;
}
