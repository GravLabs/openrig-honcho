// T19c (ADR-0014 decision 4): the shared term definition. The filter and
// the metric MUST agree on what a term is, so this file pins the single
// definition: the identical function/set objects re-exported by eval-use
// (the metric stays eval-use-v1.1 with unchanged results), the token
// grammar, the known-set collector (user/assistant TEXT only - tool
// inputs, tool results, thinking and metadata never become known), and
// the tail reader (last maxBytes from the end, unreadable = undefined).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { makeTempDir } from "../support/tempdir.ts";
import {
  GENERIC,
  TAIL_BYTES,
  knownTermsFromTranscript,
  readTranscriptTail,
  tokensOf,
} from "../../plugin/src/terms.ts";
import {
  GENERIC as GENERIC_EVAL,
  METRIC_VERSION,
  tokensOf as tokensOfEval,
} from "../../scripts/eval-use.ts";

describe("shared term module (terms.ts)", () => {
  test("eval-use re-exports the SAME GENERIC and tokensOf; metric unchanged", () => {
    expect(GENERIC_EVAL).toBe(GENERIC); // the identical Set object
    expect(tokensOfEval).toBe(tokensOf); // the identical function
    expect(METRIC_VERSION).toBe("eval-use-v1.1");
    expect(GENERIC.size).toBe(28);
    expect(GENERIC.has("context")).toBe(true);
    expect(GENERIC.has("mutation")).toBe(true);
    expect(GENERIC.has("antenna")).toBe(false);
  });

  test("token grammar: 6+ char words, 7+ hex, dotted versions; lowercased", () => {
    const t = tokensOf("Deploy LoRa gateway at 1.2.3 commit 1a2b3c4d, port 868");
    expect(t.has("deploy")).toBe(true); // 6 chars
    expect(t.has("gateway")).toBe(true);
    expect(t.has("1.2.3")).toBe(true); // standalone dotted version
    expect(t.has("1a2b3c4d")).toBe(true); // 8 hex
    expect(t.has("lora")).toBe(false); // 4 chars: not a term
    expect(t.has("868")).toBe(false); // bare number: not a term
    // metric-pinned shape: a WORD-prefixed version is absorbed by the word
    // branch (dots are word chars there) as one lowercased term.
    expect(tokensOf("ship v1.2.3 now").has("v1.2.3")).toBe(true);
    expect(tokensOf("ZEPHYRIUM").has("zephyrium")).toBe(true);
  });

  test("knownTermsFromTranscript: user/assistant text only; garbage skipped; message included", () => {
    const lines = [
      "not json at all", // garbage line
      '{"type":"assist', // a head-cut partial line
      JSON.stringify({ type: "user", message: { content: "check the zephyrium mount please" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "the antenna bracket is printed" },
            { type: "tool_use", name: "Bash", input: { command: "run kettleboard-thing" } },
            { type: "thinking", thinking: "tarpaulin covered reasoning" },
          ],
        },
        timestamp: "2026-11-04T10:00:00Z",
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "warehouse leak found" }] },
      }),
      JSON.stringify({ type: "system", message: { content: "friday system noise" } }),
      JSON.stringify({ type: "user", message: { content: "x" }, metadata: "zonthar metadata" }),
    ];
    const known = knownTermsFromTranscript(lines.join("\n"), "retune the kettleboard gate?");
    expect(known.has("zephyrium")).toBe(true); // user string content
    expect(known.has("antenna")).toBe(true); // assistant text part
    expect(known.has("kettleboard")).toBe(true); // from the INCOMING message
    expect(known.has("tarpaulin")).toBe(false); // thinking is not text
    expect(known.has("warehouse")).toBe(false); // tool_result is not text
    expect(known.has("friday")).toBe(false); // non-user/assistant entries
    expect(known.has("zonthar")).toBe(false); // metadata is never text
  });

  test("readTranscriptTail: missing or unreadable gives undefined (no filter)", () => {
    const dir = makeTempDir("terms-tail-");
    expect(readTranscriptTail(join(dir, "nope.jsonl"))).toBeUndefined();
    expect(readTranscriptTail(dir)).toBeUndefined(); // a directory is unreadable as a file
  });

  test("readTranscriptTail: small file whole; big file ONLY the last maxBytes", () => {
    const dir = makeTempDir("terms-tail-");
    const small = join(dir, "small.jsonl");
    writeFileSync(small, '{"type":"user","message":{"content":"small file marker"}}\n');
    expect(readTranscriptTail(small)).toContain("small file marker");

    const big = join(dir, "big.jsonl");
    const head = JSON.stringify({ type: "assistant", message: { content: "headpineapple lives only in the head" } });
    const tail = JSON.stringify({ type: "assistant", message: { content: "zephyrium antenna lives in the tail" } });
    const filler = JSON.stringify({ type: "user", message: { content: "padding filler entries " + "padding filler entries ".repeat(400) } });
    const parts = [head];
    while (Buffer.byteLength(parts.join("\n")) < TAIL_BYTES + 60_000) parts.push(filler);
    parts.push(tail);
    writeFileSync(big, parts.join("\n") + "\n");

    const got = readTranscriptTail(big);
    expect(got).toBeDefined();
    expect(Buffer.byteLength(got as string)).toBeLessThanOrEqual(TAIL_BYTES);
    expect(got).toContain("zephyrium");
    expect(got).not.toContain("headpineapple"); // outside the TAIL_BYTES window
    const known = knownTermsFromTranscript(got as string, "");
    expect(known.has("headpineapple")).toBe(false); // NOT known from the head
    expect(known.has("zephyrium")).toBe(true);
  });

  test("readTranscriptTail: a cut mid-multibyte does not throw", () => {
    const dir = makeTempDir("terms-tail-");
    const p = join(dir, "mb.jsonl");
    // File: [ASCII pad A bytes][e-acute, 2 bytes][tail B bytes]. Window
    // start = size - TAIL_BYTES = A + 1 when A + B = TAIL_BYTES - 1 - i.e. the window
    // opens on the SECOND byte of e-acute: an invalid leading byte.
    const tail = JSON.stringify({ type: "assistant", message: { content: "second tailmarker entry" } }) + "\n";
    const pad = "a".repeat(TAIL_BYTES - 1 - Buffer.byteLength(tail));
    writeFileSync(p, Buffer.concat([Buffer.from(pad, "utf8"), Buffer.from("é", "utf8"), Buffer.from(tail, "utf8")]));
    expect(readFileSync(p).length).toBeGreaterThan(TAIL_BYTES);
    const got = readTranscriptTail(p);
    expect(got).toBeDefined();
    expect(got).toContain("tailmarker");
    // the cut line does not parse and contributes no terms (silent skip):
    expect(knownTermsFromTranscript(got as string, "").has("tailmarker")).toBe(false);
    // ...and the same JSON line appended after a newline parses normally:
    expect(knownTermsFromTranscript("\n" + tail, "").has("tailmarker")).toBe(true);
  });
});
