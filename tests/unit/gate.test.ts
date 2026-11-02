// T8e: tests for the PURE parts of scripts/gate.ts - result aggregation, the
// bun-summary parse, the leftover filter by creation time, leftoverCheck with
// an injected lister/clock, the exit code, and the fixed step order. No
// network, no subprocesses.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  readFileSync, rmSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import {
  STEPS,
  ENVELOPE_CONTRACT_SKIP_MARKER,
  envelopeContractSkip,
  extractJson,
  failTail,
  gateExit,
  integrityVerdict,
  leftoverCheck,
  newTmpEntries,
  parseBunCounts,
  postStartScratch,
  readAcceptedDeletes,
  stepEnv,
  treeState,
  type StepResult } from "../../scripts/gate.ts";

describe("extractJson", () => {
  test("pretty multi-line JSON parses (the rig --json shape)", () => {
    expect(extractJson('{\n  "valid": true,\n  "errors": []\n}\n')).toEqual({ valid: true, errors: [] });
  });
  test("prose around the object tolerated; garbage -> null", () => {
    expect(extractJson('Advisory: blah\n{"valid": false}\ntrailer').valid).toBe(false);
    expect(extractJson("no json here")).toBe(null);
    expect(extractJson("}{")).toBe(null);
  });
});

const r = (step: string, status: "PASS" | "FAIL"): StepResult => ({ step, status, ms: 1, detail: "" });

describe("gate aggregation", () => {
  test("gateExit: any FAIL -> 1, otherwise 0", () => {
    expect(gateExit([r("unit", "PASS"), r("scan", "PASS")])).toBe(0);
    expect(gateExit([r("unit", "PASS"), r("contract", "FAIL")])).toBe(1);
    expect(gateExit([])).toBe(0);
  });

  test("STEPS: seven command steps before leftovers+report, fixed order", () => {
    expect(STEPS.map((s) => s.name)).toEqual([
      "unit",
      "contract",
      "chaos",
      "integration",
      "heavy",
      "scan",
      "validate",
    ]);
    const heavy = STEPS.find((s) => s.name === "heavy");
    expect(heavy?.env?.HONCHO_HEAVY_TESTS).toBe("1");
    expect(heavy?.argv).toContain("tests/soak");
    expect(STEPS.find((s) => s.name === "contract")?.noSkip).toBe(true);
    // steps 4 and 5 both exist and are separate (they never run in parallel -
    // the runner is sequential by construction)
    expect(STEPS.filter((s) => s.name === "integration" || s.name === "heavy").length).toBe(2);
  });
});

describe("parseBunCounts", () => {
  test("pass/fail/skip line parsed", () => {
    expect(parseBunCounts("x\n 12 pass\n 0 fail\n 3 skip\nRan 15 tests")).toEqual({ pass: 12, fail: 0, skip: 3 });
    expect(parseBunCounts(" 776 pass\n 1 fail\n").fail).toBe(1);
  });
  test("no summary -> null (crashed run reads as FAIL, not 0 fail)", () => {
    expect(parseBunCounts("SyntaxError: something died")).toBe(null);
  });
});

describe("leftover filter", () => {
  const startMs = Date.parse("2026-10-28T23:00:00Z");
  test("only honcho-bridge-scratch* created at/after the gate start counts", () => {
    const items = [
      { id: "openrig", created_at: "2026-10-29T00:00:00Z" }, // after, but not scratch
      { id: "honcho-bridge-scratch-a", created_at: "2026-10-28T22:59:59Z" }, // before -> not failed
      { id: "honcho-bridge-scratch-b", created_at: "2026-10-28T23:00:00Z" }, // at -> from this run
      { id: "honcho-bridge-scratch-c", created_at: "2026-10-28T23:05:00Z" }, // after
      { id: "honcho-bridge-scratch-d" }, // missing created_at -> fail-safe: ours
    ];
    expect(postStartScratch(items, startMs)).toEqual([
      "honcho-bridge-scratch-b",
      "honcho-bridge-scratch-c",
      "honcho-bridge-scratch-d",
    ]);
  });
});

describe("leftoverCheck with injected lister + clock", () => {
  const startMs = Date.parse("2026-10-28T23:00:00Z");
  const fakeNow = (start: number) => {
    const clock = { t: start };
    return {
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.t += ms;
      } };
  };

  test("clean list -> PASS immediately; pre-existing scratch reported not failed", async () => {
    const clock = fakeNow(startMs);
    const out = await leftoverCheck(
      async () => [
        { id: "openrig", created_at: "2026-10-27T00:00:00Z" },
        { id: "honcho-bridge-scratch-old", created_at: "2026-10-28T22:00:00Z" },
      ],
      startMs,
      { deadlineMs: 600_000, pollMs: 15_000, ...clock },
    );
    expect(out.status).toBe("PASS");
    expect(out.stillListed).toEqual([]);
    expect(out.preExisting).toEqual(["honcho-bridge-scratch-old"]);
    // T14f: nothing lingering means nothing pending the server's purge
    expect(out.pendingDeletes).toEqual([]);
  });

  test("from-this-run scratch disappears on poll 3 -> PASS", async () => {
    const clock = fakeNow(startMs);
    let calls = 0;
    const out = await leftoverCheck(
      async () => {
        calls += 1;
        return calls < 3
          ? [{ id: "honcho-bridge-scratch-mine", created_at: "2026-10-28T23:30:00Z" }]
          : [];
      },
      startMs,
      { deadlineMs: 600_000, pollMs: 15_000, ...clock },
    );
    expect(out.status).toBe("PASS");
    expect(calls).toBe(3);
  });

  test("scratch never leaves -> FAIL at the deadline with it named", async () => {
    const clock = fakeNow(startMs);
    const out = await leftoverCheck(
      async () => [{ id: "honcho-bridge-scratch-mine", created_at: "2026-10-28T23:30:00Z" }],
      startMs,
      { deadlineMs: 60_000, pollMs: 15_000, ...clock },
    );
    expect(out.status).toBe("FAIL");
    expect(out.stillListed).toEqual(["honcho-bridge-scratch-mine"]);
  });

  test("a failing lister (non-2xx) is a FAIL, never 'empty'", async () => {
    const clock = fakeNow(startMs);
    const out = await leftoverCheck(
      async () => {
        throw new Error("HTTP 500");
      },
      startMs,
      { deadlineMs: 60_000, pollMs: 15_000, ...clock },
    );
    expect(out.status).toBe("FAIL");
    expect(out.note).toContain("cannot prove deletion");
  });

  // T14f (ADR-0006 amendment 2026-10-31): past the 120 s deadline the gate
  // proves the DELETE was ACCEPTED (the name is in this run's recorded set),
  // not that the server purged it. release.ts is what refuses while listed.
  test("T14f: still listed at the deadline + accepted DELETE -> PASS with pendingDeletes", async () => {
    const clock = fakeNow(startMs);
    const out = await leftoverCheck(
      async () => [{ id: "honcho-bridge-scratch-mine", created_at: "2026-10-28T23:30:00Z" }],
      startMs,
      {
        deadlineMs: 120_000,
        pollMs: 15_000,
        ...clock,
        accepted: new Set(["honcho-bridge-scratch-mine"]) },
    );
    expect(out.status).toBe("PASS");
    expect(out.stillListed).toEqual([]);
    expect(out.pendingDeletes).toEqual(["honcho-bridge-scratch-mine"]);
    expect(out.note).toContain("accepted DELETE");
    expect(out.note).toContain("purge pending");
  });

  test("T14f: still listed at the deadline WITHOUT an accepted DELETE -> FAIL naming it", async () => {
    const clock = fakeNow(startMs);
    const out = await leftoverCheck(
      async () => [
        { id: "honcho-bridge-scratch-accepted", created_at: "2026-10-28T23:30:00Z" },
        { id: "honcho-bridge-scratch-unproven", created_at: "2026-10-28T23:31:00Z" },
      ],
      startMs,
      {
        deadlineMs: 120_000,
        pollMs: 15_000,
        ...clock,
        accepted: new Set(["honcho-bridge-scratch-accepted"]) },
    );
    expect(out.status).toBe("FAIL");
    expect(out.stillListed).toEqual(["honcho-bridge-scratch-accepted", "honcho-bridge-scratch-unproven"]);
    expect(out.note).toContain("honcho-bridge-scratch-unproven");
    expect(out.note).not.toContain("honcho-bridge-scratch-unproven, ");
    // the accepted one is still reported as pending even though the step fails
    expect(out.pendingDeletes).toEqual(["honcho-bridge-scratch-accepted"]);
  });

  test("T14f: accepted set is only consulted at the deadline (gone before -> no pendingDeletes)", async () => {
    const clock = fakeNow(startMs);
    let calls = 0;
    const out = await leftoverCheck(
      async () => {
        calls += 1;
        return calls < 2
          ? [{ id: "honcho-bridge-scratch-mine", created_at: "2026-10-28T23:30:00Z" }]
          : [];
      },
      startMs,
      {
        deadlineMs: 120_000,
        pollMs: 15_000,
        ...clock,
        accepted: new Set(["honcho-bridge-scratch-mine"]) },
    );
    expect(out.status).toBe("PASS");
    expect(out.pendingDeletes).toEqual([]);
  });
});

describe("readAcceptedDeletes (T14f: the gate's accepted-DELETE file reader)", () => {
  const withTmp = (fn: (dir: string) => void): void => {
    const dir = makeTempDir("t14f-gate-");
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("one name per {name,at} JSON line; blank lines skipped", () =>
    withTmp((dir) => {
      const f = join(dir, "gate-deletes.jsonl");
      writeFileSync(
        f,
        [
          JSON.stringify({ name: "honcho-bridge-scratch-a", at: "2026-10-31T04:00:00.000Z" }),
          "",
          JSON.stringify({ name: "honcho-bridge-scratch-b", at: "2026-10-31T04:00:01.000Z" }),
          "",
        ].join("\n"),
      );
      expect([...readAcceptedDeletes(f)].sort()).toEqual([
        "honcho-bridge-scratch-a",
        "honcho-bridge-scratch-b",
      ]);
    }));

  test("missing file or corrupt line -> EMPTY set (fail-safe: never turns an unproven leftover into a pass)", () =>
    withTmp((dir) => {
      expect(readAcceptedDeletes(join(dir, "absent.jsonl")).size).toBe(0);
      const bad = join(dir, "bad.jsonl");
      writeFileSync(bad, `${JSON.stringify({ name: "honcho-bridge-scratch-a" })}\nnot json\n`);
      expect(readAcceptedDeletes(bad).size).toBe(0);
    }));
});

describe("stepEnv (T8e-fix-4: the heavy flag never leaks)", () => {
  const step = (name: string): (typeof STEPS)[number] => {
    const s = STEPS.find((x) => x.name === name);
    if (s === undefined) throw new Error(`no step ${name}`);
    return s;
  };

  test("light integration gets NO heavy flag even when the gate process has it", () => {
    const e = stepEnv(step("integration"), { HONCHO_HEAVY_TESTS: "1", HONCHO_URL: "u" });
    expect("HONCHO_HEAVY_TESTS" in e).toBe(false);
    expect(e.HONCHO_URL).toBe("u"); // everything else still passes through
  });

  test("only the heavy step sets it, whatever the process had", () => {
    expect(stepEnv(step("heavy"), { HONCHO_HEAVY_TESTS: "1" }).HONCHO_HEAVY_TESTS).toBe("1");
    expect(stepEnv(step("heavy"), {}).HONCHO_HEAVY_TESTS).toBe("1");
    for (const s of STEPS.filter((x) => x.name !== "heavy")) {
      expect("HONCHO_HEAVY_TESTS" in stepEnv(s, { HONCHO_HEAVY_TESTS: "1" })).toBe(false);
    }
  });

  test("undefined-valued keys are dropped, not stringified", () => {
    const e = stepEnv(step("unit"), { MAYBE_UNDEFINED: undefined, KEEP: "1" });
    expect("MAYBE_UNDEFINED" in e).toBe(false);
    expect(e.KEEP).toBe("1");
  });
});

describe("treeState (clean = tracked only; untracked counted separately)", () => {
  const trackedEmpty = "\n";
  test("THE PAIR review asked to pin: clean=true WITH untracked>0", () => {
    const all = "?? CLAUDE.md\n?? pods/.mcp.json\n?? .claude/plugins/\n";
    expect(treeState(trackedEmpty, all)).toEqual({ clean: true, untracked: 3 });
  });
  test("tracked modification is never clean, untracked still counted", () => {
    expect(treeState(" M scripts/gate.ts\n", " M scripts/gate.ts\n?? CLAUDE.md\n")).toEqual({
      clean: false,
      untracked: 1 });
  });
  test("nothing at all -> clean, 0", () => {
    expect(treeState("\n", "\n")).toEqual({ clean: true, untracked: 0 });
  });
  test("staged-but-uncommitted tracked change reads dirty (--untracked-files=no still shows it)", () => {
    expect(treeState("M  plugin/src/writer.ts\n", "M  plugin/src/writer.ts\n")).toEqual({
      clean: false,
      untracked: 0 });
  });
});

describe("failTail (architect 01:39Z: FAIL keeps a redacted tail)", () => {
  test("last n non-blank lines, original order", () => {
    const out = Array.from({ length: 45 }, (_, i) => `l${i + 1}`).join("\n\n");
    const t = failTail(out, 40);
    expect(t.length).toBe(40);
    expect(t[0]).toBe("l6");
    expect(t[39]).toBe("l45");
  });
  test("secret shapes are redacted() before they may reach the report", () => {
    // assembled at runtime so the scan never sees a literal shape here; the
    // assignment rule must still fire on the composed line (fake value only)
    const name = "APP" + "_SECRET";
    const val = "f".repeat(64);
    const t = failTail(`boom begins\n${name}=${val}\nend`, 40);
    expect(t.length).toBe(3);
    expect(t[1]).not.toContain(val);
    expect(t[1]).toContain("[REDACTED:assignment]");
  });
  test("empty output -> empty tail (nothing to explain)", () => {
    expect(failTail("\n  \n", 40)).toEqual([]);
  });
});

describe("integrityVerdict (T12d: the gate attests only what the steps ran)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  test("HEAD move between start and end FAILS with both shas named", () => {
    const v = integrityVerdict(A, true, B, true);
    expect(v.status).toBe("FAIL");
    expect(v.note).toContain("HEAD moved during the gate");
    expect(v.note).toContain(A);
    expect(v.note).toContain(B);
    // the FAIL flips the gate exit (this is the step the report pushes)
    expect(gateExit([r("unit", "PASS"), { ...r("report", v.status), ms: 0 }])).toBe(1);
  });
  test("clean at start, dirty at end FAILS (mid-run tracked change)", () => {
    const v = integrityVerdict(A, true, A, false);
    expect(v.status).toBe("FAIL");
    expect(v.note).toContain("tracked files became dirty during the gate");
  });
  test("same HEAD, clean both ends: PASS", () => {
    expect(integrityVerdict(A, true, A, true).status).toBe("PASS");
  });
  test("dirty AT start stays report-but-not-fail (architect 01:39Z semantics kept)", () => {
    expect(integrityVerdict(A, false, A, false).status).toBe("PASS");
    // it may even go dirty -> clean: that is not a MID-RUN change
    expect(integrityVerdict(A, false, A, true).status).toBe("PASS");
  });
  test("unreadable HEAD at either end FAILS (an unprovable attestation attests nothing)", () => {
    expect(integrityVerdict("", true, A, true).status).toBe("FAIL");
    expect(integrityVerdict(A, true, "", true).status).toBe("FAIL");
    expect(integrityVerdict("", true, "", true).note).toContain("start");
  });
});

describe("T8e-fix (F-T8f-1): unspawnable commands become FAIL lines", () => {
  test("runSpec on a non-existent command -> FAIL, detail 'spawn: <code>'", async () => {
    const { runSpec } = await import("../../scripts/gate.ts");
    const r = await runSpec({
      name: "ghost",
      argv: ["definitely-not-a-real-binary-9f3a2b"],
      kind: "test" });
    expect(r.status).toBe("FAIL");
    expect(r.detail.startsWith("spawn: ")).toBe(true);
  });
});

describe("envelopeContractSkip (T16e, ADR-0012 decision 1)", () => {
  const markerLine = `${ENVELOPE_CONTRACT_SKIP_MARKER} @openrig/cli not found; paths tried: /nope/@openrig/cli`;

  test("no marker (contract ran) -> null", () => {
    expect(envelopeContractSkip(" 1137 pass\n 0 fail\n", undefined)).toBeNull();
  });

  test("marker without an allow -> FAIL detail naming the marker and the escape", () => {
    const r = envelopeContractSkip(`x\n${markerLine}\ny`, undefined);
    expect(r).not.toBeNull();
    expect(r).toContain(ENVELOPE_CONTRACT_SKIP_MARKER);
    expect(r).toContain("/nope/@openrig/cli"); // the path tried reaches the report
    expect(r).toContain("OPENRIG_CONTRACT_SKIP=1");
  });

  test("OPENRIG_CONTRACT_SKIP=1 allows it (machine without OpenRig)", () => {
    expect(envelopeContractSkip(markerLine, "1")).toBeNull();
  });

  test('only exactly "1" allows: unset, "0", "true" all still fail', () => {
    for (const v of [undefined, "0", "true", " 1 "]) {
      expect(envelopeContractSkip(markerLine, v)).not.toBeNull();
    }
  });
});

describe("newTmpEntries (T16h: the shared-/tmp leak check on the unit step)", () => {
  test("only names absent BEFORE count as left behind", () => {
    const before = new Set(["a", "b"]);
    expect(newTmpEntries(before, ["a", "b", "c"])).toEqual(["c"]);
  });
  test("names that vanished during the run are not new; after order kept", () => {
    const before = new Set(["gone", "x"]);
    expect(newTmpEntries(before, ["y", "gone"])).toEqual(["y"]);
  });
  test("a leak-free run yields the empty list", () => {
    expect(newTmpEntries(new Set(["a"]), ["a"])).toEqual([]);
  });
  test("empty before (a fresh /tmp view) still reports every survivor", () => {
    expect(newTmpEntries(new Set<string>(), ["l", "m"])).toEqual(["l", "m"]);
  });
});
