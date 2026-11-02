// dev.review battery for T6c-fix at pin 98430e7 (qitem-20261028162043):
// free-n by metadata filter {rig_peer, mission} reverse size=1, the empty-filter
// unfiltered prefix scan, and rig_peer+mission stamping on EVERY session
// creation (normal / epoch fallback / profile / spooled-ensure replay).
// Battery item (d): the filter request is pinned byte-for-byte against the
// ADR-0002 ruling text (keys rig_peer+mission, reverse=true, size=1) via the
// fake's request log. Real-server epoch and >100-session cases live in
// tests/integration/review-t6c.test.ts; this file is fake-only.
// Local tmp dirs + 127.0.0.1 fake; no real server, no secrets.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  readFileSync, rmSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { setRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const FIXED_TS = "2026-10-28T12:00:00.000Z";
const FIXED_SEC = Math.floor(Date.parse(FIXED_TS) / 1000);

const mkWriter = async (over: Partial<Config> = {}) => {
  const fake = await startFakeHoncho();
  const dir = makeTempDir("rev-t6cf-");
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: "lead",
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: false,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over };
  return { fake, dir, config, deps: { client, now: () => FIXED_TS } };
};

// the writer's listSessions hits, in wire order. NOTE: the fake records the
// FULL pathname, so paths carry the client's /v3 base prefix.
const P = (p: string) => `/v3${p}`;
const listHits = (fake: FakeHoncho) =>
  fake.requests.filter((r) => r.method === "POST" && r.path.startsWith(P(`/workspaces/${WS}/sessions/list`)));
const createHits = (fake: FakeHoncho, w = WS) =>
  fake.requests.filter((r) => r.method === "POST" && r.path === P(`/workspaces/${w}/sessions`));
const liveSpool = (dir: string, w = WS, peer = "lead") => {
  try {
    return readFileSync(join(dir, w, "spool", `${peer}.jsonl`), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { session: string; ensure?: { create: { id: string; metadata?: Record<string, unknown> } } });
  } catch {
    return [];
  }
};

describe("R-T6cfix (d) the filter request is ADR-0002 byte-for-byte", () => {
  test("missing state -> the one filtered call is POST sessions/list?size=1&reverse=true, body {filters:{metadata:{rig_peer,mission}}}", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      const out = await recordPrompt({ prompt: "first prompt, no seat state", claudeSessionId: "c1" }, config, deps);
      expect(out.action === "sent" && out.session).toBe("lead--general--1");
      const hits = listHits(fake);
      // fresh seat: filter answers empty -> the defence-in-depth scan follows
      expect(hits.length).toBe(2);
      const r = hits[0];
      expect(r.path).toBe(P(`/workspaces/${WS}/sessions/list?size=1&reverse=true`));
      const b = r.body as unknown as { filters: { metadata: Record<string, unknown> } };
      expect(Object.keys(b)).toEqual(["filters"]);
      expect(Object.keys(b.filters)).toEqual(["metadata"]);
      expect(Object.keys(b.filters.metadata)).toEqual(["rig_peer", "mission"]);
      expect(b.filters.metadata).toEqual({ rig_peer: "lead", mission: "general" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });

  test("the filter follows the ACTIVE mission, not a hardcoded general", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      await setRigMission(dir, WS, "slice-07", "review");
      const out = await recordPrompt({ prompt: "mission switched seat", claudeSessionId: "c1" }, config, deps);
      expect(out.action === "sent" && out.session).toBe("lead--slice-07--1");
      const hits = listHits(fake);
      expect(hits.length).toBe(2); // empty filter -> scan follows, as above
      const b = hits[0].body as { filters: { metadata: Record<string, unknown> } };
      expect(b.filters.metadata).toEqual({ rig_peer: "lead", mission: "slice-07" });
      const c = createHits(fake)[0].body as { metadata?: Record<string, unknown> };
      expect(c.metadata).toEqual({ rig_peer: "lead", mission: "slice-07" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });
});

describe("R-T6cfix prefix-scan branch (filter found nothing)", () => {
  test("untagged own sessions are invisible to the filter but counted by the scan -> max+1", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      // pre-fix shape: a session created WITHOUT stamps
      await deps.client.createSession("lead--general--3", {
        peers: { owner: { observe_me: true } },
        scopes: ["general"] });
      const out = await recordPrompt({ prompt: "state lost after untagged sessions existed", claudeSessionId: "c1" }, config, deps);
      expect(out.action === "sent" && out.session).toBe("lead--general--4");
      const hits = listHits(fake);
      expect(hits.length).toBe(2);
      expect(hits[0].path).toBe(P(`/workspaces/${WS}/sessions/list?size=1&reverse=true`));
      expect(hits[1].path).toBe(P(`/workspaces/${WS}/sessions/list?size=100&reverse=true`));
      expect(hits[1].body ?? undefined).toBeUndefined(); // no filters -> no body (the client's contract)
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });

  test("foreign ids on the scan page never match our prefix -> blind mint 1 is safe there", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      await deps.client.createSession("x--general--9", { peers: { owner: { observe_me: true } }, scopes: ["general"] });
      const out = await recordPrompt({ prompt: "only foreign sessions on the page", claudeSessionId: "c1" }, config, deps);
      expect(out.action === "sent" && out.session).toBe("lead--general--1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });

  test("(a) fake-side: newest tagged session is an epoch fallback -> next mint is epoch+1", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      await deps.client.createSession("lead--general--1760000123", {
        peers: { owner: { observe_me: true } },
        metadata: { rig_peer: "lead", mission: "general", n_fallback: true } });
      const out = await recordPrompt({ prompt: "after an epoch-fallback session", claudeSessionId: "c1" }, config, deps);
      expect(out.action === "sent" && out.session).toBe("lead--general--1760000124");
      expect(listHits(fake).length).toBe(1); // the filter answered it; no scan needed
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });
});

describe("R-T6cfix (b) every creation path stamps {rig_peer, mission}", () => {
  test("normal create: exactly the two tags, no n_fallback", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      await recordPrompt({ prompt: "plain write", claudeSessionId: "c1" }, config, deps);
      const c = createHits(fake);
      expect(c.length).toBe(1);
      const b = c[0].body as { id: string; metadata?: Record<string, unknown> };
      expect(b.id).toBe("lead--general--1");
      expect(b.metadata).toEqual({ rig_peer: "lead", mission: "general" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });

  test("epoch-fallback create (sessions/list failing): the two tags PLUS n_fallback:true", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      fake.failPattern(`/workspaces/${WS}/sessions/list`);
      const out = await recordPrompt({ prompt: "free-n cannot ask the server", claudeSessionId: "c1" }, config, deps);
      expect(out.action === "sent" && out.session).toBe(`lead--general--${FIXED_SEC}`);
      const b = createHits(fake)[0].body as { metadata?: Record<string, unknown> };
      expect(b.metadata).toEqual({ rig_peer: "lead", mission: "general", n_fallback: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });

  test("profile create stamps {rig_peer, mission} too (mission = active at creation)", async () => {
    const { fake, dir, config, deps } = await mkWriter({ profileWorkspace: "prof" });
    try {
      await recordPrompt({ prompt: "owner text mirrors to profile", claudeSessionId: "c1" }, config, deps);
      const c = createHits(fake, "prof");
      expect(c.length).toBe(1);
      const b = c[0].body as { id: string; metadata?: Record<string, unknown> };
      expect(b.id).toBe(`${WS}--lead`);
      expect(b.metadata).toEqual({ rig_peer: "lead", mission: "general" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });

  test("a spooled ensure carries the stamps and replays stamped", async () => {
    const { fake, dir, config, deps } = await mkWriter();
    try {
      // fail ONLY the create (body carries the minted id; message bodies do not)
      fake.failPattern(`/workspaces/${WS}/sessions`, { bodyContains: '"id":"lead--general--1"' });
      const out1 = await recordPrompt({ prompt: "create fails, write spools", claudeSessionId: "c1" }, config, deps);
      expect(out1.action).toBe("spooled");
      const spooled = liveSpool(dir);
      expect(spooled.length).toBe(1);
      expect(spooled[0].ensure?.create.metadata).toEqual({ rig_peer: "lead", mission: "general" });
      // recovery: replay creates it EXPLICITLY with the stored stamps
      fake.failPattern(null);
      const out2 = await recordPrompt({ prompt: "server is back", claudeSessionId: "c2" }, config, deps);
      expect(out2.action).toBe("sent");
      const replayedCreate = createHits(fake).find(
        (r) => (r.body as { id?: string }).id === "lead--general--1",
      );
      expect(replayedCreate).toBeDefined();
      expect((replayedCreate as { body: { metadata?: Record<string, unknown> } }).body.metadata).toEqual({
        rig_peer: "lead",
        mission: "general" });
      // and it was an explicit creation, not an auto-create side effect
      const s = fake.state.sessions.get(`${WS}/lead--general--1`);
      expect(s).toBeDefined();
      expect((s as { auto_created?: unknown }).auto_created).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await fake.stop();
    }
  });
});
