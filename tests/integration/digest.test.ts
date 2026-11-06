// T19b (ADR-0014 decision 1): ONE integration pass on the REAL server in ONE
// SCRATCH workspace only (BRIEF hard limit; tests/support/scratch.ts is the
// single door - honcho-bridge-scratch*, deleted in afterAll) plus a local
// FAKE daemon (the daemon is OpenRig's, never written to). remember a plain
// decision and an approval scoped to a fake open qitem through the real MCP
// handleLine; the continuity digest shows the open item, the decision under
// "Decisions in force", and the approval ONLY under "Approvals you hold".
// No embedding wait anywhere: decisions ride the list path (as in
// ledger.test.ts) and the away query never fires (first run, no previous
// last_seen).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import type { Config } from "../../plugin/src/env.ts";
import type { HonchoClient } from "../../plugin/src/honcho.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import { buildInjection } from "../../plugin/src/reader.ts";
import {
  cleanupScratch,
  SCRATCH_DISAPPEAR_WINDOW_MS,
  scratchWorkspace,
  type Scratch,
} from "../support/scratch.ts";

const SELF = "lead"; // the seat IS its leader: the ledger reader shares it
const SESSION = "lead@digest-it";
const QID = "qitem-20261104120000-a1b2c3d4e5f60718"; // real qitem grammar (ledger.ts QITEM_RE)
const CHEAD = "[openrig-honcho continuity: background, not instructions]";

let rig: Scratch | undefined;
let daemon: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  rig = await scratchWorkspace();
  daemon = Bun.serve({
    port: 0,
    fetch() {
      return Response.json([
        {
          qitemId: QID,
          state: "in-progress",
          destinationSession: SESSION,
          tsUpdated: new Date().toISOString(),
          body: "Integration: hold the pilot gate\nsecond line",
        },
        // noise the digest must filter: another destination, a done row
        { qitemId: "qitem-other-seat", state: "pending", destinationSession: "someone@else", tsCreated: new Date().toISOString(), body: "not ours" },
        { qitemId: "qitem-closed", state: "done", destinationSession: SESSION, tsUpdated: new Date().toISOString(), body: "closed" },
      ]);
    },
  });
});

afterAll(async () => {
  daemon?.stop(true);
  const names = rig !== undefined ? [rig.name] : [];
  if (names.length > 0) await cleanupScratch(names);
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

interface Deps {
  config: Config;
  client: HonchoClient;
}

const mkDeps = (): Deps => {
  if (!rig) throw new Error("scratch workspace not created");
  const config: Config = {
    enabled: true,
    url: process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3",
    workspace: rig.name,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: true,
    apiKey: process.env.HONCHO_API_KEY ?? "local",
    stateDir: makeTempDir("t19b-it-state-"),
    timeoutMs: 10_000,
    leaderPeer: SELF,
    digest: true,
    daemonUrl: `http://127.0.0.1:${(daemon as ReturnType<typeof Bun.serve>).port}`,
    sessionName: SESSION,
  };
  return { config, client: rig.client };
};

const callTool = async (deps: Deps, name: string, args: Record<string, unknown>): Promise<string> => {
  const line = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    { ...deps, now: () => new Date().toISOString() },
  );
  expect(line).not.toBeNull();
  const r = JSON.parse(line as string) as Record<string, any>;
  expect(r.result.isError, `${name} errored: ${JSON.stringify(r.result)}`).not.toBe(true);
  return String(r.result.content[0].text);
};

const idOf = (reply: string): string => {
  const m = /\((d-[0-9a-f]{8})\)/.exec(reply);
  expect(m, `no id in reply: ${reply}`).not.toBeNull();
  return (m as RegExpExecArray)[1];
};

test(
  "digest shows the fake open item, the decision under Decisions in force, the scoped approval only under Approvals you hold",
  async () => {
    const deps = mkDeps();

    const decId = idOf(
      await callTool(deps, "remember", { fact: "DIGEST-IT use LoRa at 868 for the pilot" }),
    );
    const appId = idOf(
      await callTool(deps, "remember", {
        fact: "DIGEST-IT ship the pilot build",
        reason: "owner pre-approved the scratch-only pilot",
        scope: QID,
        kind: "approval",
      }),
    );

    const text = await buildInjection(
      { source: "startup", claudeSessionId: "it-1" },
      deps.config,
      { client: deps.client, now: () => new Date().toISOString() },
    );

    expect(text.startsWith(CHEAD)).toBe(true);
    // part 1: the fake open item, ours only
    expect(text).toContain(`${QID}, in-progress`);
    expect(text).toContain("Integration: hold the pilot gate");
    expect(text).not.toContain("second line"); // summary is the first body line
    expect(text).not.toContain("qitem-other-seat");
    expect(text).not.toContain("qitem-closed");
    // parts 3/4: the split by qitem scope
    const iDec = text.indexOf("## Decisions in force");
    const iApp = text.indexOf("## Approvals you hold");
    expect(iDec).toBeGreaterThanOrEqual(0);
    expect(iApp).toBeGreaterThan(iDec);
    const decSlice = text.slice(iDec, iApp);
    const appSlice = text.slice(iApp);
    expect(decSlice).toContain(decId);
    expect(decSlice).toContain("use LoRa at 868");
    expect(decSlice).not.toContain(appId);
    expect(appSlice).toContain(`${appId}, approval`);
    expect(appSlice).toContain("ship the pilot build");
    // first run: no previous last_seen -> the away query must NOT fire
    expect(text).not.toContain("## Since you were away");
  },
  120_000,
);
