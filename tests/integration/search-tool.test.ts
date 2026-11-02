// T16d (ADR-0011 decision 5): the search TOOL against the REAL Honcho server
// in ONE SCRATCH workspace only (BRIEF hard limit; tests/support/scratch.ts is
// the single door - honcho-bridge-scratch*, deleted in afterAll). The call
// goes through the real MCP handleLine so the wire shapes, the self-self
// pair, the 3 s wall and the two-section render are all on the real path.
// Half the conclusions and messages are deploy-topic, half unrelated: an
// on-topic search returns the deploy ones and not the unrelated ones
// (conclusions settle for embeddings up to 30 s the way recall-query.test.ts
// does; message search is a plain server substring, immediate). No
// derivation (scratchWorkspaceConfiguration default, T8d-3).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import type { Config } from "../../plugin/src/env.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import {
  cleanupScratch,
  SCRATCH_DISAPPEAR_WINDOW_MS,
  scratchWorkspace,
  type Scratch } from "../support/scratch.ts";

const SESSION = "searchit--general--1";
const SELF = "build";
const MSG_PEER = "review";

let rig: Scratch | undefined;

beforeAll(async () => {
  rig = await scratchWorkspace();
});

afterAll(async () => {
  // recall-query.test.ts pattern: verify the DELETE was accepted, leave the
  // disappearance poll to the gate; hook timeout = window + margin.
  const names = rig !== undefined ? [rig.name] : [];
  if (names.length > 0) await cleanupScratch(names);
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

const search = async (): Promise<string> => {
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
    stateDir: makeTempDir("t16d-it-state-"),
    timeoutMs: 10_000 };
  const deps = { config, client: rig.client, now: () => new Date().toISOString() };
  const line = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: { query: "deploy" } } }),
    deps,
  );
  expect(line).not.toBeNull();
  const r = JSON.parse(line as string) as Record<string, any>;
  return String(r.result.content[0].text);
};

test(
  "search finds the on-topic conclusions and messages and not the unrelated ones",
  async () => {
    if (!rig) throw new Error("scratch workspace not created");
    const client = rig.client;

    const created = await client.createSession(SESSION, {
      peers: { [SELF]: {}, [MSG_PEER]: {} } });
    expect(created.ok).toBe(true);

    const conclusions = [
      "The deploy lands behind the pilot route; roll back by pointing the route at the old image.",
      "Deploys are gated: review must PASS before the deploy tag is pushed.",
      "The deploy of the search tool waits until the unit gate is green.",
      "The coffee machine on the third floor is broken again.",
      "The Q3 budget review moved to next Thursday.",
    ];
    for (const content of conclusions) {
      const r = await client.createConclusion({
        content,
        observer_id: SELF,
        observed_id: SELF, // no about: the self-self pair must find these
        session_id: SESSION });
      expect(r.ok).toBe(true);
    }

    const msgs = await client.addMessages(SESSION, [
      { peer_id: MSG_PEER, content: "the deploy log shows the last deploy at 09:12" },
      { peer_id: MSG_PEER, content: "coffee machine repair was scheduled Tuesday" },
    ]);
    expect(msgs.ok).toBe(true);

    // Embedding the fresh conclusions is the server's step; poll the real
    // search call itself until the Memories section is non-empty (<= 30 s).
    let text = "";
    const deadline = Date.now() + 30_000;
    for (;;) {
      text = await search();
      if (text.includes("Memories:") && !text.includes("Memories:\n(none)")) break;
      if (Date.now() > deadline) break;
      await Bun.sleep(2000);
    }

    // memories: on-topic in, unrelated out
    expect(text).toContain("Memories:");
    expect(/deploy/i.test(text)).toBe(true);
    expect(text).not.toContain("coffee");
    expect(text).not.toContain("budget");

    // messages: plain substring server search, immediate - "deploy" hits the
    // deploy-log message, the coffee message stays out
    expect(text).toContain("Messages:");
    expect(text).toContain("the deploy log shows the last deploy at 09:12");
    expect(text).toContain(MSG_PEER);
    expect(text).not.toContain("repair was scheduled Tuesday");
  },
  120_000,
);
