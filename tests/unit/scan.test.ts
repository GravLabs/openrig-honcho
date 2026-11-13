// T8d-1 item 3 + T8c-fix item 5 tests: scripts/scan.ts on tmp git repos. A
// planted fake secret must FAIL the scan, a clean repo must PASS; the
// tests/ fake-secret marker rule (ADR-0007 a9ee84a), the skills list-only
// zone, the dependency checks and the one-subprocess rules each get their
// own repo.
// Nothing here contains a real secret: the fakes are secret-shaped test
// strings, and two of them are built by concatenation so this file's own
// tracked bytes stay match-free outside the low-confidence shapes.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { execSync } from "node:child_process";
import {  mkdirSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { render, scanRepo } from "../../scripts/scan.ts";

const REPO = new URL("../..", import.meta.url).pathname;

const mkRepo = (files: Record<string, string>): string => {
  const dir = makeTempDir("scan-test-");
  execSync("git init -q .", { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel).slice(0, join(dir, rel).lastIndexOf("/")), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync("git add -A", { cwd: dir });
  execSync('git -c user.email=scan@local -c user.name=scan commit -qm "fixture"', { cwd: dir });
  return dir;
};

// built by concatenation: the source line here must not itself match the
// anthropic shape (tests/ is a listed zone anyway - belt and braces)
const FAKE_ANTHROPIC = ["sk-ant-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("");
const FAKE_ASSIGN = ["API_TOKEN_STORED", "=", "leakedplaintextvalue987"].join("");

describe("scan.ts on tmp repos", () => {
  test("clean repo passes", () => {
    const dir = mkRepo({
      "README.md": "hello\n",
      "plugin/src/util.ts": "export const x = 1;\n" });
    const r = scanRepo(dir);
    expect(r.fails).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("planted anthropic fake outside the listed zones FAILS, value never printed", () => {
    const dir = mkRepo({ "keys.txt": `key = ${FAKE_ANTHROPIC}\n` });
    const r = scanRepo(dir);
    expect(r.ok).toBe(false);
    expect(r.fails.some((f) => f.file === "keys.txt" && f.kind === "anthropic")).toBe(true);
    expect(render(r)).not.toContain("A1b2C3d4"); // file:line:kind only
  });

  test("planted assignment fake: non-code value fails, code value only lists", () => {
    const bad = mkRepo({ "plugin/src/conf.ts": `const ${FAKE_ASSIGN};\n` });
    const rb = scanRepo(bad);
    expect(rb.ok).toBe(false);
    expect(rb.fails.some((f) => f.kind === "assignment")).toBe(true);
    expect(render(rb)).not.toContain("leakedplaintextvalue987");

    const good = mkRepo({
      "plugin/src/conf.ts": 'const API_TOKEN_REF = process.env["HONCHO_API_KEY"];\n' });
    const rg = scanRepo(good);
    expect(rg.ok).toBe(true);
    expect(rg.lists.some((f) => f.kind === "assignment")).toBe(true);
  });

  test("tests/ marker rule (ADR-0007 a9ee84a): unmarked high-confidence fake FAILS", () => {
    const dir = mkRepo({ "tests/unit/fake.test.ts": `const s = "${FAKE_ANTHROPIC}";\n` });
    const r = scanRepo(dir);
    expect(r.ok).toBe(false);
    expect(r.fails.some((f) => f.file === "tests/unit/fake.test.ts" && f.kind === "anthropic")).toBe(true);
    expect(render(r)).not.toContain("A1b2C3d4"); // still file:line:kind only
  });

  test("tests/ marker rule: the same fake with a // fake-secret marker passes (lists)", () => {
    const dir = mkRepo({
      "tests/unit/fake.test.ts": `const s = "${FAKE_ANTHROPIC}"; // fake-secret\n` });
    const r = scanRepo(dir);
    expect(r.fails).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lists.some((f) => f.file === "tests/unit/fake.test.ts" && f.kind === "anthropic")).toBe(true);
  });

  // F1 (qitem-20261113001934-427ddddd960d4a3c): gittoken joins HIGH. The
  // values are built by concatenation - this file's tracked bytes stay
  // match-free (under tests/ the marker rule would cover them too, belt and
  // braces), and each length is exactly the redact.ts minimum.
  const FAKE_GH_CLASSIC = ["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""); // fake-secret 36
  const FAKE_GH_FINE = ["github_pat_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5"].join(""); // fake-secret 50 (the long body is also an opaque shape - the marker is what lets this tracked line pass the real-repo scan)
  const FAKE_GL_PAT = ["glpat-", "AbCdEfGhIjKlMnOpQrSt"].join(""); // fake-secret 20

  test("F1 gittoken HIGH: planted GitHub classic, fine-grained and GitLab fakes FAIL outside tests/", () => {
    const dir = mkRepo({
      "src1.txt": `x = ${FAKE_GH_CLASSIC}\n`,
      "src2.txt": `x = ${FAKE_GH_FINE}\n`,
      "src3.txt": `x = ${FAKE_GL_PAT}\n` });
    const r = scanRepo(dir);
    expect(r.ok).toBe(false);
    for (const f of ["src1.txt", "src2.txt", "src3.txt"]) {
      expect(r.fails.some((x) => x.file === f && x.kind === "gittoken")).toBe(true);
    }
    expect(render(r)).not.toContain("A1b2C3d4"); // file:line:kind only, never the value
  });

  test("F1 gittoken tests/ exemption: unmarked FAILS, the marked line lists", () => {
    const un = mkRepo({ "tests/unit/a.ts": `const s = "${FAKE_GH_CLASSIC}";\n` });
    const ru = scanRepo(un);
    expect(ru.ok).toBe(false);
    expect(ru.fails.some((x) => x.kind === "gittoken")).toBe(true);
    const mk = mkRepo({ "tests/unit/a.ts": `const s = "${FAKE_GH_CLASSIC}"; // fake-secret\n` });
    const rm = scanRepo(mk);
    expect(rm.fails).toEqual([]);
    expect(rm.lists.some((x) => x.file === "tests/unit/a.ts" && x.kind === "gittoken")).toBe(true);
  });

  test("tests/ low-confidence: non-code value fails unmarked, passes marked; code value lists", () => {
    const unmarked = mkRepo({ "tests/unit/a.ts": `const ${FAKE_ASSIGN};\n` });
    const ru = scanRepo(unmarked);
    expect(ru.ok).toBe(false);
    expect(ru.fails.some((f) => f.kind === "assignment")).toBe(true);
    expect(render(ru)).not.toContain("leakedplaintextvalue987");

    const marked = mkRepo({ "tests/unit/a.ts": `const ${FAKE_ASSIGN}; // fake-secret\n` });
    const rm = scanRepo(marked);
    expect(rm.ok).toBe(true);
    expect(rm.lists.some((f) => f.file === "tests/unit/a.ts" && f.kind === "assignment")).toBe(true);

    const code = mkRepo({
      "tests/unit/b.ts": 'const API_TOKEN_REF = process.env["HONCHO_API_KEY"];\n' });
    const rc = scanRepo(code);
    expect(rc.ok).toBe(true);
    expect(rc.lists.some((f) => f.file === "tests/unit/b.ts" && f.kind === "assignment")).toBe(true);
  });

  test(".claude/skills/ stays list-only for vendored prose", () => {
    const dir = mkRepo({
      ".claude/skills/honcho-integrate/SKILL.md": "key: Original session key (e.g., \"discord:123456\").\n", // fake-secret
    });
    const r = scanRepo(dir);
    expect(r.fails).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lists.length).toBeGreaterThanOrEqual(1);
  });

  test("the one subprocess: execFile only in nudge.ts; spawn/shell/eval/new Function forbidden", () => {
    const twoCalls = mkRepo({
      "plugin/src/nudge.ts": "import { execFile } from \"node:child_process\";\nexecFile(\"x\", []);\n",
      "plugin/src/a.ts": "import { execFile } from \"node:child_process\";\nexecFile(\"y\", []);\n" });
    expect(scanRepo(twoCalls).fails.some((f) => f.kind === "exec_file_count")).toBe(true);

    const wrongPlace = mkRepo({
      "plugin/src/other.ts": "import { execFile } from \"node:child_process\";\nexecFile(\"x\", []);\n",
      "plugin/src/nudge.ts": "import { execFile } from \"node:child_process\";\nexport const n = 1;\n" });
    expect(scanRepo(wrongPlace).fails.some((f) => f.kind === "exec_file_location")).toBe(true);

    const spawn = mkRepo({ "plugin/src/s.ts": "Bun.spawn([\"ls\"]);\n" });
    expect(scanRepo(spawn).fails.some((f) => f.kind === "spawn")).toBe(true);

    const shell = mkRepo({ "plugin/src/w.ts": "run({ shell: true });\n" });
    expect(scanRepo(shell).fails.some((f) => f.kind === "shell")).toBe(true);

    const ev = mkRepo({ "plugin/src/e.ts": "eval(\"1+1\");\n" });
    expect(scanRepo(ev).fails.some((f) => f.kind === "eval")).toBe(true);

    const fn = mkRepo({ "plugin/src/f.ts": "const F = new Function(\"return 1\");\n" });
    expect(scanRepo(fn).fails.some((f) => f.kind === "new_function")).toBe(true);

    // regex .exec( is NOT the child_process surface, but importing the
    // module outside nudge.ts is
    const cpImport = mkRepo({ "plugin/src/i.ts": "import { exec } from \"node:child_process\";\nvoid exec;\n" });
    expect(scanRepo(cpImport).fails.some((f) => f.kind === "child_process_import")).toBe(true);

    const regexExec = mkRepo({ "plugin/src/r.ts": "const m = /a/.exec(\"b\"); void m;\n" });
    expect(scanRepo(regexExec).fails.filter((f) => f.kind === "exec")).toEqual([]);
  });

  test("zero deps: node_modules under plugin/ and a package.json with dependencies fail", () => {
    const dir = mkRepo({ "plugin/src/a.ts": "export const a = 1;\n", "package.json": '{"name":"x"}\n' });
    mkdirSync(join(dir, "plugin", "node_modules", "left-pad"), { recursive: true });
    const r = scanRepo(dir);
    expect(r.fails.some((f) => f.kind === "node_modules")).toBe(true);

    const dep = mkRepo({ "package.json": '{"name":"x","dependencies":{"left-pad":"1.0.0"}}\n' });
    expect(scanRepo(dep).fails.some((f) => f.kind === "dependencies")).toBe(true);
  });

  test("a scan of nothing FAILS: empty non-git dir -> exit 1 (architect 22:45Z)", () => {
    const dir = makeTempDir("scan-empty-"); // NOT a git repo
    const r = scanRepo(dir);
    expect(r.ok).toBe(false);
    expect(r.fails.some((f) => f.kind === "git_ls_files")).toBe(true);
    // the literal check: the CLI itself exits 1 there
    const cli = Bun.spawnSync([process.execPath, join(REPO, "scripts/scan.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(1);
  });

  test("a git repo with zero tracked files FAILS (no_tracked_files)", () => {
    const dir = makeTempDir("scan-notracked-");
    execSync("git init -q .", { cwd: dir });
    writeFileSync(join(dir, "untracked.txt"), "hello\n"); // present but untracked
    const r = scanRepo(dir);
    expect(r.ok).toBe(false);
    expect(r.fails.some((f) => f.kind === "no_tracked_files")).toBe(true);
  });

  test("the real repo passes (done-when for T8d-1)", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const r = scanRepo(root);
    expect(r.fails.map((f) => `${f.file}:${f.line}:${f.kind}: ${f.why}`)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.files).toBeGreaterThan(90);
  });
});

// Architect ruling 04:06Z (T9): release/v*/SHA256SUMS carries lowercase
// "<64hex>  <path>" lines; exactly that shape in exactly that file is not a
// finding, and the exemption must not widen. Both directions below. The
// digest is built at runtime so THIS file stays 64-char-literal-free.
describe("SHA256SUMS exemption (scan.ts, architect 04:06Z)", () => {
  const dig = "0123456789abcdef".repeat(4); // 64 lowercase hex, assembled

  test("valid checksum lines in release/v0.1.0/SHA256SUMS pass; value never printed", () => {
    const dir = mkRepo({
      "release/v0.1.0/SHA256SUMS": `${dig}  openrig-honcho/bin/stop.ts\n${dig}  openrig-honcho/.claude-plugin/plugin.json\n` });
    const r = scanRepo(dir);
    expect(r.fails.map((f) => f.kind)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(render(r)).not.toContain("0123456789abcdef");
  });

  test("a sums-file line OUTSIDE the exact shape still fails (trailing junk after the path)", () => {
    const dir = mkRepo({ "release/v0.1.0/SHA256SUMS": `${dig}  openrig-honcho/x note\n` });
    const r = scanRepo(dir);
    expect(r.ok).toBe(false);
    expect(r.fails.some((f) => f.kind === "hex64")).toBe(true);
    expect(render(r)).not.toContain("0123456789abcdef");
  });

  test("the same line in any other file, or at the wrong depth, still fails", () => {
    const other = mkRepo({ "release/v0.1.0/checksums.txt": `${dig}  a\n` });
    expect(scanRepo(other).ok).toBe(false);
    const wrongDepth = mkRepo({ "release/SHA256SUMS": `${dig}  a\n` });
    const rw = scanRepo(wrongDepth);
    expect(rw.ok).toBe(false);
    expect(rw.fails.some((f) => f.kind === "hex64")).toBe(true);
  });

  test("the same shape in a DEEPER SHA256SUMS (inside the copy) is NOT exempted", () => {
    // path assembled at runtime: this file's own bytes must stay free of a
    // 40-char upper+lower+digit run (the opaque rule would catch the literal)
    const deepPath = ["release/v0.1.0/openrig-honcho", "SHA256SUMS"].join("/");
    const dir = mkRepo({ [deepPath]: `${dig}  a\n` });
    expect(scanRepo(dir).ok).toBe(false);
  });
});

describe("GATED_COMMIT pin (T13a: release.ts writes it under release/)", () => {
  test("a 40-hex GATED_COMMIT directly under release/v*/ passes the scan with NO exemption", () => {
    // assembled at runtime: this file's own bytes carry no 40-hex run
    const sha = "deadbeef".repeat(5);
    const dir = mkRepo({ "release/v1.2.3/GATED_COMMIT": `${sha}\n` });
    const r = scanRepo(dir);
    expect(r.fails).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
