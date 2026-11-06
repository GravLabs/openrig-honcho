// T17a (architect brief 2026-11-02) build-owned unit tests for
// scripts/copy-peer-memory.ts, entirely against the fake server - no real
// server, no scratch workspace touched (the scratch integration is a
// separate file and runs only with the architect told first).
//
// T27 (architect 2026-11-06 04:33Z): the script carries the RESERVED-PAIR
// ledger entries (observer = the leader, observed = openrig-ledger) - the
// post-T24 truth. Seeds here write pair conclusions directly (the same
// addConclusion door the reader pins use); deriver look-alikes on the SELF
// pair and plain conclusions on the pair must never be carried, and the
// in-force set must compute identical before and after a copy (a superseded
// and a retired entry ride the links inside the content).

import { describe, expect, test } from "bun:test";
import { createClient } from "../../plugin/src/honcho.ts";
import { parseArgs, runCopy, type CopyArgs } from "../../scripts/copy-peer-memory.ts";
import { LEDGER_PEER, formatEntry, formatRetire, parseEntry, toEntries, inForceFor } from "../../plugin/src/ledger.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const FROM = "dev-arch";
const TO = "design-arch";

const mk = async () => {
  const fake: FakeHoncho = await startFakeHoncho();
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const args: CopyArgs = { url: fake.url, workspace: WS, apiKey: "k", from: FROM, to: TO, apply: true };
  return { fake, client, args };
};

/** Pair entry straight into the fake state (bypasses the create route's
 * peer precondition like every reader pin does). */
const seedPair = (
  fake: FakeHoncho,
  peer: string,
  session: string,
  content: string,
  at = "2026-10-01T00:00:00.000Z",
): void => {
  fake.addConclusion(WS, {
    content,
    observer_id: peer,
    observed_id: LEDGER_PEER,
    session_id: session,
    created_at: at,
  });
};

const dec = (id: string, fact: string, scope = "mission", supersedes?: string): string =>
  formatEntry({ kind: "decision", id, scope, fact, ...(supersedes !== undefined ? { supersedes } : {}) });

const pairRows = (fake: FakeHoncho, peer: string): Array<Record<string, unknown>> =>
  (fake.state.conclusions.get(WS) ?? []).filter(
    (c) => c.observer_id === peer && c.observed_id === LEDGER_PEER,
  ) as Array<Record<string, unknown>>;
const pairContents = (fake: FakeHoncho, peer: string): string[] =>
  pairRows(fake, peer).map((c) => String(c.content));
const conclTotal = (fake: FakeHoncho): number =>
  [...fake.state.conclusions.values()].reduce((a, l) => a + l.length, 0);

/** The standard seed: deploy keeps a supersede chain (only d-aaaa0002 is
 * in force), general has a retired entry (nothing in force), plus a
 * rig-scoped entry visible everywhere, a PLAIN pair conclusion and a
 * self-pair look-alike - neither of which is ever carried. */
async function seedStandard(fake: FakeHoncho): Promise<void> {
  seedPair(fake, FROM, `${FROM}--deploy--1`, dec("d-aaaa0001", "we chose sqlite"));
  seedPair(
    fake,
    FROM,
    `${FROM}--deploy--1`,
    dec("d-aaaa0002", "we chose postgres", "mission", "d-aaaa0001"),
    "2026-10-02T00:00:00.000Z",
  );
  seedPair(fake, FROM, `${FROM}--general--1`, dec("d-cccc0003", "ship on friday"));
  seedPair(fake, FROM, `${FROM}--general--1`, formatRetire("d-cccc0003", "superseded by calendar"));
  seedPair(fake, FROM, `${FROM}--deploy--1`, dec("d-eeee0005", "no force pushes", "rig"));
  seedPair(fake, FROM, `${FROM}--deploy--1`, "a plain recall note - never an entry");
  // the 818/856 shape: deriver look-alike on the SELF pair
  fake.addConclusion(WS, {
    content: "derived noise, never a decision",
    observer_id: FROM,
    observed_id: FROM,
    session_id: `${FROM}--deploy--1`,
  });
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

describe("T27 pair copy against the fake server", () => {
  test("apply: entries land verbatim on the to pair; plain and look-alikes never; card renamed", async () => {
    const { fake, args } = await mk();
    await seedStandard(fake);
    fake.setPeerCard(WS, FROM, [
      `${FROM} leads the deploy work`,
      "the ex-dev-arch-x note stays verbatim",
      "plain line",
    ]);
    const res = await runCopy(args, () => {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(`${res.fact} / ${res.reason} / ${res.fix}`);
    // 6 pair rows, 1 plain -> found counts ENTRIES only (sqlite, postgres,
    // ship, retire, rig-entry)
    expect(res.counts).toMatchObject({ missions: 2, found: 5, created: 5, skipped: 0, cardItems: 3 });
    const to = pairContents(fake, TO);
    // every VALID-HEADER entry of the from pair rides over verbatim
    for (const c of pairRows(fake, FROM)) {
      if (parseEntry(String(c.content)).kind === "plain") continue;
      expect(to).toContain(String(c.content));
    }
    expect(to.some((c) => c.includes("plain recall note"))).toBe(false); // never an entry
    expect(to.some((c) => c.includes("derived noise"))).toBe(false); // self pair never read
    const card = fake.state.peerCards.get(`${WS}/${TO}`) ?? [];
    expect(card).toContain(`${TO} leads the deploy work`);
    expect(card).toContain("the ex-dev-arch-x note stays verbatim");
  });

  test("the in-force set computes IDENTICAL before and after, superseded and retired included", async () => {
    const { fake, args } = await mk();
    await seedStandard(fake);
    const res = await runCopy(args, () => {});
    expect(res.ok).toBe(true);
    const before = (mission: string): string[] =>
      inForceFor(toEntries(pairRows(fake, FROM) as never), mission).map((e) => e.id).sort();
    const after = (mission: string): string[] =>
      inForceFor(toEntries(pairRows(fake, TO) as never), mission).map((e) => e.id).sort();
    // deploy: postgres (sqlite superseded) + the rig entry; general: ship
    // retired out; the ids ride the verbatim content unchanged
    expect(before("deploy")).toEqual(["d-aaaa0002", "d-eeee0005"]);
    expect(after("deploy")).toEqual(before("deploy"));
    expect(before("general")).toEqual(["d-eeee0005"]);
    expect(after("general")).toEqual(before("general"));
    expect(after("general")).not.toContain("d-cccc0003");
  });

  test("idempotency: a second apply creates nothing (skipped = found), state unchanged", async () => {
    const { fake, args } = await mk();
    await seedStandard(fake);
    const first = await runCopy(args, () => {});
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.fact);
    const totalAfterFirst = conclTotal(fake);
    const second = await runCopy(args, () => {});
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.fact);
    expect(second.counts).toMatchObject({ found: 5, created: 0, skipped: 5 });
    expect(conclTotal(fake)).toBe(totalAfterFirst);
  });

  test("dry run: same counts, ZERO writes", async () => {
    const { fake, args } = await mk();
    await seedStandard(fake);
    const total = conclTotal(fake);
    const res = await runCopy({ ...args, apply: false }, () => {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.fact);
    expect(res.counts).toMatchObject({ found: 5, created: 5, skipped: 0 });
    expect(res.dry).toBe(true);
    expect(conclTotal(fake)).toBe(total); // nothing written
    expect(pairContents(fake, TO)).toEqual([]);
  });

  test("paging: 105 entries in one mission (page 2 reached) are all found and copied", async () => {
    const { fake, args } = await mk();
    for (let i = 0; i < 105; i++) {
      seedPair(fake, FROM, `${FROM}--deploy--1`, dec(`d-${(0xe0000000 + i).toString(16)}`, `entry ${i}`));
    }
    const res = await runCopy(args, () => {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.fact);
    expect(res.counts).toMatchObject({ found: 105, created: 105, skipped: 0 });
    expect(pairContents(fake, TO).length).toBe(105);
    expect(res.counts.pages).toBeGreaterThanOrEqual(2);
  });

  test("an entry on an untagged session is counted, reported, and left in place", async () => {
    const { fake, args } = await mk();
    seedPair(fake, FROM, "loose-session-id", dec("d-abcd0001", "orphan entry"));
    seedPair(fake, FROM, `${FROM}--deploy--1`, dec("d-abcd0002", "normal entry"));
    const lines: string[] = [];
    const res = await runCopy(args, (l) => lines.push(l));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.fact);
    expect(res.counts).toMatchObject({ found: 2, created: 1, skipped: 0, missions: 1 });
    expect(lines.some((l) => l.includes("1 entries sit on sessions without"))).toBe(true);
    const to = pairContents(fake, TO);
    expect(to.length).toBe(1);
    expect(to[0]).toContain("d-abcd0002");
  });

  test("no card on the from-peer: ok with 0 card items, no PUT", async () => {
    const { fake, args } = await mk();
    seedPair(fake, FROM, `${FROM}--deploy--1`, dec("d-abca0001", "one entry"));
    const res = await runCopy(args, () => {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.fact);
    expect(res.counts).toMatchObject({ found: 1, created: 1, cardItems: 0, cardCopied: false });
  });
});
