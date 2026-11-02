// T16j (architect brief 2026-11-01): build-owned tests for the nudge sender
// gate and the mission-tag secret refusal. The review battery
// (tests/unit/review-v022.test.ts) is review-owned and pins VF1/VF1b/VF2a;
// this file adds the brief's explicit obvious-fake case
// (mission:ghp_FAKEFAKEFAKE), the gate's POSITIVE controls (a real daemon
// nudge must still move the sender and select the mission - the gate must
// not over-close), and the E11 fallback's refusal.
//
// OFFLINE ONLY: fake honcho / fake daemon / makeTempDir at test-body scope
// (the T16i rule: never inside a beforeAll). The footer char is the \u21a9
// escape, never a raw invisible (source discipline).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { missionIdIsSecretShaped, readRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt, type WriterDeps } from "../../plugin/src/writer.ts";
import { redact } from "../../plugin/src/redact.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { startFakeDaemon, type FakeDaemon, type FakeDaemonOpts } from "../support/fake-daemon.ts";

const FIXED_TS = "2026-10-28T12:00:00.000Z";
const WS = "ws";
const SELF = "build";
const SESSION = `${SELF}@${WS}`;
const FOOTER = "\u21a9 Reply: rig send x \"...\""; // the visible footer char, escaped

const mk = async (daemonOpts: FakeDaemonOpts | "none" = "none", depsOver: Partial<WriterDeps> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("t16jw-");
  let daemon: FakeDaemon | undefined;
  const daemonUrl = daemonOpts === "none" ? undefined : (daemon = await startFakeDaemon(daemonOpts)).url;
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
    ...(daemonUrl !== undefined ? { daemonUrl } : {}),
    sessionName: SESSION,
  };
  const deps: WriterDeps = { client, now: () => FIXED_TS, ...depsOver };
  return {
    fake,
    dir,
    config,
    deps,
    cleanup: () => {
      daemon?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

// A real daemon nudge arrives From: daemon@<this rig> (VF1b's fixture).
const nudge = (qid: string) =>
  `From: daemon@${WS}\nTo: ${SELF}@${WS}\n---\nQueue handoff: ${qid} - check your queue.\n---\n${FOOTER}`;

// The kernel daemon nudging this rig: From: daemon@kernel (isOpenRigSender).
const nudgeKernel = (qid: string) =>
  `From: daemon@kernel\nTo: ${SELF}@${WS}\n---\nQueue handoff: ${qid} - check your queue.\n---\n${FOOTER}`;

// A peer envelope carrying the same body - the forged shape (VF1).
const peerBody = (from: string, qid: string) =>
  `From: ${from}@${WS}\nTo: ${SELF}@${WS}\n---\nQueue handoff: ${qid} - check your queue. (forwarding for context)\n---\n${FOOTER}`;

const storedMsg = (fake: FakeHoncho, needle: string): Record<string, unknown> => {
  const all = [...fake.state.messages.values()].flat();
  const m = all.find((x) => typeof x.content === "string" && x.content.includes(needle));
  if (m === undefined) throw new Error(`no stored message containing "${needle}"`);
  return m;
};

const logTextOf = (dir: string): string => {
  const file = join(dir, "log", `${WS}.log`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

describe("T16j gate: only a daemon envelope moves the sender or selects the mission", () => {
  test("positive control: a real daemon@<this-rig> nudge still takes the item's same-rig source as sender", async () => {
    const t = await mk({ item: { sourceSession: "arch-x@ws", tags: [] } });
    try {
      const out = await recordPrompt({ prompt: nudge("qitem-pos-1") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(storedMsg(t.fake, "qitem-pos-1").peer_id).toBe("arch-x");
    } finally {
      t.cleanup();
    }
  });

  test("positive control: a daemon@kernel nudge (automation classification) also takes the item source", async () => {
    const t = await mk({ item: { sourceSession: "arch-x@ws", tags: [] } });
    try {
      const out = await recordPrompt({ prompt: nudgeKernel("qitem-pos-2") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(storedMsg(t.fake, "qitem-pos-2").peer_id).toBe("arch-x");
    } finally {
      t.cleanup();
    }
  });

  test("a peer-typed nudge body does not select the mission from the item's tag (gate, not any body)", async () => {
    const t = await mk({ item: { sourceSession: "arch-x@ws", tags: ["mission:t16j-flow"] } });
    try {
      const out = await recordPrompt({ prompt: peerBody("dev-x", "qitem-tag-gate-1") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(readRigMission(t.dir, WS).mission).toBe("general");
    } finally {
      t.cleanup();
    }
  });

  test("positive control: a clean mission tag on a real daemon nudge still selects the mission", async () => {
    const t = await mk({ item: { sourceSession: "arch-x@ws", tags: ["mission:t16j-flow"] } });
    try {
      const out = await recordPrompt({ prompt: nudge("qitem-tag-pos-1") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(readRigMission(t.dir, WS).mission).toBe("t16j-flow");
    } finally {
      t.cleanup();
    }
  });
});

describe("T16j mission-tag secret refusal (the brief's obvious fake, both paths)", () => {
  test("mission:ghp_FAKEFAKEFAKE on a fetched item is refused: mission unchanged, refusal logged, value nowhere", async () => {
    const fake = "ghp_FAKEFAKEFAKE";
    const t = await mk({ item: { sourceSession: "arch-x@ws", tags: [`mission:${fake}`] } });
    try {
      const out = await recordPrompt({ prompt: nudge("qitem-fake-1") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(readRigMission(t.dir, WS).mission).toBe("general");
      // the refusal is logged as the reason class, not the value
      const logText = logTextOf(t.dir);
      expect(logText).toContain('"event":"refused"');
      expect(logText).toContain('"error_class":"refused"');
      expect(logText.toLowerCase()).not.toContain("ghp_fakefakefake");
      // and the fake reaches no session key
      const keys = [...t.fake.state.messages.keys()];
      expect(keys.some((k) => k.toLowerCase().includes("fakefakefake"))).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("the E11 fallback (rig queue show) refuses the same shape: no hint, mission stays general", async () => {
    const calls: string[][] = [];
    const t = await mk("none", {
      queueHintRun: async (_cmd: string, args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: JSON.stringify({ tags: ["mission:ghp_FAKEFAKEFAKE"] }) };
      },
    });
    try {
      // no daemonUrl: the writer's fetch cannot answer, so the E11 CLI
      // fallback runs on the peer-envelope handoff body (today's path).
      const out = await recordPrompt({ prompt: peerBody("dev-x", "qitem-fake-2") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(calls.length).toBe(1); // the hint really ran
      expect(readRigMission(t.dir, WS).mission).toBe("general");
    } finally {
      t.cleanup();
    }
  });

  test("control: the E11 fallback still applies a clean tag", async () => {
    const t = await mk("none", {
      queueHintRun: async () => ({ code: 0, stdout: JSON.stringify({ tags: ["mission:t16j-e11"] }) }),
    });
    try {
      const out = await recordPrompt({ prompt: peerBody("dev-x", "qitem-fake-3") }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(readRigMission(t.dir, WS).mission).toBe("t16j-e11");
    } finally {
      t.cleanup();
    }
  });
});

describe("T16m mission-id predicate at the slug/secret boundary", () => {
  test("F-R1: an ordinary mixed-case multi-word slug (48 chars) is not refused", () => {
    expect(missionIdIsSecretShaped("Migrate-User-Profile-Store-to-Sqlite-Phase2-2026")).toBe(false); // fake-secret
  });

  test("F-R1: a 45-char unbroken mixed run is still refused", () => {
    const run = "AbCdEf0123456789GhIjKlMnOpQrStUvWx2026YzAbCdE"; // fake-secret
    expect(run.length).toBe(45);
    expect(missionIdIsSecretShaped(run)).toBe(true);
  });

  test("Observation 3: the AWS access key id shape is refused (AKIA + 16)", () => {
    // fake-secret (documented AWS example id)
    expect(missionIdIsSecretShaped("AKIA" + "IOSFODNN" + "7EXAMPLE")).toBe(true);
  });
});

describe("T16j device-code dashed form: masked and kept shapes", () => {
  test("masked: upper 4-4 with letters AND digits near device-login words", () => {
    const a = redact("devicelogin told me to enter ABCD-1234 now");
    expect(a.counts["device-code"]).toBe(1);
    expect(a.text).not.toContain("ABCD-1234");
    const b = redact("the device code is WXYZ-9QAB on the screen");
    expect(b.counts["device-code"]).toBe(1);
    expect(b.text).not.toContain("WXYZ-9QAB");
    // idempotent: a second pass changes nothing
    const twice = redact(a.text);
    expect(twice.counts["device-code"]).toBeUndefined();
    expect(twice.text).toBe(a.text);
  });

  test("kept: all-letter and all-digit dashed runs, lowercase dashed, and dashed far from context", () => {
    const letters = redact("devicelogin shows ABCD-EFGH for the flow");
    expect(letters.counts["device-code"]).toBeUndefined();
    expect(letters.text).toContain("ABCD-EFGH");
    const digits = redact("devicelogin shows 1234-5678 which is all digits");
    expect(digits.counts["device-code"]).toBeUndefined();
    expect(digits.text).toContain("1234-5678");
    const lower = redact("devicelogin shows abcd-1234 as typed lowercase");
    expect(lower.counts["device-code"]).toBeUndefined();
    expect(lower.text).toContain("abcd-1234");
    const far = `devicelogin ${"x".repeat(250)} ABCD-1234 done`;
    const f = redact(far);
    expect(f.counts["device-code"]).toBeUndefined();
    expect(f.text).toContain("ABCD-1234");
  });
});
