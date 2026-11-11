// O1 (ADR-0017 Part A): the outcome collector on FIXTURE queue rows and
// FIXTURE log lines. No Honcho contact anywhere (the fake daemon is an
// OpenRig fake); the real read-only runs happen outside the suite, on
// command, with the architect's checks.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { startFakeDaemon } from "../support/fake-daemon.ts";
import {
  buildRecord,
  collectOutcomes,
  extractQitemIds,
  followOnIds,
  memoryWindow,
  outcomesFile,
  recordKey,
  serializeRecord,
  summarize,
  summaryLines,
  type OutcomeRecord,
} from "../../plugin/src/outcomes.ts";
import { fetchCurrentItem, fetchQueueListAll, fetchQueueListByState, fetchTransitions } from "../../plugin/src/daemon.ts";

const ID_A = "qitem-20261110000001-aaaaaaaaaaaaaaaa";
const ID_B = "qitem-20261110000002-bbbbbbbbbbbbbbbb";
const ID_C = "qitem-20261110000003-cccccccccccccccc";
const SEAT = "dev-build@fixture-rig";

const CANARY = "CANARY-body-text-never-in-output-9e1f";

const doc = (qitemId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  qitemId,
  state: "done",
  sourceSession: "design-architect@fixture-rig",
  destinationSession: SEAT,
  tags: ["v0.5", "outcome-log"],
  tsCreated: "2026-11-10T00:00:00.000Z",
  tsUpdated: "2026-11-10T02:00:00.000Z",
  claimedAt: "2026-11-10T00:30:00.000Z",
  closureReason: "no-follow-on",
  closureTarget: null,
  handedOffFrom: null,
  handedOffTo: null,
  body: `A plain brief with ${CANARY} planted - it must never reach an outcome record.`,
  ...over,
});

const tr = (
  transitionId: number,
  state: string,
  ts: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({ transitionId, qitemId: ID_A, state, ts, ...over });

const DONE_TRS = [
  tr(101, "pending", "2026-11-10T00:00:00.000Z"),
  tr(102, "in-progress", "2026-11-10T00:30:00.000Z"),
  tr(103, "done", "2026-11-10T02:00:00.000Z", { closureReason: "no-follow-on" }),
];

const logLine = (over: Record<string, unknown>): Record<string, unknown> => ({
  ts: "2026-11-10T01:00:00.000Z",
  hook: "mcp",
  peer: SEAT,
  event: "tool:search",
  ok: true,
  ms: 10,
  ...over,
});

describe("extractQitemIds", () => {
  test("finds both shipped id shapes, deduped; prose cannot match", () => {
    const ids = extractQitemIds(
      `see qitem-20261110000001-aaaaaaaaaaaaaaaa and ${ID_A} again plus qitem-recovery-cc4406c9809c12ae`,
    );
    expect(ids.sort()).toEqual([ID_A, "qitem-recovery-cc4406c9809c12ae"].sort());
    expect(extractQitemIds(`qitem-2026-not-an-id ${CANARY}`)).toEqual([]);
  });
});

describe("buildRecord", () => {
  test("shape and pointer fields from doc + closing transition", () => {
    const r = buildRecord(doc(ID_A, { handedOffTo: ID_B }), DONE_TRS, new Map())!;
    expect(r).toMatchObject({
      qitemId: ID_A,
      source: "design-architect@fixture-rig",
      destination: SEAT,
      tags: ["v0.5", "outcome-log"],
      created: "2026-11-10T00:00:00.000Z",
      claimed: "2026-11-10T00:30:00.000Z",
      closed: "2026-11-10T02:00:00.000Z",
      closeTransitionId: 103,
      closureReason: "no-follow-on",
      handoffTo: ID_B,
      reopenCount: 0,
    });
    expect(r.followOn).toEqual([ID_B]);
  });

  test("claimedAt absent falls back to the first in-progress transition", () => {
    const d = doc(ID_A);
    delete d.claimedAt;
    const r = buildRecord(d, DONE_TRS, new Map())!;
    expect(r.claimed).toBe("2026-11-10T00:30:00.000Z");
  });

  test("reopen: last done closes, later in-progress counts", () => {
    const trs = [
      ...DONE_TRS,
      tr(104, "in-progress", "2026-11-10T03:00:00.000Z"),
      tr(105, "done", "2026-11-10T04:00:00.000Z", { closureReason: "denied" }),
    ];
    const r = buildRecord(doc(ID_A), trs, new Map())!;
    expect(r.closeTransitionId).toBe(105);
    expect(r.closed).toBe("2026-11-10T04:00:00.000Z");
    expect(r.closureReason).toBe("denied");
    expect(r.reopenCount).toBe(1);
  });

  test("a canary in ANY fixture body never reaches the serialized record", () => {
    const reverse = new Map([[ID_A, [ID_C]]]);
    const corpus = [
      doc(ID_B, { body: `${CANARY} names ${ID_A} in prose ${CANARY}` }),
      doc(ID_C, { body: `mentions ${ID_A}` }),
    ];
    for (const d of corpus) {
      const r = buildRecord(d, DONE_TRS, reverse)!;
      expect(serializeRecord(r)).not.toContain(CANARY);
    }
    const a = buildRecord(doc(ID_A), DONE_TRS, reverse)!;
    expect(serializeRecord(a)).not.toContain(CANARY);
    expect(a.followOn).toEqual([ID_C]); // reverse link kept, content never
  });

  test("follow-on ids merge closure target + hand-off + reverse, sorted unique", () => {
    const reverse = new Map<string, string[]>([[ID_A, [ID_C, ID_B]]]);
    const r = buildRecord(
      doc(ID_A, { closureTarget: ID_B, handedOffTo: ID_C }),
      DONE_TRS,
      reverse,
    )!;
    expect(r.followOn).toEqual([ID_B, ID_C].sort());
  });

  // O4 L4 FLIP (security pass on 90f2ae6): this pin used to keep the prose
  // closureTarget verbatim ("daemon truth"). Now a pointer field holds a
  // POINTER only - prose (even prose that contains a real id) is null.
  // The follow-on LINK still extracts the id from the raw doc value.
  test("L4: a prose closureTarget becomes null; the link still extracts", () => {
    const r = buildRecord(doc(ID_A, { closureTarget: `${CANARY} ${ID_B}` }), DONE_TRS, new Map())!;
    expect(r.closureTarget).toBeNull();
    expect(r.followOn).toEqual([ID_B]); // link extraction only ever keeps ids
  });
});

// O4 M2+L4 (security pass on 90f2ae6, probe-outcomes): hostile text in the
// pointer fields. Real-daemon vocabulary (read-only probe of 639 done rows,
// 2026-11-10): sourceSession/destinationSession are ALWAYS seat names;
// handedOffFrom/handedOffTo/closureTarget can also hold a qitem id (80 rows,
// incl. legacy 8-hex ids), and prose closureTargets exist and must go. So:
// source/destination accept the seat shape ONLY; handoff/closure fields
// accept seat shape OR qitem-id shape; anything else skips the row (M2) or
// nulls the field (L4). ESC/BEL/newline payloads fail every vocabulary.
describe("M2/L4 (O4): hostile pointer fields", () => {
  const HOSTILE = `victim@ws${String.fromCodePoint(0x1b)}[31mDONE${String.fromCodePoint(0x07)}\nINJECTED`;
  test("M2: a seat field with control characters skips the row", () => {
    for (const f of ["sourceSession", "destinationSession"] as const) {
      expect(buildRecord(doc(ID_A, { [f]: HOSTILE }), DONE_TRS, new Map())).toBeNull();
    }
    for (const f of ["handedOffFrom", "handedOffTo"] as const) {
      expect(buildRecord(doc(ID_A, { [f]: HOSTILE }), DONE_TRS, new Map())).toBeNull();
    }
  });
  test("M2: the real vocabulary survives verbatim", () => {
    const r = buildRecord(
      doc(ID_A, { handedOffFrom: "qitem-20261110181700-6be44e36", handedOffTo: ID_B }), // legacy 8-hex id (real shape)
      DONE_TRS,
      new Map(),
    )!;
    expect(r.handoffFrom).toBe("qitem-20261110181700-6be44e36");
    expect(r.handoffTo).toBe(ID_B);
    expect(r.source).toBe("design-architect@fixture-rig");
    expect(r.destination).toBe(SEAT);
  });
  test("M2: a non-string seat field skips the row (fail closed)", () => {
    expect(buildRecord(doc(ID_A, { destinationSession: 42 }), DONE_TRS, new Map())).toBeNull();
    expect(buildRecord(doc(ID_A, { destinationSession: "" }), DONE_TRS, new Map())).toBeNull();
  });
  test("L4: tags ride redact(), never the raw assignment value", () => {
    const r = buildRecord(
      doc(ID_A, { tags: ["v0.5", "DB_PASSWORD = hunter2xyz99", 42] }), // fake-secret
      DONE_TRS,
      new Map(),
    )!;
    expect(r.tags).toContain("v0.5");
    expect(r.tags).toContain("DB_PASSWORD = [REDACTED:assignment]");
    expect(r.tags.join(" ")).not.toContain("hunter2xyz99"); // fake-secret
  });
  test("L4: closureReason only from the daemon vocabulary", () => {
    // NO closureReason on the closing transition, so the doc value is what
    // buildRecord reads (the transition value wins when present).
    const trs = [tr(101, "pending", "2026-11-10T00:00:00.000Z"), tr(103, "done", "2026-11-10T02:00:00.000Z")];
    for (const ok of ["handed_off_to", "blocked_on", "denied", "canceled", "no-follow-on", "escalation", "superseded", "failed", "stale", "duplicate", "manual"]) {
      expect(buildRecord(doc(ID_A, { closureReason: ok }), trs, new Map())?.closureReason).toBe(ok);
    }
    expect(buildRecord(doc(ID_A, { closureReason: "handed_off_to\nINJECTED" }), trs, new Map())?.closureReason).toBeNull();
    expect(buildRecord(doc(ID_A, { closureReason: "because-i-said-so" }), trs, new Map())?.closureReason).toBeNull();
  });
  test("L4: closureTarget only a qitem id or a seat name", () => {
    expect(buildRecord(doc(ID_A, { closureTarget: "hunter2xyz99" }), DONE_TRS, new Map())?.closureTarget).toBeNull(); // fake-secret
    expect(buildRecord(
      doc(ID_A, { closureTarget: "advisor-lead@kernel (qitem-20261013185259-529746682c195fc4), operator-agent@kernel (qitem-20261013185259-21701a85fd2876c3)" }),
      DONE_TRS,
      new Map(),
    )?.closureTarget).toBeNull(); // the real prose shape
    expect(buildRecord(doc(ID_A, { closureTarget: ID_B }), DONE_TRS, new Map())?.closureTarget).toBe(ID_B);
    expect(buildRecord(doc(ID_A, { closureTarget: "architect@ws" }), DONE_TRS, new Map())?.closureTarget).toBe("architect@ws");
  });
  // M2 print path: the summary line is the one place the collector prints
  // seat text. Even a SeatSummary built by another hand must not carry an
  // escape through to the terminal.
  test("M2: summaryLines strips control characters from the printed seat", () => {
    const lines = summaryLines([
      {
        seat: `victim@ws${String.fromCodePoint(0x1b)}[31mDONE${String.fromCodePoint(0x07)}\nINJECTED seat`,
        closed: 1,
        claimedRows: 0,
        medianClaimToCloseMs: null,
        badClosureShare: 0,
        followOnShare: 0,
        searchedShare: 0,
      },
    ]);
    expect(lines.length).toBe(1);
    const esc = String.fromCodePoint(0x1b);
    const bel = String.fromCodePoint(0x07);
    expect(lines[0]).not.toContain(esc);
    expect(lines[0]).not.toContain(bel);
    expect(lines[0].split("\n").length).toBe(1);
  });
});

describe("memoryWindow", () => {
  const lines = [
    logLine({ ts: "2026-11-10T00:29:59.000Z" }), // before claim - OUT
    logLine({ ts: "2026-11-10T00:30:00.000Z" }), // at claim - IN
    logLine({ ts: "2026-11-10T02:00:00.000Z" }), // at close - IN
    logLine({ ts: "2026-11-10T02:00:01.000Z" }), // after close - OUT
    logLine({ ts: "2026-11-10T01:00:00.000Z", peer: "other@fixture-rig" }), // other seat - OUT
    logLine({ ts: "2026-11-10T01:10:00.000Z", hook: "mcp", event: "tool:search" }),
    logLine({ ts: "2026-11-10T01:20:00.000Z", hook: "mcp", event: "tool:ask" }),
    logLine({ ts: "2026-11-10T01:30:00.000Z", hook: "mcp", event: "tool:remember" }),
    logLine({ ts: "2026-11-10T01:40:00.000Z", hook: "mcp", event: "tool:retire" }),
    logLine({ ts: "2026-11-10T01:41:00.000Z", hook: "mcp", event: "refused" }),
    logLine({ ts: "2026-11-10T00:31:00.000Z", hook: "recall", event: "injected", arm: "shown", n_items: 2 }),
    logLine({ ts: "2026-11-10T00:32:00.000Z", hook: "recall", event: "injected", arm: "held", n_items: 1 }),
    logLine({ ts: "2026-11-10T00:33:00.000Z", hook: "recall", event: "injected", n_items: 3 }), // no arm = shown
    logLine({ ts: "2026-11-10T00:34:00.000Z", hook: "recall", event: "empty" }), // not injected - OUT
    logLine({ ts: "2026-11-10T00:35:00.000Z", hook: "session-start", event: "startup", moment: "restart" }),
    logLine({ ts: "2026-11-10T00:36:00.000Z", hook: "session-start", event: "startup" }), // no digest
    "not-json",
    null,
  ];
  test("window edges inclusive, other seats and out-of-window excluded", () => {
    const m = memoryWindow(lines, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z");
    expect(m).toEqual({
      digestShown: 1,
      recallShown: 2,
      recallHeld: 1,
      search: 3,
      ask: 1,
      remember: 1,
      retire: 1,
      pointerShown: 0,
      pointerHeld: 0,
    });
  });
  test("a missing closed opens the top; a missing claim means NO window", () => {
    expect(memoryWindow(lines, SEAT, "2026-11-10T00:30:00.000Z", null).search).toBe(4);
    // never claimed = no window, ever (the real-pilot-run guard)
    expect(memoryWindow(lines, SEAT, null, null).search).toBe(0);
    expect(memoryWindow(lines, SEAT, null, "2026-11-10T02:00:00.000Z").digestShown).toBe(0);
  });
  test("F-G (ruling 08:18Z): the pointer counts from the RECALL line; old user-prompt lines still count; none is not an arm", () => {
    const m = memoryWindow(
      [
        logLine({ hook: "recall", event: "pointer", pointer: "shown", n_items: 2 }),
        logLine({ hook: "recall", event: "pointer", pointer: "held" }),
        logLine({ hook: "recall", event: "pointer", pointer: "none" }), // not an arm
        logLine({ hook: "user-prompt", event: "sent", pointer: "shown" }), // OLD log line
        logLine({ hook: "user-prompt", event: "sent", pointer: "held" }), // OLD log line
        logLine({ hook: "recall", event: "injected", arm: "shown" }), // recall keeps its own count
        logLine({ hook: "recall", event: "injected", arm: "held", pointer: "held" }), // 09:55Z held hand-off
        logLine({ hook: "recall", event: "empty", pointer: "held" }), // held hand-off, nothing to show
        logLine({ hook: "recall", event: "injected" }), // no pointer field = not a hand-off
      ],
      SEAT,
      "2026-11-10T00:00:00.000Z",
      null,
    );
    expect(m.pointerShown).toBe(2); // one fresh recall line + one old user-prompt line
    expect(m.pointerHeld).toBe(4); // fresh pointer line + old line + the two marked ordinary lines
    expect(m.recallShown).toBe(2); // the two arm-less-or-shown injected lines
    expect(m.recallHeld).toBe(1); // injected+arm=held credits recall AND pointer, separately
  });
  test("real-log spelling: peer is the LOCAL seat name (T16b), queue names seat@rig", () => {
    const m = memoryWindow(
      [
        logLine({ peer: "dev-build" }), // the shape the pilot log actually carries
        logLine({ peer: "dev-build@other-rig" }), // a DIFFERENT rig's seat: not ours
      ],
      SEAT,
      "2026-11-10T00:00:00.000Z", // claimed (a null claim would mean no window)
      null,
    );
    expect(m.search).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The runner against the fake daemon: idempotence, rebuild identity, and the
// canary at FILE level (not just per record).

function fixtureLog(stateDir: string, workspace: string, lines: Record<string, unknown>[]): void {
  mkdirSync(join(stateDir, "log"), { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "log", `${workspace}.log`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const docsFixture = (): unknown => [
  doc(ID_A, { handedOffTo: ID_B }),
  doc(ID_B, { body: `follow-up over ${CANARY}, names ${ID_A}`, closureReason: "canceled" }),
  doc(ID_C, {
    destinationSession: "dev-review@fixture-rig",
    claimedAt: "2026-11-10T00:00:00.000Z",
    closureReason: "denied",
  }),
];

const allDocsFixture = (): unknown => [
  ...docsFixture(),
  doc("qitem-20261110000004-dddddddddddddddd", {
    state: "in-progress",
    body: `someone names ${ID_C} in a live brief`,
  }),
];

async function withRunner(
  fn: (dir: string, url: string) => Promise<void>,
): Promise<void> {
  const dir = makeTempDir("o1-run-");
  const d = await startFakeDaemon({
    queueListDone: docsFixture(),
    queueListAll: allDocsFixture(),
    transitions: (id: string) => {
      if (id === ID_C) {
        return [tr(201, "in-progress", "2026-11-10T00:00:00.000Z"), tr(202, "done", "2026-11-10T01:00:00.000Z", { closureReason: "denied" })];
      }
      const reason = id === ID_B ? "canceled" : "no-follow-on";
      return DONE_TRS.map((t) => ({ ...t, qitemId: id, ...(t.state === "done" ? { closureReason: reason } : {}) }));
    },
  });
  try {
    await fn(dir, d.url);
  } finally {
    d.close();
  }
}

describe("collectOutcomes", () => {
  test("first run adds every closed row of THIS rig only", async () => {
    await withRunner(async (dir, url) => {
      fixtureLog(dir, "fixture-rig", [logLine({ ts: "2026-11-10T01:00:00.000Z" })]);
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      expect(r.closedRows).toBe(3);
      expect(r.added).toBe(3);
      const bytes = readFileSync(outcomesFile(dir, "fixture-rig"), "utf8");
      expect(bytes.split("\n").filter((l) => l !== "")).toHaveLength(3);
      expect(bytes).not.toContain(CANARY);
      expect(bytes).not.toContain("A plain brief");
    });
  });

  test("a row of ANOTHER rig (destination) never enters the file", async () => {
    await withRunner(async (dir, url) => {
      const d2 = await startFakeDaemon({
        queueListDone: [...docsFixture(), doc(ID_B + "0", { destinationSession: "x@other-rig" })],
        queueListAll: allDocsFixture(),
        transitions: DONE_TRS,
      });
      try {
        const r = await collectOutcomes({ daemonUrl: d2.url, rig: "fixture-rig", stateDir: dir });
        if ("error" in r) throw new Error(r.error);
        expect(r.closedRows).toBe(3);
      } finally {
        d2.close();
      }
    });
  });

  test("idempotence: the rerun adds nothing and the file is untouched", async () => {
    await withRunner(async (dir, url) => {
      const first = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in first) throw new Error(first.error);
      const bytes = readFileSync(outcomesFile(dir, "fixture-rig"), "utf8");
      const second = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in second) throw new Error(second.error);
      expect(second.added).toBe(0);
      expect(readFileSync(outcomesFile(dir, "fixture-rig"), "utf8")).toBe(bytes);
    });
  });

  test("rebuild identity: rebuild twice and after appends = same bytes", async () => {
    await withRunner(async (dir, url) => {
      await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      const r2 = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      if ("error" in r2) throw new Error(r2.error);
      const first = readFileSync(outcomesFile(dir, "fixture-rig"), "utf8");
      await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir }); // no dupes across rebuild+append
      await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      expect(readFileSync(outcomesFile(dir, "fixture-rig"), "utf8")).toBe(first);
    });
  });

  test("a missing hook log is fine: memory counts stay zero", async () => {
    await withRunner(async (dir, url) => {
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      for (const rec of r.records) {
        expect(rec.memory.search).toBe(0);
        expect(rec.memory.digestShown).toBe(0);
      }
    });
  });

  test("memory rides the record from the workspace log for the destination seat", async () => {
    await withRunner(async (dir, url) => {
      fixtureLog(dir, "fixture-rig", [
        logLine({ ts: "2026-11-10T01:00:00.000Z" }), // dev-build, in A's and B's window
        logLine({ ts: "2026-11-10T01:30:00.000Z", peer: "dev-review@fixture-rig" }), // review, OUTSIDE C's window (C closed 01:00)
      ]);
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      const a = r.records.find((x) => x.qitemId === ID_A)!;
      const c = r.records.find((x) => x.qitemId === ID_C)!;
      expect(a.memory.search).toBe(1);
      expect(c.memory.search).toBe(0); // the line is dev-review's, A is dev-build's
    });
  });

  test("summary counts per seat", async () => {
    await withRunner(async (dir, url) => {
      fixtureLog(dir, "fixture-rig", [logLine({ ts: "2026-11-10T01:00:00.000Z" })]);
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      const s = summarize(r.records);
      const build = s.find((x) => x.seat === SEAT)!;
      expect(build.closed).toBe(2);
      expect(build.medianClaimToCloseMs).toBe(5400_000); // 1h30m
      expect(build.badClosureShare).toBeCloseTo(0.5); // canceled of {no-follow-on, canceled}
      expect(build.followOnShare).toBeCloseTo(0.5); // A has B; B has none
      expect(build.searchedShare).toBeCloseTo(1); // the one line sits in BOTH A's and B's window
      const rev = s.find((x) => x.seat === "dev-review@fixture-rig")!;
      expect(rev.badClosureShare).toBe(1); // denied
    });
  });

  test("follow-on: a live row whose body names a closed row links back", async () => {
    await withRunner(async (dir, url) => {
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      const c = r.records.find((x) => x.qitemId === ID_C)!;
      expect(c.followOn).toContain("qitem-20261110000004-dddddddddddddddd");
    });
  });
});

// O4 M2 counting + L5 file rules (probe-outcomes: a pre-existing 644 file
// and 755 dir kept their wide modes across runs; a symlink there is written
// THROUGH). The collector owns this path - after EVERY write it enforces
// 0700 dir / 0600 file, and it refuses (error, not silent skip) on a
// symlink dir or file.
describe("collectOutcomes O4: skipped-row count and file modes (L5)", () => {
  test("M2: a hostile row is skipped and COUNTED, the good rows still land", async () => {
    const dir = makeTempDir("o4-skip-");
    // The escape sits INSIDE the seat part so the rig-suffix row filter
    // still accepts the row - it is buildRecord's vocabulary that must stop
    // it (and count it).
    const hostile = doc("qitem-20261110000009-eeeeeeeeeeeeeeee", {
      destinationSession: `vic${String.fromCodePoint(0x1b)}tim@fixture-rig`,
    });
    const d = await startFakeDaemon({
      queueListDone: [...docsFixture(), hostile],
      queueListAll: allDocsFixture(),
      transitions: DONE_TRS,
    });
    try {
      const r = await collectOutcomes({ daemonUrl: d.url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      expect(r.closedRows).toBe(4);
      expect(r.skippedRows).toBe(1);
      expect(r.added).toBe(3);
      expect(r.records.some((x) => x.qitemId === "qitem-20261110000009-eeeeeeeeeeeeeeee")).toBe(false);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L5: a pre-existing wide dir/file is tightened after the write", async () => {
    await withRunner(async (dir, url) => {
      const od = join(dir, "outcomes");
      mkdirSync(od, { recursive: true, mode: 0o755 });
      const file = outcomesFile(dir, "fixture-rig");
      writeFileSync(file, "", { mode: 0o644 });
      chmodSync(file, 0o644); // creation mode is masked by umask - force the wide mode
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      expect(r.added).toBe(3);
      expect(statSync(od).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // and a REBUILD keeps them tight
      chmodSync(file, 0o644);
      const rb = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      if ("error" in rb) throw new Error(rb.error);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  test("L5: a symlinked outcomes FILE is refused; the target stays untouched", async () => {
    await withRunner(async (dir, url) => {
      const od = join(dir, "outcomes");
      mkdirSync(od, { recursive: true, mode: 0o700 });
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "IMPORTANT-OWNER-FILE-4f13\n", { mode: 0o600 });
      symlinkSync(victim, outcomesFile(dir, "fixture-rig"));
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      expect("error" in r).toBe(true);
      if (!("error" in r)) return;
      expect(r.error).toContain("symlink");
      expect(readFileSync(victim, "utf8")).toBe("IMPORTANT-OWNER-FILE-4f13\n");
      expect(lstatSync(outcomesFile(dir, "fixture-rig")).isSymbolicLink()).toBe(true);
    });
  });

  test("L5: a symlinked outcomes DIR is refused", async () => {
    await withRunner(async (dir, url) => {
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere, { recursive: true, mode: 0o755 });
      symlinkSync(elsewhere, join(dir, "outcomes"));
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      expect("error" in r).toBe(true);
      if (!("error" in r)) return;
      expect(r.error).toContain("symlink");
      expect(existsSync(join(elsewhere, "fixture-rig.jsonl"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// O5 (review R15 on 90f2ae6): counting fixes. A failing test per finding,
// built from the reviewer's fixture descriptions.

const o5rec = (over: Partial<OutcomeRecord>): OutcomeRecord => ({
  qitemId: ID_A, source: "a@fixture-rig", destination: SEAT, tags: [],
  created: "2026-11-10T00:00:00.000Z", claimed: null, closed: null,
  closeTransitionId: null, closureReason: null, closureTarget: null,
  handoffFrom: null, handoffTo: null, reopenCount: 0, followOn: [],
  memory: { digestShown: 0, recallShown: 0, recallHeld: 0, search: 0, ask: 0, remember: 0, retire: 0, pointerShown: 0, pointerHeld: 0 },
  ...over,
});

describe("O5 F-A + N-A: pull rate over claimed rows; even median is a mean", () => {
  test("F-A: searched share divides by CLAIMED rows only, and the line says so", () => {
    const s = summarize([
      o5rec({ claimed: "2026-11-10T00:30:00.000Z", closed: "2026-11-10T02:00:00.000Z", memory: { ...o5rec({}).memory, search: 1 } }),
      o5rec({ qitemId: ID_B }), // never claimed: can never hold memory use
    ]);
    expect(s[0]!.claimedRows).toBe(1);
    expect(s[0]!.searchedShare).toBeCloseTo(1); // ADR rate: 100%, not 50%
    const line = summaryLines(s)[0]!;
    expect(line).toContain("searched 100% of 1 claimed");
  });
  test("F-A: zero claimed rows reads 0% of 0 claimed, never a divide hole", () => {
    const line = summaryLines(summarize([o5rec({})]))[0]!;
    expect(line).toContain("searched 0% of 0 claimed");
  });
  test("N-A: median of four spans 10/20/30/40 s is 25 s", () => {
    const mk = (secs: number) => o5rec({
      qitemId: `qitem-2026111000000${secs}-aaaaaaaaaaaaaaaa`,
      claimed: "2026-11-10T00:00:00.000Z",
      closed: new Date(Date.UTC(2026, 10, 10, 0, 0, secs)).toISOString(),
    });
    const s = summarize([mk(10), mk(20), mk(30), mk(40)]);
    expect(s[0]!.medianClaimToCloseMs).toBe(25_000);
    expect(summaryLines(s)[0]).toContain("median claim->close 25s");
  });
});

describe("O5 F-B + L-A: closed-row window and session-aware attribution", () => {
  test("F-B: a done row with no done transition closes at tsUpdated", () => {
    const r = buildRecord(
      doc(ID_A, { state: "done", tsUpdated: "2026-11-10T03:00:00.000Z" }),
      [tr(101, "pending", "2026-11-10T00:00:00.000Z"), tr(102, "in-progress", "2026-11-10T00:30:00.000Z")],
      new Map(),
    )!;
    expect(r.closed).toBe("2026-11-10T03:00:00.000Z");
    // the reviewer fixture: a search 30 days AFTER tsUpdated is not credited
    const m = memoryWindow(
      [logLine({ ts: "2026-12-10T00:00:00.000Z" })],
      SEAT,
      r.claimed,
      r.closed,
    );
    expect(m.search).toBe(0);
  });
  test("L-A: an MCP line with a session matches on it; a foreign session is never credited", () => {
    const lines = [
      logLine({ peer: "dev-build", session: "dev-build@totally-other-rig", ts: "2026-11-10T01:00:00.000Z" }),
    ];
    expect(memoryWindow(lines, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z").search).toBe(0);
    const mine = [logLine({ peer: "someone-else", session: SEAT, ts: "2026-11-10T01:00:00.000Z" })];
    expect(memoryWindow(mine, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z").search).toBe(1);
  });
  test("L-A: an older MCP line without a session still matches by peer", () => {
    expect(memoryWindow([logLine()], SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z").search).toBe(1);
  });
  test("L-A guard: session-start/recall lines keep peer matching (their session field is the CLAUDE session)", () => {
    const lines = [
      logLine({ hook: "session-start", moment: "startup", peer: SEAT, session: "build--general--1" }),
      logLine({ hook: "recall", event: "injected", peer: "dev-build" }),
    ];
    const m = memoryWindow(lines, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z");
    expect(m.digestShown).toBe(1);
    expect(m.recallShown).toBe(1);
  });
});

describe("O5 F-C: one record per qitem; append and --rebuild agree", () => {
  test("collect, reopen, close, collect: replaced in place, then rebuild is byte-identical", async () => {
    const dir = makeTempDir("o4-fc-");
    const reopenTrs = (id: string): unknown[] => [
      ...DONE_TRS.map((t) => ({ ...t, qitemId: id })),
      { transitionId: 104, qitemId: id, state: "in-progress", ts: "2026-11-10T03:00:00.000Z" },
      { transitionId: 105, qitemId: id, state: "done", ts: "2026-11-10T04:00:00.000Z", closureReason: "handed_off_to", closureTarget: "design-architect@fixture-rig" },
    ];
    let reopened = false;
    const d = await startFakeDaemon({
      queueListDone: docsFixture(),
      queueListAll: allDocsFixture(),
      transitions: (id: string) => (reopened && id === ID_A ? reopenTrs(id) : DONE_TRS.map((t) => ({ ...t, qitemId: id }))),
    });
    try {
      const r1 = await collectOutcomes({ daemonUrl: d.url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r1) throw new Error(r1.error);
      expect(r1.added).toBe(3);
      reopened = true;
      const r2 = await collectOutcomes({ daemonUrl: d.url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r2) throw new Error(r2.error);
      expect(r2.added).toBe(0); // ONE record per qitem: the reopen REPLACES
      expect(r2.replaced).toBe(1);
      const file = outcomesFile(dir, "fixture-rig");
      const afterAppend = readFileSync(file, "utf8");
      expect(afterAppend.split("\n").filter((l) => l !== "")).toHaveLength(3);
      const a = JSON.parse(afterAppend.split("\n").find((l) => l.includes(ID_A))!);
      expect(a.closeTransitionId).toBe(105); // the NEWER close replaced it
      expect(a.reopenCount).toBe(1);
      const r3 = await collectOutcomes({ daemonUrl: d.url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      if ("error" in r3) throw new Error(r3.error);
      expect(readFileSync(file, "utf8")).toBe(afterAppend); // byte for byte
      void summarize;
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("O5 add-on (R15 Part 2): F-D absent seats, F-H pointer arm, F-I no phantom file", () => {
  test("F-D: an ABSENT seat field gives null and KEEPS the row; present-malformed still skips", () => {
    const r = buildRecord(doc(ID_A, { sourceSession: undefined }), DONE_TRS, new Map());
    expect(r).not.toBeNull();
    expect(r!.source).toBeNull();
    expect(r!.destination).toBe(SEAT); // reviewer fixture: destination present, source absent
    const r2 = buildRecord(doc(ID_A, { destinationSession: undefined }), DONE_TRS, new Map());
    expect(r2).not.toBeNull();
    expect(r2!.destination).toBeNull();
    // present but malformed: not the daemon legitimately omitting a field
    expect(buildRecord(doc(ID_A, { sourceSession: "bad seat" }), DONE_TRS, new Map())).toBeNull();
    expect(buildRecord(doc(ID_A, { destinationSession: 42 }), DONE_TRS, new Map())).toBeNull();
    // summarize must not choke on a null destination
    expect(summaryLines(summarize([o5rec({ source: null, destination: null })]))[0]).toContain("(no destination)");
  });
  test("F-D: collect adds the row whose sourceSession is absent", async () => {
    const dir = makeTempDir("o5-fd-");
    const d = await startFakeDaemon({
      queueListDone: [doc(ID_A, { sourceSession: undefined })],
      queueListAll: [doc(ID_A, { sourceSession: undefined })],
      transitions: (id: string) => DONE_TRS.map((t) => ({ ...t, qitemId: id })),
    });
    try {
      const r = await collectOutcomes({ daemonUrl: d.url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      expect(r.added).toBe(1); // was skippedRows=1, added=0 before the fix
      expect(r.skippedRows).toBe(0);
      expect(r.records[0]!.source).toBeNull();
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("F-H: user-prompt lines count the pointer arm (shown/held) into the window", () => {
    const lines = [
      logLine({ hook: "user-prompt", pointer: "shown" }),
      logLine({ hook: "user-prompt", pointer: "held" }),
      logLine({ hook: "user-prompt", pointer: "none" }), // skipped runs: not the arm
    ];
    const m = memoryWindow(lines, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z");
    expect(m.pointerShown).toBe(1);
    expect(m.pointerHeld).toBe(1);
  });
  test("F-I: a run that wrote nothing prints no file path", async () => {
    const dir = makeTempDir("o5-fi-");
    const d = await startFakeDaemon({
      // hostile but rig-suffixed (P5 shape): passes the rig filter, fails the vocabulary
      queueListDone: [doc(ID_A, { destinationSession: "vic\u001btim@fixture-rig" })],
      queueListAll: [doc(ID_A, { destinationSession: "vic\u001btim@fixture-rig" })],
      transitions: (id: string) => DONE_TRS.map((t) => ({ ...t, qitemId: id })),
    });
    try {
      const bin = new URL("../../plugin/bin/outcomes.ts", import.meta.url).pathname;
      const p = Bun.spawn([process.execPath, bin, "--rig", "fixture-rig", "--daemon-url", d.url, "--state-dir", dir], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HONCHO_STATE_DIR: dir, OPENRIG_URL: "" },
      });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      expect(out).not.toContain("file:"); // F-I: the path would point at a file that does not exist
      expect(out).toContain("rows skipped (name/pointer shape 1)");
      expect(existsSync(outcomesFile(dir, "fixture-rig"))).toBe(false);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// daemon client additions (kept next to their consumer's tests).

describe("daemon list/transitions/current-item clients", () => {
  test("fetchQueueListByState / fetchQueueListAll parse plain arrays, drop junk", async () => {
    const d = await startFakeDaemon({ queueListDone: [doc(ID_A), 7, null] });
    try {
      const r = await fetchQueueListByState(d.url, "done");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.docs).toHaveLength(1);
    } finally { d.close(); }
    const d2 = await startFakeDaemon({ queueListAll: { items: [] } });
    try {
      expect(await fetchQueueListAll(d2.url)).toEqual({ ok: false, kind: "parse" });
    } finally { d2.close(); }
    expect(await fetchQueueListByState(undefined, "done")).toEqual({ ok: false, kind: "no-url" });
  });

  test("fetchTransitions answers the plain array; an object is parse", async () => {
    const d = await startFakeDaemon({ transitions: DONE_TRS });
    try {
      const r = await fetchTransitions(d.url, ID_A);
      expect(r.ok && r.transitions.length).toBe(3);
    } finally { d.close(); }
    const d2 = await startFakeDaemon({ transitions: { items: [] } });
    try {
      expect(await fetchTransitions(d2.url, ID_A)).toEqual({ ok: false, kind: "parse" });
    } finally { d2.close(); }
  });

  test("fetchCurrentItem: first in-progress for exactly this session, else null", async () => {
    const d = await startFakeDaemon({
      queueList: [
        { qitemId: ID_B, destinationSession: "other@r", state: "in-progress" },
        { qitemId: ID_A, destinationSession: SEAT, state: "in-progress" },
        { qitemId: ID_C, destinationSession: SEAT, state: "pending" },
      ],
    });
    try {
      expect(await fetchCurrentItem(d.url, SEAT)).toBe(ID_A);
      expect(await fetchCurrentItem(d.url, "nobody@r")).toBeNull();
      expect(await fetchCurrentItem(undefined, SEAT)).toBeNull();
    } finally { d.close(); }
  });
});

// O1 (ADR-0017): the collector NEVER contacts Honcho - pinned structurally:
describe("Honcho isolation", () => {
  test("outcomes sources import no honcho module", () => {
    for (const f of ["../../plugin/src/outcomes.ts", "../../plugin/bin/outcomes.ts"].map((p) =>
      join(import.meta.dir, p),
    )) {
      // no honcho MODULE may be imported; the state-dir fallback path string
      // (.openrig-honcho) is a filesystem name, not Honcho contact.
      expect(readFileSync(f, "utf8")).not.toMatch(/from\s+"[^"]*honcho[^"]*\.ts"/);
    }
  });
});
