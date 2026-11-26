// B10 (ADR-0022 decision 3): the shown/used id channel. The grammar gate,
// the list parse, and the per-session state file (0600 in a 0700 dir, merged,
// capped at 40 newest, pruned past a day). Local temp dirs only - shown.ts is
// pure local IO and never touches the network or a Honcho workspace.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShownList, readShown, recordShown, shownEntry, shownId } from "../../plugin/src/shown.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "shown-test-"));
const DAY_MS = 24 * 3_600_000;
const hash = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

test("shownEntry: five kinds under strict grammars, everything else rejected", () => {
  expect(shownEntry("decision", "d-0a0b0c0d")).toBe("decision:d-0a0b0c0d");
  expect(shownEntry("approval", "d-deadbeef")).toBe("approval:d-deadbeef");
  expect(shownEntry("lesson", "qitem-20261126033123-b1d597bc0111f573")).toBe(
    "lesson:qitem-20261126033123-b1d597bc0111f573",
  );
  expect(shownEntry("pointer", "qitem-20261126033123-fa23880114985030")).toBe(
    "pointer:qitem-20261126033123-fa23880114985030",
  );
  expect(shownEntry("conclusion", "server:id-7")).toBe("conclusion:server:id-7");
  // status is never a shown kind (row B10); unknown kinds never are
  expect(shownEntry("status", "d-0a0b0c0d")).toBeUndefined();
  expect(shownEntry("unknown", "x")).toBeUndefined();
  // per-kind id grammars
  expect(shownEntry("decision", "d-0a0b0c0g")).toBeUndefined(); // not hex
  expect(shownEntry("decision", "d-0a")).toBeUndefined(); // wrong length
  expect(shownEntry("lesson", "qitem-2026-b1d5")).toBeUndefined(); // not a queue id
  expect(shownEntry("conclusion", "x".repeat(101))).toBeUndefined(); // 100-char cap
  expect(shownEntry("conclusion", "a/b")).toBeUndefined(); // slash smells like a path
  expect(shownEntry("conclusion", "")).toBeUndefined();
  expect(shownEntry("decision", 7)).toBeUndefined();
  expect(shownId("decision:d-0a0b0c0d")).toBe("d-0a0b0c0d");
  expect(shownId("conclusion:server:id-7")).toBe("server:id-7"); // split at the FIRST colon
  expect(shownId("nocolon")).toBe("");
});

test("parseShownList: dedup, sorted, capped; undefined unless one valid entry", () => {
  expect(parseShownList(undefined)).toBeUndefined();
  expect(parseShownList([])).toBeUndefined();
  expect(parseShownList(["junk", "nocolon", ":x", 7])).toBeUndefined();
  const v = parseShownList([
    "lesson:qitem-20261126033123-b1d597bc0111f573",
    "decision:d-0a0b0c0d",
    "decision:d-0a0b0c0d", // dup
    "status:d-0a0b0c0d", // invalid kind: dropped
  ]);
  expect(v).toEqual(["decision:d-0a0b0c0d", "lesson:qitem-20261126033123-b1d597bc0111f573"]);
  const many = Array.from({ length: 60 }, (_, i) => `conclusion:c${i}`);
  expect(parseShownList(many)?.length).toBe(40); // default cap
});

test("recordShown/readShown: roundtrip, merge, 0600 in 0700, cap 40 newest", async () => {
  const dir = tmp();
  await recordShown(dir, "ws", "sess-1", ["decision:d-00000001", "decision:d-00000002"]);
  const f = join(dir, "ws", "shown", `${hash("sess-1")}.json`);
  expect(existsSync(f)).toBe(true);
  expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "ws", "shown")).mode & 0o777).toBe(0o700);
  await recordShown(dir, "ws", "sess-1", ["decision:d-00000002", "lesson:qitem-20261126033123-b1d597bc0111f573"]);
  expect(readShown(dir, "ws", "sess-1")).toEqual([
    "decision:d-00000001",
    "decision:d-00000002",
    "lesson:qitem-20261126033123-b1d597bc0111f573",
  ]);
  const many = Array.from({ length: 50 }, (_, i) => `conclusion:c${String(i).padStart(2, "0")}`);
  await recordShown(dir, "ws", "sess-2", many);
  const kept = readShown(dir, "ws", "sess-2");
  expect(kept.length).toBe(40);
  expect(kept).toContain("conclusion:c49"); // newest kept
  expect(kept).not.toContain("conclusion:c00");
  // empty session and unknown session: nothing, no throw
  await recordShown(dir, "ws", "", ["decision:d-00000003"]);
  expect(readShown(dir, "ws", "")).toEqual([]);
  expect(readShown(dir, "ws", "never-seen")).toEqual([]);
});
test("recordShown keeps INSERTION order in the file: the cap drops the oldest, not the alphabetically first (B11 fix)", async () => {
  const dir = tmp();
  // 40 entries, newest inserted LAST but sorting FIRST (c00 newest, c39 oldest)
  const seed = Array.from({ length: 40 }, (_, i) => `conclusion:c${String(39 - i).padStart(2, "0")}`);
  await recordShown(dir, "ws", "s1", seed);
  const f = join(dir, "ws", "shown", `${hash("s1")}.json`);
  expect((JSON.parse(readFileSync(f, "utf8")) as { ids: string[] }).ids.at(-1)).toBe("conclusion:c00");
  // one more record pushes the cap: the OLDEST (c39) goes, the NEWEST survive
  await recordShown(dir, "ws", "s1", ["conclusion:c40"]);
  const ids = (JSON.parse(readFileSync(f, "utf8")) as { ids: string[] }).ids;
  expect(ids.length).toBe(40);
  expect(ids).toContain("conclusion:c00"); // newest-before-cap survives
  expect(ids).not.toContain("conclusion:c39"); // oldest dropped, not c00 as sorted-order would do
  expect(ids.at(-1)).toBe("conclusion:c40");
  // re-shown entry moves to the end
  await recordShown(dir, "ws", "s1", ["conclusion:c10"]);
  expect((JSON.parse(readFileSync(f, "utf8")) as { ids: string[] }).ids.at(-1)).toBe("conclusion:c10");
});

// R27 F-V3: the read-merge-write now runs under withLock. Two real hook
// processes for one session are separate processes, so the pin spawns:
// 20 distinct valid ids each, same session file, both must survive.
// Repeated 7 times - one race sample is not a PASS (learned rule).
test("F-V3 (R27): two concurrent recordShown spawns keep all 40 entries (7 rounds)", async () => {
  const dir = tmp();
  const mod = join(import.meta.dir, "..", "..", "plugin", "src", "shown.ts");
  const mk = (p: string): string[] =>
    Array.from({ length: 20 }, (_, i) => `decision:d-${p}${String(i).padStart(4, "0")}`);
  const lists = [mk("aaaa"), mk("bbbb")];
  const script = (list: string[]): string =>
    `import { recordShown } from ${JSON.stringify(mod)}; await recordShown(${JSON.stringify(dir)}, "ws", SESSION, ${JSON.stringify(list)});`;
  const counts: number[] = [];
  for (let round = 0; round < 7; round++) {
    const session = `race-${round}`;
    const kids = lists.map((list) =>
      Bun.spawn([process.execPath, "-e", script(list).replace("SESSION", JSON.stringify(session))]),
    );
    const codes = await Promise.all(kids.map((k) => k.exited));
    expect(codes).toEqual([0, 0]);
    counts.push(readShown(dir, "ws", session).length);
  }
  expect(counts).toEqual([40, 40, 40, 40, 40, 40, 40]);
  // no .tmp litter in shown/, no stale lock file in locks/
  const wsDir = join(dir, "ws");
  expect(existsSync(join(wsDir, "locks"))).toBe(true);
  expect(existsSync(join(wsDir, "locks", "lock"))).toBe(false);
  expect(readdirSync(join(wsDir, "shown")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  // shown/ itself never holds a lock file (the locks/ decision, probe A10)
  expect(readdirSync(join(wsDir, "shown")).some((f) => f === "lock")).toBe(false);
});

test("readShown: corrupt or junk state files read as []", async () => {
  const dir = tmp();
  await recordShown(dir, "ws", "s", ["decision:d-0000000a"]);
  const f = join(dir, "ws", "shown", `${hash("s")}.json`);
  writeFileSync(f, "{not json");
  expect(readShown(dir, "ws", "s")).toEqual([]);
  writeFileSync(f, JSON.stringify({ ids: ["garbage", "status:d-0000000a"] }));
  expect(readShown(dir, "ws", "s")).toEqual([]);
});

test("pruneShown: day-old session files die on the next write, fresh ones live", async () => {
  const dir = tmp();
  await recordShown(dir, "ws", "old", ["decision:d-0000000b"]);
  await recordShown(dir, "ws", "fresh", ["decision:d-0000000c"]);
  const shown = join(dir, "ws", "shown");
  const dayAgoS = (Date.now() - DAY_MS) / 1000 - 120;
  utimesSync(join(shown, `${hash("old")}.json`), dayAgoS, dayAgoS);
  utimesSync(join(shown, ".pruned"), dayAgoS, dayAgoS); // the rate-limit stamp too
  await recordShown(dir, "ws", "fresh", ["decision:d-0000000d"]);
  expect(existsSync(join(shown, `${hash("old")}.json`))).toBe(false);
  expect(readShown(dir, "ws", "fresh")).toEqual(["decision:d-0000000c", "decision:d-0000000d"]);
});
