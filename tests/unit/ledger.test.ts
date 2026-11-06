// T19a (ADR-0014 d2 + amendment): the pure ledger module - format/parse
// round trip, id shape and derivation, transitive supersession, retire,
// scope grammar and the in-force view. No server, no files.

import { describe, expect, test } from "bun:test";
import {
  currentLedger,
  derivedId,
  entryBody,
  formatEntry,
  formatRetire,
  inForceFor,
  newDecisionId,
  parseEntry,
  supersededMap,
  toEntries,
  validId,
  validScope,
  type LedgerEntry,
} from "../../plugin/src/ledger.ts";

const dec = (id: string, fact = "use LoRa", over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id,
  kind: "decision",
  scope: "mission",
  mission: "sensor",
  fact,
  at: "2026-11-01T00:00:00Z",
  ...over,
});

describe("T19a ledger format/parse", () => {
  test("decision round trip", () => {
    const s = formatEntry({ kind: "decision", id: "d-1a2b3c4d", scope: "mission", fact: "use LoRa" });
    expect(s).toBe("[decision d-1a2b3c4d · scope mission] use LoRa");
    expect(parseEntry(s)).toEqual({ kind: "decision", id: "d-1a2b3c4d", scope: "mission", fact: "use LoRa" });
  });

  test("approval with reason and supersedes round trip", () => {
    const s = formatEntry({
      kind: "approval",
      id: "d-0f0f0f0f",
      scope: "qitem-20261103024649-e25e8b91965dce3a",
      supersedes: "d-1a2b3c4d",
      fact: "approve the winter test",
      reason: "owner said so on 2026-11-03",
    });
    expect(s).toBe(
      "[approval d-0f0f0f0f · scope qitem-20261103024649-e25e8b91965dce3a · supersedes d-1a2b3c4d] approve the winter test (reason: owner said so on 2026-11-03)",
    );
    expect(parseEntry(s)).toEqual({
      kind: "approval",
      id: "d-0f0f0f0f",
      scope: "qitem-20261103024649-e25e8b91965dce3a",
      supersedes: "d-1a2b3c4d",
      fact: "approve the winter test",
      reason: "owner said so on 2026-11-03",
    });
  });

  test("retire format and parse", () => {
    const s = formatRetire("d-1a2b3c4d", "no longer true");
    expect(s).toBe("[retire d-1a2b3c4d] no longer true");
    expect(parseEntry(s)).toEqual({ kind: "retire", target: "d-1a2b3c4d" });
  });

  test("multi-line fact survives the round trip", () => {
    const s = formatEntry({ kind: "decision", id: "d-abcd1234", scope: "rig", fact: "line one\nline two" });
    const p = parseEntry(s);
    expect(p.kind).toBe("decision");
    expect(p.kind === "decision" && p.fact).toBe("line one\nline two");
  });

  test("plain content parses plain (legacy conclusions)", () => {
    expect(parseEntry("ship on Fridays")).toEqual({ kind: "plain", fact: "ship on Fridays" });
  });

  test("a malformed header is treated as plain, never an error", () => {
    for (const bad of [
      "[decision zzzz] x", // bad id
      "[decision d-1234567] x", // 7 hex
      "[decision d-ABCDEF01] x", // uppercase
      "[decide d-1a2b3c4d] x", // unknown kind
      "[decision d-1a2b3c4d x", // unclosed
      "[] x", // empty
    ]) {
      expect(parseEntry(bad)).toEqual({ kind: "plain", fact: bad });
    }
  });

  test("a fact merely containing the reason shape stays a fact", () => {
    const s = formatEntry({ kind: "decision", id: "d-1a2b3c4d", scope: "mission", fact: "keep (reason: x) inline" });
    expect(parseEntry(s)).toMatchObject({ fact: "keep (reason: x) inline" });
  });
});

describe("T19a ledger ids and scope grammar", () => {
  test("id shape and determinism", () => {
    const a = newDecisionId("lead", "2026-11-01T00:00:00Z", "use LoRa");
    expect(a).toMatch(/^d-[0-9a-f]{8}$/);
    expect(validId(a)).toBe(true);
    expect(a).toBe(newDecisionId("lead", "2026-11-01T00:00:00Z", "use LoRa"));
    expect(a).not.toBe(newDecisionId("lead", "2026-11-01T00:00:01Z", "use LoRa"));
    expect(a).not.toBe(newDecisionId("builder", "2026-11-01T00:00:00Z", "use LoRa"));
    expect(a).not.toBe(newDecisionId("lead", "2026-11-01T00:00:00Z", "use Zigbee"));
  });

  test("derived ids are stable and ledger-shaped", () => {
    expect(derivedId("concl-7")).toMatch(/^d-[0-9a-f]{8}$/);
    expect(derivedId("concl-7")).toBe(derivedId("concl-7"));
    expect(derivedId("concl-7")).not.toBe(derivedId("concl-8"));
  });

  test("scope: rig, mission and a queue item pass; anything else is refused", () => {
    for (const ok of ["rig", "mission", "qitem-20261103024649-e25e8b91965dce3a"]) expect(validScope(ok)).toBe(true);
    for (const bad of [
      "",
      "Mission",
      "missions",
      "rig ",
      "qitem-20261103024649-E25E8B91965DCE3A", // uppercase hex
      "qitem-2026110302464-e25e8b91965dce3a", // 13 digits
      "qitem-20261103024649-", // no hex
      "everything",
    ]) {
      expect(validScope(bad)).toBe(false);
    }
  });
});

describe("T19a currentLedger: supersession and retire", () => {
  test("direct supersession drops the old entry", () => {
    const cur = currentLedger([dec("d-cccccccc", "915", { supersedes: "d-aaaaaaaa" }), dec("d-aaaaaaaa")]);
    expect(cur.map((e) => e.id)).toEqual(["d-cccccccc"]);
  });

  test("supersession is transitive: A by B, B by C, leaves only C", () => {
    const cur = currentLedger([
      dec("d-cccccccc", "915", { supersedes: "d-bbbbbbbb" }),
      dec("d-bbbbbbbb", "868", { supersedes: "d-aaaaaaaa" }),
      dec("d-aaaaaaaa", "433"),
    ]);
    expect(cur.map((e) => e.id)).toEqual(["d-cccccccc"]);
  });

  test("retire drops the named entry; the retire entry itself is never shown", () => {
    const cur = currentLedger([
      { ...dec("x1"), kind: "retire", target: "d-aaaaaaaa", fact: "" },
      dec("d-bbbbbbbb"),
      dec("d-aaaaaaaa"),
    ]);
    expect(cur.map((e) => e.id)).toEqual(["d-bbbbbbbb"]);
  });

  test("a cycle retires itself: both named, neither current", () => {
    const cur = currentLedger([
      dec("d-aaaaaaaa", "a", { supersedes: "d-bbbbbbbb" }),
      dec("d-bbbbbbbb", "b", { supersedes: "d-aaaaaaaa" }),
    ]);
    expect(cur).toEqual([]);
  });

  test("supersededMap names the newest replacer; retire says retired", () => {
    const m = supersededMap([
      dec("d-cccccccc", "915", { supersedes: "d-bbbbbbbb" }),
      { ...dec("x1"), kind: "retire", target: "d-aaaaaaaa", fact: "" },
      dec("d-bbbbbbbb", "868", { supersedes: "d-aaaaaaaa" }),
      dec("d-aaaaaaaa", "433"),
    ]);
    expect(m.get("d-bbbbbbbb")).toBe("d-cccccccc");
    expect(m.get("d-aaaaaaaa")).toBe("retired"); // the retire came first (newer)
    expect(m.has("d-cccccccc")).toBe(false);
  });
});

describe("T19a toEntries and the in-force view", () => {
  const concl = (
    id: string,
    content: string,
    session: string,
    created_at = "2026-11-01T00:00:00Z",
  ) => ({ id, content, session_id: session, created_at });

  test("T24 (Amendment 2): a plain conclusion is NEVER an entry - dropped, no derived id", () => {
    // was "plain conclusions become legacy mission decisions with derived
    // ids" (T19a). Amendment 2 makes provenance structural: only a valid
    // header on the ledger pair is an entry; the derivedId mapping survives
    // in scripts/bench.ts only.
    expect(toEntries([concl("concl-1", "ship on Fridays", "lead--sensor--3")])).toEqual([]);
    expect(toEntries([concl("concl-2", "the leader decided shipping waits for a green gate", "lead--sensor--3")])).toEqual([]);
    // derivedId itself is unchanged (bench helper):
    expect(derivedId("concl-1")).toMatch(/^d-[0-9a-f]{8}$/);
  });

  test("T24: untagged sessions land in mission unknown (now via a valid header)", () => {
    const [e] = toEntries([
      concl("concl-2", formatEntry({ kind: "decision", id: "d-a1e0ffff", scope: "mission", fact: "x" }), "somestraysession"),
    ]);
    expect(e.mission).toBe("unknown");
  });

  test("header entries keep their fields; retire entries become retires", () => {
    const es = toEntries([
      concl("c1", formatEntry({ kind: "approval", id: "d-11111111", scope: "rig", fact: "approve OTA" }), "lead--sensor--1"),
      concl("c2", formatRetire("d-22222222", "stale"), "lead--sensor--1"),
    ]);
    expect(es[0]).toMatchObject({ id: "d-11111111", kind: "approval", scope: "rig", mission: "sensor" });
    expect(es[1].kind).toBe("retire");
    expect(es[1].target).toBe("d-22222222");
  });

  test("in force: this mission plus rig from any mission; item scope stays home", () => {
    const entries = toEntries([
      concl("r1", formatEntry({ kind: "decision", id: "d-a1e00001", scope: "rig", fact: "convention" }), "lead--power--2"),
      concl("m1", formatEntry({ kind: "decision", id: "d-a1e00002", scope: "mission", fact: "use LoRa" }), "lead--sensor--1"),
      concl(
        "i1",
        formatEntry({ kind: "approval", id: "d-a1e00003", scope: "qitem-20261103024649-e25e8b91965dce3a", fact: "go" }),
        "lead--sensor--1",
      ),
      concl("o1", formatEntry({ kind: "decision", id: "d-a1e00004", scope: "mission", fact: "other mission" }), "lead--power--2"),
    ]);
    expect(inForceFor(entries, "sensor").map((e) => e.id)).toEqual(["d-a1e00001", "d-a1e00002", "d-a1e00003"]);
    expect(inForceFor(entries, "power").map((e) => e.id)).toEqual(["d-a1e00001", "d-a1e00004"]);
  });

  test("in force hides what a rig-scope entry superseded in another mission", () => {
    const entries = toEntries([
      concl(
        "n1",
        formatEntry({ kind: "decision", id: "d-b0b00001", scope: "rig", supersedes: "d-b0b00002", fact: "915" }),
        "lead--power--1",
      ),
      concl("o1", formatEntry({ kind: "decision", id: "d-b0b00002", scope: "mission", fact: "868" }), "lead--sensor--1"),
    ]);
    expect(inForceFor(entries, "sensor").map((e) => e.id)).toEqual(["d-b0b00001"]);
  });

  test("entryBody re-renders fact plus reason", () => {
    expect(entryBody(dec("d-x", "use LoRa", { reason: "range" }))).toBe("use LoRa (reason: range)");
    expect(entryBody(dec("d-x", "use LoRa"))).toBe("use LoRa");
  });
});
