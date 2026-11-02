// T17a integration (architect brief 2026-11-02): scripts/copy-peer-memory.ts
// against the REAL Honcho server in a SCRATCH workspace only (BRIEF hard
// limit; tests/support/scratch.ts is the single door - honcho-bridge-scratch*,
// deleted in afterAll). Run ONLY after the architect was told (brief).
//
// Shape per the brief: seed the from-peer the REAL way - the MCP remember
// tool for 3 decisions in two missions - plus direct deriver look-alike
// self-conclusions and a card; run the script with --apply; then run the
// plugin's own SessionStart reader for the to-peer as leader and assert its
// decisions block shows exactly the seeded decisions in the right missions
// and its card shows the renamed items; run --apply again and expect 0
// created; clean up through the scratch helpers. No workspaceChat anywhere.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import type { Config } from "../../plugin/src/env.ts";
import { setRigMission } from "../../plugin/src/missions.ts";
import { buildInjection } from "../../plugin/src/reader.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import { runCopy } from "../../scripts/copy-peer-memory.ts";
import {
  cleanupScratch,
  SCRATCH_DISAPPEAR_WINDOW_MS,
  scratchClient,
  scratchWorkspace,
  type Scratch,
} from "../support/scratch.ts";

const BASE = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/+$/, "");
const AUTH = (): Record<string, string> => ({
  Authorization: `Bearer ${process.env.HONCHO_API_KEY ?? "local"}`,
  "Content-Type": "application/json",
});

const FROM = "ohrfrompeer";
const TO = "ohrtopeer";
const NOW = "2026-11-02T05:00:00.000Z";

let rig: Scratch | undefined;

beforeAll(async () => {
  rig = await scratchWorkspace();
});

afterAll(async () => {
  if (rig) await cleanupScratch([rig.name]);
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

function need(): Scratch {
  if (!rig) throw new Error("scratch workspace not created");
  return rig;
}

const seatConfig = (ws: string, peer: string, stateDir: string): Config => ({
  enabled: true,
  url: BASE,
  workspace: ws,
  peer,
  observeOthers: false,
  ownerPeer: "owner",
  profileWorkspace: null,
  recordAutomation: true,
  apiKey: process.env.HONCHO_API_KEY ?? "local",
  stateDir,
  timeoutMs: 10_000,
  sessionName: `${peer}@${ws}`,
  leaderPeer: peer, // remember is leader-only; both test seats are their own leader
});

const rememberFrame = (id: number, fact: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "remember", arguments: { fact } },
  });

test("copy-peer-memory end to end in scratch", async () => {
  const s = need();
  const client = scratchClient(s.name);
  const dirFrom = makeTempDir("t17a-from-");
  const dirTo = makeTempDir("t17a-to-");

  // 1. seed the from-peer the real way: MCP remember, two missions
  const cfgFrom = seatConfig(s.name, FROM, dirFrom);
  await setRigMission(dirFrom, s.name, "deploy", "seed");
  const r1 = await handleLine(rememberFrame(1, "we chose sqlite for state"), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r1).toContain("remembered in");
  const r2 = await handleLine(rememberFrame(2, "the deriver stays off in scratch"), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r2).toContain("remembered in");
  await setRigMission(dirFrom, s.name, "audit", "seed");
  const r3 = await handleLine(rememberFrame(3, "release v0.2.2 is the pilot baseline"), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r3).toContain("remembered in");

  // deriver look-alikes: self conclusions with NO decision message (direct,
  // the 818/856 shape) - they must never be copied. handleLine answers a
  // JSON-RPC FRAME: parse the JSON first, then read the session out of the
  // text part (a raw regex would capture the frame punctuation into the id).
  const rememberSession = (frame: string | null): string => {
    const parsed = JSON.parse(String(frame)) as { result?: { content?: { text?: string }[] } };
    const text = parsed.result?.content?.[0]?.text ?? "";
    return /remembered in (\S+)/.exec(text)?.[1] ?? "";
  };
  const deploySession = rememberSession(r1);
  expect(deploySession).not.toBe("");
  for (const noise of ["derived lookalike one", "derived lookalike two"]) {
    const lc = await client.createConclusion({
      content: noise,
      observer_id: FROM,
      observed_id: FROM,
      session_id: deploySession,
    });
    expect(lc.ok).toBe(true);
  }

  // the from-peer's card (direct PUT - the route exists live)
  const cardPut = await fetch(`${BASE}/workspaces/${encodeURIComponent(s.name)}/peers/${FROM}/card`, {
    method: "PUT",
    headers: AUTH(),
    body: JSON.stringify({ peer_card: [`${FROM} leads the deploy mission`, `the ex-${FROM}-x line survives`] }),
  });
  expect(cardPut.ok).toBe(true);

  // 2. the script, apply
  const args = {
    url: BASE,
    workspace: s.name,
    apiKey: process.env.HONCHO_API_KEY ?? "local",
    from: FROM,
    to: TO,
    apply: true,
  };
  const first = await runCopy(args, () => {}, () => NOW);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(`${first.fact} / ${first.reason} / ${first.fix}`);
  expect(first.counts).toMatchObject({ missions: 2, found: 3, created: 3, skipped: 0, cardItems: 2 });

  // 3. the plugin's own SessionStart reader for the to-peer as leader:
  //    exactly the seeded decisions, per mission, and the renamed card
  const cfgTo = seatConfig(s.name, TO, dirTo);
  await setRigMission(dirTo, s.name, "deploy", "check");
  const injectDeploy = await buildInjection({ source: "startup" }, cfgTo, { client, now: () => NOW });
  expect(injectDeploy).toContain("we chose sqlite for state");
  expect(injectDeploy).toContain("the deriver stays off in scratch");
  expect(injectDeploy).not.toContain("release v0.2.2 is the pilot baseline");
  expect(injectDeploy).not.toContain("derived lookalike");
  expect(injectDeploy).toContain(`${TO} leads the deploy mission`);
  expect(injectDeploy).toContain(`the ex-${FROM}-x line survives`);

  await setRigMission(dirTo, s.name, "audit", "check");
  const injectAudit = await buildInjection({ source: "startup" }, cfgTo, { client, now: () => NOW });
  expect(injectAudit).toContain("release v0.2.2 is the pilot baseline");
  expect(injectAudit).not.toContain("we chose sqlite for state");
  expect(injectAudit).not.toContain("derived lookalike");

  // 4. second apply: nothing new
  const second = await runCopy(args, () => {}, () => NOW);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(`${second.fact} / ${second.reason} / ${second.fix}`);
  expect(second.counts).toMatchObject({ found: 3, created: 0, skipped: 3 });
}, 180_000);
