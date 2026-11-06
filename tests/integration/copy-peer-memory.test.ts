// T17a integration (architect brief 2026-11-02): scripts/copy-peer-memory.ts
// against the REAL Honcho server in a SCRATCH workspace only (BRIEF hard
// limit; tests/support/scratch.ts is the single door - honcho-bridge-scratch*,
// deleted in afterAll). Run ONLY after the architect was told (brief).
//
// Shape per the T27 brief (architect 2026-11-06 04:33Z): decisions live on
// the RESERVED PAIR since T24, so seed the from-peer the REAL way through
// the MCP tools - remember for 5 entries in two missions (one SUPERSEDES
// another via the supersedes arg, one carries scope rig) and retire for one
// of them - plus direct deriver look-alike self-conclusions and a card; run
// the script with --apply; then run the plugin's own SessionStart reader
// for the to-peer as leader and assert its decisions block shows the COPIED
// IN-FORCE SET per mission (the superseded and the retired fact absent, the
// keeper present, the rig-scope entry in both missions) and its card shows
// the renamed items; run --apply again and expect 0 created; clean up
// through the scratch helpers. No workspaceChat anywhere.

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

const rememberFrame = (id: number, fact: string, extra: Record<string, string> = {}): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "remember", arguments: { fact, ...extra } },
  });

// remember answers "remembered in <session> (d-xxxxxxxx)" inside the frame;
// the d-id is what supersedes and retire take (T27 seeding).
const decisionId = (frame: string | null): string => {
  const parsed = JSON.parse(String(frame)) as { result?: { content?: { text?: string }[] } };
  const text = parsed.result?.content?.[0]?.text ?? "";
  return /\((d-[0-9a-f]{8})\)/.exec(text)?.[1] ?? "";
};

const retireFrame = (id: string, decisionIdArg: string, reason: string): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "retire", arguments: { decision_id: decisionIdArg, reason } },
  });

test("copy-peer-memory end to end in scratch", async () => {
  const s = need();
  const client = scratchClient(s.name);
  const dirFrom = makeTempDir("t17a-from-");
  const dirTo = makeTempDir("t17a-to-");

  // 1. seed the from-peer the real way: MCP remember on the reserved pair,
  // two missions, one SUPERSEDE (remember --supersedes) and one RETIRE -
  // the copy must carry the links and the retire, not just facts (T27)
  const cfgFrom = seatConfig(s.name, FROM, dirFrom);
  await setRigMission(dirFrom, s.name, "deploy", "seed");
  const r1 = await handleLine(rememberFrame(1, "we chose sqlite for state"), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r1).toContain("remembered in");
  expect(decisionId(r1)).not.toBe("");
  const r2 = await handleLine(rememberFrame(2, "the deriver stays off in scratch"), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r2).toContain("remembered in");
  const r4 = await handleLine(
    rememberFrame(4, "we chose postgres for state", { supersedes: decisionId(r1) }),
    { config: cfgFrom, client, now: () => NOW },
  );
  expect(r4).toContain("remembered in");
  const r5 = await handleLine(rememberFrame(5, "no force pushes on main", { scope: "rig" }), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r5).toContain("remembered in");
  await setRigMission(dirFrom, s.name, "audit", "seed");
  const r3 = await handleLine(rememberFrame(3, "release v0.2.2 is the pilot baseline"), {
    config: cfgFrom,
    client,
    now: () => NOW,
  });
  expect(r3).toContain("remembered in");
  const rr = await handleLine(
    retireFrame(6, decisionId(r3), "superseded by the v0.3 line"),
    { config: cfgFrom, client, now: () => NOW },
  );
  expect(rr).toContain("retired");

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
  // 5 decisions + 1 retire entry = 6 pair entries, two missions
  expect(first.counts).toMatchObject({ missions: 2, found: 6, created: 6, skipped: 0, cardItems: 2 });

  // 3. the plugin's own SessionStart reader for the to-peer as leader:
  //    exactly the seeded decisions, per mission, and the renamed card
  const cfgTo = seatConfig(s.name, TO, dirTo);
  await setRigMission(dirTo, s.name, "deploy", "check");
  const injectDeploy = await buildInjection({ source: "startup" }, cfgTo, { client, now: () => NOW });
  expect(injectDeploy).toContain("we chose postgres for state"); // the superseded sqlite fact stays out
  expect(injectDeploy).not.toContain("we chose sqlite for state");
  expect(injectDeploy).toContain("the deriver stays off in scratch");
  expect(injectDeploy).toContain("no force pushes on main"); // rig scope reads in every mission
  expect(injectDeploy).not.toContain("release v0.2.2 is the pilot baseline");
  expect(injectDeploy).not.toContain("derived lookalike");
  expect(injectDeploy).toContain(`${TO} leads the deploy mission`);
  expect(injectDeploy).toContain(`the ex-${FROM}-x line survives`);

  await setRigMission(dirTo, s.name, "audit", "check");
  const injectAudit = await buildInjection({ source: "startup" }, cfgTo, { client, now: () => NOW });
  expect(injectAudit).toContain("no force pushes on main"); // the rig entry rides into every mission
  expect(injectAudit).not.toContain("release v0.2.2 is the pilot baseline"); // retired: the retire entry rode over too
  expect(injectAudit).not.toContain("we chose sqlite for state");
  expect(injectAudit).not.toContain("derived lookalike");

  // 4. second apply: nothing new
  const second = await runCopy(args, () => {}, () => NOW);
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error(`${second.fact} / ${second.reason} / ${second.fix}`);
  expect(second.counts).toMatchObject({ found: 6, created: 0, skipped: 6 });
}, 180_000);
