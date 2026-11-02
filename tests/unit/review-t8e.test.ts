// T8d-2 re-review attack suite (review seat, qitem -20261028231557, pin
// a6cea32). Contract: ADR-0006 F1 (reply created_at from the transcript),
// F2 (one ensure per session; pre-ruled 22:48Z: concurrent first-writers may
// each createSession ONCE - get-or-create makes that legal; the strict part
// is per-writer at-most-one, correct final state, nothing in an auto_created
// session, and ZERO further ensure calls for sequential writes), R1 order
// across an outage (fake-based twin of the soak's forwarder outage).
// Everything here is fake-driven; no live server.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  rmSync  } from "node:fs";
import type { Config } from "../../plugin/src/env.ts";
import { createClient, type HonchoClient } from "../../plugin/src/honcho.ts";
import { recordBody } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";
const NOW = () => "2026-10-28T12:00:00.000Z";
const SESSION = "build--general--1";

interface H {
  fake: FakeHoncho;
  dir: string;
  config: Config;
  client: HonchoClient;
  stop(): Promise<void>;
}

async function mk(cfgOver: Partial<Config> = {}): Promise<H> {
  const fake = await startFakeHoncho();
  const dir = makeTempDir("rev-t8e-");
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: false,
    apiKey: "sk-ant-RevT8eKeyFake0123456789abcdefGHIJ", // fake-secret
    stateDir: dir,
    timeoutMs: 2000,
    ...cfgOver };
  const client = createClient({ url: fake.url, workspace: WS, apiKey: config.apiKey, timeoutMs: 2000 });
  return {
    fake,
    dir,
    config,
    client,
    stop: async () => {
      fake.mode("ok");
      await fake.stop();
    } };
}

const write = (h: H, content: string, sender = SELF) =>
  recordBody({ content, sender, kindTag: "decision", hookName: "rev-t8e" }, h.config, { client: h.client, now: NOW });

const creates = (h: H): number =>
  h.fake.requests.filter((r) => r.method === "POST" && r.path === `/v3/workspaces/${WS}/sessions`).length;
const addPeersCalls = (h: H): number =>
  h.fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/peers")).length;
/** every message content that reached the server, in the order the wire saw it */
const wireContents = (h: H): string[] => {
  const out: string[] = [];
  for (const r of h.fake.requests) {
    if (r.method !== "POST" || !r.path.includes("/messages")) continue;
    const body = r.body as { messages?: { content: string }[] };
    for (const m of body.messages ?? []) out.push(m.content);
  }
  return out;
};

describe("T8d-2 attack: F2 one-ensure contract (pre-ruled 22:48Z)", () => {
  test("(a) three concurrent first-writes: at most one createSession PER WRITER, every message lands", async () => {
    const h = await mk();
    try {
      const rs = await Promise.all([write(h, "c1"), write(h, "c2"), write(h, "c3")]);
      for (const r of rs) expect(r.action).toBe("sent");
      // three concurrent readers can each legally ensure once (get-or-create);
      // FOUR+ means some writer ensured twice - the real bug shape
      expect(creates(h)).toBeLessThanOrEqual(3);
      expect(wireContents(h).sort()).toEqual(["c1", "c2", "c3"]);
    } finally {
      await h.stop();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("(b) final session state: right scope, owner+seat peers, not auto_created", async () => {
    const h = await mk();
    try {
      const r = await write(h, "solo");
      expect(r.action).toBe("sent");
      // fake keys the scope map as `${ws}/${scope}` -> session ids
      expect(h.fake.state.scopes.get(`${WS}/general`)).toEqual([SESSION]);
      const peers = h.fake.state.peers.get(WS);
      expect(peers?.has(SELF)).toBe(true);
      expect(peers?.has("owner")).toBe(true); // owner rides in the create peers
      expect(h.fake.state.sessions.get(`${WS}/${SESSION}`)?.auto_created).toBeUndefined();
    } finally {
      await h.stop();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("(c) nothing lands in an auto_created session - no session in the fake is auto-created", async () => {
    const h = await mk();
    try {
      await Promise.all([write(h, "p1"), write(h, "p2"), write(h, "p3", "dev-x"), write(h, "p4")]);
      for (const s of h.fake.state.sessions.values()) {
        expect(s.auto_created).toBeUndefined();
      }
      const stored = h.fake.state.messages.get(`${WS}/${SESSION}`) ?? [];
      expect(stored.length).toBe(4);
    } finally {
      await h.stop();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  test("(d) the strict contract: sequential writes ensure ZERO more calls; a new sender adds exactly once", async () => {
    const h = await mk();
    try {
      await write(h, "s1"); // first: createSession x1
      expect(creates(h)).toBe(1);
      await write(h, "s2");
      await write(h, "s3");
      expect(creates(h)).toBe(1); // F2 dedup: no ensure after the cache
      expect(addPeersCalls(h)).toBe(0); // sender === seat: never a peers call
      await write(h, "d1", "dev-x"); // new sender: exactly one addSessionPeers
      expect(addPeersCalls(h)).toBe(1);
      await write(h, "d2", "dev-x"); // cached member: no second call
      await write(h, "s4");
      expect(addPeersCalls(h)).toBe(1);
      expect(creates(h)).toBe(1);
    } finally {
      await h.stop();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe("T8d-2 attack: R1 order across an outage (fake twin of the soak forwarder phase)", () => {
  test("prompts spooled during a 500-outage replay in prompt order BEFORE the recovery write", async () => {
    const h = await mk();
    try {
      h.fake.failPattern("/messages", { status: 500 });
      for (let i = 1; i <= 5; i++) {
        const r = await write(h, `p${i}`);
        expect(r.action).toBe("spooled");
      }
      // failed POSTs appear in requests but never in state.messages - the
      // ACCEPTED view is the ordering proof
      expect((h.fake.state.messages.get(`${WS}/${SESSION}`) ?? []).length).toBe(0);
      h.fake.failPattern(null); // clear the failure rule: outage over
      const r6 = await write(h, "p6"); // its recordBody replays the spool first
      expect(r6.action).toBe("sent");
      const accepted = (h.fake.state.messages.get(`${WS}/${SESSION}`) ?? []).map(
        (m) => String((m as { content: string }).content),
      );
      expect(accepted).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    } finally {
      await h.stop();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
