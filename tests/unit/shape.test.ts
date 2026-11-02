// T5b: shaping rules (ADR-0005 E2/E4/E5, ADR-0006 R2). Pure functions, no IO.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chunk, clientId, isAck, reasoningFor } from "../../plugin/src/shape.ts";

describe("chunk (E2)", () => {
  test("60k of paragraphs -> 3 chunks, each <= 24000, rejoin equal", () => {
    const para = "x".repeat(10000);
    const text = Array.from({ length: 6 }, (_, i) => `${para}${i}`).join("\n\n");
    expect(text.length).toBeGreaterThanOrEqual(60000);
    const cs = chunk(text);
    expect(cs.length).toBe(3);
    for (const c of cs) expect(c.length).toBeLessThanOrEqual(24000);
    expect(cs.join("")).toBe(text);
  });

  test("one 60000-char line with no separators -> hard cuts <= max, rejoin equal", () => {
    const text = "q".repeat(60000);
    const cs = chunk(text);
    expect(cs.map((c) => c.length)).toEqual([24000, 24000, 12000]);
    expect(cs.join("")).toBe(text);
  });

  test("text at or under max stays one chunk", () => {
    expect(chunk("hello", 10)).toEqual(["hello"]);
    expect(chunk("a".repeat(10), 10)).toHaveLength(1);
  });

  test("mixed paragraphs/lines/oversized runs: rejoin equals input, none over max", () => {
    const text = [
      "short para one",
      "line a\nline b\n" + "y".repeat(30000), // paragraph containing a line > max
      "z".repeat(30000), // paragraph with no separators at all
      "t".repeat(9000) + "\n" + "u".repeat(9000),
    ].join("\n\n");
    for (const max of [100, 24000]) {
      const cs = chunk(text, max);
      expect(cs.join("")).toBe(text);
      for (const c of cs) expect(c.length).toBeLessThanOrEqual(max);
    }
  });
});

describe("isAck (E5)", () => {
  test("the ack patterns, case-insensitive, under 40 chars", () => {
    for (const t of [
      "ok", "Ok.", "NO", "yes", "thanks", "done", "ACK", "acked",
      "standing by", "Ready", "noted", "T5 ready", "T4-fix-2 ready",
      "locking done", "task 3 done",
    ]) {
      expect(isAck(t)).toBe(true);
    }
  });

  test("not acks: length >= 40 or no pattern", () => {
    for (const t of [
      "",
      "ok but the spool replay needs a deadline guard", // > 40 chars
      "yes, and then rebuild the whole spool layer", // 38 chars, not a pattern
      "I am not sure that works",
      "the ticket is ready to review tomorrow",
      "Auth bug is not done", // E5 whole-text rule: ends in "done", is not an ack
    ]) {
      expect(isAck(t)).toBe(false);
    }
    expect(isAck("x".repeat(40))).toBe(false); // length is < 40, not <=
  });
});

describe("reasoningFor (E4/E5)", () => {
  const real = "the spool replay removed an accepted entry twice";
  test("acks never reason, whatever the kind", () => {
    expect(reasoningFor({ kind: "dm", to: ["b"], selfPeer: "b", content: "ok" })).toBe(false);
    expect(
      reasoningFor({ kind: "multi", to: ["a", "b"], selfPeer: "a", content: "T5 ready" }),
    ).toBe(false);
  });

  test("DM always reasons", () => {
    expect(reasoningFor({ kind: "dm", to: ["build"], selfPeer: "build", content: real })).toBe(true);
  });

  test("multi: only the recipient whose peer id sorts first", () => {
    const to = ["review", "architect", "build"];
    expect(reasoningFor({ kind: "multi", to, selfPeer: "architect", content: real })).toBe(true);
    expect(reasoningFor({ kind: "multi", to, selfPeer: "build", content: real })).toBe(false);
    expect(reasoningFor({ kind: "multi", to, selfPeer: "review", content: real })).toBe(false);
  });

  test("broadcast: only the leader reasons", () => {
    const base = { kind: "broadcast" as const, to: [], content: real, leaderPeer: "architect" };
    expect(reasoningFor({ ...base, selfPeer: "architect", senderPeer: "build" })).toBe(true);
    expect(reasoningFor({ ...base, selfPeer: "build", senderPeer: "build" })).toBe(false);
  });

  test("broadcast sent by the leader: every recipient reasons", () => {
    const base = { kind: "broadcast" as const, to: [], content: real, leaderPeer: "architect" };
    expect(reasoningFor({ ...base, selfPeer: "build", senderPeer: "architect" })).toBe(true);
    expect(reasoningFor({ ...base, selfPeer: "review", senderPeer: "architect" })).toBe(true);
  });

  test("broadcast with no leader configured: nobody reasons", () => {
    expect(
      reasoningFor({ kind: "broadcast", to: [], selfPeer: "build", content: real }),
    ).toBe(false);
  });
});

describe("clientId (R2)", () => {
  test("deterministic, 64-hex, changes with any part", () => {
    const a = clientId("build", "s--1", "2026-10-28T10:00:00Z", "hello");
    expect(a).toBe(clientId("build", "s--1", "2026-10-28T10:00:00Z", "hello"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(clientId("build", "s--2", "2026-10-28T10:00:00Z", "hello")).not.toBe(a);
    expect(clientId("build", "s--1", "2026-10-28T10:00:01Z", "hello")).not.toBe(a);
    expect(clientId("review", "s--1", "2026-10-28T10:00:00Z", "hello")).not.toBe(a);
    expect(clientId("build", "s--1", "2026-10-28T10:00:00Z", "hello!")).not.toBe(a);
  });

  test("is sha256 over the four parts joined with U+0000", () => {
    const parts = ["build", "s--1", "2026-10-28T10:00:00Z", "hello"];
    const want = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
    expect(clientId(...(parts as [string, string, string, string]))).toBe(want);
  });
});
