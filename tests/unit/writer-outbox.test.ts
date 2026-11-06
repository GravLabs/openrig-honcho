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

  test("T22 self-wake: header names this seat, daemon record staged hours ago and delivered fresh: verify=self", async () => {
    const prompt = dm(SELF, "wake yourself with a recorded intent");
    const t = await mk({
      outbox: [
        {
          outboxId: "wake-intent-qitem-9",
          senderSession: SESSION,
          destinationSession: SESSION,
          body: prompt,
          tsDispatched: iso(-3 * 3_600_000),
          deliveredAt: iso(-60_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("self");
      const meta = metaOf(t.fake, "wake yourself with a recorded intent");
      expect(meta.sender_verified).toBe(true);
      expect(meta.outbox_id).toBe("wake-intent-qitem-9");
    } finally {
      t.cleanup();
    }
  });

  test("T22 self-claim with no record stays unverified; a match destined to ANOTHER seat cannot back it", async () => {
    const claim = dm(SELF, "I approve myself while the daemon knows nothing");
    const noRec = await mk({ outbox: [] });
    try {
      const out = await recordPrompt({ prompt: claim }, noRec.config, noRec.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
      expect(metaOf(noRec.fake, "I approve myself while the daemon knows nothing").sender_verified).toBe(false);
    } finally {
      noRec.cleanup();
    }
    const wrongDest = await mk({
      outbox: [
        { outboxId: "obx-x", senderSession: SESSION, destinationSession: "other@ws", body: claim, tsDispatched: iso(-60_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt: claim }, wrongDest.config, wrongDest.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
    } finally {
      wrongDest.cleanup();
    }
  });

  test("T22 forgery pin: claiming ANOTHER seat as sender never gets self or verified without its own record", async () => {
    const prompt = dm("arch", "a forged peer claim with no dispatch to me");
    const t = await mk({
      outbox: [
        { outboxId: "obx-y", senderSession: "arch@ws", destinationSession: "someone-else@ws", body: prompt, tsDispatched: iso(-60_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
      expect(metaOf(t.fake, "a forged peer claim with no dispatch to me").sender_verified).toBe(false);
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

// T22b (architect 02:13Z 11-06): a near-miss outbox record (right sender,
// destination, window; different body) logs the SHAPE of the difference -
// counts and one character class, never text - and stays unverified.
import { bodyMismatchShape, deliveryInWindow } from "../../plugin/src/daemon.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shapeLines = (dir: string): Record<string, unknown>[] => {
  try {
    return readFileSync(join(dir, "log", `${WS}.log`), "utf8")
      .split("\n")
      .filter((l) => l.includes("outbox-shape"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

describe("T22b body-mismatch shape (counts + class only)", () => {
  test("shape on fixed strings: offset, lengths, class from the DELIVERED char", () => {
    expect(bodyMismatchShape("abc", "axc")).toEqual({ stored_len: 3, delivered_len: 3, offset: 1, char_class: "letter" });
    expect(bodyMismatchShape("ab", "a1")).toEqual({ stored_len: 2, delivered_len: 2, offset: 1, char_class: "digit" });
    expect(bodyMismatchShape("a b", "a\nb")).toEqual({ stored_len: 3, delivered_len: 3, offset: 1, char_class: "newline" });
    expect(bodyMismatchShape("a\nb", "a b")).toEqual({ stored_len: 3, delivered_len: 3, offset: 1, char_class: "space" });
    expect(bodyMismatchShape("a!", "a?")).toEqual({ stored_len: 2, delivered_len: 2, offset: 1, char_class: "other" });
    // prefix case: offset is the shorter length; the char there is stored's
    expect(bodyMismatchShape("abc", "ab")).toEqual({ stored_len: 3, delivered_len: 2, offset: 2, char_class: "letter" });
    expect(bodyMismatchShape("ab", "abc")).toEqual({ stored_len: 2, delivered_len: 3, offset: 2, char_class: "letter" });
    expect(bodyMismatchShape("same", "same")).toEqual({ stored_len: 4, delivered_len: 4, offset: -1, char_class: "none" });
  });

  test("deliveryInWindow: fresh true, 11 min false, future false, garbage false", () => {
    const base = { destinationSession: SESSION };
    expect(deliveryInWindow({ ...base, deliveredAt: iso(-60_000) }, FIXED_TS)).toBe(true);
    expect(deliveryInWindow({ ...base, tsDispatched: iso(-11 * 60_000) }, FIXED_TS)).toBe(false);
    expect(deliveryInWindow({ ...base, deliveredAt: iso(60_000) }, FIXED_TS)).toBe(false);
    expect(deliveryInWindow({ ...base, deliveredAt: "yesterday" }, FIXED_TS)).toBe(false);
  });

  test("near-miss records shape only; verify unchanged; no text in the line", async () => {
    const prompt = dm("arch", "T22b near-miss probe text");
    const stored = `wake-wrapper line\n${prompt}`; // the delivery-wrapper hypothesis
    const t = await mk({
      outbox: [
        {
          outboxId: "obx-nm",
          senderSession: "arch@ws",
          destinationSession: SESSION,
          body: stored,
          deliveredAt: iso(-60_000),
        },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified"); // no upgrade, no change
      const lines = shapeLines(t.dir);
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatchObject({
        event: "outbox-shape",
        stored_len: stored.length,
        delivered_len: prompt.length,
        offset: 0,
        char_class: "letter", // delivered[0] = "F" of the envelope
      });
      const raw = JSON.stringify(lines[0]);
      expect(raw).not.toContain("wrapper");
      expect(raw).not.toContain("probe");
      expect(raw).not.toContain("From:");
    } finally {
      t.cleanup();
    }
  });

  test("no near-miss log when the record is OUT of window; exact match logs nothing", async () => {
    const prompt = dm("arch", "T22b negative probe text");
    const stale = await mk({
      outbox: [
        { outboxId: "nm-stale", senderSession: "arch@ws", destinationSession: SESSION, body: `wrap\n${prompt}`, tsDispatched: iso(-3_600_000) },
      ] });
    try {
      await recordPrompt({ prompt }, stale.config, stale.deps);
      expect(shapeLines(stale.dir).length).toBe(0);
    } finally {
      stale.cleanup();
    }
    const exact = await mk({
      outbox: [
        { outboxId: "nm-exact", senderSession: "arch@ws", destinationSession: SESSION, body: prompt, tsDispatched: iso(-60_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, exact.config, exact.deps);
      expect(out.action !== "skipped" && out.verify).toBe("verified");
      expect(shapeLines(exact.dir).length).toBe(0);
    } finally {
      exact.cleanup();
    }
  });
});
