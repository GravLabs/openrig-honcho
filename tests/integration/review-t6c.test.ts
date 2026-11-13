// dev.review integration battery for T6c at pin ed55995 (+7811c61), real
// Honcho server, SCRATCH workspaces only.
// Two jobs: (1) pin the fake's new real-parity claims (unknown scope 404,
// size>100 422, message-to-unknown-session auto-create) against the REAL
// server so a fake drift is caught; (2) free-n paging with >100 sessions in
// one scope - FINDING F-T6c-1 is the deliberately-RED test (free-n misses
// the highest n when our newest session is off the 100-item page, and the
// get-or-create ensure then MERGES the new write into an existing session).
// Cleanup pages the session list (the shared scratch helper deletes only one
// 100-item page, which cannot clean a >100-session workspace).
// ADR-0006 "Load on the shared server": tests seeding >20 sessions run only
// with HONCHO_HEAVY_TESTS=1; routine runs skip them. The three gated tests:
// the F-T6c-1 recheck (105 untagged seeds), the reverse-order test consuming
// those seeds, and the report-only residual probe.
// Probed at this pin: workspaces/list caps size at 100 (200 -> 422) and
// workspace purge is ASYNC - list rows lag DELETE by minutes under load; the
// afterAll accounts for both.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  rmSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import { recordGateDeletes, SCRATCH_DISAPPEAR_WINDOW_MS, scratchName, scratchClient } from "../support/scratch.ts";
import { scratchDisappearVerdict } from "../support/scratch-verdict.ts";
import { createClient } from "../../plugin/src/honcho.ts";

const BASE = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/+$/, "");
const KEY = process.env.HONCHO_API_KEY ?? "local";
const H = (): Record<string, string> => ({
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json" });

const made: string[] = [];
// F5: the SAME acceptance fact recordGateDeletes writes on the accepted
// branch below, kept per name so the disappearance poll can tell purge lag
// (accepted, pending) from a delete we never proved (throw).
const accepted = new Set<string>();

/** Paged delete-all-sessions then workspace delete; mirrors the helper's
 * 202-settle retry but loops pages (the helper's single list would strand
 * sessions beyond the first 100). */
async function deleteScratchPaged(name: string): Promise<void> {
  const w = encodeURIComponent(name);
  for (;;) {
    const l = await fetch(`${BASE}/workspaces/${w}/sessions/list?size=100`, { method: "POST", headers: H() });
    if (!l.ok) break;
    const items = (((await l.json()) as { items?: { id: string }[] }).items) ?? [];
    if (items.length === 0) break;
    for (const s of items) {
      const d = await fetch(`${BASE}/workspaces/${w}/sessions/${encodeURIComponent(s.id)}`, {
        method: "DELETE",
        headers: H() });
      if (!d.ok && d.status !== 404) throw new Error(`cleanup: session ${s.id} delete HTTP ${d.status}`);
    }
  }
  for (let i = 0; i < 8; i++) {
    const d = await fetch(`${BASE}/workspaces/${w}`, { method: "DELETE", headers: H() });
    // 404 = an earlier async delete already took it (observed: the list row
    // lags the delete by seconds; later attempts answer not-found)
    if (d.ok || d.status === 404) {
      recordGateDeletes([name]); // T14f: the gate's leftovers step needs every accepted delete
      accepted.add(name); // F5: the same fact, per name, for the light poll
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`cleanup: workspace ${name} delete failed after retries`);
}

let ws = "";

beforeAll(async () => {
  ws = scratchName();
  made.push(ws);
  const cw = await fetch(`${BASE}/workspaces`, { method: "POST", headers: H(), body: JSON.stringify({ id: ws }) });
  if (!cw.ok) throw new Error(`could not create scratch workspace: HTTP ${cw.status}`);
});

afterAll(async () => {
  for (const n of made) await deleteScratchPaged(n);
  // gone from workspaces/list. MEASURED at this pin: workspace DELETE answers
  // 202 (async) and purge latency scales with seeded sessions - ~221 s for a
  // ~200-session workspace (two ws), ~10-12 min for the ~400-session one (the
  // 90 s in the qitem body is unachievable under heavy seeds; report). The
  // heavy tests' 330 s hook ceiling cannot hold for a heavy purge, so heavy
  // runs verify acceptance (deleteScratchPaged throws otherwise) and check the
  // list here only when the queue is light.
  // Ruling B (architect 02:16Z after the ec6fed7 gate): heavy cleanups
  // assert DELETE ACCEPTED only - deleteScratchPaged throws unless every
  // DELETE is 2xx/404 - and never wait for purge (server lag measured 3-11
  // min, gate leftovers step is the disappearance backstop). That was
  // already this file's heavy shape since the pin that measured the purge
  // (line-83 branch unchanged). Light runs keep a disappearance poll at
  // SCRATCH_DISAPPEAR_WINDOW_MS - 900 s since the ADR-0006 amendment
  // 2026-10-30 (T13d): both v0.1.2 gate runs showed accepted deletes purging
  // in minutes, so the hook ceiling rose with the window (the old 330 s
  // ceiling is what made 120 s the ruled light window).
  const heavyRun = process.env.HONCHO_HEAVY_TESTS === "1";
  if (heavyRun) return;
  const started = Date.now();
  const deadline = started + SCRATCH_DISAPPEAR_WINDOW_MS;
  for (;;) {
    // size=100 is the server's LIST cap (probed 2026-10-28: workspaces/list
    // size>100 -> 422; an earlier 200 here made this check silently vacuous)
    const resp = await fetch(`${BASE}/workspaces/list?size=100`, { method: "POST", headers: H() });
    const ids = (((await resp.json()) as { items?: { id: string }[] }).items ?? []).map((x) => x.id);
    const still = made.filter((n) => ids.includes(n));
    if (still.length === 0) {
      // F5: one line with the elapsed purge time when everything is gone
      console.log(scratchDisappearVerdict([], SCRATCH_DISAPPEAR_WINDOW_MS, () => true, Date.now() - started).line);
      break;
    }
    if (Date.now() > deadline) {
      // F5 (review R14 O3): one verdict with the gate's leftovers step for
      // one fact. A still-listed name whose DELETE was accepted is the
      // server's async purge lag (10-70 min when busy) and PASSES as
      // pending, exactly as the leftovers step passes it; release.ts still
      // refuses while any scratch is listed. A name WITHOUT an accepted
      // DELETE is this file's failure and still throws here.
      console.log(scratchDisappearVerdict(still, SCRATCH_DISAPPEAR_WINDOW_MS, (n) => accepted.has(n), Date.now() - started).line);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000); // paged session deletes (before the window opens) + the full light window + margin

const w = (): string => encodeURIComponent(ws);

// ADR-0006 load rule: >20-session seeds only run when explicitly armed
const heavy = process.env.HONCHO_HEAVY_TESTS === "1" ? test : test.skip;

describe("R-T6c real-server parity (the T6c fake's mirror claims)", () => {
  test("unknown scope list -> 404", async () => {
    const r = await fetch(`${BASE}/workspaces/${w()}/scopes/mission-none/sessions/list`, { method: "POST", headers: H() });
    expect(r.status).toBe(404);
  });

  test("scope list size=101 -> 422 (rejected BEFORE scope resolution, as the fake does)", async () => {
    const r = await fetch(`${BASE}/workspaces/${w()}/scopes/general/sessions/list?size=101`, {
      method: "POST",
      headers: H() });
    expect(r.status).toBe(422);
  });

  // RETARGETED at the T6c-fix pin per the architect's F-2 ruling ("accepted
  // AS IS, no flip"): the REAL server's message response is a plain ARRAY of
  // message objects (probed live twice, incl. 2-message body) with NO
  // auto_created marker; the fake keeps its auto_created:true flag - it is
  // STRICTER than the real server, and that difference is the documented,
  // ruled contract. Tests needing "was the session auto-created" against the
  // REAL server must use scope/peer-config readbacks, not this response.
  test("message to an unknown session -> 201 with a plain message ARRAY and no auto_created (real shape; fake's marker is the ruled difference)", async () => {
    const r = await fetch(`${BASE}/workspaces/${w()}/sessions/review-nonexistent-session/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ messages: [{ peer_id: "probe", content: "p1" }, { peer_id: "probe", content: "p2" }] }) });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(2);
    const e = (body as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(e).sort()).toEqual(
      ["content", "created_at", "id", "metadata", "peer_id", "session_id", "token_count", "workspace_id"].sort(),
    );
    expect(e.auto_created).toBeUndefined();
    expect((e.metadata as Record<string, unknown>).auto_created).toBeUndefined();
  });

  test("no caller in plugin/ sends a page size the server rejects (only writer free-n, capped 100)", async () => {
    // source-level guard: any size param above 100 anywhere in plugin/ would
    // 422 against this server; scan the shipped tree.
    const { readdirSync, readFileSync } = await import("node:fs");
    const root = new URL("../../plugin/", import.meta.url).pathname;
    const files: string[] = [];
    for (const sub of ["src", "bin"]) {
      for (const f of readdirSync(join(root, sub))) {
        if (f.endsWith(".ts")) files.push(join(root, sub, f));
      }
    }
    expect(files.length).toBeGreaterThan(5); // the scan actually saw the tree
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/size:\s*(\d+)/g)) {
        expect(Number(m[1]), `${f} size ${m[1]}`).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("R-T6c free-n paging (real server, >100 sessions in one scope)", () => {
  // RED at ed55995 (the finding); at the T6c-fix pin this is the recheck: the
  // empty-filter prefix scan must mint 106, not merge into existing 101.
  heavy("F-T6c-1 RECHECK at 98430e7: free-n mints a NEVER-EXISTING session when >100 untagged sessions are in the scope [heavy]", async () => {
    const peer = "rev-paging";
    const client = createClient({ url: BASE, workspace: ws, apiKey: KEY, timeoutMs: 10_000 });
    // 105 sessions n=1..105 created ASCENDING (creation order == n order):
    // the server page (size=100, default order) returns the 100 OLDEST -
    // our highest n (105) is off-page.
    for (let i = 1; i <= 105; i++) {
      const r = await client.createSession(`${peer}--general--${i}`, {
        peers: { owner: { observe_me: true } },
        scopes: ["general"] });
      if (!r.ok) throw new Error(`seed failed at ${i}: ${r.kind === "http" ? r.status : r.error}`);
    }
    const stateDir = makeTempDir("rev-t6c-paging-");
    try {
      const config: Config = {
        enabled: true,
        url: BASE,
        workspace: ws,
        peer,
        observeOthers: false,
        ownerPeer: "owner",
        profileWorkspace: null,
        recordAutomation: false,
        apiKey: KEY,
        stateDir,
        timeoutMs: 10_000 };
      const out = await recordPrompt(
        { prompt: "first prompt with 105 sessions already in scope", claudeSessionId: "c1" },
        config,
        { client, now: () => new Date().toISOString() },
      );
      expect(out.action).toBe("sent");
      if (out.action === "skipped") return;
      // The ADR-0002 free-n rule: n = max existing n + 1 = 106. The page-size
      // cap means the writer only sees 1..100, mints 101 - which EXISTS - and
      // the get-or-create ensure appends this write to that old conversation.
      expect(out.session).toBe(`${peer}--general--106`);
      // (when green, also assert no old session gained a message:)
      const old101 = await fetch(
        `${BASE}/workspaces/${w()}/sessions/${encodeURIComponent(`${peer}--general--101`)}/messages/list?size=10`,
        { method: "POST", headers: H() },
      );
      const m = ((await old101.json()) as { items?: unknown[] }).items ?? [];
      expect(m.length).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // its OWN scratch workspace: in the shared one the scope already holds
  // >100 sessions from the finding test, which (per F-T6c-1) would mask the
  // <=100 behaviour being controlled for
  test("control: with <=100 sessions in the scope the same path mints max+1 correctly", async () => {
    const peer = "rev-ctl";
    const ctlWs = scratchName();
    made.push(ctlWs);
    const cw = await fetch(`${BASE}/workspaces`, { method: "POST", headers: H(), body: JSON.stringify({ id: ctlWs }) });
    if (!cw.ok) throw new Error(`ctl scratch create failed: ${cw.status}`);
    const client = createClient({ url: BASE, workspace: ctlWs, apiKey: KEY, timeoutMs: 10_000 });
    for (const i of [1, 2, 3]) {
      await client.createSession(`${peer}--general--${i}`, { peers: { owner: { observe_me: true } }, scopes: ["general"] });
    }
    const stateDir = makeTempDir("rev-t6c-ctl-");
    try {
      const out = await recordPrompt(
        { prompt: "control prompt with 3 sessions", claudeSessionId: "c1" },
        {
          enabled: true, url: BASE, workspace: ws, peer, observeOthers: false, ownerPeer: "owner",
          profileWorkspace: null, recordAutomation: false, apiKey: KEY, stateDir, timeoutMs: 10_000 },
        { client, now: () => new Date().toISOString() },
      );
      expect(out.action === "sent" && out.session).toBe(`${peer}--general--4`);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("epoch case at the pin (real server): newest tagged session is an epoch fallback -> next mint is epoch+1, no collision", async () => {
    const peer = "rev-epoch";
    const epoch = 1_760_000_123;
    const client = scratchClient(ws);
    const c = await client.createSession(`${peer}--general--${epoch}`, {
      peers: { owner: { observe_me: true } },
      metadata: { rig_peer: peer, mission: "general", n_fallback: true } });
    expect(c.ok).toBe(true);
    const stateDir = makeTempDir("rev-t6c-epoch-");
    try {
      const out = await recordPrompt(
        { prompt: "after an epoch-fallback newest session", claudeSessionId: "c1" },
        {
          enabled: true, url: BASE, workspace: ws, peer, observeOthers: false, ownerPeer: "owner",
          profileWorkspace: null, recordAutomation: false, apiKey: KEY, stateDir, timeoutMs: 10_000 },
        { client, now: () => new Date().toISOString() },
      );
      expect(out.action === "sent" && out.session).toBe(`${peer}--general--${epoch + 1}`);
      // and the epoch session itself stayed untouched
      const m = await fetch(
        `${BASE}/workspaces/${w()}/sessions/${encodeURIComponent(`${peer}--general--${epoch}`)}/messages/list?size=5`,
        { method: "POST", headers: H() },
      );
      const items = (((await m.json()) as { items?: unknown[] }).items) ?? [];
      expect(items.length).toBe(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // gated with F-T6c-1: it consumes that test's 105-session seed
  heavy("reverse=true shows newest-created first, where OUR highest n lives (fix-input: reverse finds what the forward page misses) [heavy]", async () => {
    const client = scratchClient(ws);
    // scope now holds >105 sessions; the forward page (first 100 created)
    // misses rev-paging--105, the reverse page must lead with the recent ones
    const rev = await client.listScopeSessions("general", { size: 100, reverse: true });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;
    const firstMine = rev.data.items
      .map((s) => s.id)
      .find((id) => id.startsWith("rev-paging--general--"));
    expect(firstMine).toBeDefined();
    // per-peer creation order == n order, so the FIRST of our sessions in
    // reverse order must be the highest n the earlier tests left (105 or 106)
    const n = Number((firstMine as string).slice("rev-paging--general--".length));
    expect(n).toBeGreaterThanOrEqual(105);
    // and prove the forward page misses it: our first hit forward is a LOWER n
    const fwd = await client.listScopeSessions("general", { size: 100 });
    expect(fwd.ok).toBe(true);
    if (!fwd.ok) return;
    const firstFwd = fwd.data.items
      .map((s) => s.id)
      .find((id) => id.startsWith("rev-paging--general--"));
    const nFwd = Number((firstFwd as string).slice("rev-paging--general--".length));
    expect(nFwd).toBeLessThan(n);
  });

  // battery item (c): the FILTER branch (not the scan) at >100 tagged sessions
  heavy("(c) >100 tagged sessions in the scope: the reverse size=1 filter answers the newest -> mints a never-existing n, no merge [heavy]", async () => {
    const peer = "rev-tagged";
    const client = scratchClient(ws);
    for (let i = 1; i <= 105; i++) {
      const r = await client.createSession(`${peer}--general--${i}`, {
        peers: { owner: { observe_me: true } },
        metadata: { rig_peer: peer, mission: "general" } });
      if (!r.ok) throw new Error(`tagged seed failed at ${i}`);
    }
    const stateDir = makeTempDir("rev-t6c-tagged-");
    try {
      const out = await recordPrompt(
        { prompt: "105 tagged sessions exist, newest is --105", claudeSessionId: "c1" },
        {
          enabled: true, url: BASE, workspace: ws, peer, observeOthers: false, ownerPeer: "owner",
          profileWorkspace: null, recordAutomation: false, apiKey: KEY, stateDir, timeoutMs: 10_000 },
        { client, now: () => new Date().toISOString() },
      );
      // page-size limits cannot bite: filters+reverse+size=1 answers --105
      expect(out.action === "sent" && out.session).toBe(`${peer}--general--106`);
      const prev = await fetch(
        `${BASE}/workspaces/${w()}/sessions/${encodeURIComponent(`${peer}--general--105`)}/messages/list?size=5`,
        { method: "POST", headers: H() },
      );
      const items = (((await prev.json()) as { items?: unknown[] }).items) ?? [];
      expect(items.length).toBe(0); // no merge into the newest existing
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // REPORT-ONLY per the qitem: asserts what the fix STILL misses, as observed,
  // so a future change that narrows or widens it shows up here.
  heavy("RESIDUAL (documented, report-only): untagged own session pushed off the newest-100 scan page -> n=1 collides and merges [heavy]", async () => {
    const peer = "rev-resid";
    const old = `${peer}--general--1`;
    // an OLD UNTAGGED conversation with one message (created first)
    const seed = await fetch(`${BASE}/workspaces/${w()}/sessions/${encodeURIComponent(old)}/messages`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ messages: [{ peer_id: peer, content: "old conversation message" }] }) });
    expect(seed.status).toBe(201);
    // 105 NEWER sessions from OTHER peers crowd the unfiltered newest-100 page
    const client = scratchClient(ws);
    for (let i = 1; i <= 105; i++) {
      const r = await client.createSession(`x-occ--general--${i}`, { peers: { owner: { observe_me: true } } });
      if (!r.ok) throw new Error(`x-occ seed failed at ${i}`);
    }
    const stateDir = makeTempDir("rev-t6c-resid-");
    try {
      const out = await recordPrompt(
        { prompt: "fresh state after our untagged session went off-page", claudeSessionId: "c1" },
        {
          enabled: true, url: BASE, workspace: ws, peer, observeOthers: false, ownerPeer: "owner",
          profileWorkspace: null, recordAutomation: false, apiKey: KEY, stateDir, timeoutMs: 10_000 },
        { client, now: () => new Date().toISOString() },
      );
      // OBSERVED: filter empty (untagged), scan page holds only x-occ ids,
      // n=1 is minted onto the EXISTING rev-resid--general--1 - the merge
      // shape, bounded to untagged-sessions-beyond-page-100 by the fix.
      expect(out.action === "sent" && out.session).toBe(old);
      const m = await fetch(
        `${BASE}/workspaces/${w()}/sessions/${encodeURIComponent(old)}/messages/list?size=10`,
        { method: "POST", headers: H() },
      );
      const items = (((await m.json()) as { items?: unknown[] }).items) ?? [];
      expect(items.length).toBe(2);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
