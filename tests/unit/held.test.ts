// T18b (ADR-0013 decision 2, ruling 15:27Z option c): the private held
// file - append, mode, and the newest-200 / 1 MB pruning. No spawning:
// appendHeld is a pure file helper; the hook wiring is pinned in
// recall-holdout.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHeld, HELD_MAX_BYTES, HELD_MAX_ENTRIES, heldPath, type HeldEntry } from "../../plugin/src/held.ts";

const dir = (): string => mkdtempSync(join(tmpdir(), "held-"));

const entry = (i: number, text = "small"): HeldEntry => ({
  ts: `2026-11-04T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  session: `sess-${i}`,
  prompt_sha256: String(i).toString(16).padStart(64, "0"),
  n_items: 1,
  text,
});

describe("T18b held file", () => {
  test("path follows the seat-state convention", () => {
    expect(heldPath("/s", "ws", "build")).toBe(join("/s", "ws", "seats", "build.held.jsonl"));
  });

  test("first append creates 0600 in a 0700 seats dir and parses back", () => {
    const s = dir();
    const file = join(s, "ws", "seats", "build.held.jsonl");
    appendHeld(file, entry(1));
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(s, "ws", "seats")).mode & 0o777).toBe(0o700);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]) as HeldEntry).session).toBe("sess-1");
  });

  test("entry cap: after 250 appends only the newest 200 remain", () => {
    const s = dir();
    const file = join(s, "ws", "seats", "build.held.jsonl");
    for (let i = 0; i < 250; i++) appendHeld(file, entry(i));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(HELD_MAX_ENTRIES);
    const sessions = lines.map((l) => (JSON.parse(l) as HeldEntry).session);
    expect(sessions[0]).toBe(`sess-${250 - HELD_MAX_ENTRIES}`); // oldest kept
    expect(sessions[HELD_MAX_ENTRIES - 1]).toBe("sess-249"); // newest kept
    expect(sessions).not.toContain("sess-0"); // oldest pruned
  });

  test("entry cap on a pre-filled file: append prunes to 200 at once", () => {
    const s = dir();
    mkdirSync(join(s, "ws", "seats"), { recursive: true, mode: 0o700 });
    const file = join(s, "ws", "seats", "build.held.jsonl");
    writeFileSync(
      file,
      Array.from({ length: 250 }, (_, i) => JSON.stringify(entry(i))).join("\n") + "\n",
    );
    appendHeld(file, entry(999));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(HELD_MAX_ENTRIES);
    expect((JSON.parse(lines[lines.length - 1]) as HeldEntry).session).toBe("sess-999");
  });

  test("byte cap: kept content stays at or under 1 MB, newest-first", () => {
    const s = dir();
    mkdirSync(join(s, "ws", "seats"), { recursive: true, mode: 0o700 });
    const file = join(s, "ws", "seats", "build.held.jsonl");
    const big = "x".repeat(10_000);
    // ~1.12 MB pre-filled (each line ~10.1 KB, uniquely tagged): over the
    // byte cap, so the append must prune from the oldest end.
    writeFileSync(
      file,
      Array.from({ length: 110 }, (_, i) => JSON.stringify(entry(i, `${i}:${big}`))).join("\n") + "\n",
    );
    appendHeld(file, entry(1000, `last:${big}`));
    const raw = readFileSync(file, "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(HELD_MAX_BYTES);
    const lines = raw.trim().split("\n");
    expect((JSON.parse(lines[lines.length - 1]) as HeldEntry).text.startsWith("last:")).toBe(true);
    // the surviving head is a SUFFIX of the original order (pruned oldest first)
    const firstKept = (JSON.parse(lines[0]) as HeldEntry).text.split(":")[0];
    expect(Number(firstKept)).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(111); // some lines were pruned
    expect(lines.length).toBeGreaterThan(80); // newest always kept, bulk survives
  });

  test("a corrupt existing file is not fatal: the new entry lands, eval-use skips bad lines", () => {
    const s = dir();
    mkdirSync(join(s, "ws", "seats"), { recursive: true, mode: 0o700 });
    const file = join(s, "ws", "seats", "build.held.jsonl");
    writeFileSync(file, "{broken line\n}{also broken");
    appendHeld(file, entry(2));
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBe(3); // bad lines kept verbatim, newest entry appended
    const parseable = lines
      .map((l) => {
        try {
          return JSON.parse(l) as HeldEntry;
        } catch {
          return undefined;
        }
      })
      .filter((x): x is HeldEntry => x !== undefined);
    expect(parseable.length).toBe(1);
    expect(parseable[0].session).toBe("sess-2");
  });
});
