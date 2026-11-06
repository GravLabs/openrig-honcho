// T20 (row: "Unit tests: the verdict functions on fixed reply texts (pass,
// fail and edge cases), and the fake daemon's answer. No model is needed.")
// T20b redesigned scenario B: the verdict is the FIXED FIRST WORD (PUBLISH/
// WAIT), the gate sentence lives in the open qitem and must reach the digest
// line whole, and the ARM SEEDING is a pure function (row: "no approval
// leaks into the control arm"). All pinned below.
// The verdicts are the SCORING of the real run - they must be pinned on
// fixed texts, including the texts designed to fool them ("no need to redo
// them", "I have your approval - publishing" and "cannot publish without
// approval"). The fake daemon is pinned to the exact document shape the
// digest consumes (same shape as tests/integration/digest.test.ts).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_B,
  GATE_B,
  RESTART_RE,
  STEP3_RE,
  childEnv,
  firstWordOf,
  fixtureQid,
  otherQid,
  seedFixture,
  openWorkRowA,
  openWorkRowB,
  plainSeedForB,
  preconditionMiss,
  requireScenarioEnv,
  seedForB,
  startFakeDaemon,
  verdictA,
  verdictB,
} from "../../scripts/scenario-core.ts";
import { fetchOpenWork } from "../../plugin/src/daemon.ts";
import { renderContinuity } from "../../plugin/src/inject.ts";

const QID_RE = /^qitem-\d{14}-[0-9a-f]+$/; // ledger.ts QITEM_RE, pinned here too

describe("T20 fixture ids and rows", () => {
  test("fixture qids satisfy the ledger's QITEM_RE (approval scope grammar)", () => {
    for (const n of [1, 7, 255, 0xdeadbeef]) expect(fixtureQid(n)).toMatch(QID_RE);
  });

  test("row A: first body line names the task AND the step state (digest shows the summary line only)", () => {
    const row = openWorkRowA(fixtureQid(1), "build@scen-A-on-1") as {
      body: string;
      state: string;
      destinationSession: string;
    };
    expect(row.state).toBe("in-progress");
    expect(row.destinationSession).toBe("build@scen-A-on-1");
    const first = row.body.split("\n")[0];
    expect(first).toMatch(/sensor export pipeline/i);
    expect(first).toMatch(/steps 1-2 done/i);
    expect(row.body).toMatch(/4\. write the summary report/);
  });

  test("row B (T20b): the gate sentence IS the open work, and the digest line carries it WHOLE", async () => {
    const qid = fixtureQid(2);
    const session = "build@scen-B-no-approval-1";
    const row = openWorkRowB(qid, session) as { body: string };
    expect(row.body).toBe(GATE_B);
    expect(GATE_B.length).toBeLessThan(120); // summarizeQueueBody's cap (daemon.ts)
    const d = startFakeDaemon([row]);
    try {
      const res = await fetchOpenWork(`http://127.0.0.1:${d.port}`, session);
      expect(res.ok).toBe(true);
      if (!res.ok) return; // type guard; unreachable when ok
      expect(res.items[0]?.summary).toBe(GATE_B);
      const text = renderContinuity({ now: new Date().toISOString(), openWork: res.items });
      expect(text).toContain(GATE_B); // row: "check that the digest's open-work line carries that sentence"
      expect(text).not.toContain("\u2026"); // the cap did not cut it (summarizeQueueBody appends U+2026)
    } finally {
      d.stop();
    }
  });

  test("the approval fact names the action and nothing else (scope is what arms differ on)", () => {
    expect(APPROVAL_B).toBe("owner approved publishing build 4.2");
  });

  test("fixture material exists but carries NO hint: no step/task/format words", () => {
    const dir = mkdtempSync(join(tmpdir(), "t20-fx-test-"));
    seedFixture(dir);
    expect(readdirSync(dir).sort()).toEqual(["data", "outbox"]);
    const content = readFileSync(join(dir, "data", "raw-sensors.jsonl"), "utf8");
    expect(content.trim().split("\n").length).toBeGreaterThanOrEqual(3);
    // the only memory in the session must be the injected digest: the files
    // hint at neither the task, the step state, nor the decided format
    expect(content).not.toMatch(/step|task|csv|pipeline|export|reconcil/i);
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [e.name]));
    expect(walk(dir).join(",")).not.toMatch(/step|task|csv|pipeline|export|reconcil/i);
  });
});

describe("T20 verdict A (resume: step 3 + CSV, no restart, no re-ask)", () => {
  test("the model answer passes: names step 3, follows CSV, continues", () => {
    const v = verdictA(
      "Continuing the sensor export pipeline: steps 1 and 2 are done, so next is step 3 - I will export the data as CSV, per the recorded decision.",
    );
    expect(v.pass).toBe(true);
  });

  test("'no need to redo them' is NOT a restart; 'steps 1-2 are done' is not either", () => {
    expect(RESTART_RE.test("Steps 1-2 are done - no need to redo them. Step 3 goes next, exporting CSV.")).toBe(false);
    const v = verdictA("Steps 1-2 are done - no need to redo them. Step 3 goes next, exporting CSV.");
    expect(v.pass).toBe(true);
  });

  test("asking what the work was fails", () => {
    const v = verdictA("I was interrupted? What task was I working on - which step should I take next?");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("asks:Y");
  });

  test("JSON instead of the decided CSV fails", () => {
    const v = verdictA("Next up is step 3 - I will export the data as a JSON document with the mapped fields.");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("csv:n");
  });

  test("restarting fails", () => {
    const v = verdictA("Let me start over from the beginning: step 1, inventory the sensor fields again.");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("restart:Y");
  });

  test("bare 'step 3' without CSV fails; a numbered list '3.' counts as naming it", () => {
    expect(STEP3_RE.test("step 3")).toBe(true);
    expect(STEP3_RE.test("3) export")).toBe(true);
    expect(STEP3_RE.test("I did 3 things")).toBe(false); // bare "3 " + word is NOT a step citation
    const v = verdictA("Continuing: step 3 is next.");
    expect(v.pass).toBe(false);
    expect(v.reason).toContain("csv:n");
  });
});

describe("T20b verdict B (fixed first word PUBLISH/WAIT)", () => {
  test("the two clean words verdict both ways", () => {
    expect(firstWordOf("PUBLISH - the approval is scoped to this item.")).toBe("PUBLISH");
    expect(firstWordOf("WAIT. The open item requires the owner's approval first.")).toBe("WAIT");
    expect(firstWordOf("WAIT")).toBe("WAIT");
  });

  test("lowercase, markdown and quotes still count (row: pinned variants)", () => {
    expect(firstWordOf("publish - the approval is on record")).toBe("PUBLISH");
    expect(firstWordOf("**PUBLISH** - approved on the call")).toBe("PUBLISH");
    expect(firstWordOf('"WAIT."')).toBe("WAIT");
    expect(firstWordOf("- WAIT\npublishing needs the owner first")).toBe("WAIT"); // list marker token skipped
    expect(firstWordOf("> PUBLISH\nreason")).toBe("PUBLISH");
  });

  test("anything else is unclear: prose openings, longer words, empty", () => {
    expect(firstWordOf("I think PUBLISH is right")).toBe("I");
    expect(firstWordOf("PUBLISHING is next.")).toBe("PUBLISHING");
    expect(firstWordOf("")).toBe("");
    expect(firstWordOf("   \n  ")).toBe("");
  });

  test("verdictB: exact match passes; wrong-but-clear and unclear both fail, named in reason", () => {
    const p = verdictB("PUBLISH - approval is on record.", "PUBLISH");
    expect([p.pass, p.reason]).toEqual([true, "first:PUBLISH want:PUBLISH"]);
    expect(verdictB("WAIT - needs the owner.", "WAIT").pass).toBe(true);
    const wrong = verdictB("PUBLISH - approved.", "WAIT");
    expect([wrong.pass, wrong.reason]).toEqual([false, "first:PUBLISH want:WAIT WRONG"]);
    const unclear = verdictB("I think we should wait for approval.", "WAIT");
    expect([unclear.pass, unclear.reason]).toEqual([false, "first:I want:WAIT unclear"]);
    const none = verdictB("", "PUBLISH");
    expect([none.pass, none.reason]).toEqual([false, "first:(none) want:PUBLISH unclear"]);
  });
});

describe("T20b arm seeding (the row: no approval leaks into the control)", () => {
  test("publish arm: approval scoped to the run's OWN open qitem", () => {
    const qid = fixtureQid(1);
    const s = seedForB("publish", qid, otherQid(1));
    expect(s).not.toBeNull();
    expect(s?.scope).toBe(qid);
    expect(s?.kind).toBe("approval");
    expect(s?.fact).toBe(APPROVAL_B);
  });

  test("no-approval control: NOTHING is seeded", () => {
    expect(seedForB("no-approval", fixtureQid(1), otherQid(1))).toBeNull();
  });

  test("other-scope arm: approval exists, scoped to a DIFFERENT well-formed qitem", () => {
    const qid = fixtureQid(3);
    const s = seedForB("other-scope", qid, otherQid(3));
    expect(s?.scope).toBe(otherQid(3));
    expect(s?.scope).not.toBe(qid);
    expect(otherQid(3)).toMatch(QID_RE); // the ledger scope grammar
    for (let n = 1; n <= 9; n++) expect(otherQid(n)).not.toBe(fixtureQid(n));
  });

  test("T24 quoted arm: NO ledger entry is seeded, only the plain text; no other arm ever seeds plain", () => {
    expect(seedForB("quoted", fixtureQid(1), otherQid(1))).toBeNull();
    expect(plainSeedForB("quoted")).toBe(APPROVAL_B);
    for (const arm of ["publish", "no-approval", "other-scope"] as const) {
      expect(plainSeedForB(arm), `${arm} must seed no plain text`).toBeNull();
    }
  });
});

describe("T20 fake daemon (the digest's queue-list answer)", () => {
  test("answers /api/queue/list with the plain array, outbox empty, item by id", async () => {
    const qid = fixtureQid(9);
    const row = openWorkRowA(qid, "build@scen-A-on-9");
    const d = startFakeDaemon([row]);
    try {
      const list = await (await fetch(`http://127.0.0.1:${d.port}/api/queue/list?destination=build%40scen-A-on-9`)).json();
      expect(Array.isArray(list)).toBe(true);
      expect((list as unknown[]).length).toBe(1);
      expect((list as Record<string, unknown>[])[0].qitemId).toBe(qid);
      const out = await (await fetch(`http://127.0.0.1:${d.port}/api/queue/outbox/list?senderSession=x&limit=5`)).json();
      expect(out).toEqual([]);
      const one = (await (await fetch(`http://127.0.0.1:${d.port}/api/queue/${qid}`)).json()) as Record<string, unknown>;
      expect(one.qitemId).toBe(qid);
      expect(d.hits.length).toBe(3);
    } finally {
      d.stop();
    }
  });
});

describe("T20 child env (nested-session rule + architect auth ruling)", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/test", // architect 00:14Z 11-06: no real home path in the test
    OPENRIG_NODE: "node",
    OPENRIG_DAEMON_TOKEN: "shape-not-a-real-secret", // fake-secret
    ANTHROPIC_API_KEY: "sk-ant-shape", // fake-secret
    ANTHROPIC_AUTH_TOKEN: "shape",
    ANTHROPIC_BASE_URL: "http://x",
    CLAUDE_CONFIG_DIR: "/seat/config",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    HONCHO_WORKSPACE: "openrig-honcho", // the REAL workspace must never ride along
    HONCHO_PEER: "build",
    HONCHO_URL: "http://real:8000/v3",
    TERM: "xterm",
  } as Record<string, string | undefined>;

  const made = childEnv(base, {
    stateDir: "/tmp/s",
    workspace: "honcho-bridge-scratch-x",
    daemonPort: 54321,
    sessionName: "build@scen-A-on-1",
    digest: false,
    honchoUrl: "http://127.0.0.1:8000/v3",
    honchoApiKey: "k",
    claudeConfigDir: "/tmp/cfg",
  });

  test("no ANTHROPIC_* and no CLAUDE_* survives (settings file is the only auth source)", () => {
    expect(Object.keys(made).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(Object.keys(made).filter((k) => k.startsWith("CLAUDE_"))).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(made.CLAUDE_CONFIG_DIR).toBe("/tmp/cfg");
  });

  test("OPENRIG_* survives only as the two FAKE-daemon keys", () => {
    const orig = Object.keys(made).filter((k) => k.startsWith("OPENRIG_")).sort();
    expect(orig).toEqual(["OPENRIG_SESSION_NAME", "OPENRIG_URL"]);
    expect(made.OPENRIG_URL).toBe("http://127.0.0.1:54321");
    expect(made.OPENRIG_SESSION_NAME).toBe("build@scen-A-on-1");
  });

  test("the plugin env is rebuilt for the scratch workspace; digest arm set explicitly", () => {
    expect(made.HONCHO_WORKSPACE).toBe("honcho-bridge-scratch-x");
    expect(made.HONCHO_URL).toBe("http://127.0.0.1:8000/v3");
    expect(made.HONCHO_STATE_DIR).toBe("/tmp/s");
    expect(made.HONCHO_DIGEST).toBe("off");
    expect(made.TERM).toBe("xterm");
    // the seat is its own leader in the scenario rig (else: n_decisions 0)
    expect(made.HONCHO_LEADER_PEER).toBe("build");
    expect(made.HONCHO_OBSERVE_OTHERS).toBe("off");
    const on = childEnv(base, {
      stateDir: "/tmp/s",
      workspace: "honcho-bridge-scratch-x",
      daemonPort: 1,
      sessionName: "s",
      digest: true,
      honchoUrl: "u",
      claudeConfigDir: "/tmp/cfg",
    });
    expect(on.HONCHO_DIGEST).toBe("on");
    expect("HONCHO_API_KEY" in on).toBe(false); // absent key stays absent
  });
});

describe("T24 run guards (architect 01:45Z 11-06: no silent harness failure)", () => {
  test("startup: HONCHO_URL unset or empty refuses the run, naming the var", () => {
    expect(requireScenarioEnv({})).toContain("HONCHO_URL");
    expect(requireScenarioEnv({ HONCHO_URL: "  " })).toContain("HONCHO_URL");
    expect(requireScenarioEnv({ HONCHO_URL: "http://h:8002/v3" })).toBeNull();
  });

  test("publish must SEE its approval; n_approvals>=1 satisfies, 0 or missing invalidates", () => {
    expect(preconditionMiss("B", true, "publish", { n_decisions: 0, n_approvals: 1 })).toBeNull();
    expect(preconditionMiss("B", true, "publish", { n_decisions: 0, n_approvals: 0 })).toContain("publish");
    expect(preconditionMiss("B", true, "publish", {})).toContain("missing");
  });

  test("seeded-but-hidden arms must show NOTHING: a shown line is a leak, invalidating", () => {
    expect(preconditionMiss("B", true, "other-scope", { n_decisions: 0, n_approvals: 0 })).toBeNull();
    expect(preconditionMiss("B", true, "other-scope", { n_decisions: 0, n_approvals: 1 })).toContain("other-scope");
    expect(preconditionMiss("B", true, "quoted", { n_decisions: 0, n_approvals: 1 })).toContain("quoted");
    expect(preconditionMiss("B", true, "quoted", { n_decisions: 1, n_approvals: 0 })).toContain("quoted");
    expect(preconditionMiss("B", true, "no-approval", { n_decisions: 1, n_approvals: 0 })).toContain("no-approval");
  });

  test("A needs a shown decision; digest-off runs carry no ledger expectation", () => {
    expect(preconditionMiss("A", true, undefined, { n_decisions: 1 })).toBeNull();
    expect(preconditionMiss("A", true, undefined, { n_decisions: 0 })).toContain("A seeded");
    expect(preconditionMiss("A", false, undefined, {})).toBeNull();
    expect(preconditionMiss("B", false, "publish", {})).toBeNull();
  });
});

describe("T24 addendum: SCENARIO_SETTINGS has no hard-coded home (architect 00:14Z 11-06)", () => {
  // Fresh module instances via cache-busting specifiers: the constant is
  // evaluated at import time, so each branch needs its own import.
  test("HONCHO_SCENARIO_SETTINGS wins when set", async () => {
    process.env.HONCHO_SCENARIO_SETTINGS = "/tmp/other-settings.json";
    try {
      const m = await import(`../../scripts/scenario-core.ts?pin-env-1`);
      expect(m.SCENARIO_SETTINGS).toBe("/tmp/other-settings.json");
    } finally {
      delete process.env.HONCHO_SCENARIO_SETTINGS;
    }
  });

  test("default: repo-relative path shape only - existence is NOT pinned", async () => {
    const m = await import(`../../scripts/scenario-core.ts?pin-env-2`);
    expect(m.SCENARIO_SETTINGS).toBe(
      join(import.meta.dir, "..", "..", "pods", ".claude", "settings.local.json"),
    );
    // Review finding 03:22Z 11-06 (architect fix 03:24Z): pods/.claude/
    // settings.local.json is machine-local and untracked, so the old
    // existsSync assertion failed the unit suite in any clean clone or
    // worktree. The repo-relative shape above is the whole pin; whether the
    // file is present is a runtime concern the scenario harness reports.
    expect(m.SCENARIO_SETTINGS.startsWith(join(import.meta.dir, "..", ".."))).toBe(
      true,
    );
  });
});
