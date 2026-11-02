// T16i (architect 2026-11-01 23:36Z): no file under tests/ may call
// makeTempDir (or trackTempDir) from inside a beforeAll block.
//
// Why: bun test v1.4.2 fires an afterAll registered INSIDE a beforeAll at
// the end of the beforeAll PHASE, not at file end (probe:
// /var/tmp/t16i-lifecycle-probe.test.ts). The temp dir is therefore deleted
// before the file's first test line - the v0.2.2 soak failure, where every
// seat freeN-minted an extra session against the missing state dir. The
// rule: create temp dirs at module or describe top level (collection
// scope), or inside a test body; both clean up at file end.
//
// The scan is deliberately simple (per the ruling): brace-balance each
// beforeAll( ... ) block and flag a call inside it. Full-line comments are
// skipped; this file is excluded from its own scan.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TESTS_DIR = join(import.meta.dir, "..");
const SELF = "unit/tempdir-beforeall-scan.test.ts";

// built by concatenation so a literal of the token never appears here
const CALL_RE = new RegExp("(?:make" + "TempDir|track" + "TempDir)\\s*\\(");
const HOOK_RE = new RegExp("\\bbefore" + "All\\s*\\(");

/** Scan the block that opens at lines[start] (a beforeAll line); return
 * the call lines found and the index of the line where braces balance. */
function scanBlock(lines: string[], start: number): { calls: string[]; end: number } {
  const calls: string[] = [];
  let depth = 0;
  let started = false;
  for (let j = start; j < lines.length; j += 1) {
    const line = lines[j];
    const body = line.trim();
    const isComment = body.startsWith("//") || body.startsWith("*");
    if (!isComment && CALL_RE.test(line)) calls.push(`${j + 1}:${body}`);
    for (const ch of line) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") depth -= 1;
    }
    if (started && depth <= 0) return { calls, end: j };
  }
  return { calls, end: lines.length - 1 };
}

const listTs = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

const violations = (): string[] => {
  const bad: string[] = [];
  for (const file of listTs(TESTS_DIR)) {
    const rel = relative(TESTS_DIR, file).replace(/\\/g, "/");
    if (rel === SELF) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const body = lines[i].trim();
      if (body.startsWith("//") || body.startsWith("*")) continue;
      if (!HOOK_RE.test(lines[i])) continue;
      const { calls, end } = scanBlock(lines, i);
      for (const c of calls) bad.push(`${rel}:${c}`);
      i = end;
    }
  }
  return bad;
};

test("no temp-dir call sits inside a beforeAll block under tests/", () => {
  expect(violations()).toEqual([]);
});

test("the scanner bites: a planted beforeAll call is reported, a comment and a test-body call are not", () => {
  const sample = [
    'describe("x", () => {',
    "  beforeAll(async () => {",
    '    // makeTempDir("in-a-comment-") must NOT count',
    '    dir = makeTempDir("planted-");',
    "  });",
    '  test("t", () => { dir2 = makeTempDir("in-test-"); });',
    "});",
  ];
  const hookAt = sample.findIndex((l) => HOOK_RE.test(l));
  expect(hookAt).toBe(1);
  const { calls, end } = scanBlock(sample, hookAt);
  expect(calls).toEqual(['4:dir = makeTempDir("planted-");']);
  expect(end).toBe(4); // the block closes before the test() line
});
