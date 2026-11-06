// T21 (row qitem-20261105012942-47aee00af4eb2bc7): routine coordination
// messages are stored but skip the deriver (ADR-0005 E5b). Unit coverage per
// the row: a >=40-message table (routine vs fact-carrying look-alikes), both
// directions (incoming prompt / own reply), HONCHO_SKIP_ROUTINE=off byte-
// identical (no configuration on the wire, exactly today's shape), and the
// routine: 1 log field. Local tmp dirs + 127.0.0.1 fake only.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { logEvent } from "../../plugin/src/log.ts";
import { isRoutine, reasoningFor } from "../../plugin/src/shape.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import { recordReply } from "../../plugin/src/stop.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const FIXED_NOW = () => "2026-11-05T12:00:00.000Z";

const mk = async (over: Partial<Config> = {}) => {
  const fake = await startFakeHoncho();
  const dir = makeTempDir("routine-");
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: "build",
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: true,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over,
  };
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  return {
    fake,
    dir,
    config,
    deps: { client, now: FIXED_NOW },
    cleanup: () => {
      void fake.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const stored = (fake: FakeHoncho, session: string) => fake.state.messages.get(`${WS}/${session}`) ?? [];
type Msg = { content: string; configuration?: { reasoning?: { enabled?: boolean } } };

// ---------- the table (row: at least 40 messages, both classes) ----------

const ROUTINE: string[] = [
  "standing by",
  "Standing by.",
  "on it",
  "On it!",
  "claimed",
  "qitem-20261105010929-f05f4205927dfd14 claimed",
  "T20 picked up",
  "T20-extended picked up",
  "starting now",
  "still working",
  "still running",
  "no change",
  "nothing to report",
  "will report",
  "will report later",
  "reporting soon",
  "received",
  "acknowledged",
  "ok",
  "got it",
  "understood",
  "awaiting review",
  "waiting for the architect",
  "T19b on it - standing by",
  "will do it",
  "will handle it, awaiting the owner verdict",
];

const KEEP: string[] = [
  "review found 3 issues", // a finding
  "tests 1417/0", // a result with numbers
  "approved", // a decision (E5 keeps it too; routine must not claim it)
  "use CSV, not JSON", // a decision
  "failed: contract suite red", // a finding
  "6b0a1a4 PASS", // a sha + verdict
  "standing by, blocked on the 3.5.0 upgrade", // routine shape + a version number
  "waiting for the T19 review result", // routine shape naming a RESULT
  "the gate timed out", // a result
  "auth bug is not done", // the E5 look-alike
  "T20 needs a third arm", // a decision
  "done", // E5 ack territory - NOT routine vocabulary
  "ok, but the fixture needs a hint file", // ack opening + a decision
  "no change to the design", // routine opening + substance
  "nothing to report - 3 findings", // routine opening + a number
  "standing by " + "standing by ".repeat(30), // >= 300 chars
  "I am on it", // outside the strict allow-list (bias toward keeping)
  "ack the row", // "ack" as a verb, then substance
  "understood, will proceed", // carries an intended action
];

describe("T21 E5b routine table", () => {
  test(`routine messages match (${ROUTINE.length})`, () => {
    for (const t of ROUTINE) expect([t, isRoutine(t)]).toEqual([t, true]);
  });
  test(`fact-carrying look-alikes do NOT match (${KEEP.length})`, () => {
    for (const t of KEEP) expect([t, isRoutine(t)]).toEqual([t, false]);
  });
  test("table size and class balance (row: at least 40, about half/half)", () => {
    expect(ROUTINE.length + KEEP.length).toBeGreaterThanOrEqual(40);
    expect(Math.abs(ROUTINE.length - KEEP.length)).toBeLessThanOrEqual(10);
  });
});

describe("T21 E5b reasoningFor", () => {
  const base = { selfPeer: "build", senderPeer: "other" };
  test("dm + routine: on suppresses, off keeps (both directions use dm)", () => {
    const i = (skipRoutine: boolean) => ({ ...base, kind: "dm" as const, to: [], skipRoutine, content: "awaiting review" });
    expect(reasoningFor(i(true))).toBe(false);
    expect(reasoningFor(i(false))).toBe(true);
  });
  test("off is byte-identical for EVERY table message (the E5-only rule decides alone)", () => {
    for (const t of [...ROUTINE, ...KEEP]) {
      expect(
        reasoningFor({ ...base, kind: "dm", to: [], skipRoutine: false, content: t }),
      ).toBe(reasoningFor({ ...base, kind: "dm", to: [], content: t }));
    }
  });
  test("broadcast leader copy + routine: on suppresses, off keeps", () => {
    const i = (skipRoutine: boolean) => ({
      selfPeer: "build",
      senderPeer: "other",
      leaderPeer: "build",
      kind: "broadcast" as const,
      to: [] as string[],
      skipRoutine,
      content: "on it",
    });
    expect(reasoningFor(i(true))).toBe(false);
    expect(reasoningFor(i(false))).toBe(true);
  });
});

describe("T21 E5b on the wire", () => {
  test("own reply (stop path): routine stored with reasoning off; routine:true on the outcome", async () => {
    const t = await mk({ skipRoutine: true });
    try {
      const out = await recordReply({ last_assistant_message: "awaiting review" }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect("routine" in out && out.routine).toBe(true);
      const m = stored(t.fake, "build--general--1")[0] as Msg;
      expect(m.content).toBe("awaiting review"); // still stored
      expect(m.configuration?.reasoning?.enabled).toBe(false);
    } finally { t.cleanup(); }
  });

  test("incoming prompt (user-prompt path): routine stored with reasoning off", async () => {
    const t = await mk({ skipRoutine: true });
    try {
      const out = await recordPrompt({ prompt: "On it.", claudeSessionId: "s1" }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect("routine" in out && out.routine).toBe(true);
      const msgs = stored(t.fake, "build--general--1") as Msg[];
      expect(msgs.some((m) => m.content === "On it." && m.configuration?.reasoning?.enabled === false)).toBe(true);
    } finally { t.cleanup(); }
  });

  test("off: byte-identical to today - no configuration field on routine text", async () => {
    const t = await mk({ skipRoutine: false });
    try {
      const out = await recordReply({ last_assistant_message: "awaiting review" }, t.config, t.deps);
      expect("routine" in out).toBe(false);
      const m = stored(t.fake, "build--general--1")[0] as Msg;
      expect(m.configuration).toBeUndefined(); // wire shape == pre-T21
    } finally { t.cleanup(); }
  });

  test("a fact-carrying reply keeps the deriver with the switch ON", async () => {
    const t = await mk({ skipRoutine: true });
    try {
      const out = await recordReply({ last_assistant_message: "review found 3 issues" }, t.config, t.deps);
      expect("routine" in out).toBe(false);
      const m = stored(t.fake, "build--general--1")[0] as Msg;
      expect(m.configuration).toBeUndefined();
    } finally { t.cleanup(); }
  });
});

describe("T21 E5b log field", () => {
  test("routine: 1 lands on the event line through the whitelist; absent otherwise", () => {
    const dir = makeTempDir("routine-log-");
    try {
      const target = { stateDir: dir, workspace: WS, peer: "build" };
      logEvent(target, { hook: "user-prompt", event: "sent", ok: true, ms: 3, session: "build--general--1", n_msgs: 1, routine: 1 });
      logEvent(target, { hook: "stop", event: "sent", ok: true, ms: 3, session: "build--general--1", n_msgs: 1 });
      const lines = readFileSync(join(dir, "log", `${WS}.log`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines[0].routine).toBe(1);
      expect("routine" in lines[1]).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
