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
  commitsFor,
  storedCommits,
  extractQitemIds,
  followOnIds,
  memoryWindow,
  modelsWindow,
  outcomesFile,
  recordKey,
  serializeRecord,
  summarize,
  summaryLines,
  type OutcomeRecord,
} from "../../plugin/src/outcomes.ts";
import { COLLECTOR_TIMEOUT_MS, DAEMON_TIMEOUT_MS, fetchCurrentItem, fetchOutbox, fetchQueueListAll, fetchQueueListByState, fetchTransitions } from "../../plugin/src/daemon.ts";

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
  test("R20 F-P5: the anchor is the last pointer at or before the claim, not an old unclaimed nudge", () => {
    const Q = "qitem-20261110000500-bbbbbbbbbbbbbbbb";
    const l = [
      logLine({ ts: "2026-11-08T00:00:00.000Z", hook: "recall", event: "pointer", pointer: "shown", qitem: Q }), // old nudge
      logLine({ ts: "2026-11-09T00:00:00.000Z", hook: "mcp", event: "tool:search" }), // between - not credited
      logLine({ ts: "2026-11-10T00:20:00.000Z", hook: "recall", event: "pointer", pointer: "shown", qitem: Q }), // led to the claim
      logLine({ ts: "2026-11-10T00:25:00.000Z", hook: "mcp", event: "tool:search" }), // credited
    ];
    const m = memoryWindow(l, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T00:31:00.000Z", "2026-11-07T00:00:00.000Z", Q);
    expect(m.searchAfterPointer).toBe(1);
  });

  test("R20 N-P2: the record file keeps the pointer fields", () => {
    const m = memoryWindow([], SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T00:31:00.000Z");
    const line = serializeRecord({ qitemId: "q", source: null, destination: SEAT, tags: [], created: null, claimed: null, closed: null, closeTransitionId: null, closureReason: null, closureTarget: null, handoffFrom: null, handoffTo: null, reopenCount: 0, followOn: [], memory: { ...m, pointerShown: 2, pointerHeld: 1, searchAfterPointer: 1 } } as never);
    const back = JSON.parse(line).memory;
    expect([back.pointerShown, back.pointerHeld, back.searchAfterPointer]).toEqual([2, 1, 1]);
  });

  test("v0.5.6: the pointer arriving before the claim counts; searches count from the claim (R20 F-P2)", () => {
    const Q = "qitem-20261110000500-aaaaaaaaaaaaaaaa";
    const l = [
      logLine({ ts: "2026-11-10T00:06:00.000Z", hook: "recall", event: "pointer", pointer: "shown", qitem: Q }),
      logLine({ ts: "2026-11-10T00:05:30.000Z", hook: "mcp", event: "tool:search" }), // before the pointer
      logLine({ ts: "2026-11-10T00:10:00.000Z", hook: "mcp", event: "tool:search" }), // after the pointer, before the claim
    ];
    const m = memoryWindow(l, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T00:31:00.000Z", "2026-11-10T00:05:00.000Z", Q);
    expect(m.pointerShown).toBe(1); // arrived with the hand-off, before the claim
    expect(m.search).toBe(0); // tool calls still count from the claim
    expect(m.searchAfterPointer).toBe(1); // only the one after THIS row's pointer
    // another row's pointer is not this row's anchor
    expect(memoryWindow(l, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T00:31:00.000Z", "2026-11-10T00:05:00.000Z", "qitem-other").searchAfterPointer).toBeUndefined();
    // never claimed: still no window at all
    expect(memoryWindow(l, SEAT, null, "2026-11-10T00:31:00.000Z", "2026-11-10T00:05:00.000Z", Q).pointerShown).toBe(0);
  });

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
  test("B10: shown/used counts per kind inside the window; other seats and out-of-window lines excluded", () => {
    const Q = "qitem-20261110000500-cccccccccccccccc";
    const l = [
      logLine({ ts: "2026-11-10T00:20:00.000Z", hook: "recall", event: "pointer", pointer: "shown", qitem: Q, shown: [`pointer:${Q}`, "decision:d-0a0b0c0d"] }),
      logLine({ ts: "2026-11-10T00:40:00.000Z", hook: "session-start", event: "startup", moment: "continuity", shown: ["decision:d-deadbeef", "lesson:qitem-20261110000500-dddddddddddddddd"] }),
      logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", used: ["decision:d-0a0b0c0d"] }), // pre-split line: folds into cited
      logLine({ ts: "2026-11-10T01:10:00.000Z", hook: "stop", event: "sent", cited: ["conclusion:cx1234567"], acted: ["lesson:qitem-20261110000500-eeeeeeeeeeeeeeee"], used: ["conclusion:cx1234567", "lesson:qitem-20261110000500-eeeeeeeeeeeeeeee"] }), // B12 split line
      logLine({ ts: "2026-11-10T01:30:00.000Z", peer: "other@fixture-rig", hook: "stop", event: "sent", used: ["decision:d-99999999"] }), // other seat - OUT
      logLine({ ts: "2026-11-10T03:00:00.000Z", hook: "stop", event: "sent", used: ["decision:d-88888888"] }), // after close - OUT
    ];
    const m = memoryWindow(l, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z", "2026-11-10T00:05:00.000Z", Q);
    expect(m.shownIds).toEqual({ decision: 2, lesson: 1, pointer: 1 });
    expect(m.usedIds).toEqual({ decision: 1, conclusion: 1, lesson: 1 });
    expect(m.citedIds).toEqual({ decision: 1, conclusion: 1 }); // decision 1 = the fold
    expect(m.actedIds).toEqual({ lesson: 1 });
  });
  test("B10: a shown-less log stays byte-identical; once live, a never-claimed row counts {}", () => {
    const m0 = memoryWindow(lines, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z");
    expect("shownIds" in m0).toBe(false);
    expect("usedIds" in m0).toBe(false);
    expect("citedIds" in m0).toBe(false);
    expect("actedIds" in m0).toBe(false);
    const live = [logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", used: ["decision:d-0a0b0c0d"] })];
    const never = memoryWindow(live, SEAT, null, "2026-11-10T02:00:00.000Z");
    expect(never.shownIds).toEqual({});
    expect(never.usedIds).toEqual({});
    expect(never.citedIds).toEqual({}); // window-less row: initialized, not folded
    expect(never.actedIds).toEqual({});
  });
  test("B12 fold: a pre-split used-only line lands in citedIds, never actedIds; serializeRecord carries both", () => {
    const m = memoryWindow(
      [logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", used: ["decision:d-0a0b0c0d"] })],
      SEAT,
      "2026-11-10T00:30:00.000Z",
      null,
    );
    expect(m.citedIds).toEqual({ decision: 1 });
    expect(m.actedIds).toEqual({});
    const line = serializeRecord({ qitemId: "q", source: null, destination: SEAT, tags: [], created: null, claimed: null, closed: null, closeTransitionId: null, closureReason: null, closureTarget: null, handoffFrom: null, handoffTo: null, reopenCount: 0, followOn: [], memory: { ...m } } as never);
    const rec = JSON.parse(line) as { memory: Record<string, unknown> };
    expect(rec.memory.citedIds).toEqual({ decision: 1 });
    expect(rec.memory.actedIds).toEqual({});
  });
  test("B10: hand-edited junk entries never count and cannot make a log live; serializeRecord carries the fields", () => {
    const junk = [logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", used: ["status:d-0a0b0c0d", "garbage"] })];
    expect("usedIds" in memoryWindow(junk, SEAT, "2026-11-10T00:30:00.000Z", null)).toBe(false);
    const m = memoryWindow(
      [...junk, logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", used: ["decision:d-0a0b0c0d"] })],
      SEAT,
      "2026-11-10T00:30:00.000Z",
      null,
    );
    expect(m.usedIds).toEqual({ decision: 1 }); // the junk line added nothing
    const line = serializeRecord({ qitemId: "q", source: null, destination: SEAT, tags: [], created: null, claimed: null, closed: null, closeTransitionId: null, closureReason: null, closureTarget: null, handoffFrom: null, handoffTo: null, reopenCount: 0, followOn: [], memory: { ...m } } as never);
    expect(JSON.parse(line).memory.usedIds).toEqual({ decision: 1 });
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

// ADR-0022 decision 2: OutcomeRecord.models - sorted distinct model ids on
// the destination seat's lines in the row's window. Absent while the whole
// log carries no model (old records and every rebuild over a model-less log
// stay byte-identical); [] once the log is model-live but the window had none.
describe("models (ADR-0022 d2)", () => {
  const MA = "fixture-model-a.1";
  const MB = "zeta-model.2";
  test("modelsWindow: sorted distinct ids; seat, window and L-A rules as memoryWindow", () => {
    const l = [
      logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", model: MB }),
      logLine({ ts: "2026-11-10T00:30:00.000Z", hook: "session-start", event: "startup", model: MA }), // at claim - IN
      logLine({ ts: "2026-11-10T01:30:00.000Z", hook: "stop", event: "sent", model: MB }), // distinct dedupe
      logLine({ ts: "2026-11-10T00:29:59.000Z", hook: "stop", event: "sent", model: "out-of-window" }), // before claim - OUT
      logLine({ ts: "2026-11-10T01:10:00.000Z", hook: "stop", event: "sent", model: "other-seat-model", peer: "other@fixture-rig" }), // other seat - OUT
      logLine({ ts: "2026-11-10T01:11:00.000Z", hook: "mcp", event: "tool:search", model: "foreign-session", session: "x@other-rig" }), // L-A - OUT
      logLine({ ts: "2026-11-10T01:12:00.000Z", hook: "stop", event: "sent", model: "bad model!" }), // fails the grammar - ignored
    ];
    expect(modelsWindow(l, SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z")).toEqual([MA, MB]);
    // never claimed = no window (bottom rule shared with memoryWindow), but a live log still answers []
    expect(modelsWindow(l, SEAT, null, null)).toEqual([]);
  });
  test("absent while NO line in the log carries a model; [] once one does", () => {
    expect(modelsWindow([], SEAT, "2026-11-10T00:30:00.000Z", null)).toBeUndefined();
    // a "model" of its own that fails the grammar is not a model line either
    // (the writer cannot produce one; a hand-edited log must not flip records)
    expect(modelsWindow([logLine({ model: "bad model!" })], SEAT, "2026-11-10T00:30:00.000Z", null)).toBeUndefined();
    // a valid model line ANYWHERE (other seat, far outside the window) makes
    // new records carry the field: [] for a window that showed none
    expect(
      modelsWindow([logLine({ ts: "2020-01-01T00:00:00.000Z", peer: "other@fixture-rig", model: MA })], SEAT, "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z"),
    ).toEqual([]);
  });
  test("collector: records carry sorted models; rebuild idempotent; a model-less log keeps old bytes", async () => {
    await withRunner(async (dir, url) => {
      fixtureLog(dir, "fixture-rig", [
        logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "stop", event: "sent", model: MB }),
        logLine({ ts: "2026-11-10T01:00:00.000Z", hook: "session-start", event: "startup", model: MA }),
      ]);
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in r) throw new Error(r.error);
      expect(r.records).toHaveLength(3);
      // the two dev-build rows collect both ids; the dev-review row (ID_C,
      // its own destination seat) sees none in a live log: []
      for (const rec of r.records) {
        expect(rec.models).toEqual(rec.destination === SEAT ? [MA, MB] : []);
      }
      await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      const bytes = readFileSync(outcomesFile(dir, "fixture-rig"), "utf8");
      expect(JSON.parse(bytes.split("\n")[0]!).models).toEqual([MA, MB]);
      await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      expect(readFileSync(outcomesFile(dir, "fixture-rig"), "utf8")).toBe(bytes); // rebuild idempotency pin
    });
    await withRunner(async (dir, url) => {
      // no fixtureLog at all: no model line anywhere - the field is absent
      await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      expect(readFileSync(outcomesFile(dir, "fixture-rig"), "utf8")).not.toContain("models");
    });
  });
});

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

  test("R24 F-K24: a row the done list returns in another state never enters the file", async () => {
    await withRunner(async (dir) => {
      const d2 = await startFakeDaemon({
        queueListDone: [...docsFixture(), doc(ID_B + "1", { state: "in-progress" }), doc(ID_B + "2", { state: undefined })],
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

// F8 (ADR-0017 d5, found while verifying V6): OpenRig's own housekeeping
// follow-ons (stuck-sweep recovery rows, wake escalations) are not a rework
// signal. The machinery test is the one V6 shares (isMachineryRow).
describe("F8: follow-on share excludes OpenRig housekeeping", () => {
  const REC1 = "qitem-recovery-00000000000000a1";
  const ID_D = "qitem-20261110000004-dddddddddddddddd";
  const ID_E = "qitem-20261110000005-eeeeeeeeeeeeeeee";
  const ID_WAKE = "qitem-20261110000006-ffffffffffffffff";
  const ID_GHOST = "qitem-20261110000007-9999999999999999"; // never in the log

  test("recovery-only and wake follow-ons do not count; a review send-back and an absent plain id do", () => {
    const s = summarize([
      o5rec({ qitemId: ID_A, followOn: [REC1] }), // housekeeping only -> no
      o5rec({ qitemId: REC1, source: "advisor@fixture-rig", tags: ["stuck-sweep-finding"] }),
      o5rec({ qitemId: ID_B, followOn: [ID_C] }), // review sends work back -> yes
      o5rec({ qitemId: ID_C, source: "review@fixture-rig" }),
      o5rec({ qitemId: ID_D, followOn: [ID_WAKE] }), // wake escalation -> no
      o5rec({ qitemId: ID_WAKE, source: "daemon@fixture-rig", tags: ["wake-escalation"] }),
      o5rec({ qitemId: ID_E, followOn: [ID_GHOST] }), // absent: prefix alone speaks -> yes
    ]);
    expect(s[0]!.closed).toBe(7); // five parents + the two housekeeping rows themselves
    expect(s[0]!.followOnShare).toBeCloseTo(2 / 7);
    const line = summaryLines(s)[0]!;
    expect(line).toContain("follow-on (excl. housekeeping) 29%");
  });
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

  test("v0.5.7: the collector's reads wait past the hooks' 1 s budget; hook reads do not", async () => {
    // live 2026-11-22: GET /api/queue/list took 1.4-3 s (4.9-7.7 MB), so the
    // collector failed "queue list: daemon timeout" at the shared 1 s budget
    expect(COLLECTOR_TIMEOUT_MS).toBeGreaterThan(DAEMON_TIMEOUT_MS);
    const d = await startFakeDaemon({ delayMs: 1500, queueListDone: [doc(ID_A)], queueListAll: [doc(ID_A)], transitions: DONE_TRS });
    try {
      const [byState, all, tr, hook] = await Promise.all([
        fetchQueueListByState(d.url, "done"),
        fetchQueueListAll(d.url),
        fetchTransitions(d.url, ID_A),
        fetchOutbox(d.url, "architect@rig"),
      ]);
      expect(byState.ok && byState.docs.length).toBe(1);
      expect(all.ok && all.docs.length).toBe(1);
      expect(tr.ok && tr.transitions.length).toBe(3);
      expect(hook).toEqual({ ok: false, kind: "timeout" });
    } finally { d.close(); }
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

// v0.5.9 (ADR-0019 amended 2026-11-23): start/end commits on outcome records.
describe("outcome commits (--repo)", () => {
  const SHA1 = "1".repeat(40);
  const SHA2 = "2".repeat(40);
  const fakeGit = (calls: string[][]) => (_cwd: string, args: string[]): string | null => {
    calls.push(args);
    if (args[0] === "rev-list") return args[2] === `--before=@${Math.floor(Date.parse("2026-11-10T00:30:00.000Z") / 1000)}` ? `${SHA1}\n` : `${SHA2}\n`;
    if (args[0] === "diff") return "a.ts\nb/c.md\n";
    return null;
  };
  test("commitsFor: start at the claim, end at the close, files between; same commit is 0", () => {
    const calls: string[][] = [];
    const g = fakeGit(calls);
    expect(commitsFor("/repo", "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z", g)).toEqual({ start: SHA1, end: SHA2, files: 2 });
    expect(calls.map((c) => c[0])).toEqual(["rev-list", "rev-list", "diff"]);
    expect(commitsFor("/repo", "2026-11-10T03:00:00.000Z", "2026-11-10T04:00:00.000Z", g)).toEqual({ start: SHA2, end: SHA2, files: 0 });
  });
  test("commitsFor: no claim, a failing git or a non-sha answer is a null part, never an error", () => {
    expect(commitsFor("/repo", null, "2026-11-10T02:00:00.000Z", () => `${SHA2}\n`)).toEqual({ start: null, end: SHA2, files: null });
    expect(commitsFor("/repo", "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z", () => null)).toEqual({ start: null, end: null, files: null });
    expect(commitsFor("/repo", "2026-11-10T00:30:00.000Z", "2026-11-10T02:00:00.000Z", () => "fatal: bad\n")).toEqual({ start: null, end: null, files: null });
  });
  test("serializeRecord: commits rides LAST and only when collected", () => {
    const base = buildRecord(doc(ID_A), DONE_TRS, new Map()) as OutcomeRecord;
    const plain = serializeRecord(base);
    expect(plain).not.toContain("commits");
    const withC = serializeRecord({ ...base, commits: { start: SHA1, end: SHA2, files: 2 } });
    expect(withC).toBe(`${plain.slice(0, -1)},"commits":{"start":"${SHA1}","end":"${SHA2}","files":2}}`);
  });
  test("collector with a real throwaway repository: records name the commits; without --repo the bytes are unchanged", async () => {
    const { spawnSync } = await import("node:child_process");
    const repoDir = makeTempDir("o59-repo-");
    const g = (args: string[], date?: string) => {
      const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? "" } });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    g(["init", "-q"]);
    g(["config", "user.email", "t@example.invalid"]);
    g(["config", "user.name", "t"]);
    g(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repoDir, "a.ts"), "1\n");
    g(["add", "."]);
    g(["commit", "-qm", "one"], "2026-11-10T00:00:00Z");
    const c1 = g(["rev-parse", "HEAD"]);
    writeFileSync(join(repoDir, "a.ts"), "2\n");
    writeFileSync(join(repoDir, "b.md"), "2\n");
    g(["add", "."]);
    g(["commit", "-qm", "two"], "2026-11-10T01:00:00Z");
    const c2 = g(["rev-parse", "HEAD"]);
    await withRunner(async (dir, url) => {
      const plain = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      if ("error" in plain) throw new Error(plain.error);
      const before = readFileSync(outcomesFile(dir, "fixture-rig"), "utf8");
      expect(before).not.toContain("commits");
      const r = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, repo: repoDir, rebuild: true });
      if ("error" in r) throw new Error(r.error);
      const a = r.records.find((x) => x.qitemId === ID_A) as OutcomeRecord;
      // claimed 00:30 (after commit one), closed 02:00 (after commit two)
      expect(a.commits).toEqual({ start: c1, end: c2, files: 2 });
      const again = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, repo: repoDir, rebuild: true });
      if ("error" in again) throw new Error(again.error);
      expect(again.records.map(serializeRecord)).toEqual(r.records.map(serializeRecord));
      // R22 F-S3: the daily run without --repo keeps what a --repo run stored
      const withBytes = readFileSync(outcomesFile(dir, "fixture-rig"), "utf8");
      const daily = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir });
      if ("error" in daily) throw new Error(daily.error);
      expect(daily.replaced).toBe(0);
      expect(readFileSync(outcomesFile(dir, "fixture-rig"), "utf8")).toBe(withBytes);
      // an explicit rebuild without --repo re-derives the file: commits go
      const rb = await collectOutcomes({ daemonUrl: url, rig: "fixture-rig", stateDir: dir, rebuild: true });
      if ("error" in rb) throw new Error(rb.error);
      expect(readFileSync(outcomesFile(dir, "fixture-rig"), "utf8")).toBe(before);
    });
  });
});

describe("storedCommits (R22 F-S3)", () => {
  test("only a well-formed commits object is carried", () => {
    const S = "a".repeat(40);
    expect(storedCommits(JSON.stringify({ commits: { start: S, end: null, files: null } }))).toEqual({ start: S, end: null, files: null });
    expect(storedCommits(JSON.stringify({ commits: { start: "nope", end: S, files: 1 } }))).toBeUndefined();
    expect(storedCommits(JSON.stringify({ commits: { start: S, end: S, files: -1 } }))).toBeUndefined();
    expect(storedCommits(JSON.stringify({}))).toBeUndefined();
    expect(storedCommits("not json")).toBeUndefined();
  });
});
