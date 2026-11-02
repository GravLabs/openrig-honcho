// Server probe (T2): records how Honcho v3.4.0 actually behaves on the
// endpoints the plugin design rests on. Each test records its fact.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createClient } from "../../plugin/src/honcho.ts";
import { cleanupScratch, SCRATCH_DISAPPEAR_WINDOW_MS, scratchClient, scratchWorkspace, type Scratch } from "../support/scratch.ts";

const url = process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3";
const apiKey = process.env.HONCHO_API_KEY ?? "local";

let scratch: Scratch | undefined;

beforeAll(async () => {
  scratch = await scratchWorkspace();
});

afterAll(async () => {
  // T8e-fix-3: mode-aware cleanup - heavy = acceptance only (gate proves
  // disappearance); light = also poll out of workspaces/list, for the full
  // SCRATCH_DISAPPEAR_WINDOW_MS (900 s, ADR-0006 amendment 2026-10-30). The
  // DELETE retries run before the window opens, so the hook gets 300 s of
  // margin on top of it (T13d).
  if (scratch) await cleanupScratch([scratch.name]);
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

function need(): Scratch {
  if (!scratch) throw new Error("scratch workspace not created");
  return scratch;
}

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
});

// (a) Session with two peers and a scope; the scope must list it back.
// Recorded fact: the server stores the scope name EXACTLY as sent ("mission-
// probe", unprefixed); GET scopes/list shows it with no server-added prefix.
test("(a) created session appears in its scope's session list", async () => {
  const s = need();
  const created = await s.client.createSession("probe--general--1", {
    peers: {
      "probe-seat": { observe_me: true, observe_others: false },
      owner: { observe_me: true, observe_others: false },
    },
    scopes: ["mission-probe"],
    metadata: { rig_peer: "probe-seat", mission: "general" },
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  const listed = await s.client.listScopeSessions("mission-probe", { size: 50 });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.data.items.map((x) => x.id)).toContain("probe--general--1");

  // Record scope naming: fetch the workspace scope list directly.
  const resp = await fetch(`${url.replace(/\/$/, "")}/workspaces/${s.name}/scopes/list`, {
    method: "POST",
    headers: authHeaders(),
  });
  expect(resp.ok).toBe(true);
  const page = (await resp.json()) as { items: { id: string }[] };
  const names = page.items.map((x) => x.id);
  console.log(`RECORD(a) scope name as listed: ${JSON.stringify(names)}`);
  expect(names).toContain("mission-probe");
});

// (b) Peer configs set at create are what GET .../config returns.
// Recorded fact (observed): set values come back verbatim; an unset
// observe_others returns null, not false.
test("(b) session peer config round-trips", async () => {
  const s = need();
  const created = await s.client.createSession("probe--general--2", {
    peers: {
      "observer-seat": { observe_me: true, observe_others: true },
      "quiet-seat": { observe_me: true },
    },
  });
  expect(created.ok).toBe(true);

  const resp = await fetch(
    `${url.replace(/\/$/, "")}/workspaces/${s.name}/sessions/probe--general--2/peers/observer-seat/config`,
    { headers: authHeaders() },
  );
  expect(resp.ok).toBe(true);
  const observer = (await resp.json()) as { observe_me: boolean | null; observe_others: boolean | null };
  expect(observer.observe_me).toBe(true);
  expect(observer.observe_others).toBe(true);

  const resp2 = await fetch(
    `${url.replace(/\/$/, "")}/workspaces/${s.name}/sessions/probe--general--2/peers/quiet-seat/config`,
    { headers: authHeaders(), },
  );
  expect(resp2.ok).toBe(true);
  const quiet = (await resp2.json()) as { observe_me: boolean | null; observe_others: boolean | null };
  console.log(`RECORD(b) unset observe_others returns: ${JSON.stringify(quiet)}`);
  expect(quiet.observe_me).toBe(true);
  expect(quiet.observe_others ?? false).toBe(false);
});

// (c) A message whose peer_id is not a session member.
// Recorded fact (observed at runtime, asserted below): the server auto-adds
// the unknown peer to the session and accepts the message (201).
test("(c) addMessages with a non-member peer_id", async () => {
  const s = need();
  const res = await s.client.addMessages("probe--general--1", [
    { peer_id: "stranger", content: "probe: message from a non-member peer" },
  ]);
  console.log(`RECORD(c) non-member peer_id result: ${JSON.stringify(res.ok ? { ok: true } : res)}`);
  expect(res.ok).toBe(true);
  if (res.ok) {
    // The auto-added peer is now visible in the session config.
    const cfg = await fetch(
      `${url.replace(/\/$/, "")}/workspaces/${s.name}/sessions/probe--general--1/peers/stranger/config`,
      { headers: authHeaders() },
    );
    expect(cfg.ok).toBe(true);
  }
});

// (d) Peer id rules at workspace-level peer creation.
// Recorded fact (observed): the server rule is pattern ^[a-zA-Z0-9_-]+$ with
// max length 512; creation succeeds with HTTP 201. A space is rejected (422);
// 100 AND 101 chars are both ACCEPTED; only > 512 is rejected (422).
// (Our env contract's 100-char cap is stricter than the server's - a
// plugin-side choice, not a server rule.)
async function createPeer(id: string): Promise<number> {
  const s = need();
  const resp = await fetch(`${url.replace(/\/$/, "")}/workspaces/${s.name}/peers`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id }),
  });
  return resp.status;
}

test("(d) peer id rules: space rejected, 100/101 accepted (max is 512), create = 201", async () => {
  expect(await createPeer("bad id")).toBe(422);
  expect(await createPeer("a".repeat(100))).toBe(201);
  const r101 = await createPeer("b".repeat(101));
  console.log(`RECORD(d) 101-char peer id status: ${r101}`);
  expect(r101).toBe(201);
  const r513 = await createPeer("c".repeat(513));
  console.log(`RECORD(d) 513-char peer id status: ${r513}`);
  expect(r513).toBe(422);
});

// (e) A peer that exists but has no card yet: ok with empty/null, not an error.
// Recorded fact (observed): GET .../card returns 200 {"peer_card":null}. A
// peer that does not exist at all returns HTTP 404 (kind "http"), so callers
// must create peers via sessions, not rely on card GETs.
test("(e) getPeerCard: existing peer without a card is ok with null", async () => {
  const s = need();
  await createPeer("cardless-peer");
  const res = await s.client.getPeerCard("cardless-peer");
  console.log(`RECORD(e) cardless peer: ${JSON.stringify(res)}`);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.data.peer_card === null || res.data.peer_card.length === 0).toBe(true);
  }

  const missing = await s.client.getPeerCard("never-seen-peer");
  console.log(`RECORD(e) nonexistent peer: ${JSON.stringify(missing)}`);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.kind).toBe("http");
});

// (f) Timeout: an unreachable host returns {ok:false, kind:"timeout"} quickly.
test("(f) unreachable server times out inside the budget", async () => {
  const client = createClient({
    url: "http://10.255.255.1:9/v3",
    workspace: "honcho-bridge-scratch-unused",
    apiKey: "local",
    timeoutMs: 500,
  });
  const t0 = performance.now();
  const res = await client.getPeerCard("probe-peer");
  const ms = performance.now() - t0;
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.kind).toBe("timeout");
  expect(ms).toBeLessThan(1500);
});

// workspaceChat is exercised for shape only - calling it burns 6-30 s of
// model-server dialectic time (BRIEF), which a probe must not pay.
test("(g) workspaceChat is wired with the schema fields (no call)", () => {
  const s = need();
  expect(typeof s.client.workspaceChat).toBe("function");
  const input: Parameters<typeof s.client.workspaceChat>[0] = {
    query: "shape check only",
    scope: "mission-probe",
    reasoning_level: "low",
  };
  void input;
});
