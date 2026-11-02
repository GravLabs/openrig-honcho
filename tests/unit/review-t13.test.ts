// T13 review (dev-review, 2026-10-30, pin c92ee92): expectation tests for the
// v0.1.2 amendment (install record + backup folder) and the ADR rulings at
// 668f2f0/c92ee92. T13b is not implemented at this pin - its tests are
// test.skip-marked (T12 precedent) and un-skip with the T13b code, at which
// point they must pass with NO body edits. The 3 T13a tests ran AND PASSED
// at the accepted pin 0c06b13 (qitem-20261030023239, 2026-10-30): the same
// file at c92ee92 was a run against half-done code and was withdrawn.
//
// Rulings these pin, in the ADR's words:
// - rule 5 comes before rule 3 (668f2f0);
// - envAdded: only the five flag names, without duplicates, else wrong shape (668f2f0);
// - staged apply renames install.json before settings.local.json (668f2f0);
// - a valid record naming this plugin path is itself proof for uninstall (c92ee92);
// - a re-run without a flag leaves the key and its record entry (c92ee92);
// - copy equals git ls-files plugin + refuse on untracked/ignored in plugin (668f2f0,
//   ADR-0007) - the main() wiring is NOT at this pin; see the skip-marked note at
//   the bottom and the qitem plan in ~/review-scratch.

import { expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareTrees, gatedCommitBody } from "../../scripts/release.ts";
import { redact } from "../../plugin/src/redact.ts";

const PLUGIN = join(import.meta.dir, "..", "..", "plugin");
const PLUGIN_REAL = realpathSync(PLUGIN);
const SCRIPT = join(PLUGIN, "bin", "install-project.ts");
const BUN = process.execPath;
const URL_VAL = "http://localhost:8000/v3"; // no network: the installer never calls out
const WS = "honcho-bridge-scratch-review-t13";
const OURS = ["HONCHO_URL", "HONCHO_WORKSPACE", "HONCHO_LEADER_PEER", "HONCHO_PROFILE_WORKSPACE", "HONCHO_OWNER_PEER"];
const OUR_DIR_REL = join(".claude", "openrig-honcho");

function project(settings: unknown, mcp?: unknown): string {
  const d = makeTempDir("review-t13-");
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, ".claude", "settings.local.json"), JSON.stringify(settings, null, 2));
  if (mcp !== undefined) writeFileSync(join(d, ".mcp.json"), JSON.stringify(mcp, null, 2));
  return d;
}

function run(d: string, extra: string[]): { exit: number; out: string } {
  const r = Bun.spawnSync([BUN, SCRIPT, d, ...extra]);
  return { exit: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}
const install = (d: string, extra: string[] = []) =>
  run(d, ["--url", URL_VAL, "--workspace", WS, ...extra]);
const uninstall = (d: string) => run(d, ["--uninstall"]);

const settingsOf = (d: string): Json => JSON.parse(readFileSync(join(d, ".claude", "settings.local.json"), "utf8"));
type Json = Record<string, unknown>;
const envOf = (d: string): Json => (settingsOf(d).env ?? {}) as Json;
const recPath = (d: string) => join(d, OUR_DIR_REL, "install.json");
const recordOf = (d: string): Json => JSON.parse(readFileSync(recPath(d), "utf8"));
function writeRecord(d: string, rec: unknown): void {
  mkdirSync(join(d, OUR_DIR_REL), { recursive: true });
  writeFileSync(recPath(d), JSON.stringify(rec, null, 2));
}
// A v0.1.1-style install proven by a hook group naming this plugin path.
function proveInstall(d: string): void {
  const s = settingsOf(d);
  s.hooks = { Stop: [{ hooks: [{ command: `bun run ${PLUGIN_REAL}/bin/stop.ts` }] }] };
  writeFileSync(join(d, ".claude", "settings.local.json"), JSON.stringify(s, null, 2));
}
const modeOf = (p: string) => statSync(p).mode & 0o777;

// ---------------------------------------------------------------------------
// T13a: pure helpers ARE at this pin - these run now.
// ---------------------------------------------------------------------------

test("T13a compareTrees: identical trees -> no diffs; each diff kind is named", () => {
  const a = makeTempDir("review-t13-a-");
  const b = makeTempDir("review-t13-b-");
  mkdirSync(join(a, "sub"));
  mkdirSync(join(b, "sub"));
  writeFileSync(join(a, "f.ts"), "x");
  writeFileSync(join(b, "f.ts"), "x");
  writeFileSync(join(a, "sub", "g.ts"), "same");
  writeFileSync(join(b, "sub", "g.ts"), "same");
  expect(compareTrees(a, b)).toEqual([]);
  writeFileSync(join(b, "sub", "g.ts"), "changed");
  expect(compareTrees(a, b)).toEqual([{ path: "sub/g.ts", kind: "differs" }]);
  writeFileSync(join(b, "sub", "g.ts"), "same");
  writeFileSync(join(a, "onlyA.ts"), "1");
  writeFileSync(join(b, "onlyB.ts"), "1");
  expect(compareTrees(a, b)).toEqual([
    { path: "onlyA.ts", kind: "only-in-a" },
    { path: "onlyB.ts", kind: "only-in-b" },
  ]);
});

test("T13a compareTrees: node_modules is excluded on BOTH sides, exactly as listFiles does", () => {
  const a = makeTempDir("review-t13-nm-a-");
  const b = makeTempDir("review-t13-nm-b-");
  mkdirSync(join(a, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(a, "node_modules", "dep", "i.js"), "junk");
  expect(compareTrees(a, b)).toEqual([]);
});

test("T13a gatedCommitBody: one 40-hex line with a trailing newline; scan-safe", () => {
  const commit = "5a8030b1c2d3e4f5061728394a5b6c7d8e9f0a1b";
  const body = gatedCommitBody(commit);
  expect(body).toBe(`${commit}\n`);
  const r = redact(body);
  expect(r.text).toBe(body); // 40 lowercase hex must not match hex64 (64+) or opaque (needs upper)
});

// ---------------------------------------------------------------------------
// T13b: the amendment - skip-marked until the code lands; un-skip with no
// body edits. Every refusal test asserts exit 1 AND nothing written.
// ---------------------------------------------------------------------------

test("T13b record shape and folder: 0600 record with names only, backups inside the folder, .gitignore *, nothing new at the project root", () => {
  const d = project({ env: { KEEP: "1" } });
  expect(install(d).exit).toBe(0);
  const rec = recordOf(d);
  expect(rec.version).toBe(1);
  expect(realpathSync(String(rec.plugin))).toBe(PLUGIN_REAL);
  expect([...(rec.envAdded as string[])].sort()).toEqual(["HONCHO_URL", "HONCHO_WORKSPACE"]);
  expect(rec.enabledAdded).toBe(true);
  expect(modeOf(recPath(d))).toBe(0o600);
  expect(readFileSync(recPath(d), "utf8")).not.toContain(URL_VAL); // names only, never values
  const backups = readdirSync(join(d, OUR_DIR_REL, "backups"));
  expect(backups.some((n) => n.startsWith("settings.local.json."))).toBe(true);
  expect(backups.every((n) => modeOf(join(d, OUR_DIR_REL, "backups", n)) === 0o600)).toBe(true);
  expect(readFileSync(join(d, OUR_DIR_REL, ".gitignore"), "utf8").trim()).toBe("*");
  const rootExtras = readdirSync(d).filter((n) => n.includes("bak-openrig-honcho") || n.startsWith(".mcp.json."));
  expect(rootExtras).toEqual([]); // amendment: nothing is written to the project root any more
});

test("T13b output names only: install and uninstall never echo a flag value", () => {
  const d = project({ env: {} });
  const i = install(d, ["--owner-peer", "the-owner-peer-value"]);
  expect(i.exit).toBe(0);
  expect(i.out).not.toContain(URL_VAL);
  expect(i.out).not.toContain(WS);
  expect(i.out).not.toContain("the-owner-peer-value");
  const u = uninstall(d);
  expect(u.exit).toBe(0);
  expect(u.out).not.toContain(URL_VAL);
  expect(u.out).not.toContain(WS);
});

test("T13b idempotent re-run: nothing to change, record kept, no new backups", () => {
  const d = project({ env: {} }, { mcpServers: {} });
  expect(install(d).exit).toBe(0);
  const rec1 = readFileSync(recPath(d), "utf8");
  const b1 = readdirSync(join(d, OUR_DIR_REL, "backups")).length;
  const r = install(d);
  expect(r.out).toContain("nothing to change");
  expect(readFileSync(recPath(d), "utf8")).toBe(rec1); // kept across re-runs
  expect(readdirSync(join(d, OUR_DIR_REL, "backups")).length).toBe(b1);
});

test("T13b re-run adds a flag: envAdded grows, never drops recorded names (amendment rule 2)", () => {
  const d = project({ env: {} });
  expect(install(d).exit).toBe(0);
  expect(install(d, ["--leader", "design-architect"]).exit).toBe(0);
  const names = recordOf(d).envAdded as string[];
  expect(names).toContain("HONCHO_URL");
  expect(names).toContain("HONCHO_WORKSPACE");
  expect(names).toContain("HONCHO_LEADER_PEER");
  expect(names.length).toBe(3);
});

test("T13b rule 3 same value: a pre-existing equal key is left alone and NOT recorded", () => {
  const d = project({ env: { HONCHO_URL: URL_VAL, HONCHO_WORKSPACE: WS } }); // no proof of ours: first install
  expect(install(d).exit).toBe(0);
  expect(recordOf(d).envAdded).toEqual([]);
  expect(uninstall(d).exit).toBe(0);
  expect(envOf(d).HONCHO_URL).toBe(URL_VAL); // it was never ours
  expect(envOf(d).HONCHO_WORKSPACE).toBe(WS);
});

test("T13b rule 3 first install: a pre-existing key with a different value -> refuse, nothing written", () => {
  const d = project({ env: { HONCHO_URL: "http://127.0.0.1:1/v3" } }, { mcpServers: { other: { command: "x" } } });
  const before = readFileSync(join(d, ".mcp.json"), "utf8");
  const r = install(d);
  expect(r.exit).toBe(1);
  expect(existsSync(recPath(d))).toBe(false);
  expect(envOf(d).HONCHO_URL).toBe("http://127.0.0.1:1/v3");
  expect(readFileSync(join(d, ".mcp.json"), "utf8")).toBe(before);
  expect(existsSync(join(d, OUR_DIR_REL, "backups"))).toBe(false); // not a folder, not a backup
});

test("T13b rule 5 BEFORE rule 3: proven path + no record -> present flag keys are ours, changed and recorded (668f2f0)", () => {
  const d = project({ env: { HONCHO_URL: "http://127.0.0.1:1/v3", HONCHO_WORKSPACE: WS } });
  proveInstall(d); // a hook group names PLUGIN_DIR; no record exists
  expect(install(d).exit).toBe(0); // rule 3 would have refused: rule 5 wins
  expect(envOf(d).HONCHO_URL).toBe(URL_VAL);
  expect([...(recordOf(d).envAdded as string[])].sort()).toEqual(["HONCHO_URL", "HONCHO_WORKSPACE"]);
});

test("T13b rule 5 then uninstall: keys counted as added by the record basis ARE removed", () => {
  const d = project({ env: { HONCHO_URL: URL_VAL, HONCHO_WORKSPACE: WS } });
  proveInstall(d);
  expect(install(d).exit).toBe(0);
  expect(uninstall(d).exit).toBe(0);
  expect("HONCHO_URL" in envOf(d)).toBe(false);
  expect("HONCHO_WORKSPACE" in envOf(d)).toBe(false);
});

const badRecords: [string, Json][] = [
  ["envAdded names a foreign key", { version: 1, plugin: PLUGIN_REAL, envAdded: ["ANTHROPIC_API_KEY"], enabledAdded: false }],
  ["envAdded duplicates a name", { version: 1, plugin: PLUGIN_REAL, envAdded: ["HONCHO_URL", "HONCHO_URL"], enabledAdded: false }],
  ["enabledAdded is not a boolean", { version: 1, plugin: PLUGIN_REAL, envAdded: [], enabledAdded: "yes" }],
  ["record names another plugin path", { version: 1, plugin: "/some/other/plugin", envAdded: [], enabledAdded: false }],
  ["version is not 1", { version: 2, plugin: PLUGIN_REAL, envAdded: [], enabledAdded: false }],
];
for (const [label, rec] of badRecords) {
  test(`T13b rule 6 wrong-shape record (${label}): refuse on install AND uninstall, nothing written`, () => {
    const d = project({ env: { HONCHO_URL: "http://127.0.0.1:1/v3" } });
    proveInstall(d);
    writeRecord(d, rec);
    const i = install(d);
    expect(i.exit).toBe(1);
    expect(envOf(d).HONCHO_URL).toBe("http://127.0.0.1:1/v3"); // untouched
    const u = uninstall(d);
    expect(u.exit).toBe(1);
    expect(envOf(d).HONCHO_URL).toBe("http://127.0.0.1:1/v3");
    expect(existsSync(recPath(d))).toBe(true); // the refused record stays for the human
  });
}

test("T13b rule 6 unreadable record: refuse both ways", () => {
  const d = project({ env: {} });
  proveInstall(d);
  mkdirSync(recPath(d), { recursive: true }); // a DIRECTORY where the record must be
  expect(install(d).exit).toBe(1);
  expect(uninstall(d).exit).toBe(1);
  rmSync(recPath(d), { recursive: true, force: true });
  writeFileSync(recPath(d), "{not json");
  expect(install(d).exit).toBe(1);
  expect(uninstall(d).exit).toBe(1);
});

test("T13b rule 6 symlinked record: refuse, the link survives and its target is untouched", () => {
  const d = makeTempDir("review-t13-sym-");
  mkdirSync(join(d, ".claude"), { recursive: true });
  writeFileSync(join(d, ".claude", "settings.local.json"), JSON.stringify({ env: {} }));
  const target = join(d, "elsewhere.json");
  const targetBody = JSON.stringify({ version: 1, plugin: PLUGIN_REAL, envAdded: [], enabledAdded: false });
  writeFileSync(target, targetBody);
  mkdirSync(join(d, OUR_DIR_REL), { recursive: true });
  symlinkSync(join(d, "elsewhere.json"), recPath(d));
  expect(install(d).exit).toBe(1);
  expect(uninstall(d).exit).toBe(1);
  expect(lstatSync(recPath(d)).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(targetBody);
});

test("T13b record is proof (c92ee92): hooks and server hand-removed -> uninstall proceeds; removes record, keeps backups and .gitignore; leaves and REPORTS foreign HONCHO_* keys", () => {
  const d = project({ env: {} }, { mcpServers: {} });
  expect(install(d).exit).toBe(0);
  const s = settingsOf(d);
  delete s.hooks; // the hand-removal this ruling covers
  writeFileSync(join(d, ".claude", "settings.local.json"), JSON.stringify(s, null, 2));
  rmSync(join(d, ".mcp.json"));
  const env = envOf(d);
  void env; // add a foreign HONCHO_* key the uninstall must never remove
  const s2 = settingsOf(d);
  s2.env = { ...(s2.env as Json), HONCHO_TIMEOUT_MS: "1234" };
  writeFileSync(join(d, ".claude", "settings.local.json"), JSON.stringify(s2, null, 2));
  const u = uninstall(d);
  expect(u.exit).toBe(0);
  expect(u.out).not.toContain("nothing to change");
  expect("HONCHO_URL" in envOf(d)).toBe(false);
  expect(envOf(d).HONCHO_TIMEOUT_MS).toBe("1234");
  expect(u.out).toContain("HONCHO_TIMEOUT_MS"); // rule 4: says which HONCHO_* names it left
  expect(existsSync(recPath(d))).toBe(false); // uninstall removes install.json
  expect(existsSync(join(d, OUR_DIR_REL, "backups"))).toBe(true); // keeps backups and .gitignore
  expect(existsSync(join(d, OUR_DIR_REL, ".gitignore"))).toBe(true);
});

test("T13b crash window (668f2f0 order): a record naming keys that were never written is harmless on uninstall", () => {
  const d = project({ env: { OWNER_KEY: "mine" } });
  proveInstall(d);
  writeRecord(d, { version: 1, plugin: PLUGIN_REAL, envAdded: [...OURS], enabledAdded: false });
  const u = uninstall(d);
  expect(u.exit).toBe(0);
  expect(envOf(d)).toEqual({ OWNER_KEY: "mine" }); // absent names are skipped; owner keys never touched
});

test("T13b re-run without a flag (c92ee92): the key and its record entry stay; only uninstall removes them", () => {
  const d = project({ env: {} });
  expect(install(d, ["--leader", "design-architect"]).exit).toBe(0);
  expect(install(d).exit).toBe(0); // no --leader this time
  expect(envOf(d).HONCHO_LEADER_PEER).toBe("design-architect");
  expect(recordOf(d).envAdded).toContain("HONCHO_LEADER_PEER");
  expect(uninstall(d).exit).toBe(0);
  expect("HONCHO_LEADER_PEER" in envOf(d)).toBe(false);
});

test("T13b enabledAdded=false: an owner's pre-existing rig_memory entry survives uninstall", () => {
  const d = project({ env: {}, enabledMcpjsonServers: ["rig_memory"] }); // owner had it first
  expect(install(d).exit).toBe(0);
  expect(recordOf(d).enabledAdded).toBe(false);
  expect(uninstall(d).exit).toBe(0);
  expect((settingsOf(d).enabledMcpjsonServers as string[])).toContain("rig_memory");
});

test("T13b no-record uninstall on a proven path still works (rule 5 as v0.1.1 did) and says so", () => {
  const d = project({ env: { HONCHO_URL: URL_VAL } }, { mcpServers: {} });
  proveInstall(d);
  // no record: v0.1.1 state
  const r = Bun.spawnSync([BUN, join(PLUGIN_REAL, "bin", "install-project.ts"), d, "--uninstall"]);
  expect(r.exitCode).toBe(0);
  expect("HONCHO_URL" in envOf(d)).toBe(false);
});

// NOT covered here (qitem live-run, needs a scratch git clone, not a unit test):
// - release.ts main(): refuse on untracked/ignored plugin files; copy == ls-files
//   byte check end-to-end; GATED_COMMIT written last and never overwritten.
// - B1 (RULED 01:31Z: release refuses ANY symlink in plugin, tracked or not,
//   ADR-0007): COVERED at the qitem live-run (scratch clones, 2026-10-30):
//   untracked symlink and tracked symlink (mode 120000) each refuse with no
//   release/ writes; a symlink can only reach the copy FROM plugin/, which is
//   refused pre-copy.
