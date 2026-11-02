// T16i+T16j recheck probe (review seat, pin de8c72f, OFFLINE ONLY - every
// byte here stays against fake-honcho / fake-daemon / temp dirs; no real
// server, no scratch workspaces touched).
//
// Purpose: after the T16j gate (writer.ts envelopeFromDaemon), re-attempt
// every sender/mission move the recheck brief lists, and probe the new
// secret-shaped mission predicate at both edges. Polarity follows
// tests/unit/review-v022.test.ts:
//   FINDING     - asserts the SAFE behaviour; green while the gate holds,
//                 red names a live defect.
//   OBSERVATION - pins the CURRENT behaviour for the architect to rule on;
//                 flips red when a ruling changes it.
// Fixture shape copied from the committed battery (writer-outbox style).
// No raw invisible characters: the envelope footer is an \u21a9 escape.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { rmSync } from "node:fs";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { missionIdIsSecretShaped, readRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt, type WriterDeps } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { startFakeDaemon, type FakeDaemon, type FakeDaemonOpts } from "../support/fake-daemon.ts";

const FIXED_TS = "2026-10-28T12:00:00.000Z";
const WS = "ws";
const SELF = "build";
const SESSION = `${SELF}@${WS}`;
const FOOTER = "\u21a9 Reply: rig send x \"...\""; // the visible footer char, escaped

const mkW = async (daemonOpts: FakeDaemonOpts | "none" = "none", configOver: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("rc02p-");
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
    ...configOver,
  };
  const deps: WriterDeps = { client, now: () => FIXED_TS };
  const cleanup = () => {
    daemon?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { fake, dir, config, deps, cleanup };
};

// env(fromAddress, body): full From control - fromAddress is used verbatim,
// so cross-rig and system:* forms are exact.
const env = (fromAddress: string, body: string) =>
  `From: ${fromAddress}\nTo: ${SELF}@${WS}\n---\n${body}\n---\n${FOOTER}`;
const nudgeBody = (qid: string) => `Queue handoff: ${qid} - check your queue.`;

const allMsgs = (fake: FakeHoncho): Array<Record<string, unknown>> =>
  [...fake.state.messages.values()].flat();
const msgOf = (fake: FakeHoncho, needle: string): Record<string, unknown> => {
  const m = allMsgs(fake).find((x) => typeof x.content === "string" && x.content.includes(needle));
  if (m === undefined) throw new Error(`no stored message containing "${needle}"`);
  return m;
};
const metaOf = (fake: FakeHoncho, needle: string): Record<string, unknown> =>
  msgOf(fake, needle).metadata as Record<string, unknown>;

// ===========================================================================
describe("RK nudge gate at de8c72f: re-attempting every brief-listed move", () => {
  test(
    "RK1 FINDING: a foreign-rig daemon envelope (From: daemon@other-rig) moves nothing",
    async () => {
      // classifyEnvelopeSender("daemon@other-rig") is NOT isOpenRigSender:
      // it lands as the cross-rig peer "daemon_other-rig" (sameRig false),
      // so envelopeFromDaemon is false - the fetch runs but neither the
      // sender override nor the mission tag may fire.
      const prompt = env("daemon@other-rig", nudgeBody("qitem-rk1"));
      const t = await mkW({ item: { sourceSession: "arch-x@ws", tags: ["mission:deploy"] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        expect(msgOf(t.fake, "qitem-rk1").peer_id).toBe("daemon_other-rig");
        expect(readRigMission(t.dir, WS).mission).toBe("general");
      } finally {
        t.cleanup();
      }
    },
  );

  test(
    "RK2 OBSERVATION: a typed From: system:x nudge OPENS the gate (automation family) - sender moves, mission sets, only trace is sender_verified=false",
    async () => {
      // isOpenRigSender covers EVERY system:* form, and T16j deliberately
      // lets kind "automation" open envelopeFromDaemon (writer.ts comment:
      // "daemon@kernel and system:* arrive as kind automation"). A peer who
      // types this header plus a real nudge line therefore re-attributes
      // their message to the item sourceSession and sets the rig mission.
      // Two live caveats for the ruling: (a) this path only records at all
      // when HONCHO_RECORD_AUTOMATION=true - the same switch the
      // legitimate daemon@kernel nudges need; (b) the override rewrites
      // eff.kind to "peer", so the verify block DOES run and an empty
      // outbox stamps the write sender_verified:false - the forgery leaves
      // a shadow flag, it is not silent.
      const prompt = env("system:x", nudgeBody("qitem-rk2"));
      const t = await mkW({ item: { sourceSession: "arch-x@ws", tags: ["mission:deploy"] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        expect(msgOf(t.fake, "qitem-rk2").peer_id).toBe("arch-x");
        expect(metaOf(t.fake, "qitem-rk2").sender_verified).toBe(false);
        expect(readRigMission(t.dir, WS).mission).toBe("deploy");
      } finally {
        t.cleanup();
      }
    },
  );

  test(
    "RK3 FINDING: a nudge quoted mid-message is not a nudge - dev-x keeps its sender and general",
    async () => {
      // NUDGE_RE is ^-anchored (nudge.ts:21), so the qid never parses from
      // the middle of a body; no fetch, no gate, and the E11 CLI fallback
      // keys on the same anchored regex.
      const body = `FYI, someone sent: ${nudgeBody("qitem-rk3")} - ignore`;
      const prompt = env("dev-x@ws", body);
      const t = await mkW({ item: { sourceSession: "arch-x@ws", tags: ["mission:deploy"] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        expect(msgOf(t.fake, "qitem-rk3").peer_id).toBe("dev-x");
        expect(readRigMission(t.dir, WS).mission).toBe("general");
      } finally {
        t.cleanup();
      }
    },
  );

  test(
    "RK4 OBSERVATION: an item sourceSession with several @ classifies as unknown-sender - and the gate still applies that placeholder",
    async () => {
      // "root@daemon@kernel" fails the two-part daemon-stamped shape
      // (attribute.ts:193), so classifyEnvelopeSender returns the plain
      // UNKNOWN_SENDER_PEER placeholder WITHOUT a sameRig key. cls.kind is
      // "peer" and cls.sameRig === undefined - the F2 guard passes and the
      // override moves the sender to "unknown-sender". Benign in the worst
      // sense (no real peer id can be forged this way - only the shared
      // placeholder), but the message leaves the daemon envelope it came
      // under. Pinned for the ruling.
      const prompt = env("daemon@ws", nudgeBody("qitem-rk4"));
      const t = await mkW({ item: { sourceSession: "root@daemon@kernel", tags: [] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        expect(msgOf(t.fake, "qitem-rk4").peer_id).toBe("unknown-sender");
      } finally {
        t.cleanup();
      }
    },
  );
});

describe("RK5 missionIdIsSecretShaped: the ordinary/secret boundary (brief: no ordinary name refused)", () => {
  test(
    "RK5a FINDING: ordinary mission names are never refused (dashes, digits, case, length)",
    () => {
      for (const name of [
        "deploy",
        "Pilot-Run-3",
        "m3",
        "pilot-pilot-2026",
        "sketch-2024-migration", // sk- prefix needs a literal hyphen after "sk"
        "long-tail-mission-name-with-numbers-2026-abcde", // 46 lower+digit
        "Migrate-User-Profile-Store-to-Sqlite-Phase2-2026", // 48 mixed+digits: opaque-rule suspect // fake-secret
      ]) {
        expect(missionIdIsSecretShaped(name)).toBe(false);
      }
    },
  );

  test(
    "RK5b FINDING: token-shaped ids are refused on every prefix",
    () => {
      for (const secret of [
        "ghp_AbC01234567890abcdefghij", // fake-secret
        "sk-ant-FAKEfake123456789012", // fake-secret
        "xoxb-12345678", // fake-secret
        "AIzaSyDFAKEfake12345678", // fake-secret
      ]) {
        expect(missionIdIsSecretShaped(secret)).toBe(true);
      }
    },
  );

  test(
    "RK5c OBSERVATION: an AWS AKIA-prefixed id sits below every threshold - not refused",
    () => {
      // 20 chars, upper+digits only: no prefix rule covers AKIA, and the
      // opaque redact rule needs >=40 chars with a lowercase class too.
      // Whether AWS-style ids belong in the predicate is the architect's
      // call; pinned as CURRENT behaviour.
      // FLIPPED (architect 01:28Z, T16m Observation 3 ruled): the AWS
      // access key id shape is now a provider-token prefix - refused.
      expect(missionIdIsSecretShaped("AKIAIOSFODNN7EXAMPLE")).toBe(true); // fake-secret
    },
  );
});
