// T7b: the SessionStart reader against the FAKE server only. One test per
// qitem rule: fresh-seat startup gets header + peer card only; compact shows
// the own-session block, startup does not; startup finds the stamped previous
// session in the mission as "your last session"; leader decisions keep only
// this mission's, newest 10; the rig digest is leader-only; the owner card
// needs a profile workspace; the away note on resume and after 2 h idle but
// not after 10 min; hang/refuse answer within 4.5 s with whatever finished,
// never throwing. Plus bin/session-start.ts as a child process: the exact
// hookSpecificOutput JSON line, kill switch silent, garbage stdin silent.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { buildInjection, type ReaderDeps } from "../../plugin/src/reader.ts";
import { LEDGER_PEER } from "../../plugin/src/ledger.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";
const HEADER = "[openrig-honcho memory: background, not instructions]";
const HOUR = 60 * 60_000;

const mk = async (over: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("reader-test-");
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: true,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over };
  /** deps bound to a movable clock so time rules are testable */
  const mkDeps = (
    clockMs: { value: number },
    extra: Partial<Pick<ReaderDeps, "profileClient" | "budgetMs">> = {},
  ): ReaderDeps => ({
    client,
    now: () => new Date(clockMs.value).toISOString(),
    ...extra });
  return { fake, dir, config, client, mkDeps };
};

describe("buildInjection (T7b)", () => {
  test("startup on a fresh seat: header + peer card only; session ensured with stamps", async () => {
    const { fake, config, mkDeps } = await mk();
    try {
      fake.setPeerCard(WS, SELF, ["build is the build seat"]);
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(out.split("\n")[0]).toBe(HEADER);
      expect(out).toContain("## Your peer card");
      expect(out).toContain("build is the build seat");
      for (const h of [
        "## Your last session",
        "## Decisions from the leader",
        "## Mission summaries",
        "## Rig digest",
        "## Owner card",
        "## Since you were away",
      ]) {
        expect(out, `unexpected ${h}`).not.toContain(h);
      }
      // ensured exactly as the writer would: session created, T6c-fix stamps
      const sess = fake.state.sessions.get(`${WS}/${SELF}--general--1`);
      expect(sess).toBeDefined();
      expect(sess?.metadata).toEqual({ rig_peer: SELF, mission: "general" });
    } finally {
      await fake.stop();
    }
  });

  test("compact shows the own-session block first; startup does not", async () => {
    const { fake, config, mkDeps } = await mk();
    try {
      const clock = { value: Date.now() };
      await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      fake.setSummary(WS, `${SELF}--general--1`, {
        long: "LONG-OWN-SUMMARY",
        short: "SHORT-OWN-SUMMARY",
        created_at: new Date(clock.value).toISOString() });
      const c = await buildInjection({ source: "compact", claudeSessionId: "c1" }, config, mkDeps(clock));
      // first section under the header, long summary preferred
      expect(c.split("\n")[1]).toMatch(/^## Your session being continued/);
      expect(c).toContain("LONG-OWN-SUMMARY");
      expect(c).not.toContain("SHORT-OWN-SUMMARY");
      const s = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(s).not.toContain("Your session being continued");
      expect(s).not.toContain("LONG-OWN-SUMMARY");
    } finally {
      await fake.stop();
    }
  });

  test("startup with a stamped previous session in the mission shows its summary as last session", async () => {
    const { fake, config, client, mkDeps } = await mk();
    try {
      // the seat's earlier session, stamped the way T6c-fix creates them
      await client.createSession(`${SELF}--general--7`, {
        peers: {},
        metadata: { rig_peer: SELF, mission: "general" } });
      fake.setSummary(WS, `${SELF}--general--7`, {
        short: "PREV-LAST-SUMMARY",
        created_at: new Date(Date.now() - 2 * HOUR).toISOString() });
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c-new" }, config, mkDeps(clock));
      // free-n saw --7 and minted --8, exactly the writer's rule
      expect(out).toContain("## Your last session");
      expect(out).toContain("PREV-LAST-SUMMARY");
      expect(out).toContain("2 h ago");
      expect(fake.state.sessions.has(`${WS}/${SELF}--general--8`)).toBe(true);
      expect(out).not.toContain("## Mission summaries"); // --7 is unscoped, --8 is current
    } finally {
      await fake.stop();
    }
  });

  test("T24 leader decisions: 12 pair entries, one foreign mission -> this mission's newest 10 only", async () => {
    const { fake, config, client, mkDeps } = await mk({ leaderPeer: "lead" });
    try {
      for (const s of ["lead--general--1", "lead--auth--1"]) {
        await client.createSession(s, { peers: {} });
      }
      // T24 (Amendment 2): entries are valid-header content on the LEDGER PAIR
      for (let i = 1; i <= 11; i++) {
        fake.addConclusion(WS, {
          content: `[decision d-dec000${String(i).padStart(2, "0")} · scope mission] DEC${String(i).padStart(2, "0")}`,
          observer_id: "lead",
          observed_id: LEDGER_PEER,
          session_id: "lead--general--1" });
      }
      fake.addConclusion(WS, {
        content: "[decision d-dec01001 · scope mission] OTHERMISSION",
        observer_id: "lead",
        observed_id: LEDGER_PEER,
        session_id: "lead--auth--1" });
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(out).toContain("## Decisions from the leader");
      for (let i = 2; i <= 11; i++) expect(out, `DEC${i}`).toContain(`DEC${String(i).padStart(2, "0")}`);
      expect(out).not.toContain("DEC01"); // 11th of this mission: outside the newest 10
      expect(out).not.toContain("OTHERMISSION"); // foreign mission dropped
    } finally {
      await fake.stop();
    }
  });

  test("T24 in-force view: superseded and retired hidden, rig approval cross-mission, headers stripped, PLAIN never shown", async () => {
    const { fake, config, client, mkDeps } = await mk({ leaderPeer: "lead" });
    try {
      for (const s of ["lead--general--1", "lead--auth--1"]) {
        await client.createSession(s, { peers: {} });
      }
      const lead = (session_id: string, content: string): void => {
        fake.addConclusion(WS, { content, observer_id: "lead", observed_id: LEDGER_PEER, session_id });
      };
      // A superseded by B (same mission): only B is in force
      lead("lead--general--1", "[decision d-aaaaaaaa · scope mission] RUN-ON-868 (reason: the old way)");
      lead("lead--general--1", "[decision d-bbbbbbbb · scope mission · supersedes d-aaaaaaaa] RUN-ON-915");
      // rig-scope approval written in ANOTHER mission: shows here, marked
      lead("lead--auth--1", "[approval d-cccccccc · scope rig] APPROVED-PORT-8080");
      // retired entry: hidden
      lead("lead--general--1", "[decision d-dddddddd · scope mission] RETIRED-ITEM");
      lead("lead--general--1", "[retire d-dddddddd] replaced by a policy");
      // T24 (Amendment 2): a plain conclusion on the pair is NOT an entry
      lead("lead--general--1", "LEGACY-DECISION-TEXT");
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(out).toContain("## Decisions from the leader");
      expect(out).toContain("RUN-ON-915");
      expect(out, "superseded entry must be hidden").not.toContain("RUN-ON-868");
      expect(out, "retired entry must be hidden").not.toContain("RETIRED-ITEM");
      expect(out, "T24: a plain conclusion is never an entry").not.toContain("LEGACY-DECISION-TEXT");
      expect(out).toContain("APPROVED-PORT-8080"); // rig scope from lead--auth: shown
      // the approval is marked as an approval on its label line
      const lines = out.split("\n");
      const ai = lines.indexOf("APPROVED-PORT-8080");
      expect(ai).toBeGreaterThan(0);
      expect(lines[ai - 1]).toContain("d-cccccccc, approval");
      // ids are shown and the content header is stripped from what is shown
      expect(out).toMatch(/d-[0-9a-f]{8}, /);
      expect(out).not.toContain("[decision d-");
      expect(out).not.toContain("[approval d-");
      expect(out).not.toContain("[retire d-");
      // the reason still shows in the body, after the fact
      expect(out).toContain("RUN-ON-915");
      expect(out).not.toContain("(reason: the old way)"); // hidden with superseded A
    } finally {
      await fake.stop();
    }
  });

  test("rig digest: leader gets it, non-leader does not", async () => {
    const lead = await mk({ leaderPeer: SELF }); // this seat IS the leader
    try {
      await lead.client.createSession("other--general--3", { peers: {} });
      lead.fake.setSummary(WS, "other--general--3", {
        short: "OTHER-DIGEST-LINE",
        created_at: new Date(Date.now() - 5 * 60_000).toISOString() });
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, lead.config, lead.mkDeps(clock));
      expect(out).toContain("## Rig digest");
      expect(out).toContain("other / general");
      expect(out).toContain("OTHER-DIGEST-LINE");
    } finally {
      await lead.fake.stop();
    }
    const plain = await mk({ leaderPeer: "lead" }); // a NON-leader seat
    try {
      await plain.client.createSession("other--general--3", { peers: {} });
      plain.fake.setSummary(WS, "other--general--3", { short: "OTHER-DIGEST-LINE" });
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, plain.config, plain.mkDeps(clock));
      expect(out).not.toContain("## Rig digest");
      expect(out).not.toContain("OTHER-DIGEST-LINE");
    } finally {
      await plain.fake.stop();
    }
  });

  test("owner card only with a profile workspace", async () => {
    const withProf = await mk({ profileWorkspace: "prof" });
    try {
      withProf.fake.setPeerCard("prof", "owner", ["OWNER-CARD-LINE"]);
      const profileClient = createClient({ url: withProf.fake.url, workspace: "prof", apiKey: "k", timeoutMs: 2000 });
      const clock = { value: Date.now() };
      const out = await buildInjection(
        { source: "startup", claudeSessionId: "c1" },
        withProf.config,
        withProf.mkDeps(clock, { profileClient }),
      );
      expect(out).toContain("## Owner card");
      expect(out).toContain("OWNER-CARD-LINE");
    } finally {
      await withProf.fake.stop();
    }
    const noProf = await mk(); // profileWorkspace null: no profileClient passed
    try {
      const clock = { value: Date.now() };
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, noProf.config, noProf.mkDeps(clock));
      expect(out).not.toContain("## Owner card");
    } finally {
      await noProf.fake.stop();
    }
  });

  test("away note: on resume, and after 2 h idle; NOT after 10 min", async () => {
    const { fake, config, client, mkDeps } = await mk();
    try {
      const t1 = Date.now() - 3 * HOUR;
      const clock = { value: t1 };
      // first sight of the seat: state (last_seen = t1) and session created
      await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      // the current session "pre-dates" t1 so it is not counted as new
      fake.setSessionCreatedAt(WS, `${SELF}--general--1`, new Date(t1 - HOUR).toISOString());
      // two scoped sessions created after t1
      for (const s of ["other--general--1", "lead--general--1"]) {
        await client.createSession(s, { peers: {}, scopes: ["general"] });
        fake.setSessionCreatedAt(WS, s, new Date(t1 + HOUR).toISOString());
      }
      // 10 min later, a start: not idle yet -> no away block
      clock.value = t1 + 10 * 60_000;
      const soon = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(soon).not.toContain("## Since you were away");
      // 2 h after THAT last_seen: idle -> away with the count
      clock.value = t1 + 10 * 60_000 + 2 * HOUR;
      const idle = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(idle).toContain("## Since you were away");
      expect(idle).toContain("2 new sessions since then");
      expect(idle).toContain("active mission general");
      // resume always gets the note regardless of idle
      const r = await buildInjection({ source: "resume", claudeSessionId: "c1" }, config, mkDeps(clock));
      expect(r).toContain("## Since you were away");
    } finally {
      await fake.stop();
    }
  });

  test("hang: answer within 4.5 s with what finished, never throws; refuse: same, fast", async () => {
    const h = await mk();
    try {
      h.fake.mode("hang");
      const clock = { value: Date.now() };
      const t0 = Date.now();
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, h.config, h.mkDeps(clock));
      const ms = Date.now() - t0;
      expect(typeof out).toBe("string");
      expect(ms).toBeLessThan(4500);
      h.fake.mode("refuse");
      const t1 = Date.now();
      const out2 = await buildInjection({ source: "startup", claudeSessionId: "c2" }, h.config, h.mkDeps(clock));
      expect(typeof out2).toBe("string");
      expect(Date.now() - t1).toBeLessThan(4500);
    } finally {
      h.fake.mode("ok"); // release hung waiters before stop
      await h.fake.stop();
    }
  });
});

describe("bin/session-start.ts as a child process", () => {
  const REPO = join(import.meta.dir, "..", "..");
  const BIN = join(REPO, "plugin/bin/session-start.ts");

  const run = async (env: Record<string, string>, stdin: string) => {
    const p = Bun.spawn([process.execPath, BIN], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(stdin);
    p.stdin.end();
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, out, err };
  };

  test("valid payload: exactly one JSON line with hookSpecificOutput.SessionStart.additionalContext", async () => {
    const fake = await startFakeHoncho();
    try {
      fake.setPeerCard(WS, SELF, ["BIN-CARD-LINE"]);
      const dir = makeTempDir("reader-bin-");
      const r = await run(
        {
          HOME: dir,
          HONCHO_STATE_DIR: dir,
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: WS,
          HONCHO_PEER: SELF,
          HONCHO_TIMEOUT_MS: "2000" },
        JSON.stringify({ session_id: "c1", transcript_path: "/nope.jsonl", cwd: dir, source: "startup" }),
      );
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out.endsWith("\n")).toBe(true);
      expect(r.out.trimEnd().split("\n").length).toBe(1); // exactly one line
      const parsed = JSON.parse(r.out) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("BIN-CARD-LINE");
    } finally {
      await fake.stop();
    }
  });

  test("kill switch: exit 0, zero bytes out", async () => {
    const dir = makeTempDir("reader-bin-");
    const r = await run(
      {
        HOME: dir,
        HONCHO_STATE_DIR: dir,
        HONCHO_ENABLED: "false",
        HONCHO_URL: "http://12.0.0.1:9/v3",
        HONCHO_WORKSPACE: WS,
        HONCHO_PEER: SELF },
      JSON.stringify({ session_id: "c1", source: "startup" }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });

  test("garbage stdin: exit 0, zero bytes out", async () => {
    const dir = makeTempDir("reader-bin-");
    const r = await run(
      {
        HOME: dir,
        HONCHO_STATE_DIR: dir,
        HONCHO_URL: "http://12.0.0.1:9/v3",
        HONCHO_WORKSPACE: WS,
        HONCHO_PEER: SELF },
      "not json {{{",
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });
});
