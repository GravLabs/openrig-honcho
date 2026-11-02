// T17a (architect brief 2026-11-02): build-owned unit tests for
// scripts/copy-peer-memory.ts, entirely against the fake server - no real
// server, no scratch workspace touched (the scratch integration is a separate
// file and runs only with the architect told first).
//
// Seeds mirror the remember shape: a stamped from-session, a decision message
// (metadata.kind "decision", sender = the peer) plus the matching
// observer = observed self-conclusion, and deriver look-alikes (self
// conclusions with NO message) that must never be copied.

import { describe, expect, test } from "bun:test";
import { createClient } from "../../plugin/src/honcho.ts";
import { parseArgs, runCopy, type CopyArgs } from "../../scripts/copy-peer-memory.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const FROM = "dev-arch";
const TO = "design-arch";
const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-02T00:00:00.000Z";

const mk = async () => {
  const fake: FakeHoncho = await startFakeHoncho();
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const args: CopyArgs = { url: fake.url, workspace: WS, apiKey: "k", from: FROM, to: TO, apply: true };
  return { fake, client, args };
};

const sessionSeed = (peer: string, mission: string) => ({
  peers: { [peer]: { observe_me: true, observe_others: false } },
  scopes: [mission === "general" ? "general" : `mission-${mission}`],
  metadata: { rig_peer: peer, mission },
});

const decisionMsg = (content: string, mission: string, clientId: string, at: string) => ({
  peer_id: FROM,
  content,
  created_at: at,
  metadata: { client_id: clientId, kind: "decision", mission },
});

/** A remember-shaped decision: stamped session + message + self conclusion. */
const seedDecision = async (
  client: ReturnType<typeof createClient>,
  sessionId: string,
  mission: string,
  content: string,
  clientId: string,
  at: string,
) => {
  const cs = await client.createSession(sessionId, sessionSeed(FROM, mission));
  expect(cs.ok).toBe(true);
  const am = await client.addMessages(sessionId, [decisionMsg(content, mission, clientId, at)]);
  expect(am.ok).toBe(true);
  const cc = await client.createConclusion({
    content,
    observer_id: FROM,
    observed_id: FROM,
    session_id: sessionId,
  });
  expect(cc.ok).toBe(true);
};

const stateSize = (m: Map<string, unknown>): number => m.size;
const msgTotal = (fake: FakeHoncho): number =>
  [...fake.state.messages.values()].reduce((a, l) => a + l.length, 0);
const conclTotal = (fake: FakeHoncho): number =>
  [...fake.state.conclusions.values()].reduce((a, l) => a + l.length, 0);
const msgsOf = (fake: FakeHoncho, session: string): Array<Record<string, unknown>> =>
  (fake.state.messages.get(`${WS}/${session}`) ?? []) as Array<Record<string, unknown>>;
const conclContents = (fake: FakeHoncho, peer: string): string[] =>
  (fake.state.conclusions.get(WS) ?? [])
    .filter((c) => c.observer_id === peer && c.observed_id === peer)
    .map((c) => String(c.content));

async function seedFull(t: { fake: FakeHoncho; client: ReturnType<typeof createClient> }) {
  // mission deploy: one plain decision + one chunked (2 messages, one conclusion)
  await seedDecision(t.client, `${FROM}--deploy--1`, "deploy", "we chose sqlite", "c1", T1);
  const cs = await t.client.createSession(`${FROM}--deploy--2`, sessionSeed(FROM, "deploy"));
  expect(cs.ok).toBe(true);
  const am = await t.client.addMessages(`${FROM}--deploy--2`, [
    {
      peer_id: FROM,
      content: "part A ",
      created_at: T2,
      metadata: { client_id: "c2a", kind: "decision", mission: "deploy", chunk: { id: "ch1", i: 1, n: 2 } },
    },
    {
      peer_id: FROM,
      content: "part B",
      created_at: T2,
      metadata: { client_id: "c2b", kind: "decision", mission: "deploy", chunk: { id: "ch1", i: 2, n: 2 } },
    },
  ]);
  expect(am.ok).toBe(true);
  const cc = await t.client.createConclusion({
    content: "part A part B",
    observer_id: FROM,
    observed_id: FROM,
    session_id: `${FROM}--deploy--2`,
  });
  expect(cc.ok).toBe(true);
  // mission general: one decision
  await seedDecision(t.client, `${FROM}--general--1`, "general", "ship on friday", "c3", T2);
  // deriver look-alikes: self conclusions with NO message (the 818/856 shape)
  const lookalikes = await t.client.createConclusion({
    content: "derived noise, never a decision",
    observer_id: FROM,
    observed_id: FROM,
    session_id: `${FROM}--deploy--1`,
  });
  expect(lookalikes.ok).toBe(true);
  // a NON-decision message (must not be copied even though the peer sent it)
  const am2 = await t.client.addMessages(`${FROM}--deploy--1`, [
    { peer_id: FROM, content: "just chatter", created_at: T1, metadata: { client_id: "c4", kind: "reply", mission: "deploy" } },
  ]);
  expect(am2.ok).toBe(true);
  // the card: whole-word rename + a look-alike substring that must survive
  t.fake.setPeerCard(WS, FROM, [
    `${FROM} leads the deploy work`,
    "the ex-dev-arch-x note stays verbatim",
    "plain line",
  ]);
}

describe("T17a parseArgs refusals (no network)", () => {
  test("refuses every honcho.dev cloud host form, same rule as the plugin", () => {
    for (const url of ["https://honcho.dev/v3", "https://api.honcho.dev/v3", "https://x.honcho.dev/v3"]) {
      const r = parseArgs(["--url", url, "--workspace", "w", "--from", "a", "--to", "b"], {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fact).toContain("cloud host");
    }
  });

  test("refuses from === to, missing and unknown args; ok-parses with --apply and key default", () => {
    expect(parseArgs(["--url", "http://h:8002/v3", "--workspace", "w", "--from", "a", "--to", "a"], {}).ok).toBe(false);
    expect(parseArgs(["--url", "http://h:8002/v3", "--workspace", "w", "--from", "a"], {}).ok).toBe(false);
    const bad = parseArgs(["--url", "http://h:8002/v3", "--workspace", "w", "--from", "a", "--to", "b", "--zap"], {});
    expect(bad.ok).toBe(false);
    const ok = parseArgs(["--url", "http://localhost:8000/v3", "--workspace", "w", "--from", "a", "--to", "b", "--apply"], {
      HONCHO_API_KEY: "sekret-not-shown", // fake-secret
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.args.apply).toBe(true);
      expect(ok.args.apiKey).toBe("sekret-not-shown");
    }
    const dflt = parseArgs(["--url", "http://h:8002/v3", "--workspace", "w", "--from", "a", "--to", "b"], {});
    expect(dflt.ok && dflt.args.apiKey).toBe("local");
    expect(dflt.ok && dflt.args.apply).toBe(false);
  });
});

describe("T17a copy against the fake server", () => {
  test("apply: decisions (incl. chunked) land for the to-peer, look-alikes never; card renamed", async () => {
    const t = await mk();
    await seedFull(t);
    const lines: string[] = [];
    const res = await runCopy(t.args, (l) => lines.push(l), () => "2026-11-02T04:00:00.000Z");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts).toMatchObject({ missions: 2, found: 3, created: 3, skipped: 0, cardItems: 3, cardCopied: true });
    expect(res.dry).toBe(false);

    // to-sessions exist, stamped like the plugin creates them
    const dep = t.fake.state.sessions.get(`${WS}/${TO}--deploy--1`);
    expect(dep).toBeDefined();
    expect((dep as { metadata: Record<string, unknown> }).metadata).toEqual({ rig_peer: TO, mission: "deploy" });
    expect(t.fake.state.sessions.get(`${WS}/${TO}--general--1`)).toBeDefined();

    // conclusions: the 3 decisions, none of the look-alikes, none of the chatter
    const toConcl = conclContents(t.fake, TO);
    expect(toConcl.sort()).toEqual(["part A part B", "ship on friday", "we chose sqlite"]);
    expect(toConcl).not.toContain("derived noise, never a decision");
    expect(toConcl).not.toContain("just chatter");

    // decision messages: to-peer author, copied_from + original_at metadata
    const dm = msgsOf(t.fake, `${TO}--deploy--1`);
    expect(dm.length).toBe(2);
    const sqlite = dm.find((m) => m.content === "we chose sqlite");
    expect(sqlite).toBeDefined();
    const md = (sqlite as { metadata: Record<string, unknown> }).metadata;
    expect(md.kind).toBe("decision");
    expect(md.copied_from).toBe(FROM);
    expect(md.original_at).toBe(T1);
    expect(md.mission).toBe("deploy");
    expect((sqlite as { peer_id: string }).peer_id).toBe(TO);

    // card: whole-word from->to, substring survivor, plain line kept
    const cardResp = await t.client.getPeerCard(TO);
    expect(cardResp.ok).toBe(true);
    expect((cardResp as { data: { peer_card: string[] } }).data.peer_card).toEqual([
      `${TO} leads the deploy work`,
      "the ex-dev-arch-x note stays verbatim",
      "plain line",
    ]);

    // nothing of the from-peer changed
    expect(conclContents(t.fake, FROM)).toContain("derived noise, never a decision");
  });

  test("idempotency: a second apply creates nothing (skipped = found), state unchanged", async () => {
    const t = await mk();
    await seedFull(t);
    const first = await runCopy(t.args, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(first.ok).toBe(true);
    const sessions = stateSize(t.fake.state.sessions);
    const msgs = msgTotal(t.fake);
    const concl = conclTotal(t.fake);
    const second = await runCopy(t.args, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.counts).toMatchObject({ found: 3, created: 0, skipped: 3 });
    expect(stateSize(t.fake.state.sessions)).toBe(sessions);
    expect(msgTotal(t.fake)).toBe(msgs);
    expect(conclTotal(t.fake)).toBe(concl);
  });

  test("dry run: same counts, ZERO writes", async () => {
    const t = await mk();
    await seedFull(t);
    const before = {
      sessions: stateSize(t.fake.state.sessions),
      msgs: msgTotal(t.fake),
      concl: conclTotal(t.fake),
      cards: stateSize(t.fake.state.peerCards),
    };
    const res = await runCopy({ ...t.args, apply: false }, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dry).toBe(true);
    expect(res.counts).toMatchObject({ found: 3, created: 3, skipped: 0, cardItems: 3, cardCopied: false });
    expect(stateSize(t.fake.state.sessions)).toBe(before.sessions);
    expect(msgTotal(t.fake)).toBe(before.msgs);
    expect(conclTotal(t.fake)).toBe(before.concl);
    expect(stateSize(t.fake.state.peerCards)).toBe(before.cards);
    expect(t.fake.state.peerCards.get(`${WS}/${TO}`)).toBeUndefined();
  });

  test("already-carried content is skipped, the rest still copies into a fresh free-n session", async () => {
    const t = await mk();
    await seedFull(t);
    // pre-exist one carried decision for the to-peer in deploy
    const cs = await t.client.createSession(`${TO}--deploy--1`, sessionSeed(TO, "deploy"));
    expect(cs.ok).toBe(true);
    const am = await t.client.addMessages(`${TO}--deploy--1`, [
      {
        peer_id: TO,
        content: "we chose sqlite",
        created_at: T1,
        metadata: { client_id: "x1", kind: "decision", mission: "deploy", copied_from: FROM, original_at: T1 },
      },
    ]);
    expect(am.ok).toBe(true);
    const res = await runCopy(t.args, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts).toMatchObject({ found: 3, created: 2, skipped: 1 });
    // freeN saw the existing deploy session -> the new copies land at n=2
    expect(t.fake.state.sessions.get(`${WS}/${TO}--deploy--2`)).toBeDefined();
    expect(msgsOf(t.fake, `${TO}--deploy--2`).length).toBe(1); // the chunked decision only
  });

  test("paging: with 105 decisions in one session (last on page 2) every one is found and copied", async () => {
    const t = await mk();
    const cs = await t.client.createSession(`${FROM}--deploy--1`, sessionSeed(FROM, "deploy"));
    expect(cs.ok).toBe(true);
    // 105 decision messages in one session, batched like the writer (100 + 5):
    // the server-side filter still leaves 105 matches, so the decision list
    // spans two pages and the 105th (the marker) is on page 2 - a capped
    // read would silently miss it (architect ruling 03:42Z)
    const batch = (from: number, n: number) => ({
      messages: Array.from({ length: n }, (_, i) => {
        const k = from + i;
        return {
          peer_id: FROM,
          content: `standing decision number ${k}`,
          created_at: T1,
          metadata: { client_id: `p-${k}`, kind: "decision", mission: "deploy" },
        };
      }),
    });
    const a1 = await t.client.addMessages(`${FROM}--deploy--1`, batch(1, 100).messages);
    expect(a1.ok).toBe(true);
    const a2 = await t.client.addMessages(`${FROM}--deploy--1`, [
      ...batch(101, 4).messages,
      {
        peer_id: FROM,
        content: "decision number 105 was on page two",
        created_at: T1,
        metadata: { client_id: "p-105", kind: "decision", mission: "deploy" },
      },
    ]);
    expect(a2.ok).toBe(true);
    const res = await runCopy(t.args, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts).toMatchObject({ found: 105, created: 105, skipped: 0 });
    expect(res.counts.pages).toBeGreaterThan(1); // the page walk really walked
    const toConcl = conclContents(t.fake, TO);
    expect(toConcl.length).toBe(105);
    expect(toConcl).toContain("decision number 105 was on page two");
    expect(toConcl).toContain("standing decision number 1");
    expect(toConcl).toContain("standing decision number 104");
    // one second pass stays idempotent across the paged read too
    const second = await runCopy(t.args, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.counts).toMatchObject({ found: 105, created: 0, skipped: 105 });
  });

  test("no card on the from-peer: ok with 0 card items, no PUT", async () => {
    const t = await mk();
    await seedDecision(t.client, `${FROM}--deploy--1`, "deploy", "solo fact", "c9", T1);
    const res = await runCopy(t.args, () => {}, () => "2026-11-02T04:00:00.000Z");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts).toMatchObject({ found: 1, created: 1, cardItems: 0, cardCopied: false });
    expect(t.fake.state.peerCards.get(`${WS}/${TO}`)).toBeUndefined();
  });
});
