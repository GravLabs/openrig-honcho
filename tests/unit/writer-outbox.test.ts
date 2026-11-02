// T16f: outbox verification (shadow mode) and queue-nudge sender/mission
// from the queue item, end-to-end through recordPrompt against fake-honcho
// + fake-daemon. The mk()/dm() fixtures copy tests/unit/writer.test.ts -
// deps.now is FIXED, so outbox stamps are crafted just before FIXED_TS.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  rmSync  } from "node:fs";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt, type WriterDeps } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { deadDaemonUrl, startFakeDaemon, type FakeDaemon, type FakeDaemonOpts } from "../support/fake-daemon.ts";

const FIXED_TS = "2026-10-28T12:00:00.000Z";
const T0 = Date.parse(FIXED_TS);
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const WS = "ws";
const SELF = "build";
const SESSION = `${SELF}@${WS}`; // config.sessionName (the expected destination)

const mk = async (daemonOpts: FakeDaemonOpts | "none" = "none", configOver: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("writer-outbox-");
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
    ...configOver };
  const deps: WriterDeps = { client, now: () => FIXED_TS };
  const cleanup = () => {
    daemon?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { fake, dir, config, deps, cleanup };
};

const dm = (from: string, body: string) =>
  `From: ${from}@${WS}\nTo: ${SELF}@${WS}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;

const allMsgs = (fake: FakeHoncho): Array<Record<string, unknown>> =>
  [...fake.state.messages.values()].flat();
const metaOf = (fake: FakeHoncho, needle: string): Record<string, unknown> => {
  const m = allMsgs(fake).find((x) => typeof x.content === "string" && x.content.includes(needle));
  if (m === undefined) throw new Error(`no stored message containing "${needle}"`);
  return m.metadata as Record<string, unknown>;
};

describe("outbox verification, shadow mode (T16f / ADR-0012 d2)", () => {
  test("match: verify=verified, sender_verified true + outbox_id on the wire", async () => {
    const prompt = dm("arch", "please rerun the gate");
    const t = await mk({
      outbox: [
        {
          outboxId: "obx-1",
          senderSession: "arch@ws",
          destinationSession: SESSION,
          body: prompt,
          tsDispatched: iso(-60_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(out.action !== "skipped" && out.verify).toBe("verified");
      const meta = metaOf(t.fake, "please rerun the gate");
      expect(meta.sender_verified).toBe(true);
      expect(meta.outbox_id).toBe("obx-1");
    } finally {
      t.cleanup();
    }
  });

  test("daemon answered, no entry matches: unverified, sender_verified false", async () => {
    const prompt = dm("arch", "entry for the unverified case");
    const t = await mk({ outbox: [] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
      const meta = metaOf(t.fake, "entry for the unverified case");
      expect(meta.sender_verified).toBe(false);
      expect("outbox_id" in meta).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("unreachable daemon: unchecked, NO metadata flag, and the write happens", async () => {
    const prompt = dm("arch", "write survives the dead daemon");
    const url = await deadDaemonUrl();
    const t = await mk("none", { daemonUrl: url });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(out.action !== "skipped" && out.verify).toBe("unchecked");
      const meta = metaOf(t.fake, "write survives the dead daemon");
      expect("sender_verified" in meta).toBe(false);
      expect("outbox_id" in meta).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("slow daemon (>1 s): gives up at the budget, unchecked, write still lands", async () => {
    const prompt = dm("arch", "slow daemon must not block the write");
    const t = await mk({ delayMs: 1500 });
    try {
      const t0 = Date.now();
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      const elapsed = Date.now() - t0;
      expect(out.action).toBe("sent");
      expect(out.action !== "skipped" && out.verify).toBe("unchecked");
      metaOf(t.fake, "slow daemon must not block the write");
      expect(elapsed).toBeLessThan(5000); // the 1 s abort, not the 1.5 s reply
    } finally {
      t.cleanup();
    }
  });

  test("trailing whitespace edge: outbox body carries the typed EOL", async () => {
    const prompt = dm("arch", "whitespace tolerance edge");
    const t = await mk({
      outbox: [
        { outboxId: "obx-eol", destinationSession: SESSION, body: `${prompt}  \n`, tsDispatched: iso(-5_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("verified");
      expect(metaOf(t.fake, "whitespace tolerance edge").sender_verified).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("no sessionName: the destination cannot be proven -> unchecked, no flag", async () => {
    const prompt = dm("arch", "cannot prove the destination");
    const t = await mk({ outbox: [] }, { sessionName: undefined });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unchecked");
      expect("sender_verified" in metaOf(t.fake, "cannot prove the destination")).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("no daemonUrl: no lookup attempted - NO verify field at all (baseline guarantee)", async () => {
    const prompt = dm("arch", "baseline fixtures stay byte-equal");
    const t = await mk("none");
    try {
      const out = (await recordPrompt({ prompt }, t.config, t.deps)) as Record<string, unknown>;
      expect(out.action).toBe("sent");
      expect("verify" in out).toBe(false);
      expect("sender_verified" in metaOf(t.fake, "baseline fixtures stay byte-equal")).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe("queue nudges from the queue item (T16f / ADR-0012 d3)", () => {
  const nudge = (from: string, qid: string) =>
    `From: ${from}\nTo: ${SESSION}\n---\nQueue handoff: ${qid} - check your queue.\n---\n↩ Reply: rig send x "..."`;

  test("item fetch ok: sender becomes sourceSession peer, mission tag sets the mission", async () => {
    // From: daemon@kernel is automation-shaped; the item's sourceSession
    // (transport provenance) overrides it to the real peer and the
    // mission:deploy tag moves the seat off general before the write.
    const prompt = nudge("daemon@kernel", "qitem-abc-1");
    const t = await mk({
      item: { sourceSession: "arch-x@ws", tags: ["build", "mission:deploy"] },
      outbox: [
        { outboxId: "wake-1", destinationSession: SESSION, body: prompt, tsDispatched: iso(-5_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(out.action !== "skipped" && out.peer).toBe("arch-x");
      expect(out.action !== "skipped" && out.verify).toBe("verified"); // shadow check still runs
      // Sessions are the RECEIVER's own stream (build--<mission>--n); the
      // overridden sender lands as the stored message's peer_id.
      const keys = [...t.fake.state.messages.keys()];
      expect(keys.some((k) => k.startsWith(`${WS}/build--deploy--`))).toBe(true);
      const msg = allMsgs(t.fake).find((x) => String(x.content).includes("check your queue"));
      expect(msg?.peer_id).toBe("arch-x");
      expect(metaOf(t.fake, "check your queue").kind).toBe("peer");
      const rig = readRigMission(t.dir, WS);
      expect(rig.mission).toBe("deploy");
      expect(rig.set_by).toBe("queue");
    } finally {
      t.cleanup();
    }
  });

  test("item fetch fails (404): the E11 CLI fallback still runs and the sender stays", async () => {
    // The shipped E11 nudge shape (From: daemon@<this rig> -> peer "daemon");
    // the failed daemon fetch leaves today's parsing exactly in place.
    const prompt = nudge(`daemon@${WS}`, "qitem-abc-1");
    const calls: string[][] = [];
    const t = await mk({ itemStatus: 404 });
    t.deps.queueHintRun = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: JSON.stringify({ tags: ["mission:cli-hint"] }) };
    };
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.peer).toBe("daemon");
      expect(calls).toEqual([["rig", "queue", "show", "qitem-abc-1", "--json"]]);
      expect(readRigMission(t.dir, WS).mission).toBe("cli-hint");
      const keys = [...t.fake.state.messages.keys()];
      expect(keys.some((k) => k.startsWith(`${WS}/build--cli-hint--`))).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("already-set mission is not overridden by the item tag", async () => {
    const prompt = nudge(`daemon@${WS}`, "qitem-abc-1");
    const t = await mk({ item: { sourceSession: "arch-x@ws", tags: ["mission:deploy"] } });
    try {
      const { setRigMission } = await import("../../plugin/src/missions.ts");
      await setRigMission(t.dir, WS, "keepme", "tool");
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.peer).toBe("arch-x"); // sender still overrides
      expect(readRigMission(t.dir, WS).mission).toBe("keepme"); // mission untouched
    } finally {
      t.cleanup();
    }
  });
});
