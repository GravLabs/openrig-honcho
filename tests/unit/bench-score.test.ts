// T18c (ADR-0013 decision 3): the benchmark's scoring math and dataset
// validator, pinned with an in-memory fake dataset and fake shown-sets -
// NO server, NO seeding. The real dataset files are also validated here
// (pure file reads), so dataset drift fails the unit gate, not a run.

import { describe, expect, test } from "bun:test";
import {
  aggregate,
  formatReport,
  inForceIds,
  loadDataset,
  scoreQuestion,
  validateDataset,
  type Concl,
  type Question,
} from "../../scripts/bench.ts";

const c = (
  id: string,
  observer: string,
  observed: string,
  created_at: string,
  content: string,
): Concl => ({ id, observer, observed, session: `${observer}--m--1`, mission: "m", created_at, content });

const ds: Concl[] = [
  c("x-1", "lead", "lead", "2026-01-01T00:00:00Z", "Decision: use LoRa at 868 MHz."),
  c("x-2", "lead", "lead", "2026-01-05T00:00:00Z", "Decision: use LoRa at 915 MHz; 868 retired."),
  c("x-3", "build", "build", "2026-01-06T00:00:00Z", "Builder is waiting on the driver."),
  c("x-4", "build", "build", "2026-01-07T00:00:00Z", "Driver merged; builder moved on."),
  c("x-5", "check", "build", "2026-01-02T00:00:00Z", "Lesson: flash on a spare board first."),
  c("x-6", "build", "build", "2026-01-07T06:00:00Z", "Builder used the make tool."),
];

const qs: Question[] = [
  {
    id: "fx-1",
    job: "decision",
    text: "which band?",
    as_of: "2026-01-07T12:00:00Z",
    pairs: [["lead", "lead"]],
    expect: ["x-2"],
    must_not: ["x-1"],
    known: [],
  },
  {
    id: "fx-2",
    job: "continuity",
    text: "what is build doing?",
    as_of: "2026-01-07T12:00:00Z",
    pairs: [["build", "build"]],
    expect: ["x-4"],
    must_not: ["x-3"],
    known: ["x-6"],
  },
  {
    id: "fx-3",
    job: "history",
    text: "what was the old band?",
    as_of: "2026-01-07T12:00:00Z",
    pairs: [["lead", "lead"]],
    expect: ["x-1"],
    must_not: [],
    known: [],
  },
];

const sh = (id: string, content = "0123456789") => ({ id, content }); // 10 chars

describe("T18c bench scorer", () => {
  test("answerable when an expected id is shown; forbidden ids count as wrong", () => {
    const good = scoreQuestion(qs[0], [sh("x-2"), sh("x-5")], 12);
    expect(good.answerable).toBe(true);
    expect(good.wrongShown).toBe(0);
    // x-2 expected (ok), x-5 neither expected nor forbidden (ok): 2/2
    expect(good.precision).toBe(1);
    expect(good.chars).toBe(20);
    expect(good.ms).toBe(12);
    expect(good.shown).toBe(2);

    const bad = scoreQuestion(qs[0], [sh("x-1"), sh("x-2")], 5);
    expect(bad.answerable).toBe(true); // expected present...
    expect(bad.wrongShown).toBe(1); // ...and the superseded one leaked
    expect(bad.precision).toBe(0.5); // only x-2 is ok
  });

  test("empty shown set scores zero, not a crash and not precision 1", () => {
    const s = scoreQuestion(qs[0], [], 3);
    expect(s.answerable).toBe(false);
    expect(s.precision).toBe(0);
    expect(s.novelty).toBe(0);
    expect(s.chars).toBe(0);
  });

  test("novelty: shown minus known over shown; empty known means all novel", () => {
    const s = scoreQuestion(qs[1], [sh("x-4"), sh("x-6")], 1);
    expect(s.novelty).toBe(0.5); // x-6 is known to the seat
    const n = scoreQuestion(qs[2], [sh("x-1")], 1);
    expect(n.novelty).toBe(1);
  });

  test("history job: the superseded id is the right answer, no must_not needed", () => {
    const s = scoreQuestion(qs[2], [sh("x-1"), sh("x-2")], 1);
    expect(s.answerable).toBe(true);
    expect(s.wrongShown).toBe(0);
  });

  test("aggregate: per strategy+job means, sums and latency percentiles", () => {
    const rows = [
      { s: scoreQuestion(qs[0], [sh("x-2")], 10), strategy: "a", job: "decision" },
      { s: scoreQuestion(qs[0], [sh("x-1")], 30), strategy: "a", job: "decision" },
      { s: scoreQuestion(qs[0], [sh("x-2"), sh("x-1")], 20), strategy: "b", job: "decision" },
      { s: scoreQuestion(qs[2], [sh("x-1")], 40), strategy: "b", job: "history" },
    ];
    const cells = aggregate(rows);
    expect(cells.length).toBe(3);
    const a = cells.find((x) => x.strategy === "a")!;
    expect(a.answerAtK).toBe(0.5);
    expect(a.precision).toBe(0.5);
    expect(a.wrongShown).toBe(1);
    expect(a.p50ms).toBe(30); // pct: sorted [10,30], floor(0.5*2)=1 -> 30
    const b = cells.find((x) => x.strategy === "b" && x.job === "decision")!;
    expect(b.p95ms).toBe(20);
    expect(b.novelty).toBe(1);
  });

  test("formatReport prints one aligned row per cell, header present", () => {
    const t = formatReport(aggregate([{ s: scoreQuestion(qs[0], [sh("x-2")], 7), strategy: "s1", job: "decision" }]));
    expect(t).toContain("strategy");
    expect(t).toContain("answer@k");
    expect(t).toContain("s1");
    expect(t.split("\n").length).toBe(2);
  });
});

describe("T18c dataset validator", () => {
  const qbase = (over: Partial<Question>): Question =>
    ({
      id: "vq",
      job: "decision",
      text: "t",
      as_of: "2026-01-07T12:00:00Z",
      pairs: [["lead", "lead"]],
      expect: ["x-2"],
      must_not: [],
      known: [],
      ...over,
    }) as Question;

  test("catches duplicate content, unknown refs, pair gaps, future expects", () => {
    expect(validateDataset([...ds, c("x-7", "lead", "lead", "2026-01-01T00:00:00Z", ds[0].content)], [])).toContain(
      "duplicate content x-7",
    );
    expect(validateDataset(ds, [qbase({ expect: ["nope"] })])).toContain("vq unknown id nope");
    expect(validateDataset(ds, [qbase({ expect: ["x-3"] })])).toContain("vq: x-3 not covered by pairs");
    expect(validateDataset(ds, [qbase({ expect: ["x-2"], as_of: "2026-01-04T00:00:00Z" })])).toContain(
      "vq: x-2 newer than as_of",
    );
    expect(validateDataset(ds, [qbase({ expect: [] })])).toContain("vq no expected id");
  });

  test("the fake dataset validates clean", () => {
    expect(validateDataset(ds, qs)).toEqual([]);
  });

  test("the REAL shipped dataset passes every invariant (no server)", () => {
    const { conclusions, questions } = loadDataset();
    expect(validateDataset(conclusions, questions)).toEqual([]);
    expect(conclusions.length).toBe(150);
    expect(questions.length).toBeGreaterThanOrEqual(40);
    const jobs = new Set(questions.map((q) => q.job));
    for (const j of ["continuity", "decision", "lesson", "peer", "provenance", "history"]) {
      expect(jobs.has(j)).toBe(true);
    }
    // every pair referenced by a question is seeded, i.e. exists in the corpus
    const pairs = new Set(conclusions.map((x) => `${x.observer}|${x.observed}`));
    for (const q of questions) {
      for (const [o, ob] of q.pairs) expect(pairs.has(`${o}|${ob}`)).toBe(true);
    }
  });

  // T19a2: the ledger link invariants
  const link = (over: Partial<Concl> & { id: string }): Concl => ({
    observer: "lead",
    observed: "lead",
    session: "lead--m--1",
    mission: "m",
    created_at: "2026-01-10T00:00:00Z",
    content: `Decision: content of ${over.id}.`,
    ...over,
  });
  const withProblems = (conclusions: Concl[]): string[] =>
    validateDataset(conclusions, []).filter((p) => p.includes("supersede"));

  test("a clean link passes; unknown target, stale replacer and non-lead ends all fail", () => {
    const ok = [link({ id: "b-1", created_at: "2026-01-01T00:00:00Z", content: "Decision: A." }),
      link({ id: "b-2", created_at: "2026-01-02T00:00:00Z", content: "Decision: B.", supersedes: "b-1" })];
    expect(withProblems(ok)).toEqual([]);
    expect(withProblems([
      link({ id: "b-2", content: "Decision: B.", supersedes: "b-404" }),
    ])).toEqual(["b-2 supersedes unknown b-404"]);
    // target newer than its replacer: the link points at the future
    expect(withProblems([
      link({ id: "b-1", created_at: "2026-01-01T00:00:00Z", content: "Decision: A.", supersedes: "b-2" }),
      link({ id: "b-2", created_at: "2026-01-05T00:00:00Z", content: "Decision: B." }),
    ])).toEqual(["b-1 supersedes b-2 but is not newer"]);
    // equal timestamps are not "older" either
    expect(withProblems([
      link({ id: "b-1", created_at: "2026-01-01T00:00:00Z", content: "Decision: A.", supersedes: "b-2" }),
      link({ id: "b-2", created_at: "2026-01-01T00:00:00Z", content: "Decision: B." }),
    ])).toEqual(["b-1 supersedes b-2 but is not newer"]);
    // a state note (not lead-authored) may not take part in a link
    expect(
      withProblems([
        link({ id: "b-1", observer: "build", observed: "build", created_at: "2026-01-01T00:00:00Z", content: "Builder note A." }),
        link({ id: "b-2", created_at: "2026-01-02T00:00:00Z", content: "Decision: B.", supersedes: "b-1" }),
      ]),
    ).toEqual(["b-2 supersedes b-1: links must be lead entries"]);
    expect(
      withProblems([
        link({ id: "b-1", created_at: "2026-01-01T00:00:00Z", content: "Decision: A." }),
        link({ id: "b-2", observer: "build", observed: "build", created_at: "2026-01-02T00:00:00Z", content: "Builder note B.", supersedes: "b-1" }),
      ]),
    ).toEqual(["b-2 supersedes b-1: links must be lead entries"]);
  });

  test("the real dataset's links pass: b-009 -> b-001 and b-010 -> b-005", () => {
    const { conclusions } = loadDataset();
    const links = conclusions.filter((x) => x.supersedes !== undefined);
    expect(links.map((x) => `${x.id}->${x.supersedes}`).sort()).toEqual(["b-009->b-001", "b-010->b-005"]);
    expect(validateDataset(conclusions, loadDataset().questions)).toEqual([]);
  });
});

describe("T19a2 in-force ledger filter", () => {
  const concl = (id: string, created_at: string, content: string, supersedes?: string): Concl => ({
    id,
    observer: "lead",
    observed: "lead",
    session: "lead--m--1",
    mission: "m",
    created_at,
    content,
    ...(supersedes !== undefined ? { supersedes } : {}),
  });
  const tiny: Concl[] = [
    concl("a", "2026-01-01T00:00:00Z", "Decision: run on 868."),
    concl("b", "2026-01-10T00:00:00Z", "Decision: run on 915.", "a"),
  ];

  test("A is in force before B exists, gone after; B always in force", () => {
    expect(inForceIds(tiny, "2026-01-05T00:00:00Z")).toEqual(new Set(["a"]));
    expect(inForceIds(tiny, "2026-01-10T00:00:00Z")).toEqual(new Set(["b"]));
    // exactly at as_of B exists: the filter is inclusive, like notFuture
    expect(inForceIds(tiny, "2026-01-09T23:59:59Z")).toEqual(new Set(["a"]));
  });

  test("the ledger rule is the real one: transitive chains and no links at all", () => {
    const chain: Concl[] = [
      concl("a", "2026-01-01T00:00:00Z", "Decision: A."),
      concl("b", "2026-01-02T00:00:00Z", "Decision: B.", "a"),
      concl("c", "2026-01-03T00:00:00Z", "Decision: C.", "b"),
    ];
    expect(inForceIds(chain, "2026-01-03T12:00:00Z")).toEqual(new Set(["c"]));
    const unlinked = [concl("a", "2026-01-01T00:00:00Z", "Decision: A."),
      concl("b", "2026-01-02T00:00:00Z", "Decision: B.")];
    expect(inForceIds(unlinked, "2026-01-03T00:00:00Z")).toEqual(new Set(["a", "b"]));
  });
});
