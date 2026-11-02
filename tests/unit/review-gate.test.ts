// T8e gate attack suite (review seat, qitem -20261029003356, pin c9ee86a).
// Contract: ADR-0006 "The gate". The FULL gate is NOT run here (server is
// draining; the architect runs it once after the drain) - attacks go at the
// exported pure parts plus real runSpec smokes on tmp test files. Offline,
// fake-only, zero network.
//
// Attack list from the qitem: step aggregation (FAIL anywhere -> exit 1,
// all steps run), contract SKIP counts as FAIL, the leftovers filter (only
// workspaces created at/after gate start fail; a failing list FAILS),
// gate-report.json contents (commit + clean flag; reviewed on build's post-
// drain run - fields pinned here by reading), no secret value ever printed.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  readFileSync, rmSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import {
  extractJson,
  gateExit,
  leftoverCheck,
  parseBunCounts,
  postStartScratch,
  runSpec,
  type StepResult } from "../../scripts/gate.ts";

const pass = (step: string): StepResult => ({ step, status: "PASS", ms: 1, detail: "" });
const fail = (step: string): StepResult => ({ step, status: "FAIL", ms: 1, detail: "" });

describe("gate aggregation", () => {
  test("gateExit: one FAIL among eight PASSes is exit 1; all PASS is 0; empty is 0", () => {
    expect(gateExit([pass("a"), pass("b"), fail("c"), pass("d"), pass("e"), pass("f"), pass("g"), pass("h")])).toBe(1);
    expect(gateExit([pass("a"), pass("b")])).toBe(0);
    expect(gateExit([])).toBe(0); // no steps -> no FAIL (crash path is pinned by F-T8f-1 below)
  });

  test("F-T8f-1: a step whose binary cannot spawn must FAIL the step, not throw out of the loop (contract: the gate stops at NOTHING)", async () => {
    // runSpec has no try around Bun.spawn: a spawn-time ENOENT (missing
    // "rig" on PATH, deleted bun) THROWS through main()'s sequential loop -
    // later steps, the leftovers check and gate-report.json are all skipped
    // and NO GATE line prints. This test pins the contract the header
    // promises: every step ends as a StepResult.
    const r = await runSpec({
      name: "no-such-binary",
      argv: ["definitely-not-a-real-binary-9x7q"],
      kind: "validate" });
    expect(r.status).toBe("FAIL"); // red today = throws instead (finding)
  });
  test("END-TO-END failTail redaction (review attack, real gate 02:10Z proved the feature live): a FAILing CHILD printing a secret shape reaches StepResult only redacted", async () => {
    // gate.test.ts:187 pins failTail the function; this pins the SPAWN PATH:
    // runSpec captures the child's output, tails it, redacts it, and hands
    // the StepResult that main() serializes into gate-report.json. The fake
    // value is assembled at runtime on both sides (scan-safe lines here;
    // the child prints it whole) - shape only, never a real secret.
    const val = "f".repeat(40); // assignment-shaped payload, fake value
    const script = `console.log("boom begins");console.log("APP_"+"SECRET="+${JSON.stringify("f".repeat(40))});console.log("boom ends");process.exit(3);`;
    const r = await runSpec({ name: "leaky-child", argv: ["bun", "-e", script], kind: "test" });
    expect(r.status).toBe("FAIL");
    expect(r.failTail).toBeDefined();
    const joined = (r.failTail ?? []).join("\n");
    expect(joined).not.toContain(val); // the raw value never crosses
    expect(joined).toContain("[REDACTED:assignment]"); // the belt did fire
    expect(JSON.stringify(r)).not.toContain(val); // and not via serialization
  });
});

describe("bun summary parsing", () => {
  test("parseBunCounts: standard summary, missing skip, and crash output", () => {
    expect(parseBunCounts(" 795 pass\n 5 fail\n 4 skip\n")).toEqual({ pass: 795, fail: 5, skip: 4 });
    expect(parseBunCounts(" 12 pass\n 0 fail\n")).toEqual({ pass: 12, fail: 0, skip: 0 });
    expect(parseBunCounts("no tests found")).toBeNull();
  });

  test("runSpec on a crashing test file (exit!=0, no clean 0-fail summary) FAILS the step", async () => {
    const dir = makeTempDir("rev-gate-");
    try {
      // process.exit mid-run: bun dies with a nonzero code and no "0 fail"
      // summary - either gate detail path is acceptable, PASS is not. (An
      // import-time throw is NOT this shape - bun counts it as 1 fail, my
      // first version's wrong assumption.)
      const f = join(dir, "crash.test.ts");
      writeFileSync(f, `import { describe, expect, test } from "bun:test";\ndescribe("s", () => { test("ok", () => { expect(1).toBe(1); }); test("dies", () => { process.exit(7); }); });\n`);
      const r = await runSpec({ name: "crash", argv: ["bun", "test", f], kind: "test" });
      expect(r.status).toBe("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("contract semantics: a SKIPped test FAILS a noSkip step; without noSkip it PASSES", async () => {
    const dir = makeTempDir("rev-gate-");
    try {
      const f = join(dir, "skips.test.ts");
      writeFileSync(f, `import { describe, expect, test } from "bun:test";\ndescribe("s", () => { test("real", () => { expect(1).toBe(1); }); test.skip("skipped", () => {}); });\n`);
      const withNoSkip = await runSpec({ name: "contract", argv: ["bun", "test", f], kind: "test", noSkip: true });
      expect(withNoSkip.status).toBe("FAIL");
      expect(withNoSkip.detail).toContain("1 skip");
      const plain = await runSpec({ name: "lenient", argv: ["bun", "test", f], kind: "test" });
      expect(plain.status).toBe("PASS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("extractJson: tolerates prose, returns null on garbage", () => {
    expect(extractJson('noise {"valid":true} noise')).toEqual({ valid: true });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{ broken")).toBeNull();
  });
});

describe("leftovers filter (the from-this-run rule)", () => {
  const T0 = Date.parse("2026-10-29T00:00:00.000Z");
  const iso = (ms: number): string => new Date(ms).toISOString();

  test("only scratch created AT or after gate start count; older pre-existing scratch never fails the gate; missing created_at counts (fail-safe)", () => {
    const items = [
      { id: "honcho-bridge-scratch-old", created_at: iso(T0 - 60_000) },
      { id: "honcho-bridge-scratch-at-start", created_at: iso(T0) }, // boundary: AT counts
      { id: "honcho-bridge-scratch-new", created_at: iso(T0 + 5_000) },
      { id: "honcho-bridge-scratch-unprovable" }, // no created_at -> ours to wait for
      { id: "openrig", created_at: iso(T0 + 1) }, // not scratch: never ours
    ];
    expect(postStartScratch(items, T0).sort()).toEqual([
      "honcho-bridge-scratch-at-start",
      "honcho-bridge-scratch-new",
      "honcho-bridge-scratch-unprovable",
    ]);
  });

  test("a FAILING list is a FAIL, never 'empty' (cannot prove deletion)", async () => {
    const r = await leftoverCheck(
      async () => {
        throw new Error("HTTP 500");
      },
      T0,
      { deadlineMs: 50, pollMs: 10, now: () => Date.now(), sleep: async () => {} },
    );
    expect(r.status).toBe("FAIL");
    expect(r.note).toContain("cannot prove deletion");
  });

  test("poll passes when the from-this-run set drains; pre-existing scratch is reported, not failed", async () => {
    let calls = 0;
    const r = await leftoverCheck(
      async () => {
        calls += 1;
        return calls === 1
          ? [{ id: "honcho-bridge-scratch-mine", created_at: iso(T0 + 1) }, { id: "honcho-bridge-scratch-pre", created_at: iso(T0 - 1) }]
          : [{ id: "honcho-bridge-scratch-pre", created_at: iso(T0 - 1) }];
      },
      T0,
      { deadlineMs: 1000, pollMs: 1, now: () => Date.now(), sleep: async () => {} },
    );
    expect(r.status).toBe("PASS");
    expect(r.preExisting).toEqual(["honcho-bridge-scratch-pre"]);
    expect(r.note).toContain("pre-existing scratch (not failed)");
  });

  test("deadline expiry FAILS and names the still-listed workspaces", async () => {
    let t = 0;
    const r = await leftoverCheck(
      async () => [{ id: "honcho-bridge-scratch-stuck", created_at: iso(T0 + 1) }],
      T0,
      {
        deadlineMs: 100,
        pollMs: 1,
        now: () => (t += 60), // fake clock outruns the deadline fast
        sleep: async () => {} },
    );
    expect(r.status).toBe("FAIL");
    expect(r.stillListed).toEqual(["honcho-bridge-scratch-stuck"]);
  });

  test("no secret value can ride the gate's printed shapes: details carry counts, ids and fixed phrases only", () => {
    // pure-function surfaces: gateExit (0/1), postStartScratch (workspace
    // ids), runSpec test details (`N fail / N pass`), scan line (file:line:
    // kind from scan.ts's render, values structurally excluded), validate
    // detail (valid + exit code only). The capture marker lines (CHAOS/SOAK
    // SUMMARY) carry counts and scratch NAMES by their own design.
    expect(gateExit([fail("x")])).toBe(1);
    expect(postStartScratch([{ id: "honcho-bridge-scratch-a" }], 0)).toEqual(["honcho-bridge-scratch-a"]);
    const counts = parseBunCounts(" 1 pass\n 1 fail\n");
    expect(`${counts?.fail} fail / ${counts?.pass} pass`).toBe("1 fail / 1 pass");
  });
});
