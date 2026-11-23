// v0.5.9 (ADR-0019 amended 2026-11-23): the lead's stale_review tool - every
// pending proposal at once with its retire call, and `keep` for entries that
// stand. Fake Honcho only; the stale file is a temp state dir.

import { describe, expect, test } from "bun:test";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { formatEntry, LEDGER_PEER } from "../../plugin/src/ledger.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import {
  keepProposals,
  pendingForReview,
  pickStaleForDigest,
  readStaleState,
  writeStaleState,
  type StaleState,
} from "../../plugin/src/stale.ts";
import { startFakeHoncho } from "../support/fake-honcho.ts";
import { makeTempDir } from "../support/tempdir.ts";

const WS = "ws";
const LEAD = "lead";
const NOW = "2026-11-23T04:00:00.000Z";

const prop = (oldId: string, newId: string, oldAt: string, shown = 0) => ({
  oldId,
  newId,
  why: "a later status replaced it",
  oldAt,
  at: "2026-11-22T00:00:00.000Z",
  shown,
});

const state = (): StaleState => ({
  version: 1,
  classes: {},
  lastCheckedAt: "2026-11-22T00:00:00.000Z",
  proposals: [
    prop("d-0000000b", "d-0000000c", "2026-11-20T00:00:00.000Z", 3),
    prop("d-0000000a", "d-0000000c", "2026-11-10T00:00:00.000Z"),
    prop("d-0000000f", "d-0000000c", "2026-11-11T00:00:00.000Z"),
  ],
});

describe("stale.ts review helpers", () => {
  test("pendingForReview: in force and not kept, oldest first, whatever the showing count", () => {
    const st = state();
    st.kept = ["d-0000000f"];
    const got = pendingForReview(st, new Set(["d-0000000a", "d-0000000b", "d-0000000f"]));
    expect(got.map((p) => p.oldId)).toEqual(["d-0000000a", "d-0000000b"]);
    expect(pendingForReview(st, new Set(["d-0000000b"])).map((p) => p.oldId)).toEqual(["d-0000000b"]);
  });
  test("keepProposals: only pending ids; they leave the list and join kept", () => {
    const st = state();
    const r = keepProposals(st, ["d-0000000a", "d-0000000a", "d-12345678"]);
    expect(r).toEqual({ kept: ["d-0000000a"], refused: ["d-12345678"], evicted: 0 });
    expect(st.proposals.map((p) => p.oldId)).toEqual(["d-0000000b", "d-0000000f"]);
    expect(st.kept).toEqual(["d-0000000a"]);
  });
  test("R22 N-S2: the cap drops the oldest kept ids and says how many", async () => {
    const { KEPT_MAX } = await import("../../plugin/src/stale.ts");
    const st = state();
    st.kept = Array.from({ length: KEPT_MAX }, (_, i) => `d-${(0x10000000 + i).toString(16)}`);
    const r = keepProposals(st, ["d-0000000a"]);
    expect(r.evicted).toBe(1);
    expect(st.kept?.length).toBe(KEPT_MAX);
    expect(st.kept?.[KEPT_MAX - 1]).toBe("d-0000000a");
    expect(st.kept).not.toContain("d-10000000");
  });
  test("kept survives the file round-trip; damaged kept values are dropped; the digest skips kept", () => {
    const dir = makeTempDir("stale-review-");
    const st = state();
    st.kept = ["d-0000000a", "nope", "d-0000000a"] as string[];
    writeStaleState(dir, WS, st);
    const back = readStaleState(dir, WS) as StaleState;
    expect(back.kept).toEqual(["d-0000000a"]);
    const pk = pickStaleForDigest(back, new Set(["d-0000000a", "d-0000000b", "d-0000000f"]), 5);
    expect(pk.picked.map((p) => p.oldId)).toEqual(["d-0000000f"]);
  });
  test("a file without kept reads back without it (pre-v0.5.9 files are unchanged)", () => {
    const dir = makeTempDir("stale-review-");
    writeStaleState(dir, WS, state());
    expect("kept" in (readStaleState(dir, WS) as object)).toBe(false);
  });
});

describe("stale_review tool", () => {
  const mk = async (leader = true) => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("stale-review-mcp-");
    const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
    const config: Config = {
      enabled: true, url: fake.url, workspace: WS, peer: LEAD, observeOthers: false, ownerPeer: "owner",
      profileWorkspace: null, recordAutomation: true, apiKey: "k", stateDir: dir, timeoutMs: 2000,
      ...(leader ? { leaderPeer: LEAD } : { leaderPeer: "someone-else" }) };
    const plant = (content: string, at: string) =>
      fake.addConclusion(WS, { content, observer_id: LEAD, observed_id: LEDGER_PEER, session_id: "lead--m--1", created_at: at });
    plant(formatEntry({ kind: "decision", id: "d-0000000a", scope: "mission", fact: "main is at abc1234" }), "2026-11-10T00:00:00.000Z");
    plant(formatEntry({ kind: "approval", id: "d-0000000b", scope: "mission", owner: "0a1b2c3d", fact: "publish 0.13.0" }), "2026-11-20T00:00:00.000Z");
    plant(formatEntry({ kind: "status", id: "d-0000000c", scope: "mission", fact: "main is at def5678" }), "2026-11-22T00:00:00.000Z");
    // d-0000000f has a proposal but is no longer in the ledger (retired elsewhere)
    writeStaleState(dir, WS, state());
    const call = async (args: Record<string, unknown>) => {
      const line = await handleLine(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stale_review", arguments: args } }),
        { config, client, now: () => NOW },
      );
      const r = JSON.parse(line as string) as Record<string, any>;
      return { text: String(r.result.content[0].text), isError: r.result.isError === true };
    };
    return { fake, dir, call };
  };

  test("lists pending in-force proposals oldest first with the exact retire call; owner approvals say so", async () => {
    const h = await mk();
    try {
      const r = await h.call({});
      expect(r.isError).toBe(false);
      const lines = r.text.split("\n");
      expect(lines[0]).toBe('2 pending stale proposals, oldest first. Retire the ones that are stale; keep the rest with stale_review {"keep": [ids]}.');
      expect(lines[1]).toBe("- d-0000000a (decision, 13 d ago): main is at abc1234");
      expect(lines[2]).toBe("  stale because of d-0000000c: a later status replaced it");
      expect(lines[3]).toBe('  retire: mcp__rig_memory__retire {"decision_id":"d-0000000a","reason":"made stale by d-0000000c"}');
      expect(lines[4]).toContain("- d-0000000b (approval, 3 d ago) (owner approval: retiring it needs the owner's turn): publish 0.13.0");
      // R22 N-S3: no copyable retire call for an owner approval
      expect(lines[6]).toBe("  retire: ask the owner; on the owner's turn, mcp__rig_memory__retire with decision_id d-0000000b");
      expect(r.text).not.toContain('"decision_id":"d-0000000b"');
      expect(r.text).not.toContain("d-0000000f");
    } finally {
      await h.fake.stop();
    }
  });

  test("keep stores the id, the list shrinks, and an unknown id is named, not an error", async () => {
    const h = await mk();
    try {
      const r = await h.call({ keep: ["d-0000000a", "d-99999999"] });
      expect(r.isError).toBe(false);
      expect(r.text).toContain("kept d-0000000a: not proposed again");
      expect(r.text).toContain("not a pending proposal, ignored: d-99999999");
      expect(r.text).toContain("1 pending stale proposal, oldest first.");
      expect(r.text).not.toContain("- d-0000000a");
      expect(readStaleState(h.dir, WS)?.kept).toEqual(["d-0000000a"]);
    } finally {
      await h.fake.stop();
    }
  });

  test("bad keep is a usage error and changes nothing; no file is no proposals", async () => {
    const h = await mk();
    try {
      const bad = await h.call({ keep: ["d-xyz"] });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("usage: stale_review");
      expect(readStaleState(h.dir, WS)?.kept).toBeUndefined();
    } finally {
      await h.fake.stop();
    }
  });

  test("a seat that is not the leader is refused and the tool is not listed", async () => {
    const h = await mk(false);
    try {
      const r = await h.call({});
      expect(r.isError).toBe(true);
      expect(r.text).toBe("stale_review is leader-only");
    } finally {
      await h.fake.stop();
    }
  });
});

describe("the digest points at stale_review", () => {
  test("a stale section ends with the review line; no proposals, no line", async () => {
    const { renderContinuity, STALE_REVIEW_LINE } = await import("../../plugin/src/inject.ts");
    const withP = renderContinuity({
      now: NOW,
      staleProposals: [{ oldId: "d-0000000a", oldAt: "2026-11-10T00:00:00.000Z", why: "replaced" }],
    });
    expect(withP).toContain(STALE_REVIEW_LINE);
    expect(withP.indexOf("Possibly stale")).toBeLessThan(withP.indexOf(STALE_REVIEW_LINE));
    expect(renderContinuity({ now: NOW, leftOff: { summary: "x", at: NOW, session: "s" } })).not.toContain("stale_review");
  });
});
