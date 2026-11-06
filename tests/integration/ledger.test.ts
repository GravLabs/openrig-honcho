// T19a (ADR-0014 decision 2 + amendment): the decision ledger against the
// REAL Honcho server in ONE SCRATCH workspace only (BRIEF hard limit;
// tests/support/scratch.ts is the single door - honcho-bridge-scratch*,
// deleted in afterAll). remember A, then remember B superseding A, through
// the real MCP handleLine; the session-start block (buildInjection, the list
// path - no embedding wait) shows B and NOT A; the search tool (embeddings
// settle up to 30 s the way search-tool.test.ts does) still shows A, marked
// "(superseded by d-…)". No derivation (scratchWorkspaceConfiguration
// default, T8d-3).

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
  type Scratch } from "../support/scratch.ts";

const SELF = "lead"; // the seat IS the leader: remember and the in-force view share it

let rig: Scratch | undefined;

beforeAll(async () => {
  rig = await scratchWorkspace();
});

afterAll(async () => {
  // search-tool.test.ts pattern: verify the DELETE was accepted, leave the
  // disappearance poll to the gate; hook timeout = window + margin.
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
    stateDir: makeTempDir("t19a-it-state-"),
    timeoutMs: 10_000,
    leaderPeer: SELF };
  return { config, client: rig.client };
};

const callTool = async (deps: Deps, name: string, args: Record<string, unknown>): Promise<string> => {
  const line = await handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args } }),
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
  "remember A, remember B superseding A: session start shows B not A; search marks A superseded",
  async () => {
    const deps = mkDeps();

    const rA = await callTool(deps, "remember", {
      fact: "LEDGER-IT run the nightly gate on 868",
      reason: "the 868 box is quieter at night",
    });
    expect(rA).toMatch(/^remembered in lead--general--\d+ \(d-[0-9a-f]{8}\)/);
    const idA = idOf(rA);

    const rB = await callTool(deps, "remember", {
      fact: "LEDGER-IT run the nightly gate on 915",
      supersedes: idA,
    });
    const idB = idOf(rB);
    expect(idB).not.toBe(idA);

    // session start (list path, immediate): only B is in force, header stripped
    const inj = await buildInjection(
      { source: "startup", claudeSessionId: "t19a-it-c1" },
      deps.config,
      { client: deps.client, now: () => new Date().toISOString() },
    );
    expect(inj).toContain("## Decisions from the leader");
    expect(inj).toContain("LEDGER-IT run the nightly gate on 915");
    expect(inj, "superseded A must not be injected").not.toContain("868");
    expect(inj).toContain(idB); // the id label rides on the entry
    expect(inj).not.toContain("[decision d-"); // header stripped from the body
    // B has no reason, so no reason may be shown: a "(reason:" here is A leaking
    expect(inj).not.toContain("(reason:");

    // search keeps history, marked: wait for embeddings like search-tool.test.ts
    let text = "";
    const deadline = Date.now() + 30_000;
    for (;;) {
      text = await callTool(deps, "search", { query: "nightly gate" });
      if (text.includes("LEDGER-IT run the nightly gate on 868") && text.includes("on 915")) break;
      if (Date.now() > deadline) break;
      await Bun.sleep(2000);
    }
    expect(text).toContain("LEDGER-IT run the nightly gate on 868");
    expect(text).toContain(`(superseded by ${idB})`);
    // B is in force: unmarked
    expect(text).not.toContain("on 915 (superseded by");
    expect(text).not.toContain(`(superseded by ${idA})`);
  },
  120_000,
);
