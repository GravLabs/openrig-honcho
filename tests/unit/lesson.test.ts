// V6 (ADR-0019 decision 6, amended 2026-11-13): suggest a lesson after
// rework. Checks (a)-(e) from the row brief. The outcome log is a LOCAL
// file; the digest shows one line at session start; the plugin never reads
// or writes lore and never calls a model or the network for this.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { buildInjection, type ReaderDeps } from "../../plugin/src/reader.ts";
import {
  outcomesFile,
  serializeRecord,
  type OutcomeRecord,
} from "../../plugin/src/outcomes.ts";
import {
  lessonStatePath,
  maybeLessonSuggestion,
  readLessonState,
  reworkReason,
} from "../../plugin/src/lesson.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { makeTempDir } from "../support/tempdir.ts";

const WS = "ws";
const SELF = "build";
const SESSION = "build@testrig";
const NOW = "2026-11-13T12:00:00.000Z";
const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

const Q1 = "qitem-20261106120000-000000000000aa01";
const Q2 = "qitem-20261106120000-000000000000aa02";
const Q3 = "qitem-20261106120000-000000000000aa03";

const ZERO = {
  digestShown: 0, recallShown: 0, recallHeld: 0, search: 0, ask: 0,
  remember: 0, retire: 0, pointerShown: 0, pointerHeld: 0,
};

const rec = (over: Partial<OutcomeRecord> & { qitemId: string }): OutcomeRecord => ({
  source: "lead@testrig",
  destination: SESSION,
  tags: [],
  created: ago(5 * DAY),
  claimed: ago(4 * DAY),
  closed: ago(2 * DAY),
  closeTransitionId: 1,
  closureReason: "no-follow-on",
  closureTarget: null,
  handoffFrom: null,
  handoffTo: null,
  reopenCount: 0,
  followOn: [],
  memory: ZERO,
  ...over,
});

const seedOutcomes = (dir: string, recs: OutcomeRecord[]): void => {
  const file = outcomesFile(dir, WS);
  mkdirSync(join(dir, "outcomes"), { recursive: true });
  writeFileSync(file, recs.map((r) => serializeRecord(r)).join("\n") + "\n", { mode: 0o600 });
};

const mkConfig = (stateDir: string, over: Partial<Config> = {}): Config => ({
  enabled: true,
  url: "http://127.0.0.1:9/v3",
  workspace: WS,
  peer: SELF,
  observeOthers: false,
  ownerPeer: "owner",
  profileWorkspace: null,
  recordAutomation: true,
  apiKey: "k",
  stateDir,
  timeoutMs: 2000,
  digest: true,
  leaderPeer: SELF,
  sessionName: SESSION,
  ...over,
});

// ---------------------------------------------------------------------------
// (a) the rework rule, pure

describe("V6 lesson: the rework rule", () => {
  const by = (rs: OutcomeRecord[]): Map<string, OutcomeRecord> =>
    new Map(rs.map((r) => [r.qitemId, r]));

  test("(a) each rework kind is detected; an onward hand-off is not", () => {
    expect(reworkReason(rec({ qitemId: Q1, reopenCount: 1 }), by([]))).toBe("reopened");
    expect(reworkReason(rec({ qitemId: Q1, closureReason: "denied" }), by([]))).toBe("denied");
    expect(reworkReason(rec({ qitemId: Q1, closureReason: "failed" }), by([]))).toBe("failed");
    expect(
      reworkReason(
        rec({ qitemId: Q1, followOn: [Q2] }),
        by([rec({ qitemId: Q2, source: "review@testrig" })]), // SAME destination, DIFFERENT sender
      ),
    ).toBe("sent back");
    // an ordinary hand-off ONWARD: follow-on with a different destination
    expect(
      reworkReason(
        rec({ qitemId: Q1, followOn: [Q2] }),
        by([rec({ qitemId: Q2, destination: "review@testrig" })]),
      ),
    ).toBeNull();
    // plain clean closure
    expect(reworkReason(rec({ qitemId: Q1 }), by([]))).toBeNull();
    // not closed yet: nothing counts, even reopened
    expect(reworkReason(rec({ qitemId: Q1, closed: null, reopenCount: 2 }), by([]))).toBeNull();
    // canceled is NOT one of the four rework kinds
    expect(reworkReason(rec({ qitemId: Q1, closureReason: "canceled" }), by([]))).toBeNull();
  });

  // The four real shapes from a pilot outcome log (architect ruling 2026-11-13
  // 15:29Z): only a different seat sending work BACK is a correction.
  const REC1 = "qitem-recovery-00000000000000a1";

  test("(a2) review send-back is rework; machinery rows and continuations are not", () => {
    // the real rework: architect->build release row, review sends findings back
    expect(
      reworkReason(
        rec({ qitemId: Q1, source: "arch@testrig", followOn: [Q2] }),
        by([rec({ qitemId: Q2, source: "review@testrig" })]),
      ),
    ).toBe("sent back");
    // machinery: a stuck-sweep recovery row as the follow-on (id + tag)
    expect(
      reworkReason(
        rec({ qitemId: Q1, source: "arch@testrig", followOn: [REC1] }),
        by([rec({ qitemId: REC1, source: "advisor@testrig", tags: ["stuck-sweep-finding"] })]),
      ),
    ).toBeNull();
    // machinery: a daemon source with a wake-escalation tag
    expect(
      reworkReason(
        rec({ qitemId: Q1, source: "arch@testrig", followOn: [Q2] }),
        by([rec({ qitemId: Q2, source: "daemon@testrig", tags: ["wake-escalation"] })]),
      ),
    ).toBeNull();
    // machinery by tag alone: human source, wake- prefixed tag
    expect(
      reworkReason(
        rec({ qitemId: Q1, source: "arch@testrig", followOn: [Q2] }),
        by([rec({ qitemId: Q2, source: "operator@testrig", tags: ["wake-escalation"] })]),
      ),
    ).toBeNull();
    // continuation: the SAME requester sends a second row to the same seat
    expect(
      reworkReason(
        rec({ qitemId: Q1, followOn: [Q2] }),
        by([rec({ qitemId: Q2 })]), // both source lead@testrig
      ),
    ).toBeNull();
    // an unknown source never proves a different sender
    expect(
      reworkReason(
        rec({ qitemId: Q1, followOn: [Q2] }),
        by([rec({ qitemId: Q2, source: null })]),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// digest integration: fake Honcho only; the outcome + lesson files are local

describe("V6 lesson: the digest suggestion", () => {
  const setup = async (): Promise<{ fake: FakeHoncho; dir: string; config: Config; deps: ReaderDeps }> => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("lesson-");
    const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
    return { fake, dir, config: mkConfig(dir, { url: fake.url }), deps: { client, now: () => NOW } };
  };

  test("(b) shows for the destination seat only, once per item, one per digest", async () => {
    const { fake, dir, config, deps } = await setup();
    try {
      // Q1 reworked by a follow-on back to the same seat; Q2 is that follow-on
      seedOutcomes(dir, [
        rec({ qitemId: Q1, closed: ago(2 * DAY), followOn: [Q2] }),
        rec({ qitemId: Q2, source: "review@testrig", closed: ago(1 * DAY) }), // clean itself
        rec({ qitemId: Q3, destination: "other@testrig", reopenCount: 1, closed: ago(1 * DAY) }),
      ]);
      const out1 = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, deps);
      expect(out1).toContain("Lesson worth writing?");
      expect(out1).toContain(`${Q1} needed rework (sent back)`);
      expect(out1).toContain("seats/build/lore/<slug>.md");
      expect(out1).toContain("[authoritative]");
      expect(out1).not.toContain(Q3); // another seat's item never shows here
      // once per item: the second digest does not repeat it
      const out2 = await buildInjection({ source: "startup", claudeSessionId: "c2" }, config, deps);
      expect(out2).not.toContain("Lesson worth writing?");
      // at most one per digest: two NEW unsuggested reworks -> newest closed
      // first. Q1 must not reseed here: once suggested, an item never shows
      // again (brief: "never repeats"), whatever its row says now.
      seedOutcomes(dir, [
        rec({ qitemId: Q1, closed: ago(3 * DAY), reopenCount: 1 }), // already suggested
        rec({ qitemId: Q2, closed: ago(1 * DAY), closureReason: "denied" }),
        rec({ qitemId: Q3, destination: SESSION, reopenCount: 1, closed: ago(2 * DAY) }),
      ]);
      const a = await buildInjection({ source: "startup", claudeSessionId: "c3" }, config, deps);
      expect(a).toContain(`${Q2} needed rework (denied)`); // newest closed first
      expect(a).not.toContain(Q3); // only one per digest
      const b = await buildInjection({ source: "startup", claudeSessionId: "c4" }, config, deps);
      expect(b).toContain(`${Q3} needed rework (reopened)`);
      expect(b).not.toContain(Q1); // Q1 is suggested forever, even after reseeding
      const c = await buildInjection({ source: "startup", claudeSessionId: "c5" }, config, deps);
      expect(c).not.toContain("Lesson worth writing?"); // both used up
    } finally {
      await fake.stop();
    }
  });

  test("(c) a rework closed more than 7 days ago is not suggested", async () => {
    const { fake, dir, config, deps } = await setup();
    try {
      seedOutcomes(dir, [rec({ qitemId: Q1, closed: ago(8 * DAY), reopenCount: 1 })]);
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, deps);
      expect(out).not.toContain("Lesson worth writing?");
      const st = readLessonState(dir, WS);
      expect(st === null || st.suggested[Q1] === undefined).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("(d) the record file is 0600 and a rerun does not repeat", async () => {
    const { fake, dir, config, deps } = await setup();
    try {
      seedOutcomes(dir, [rec({ qitemId: Q1, reopenCount: 1 })]);
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, deps);
      expect(out).toContain(Q1);
      const stFile = lessonStatePath(dir, WS);
      expect((statSync(stFile).mode & 0o077) === 0).toBe(true); // 0600
      expect(readLessonState(dir, WS)!.suggested[Q1]).toBeDefined();
      const again = maybeLessonSuggestion(dir, WS, SESSION, SELF, NOW); // local API rerun
      expect(again).toBeUndefined();
      const out2 = await buildInjection({ source: "startup", claudeSessionId: "c2" }, config, deps);
      expect(out2).not.toContain("Lesson worth writing?");
    } finally {
      await fake.stop();
    }
  });

  test("(e) nothing lore-shaped is read or written: paths stay in the state dir", () => {
    // the module touches exactly two local paths, both under stateDir
    const dir = "/state";
    expect(lessonStatePath(dir, WS)).toBe(join(dir, "lesson", "ws.json"));
    expect(lessonStatePath(dir, WS)).not.toContain("lore");
    expect(outcomesFile(dir, WS)).not.toContain("lore");
    // lesson.ts never mentions lore and has no fs calls with a lore path
    const src = readFileSync(join(import.meta.dir, "..", "..", "plugin", "src", "lesson.ts"), "utf8");
    expect(src.includes("lore")).toBe(false);
    expect(/readFileSync\([^)]*lore/.test(src)).toBe(false);
    expect(/writeJsonAtomic\([^)]*lore/.test(src)).toBe(false);
    // the renderer adds no fs import
    const inj = readFileSync(join(import.meta.dir, "..", "..", "plugin", "src", "inject.ts"), "utf8");
    expect(inj.includes('from "node:fs"')).toBe(false);
    expect(inj.includes("readFileSync")).toBe(false);
  });
});
