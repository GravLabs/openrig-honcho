// v0.5.11 (ADR-0020): the memory report - counting, the outcome comparisons,
// ledger states, and the page's safety (escaped, redacted, counts-only means
// no memory text). Pure: no server, no files.

import { describe, expect, test } from "bun:test";
import { formatEntry, formatRetire, toEntries } from "../../plugin/src/ledger.ts";
import { memoryWindow, summarize, type OutcomeRecord } from "../../plugin/src/outcomes.ts";
import {
  costsContext,
  ledgerNodes,
  modelFamily,
  outcomeGroups,
  renderReport,
  shownUsed,
  usage,
  usageOf,
  type ReportInput,
} from "../../plugin/src/report.ts";

const NOW = "2026-11-24T12:00:00.000Z";
const line = (o: Record<string, unknown>) => ({ ts: "2026-11-24T10:00:00.000Z", ok: true, ms: 10, peer: "build", ...o });

const one = (o: Record<string, unknown>) => usageOf(o).map((u) => `${u.kind}:${u.n}`).join(",");

describe("usageOf", () => {
  test("each counted event maps to its kinds; others count nothing", () => {
    expect(one(line({ hook: "user-prompt", event: "sent", n_msgs: 2 }))).toBe("recorded:2");
    expect(one(line({ hook: "stop", event: "sent" }))).toBe("recorded:1");
    expect(one(line({ hook: "session-start", event: "compact", moment: "continuity" }))).toBe("digest:1");
    expect(one(line({ hook: "recall", event: "injected" }))).toBe("recall:1");
    expect(one(line({ hook: "recall", event: "injected", arm: "shown" }))).toBe("recall:1");
    expect(one(line({ hook: "recall", event: "pointer", pointer: "shown" }))).toBe("pointer:1");
    expect(one(line({ hook: "recall", event: "pointer", pointer: "held" }))).toBe("");
    for (const t of ["search", "ask", "remember", "retire", "stale_review"]) expect(one(line({ hook: "mcp", event: `tool:${t}` }))).toBe(`${t}:1`);
    expect(one(line({ hook: "mcp", event: "tool:status" }))).toBe("");
    expect(one(line({ hook: "recall", event: "not-peer" }))).toBe("");
  });
  test("R24 F-B: a held recall wrote nothing to the prompt and is not counted as added", () => {
    expect(one(line({ hook: "recall", event: "injected", arm: "held" }))).toBe("");
    const u = usage([line({ hook: "recall", event: "injected", arm: "shown" }), line({ hook: "recall", event: "injected", arm: "held" }), line({ hook: "recall", event: "injected" })], NOW, 1);
    expect(u.totals.recall).toBe(2);
  });
  test("R24 F-C: the pre-O6 user-prompt pointer counts too, beside its message", () => {
    expect(one(line({ hook: "user-prompt", event: "sent", pointer: "shown" }))).toBe("recorded:1,pointer:1");
    expect(one(line({ hook: "user-prompt", event: "sent", pointer: "held" }))).toBe("recorded:1");
    const u = usage([line({ hook: "user-prompt", event: "sent", pointer: "shown" }), line({ hook: "recall", event: "pointer", pointer: "shown" })], NOW, 1);
    expect(u.totals.pointer).toBe(2);
  });
});

describe("usage", () => {
  test("counts by day and seat inside the window; latency and failures per hook", () => {
    const lines = [
      line({ hook: "user-prompt", event: "sent", n_msgs: 3 }),
      line({ hook: "mcp", event: "tool:search", peer: "review", ms: 30 }),
      line({ hook: "recall", event: "injected", ok: false, ms: 50 }),
      line({ hook: "recall", event: "injected", ts: "2026-11-01T00:00:00.000Z" }), // outside 3 days
      line({ hook: "recall", event: "injected", ts: "2026-11-25T00:00:00.000Z" }), // after now
      "garbage",
      null,
    ];
    const u = usage(lines, NOW, 3);
    expect(u.days).toEqual(["2026-11-22", "2026-11-23", "2026-11-24"]);
    expect(u.totals.recorded).toBe(3);
    expect(u.totals.search).toBe(1);
    expect(u.totals.recall).toBe(1);
    expect(u.bySeat.review?.search).toBe(1);
    expect(u.byDay["2026-11-24"]?.recorded).toBe(3);
    expect(u.hooks.recall).toEqual({ n: 1, p50: 50, p95: 50, failures: 1 });
  });
});

const rec = (id: string, over: Partial<OutcomeRecord> = {}, mem: Partial<OutcomeRecord["memory"]> = {}): OutcomeRecord => ({
  qitemId: id,
  source: "lead@r",
  destination: "build@r",
  tags: [],
  created: "2026-11-20T00:00:00.000Z",
  claimed: "2026-11-20T00:00:00.000Z",
  closed: "2026-11-20T02:00:00.000Z",
  closeTransitionId: 1,
  closureReason: "no-follow-on",
  closureTarget: null,
  handoffFrom: null,
  handoffTo: null,
  reopenCount: 0,
  followOn: [],
  memory: { digestShown: 0, recallShown: 0, recallHeld: 0, search: 0, ask: 0, remember: 0, retire: 0, pointerShown: 0, pointerHeld: 0, ...mem },
  ...over,
});

describe("outcomeGroups", () => {
  test("holdout arms and exposure split; rework is a reopen or a real follow-on; housekeeping and unclaimed rows left out", () => {
    const rs = [
      rec("qitem-1", { reopenCount: 1 }, { pointerShown: 1 }),
      rec("qitem-2", {}, { pointerShown: 1 }),
      rec("qitem-3", {}, { pointerHeld: 1 }),
      rec("qitem-4", {}, {}),
      rec("qitem-5", { claimed: null }, { recallShown: 2 }),
      rec("qitem-recovery-abc", {}, {}),
    ];
    const g = outcomeGroups(rs);
    expect(g.holdout.map((x) => [x.rows, x.reworkShare])).toEqual([[2, 0.5], [1, 0]]);
    expect(g.exposure.map((x) => [x.rows, x.reworkShare])).toEqual([[2, 0.5], [2, 0]]); // a held pointer is not memory shown
    expect(g.holdout[0]?.medianHours).toBe(2);
    expect(g.withCommits).toBe(0);
  });
  test("R24 F-D: commits counted on compared rows only; every logged row is a done row", () => {
    const commits = { atClaim: "a".repeat(40), atClose: "b".repeat(40), files: 3 } as unknown as OutcomeRecord["commits"];
    const rs = [
      rec("qitem-1", { closed: null }),
      rec("qitem-2", { closed: null, claimed: null }),
      rec("qitem-3"),
      rec("qitem-4", { commits }),
      rec("qitem-recovery-www", { commits }),
    ];
    const g = outcomeGroups(rs);
    expect(g.closedRows).toBe(5);
    expect(g.housekeeping).toBe(1);
    expect(g.unclaimed).toBe(1);
    expect(g.withCommits).toBe(1);
    expect(g.exposure.reduce((a, x) => a + x.rows, 0)).toBe(3);
    const html = renderReport(input({ outcomes: rs }));
    expect(html).toContain("5 closed rows, 3 compared below; left out: 1 OpenRig housekeeping, 1 never claimed; 1 of the compared carries its commits.");
    expect(g.compared + g.housekeeping + g.unclaimed).toBe(g.closedRows);
  });
});

describe("R24 F-H, F-I: the report and the outcome collector agree", () => {
  test("one digest rule: a failed session-start is no digest on either surface", () => {
    const lines = [
      line({ ts: "2026-11-20T00:10:00.000Z", hook: "session-start", event: "startup", moment: "restart", ok: false }),
      line({ ts: "2026-11-20T00:20:00.000Z", hook: "session-start", event: "startup", moment: "restart" }),
    ];
    expect(memoryWindow(lines, "build@r", "2026-11-20T00:00:00.000Z", "2026-11-20T02:00:00.000Z").digestShown).toBe(1);
    expect(usage(lines, "2026-11-20T12:00:00.000Z", 1).totals.digest).toBe(1);
  });
  test("summarize and the page count the same closed rows (a missing close time is still a done row)", () => {
    const rs = [rec("qitem-1"), rec("qitem-2", { closed: null }), rec("qitem-3")];
    expect(summarize(rs)[0]?.closed).toBe(outcomeGroups(rs).closedRows);
    expect(outcomeGroups(rs).closedRows).toBe(3);
  });
});

const T = (h: number) => new Date(Date.parse("2026-11-20T00:00:00.000Z") + h * 3_600_000).toISOString();
const conc = (content: string, h: number, i: number) => ({ id: `c${i}`, content, session_id: "lead--m--1", created_at: T(h) });
const ledgerFixture = () =>
  toEntries([
    conc(formatEntry({ kind: "decision", id: "d-0000000a", scope: "mission", fact: "use <script>alert(1)</script> nowhere" }), 0, 1),
    conc(formatEntry({ kind: "decision", id: "d-0000000b", scope: "mission", supersedes: "d-0000000a", fact: "the replacement" }), 1, 2),
    conc(formatEntry({ kind: "status", id: "d-0000000c", scope: "mission", fact: "main at one" }), 2, 3),
    conc(formatEntry({ kind: "status", id: "d-0000000d", scope: "mission", fact: "main at two" }), 3, 4),
    conc(formatEntry({ kind: "approval", id: "d-0000000e", scope: "mission", owner: "0a1b2c3d", fact: "ship it" }), 4, 5),
    conc(formatRetire("d-0000000e", "done"), 5, 6),
  ]);

describe("ledgerNodes", () => {
  test("states: in force, superseded (replaced and older status), retired with its time", () => {
    const n = ledgerNodes(ledgerFixture(), undefined, false);
    const st = Object.fromEntries(n.map((x) => [x.id, x.state]));
    expect(st).toEqual({ "d-0000000a": "superseded", "d-0000000b": "in force", "d-0000000c": "superseded", "d-0000000d": "in force", "d-0000000e": "retired" });
    expect(n.find((x) => x.id === "d-0000000e")?.retiredAt).toBe(T(5));
    expect(n.find((x) => x.id === "d-0000000b")?.supersedes).toBe("d-0000000a");
  });
  test("R24 F-A, N-A: scope is redacted, stripped of invisible characters and capped; empty counts-only", () => {
    const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""); // built at run time
    const led = toEntries([conc(`[decision d-00000011 · scope ${key}] clean \u202e fact\u0000`, 0, 1), conc(`[decision d-00000012 · scope ${"s".repeat(5000)}] long`, 1, 2)]);
    const n = ledgerNodes(led, undefined, false);
    expect(n[0]?.scope).toContain("[REDACTED:aws]");
    expect(n[0]?.text).not.toMatch(/[\u202e\u0000]/);
    expect(n[1]?.scope.length).toBeLessThanOrEqual(80);
    expect(ledgerNodes(led, undefined, true).every((x) => x.scope === "")).toBe(true);
    for (const countsOnly of [false, true]) {
      const html = renderReport(input({ ledger: led, countsOnly }));
      expect(html).not.toContain(key);
      expect(html).not.toContain("s".repeat(81));
      expect(html).not.toMatch(/[\u202e\u0000]/);
    }
    expect(renderReport(input({ ledger: led, countsOnly: true }))).not.toContain("<th>Scope</th>");
  });
  test("counts only: no text on any node", () => {
    expect(ledgerNodes(ledgerFixture(), undefined, true).every((x) => x.text === undefined)).toBe(true);
  });
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  rig: "testrig",
  workspace: "ws",
  now: NOW,
  days: 7,
  countsOnly: false,
  logLines: [line({ hook: "user-prompt", event: "sent", n_msgs: 1 })],
  outcomes: [rec("qitem-1", {}, { pointerShown: 1 })],
  ledger: ledgerFixture(),
  stored: { sessions: 3, conclusions: 1200, byObserver: { build: 900, "<b>": 1 } },
  stale: { pending: 2, kept: 1 },
  ...over,
});

describe("renderReport", () => {
  test("a whole page with every section; memory text escaped; no script anywhere", () => {
    const html = renderReport(input());
    for (const h of ["What the memory holds", "How the seats use it", "Does work go better with memory?", "The ledger over time", "Health"]) expect(html).toContain(h);
    expect(html).toContain("the replacement");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;b&gt;");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
  test("a secret in a ledger entry is redacted in the page", () => {
    const key = ["sk-ant-", "api03-", "A".repeat(30)].join(""); // built at run time
    const led = toEntries([conc(formatEntry({ kind: "decision", id: "d-0000000f", scope: "mission", fact: `key ${key} here` }), 0, 1)]);
    const html = renderReport(input({ ledger: led }));
    expect(html).not.toContain(key);
    expect(html).toContain("[REDACTED:anthropic]");
  });
  test("counts only: no ledger text, no Text column, says so in the header", () => {
    const html = renderReport(input({ countsOnly: true }));
    expect(html).not.toContain("the replacement");
    expect(html).not.toContain("main at two");
    expect(html).not.toContain("<th>Text</th>");
    expect(html).toContain("counts only, no memory text");
  });
  test("R24 F-G: a hostile created_at never reaches the page; Since is a date or blank", () => {
    const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
    const led = ledgerFixture().map((e, i) => (i === 3 ? { ...e, at: `${key}\u202e\u0000` } : e));
    const html = renderReport(input({ ledger: led }));
    expect(html).not.toContain("AKIA");
    expect(html).not.toMatch(/[\u202e\u0000]/);
    expect(ledgerNodes(led, undefined, false).every((n) => n.at === "" || /^\d{4}-\d\d-\d\dT/.test(n.at))).toBe(true);
  });
  test("R24 F-J: the outcome sentence adds up, singular at one, never-claimed rows named", () => {
    const rs = [rec("qitem-1"), rec("qitem-2", { claimed: null }), rec("qitem-recovery-x")];
    const g = outcomeGroups(rs);
    expect([g.closedRows, g.compared, g.housekeeping, g.unclaimed]).toEqual([3, 1, 1, 1]);
    expect(renderReport(input({ outcomes: rs }))).toContain("3 closed rows, 1 compared below; left out: 1 OpenRig housekeeping, 1 never claimed.");
    expect(renderReport(input({ outcomes: [rec("qitem-1")] }))).toContain("1 closed row, 1 compared below.");
  });
  test("R24 F-E: a ledger with no readable times still renders a page, with no NaN", () => {
    const undated = ledgerFixture().map((e) => ({ ...e, at: "" }));
    for (const countsOnly of [false, true]) {
      const html = renderReport(input({ ledger: undated, countsOnly }));
      expect(html).toContain("timeline is not drawn");
      expect(html).not.toContain("NaN");
    }
    const mixed = ledgerFixture().map((e, i) => (i === 0 ? { ...e, at: "" } : e));
    const html = renderReport(input({ ledger: mixed }));
    expect(html).not.toContain("NaN");
    expect(html).toContain("1 entry has no readable time");
  });
  test("R24 F-F: a late retirement's cross stays inside the chart; kinds pin the class attribute", () => {
    const led = toEntries([
      conc(formatEntry({ kind: "decision", id: "d-00000010", scope: "mission", fact: "a" }), 0, 1),
      conc(formatEntry({ kind: "status", id: "d-00000011", scope: "mission", fact: "b" }), 1, 2),
      conc(formatRetire("d-00000010", "late"), 24 * 30, 3),
    ]);
    const html = renderReport(input({ ledger: led }));
    const xs = [...html.matchAll(/<text x="([\d.]+)"[^>]*class="x"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(1);
    for (const x of xs) expect(x >= 80 && x <= 626).toBe(true);
    const classes = [...html.matchAll(/<circle [^>]*class="([^"]*)"/g)].map((m) => m[1]);
    for (const c of classes) expect(c).toMatch(/^dot (on|off) (decision|approval|status)$/);
  });
  test("unreachable parts render as missing, never throw", () => {
    const html = renderReport(input({ ledger: null, stored: null, stale: null, outcomes: [], logLines: [] }));
    expect(html).toContain("The ledger could not be read.");
  });
});

describe("shown against used (B11, ADR-0022 d4)", () => {
  const sl = (o: Record<string, unknown>) => line({ hook: "stop", event: "sent", ...o });
  test("modelFamily: claude ids, local engine ids, other, unknown", () => {
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("claude");
    expect(modelFamily("qwen3.8-flash-next")).toBe("local");
    expect(modelFamily("Local-Engine-2.2-Q6")).toBe("local");
    expect(modelFamily("gpt-5-codex")).toBe("other");
    expect(modelFamily(undefined)).toBe("unknown");
    expect(modelFamily("")).toBe("unknown");
    // F-V4 (R27): validate with modelFromInput first - an invalid id is
    // "unknown" (no valid model), never "other" (a wrong family label).
    expect(modelFamily("hand-edited\njunk")).toBe("unknown");
    expect(modelFamily("bad model!")).toBe("unknown");
    expect(modelFamily("x".repeat(101))).toBe("unknown");
  });
  test("shownUsed: per family and kind over the window; window, junk and model-less lines", () => {
    const lines = [
      sl({ model: "claude-haiku-4-5", shown: ["decision:d-00000001", "approval:d-cafe0001", "junk:xx"] }),
      sl({ model: "qwen3-next", used: ["decision:d-00000001"] }),
      sl({ model: "gpt-5-codex", shown: ["pointer:qitem-20261126033123-fa23880114985030"] }),
      sl({ peer: "lead", shown: ["lesson:qitem-20261126033123-b1d597bc0111f573"] }), // no model id, no model line at that seat -> unknown
      sl({ model: "claude-haiku-4-5", shown: ["decision:d-00000002"], ts: "2026-11-01T00:00:00.000Z" }), // outside 7 d
      sl({ model: "gpt-5-codex", cited: ["decision:d-00000003"], acted: ["decision:d-00000004"], used: ["decision:d-00000003", "decision:d-00000004"] }), // B12 split line
      sl({ shown: "not-an-array" }),
      null,
    ];
    const su = shownUsed(lines, NOW, 7);
    expect(su.live).toBe(true);
    expect(su.cells.claude.decision.shown).toBe(1);
    expect(su.cells.claude.approval.shown).toBe(1);
    // B12 fold: a pre-split line (used only) counts as cited, never acted.
    expect(su.cells.local.decision.used).toBe(1);
    expect(su.cells.local.decision.cited).toBe(1);
    expect(su.cells.local.decision.acted).toBe(0);
    expect(su.cells.other.pointer.shown).toBe(1);
    expect(su.cells.unknown.lesson.shown).toBe(1);
    expect(su.cells.local.decision.shown).toBe(0);
    expect(su.cells.claude.decision.used).toBe(0);
    // a split line keeps its own cited/acted (own model only, no borrow);
    // used = the union field
    expect(su.cells.other.decision.cited).toBe(1);
    expect(su.cells.other.decision.acted).toBe(1);
    expect(su.cells.other.decision.used).toBe(2);
    expect(su.entries.get("decision:d-00000001")).toEqual({ kind: "decision", shown: 1, cited: 1, acted: 0 });
    expect(su.entries.get("decision:d-00000004")).toEqual({ kind: "decision", shown: 0, cited: 0, acted: 1 });
    expect(shownUsed([line({ hook: "session-start", moment: "continuity" })], NOW, 7).live).toBe(false);
  });
  test("F-V2 fold: a used-only line feeds cited and the used compat, never acted; a cited/acted-only line builds its own union", () => {
    const split = shownUsed([sl({ model: "qwen3-next", cited: ["conclusion:c-abc12345"], acted: ["conclusion:c-def45678"] })], NOW, 7);
    expect(split.cells.local.conclusion.cited).toBe(1);
    expect(split.cells.local.conclusion.acted).toBe(1);
    expect(split.cells.local.conclusion.used).toBe(2); // usedRaw ?? union
    expect(split.live).toBe(true);
    const fold = shownUsed([sl({ model: "qwen3-next", used: ["conclusion:c-abc12345"] })], NOW, 7);
    expect(fold.cells.local.conclusion.cited).toBe(1);
    expect(fold.cells.local.conclusion.acted).toBe(0);
    expect(fold.cells.local.conclusion.used).toBe(1);
  });
  test("costsContext (b98ef14): shown at least 5 and never cited AND never acted; any cited or acted entry is out", () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 5; i++) lines.push(sl({ model: "claude-haiku", shown: ["decision:d-0000000a", "conclusion:c-never1", "conclusion:c-cited1", "conclusion:c-acted1"] }));
    // cited once: out (Codex entries would otherwise be listed forever)
    lines.push(sl({ model: "claude-haiku", shown: ["conclusion:c-cited1"], cited: ["conclusion:c-cited1"] }));
    // acted once: out
    lines.push(sl({ model: "claude-haiku", shown: ["conclusion:c-acted1"], acted: ["conclusion:c-acted1"] }));
    for (let i = 0; i < 4; i++) lines.push(sl({ model: "claude-haiku", shown: ["decision:d-0000000b"] }));
    expect(costsContext(shownUsed(lines, NOW, 7))).toEqual([
      { entry: "conclusion:c-never1", kind: "conclusion", shown: 5 },
      { entry: "decision:d-0000000a", kind: "decision", shown: 5 },
    ]);
  });
  test("costsContext (N-F24, B13): a non-scannable conclusion is never listed; a scannable one at the same count still is", () => {
    // "conclusion:done" (all letters) and "conclusion:c-ne" (7 chars) are the
    // ids scannableEntry refuses in stop.ts, so no cited/acted evidence can
    // ever exist for them - listing them would call "never looked for"
    // "never cited or acted". They still count in Shown.
    const lines: unknown[] = [];
    for (let i = 0; i < 9; i++) lines.push(sl({ model: "claude-haiku", shown: ["conclusion:done", "conclusion:c-ne", "conclusion:c-abc12345"] }));
    const su = shownUsed(lines, NOW, 7);
    expect(costsContext(su)).toEqual([
      { entry: "conclusion:c-abc12345", kind: "conclusion", shown: 9 },
    ]);
    // the Shown column is unaffected: all three counted, 27 total
    expect(su.cells.claude.conclusion.shown).toBe(27);
    expect(su.entries.get("conclusion:done")).toEqual({ kind: "conclusion", shown: 9, cited: 0, acted: 0 });
    expect(su.entries.get("conclusion:c-ne")).toEqual({ kind: "conclusion", shown: 9, cited: 0, acted: 0 });
  });
  test("costsContext fold interaction: a pre-split used-only line counts as evidence (cited), clearing the entry", () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 5; i++) lines.push(sl({ model: "claude-haiku", shown: ["decision:d-0000000c"] }));
    lines.push(sl({ model: "claude-haiku", used: ["decision:d-0000000c"] })); // old shape: folds to cited
    expect(costsContext(shownUsed(lines, NOW, 7))).toEqual([]);
  });
  test("borrow (architect 2026-11-26): model-less shown lines take their seat's next model line", () => {
    const lines = [
      line({ hook: "session-start", moment: "continuity", peer: "build", ts: "2026-11-24T10:00:00.000Z", shown: ["decision:d-0000000e"] }),
      line({ hook: "recall", event: "injected", arm: "shown", peer: "build", ts: "2026-11-24T10:02:00.000Z", shown: ["conclusion:cx"] }),
      line({ hook: "stop", event: "sent", peer: "build", model: "claude-haiku-4-5-20251001", ts: "2026-11-24T10:05:00.000Z", used: ["decision:d-0000000e"] }),
    ];
    const su = shownUsed(lines, NOW, 7);
    expect(su.cells.claude.decision.shown).toBe(1);
    expect(su.cells.claude.conclusion.shown).toBe(1);
    expect(su.cells.claude.decision.used).toBe(1);
    expect(su.cells.unknown.decision.shown).toBe(0);
  });
  test("borrow limits: past 60 min, another seat's model, or only an earlier line - stays unknown", () => {
    const late = shownUsed(
      [
        line({ hook: "session-start", moment: "continuity", peer: "build", ts: "2026-11-24T10:00:00.000Z", shown: ["decision:d-0000000f"] }),
        line({ hook: "stop", event: "sent", peer: "build", model: "claude-haiku", ts: "2026-11-24T11:30:00.000Z" }),
      ],
      NOW,
      7,
    );
    expect(late.cells.unknown.decision.shown).toBe(1);
    expect(late.cells.claude.decision.shown).toBe(0);
    const other = shownUsed(
      [
        line({ hook: "session-start", moment: "continuity", peer: "build", ts: "2026-11-24T10:00:00.000Z", shown: ["decision:d-0000000f"] }),
        line({ hook: "stop", event: "sent", peer: "review", model: "claude-haiku", ts: "2026-11-24T10:05:00.000Z" }),
      ],
      NOW,
      7,
    );
    expect(other.cells.unknown.decision.shown).toBe(1);
    expect(other.cells.claude.decision.shown).toBe(0);
    const before = shownUsed(
      [
        line({ hook: "stop", event: "sent", peer: "build", model: "claude-haiku", ts: "2026-11-24T09:00:00.000Z" }),
        line({ hook: "session-start", moment: "continuity", peer: "build", ts: "2026-11-24T10:00:00.000Z", shown: ["decision:d-0000000f"] }),
      ],
      NOW,
      7,
    );
    expect(before.cells.unknown.decision.shown).toBe(1);
  });
  test("the page: family table, the Codex note, the costs list; a shown-less log says so", () => {
    const lines: unknown[] = [line({ hook: "session-start", moment: "continuity", model: "claude-haiku", shown: ["decision:d-0000000c"] })];
    // c-heavy1, not c-heavy: a 7-char conclusion is non-scannable (N-F24) and
    // would correctly never reach the costs list.
    for (let i = 0; i < 5; i++) lines.push(line({ hook: "stop", event: "sent", model: "qwen3-next", shown: ["conclusion:c-heavy1"] }));
    const html = renderReport(input({ logLines: lines }));
    expect(html).toContain("Shown against used");
    expect(html).toContain("<td>claude</td><td>decisions</td><td>1</td><td>0</td><td>0</td>");
    expect(html).toContain("Model family</th><th>Entry kind</th><th>Shown</th><th>Cited</th><th>Acted</th>");
    expect(html).toContain("Codex acted counts are not measured");
    expect(html).toContain("Codex entries show cited only");
    expect(html).not.toContain("Codex used counts come from the final message only");
    expect(html).toContain("Claude shown counts take the model of the seat's next Stop line within the hour");
    expect(html).toContain("never cited or acted - ids and counts only");
    expect(html).toContain("Costs context, no evidence");
    expect(html).toContain("<td>conclusion:c-heavy1</td><td>conclusion</td><td>5</td>");
    expect(html).toContain("local model");
    const off = renderReport(input());
    expect(off).toContain("No shown ids in this log window yet");
    expect(off).not.toContain("Costs context");
  });
  test("privacy: the table is counts only; ids appear only in the costs list; counts-only too", () => {
    // a single shown entry contributes counts, never its id (ids reach the
    // page only via the costs list, where the row allows them)
    const one = renderReport(input({ logLines: [line({ hook: "stop", event: "sent", model: "claude-haiku", shown: ["decision:d-0000000d"] })] }));
    expect(one).toContain("Shown against used");
    expect(one).not.toContain("decision:d-0000000d");
    const heavy: unknown[] = [];
    for (let i = 0; i < 5; i++) heavy.push(line({ hook: "stop", event: "sent", model: "claude-haiku", shown: ["decision:d-0000000d"] }));
    for (const countsOnly of [false, true]) {
      const html = renderReport(input({ logLines: heavy, countsOnly }));
      expect(html).toContain("decision:d-0000000d");
      expect(html).not.toMatch(/<script/);
    }
  });
});
