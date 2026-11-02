// T16b (ADR-0011 decision 1): conclusions/query against the REAL Honcho
// server (v3.4.0) in ONE SCRATCH workspace only (BRIEF hard limit;
// tests/support/scratch.ts is the single door - honcho-bridge-scratch*,
// deleted in afterAll like the other integration tests). Create conclusions
// with the existing create call, half about a deploy topic and half
// unrelated, then query through queryConclusions at the 0.45 gate: the
// on-topic body returns the deploy ones, an acknowledgement body returns
// nothing (the pilot probe of 2026-11-01 is the behaviour this pins).
// No workspaceChat anywhere (model-server time); the deriver stays off
// (scratchWorkspaceConfiguration default, T8d-3).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { recallQueryText } from "../../plugin/src/recall.ts";
import {
  cleanupScratch,
  SCRATCH_DISAPPEAR_WINDOW_MS,
  scratchWorkspace,
  type Scratch,
} from "../support/scratch.ts";

const SESSION = "recallq--general--1";
const OBSERVER = "build";
const OBSERVED = "dev-x";

let rig: Scratch | undefined;

beforeAll(async () => {
  rig = await scratchWorkspace();
});

afterAll(async () => {
  // Writer.test.ts pattern: verify the DELETE was accepted, leave the
  // disappearance poll to the gate; hook timeout = window + margin.
  const names = rig !== undefined ? [rig.name] : [];
  if (names.length > 0) await cleanupScratch(names);
}, SCRATCH_DISAPPEAR_WINDOW_MS + 300_000);

test(
  "deploy conclusions come back at 0.45 for an on-topic query; an acknowledgement comes back empty",
  async () => {
    if (!rig) throw new Error("scratch workspace not created");
    const client = rig.client;

    const created = await client.createSession(SESSION, {
      peers: { [OBSERVER]: {}, [OBSERVED]: {} },
    });
    expect(created.ok).toBe(true);

    const facts = [
      "The deploy lands behind the pilot route; roll back by pointing the route at the old image.",
      "Deploys are gated: review must PASS before the deploy tag is pushed.",
      "The deploy of the recall hook waits until the gate is green.",
      "The coffee machine on the third floor is broken again.",
      "The Q3 budget review moved to next Thursday.",
    ];
    for (const content of facts) {
      const r = await client.createConclusion({
        content,
        observer_id: OBSERVER,
        observed_id: OBSERVED,
        session_id: SESSION,
      });
      expect(r.ok).toBe(true);
    }

    const ask = (body: string) =>
      client.queryConclusions({
        query: recallQueryText(body),
        top_k: 4,
        distance: 0.45,
        filters: { observer: OBSERVER, observed: OBSERVED },
      });

    // Embedding the fresh conclusions is the server's step; settle for up to
    // 30 s the way writer.test.ts waits for message readback, then assert.
    let texts: string[] | undefined;
    const deadline = Date.now() + 30_000;
    for (;;) {
      const onTopic = await ask("did the deploy land?");
      expect(onTopic.ok).toBe(true);
      if (!onTopic.ok) throw new Error(`on-topic query failed: ${onTopic.kind} ${onTopic.status}`);
      texts = onTopic.data.map((c) => c.content);
      if (texts.length > 0 || Date.now() > deadline) break;
      await Bun.sleep(2000);
    }
    expect(texts!.length).toBeGreaterThanOrEqual(1); // on-topic returns the deploy ones
    expect(texts!.every((t) => /deploy/i.test(t))).toBe(true); // unrelated ones stay out
    expect(texts!.some((t) => /coffee|budget/i.test(t))).toBe(false);

    const ack = await ask("Acknowledged. Standing by.");
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.data.length).toBe(0); // the probe: acks answer nothing until 0.5
  },
  120_000,
);
