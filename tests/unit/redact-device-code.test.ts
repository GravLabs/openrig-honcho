// T16c (ADR-0011 decision 6): the device-code rule. HARD LIMIT: every code
// here is an obvious fake (the brief names ABCD1234X as the style) - a real
// sign-in code never enters source or tests. Pure: no env, no files, no
// network. The kept/masked split and the ~200-char context window follow the
// brief verbatim; boundary cases pin the interpretation edges.

import { describe, expect, test } from "bun:test";
import { redact } from "../../plugin/src/redact.ts";

describe("device-code (T16c)", () => {
  test("brief masked case 1: code + devicelogin URL, words around stay", () => {
    const r = redact("code ABCD1234X for https://microsoft.com/devicelogin");
    expect(r.text).toBe("code [REDACTED:device-code] for https://microsoft.com/devicelogin");
    expect(r.text).not.toContain("ABCD1234X");
    expect(r.counts["device-code"]).toBe(1);
  });

  test("brief masked case 2: the device code phrase", () => {
    const r = redact("enter the device code WXYZ5678 to sign in");
    expect(r.text).toBe("enter the device code [REDACTED:device-code] to sign in");
    expect(r.counts["device-code"]).toBe(1);
  });

  test("brief masked case 3: multi-line, code on the line after devicelogin", () => {
    const r = redact(
      "sign in at https://microsoft.com/devicelogin\nthe code WERTY1234 expires in 15 minutes",
    );
    expect(r.text).toContain("[REDACTED:device-code]");
    expect(r.text).not.toContain("WERTY1234");
    expect(r.text).toContain("expires in 15 minutes");
    expect(r.counts["device-code"]).toBe(1);
  });

  test("brief kept case 1: commit-ish word, no context", () => {
    const r = redact("RELEASE1 is tagged");
    expect(r.text).toBe("RELEASE1 is tagged");
    expect(r.counts["device-code"]).toBeUndefined();
  });

  test("brief kept case 2: upper-case acronym, no context", () => {
    const r = redact("HTTP2PRO");
    expect(r.text).toBe("HTTP2PRO");
    expect(r.counts["device-code"]).toBeUndefined();
  });

  test("boundary: all digits near devicelogin is not the shape", () => {
    const r = redact("go to devicelogin and enter 12345678");
    expect(r.text).toBe("go to devicelogin and enter 12345678");
    expect(r.counts["device-code"]).toBeUndefined();
  });

  test("boundary: all letters with context but NOT after the word code", () => {
    const r = redact("open the device login and watch CONFIRMED appear");
    expect(r.text).toBe("open the device login and watch CONFIRMED appear");
    expect(r.counts["device-code"]).toBeUndefined();
  });

  test("boundary: all letters right after the word code with context is masked", () => {
    const r = redact("visit devicelogin, code OVERNITE please");
    expect(r.text).toBe("visit devicelogin, code [REDACTED:device-code] please");
    expect(r.counts["device-code"]).toBe(1);
  });

  test("boundary: shape and context but 250+ chars apart is kept", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(15); // 375 lower-case chars
    const r = redact(`sign in with code ABCD1234X ${filler}then visit https://microsoft.com/devicelogin`);
    expect(r.text).toContain("ABCD1234X");
    expect(r.counts["device-code"]).toBeUndefined();
  });

  test("boundary: 10-char run is kept even right next to devicelogin", () => {
    const r = redact("devicelogin code ABCDE12345 now");
    expect(r.text).toBe("devicelogin code ABCDE12345 now");
    expect(r.counts["device-code"]).toBeUndefined();
  });

  test("two codes in one message: both masked, counter is 2", () => {
    const r = redact("presented codes ABCD1234X and QRST4567 at https://microsoft.com/devicelogin");
    expect(r.text).not.toContain("ABCD1234X");
    expect(r.text).not.toContain("QRST4567");
    expect(r.counts["device-code"]).toBe(2);
  });

  test("idempotent: redacting the output again masks nothing new", () => {
    const once = redact("enter the device code WXYZ5678 to sign in");
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.counts["device-code"]).toBeUndefined();
  });
});
