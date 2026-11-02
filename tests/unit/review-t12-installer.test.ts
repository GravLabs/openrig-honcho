// T12 review (dev-review, 2026-10-29, pin 9d35f91): the five installer
// findings F1-F4, un-skipped per the T12c brief - they now run against the
// fixed installer. Where the test body and the written brief disagreed
// (F1d's exit code, F4's refuse-vs-write-through), the architect ruled at
// 19:31Z: the brief wins (refuse, exit 1, nothing written), and review
// supplied the refuse-shape bodies used below.
//
// Full attack harness (also exercises the 39 PASSing invariants incl. the
// no-value-leak assertions): /tmp/t12attack/harness.py (throwaway, rerun
// `python3 -I` it before deleting).

import { expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync  } from "node:fs";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..", "..", "plugin");
const SCRIPT = join(PLUGIN, "bin", "install-project.ts");
const BUN = process.execPath;

function project(settings: unknown, mcp?: unknown): string {
  const d = makeTempDir("review-t12-");
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, ".claude", "settings.local.json"), JSON.stringify(settings, null, 2));
  if (mcp !== undefined) writeFileSync(join(d, ".mcp.json"), JSON.stringify(mcp, null, 2));
  return d;
}

function install(d: string, extra: string[] = []): { exit: number; out: string } {
  const r = Bun.spawnSync([BUN, SCRIPT, d, "--url", "http://localhost:8000/v3", "--workspace", "honcho-bridge-scratch-review-t12", ...extra]);
  return { exit: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

const settingsOf = (d: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(d, ".claude", "settings.local.json"), "utf8"));

test("baseline: a well-formed settings file merges ours and keeps foreign order (guard for the tests below)", () => {
  const d = project({ env: { KEEP: "1" }, permissions: { deny: ["Read(./.env*)"] } }, { mcpServers: { other: { command: "f" } } });
  expect(install(d).exit).toBe(0);
  const s = settingsOf(d);
  expect((s.env as Record<string, string>).KEEP).toBe("1");
  expect(s.permissions).toEqual({ deny: ["Read(./.env*)"] });
});

test("F1 hooks-as-string: a foreign non-object hooks value must be preserved or refused, not replaced", () => {
  // planInstall: `isJsonObject(settings.hooks) ? settings.hooks : {}` discards
  // the foreign value; it survives only in the dated backup. Same code shape
  // for env (array -> {}), enabledMcpjsonServers (string -> [ours]) and
  // .mcp.json mcpServers (string -> {ours}) - four reproductions, one root.
  const d = project({ hooks: "foreign-string" });
  install(d);
  expect(settingsOf(d).hooks).toBe("foreign-string"); // got: an object of our hook groups
});

test("F1b env-as-array: foreign env array must survive", () => {
  const d = project({ env: ["foreign-A", "foreign-B"] });
  install(d);
  expect(settingsOf(d).env).toEqual(["foreign-A", "foreign-B"]); // got: our HONCHO_* object
});

test("F1c enabledMcpjsonServers-as-string must survive", () => {
  const d = project({ enabledMcpjsonServers: "foreign-pres" });
  install(d);
  expect(settingsOf(d).enabledMcpjsonServers).toBe("foreign-pres"); // got: ["rig_memory"]
});

test("F1d mcpServers-as-string is refused like the by-path rig_memory is (19:31Z ruling: refuse)", () => {
  const d = project({ env: {} }, { mcpServers: "foreign-mcp" });
  const before = readFileSync(join(d, ".mcp.json"), "utf8");
  const r = install(d);
  expect(r.exit).toBe(1);
  expect(readFileSync(join(d, ".mcp.json"), "utf8")).toBe(before);
});

test("F2 uninstall from a different plugin path removes env keys it did not add", () => {
  // Hooks and the MCP server are filtered by namesPlugin (path-scoped); the
  // five env keys, the enabledMcpjsonServers entry and the skill folder are
  // removed by NAME only. After install from path A, --uninstall from a copy
  // at path B deletes A's env keys while leaving A's hooks - a half-uninstall
  // of something B never installed. Also: an owner's PRE-EXISTING
  // enabledMcpjsonServers ["rig_memory"] (install adds nothing) is deleted
  // entirely by uninstall.
  const d = project({ env: { KEEP: "1" } }, { mcpServers: {} });
  const alt = makeTempDir("review-t12-alt-");
  cpSync(PLUGIN, join(alt, "plugin"), { recursive: true });
  expect(install(d).exit).toBe(0);
  const before = readFileSync(join(d, ".claude", "settings.local.json"), "utf8");
  const r = Bun.spawnSync([BUN, join(alt, "plugin", "bin", "install-project.ts"), d, "--uninstall"]);
  // v0.1.2 (ADR-0008 amendment rule 6, architect 03:55Z): the install record
  // names path A, so B refuses loudly instead of v0.1.1's "nothing to change".
  // Either way B changes nothing.
  expect(r.exitCode).toBe(1);
  expect(r.stdout.toString() + r.stderr.toString()).toContain("different plugin path");
  expect(readFileSync(join(d, ".claude", "settings.local.json"), "utf8")).toBe(before);
});

test("F3 read-only project dir with writable .claude leaves a half install", () => {
  // settings is rewritten, then the .mcp.json backup throws EACCES uncaught
  // (exit 1, ugly stack): settings changed, .mcp.json untouched. Values do
  // NOT leak into stderr (asserted in the harness). A writability check for
  // every write target before the first write would make it refuse-nothing.
  const d = project({ env: { KEEP: "1" } }, { mcpServers: { other: { command: "f" } } });
  chmodSync(d, 0o555);
  const r = install(d);
  chmodSync(d, 0o755);
  const halfDone = "HONCHO_URL" in (settingsOf(d).env as Record<string, string>) && r.exit !== 0;
  expect(halfDone).toBe(false); // got: true (partial install)
});

test("F4 symlinked settings file is refused: the link survives and the target is untouched (19:31Z ruling)", () => {
  // was: the atomic write renamed over the symlink - link gone, target never
  // updated (divergence, target orphaned unreferenced).
  const d = makeTempDir("review-t12-sym-");
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, "elsewhere.json"), JSON.stringify({ env: { KEEP: "1" } }));
  symlinkSync("../elsewhere.json", join(d, ".claude", "settings.local.json"));
  const before = readFileSync(join(d, "elsewhere.json"), "utf8");
  const r = install(d);
  expect(r.exit).toBe(1);
  expect(r.out.includes("settings.local.json")).toBe(true);
  expect(lstatSync(join(d, ".claude", "settings.local.json")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(d, "elsewhere.json"), "utf8")).toBe(before);
});
