// T2b: the fake Honcho server, exercised through the REAL client
// (createClient) so the fake's paths and shapes are proven compatible. Local
// 127.0.0.1 only; never touches http://localhost:8000.

import { describe, expect, test } from "bun:test";
import { createClient } from "../../plugin/src/honcho.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const mk = (fake: FakeHoncho, timeoutMs = 5000) =>
  createClient({ url: fake.url, workspace: "ws", apiKey: "test-key-not-a-secret", timeoutMs }); // fake-secret

describe("fake-honcho via the real client", () => {
  test("ok: session+peers+scopes, 3 messages in order, listScopeSessions shows it", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mk(fake);
      const created = await client.createSession("dev-build--general--1", {
        peers: { "dev-build": { observe_me: true }, owner: { observe_me: true, observe_others: false } },
        scopes: ["general"],
        metadata: { rig_peer: "dev-build" },
      });
      expect(created.ok).toBe(true);
      if (created.ok) expect(created.data.id).toBe("dev-build--general--1");

      const added = await client.addMessages("dev-build--general--1", [
        { peer_id: "dev-build", content: "one" },
        { peer_id: "owner", content: "two" },
        { peer_id: "unknown-sender", content: "three" },
      ]);
      expect(added.ok).toBe(true);

      const list = await client.listScopeSessions("general");
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.data.items.map((s) => s.id)).toContain("dev-build--general--1");
        expect(list.data.total).toBe(1);
      }

      const stored = fake.state.messages.get("ws/dev-build--general--1") ?? [];
      expect(stored.map((m) => m.content)).toEqual(["one", "two", "three"]);
      expect(stored.map((m) => m.peer_id)).toEqual(["dev-build", "owner", "unknown-sender"]);
      expect(fake.state.workspaces.has("ws")).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("500 -> {ok:false, kind:'http'} and the request is still recorded", async () => {
    const fake = await startFakeHoncho();
    try {
      fake.mode("500");
      const before = fake.requests.length;
      const r = await mk(fake).addMessages("nope", [{ peer_id: "p", content: "x" }]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe("http");
        expect(r.error).toContain("500");
      }
      expect(fake.requests.length).toBeGreaterThan(before);
    } finally {
      await fake.stop();
    }
  });

  test("hang with timeoutMs 300 -> kind 'timeout' within 800 ms", async () => {
    const fake = await startFakeHoncho();
    try {
      fake.mode("hang");
      const t0 = Date.now();
      const r = await mk(fake, 300).addMessages("s", [{ peer_id: "p", content: "x" }]);
      const elapsed = Date.now() - t0;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("timeout");
      expect(elapsed).toBeLessThan(800);
    } finally {
      await fake.stop();
    }
  });

  test("refuse -> kind 'connect' (nothing reaches the server); mode('ok') relistens on the SAME port", async () => {
    const fake = await startFakeHoncho();
    try {
      fake.mode("refuse");
      const before = fake.requests.length;
      const r = await mk(fake).createSession("s1", { peers: { p: {} } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("connect");
      expect(fake.requests.length).toBe(before); // refused connects never arrive

      fake.mode("ok");
      const r2 = await mk(fake).createSession("s1", { peers: { p: {} } });
      expect(r2.ok).toBe(true); // same fake.url -> same port
    } finally {
      await fake.stop();
    }
  });

  test("slow 200 ms with timeout 1000 -> ok", async () => {
    const fake = await startFakeHoncho();
    try {
      fake.mode("slow", { delayMs: 200 });
      const t0 = Date.now();
      const r = await mk(fake, 1000).workspaceChat({ query: "q" });
      const elapsed = Date.now() - t0;
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.content).toBe("fake-honcho fixed answer");
      expect(elapsed).toBeGreaterThanOrEqual(150);
    } finally {
      await fake.stop();
    }
  });

  test("requests records method, path (with query), body and time for each call", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mk(fake);
      await client.createSession("s1", { peers: { p1: { observe_me: true } }, scopes: ["general"] });
      await client.addMessages("s1", [{ peer_id: "p1", content: "x" }]);
      await client.listScopeSessions("general", { size: 5 });
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /v3/workspaces/ws/sessions",
        "POST /v3/workspaces/ws/sessions/s1/messages",
        "POST /v3/workspaces/ws/scopes/general/sessions/list?size=5",
      ]);
      expect(fake.requests[0].body).toEqual({
        id: "s1",
        peers: { p1: { observe_me: true } },
        scopes: ["general"],
      });
      expect(fake.requests[2].body).toBeUndefined();
      for (const r of fake.requests) expect(typeof r.at).toBe("number");
    } finally {
      await fake.stop();
    }
  });

  test("every client method answers in ok mode; card 404s an unknown peer; unknown path 404s", async () => {
    const fake = await startFakeHoncho();
    try {
      const client = mk(fake);
      expect((await client.createSession("s2", { peers: { alice: { observe_me: true } }, scopes: ["mission-x"] })).ok).toBe(true);
      expect((await client.addSessionPeers("s2", { bob: { observe_me: true } })).ok).toBe(true);
      expect((await client.addMessages("s2", [{ peer_id: "bob", content: "hi" }])).ok).toBe(true);
      expect((await client.listScopeSessions("mission-x")).ok).toBe(true);
      const sums = await client.getSessionSummaries("s2");
      expect(sums.ok).toBe(true);
      if (sums.ok) expect(sums.data.short_summary).toBeNull();
      const card = await client.getPeerCard("alice");
      expect(card.ok).toBe(true);
      if (card.ok) expect(card.data.peer_card).toEqual([]);
      const ghost = await client.getPeerCard("ghost");
      expect(ghost.ok).toBe(false);
      if (!ghost.ok) expect(ghost.kind).toBe("http");
      expect((await client.createConclusion({ content: "c", observer_id: "alice", observed_id: "bob" })).ok).toBe(true);
      expect((await client.workspaceChat({ query: "q", scope: "mission-x" })).ok).toBe(true);
      // parity with the real server (ADR-0004 amendment): a scope that does
      // not exist 404s the chat instead of answering
      const ghostChat = await client.workspaceChat({ query: "q", scope: "nope" });
      expect(ghostChat.ok).toBe(false);
      if (!ghostChat.ok) {
        expect(ghostChat.kind).toBe("http");
        expect(ghostChat.status).toBe(404);
      }
      expect(fake.state.conclusions.get("ws")?.length).toBe(1);

      const raw = await fetch(`${fake.url.replace(/\/v3$/, "")}/v3/nope`);
      expect(raw.status).toBe(404);
      expect(await raw.json()).toEqual({ detail: "Not Found" });
    } finally {
      await fake.stop();
    }
  });

  test("stop() with a hung request returns promptly and releases the waiter", async () => {
    const fake = await startFakeHoncho();
    fake.mode("hang");
    const r = await mk(fake, 200).addMessages("s", [{ peer_id: "p", content: "x" }]);
    expect(r.ok).toBe(false);
    const t0 = Date.now();
    await fake.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    // and the suite reaching this line at all is the no-open-handle proof:
    // bun test only exits after every handle is closed.
  });
});
