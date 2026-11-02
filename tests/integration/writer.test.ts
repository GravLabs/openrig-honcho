// T6c: the writer against the REAL Honcho server (v3.4.0) in SCRATCH
// workspaces only (BRIEF hard limit; tests/support/scratch.ts is the single
// door - names honcho-bridge-scratch*, deleted in afterAll, then polled out
// of workspaces/list). Two scratch workspaces: one as the rig workspace, one
// as the profile workspace. No workspaceChat calls anywhere (model-server time).
// Readbacks (probed live 2026-10-28): messages via POST .../sessions/<id>/
// messages/list, peer config via GET .../peers/<peer>/config, workspace
// presence via POST /workspaces/list.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  writeFileSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { setRigMission } from "../../plugin/src/missions.ts";
import { recordReply } from "../../plugin/src/stop.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import {
  cleanupScratch,
  SCRATCH_DISAPPEAR_WINDOW_MS,
  scratchClient,
  scratchWorkspace,
  type Scratch } from "../support/scratch.ts";

const BASE = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/+$/, "");
const AUTH = (): Record<string, string> => ({
  Authorization: `Bearer ${process.env.HONCHO_API_KEY ?? "local"}`,
  "Content-Type": "application/json" });

let rig: Scratch | undefined;
let prof: Scratch | undefined;

beforeAll(async () => {
  rig = await scratchWorkspace();
  prof = await scratchWorkspace();
});

afterAll(async () => {
  // T8e-fix-3 (architect 02:16Z, ADR-0006 per-run-mode): heavy verifies the
  // DELETE was accepted and leaves disappearance to the gate's final check;
  // light verifies disappearance (SCRATCH_DISAPPEAR_WINDOW_MS, 900 s since
  // the ADR-0006 amendment 2026-10-30). Acceptance is proven in the helper
  // in BOTH modes - a rejected DELETE throws there either way. The hook
  // timeout = the full window + 300 s margin: the session/workspace DELETEs
  // (each retried across ~45 s) run BEFORE the window opens, inside the same
  // hook (T13d).
  const names = [rig, prof].filter(Boolean).map((s) => (s as Scratch).name);
  if (names.length > 0) await cleanupScratch(names);
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

function need(): { rigName: string; profName: string } {
  if (!rig || !prof) throw new Error("scratch workspaces not created");
  return { rigName: rig.name, profName: prof.name };
}

interface SrvMsg {
  peer_id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

async function serverMessages(ws: string, session: string): Promise<SrvMsg[]> {
  const resp = await fetch(`${BASE}/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(session)}/messages/list?size=100`, {
    method: "POST",
    headers: AUTH() });
  expect(resp.ok).toBe(true);
  const page = (await resp.json()) as { items?: SrvMsg[] };
  return page.items ?? [];
}

async function peerConfig(
  ws: string,
  session: string,
  peer: string,
): Promise<{ observe_me: boolean | null; observe_others: boolean | null } | null> {
  const resp = await fetch(
    `${BASE}/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(session)}/peers/${encodeURIComponent(peer)}/config`,
    { headers: AUTH() },
  );
  if (resp.status === 404) return null;
  expect(resp.ok).toBe(true);
  return (await resp.json()) as { observe_me: boolean | null; observe_others: boolean | null };
}

async function sessionsIn(ws: string): Promise<string[]> {
  const resp = await fetch(`${BASE}/workspaces/${encodeURIComponent(ws)}/sessions/list?size=100`, {
    method: "POST",
    headers: AUTH() });
  expect(resp.ok).toBe(true);
  const page = (await resp.json()) as { items?: { id: string }[] };
  return (page.items ?? []).map((s) => s.id);
}

const mkHarness = (peer: string, over: Partial<Config> = {}) => {
  const { rigName, profName } = need();
  const stateDir = makeTempDir("t6c-writer-");
  const config: Config = {
    enabled: true,
    url: BASE,
    workspace: rigName,
    peer,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: true,
    apiKey: process.env.HONCHO_API_KEY ?? "local",
    stateDir,
    timeoutMs: 10_000,
    ...over };
  const deps = { client: scratchClient(rigName), now: () => new Date().toISOString() };
  return { rigName, profName, config, deps };
};

// same-rig envelope: the rig token must equal config.workspace (the scratch name)
const dm = (rigName: string, self: string, from: string, body: string) =>
  `From: ${from}@${rigName}\nTo: ${self}@${rigName}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;

const AUTOMATION_PROMPT =
  "OpenRig-generated identity context (not a project task):\nrole guidance here\nEnd of generated identity context.";

// ---------------------------------------------------------------------------

test("1) enveloped DM: session exists with ADR-0002 peer configs, scope lists it, message peer dev-build", async () => {
  const { rigName, config, deps } = mkHarness("t6c-dm");
  const out = await recordPrompt({ prompt: dm(rigName, "t6c-dm", "dev-build", "integration dm body"), claudeSessionId: "c1" }, config, deps);
  expect(out.action).toBe("sent");
  if (out.action === "skipped") return;
  const session = out.session;
  expect(session).toBe("t6c-dm--general--1");

  const scoped = await deps.client.listScopeSessions("general", { size: 100 });
  expect(scoped.ok && scoped.data.items.map((s) => s.id)).toContain(session);

  const msgs = await serverMessages(rigName, session);
  expect(msgs.map((m) => m.content)).toEqual(["integration dm body"]);
  expect(msgs[0].peer_id).toBe("dev-build");

  expect(await peerConfig(rigName, session, "owner")).toEqual({ observe_me: true, observe_others: false });
  expect(await peerConfig(rigName, session, "t6c-dm")).toEqual({ observe_me: true, observe_others: false });
  expect(await peerConfig(rigName, session, "dev-build")).toEqual({ observe_me: true, observe_others: false });
});

test("2) owner prompt lands in the rig session AND the profile session; a peer DM adds nothing to the profile", async () => {
  const { profName } = need();
  const { rigName, config, deps } = mkHarness("t6c-prof", { profileWorkspace: profName });
  const out = await recordPrompt({ prompt: "owner words for the profile test" }, config, deps);
  expect(out.action).toBe("sent");

  const rigMsgs = await serverMessages(rigName, "t6c-prof--general--1");
  expect(rigMsgs.map((m) => m.content)).toEqual(["owner words for the profile test"]);
  expect(rigMsgs[0].peer_id).toBe("owner");

  const profSession = `${rigName}--t6c-prof`;
  const profMsgs = await serverMessages(profName, profSession);
  expect(profMsgs.map((m) => m.content)).toEqual(["owner words for the profile test"]);
  expect(profMsgs[0].peer_id).toBe("owner");
  expect(await peerConfig(profName, profSession, "owner")).toEqual({ observe_me: true, observe_others: false });

  await recordPrompt({ prompt: dm(rigName, "t6c-prof", "dev-build", "a peer dm, never profiled") }, config, deps);
  const profAfter = await serverMessages(profName, profSession);
  expect(profAfter.length).toBe(1); // unchanged
});

test("3) mission switch: next message in <self>--probe-mission--1, listed in scope mission-probe-mission", async () => {
  const { rigName, config, deps } = mkHarness("t6c-mis");
  expect((await recordPrompt({ prompt: dm(rigName, "t6c-mis", "dev-build", "before the switch") }, config, deps)).action).toBe("sent");
  expect((await setRigMission(config.stateDir, rigName, "probe-mission", "t6c")).ok).toBe(true);
  const out = await recordPrompt({ prompt: dm(rigName, "t6c-mis", "dev-build", "after the switch") }, config, deps);
  expect(out.action === "sent" && out.session).toBe("t6c-mis--probe-mission--1");

  const scoped = await deps.client.listScopeSessions("mission-probe-mission", { size: 100 });
  expect(scoped.ok && scoped.data.items.map((s) => s.id)).toContain("t6c-mis--probe-mission--1");
  const msgs = await serverMessages(rigName, "t6c-mis--probe-mission--1");
  expect(msgs.map((m) => m.content)).toEqual(["after the switch"]);
});

test("4) ADR-0003 shapes in a DM reach the server only as [REDACTED:<kind>]", async () => {
  const { rigName, config, deps } = mkHarness("t6c-red");
  const fakeAnth = `sk-ant-${"FAKE".repeat(8)}`; // made-up, right shape only
  const fakeHex = "f".repeat(64);
  const fakeStrata = `strata_${"0123456789abcdefghij0123456789ab"}`;
  const out = await recordPrompt(
    { prompt: dm(rigName, "t6c-red", "dev-build", `keys: ${fakeAnth} ${fakeHex} ${fakeStrata} end`) },
    config,
    deps,
  );
  expect(out.action).toBe("sent");
  const msgs = await serverMessages(rigName, "t6c-red--general--1");
  const content = msgs[0].content;
  expect(content).toContain("[REDACTED:anthropic]");
  expect(content).toContain("[REDACTED:hex64]");
  expect(content).toContain("[REDACTED:strata]");
  expect(content).not.toContain("FAKEFAKEFAKE");
  expect(content).not.toContain(fakeHex);
  expect(content).not.toContain(fakeStrata);
});

test("5) automation: record off writes nothing; record on lands as openrig with observe_me false", async () => {
  const off = mkHarness("t6c-auto", { recordAutomation: false });
  const skipped = await recordPrompt({ prompt: AUTOMATION_PROMPT }, off.config, off.deps);
  expect(skipped).toEqual({ action: "skipped", reason: "not-recorded" });
  expect(await sessionsIn(off.rigName)).not.toContain("t6c-auto--general--1");

  const on = mkHarness("t6c-auto"); // same peer, fresh state dir: --1 free-n lands
  const out = await recordPrompt({ prompt: AUTOMATION_PROMPT }, on.config, on.deps);
  expect(out.action === "sent" && out.peer).toBe("openrig");
  const msgs = await serverMessages(on.rigName, "t6c-auto--general--1");
  expect(msgs[0].peer_id).toBe("openrig");
  expect(await peerConfig(on.rigName, "t6c-auto--general--1", "openrig")).toEqual({
    observe_me: false,
    observe_others: false });
});

test("6) reply: transcript text lands as the seat's peer; the same Stop twice records once", async () => {
  const { rigName, config, deps } = mkHarness("t6c-rep");
  const tp = join(config.stateDir, "turn.jsonl");
  writeFileSync(
    tp,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "integration prompt" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "integration reply part one" }] } }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const out = await recordReply({ transcript_path: tp }, config, deps);
  expect(out.action).toBe("sent");
  const again = await recordReply({ transcript_path: tp }, config, deps);
  // T8c contract (build 20:26Z): the E3 dedupe skip carries reason "duplicate"
  expect(again).toEqual({ action: "skipped", reason: "duplicate" });

  const msgs = await serverMessages(rigName, "t6c-rep--general--1");
  expect(msgs.length).toBe(1);
  expect(msgs[0].content).toBe("integration reply part one");
  expect(msgs[0].peer_id).toBe("t6c-rep");
  expect(msgs[0].metadata?.kind).toBe("reply");
});

test("7) kill switch through bin/user-prompt.ts writes nothing to the real server", async () => {
  const { rigName } = mkHarness("t6c-kill");
  const stateDir = makeTempDir("t6c-kill-");
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "..", "plugin/bin/user-prompt.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: stateDir,
      HONCHO_STATE_DIR: stateDir,
      HONCHO_ENABLED: "false",
      HONCHO_URL: BASE,
      HONCHO_WORKSPACE: rigName,
      HONCHO_PEER: "t6c-kill",
      HONCHO_API_KEY: process.env.HONCHO_API_KEY ?? "local" } });
  proc.stdin.write(JSON.stringify({ prompt: "must never reach the server", session_id: "c9" }));
  proc.stdin.end();
  const [code, outb, errb] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(outb).toBe("");
  expect(errb).toBe("");
  const sessions = await sessionsIn(rigName);
  expect(sessions).not.toContain("t6c-kill--general--1");
});

test("8) no implicit sessions: every session with messages is one we ensured, in the scope/peers we set", async () => {
  const { rigName, profName } = need();
  const rigSessions = await sessionsIn(rigName);
  expect(rigSessions.length).toBeGreaterThan(0);
  for (const id of rigSessions) {
    const m = /^(t6c-[a-z]+)--([a-z-]+)--(\d+)$/.exec(id);
    expect(m, `unexpected rig session id: ${id}`).not.toBeNull();
    if (!m) continue;
    const [, seat, mission] = m;
    const msgs = await serverMessages(rigName, id);
    expect(msgs.length, `session ${id} should carry our write`).toBeGreaterThan(0);
    const scope = mission === "general" ? "general" : `mission-${mission}`;
    const scoped = await scratchClient(rigName).listScopeSessions(scope, { size: 100 });
    expect(scoped.ok && scoped.data.items.map((s) => s.id), `${id} missing from scope ${scope}`).toContain(id);
    expect(await peerConfig(rigName, id, seat)).toEqual({ observe_me: true, observe_others: false });
  }
  const profSessions = await sessionsIn(profName);
  expect(profSessions.length).toBeGreaterThan(0);
  for (const id of profSessions) {
    const m = new RegExp(`^${rigName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}--(t6c-[a-z]+)$`).exec(id);
    expect(m, `unexpected profile session id: ${id}`).not.toBeNull();
    const msgs = await serverMessages(profName, id);
    expect(msgs.length, `profile session ${id} should carry the owner write`).toBeGreaterThan(0);
    expect(msgs.every((x) => x.peer_id === "owner")).toBe(true); // ONLY the human
    expect(await peerConfig(profName, id, "owner")).toEqual({ observe_me: true, observe_others: false });
  }
});
