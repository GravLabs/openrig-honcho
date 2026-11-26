// ADR-0021 decision 3 (v0.5.12, row B3): notifyStaleProposals posts ONE
// queue row through the allowlisted runner - ids and ages only, never memory
// text - and records the named ids in `notified` so the next day is quiet.
// Everything runs with an injected fake runner and temp state dirs: no real
// rig, no real model, no real server.
import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import type { Conclusion } from "../../plugin/src/honcho.ts";
import { LEDGER_PEER, formatEntry } from "../../plugin/src/ledger.ts";
import {
  NOTIFIED_MAX,
  notifyStaleProposals,
  readStaleState,
  staleStatePath,
  writeStaleState,
  type StaleState,
} from "../../plugin/src/stale.ts";
import { makeTempDir } from "../support/tempdir.ts";

const WS = "ws";
const SELF = "build";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

// ledger ids: d- + 8 HEX (the grammar parseEntry enforces)
const O1 = "d-bbbb0001"; // old decision, in force -> the pending proposal
const O2 = "d-bbbb0002"; // second old decision (new-proposal test)
const N1 = "d-bbbb0003"; // the new status

const mkConfig = (stateDir: string): Config => ({
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
} as Config);

const concl = (id: string, kind: "decision" | "status", fact: string, atMs: number): Conclusion => ({
  id: `concl-${id}`,
  content: formatEntry({ kind, id, scope: "mission", fact }),
  observer_id: SELF,
  observed_id: LEDGER_PEER,
  created_at: ago(atMs),
});

// O1 and O2 are in force (nothing supersedes them); N1 is the newest entry.
const ITEMS: Conclusion[] = [
  concl(O1, "decision", "alfa: ship v1 from tag a1b2c3", 300 * DAY),
  concl(O2, "decision", "bravo: keep the old parser", 200 * DAY),
  concl(N1, "status", "delta: main moved to v2", 1 * HOUR),
];

const proposal = (oldId: string, why: string, oldDays: number): StaleState["proposals"][number] => ({
  oldId,
  newId: N1,
  why,
  oldAt: ago(oldDays * DAY),
  at: ago(2 * HOUR),
  shown: 0,
});

const seed = (dir: string, st: StaleState): void => {
  writeStaleState(dir, WS, st);
};

interface Call {
  cmd: string;
  args: string[];
  t: number;
  body: string; // what the body file held at call time
}

/** A fake runner that records the call and reads the body file it was given. */
const fakeRunner = (code = 0): { calls: Call[]; run: (c: string, a: string[], t: number) => Promise<{ code: number; stdout: string }> } => {
  const calls: Call[] = [];
  return {
    calls,
    run: async (cmd, args, t) => {
      // resolve the body path by flag, not by index: the create argv gained
      // --source after --destination (timer probe), so fixed indices drift
      calls.push({ cmd, args, t, body: readFileSync(args[args.indexOf("--body-file") + 1], "utf8") });
      return { code, stdout: "{}" };
    },
  };
};

describe("notifyStaleProposals (ADR-0021 d3)", () => {
  test("posts one row for fresh pending ids; ids+ages only, never fact text", async () => {
    const dir = makeTempDir("sn-post-");
    seed(dir, {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [proposal(O1, "the version fact was replaced", 300)],
    });
    const f = fakeRunner();
    const r = await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rigx", { run: f.run });
    expect(r).toBe("posted");
    expect(f.calls.length).toBe(1);
    const c = f.calls[0];
    expect(c.cmd).toBe("rig");
    expect(c.args.slice(0, 4)).toEqual(["queue", "create", "--destination", "lead@rigx"]);
    expect(c.args.slice(4, 6)).toEqual(["--source", "stale-check@rigx"]);
    expect(c.args).toContain("--tags");
    expect(c.args[c.args.indexOf("--tags") + 1]).toBe("openrig-honcho,stale-review");
    expect(c.args[c.args.indexOf("--summary") + 1]).toBe(
      "Stale review: 1 ledger entries may be out of date - run stale_review",
    );
    // the body: id + age + the fixed ask, and NOT a word of memory content
    expect(c.body).toContain(O1);
    expect(c.body).toContain("days");
    expect(c.body).toContain(
      "Open stale_review on your seat; keep or retire each. Proposed by the daily stale check (openrig-honcho).",
    );
    expect(c.body).not.toContain("alfa"); // no fact text
    expect(c.body).not.toContain("replaced"); // no why text
    // the body file is gone and the ids are recorded
    expect(existsSync(join(dir, "stale", `${WS}.notify.txt`))).toBe(false);
    expect(readStaleState(dir, WS)?.notified).toEqual([O1]);
  });

  test("the second run posts nothing: the same ids were already named", async () => {
    const dir = makeTempDir("sn-quiet-");
    seed(dir, {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [proposal(O1, "was replaced", 300)],
      notified: [O1],
    });
    const f = fakeRunner();
    expect(await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rigx", { run: f.run })).toBe("none");
    expect(f.calls.length).toBe(0);
  });

  test("a NEW pending id posts again; notified grows and caps oldest-first", async () => {
    const dir = makeTempDir("sn-new-");
    const old = Array.from({ length: NOTIFIED_MAX }, (_, i) => `d-${(i + 1).toString(16).padStart(8, "0")}`);
    seed(dir, {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [proposal(O1, "was replaced", 300), proposal(O2, "parser swapped", 200)],
      notified: [...old.slice(1), O1], // O1 already named, O2 fresh; already at the cap
    });
    const f = fakeRunner();
    expect(await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rigx", { run: f.run })).toBe("posted");
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].body).toContain(O2);
    expect(f.calls[0].body).not.toContain(O1);
    const st = readStaleState(dir, WS);
    expect(st?.notified?.length).toBe(NOTIFIED_MAX); // cap holds
    expect(st?.notified?.includes(old[0])).toBe(false); // oldest dropped
    expect(st?.notified?.includes(O2)).toBe(true);
  });

  test("a failed post: 'failed', the runner saw the row, notified untouched", async () => {
    const dir = makeTempDir("sn-fail-");
    seed(dir, {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [proposal(O1, "was replaced", 300)],
    });
    const f = fakeRunner(1); // rig exits non-zero
    expect(await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rigx", { run: f.run })).toBe("failed");
    expect(f.calls.length).toBe(1);
    const st = readStaleState(dir, WS);
    expect(st?.notified).toBeUndefined();
    expect(existsSync(join(dir, "stale", `${WS}.notify.txt`))).toBe(false); // body cleaned either way
  });

  test("a bad session never reaches the runner: 'failed' with zero calls", async () => {
    const dir = makeTempDir("sn-badsess-");
    seed(dir, {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [proposal(O1, "was replaced", 300)],
    });
    const f = fakeRunner();
    expect(await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rig; rm", { run: f.run })).toBe("failed");
    expect(f.calls.length).toBe(0);
  });

  test("no state file at all: 'none', runner untouched", async () => {
    const dir = makeTempDir("sn-nostate-");
    const f = fakeRunner();
    expect(await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rigx", { run: f.run })).toBe("none");
    expect(f.calls.length).toBe(0);
  });

  test("readStaleState tolerates unknown fields and keeps notified (older-plugin file)", () => {
    const dir = makeTempDir("sn-tolerate-");
    writeStaleState(dir, WS, { version: 1, classes: {}, lastCheckedAt: null, proposals: [] });
    const raw = JSON.parse(readFileSync(staleStatePath(dir, WS), "utf8")) as Record<string, unknown>;
    raw.fromTheFuture = { any: "shape" }; // a field this plugin does not know
    raw.notified = [O1, O1, "not-an-id", O2];
    writeFileSync(staleStatePath(dir, WS), JSON.stringify(raw));
    const st = readStaleState(dir, WS);
    expect(st).not.toBeNull();
    expect(st?.notified).toEqual([O1, O2]); // deduped, grammar-filtered
  });

  // F-D24 (R25 recheck, probe G G11): the body write must never go THROUGH a
  // planted link at the body path. It lands on a unique temp name and renames
  // over the path, so the link ENTRY is replaced and the target keeps its
  // bytes. Precondition: write access inside the 0700 state dir, same as F-C.
  const plantTest = async (kind: "symlink" | "hardlink"): Promise<void> => {
    const dir = makeTempDir(`sn-fd24-${kind}-`);
    const victim = join(makeTempDir("sn-fd24-out-"), "victim.txt");
    writeFileSync(victim, "PRECIOUS-BEFORE\n");
    seed(dir, {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [proposal(O1, "the version fact was replaced", 300)],
    });
    const bodyPath = join(dir, "stale", `${WS}.notify.txt`);
    mkdirSync(join(dir, "stale"), { recursive: true }); // seed made it; be explicit
    if (kind === "symlink") symlinkSync(victim, bodyPath);
    else linkSync(victim, bodyPath);
    const f = fakeRunner();
    const r = await notifyStaleProposals(mkConfig(dir), ITEMS, "lead@rigx", { run: f.run });
    // the rename left OUR regular 0600 file at the path, so the post runs
    expect(r, "the body is a regular file now: createQueueRow accepts it").toBe("posted");
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].body).toContain(O1); // the runner saw OUR notify body
    expect(readFileSync(victim, "utf8")).toBe("PRECIOUS-BEFORE\n"); // victim untouched
    expect(existsSync(bodyPath)).toBe(false); // removed after the post, link entry included
  };

  test("F-D24 (R25): a planted SYMLINK at the body path is replaced, not written through", async () => {
    await plantTest("symlink");
  });

  test("F-D24 (R25): a planted HARD LINK keeps the other name bytes untouched", async () => {
    await plantTest("hardlink");
  });
});
