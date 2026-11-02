// T9: `bun run scripts/release.ts <version>` - build the v<version> release
// copy under release/ (ADR-0007 release sequence). It REFUSES unless:
//   1. the version argument is a plain X.Y.Z;
//   2. gate-report.json exists for the CURRENT HEAD, exit 0, cleanTree true,
//      and EVERY recorded step PASS (the pure gateAllows() below);
//   3. the tree is STILL clean (tracked) right now - the gate ran earlier,
//      anything could have touched it since;
//   4. plugin/.claude-plugin/plugin.json carries the same version;
//   5. release/v<version>/openrig-honcho/ does not exist yet - never
//      overwrite; the architect's README.md and rig-spec.example.yaml in
//      release/v<version>/ are never read, written or removed by this script;
//   6. (T14f, ADR-0006 amendment 2026-10-31) NO honcho-bridge-scratch*
//      workspace is still listed on the server, and the list itself succeeds
//      - the gate now proves deletes ACCEPTED, not purged, so the release is
//      what carries the proof the deriver caught up.
// Then it copies plugin/ -> release/v<version>/openrig-honcho/ and, before
// anything else touches the copy, compares it to plugin/ file-for-file and
// byte-for-byte (T13a, ADR-0007: the release must not ship a copy that
// differs from what the gate tested). The expected file SET is the git index
// (git ls-files plugin), and plugin/ must carry NO untracked or ignored
// files (00:59Z amendment) - the gate ran on the tracked tree, so anything
// else in the copy is untested. plugin/ must also hold NO symlinks,
// tracked (git ls-files -s mode 120000) or untracked (architect ruling
// B1, 01:35Z) - the copy must be plain files the gate actually read. Any
// difference refuses with up to 10 named paths; the copy is LEFT for
// inspection and must be removed before a retry. It then writes SHA256SUMS for every copied file, and CHECKS the
// copy: `rig plugin validate` on the copy says valid true, the version
// matches, no node_modules crept in, and the repo scan (which covers
// release/) passes. Last, once every check passed, it writes
// release/v<version>/GATED_COMMIT - the 40-hex gated commit, one line - and
// refuses if that file already exists (never overwritten; the architect's
// hand-written ones were the v0.1.0/v0.1.1 way, the script owns it from
// v0.1.2). It does NOT tag and does NOT push: it prints the tag command for
// the architect to run.
//
// SHA256SUMS uses the STANDARD lowercase "<64hex>  <path>" shape. The gate's
// scan would fail those hex64 lines under release/, so scan.ts carries a
// narrowly ruled exemption (architect 04:06Z): exactly this line shape in a
// file named SHA256SUMS directly under release/v*/; anything else there is
// scanned normally. Pinned on both sides: tests/unit/scan.test.ts (both
// directions) and tests/unit/release.test.ts (the emitted shape matches the
// exemption regex).

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { extractJson, listAllWorkspaces } from "./gate.ts";

const REPO = join(import.meta.dir, "..");

export type GateCheck = { ok: true } | { ok: false; reason: string };

/**
 * The pure gate verdict (exported so the refusal is unit-tested, review
 * 03:13Z: "verify the refusal actually fires rather than trusting the guard
 * message"). Input is the PARSED gate-report.json (unknown - the report is
 * external input and may be anything); headCommit is the current HEAD sha.
 * Fails with the FIRST reason found, in the order an operator would fix them.
 */
export function gateAllows(report: unknown, headCommit: string): GateCheck {
  const no = (reason: string): GateCheck => ({ ok: false, reason });
  if (typeof report !== "object" || report === null) return no("gate-report.json is missing or not an object");
  const r = report as {
    commit?: unknown;
    cleanTree?: unknown;
    exit?: unknown;
    steps?: unknown;
  };
  if (r.exit !== 0) return no(`gate exit is ${JSON.stringify(r.exit)}, not 0 - the gate was not green`);
  if (r.commit !== headCommit) {
    return no(`gate ran on commit ${String(r.commit)}, HEAD is ${headCommit} - rerun bun run gate`);
  }
  if (r.cleanTree !== true) return no("gate tree was not clean (tracked changes) at gate time");
  if (!Array.isArray(r.steps) || r.steps.length === 0) return no("gate report has no steps - not a usable report");
  const bad = (r.steps as Array<{ step?: unknown; status?: unknown }>).filter((s) => s.status !== "PASS");
  if (bad.length > 0) {
    return no(`gate steps not PASS: ${bad.map((s) => `${String(s.step)}=${String(s.status)}`).join(", ")}`);
  }
  return { ok: true };
}

/** The version argument rule (pure): plain X.Y.Z, nothing else. */
export function validVersion(v: string | undefined): v is string {
  return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
}

/** The SHA256SUMS body (pure): sorted lowercase "hex64  relpath" lines,
 * relative to the release dir - the exact shape the scan exemption rules in.
 * `entries` are [relative path, lowercase hex digest]. */
export function sumsBody(entries: ReadonlyArray<[string, string]>): string {
  return (
    [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, hex]) => `${hex}  ${p}`)
      .join("\n") + "\n"
  );
}

const SCRATCH_PREFIX = "honcho-bridge-scratch";

export type ScratchVerdict = { ok: true } | { ok: false; reason: string; fix: string };

/**
 * T14f (ADR-0006 amendment 2026-10-31), the pure half: the gate proves each
 * scratch DELETE was accepted and leaves the purge to the server's single
 * deriver, so the RELEASE refuses while any honcho-bridge-scratch* is still
 * listed (the server has not caught up; the gate report's pendingDeletes say
 * which). Names the count and the first five ids. Empty list = clear.
 */
export function scratchClearCheck(ids: readonly string[]): ScratchVerdict {
  const no = (reason: string, fix: string): ScratchVerdict => ({ ok: false, reason, fix });
  const listed = ids.filter((id) => id.startsWith(SCRATCH_PREFIX));
  if (listed.length === 0) return { ok: true };
  const shown = listed.slice(0, 5).join(", ") + (listed.length > 5 ? ", …" : "");
  return no(
    `${listed.length} honcho-bridge-scratch* workspace(s) still listed on the server: ${shown}`,
    "the server's deriver has not purged the gate's test workspaces yet - wait until workspaces/list no longer shows any scratch workspace (the gate report's pendingDeletes name them), then rerun bun run gate and this script",
  );
}

/**
 * The seam half (exported so unit tests never touch the network): run the
 * injected lister, judge with scratchClearCheck. A THROWING list is a refusal
 * too - an unreachable server never reads as "clear" (same rule as the
 * gate's leftovers step: failing list != empty list).
 */
export async function scratchClearVerdict(
  list: () => Promise<readonly string[]>,
): Promise<ScratchVerdict> {
  const no = (reason: string, fix: string): ScratchVerdict => ({ ok: false, reason, fix });
  let ids: readonly string[];
  try {
    ids = await list();
  } catch (e) {
    return no(
      `workspaces/list failed: ${e instanceof Error ? e.message : String(e)} - cannot prove the server caught up with the gate's test deletes`,
      "make the Honcho server reachable, then rerun bun run gate and this script",
    );
  }
  return scratchClearCheck(ids);
}

function refuse(reason: string, fix: string): never {
  console.log(`RELEASE REFUSED\n  fact:   ${reason}\n  reason: the release copy must only be built from a green gate on the exact current commit with a clean tree (ADR-0007)\n  fix:    ${fix}`);
  process.exit(1);
}

const sha256Hex = (data: Buffer): string => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** Every file under dir, paths relative to dir, sorted; node_modules excluded. */
function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

export interface TreeDiff {
  path: string; // relative to the tree roots
  kind: "only-in-a" | "only-in-b" | "differs";
}

/**
 * Byte-for-byte tree fidelity (T13a, ADR-0007): the release copy must equal
 * what the gate tested. Same relative FILE set on both sides (node_modules
 * excluded exactly as listFiles does) and identical bytes per file. An empty
 * list proves the copy is exact. Reads only; writes nothing.
 */
export function compareTrees(a: string, b: string): TreeDiff[] {
  const fa = listFiles(a);
  const fb = listFiles(b);
  const sa = new Set(fa);
  const sb = new Set(fb);
  const diffs: TreeDiff[] = [];
  for (const p of fa) {
    if (!sb.has(p)) {
      diffs.push({ path: p, kind: "only-in-a" });
    } else if (!readFileSync(join(a, p)).equals(readFileSync(join(b, p)))) {
      diffs.push({ path: p, kind: "differs" });
    }
  }
  for (const p of fb) {
    if (!sa.has(p)) diffs.push({ path: p, kind: "only-in-b" });
  }
  return diffs;
}

/** The GATED_COMMIT body (pure): the gated 40-hex commit, ONE line, trailing
 * newline. The 40-hex shape needs no scan exemption (hex64 wants 64+, the
 * opaque rule wants an uppercase run) - pinned in tests/unit/scan.test.ts. */
export function gatedCommitBody(commit: string): string {
  return `${commit}\n`;
}

/**
 * Parse `git ls-files -s <dir>` (pure, T13a): "mode sha stage\tpath" per
 * entry. files = the expected release file set (paths relative to the
 * dir); symlinks = entries with mode 120000, which rule B1 (01:35Z)
 * refuses outright - a symlink is not plain content the gate tested.
 */
export function parseLsFilesStage(out: string): { files: string[]; symlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const [meta, path] = line.split("\t");
    if (path === undefined) continue; // not the -s shape - ignore defensively
    if (meta.trim().split(/\s+/)[0] === "120000") symlinks.push(path);
    else files.push(path);
  }
  return { files, symlinks };
}

/**
 * plugin/ must carry NO untracked or ignored files (T13a, 00:59Z
 * amendment) - which also covers untracked symlinks (rule B1), since
 * git reports them as "?? ". Pure: parse `git status --porcelain
 * --ignored plugin` and return the offending paths. Tracked-change
 * lines are NOT this rule; the tree-dirty check refuses those earlier
 * and must not double-report here.
 */
export function unexpectedPluginFiles(porcelainIgnored: string): string[] {
  return porcelainIgnored
    .split("\n")
    .filter((l) => l.startsWith("?? ") || l.startsWith("!! "))
    .map((l) => l.slice(3));
}

function run(cmd: string): { code: number; out: string } {
  try {
    return { code: 0, out: execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "" };
  }
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (!validVersion(version)) {
    refuse(`version argument ${JSON.stringify(process.argv[2])}`, "usage: bun run scripts/release.ts <X.Y.Z>, e.g. 0.1.0");
  }

  let head = "";
  try {
    head = execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    refuse("git rev-parse HEAD failed", "run this inside the git repo");
  }

  let report: unknown = null;
  try {
    report = JSON.parse(readFileSync(join(REPO, "gate-report.json"), "utf8")) as unknown;
  } catch {
    report = null;
  }
  const verdict = gateAllows(report, head);
  if (!verdict.ok) refuse(verdict.reason, "run bun run gate on a clean tree first, then retry");

  const dirty = run("git status --porcelain --untracked-files=no");
  if (dirty.code !== 0) refuse("git status failed", "fix the git checkout first");
  if (dirty.out.trim() !== "") {
    refuse("the tree became dirty after the gate ran", "commit or revert the tracked changes, rerun bun run gate, then retry");
  }

  // T13a (00:59Z amendment): the gate ran on the TRACKED tree, so plugin/
  // must hold nothing else. An untracked or ignored file would ride into
  // the copy untested; untracked SYMLINKS (rule B1) are reported as "??"
  // and refused here too. Refuse before anything is written.
  const pluginExtra = run("git status --porcelain --ignored plugin");
  if (pluginExtra.code !== 0) refuse("git status --porcelain --ignored plugin failed", "fix the git checkout first");
  const unexp = unexpectedPluginFiles(pluginExtra.out);
  if (unexp.length > 0) {
    refuse(
      `plugin/ carries ${unexp.length} untracked or ignored file(s): ${unexp.slice(0, 10).join(", ")}`,
      "remove them (or track them and rerun bun run gate) - the copy ships the tracked tree the gate tested, nothing else",
    );
  }

  // Rule B1 (01:35Z), checked BEFORE the copy (architect 02:05Z rerun: a
  // post-copy refusal would leave release/v<ver>/openrig-honcho/ with the
  // symlink in it and the retry would refuse on already-exists): plugin/
  // holds no tracked symlink (mode 120000); untracked symlinks are "??"
  // and already refused above. Nothing is written when this refuses.
  const stage = run("git ls-files -s plugin");
  if (stage.code !== 0) refuse("git ls-files -s plugin failed", "fix the git checkout first");
  const { files: trackedPaths, symlinks } = parseLsFilesStage(stage.out);
  if (symlinks.length > 0) {
    refuse(
      `plugin/ holds ${symlinks.length} tracked symlink(s): ${symlinks.slice(0, 10).join(", ")}`,
      "replace them with plain files (rule B1) - the release copy must be what the gate actually read",
    );
  }
  const strip = (p: string): string => (p.startsWith("plugin/") ? p.slice("plugin/".length) : p);
  const tracked = new Set(trackedPaths.map(strip));

  const pluginJsonPath = join(REPO, "plugin", ".claude-plugin", "plugin.json");
  let pluginVersion = "";
  try {
    pluginVersion = String((JSON.parse(readFileSync(pluginJsonPath, "utf8")) as { version?: unknown }).version ?? "");
  } catch {
    refuse("plugin/.claude-plugin/plugin.json unreadable", "the plugin manifest must exist and parse");
  }
  if (pluginVersion !== version) {
    refuse(`plugin.json says version ${pluginVersion}, asked to release ${version}`, "bump plugin/.claude-plugin/plugin.json to the released version first (architect's call)");
  }

  const releaseDir = join(REPO, "release", `v${version}`);
  // C12: release/v<version> occupied by a FILE made the copy throw a raw
  // ENOTDIR. Refuse with the usual fact/reason/fix before anything is written.
  if (existsSync(releaseDir) && !statSync(releaseDir).isDirectory()) {
    refuse(
      `release/v${version} exists and is not a directory`,
      "this script builds release/v<version>/ as a directory - remove the file first (it is not ours to guess), then rerun bun run gate and this script",
    );
  }
  const dest = join(releaseDir, "openrig-honcho");
  if (existsSync(dest)) {
    refuse(`${relative(REPO, dest)} already exists`, "this script never overwrites a release copy - move the old one away explicitly first");
  }
  const gatedPath = join(releaseDir, "GATED_COMMIT");
  if (existsSync(gatedPath)) {
    refuse(`release/v${version}/GATED_COMMIT already exists`, "this script never overwrites the gated-commit record - move the old release dir away explicitly first");
  }

  // ---- T14f (ADR-0006 amendment 2026-10-31): the gate proves deletes
  // ACCEPTED, not purged - so refuse BEFORE any copy while the server still
  // lists a scratch workspace (its single deriver has not caught up) or the
  // list itself fails. Read-only: the gate's own lister, same request;
  // nothing is written when this refuses.
  const scratchVerdict = await scratchClearVerdict(async () => (await listAllWorkspaces()).map((w) => w.id));
  if (!scratchVerdict.ok) refuse(scratchVerdict.reason, scratchVerdict.fix);

  // ---- build: ONLY plugin/ -> release/v<version>/openrig-honcho/. The
  // architect's README.md / rig-spec.example.yaml in releaseDir are not
  // touched (no read, no write, no delete anywhere in this script).
  cpSync(join(REPO, "plugin"), dest, {
    recursive: true,
    filter: (src) => !src.split("/").includes("node_modules"),
  });

  // ---- T13a copy fidelity: the copy must be exactly the tree the gate
  // tested - same file set as the git index (tracked computed pre-copy,
  // where the B1 symlink refusal fired) and identical bytes vs plugin/.
  // Any difference refuses; the copy is LEFT for inspection with no
  // SHA256SUMS and no GATED_COMMIT.
  const files = listFiles(dest);
  const copySet = new Set(files);
  const diffs: TreeDiff[] = compareTrees(join(REPO, "plugin"), dest);
  for (const p of tracked) if (!copySet.has(p)) diffs.push({ path: p, kind: "only-in-a" });
  for (const p of files) if (!tracked.has(p)) diffs.push({ path: p, kind: "only-in-b" });
  const uniq = new Map<string, TreeDiff>();
  for (const d of diffs) uniq.set(`${d.kind} ${d.path}`, d);
  if (uniq.size > 0) {
    refuse(
      `the copy does not match the gated tree (${uniq.size} difference(s)): ${[...uniq.values()].slice(0, 10).map((d) => `${d.path} (${d.kind})`).join(", ")}`,
      `delete ${relative(REPO, dest)} - it is left for inspection and carries no SHA256SUMS or GATED_COMMIT - fix plugin/, rerun bun run gate, then retry`,
    );
  }

  // ---- SHA256SUMS (see header for the ruled lowercase shape + scan exemption)
  const entries = files.map((rel): [string, string] => [
    `openrig-honcho/${rel}`,
    sha256Hex(readFileSync(join(dest, rel))),
  ]);
  writeFileSync(join(releaseDir, "SHA256SUMS"), sumsBody(entries));

  // ---- checks on what is now on disk
  const val = run(`rig plugin validate ${relative(REPO, dest)} --json`);
  const parsed = extractJson(val.out) as { valid?: unknown } | null;
  if (val.code !== 0 || parsed === null || parsed.valid !== true) {
    refuse(`rig plugin validate on the copy did not say valid true (exit ${val.code})`, "fix the plugin and rerun the gate");
  }
  const copyJson = JSON.parse(readFileSync(join(dest, ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown };
  if (copyJson.version !== version) {
    refuse(`the copy's plugin.json says ${String(copyJson.version)}, expected ${version}`, "the copy is inconsistent - remove it and rebuild");
  }
  const nm = run(`find ${relative(REPO, dest)} -name node_modules`);
  if (nm.code === 0 && nm.out.trim() !== "") {
    refuse("node_modules found in the release copy", "zero runtime deps is a hard rule (ADR-0006 X5) - remove and rebuild");
  }
  const scan = run("bun run scripts/scan.ts");
  if (scan.code !== 0) {
    refuse("the repo scan (which covers release/) failed after the copy", "see scan output; the release copy must be secret-clean");
  }

  // ---- LAST: the gated-commit record, written only after every check
  // passed (T13a). gateAllows already proved report.commit === head; the
  // 40-hex guard is the belt (pinned shape in the scan test).
  if (!/^[0-9a-f]{40}$/.test(head)) {
    refuse(`HEAD is not a 40-hex sha: ${JSON.stringify(head)}`, "cannot record a gated commit that is not a commit");
  }
  writeFileSync(gatedPath, gatedCommitBody(head));

  console.log(`RELEASE v${version} built (not tagged, not pushed)`);
  console.log(`  copy:      ${relative(REPO, dest)} (${files.length} files, byte-exact vs plugin/ and the git index; no symlinks)`);
  console.log(`  checksums: release/v${version}/SHA256SUMS (verify: cd release/v${version} && sha256sum -c SHA256SUMS)`);
  console.log(`  gated:     release/v${version}/GATED_COMMIT = ${head} (the commit the gate tested)`);
  console.log("  checks:   rig plugin validate valid=true; version matches; no node_modules; scan PASS");
  console.log(`  tag when the owner approves (local only - no remote, no push): git tag -a v${version} -m "openrig-honcho v${version}"`);
}

if (import.meta.main) {
  await main();
}
