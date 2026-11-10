// C5c: the trusted_hash recipe, pinned to REAL oracles - not to our own
// output. The fingerprint vector is a Rust-computed constant from
// codex-rs/config/src/fingerprint_tests.rs:23 (tag rust-v0.167.0).

import { describe, expect, test } from "bun:test";
import {
  codexEventLabel,
  codexHookKey,
  codexNormalizedTimeout,
  codexTrustedHash,
  versionForToml,
} from "../../plugin/src/codex-trust.ts";

describe("C5c: version_for_toml against the Rust golden vector", () => {
  test("reproduces the hash Rust reports for its fingerprint test value", () => {
    // The Rust test parses these three TOML orderings and hashes them; key
    // order must not matter (sort_all_objects).
    const value = {
      rows: [
        { z: 2, a: 1 },
        { z: 4, a: 3 },
      ],
      nested: { z: "text", a: true },
    };
    expect(versionForToml(value)).toBe(
      "sha256:a5e4c8fbdbc75d185b0f2b5291bfb2de10e8c523d6c89248876fd78a97c83176", // fake-secret
    );
    // key order in our input changes nothing (arrays keep their order)
    const reordered = {
      nested: { a: true, z: "text" },
      rows: [
        { a: 1, z: 2 },
        { a: 3, z: 4 },
      ],
    };
    expect(versionForToml(reordered)).toBe(versionForToml(value));
  });
});

describe("C5c: key shape (hooks/src/lib.rs:125-135)", () => {
  test("path:event_snake:group:handler", () => {
    expect(codexHookKey("/seat/.codex/hooks.json", "SessionStart", 0, 0)).toBe(
      "/seat/.codex/hooks.json:session_start:0:0",
    );
    expect(codexHookKey("/s/.codex/hooks.json", "UserPromptSubmit", 1, 0)).toBe(
      "/s/.codex/hooks.json:user_prompt_submit:1:0",
    );
    expect(codexHookKey("/s/.codex/hooks.json", "Stop", 0, 0)).toBe(
      "/s/.codex/hooks.json:stop:0:0",
    );
    expect(codexEventLabel("NoSuchEvent")).toBe(null);
    expect(() => codexHookKey("/x", "NoSuchEvent", 0, 0)).toThrow();
  });
});

describe("C5c: identity hash shape", () => {
  test("a known identity hashes over exactly the sorted compact JSON", () => {
    // Recompute by hand from the documented recipe, independently of the
    // module: sorted keys, no spaces, matcher ABSENT when null (the TOML
    // serialization drops None), async PRESENT when false.
    const handJson =
      '{"event_name":"stop","hooks":[{"async":true,"command":"bun run /p/bin/stop.ts --harness codex --settings \\"/s/.codex/openrig-honcho/settings.json\\"","timeout":30,"type":"command"}]}';
    const expected = `sha256:${require("node:crypto")
      .createHash("sha256")
      .update(handJson, "utf8")
      .digest("hex")}`;
    expect(
      codexTrustedHash("Stop", null, {
        command: 'bun run /p/bin/stop.ts --harness codex --settings "/s/.codex/openrig-honcho/settings.json"',
        timeoutSec: 30,
        async: true,
      }),
    ).toBe(expected);
  });

  test("matcher present, and a matcher change flips the hash", () => {
    const h = (matcher: string | null): string =>
      codexTrustedHash("SessionStart", matcher, {
        command: "bun run /p/bin/session-start.ts",
        timeoutSec: 8,
        async: false,
      });
    const withMatcher = h("startup|resume|clear|compact|fork");
    expect(withMatcher).not.toBe(h(null));
    expect(withMatcher).not.toBe(h("startup"));
    // async is part of the identity too
    expect(
      codexTrustedHash("Stop", null, { command: "x", timeoutSec: 30, async: true }),
    ).not.toBe(codexTrustedHash("Stop", null, { command: "x", timeoutSec: 30, async: false }));
    // and so is the timeout
    expect(
      codexTrustedHash("Stop", null, { command: "x", timeoutSec: 31, async: true }),
    ).not.toBe(codexTrustedHash("Stop", null, { command: "x", timeoutSec: 30, async: true }));
  });
});

describe("C5c: timeout normalization (discovery.rs:940-968)", () => {
  test("our events pass through, floor 1 and default 600; SessionEnd clamps", () => {
    expect(codexNormalizedTimeout("SessionStart", 8)).toBe(8);
    expect(codexNormalizedTimeout("UserPromptSubmit", undefined)).toBe(600);
    expect(codexNormalizedTimeout("Stop", 0)).toBe(1);
    expect(codexNormalizedTimeout("SessionEnd", 99)).toBe(3);
    expect(codexNormalizedTimeout("Interrupt", undefined)).toBe(1);
  });
});
