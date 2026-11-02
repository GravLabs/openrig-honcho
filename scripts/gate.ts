// T8e: `bun run gate` - the v0.1 release gate (ADR-0006 "The gate", and what
// runs before every Gitea push per ADR-0007). Nine steps, in order; the gate
// stops at NOTHING (every step runs even after a failure) and exits 1 if any
// step failed. Each step prints exactly one line:
//   GATE <step> PASS|FAIL <short detail>
// Step results, durations, captured summary lines, the START commit (commit;
// headAtEnd is what HEAD became by the end), the tree-clean flag and
// leftovers land in gate-report.json (git-ignored). The report step FAILS if
// HEAD moved or the tracked tree went dirty during the run (T12d): the
// attestation covers only what the steps actually ran.
//
// No step may print a secret: counts, file:line:kind and our own summary
// lines only. Steps never run in parallel - integration (light) and heavy
// are sequential by construction.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../plugin/src/redact.ts";

const REPO = join(import.meta.dir, "..");
const SCRATCH_PREFIX = "honcho-bridge-scratch";

// ---------- pure parts (unit-tested in tests/unit/gate.test.ts) ----------

export interface StepResult {
  step: string;
  status: "PASS" | "FAIL";
  ms: number;
  detail: string;
  summaryLine?: string;
  /** FAIL only: the failing child's last failTailLines() lines, redacted
   * (architect 01:39Z) - the gate must not just stop at nothing, it must
   * explain itself. */
  failTail?: string[];
}

/** Git tree verdict (pure; architect 01:53Z after review's pin-test ask):
 * clean = NO TRACKED changes; untracked is counted SEPARATELY (OpenRig-
 * managed seat files we never commit). "clean with 3 untracked config files"
 * is a different claim than the old porcelain-everything version, so the
 * pair gets an explicit test instead of living inline. Inputs are the two
 * porcelain outputs (tracked-only, then all). */
export function treeState(
  porcelainTracked: string,
  porcelainAll: string,
): { clean: boolean; untracked: number } {
  return {
    clean: porcelainTracked.trim() === "",
    untracked: porcelainAll.split("\n").filter((l) => l.startsWith("??")).length,
  };
}

/** The post-mortem tail (pure): last n NON-BLANK lines of a child's output,
 * each passed through redact() before it may reach the report - tests use
 * only marked fakes, but the belt goes on anyway (architect 01:39Z). */
export function failTail(out: string, n = 40): string[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .map((l) => redact(l).text);
}

export function gateExit(results: readonly StepResult[]): 0 | 1 {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

/**
 * T12d (architect 19:18Z, born from the 19:10Z run): the gate attests the
 * commit the STEPS actually ran. HEAD (and the tracked-tree verdict) is
 * captured before any step and re-read at report time; a move in between is
 * a report FAIL, because ADR-0007 releases only from a commit the gate
 * passed, and a mid-run commit swap would let an untested change inherit
 * the attestation. Values are plain inputs so a test can fake the reader.
 * A tree that was DIRTY at start stays report-but-not-fail (architect
 * 01:39Z: a dirty tree is reported; release.ts is what refuses); only
 * clean-at-start -> dirty-at-end fails as a mid-run change.
 */
export function integrityVerdict(
  headAtStart: string,
  cleanAtStart: boolean,
  headAtEnd: string,
  cleanAtEnd: boolean,
): { status: "PASS" | "FAIL"; note: string } {
  if (headAtStart === "") return { status: "FAIL", note: "git HEAD unreadable at gate start - nothing to attest" };
  if (headAtEnd === "") return { status: "FAIL", note: "git HEAD unreadable at gate end - attestation unverifiable" };
  if (headAtStart !== headAtEnd) {
    return { status: "FAIL", note: `HEAD moved during the gate: ${headAtStart} -> ${headAtEnd}` };
  }
  if (cleanAtStart && !cleanAtEnd) {
    return { status: "FAIL", note: "tracked files became dirty during the gate" };
  }
  return { status: "PASS", note: "HEAD and tracked tree unchanged across the run" };
}

/** Parse `N pass / N fail / N skip` out of bun test output; null when the
 * run produced no recognizable summary (crash -> caller FAILs the step). */
export function parseBunCounts(out: string): { pass: number; fail: number; skip: number } | null {
  const p = /(\d+) pass/.exec(out);
  const f = /(\d+) fail/.exec(out);
  const s = /(\d+) skip/.exec(out);
  if (p === null || f === null) return null;
  return { pass: Number(p[1]), fail: Number(f[1]), skip: s === null ? 0 : Number(s[1]) };
}

/** T16e (ADR-0012 decision 1): the line tests/unit/envelope-contract.test.ts
 * prints when the installed @openrig/cli cannot be loaded. The unit step
 * fails on it - the envelope contract MUST run at the gate, or an OpenRig
 * upgrade that moves the envelope ships silently. OPENRIG_CONTRACT_SKIP=1 is
 * the explicit "this machine has no OpenRig" escape. */
export const ENVELOPE_CONTRACT_SKIP_MARKER = "ENVELOPE_CONTRACT SKIPPED";

export function envelopeContractSkip(out: string, allowSkip: string | undefined): string | null {
  if (allowSkip === "1") return null;
  const line = out
    .split("\n")
    .find((l) => l.includes(ENVELOPE_CONTRACT_SKIP_MARKER));
  if (line === undefined) return null;
  return `envelope contract test skipped - ${line.trim()} - set OPENRIG_CONTRACT_SKIP=1 only on machines without OpenRig`;
}

/**
 * T16h (2026-11-01 incident: ~31k leftover test dirs took the shared /tmp
 * tmpfs to 100% inodes and the unit gate could not even mkdtemp): names
 * present in AFTER but not in BEFORE - the entries this step created and
 * LEFT BEHIND. Inputs are `ls -A /tmp`-style name lists. Counts only, never
 * contents: /tmp names from other rigs may never reach a gate line.
 */
export function newTmpEntries(before: ReadonlySet<string>, after: Iterable<string>): string[] {
  return [...after].filter((n) => !before.has(n));
}

/** First {...} JSON object in a CLI's stdout (tolerates surrounding prose);
 * null when there is none. */
export function extractJson(out: string): unknown {
  const s = out.indexOf("{");
  const e = out.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(out.slice(s, e + 1));
  } catch {
    return null;
  }
}

/** The leftovers filter (pure): honcho-bridge-scratch* workspaces created AT
 * or after the gate start. A missing created_at counts as from-this-run
 * (fail-safe: an unprovable workspace is treated as ours to wait for). */
export function postStartScratch(
  items: ReadonlyArray<{ id: string; created_at?: string }>,
  gateStartMs: number,
): string[] {
  return items
    .filter(
      (i) =>
        i.id.startsWith(SCRATCH_PREFIX) &&
        (i.created_at === undefined || Date.parse(i.created_at) >= gateStartMs),
    )
    .map((i) => i.id);
}

export interface LeftoverOutcome {
  status: "PASS" | "FAIL";
  stillListed: string[];
  preExisting: string[];
  /** T14f: from-this-run scratch still listed whose DELETE this run had
   * accepted - the server's purge is pending, the release refuses on it. */
  pendingDeletes: string[];
  note: string;
}

/** Step 8 as pure logic over an injected lister: poll until no
 * from-this-run scratch workspace is listed, or the deadline passes. A
 * failing/unreachable list (lister throws) is a FAIL, never "empty".
 * T14f (ADR-0006 amendment 2026-10-31): past the deadline, PASS iff every
 * still-listed name has an accepted DELETE (`accepted`, read from the run's
 * gate-deletes.jsonl by the caller); those become pendingDeletes. A name
 * without an accepted DELETE stays a FAIL. */
export async function leftoverCheck(
  listWorkspaces: () => Promise<Array<{ id: string; created_at?: string }>>,
  gateStartMs: number,
  opts: {
    deadlineMs: number;
    pollMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    accepted?: ReadonlySet<string>;
  },
): Promise<LeftoverOutcome> {
  const started = opts.now();
  let lastNote = "";
  let preExisting: string[] = [];
  for (;;) {
    let items: Array<{ id: string; created_at?: string }>;
    try {
      items = await listWorkspaces();
    } catch (e) {
      return {
        status: "FAIL",
        stillListed: [],
        preExisting: [],
        pendingDeletes: [],
        note: `workspaces/list failed: ${e instanceof Error ? e.message : String(e)} - cannot prove deletion`,
      };
    }
    const still = postStartScratch(items, gateStartMs);
    preExisting = items
      .filter((i) => i.id.startsWith(SCRATCH_PREFIX) && !still.includes(i.id))
      .map((i) => i.id);
    lastNote =
      still.length === 0
        ? `no from-this-run scratch left; pre-existing scratch (not failed): ${JSON.stringify(preExisting)}`
        : `${still.length} from-this-run scratch still listed`;
    if (still.length === 0) {
      return { status: "PASS", stillListed: [], preExisting, pendingDeletes: [], note: lastNote };
    }
    if (opts.now() - started >= opts.deadlineMs) {
      const accepted = opts.accepted ?? new Set<string>();
      const unproven = still.filter((n) => !accepted.has(n));
      if (unproven.length === 0) {
        // every lingering workspace was accepted by a DELETE this run: the
        // server's single deriver just has not purged them yet (ADR-0006:
        // the gate proves acceptance, release.ts refuses until they settle)
        return {
          status: "PASS",
          stillListed: [],
          preExisting,
          pendingDeletes: still,
          note: `${still.length} from-this-run scratch still listed with an accepted DELETE: ${still.join(", ")} - purge pending (pendingDeletes)`,
        };
      }
      return {
        status: "FAIL",
        stillListed: still,
        preExisting,
        pendingDeletes: still.filter((n) => accepted.has(n)),
        note: `${lastNote}; no accepted DELETE for: ${unproven.join(", ")}`,
      };
    }
    await opts.sleep(opts.pollMs);
  }
}

export interface StepSpec {
  name: string;
  argv: string[]; // resolved against the repo root; "bun" -> process.execPath
  env?: Record<string, string>;
  kind: "test" | "scan" | "validate";
  /** test steps: 0 fail (and 0 skip for contract). */
  noSkip?: boolean;
  /** capture the first line containing this marker into summaryLine. */
  capture?: string;
}

export const STEPS: readonly StepSpec[] = [
  { name: "unit", argv: ["bun", "test", "tests/unit", "tests/property"], kind: "test" },
  { name: "contract", argv: ["bun", "test", "tests/contract"], kind: "test", noSkip: true },
  { name: "chaos", argv: ["bun", "test", "tests/chaos"], kind: "test", capture: "CHAOS SUMMARY" },
  { name: "integration", argv: ["bun", "test", "tests/integration"], kind: "test" },
  {
    name: "heavy",
    argv: ["bun", "test", "tests/integration", "tests/soak"],
    env: { HONCHO_HEAVY_TESTS: "1" },
    kind: "test",
    capture: "SOAK SUMMARY",
  },
  { name: "scan", argv: ["bun", "run", "scripts/scan.ts"], kind: "scan" },
  { name: "validate", argv: ["rig", "plugin", "validate", "plugin", "--json"], kind: "validate" },
];

// ---------- real-run pieces ----------

/**
 * T8e-fix-4 (architect 02:46Z, born from gate run 3): HONCHO_HEAVY_TESTS is
 * NEVER inherited from the gate process - only a step's own env sets it.
 * Run 3 exposed the leak: `HONCHO_HEAVY_TESTS=1 bun run gate` exported the
 * flag into EVERY step's env, so the LIGHT integration step ran heavy-flagged
 * (review-t6c's gated tests ran in it; its afterAlls took the heavy path and
 * the light disappearance verification never executed in-gate).
 */
export function stepEnv(
  spec: StepSpec,
  procEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(procEnv)) {
    if (k === "HONCHO_HEAVY_TESTS" && spec.env?.HONCHO_HEAVY_TESTS === undefined) continue;
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...(spec.env ?? {}) };
}

/** Run one command step (exported for the unit smoke; the gate itself is
 * sequential and runs every step always). */
export async function runSpec(spec: StepSpec): Promise<StepResult> {
  const t0 = Date.now();
  const argv = spec.argv.map((a) => (a === "bun" ? process.execPath : a));
  // F-T8f-1 (review 00:50Z, qitem T8e-fix): a missing binary makes Bun.spawn
  // THROW (ENOENT, e.g. `rig` absent from a non-login shell's PATH). That
  // throw becomes FAIL with detail "spawn: <code>" - the gate stops at
  // nothing: remaining steps, the leftovers poll and gate-report.json all
  // still happen, and the gate exits 1.
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, {
      cwd: REPO,
      env: stepEnv(spec, process.env as Record<string, string | undefined>),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? (e instanceof Error ? e.name : "unknown");
    return { step: spec.name, status: "FAIL", ms: Date.now() - t0, detail: `spawn: ${code}` };
  }
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  const code = await p.exited;
  const ms = Date.now() - t0;
  const combined = `${out}\n${err}`;
  const grab = spec.capture === undefined ? undefined : combined.split("\n").find((l) => l.includes(spec.capture as string));
  const tail = failTail(combined);
  const fail = (detail: string): StepResult => ({
    step: spec.name,
    status: "FAIL",
    ms,
    detail,
    ...(grab !== undefined ? { summaryLine: grab.trim() } : {}),
    ...(tail.length > 0 ? { failTail: tail } : {}),
  });

  if (spec.kind === "test") {
    // T16e: the envelope contract test may only skip on an explicit allow.
    if (spec.name === "unit") {
      const ec = envelopeContractSkip(combined, process.env.OPENRIG_CONTRACT_SKIP);
      if (ec !== null) return fail(ec);
    }
    const c = parseBunCounts(combined);
    if (c === null) return fail(`no bun summary (exit ${code})`);
    if (code !== 0 && c.fail === 0) return fail(`exit ${code} with 0 fail (bun crashed?)`);
    if (c.fail > 0) return fail(`${c.fail} fail / ${c.pass} pass`);
    if (spec.noSkip === true && c.skip > 0) return fail(`${c.skip} skip (contract skips only when the server is unreachable)`);
    const summaryLine = grab ?? `pass=${c.pass} skip=${c.skip}`;
    return { step: spec.name, status: "PASS", ms, detail: `pass=${c.pass} skip=${c.skip}`, ...(summaryLine !== undefined ? { summaryLine } : {}) };
  }
  if (spec.kind === "scan") {
    const line = combined.split("\n").find((l) => l.startsWith("scan:")) ?? "";
    if (code !== 0) return fail(`exit ${code} ${line}`);
    return { step: spec.name, status: "PASS", ms, detail: line.replace(/^scan: (PASS|FAIL) /, ""), summaryLine: line };
  }
  // validate
  const parsed = extractJson(out) as { valid?: unknown } | null;
  if (parsed === null) return fail(`unparsable --json output (exit ${code})`);
  if (code !== 0 || parsed.valid !== true) {
    // errors are paths/phrases from rig, never secret values
    return fail(`valid=${String(parsed.valid)} (exit ${code})`);
  }
  return { step: spec.name, status: "PASS", ms, detail: "valid true" };
}

const BASE = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/+$/, "");

/** All pages of workspaces/list (size<=100 per the ruled cap); throws on any
 * non-2xx - an unreachable list must never read as "empty".
 * T14f: exported so release.ts reuses the exact same read-only request. */
export async function listAllWorkspaces(): Promise<Array<{ id: string; created_at?: string }>> {
  const seen = new Map<string, { id: string; created_at?: string }>();
  for (let page = 1; page <= 20; page++) {
    const resp = await fetch(`${BASE}/workspaces/list?size=100&page=${page}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HONCHO_API_KEY ?? "local"}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const p = (await resp.json()) as { items?: Array<{ id: string; created_at?: string }>; pages?: number; total?: number };
    if (!Array.isArray(p.items)) throw new Error("answer had no items array");
    for (const it of p.items) seen.set(it.id, it);
    const pages = p.pages ?? 1;
    if (page >= pages || p.items.length === 0) break;
  }
  return [...seen.values()];
}

/** T14f (ADR-0006 amendment 2026-10-31): read the run's accepted-deletes file
 * (one JSON line `{"name":..,"at":..}` per accepted DELETE, written by
 * cleanupScratch while HONCHO_GATE_DELETES is set) into a name set. Any read
 * or parse failure yields the EMPTY set - fail-safe: an unreadable file never
 * turns an unproven leftover into a pass. */
export function readAcceptedDeletes(path: string): ReadonlySet<string> {
  try {
    const names = new Set<string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const o = JSON.parse(line) as { name?: unknown };
      if (typeof o.name === "string") names.add(o.name);
    }
    return names;
  } catch {
    return new Set<string>();
  }
}

/** T12d readers (git can fail: empty head / untracked -1 report honestly;
 * integrityVerdict turns an unreadable HEAD into a FAIL, never a blank pass). */
const readHead = (): string => {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const readTree = (): { clean: boolean; untracked: number } => {
  try {
    return treeState(
      execSync("git status --porcelain --untracked-files=no", { cwd: REPO, encoding: "utf8" }),
      execSync("git status --porcelain", { cwd: REPO, encoding: "utf8" }),
    );
  } catch {
    return { clean: false, untracked: -1 }; // -1 = could not count (git failed)
  }
};

/** T16h: the /tmp name list around the unit step (names only, never
 * contents). null = /tmp unreadable - the leak check cannot run and stays
 * silent (a /tmp that cannot be read also cannot host mkdtemp: the unit
 * step itself fails then). */
/** T16h: tests/support/tempdir.ts gives every test temp dir this prefix. */
const TEMP_PREFIX = "ohr-";

const tmpSnapshot = (): Set<string> | null => {
  try {
    return new Set(readdirSync("/tmp"));
  } catch {
    return null;
  }
};

async function main(): Promise<void> {
  const startedMs = Date.now();
  const startedIso = new Date(startedMs).toISOString();
  // T14f: a fresh accepted-deletes file for THIS run, then the env that makes
  // every step's cleanupScratch record into it (git-ignored, 0600). Unlike
  // HONCHO_HEAVY_TESTS this one is meant to reach every step, so setting it
  // on process.env - which stepEnv copies - is the mechanism, not a leak.
  const deletesFile = join(REPO, "gate-deletes.jsonl");
  rmSync(deletesFile, { force: true });
  writeFileSync(deletesFile, "", { mode: 0o600 });
  process.env.HONCHO_GATE_DELETES = deletesFile;
  // T12d: capture what the run will attest BEFORE any step touches anything
  const headAtStart = readHead();
  const treeAtStart = readTree();
  const results: StepResult[] = [];

  for (const spec of STEPS) {
    // T8e-fix belt: even an unexpected per-step error must not swallow the
    // remaining steps or gate-report.json (the gate stops at nothing).
    // T16h: the unit step doubles as the temp-dir leak gate on shared /tmp.
    const tmpBefore = spec.name === "unit" ? tmpSnapshot() : null;
    let r: StepResult;
    try {
      r = await runSpec(spec);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e instanceof Error ? e.name : "unknown");
      r = { step: spec.name, status: "FAIL", ms: 0, detail: `spawn: ${code}` };
    }
    if (tmpBefore !== null) {
      // only our own entries (makeTempDir names them ohr-*): /tmp is shared,
      // and another rig's files must never fail this gate (architect 20:45Z)
      const news = newTmpEntries(tmpBefore, tmpSnapshot() ?? new Set<string>()).filter((n) =>
        n.startsWith(TEMP_PREFIX),
      );
      if (news.length > 20) {
        r = {
          ...r,
          status: "FAIL",
          detail: `${r.detail}; tmp: ${news.length} new /tmp entries left after the unit run (limit 20, ohr-* only)`,
        };
      }
    }
    results.push(r);
    console.log(`GATE ${r.step} ${r.status} ${r.detail}`);
  }

  // step 8: leftovers. T14f (ADR-0006 amendment 2026-10-31): the 15-minute
  // disappearance wait is gone - the gate proves each DELETE was ACCEPTED
  // (cleanupScratch recorded it in gate-deletes.jsonl) and polls only 120 s
  // for the purge; past that, every still-listed name with an accepted DELETE
  // passes as pendingDeletes, and release.ts is what refuses to ship while any
  // scratch is still listed. A still-listed name WITHOUT an accepted DELETE,
  // or a failing list, still FAILs. Never delete anything.
  const loT0 = Date.now();
  const lo = await leftoverCheck(listAllWorkspaces, startedMs, {
    deadlineMs: 120_000,
    pollMs: 15_000,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    accepted: readAcceptedDeletes(deletesFile),
  });
  const loDetail =
    lo.status === "PASS"
      ? lo.pendingDeletes.length === 0
        ? "no from-this-run scratch left"
        : `${lo.pendingDeletes.length} accepted deletes pending purge: ${lo.pendingDeletes.join(", ")}`
      : `still listed: ${JSON.stringify(lo.stillListed)}`;
  results.push({
    step: "leftovers",
    status: lo.status,
    ms: Date.now() - loT0, // its OWN duration, not time since gate start (review's anchor nit)
    detail: loDetail,
    summaryLine: lo.note,
  });
  console.log(`GATE leftovers ${lo.status} ${results[results.length - 1]?.detail ?? ""}`);

  // step 9: the report + the T12d attestation. clean = NO TRACKED changes
  // (architect 01:39Z): untracked files are OpenRig-managed seat files we
  // never commit, so they are counted separately, never mixed into the clean
  // flag. A tree dirty AT START is still reported-not-failed; a HEAD move or
  // a clean->dirty flip DURING the run fails the report step (and the gate):
  // the attestation covers only what the steps actually ran.
  const headAtEnd = readHead();
  const treeAtEnd = readTree();
  const verdict = integrityVerdict(headAtStart, treeAtStart.clean, headAtEnd, treeAtEnd.clean);
  const report = {
    started: startedIso,
    finished: new Date().toISOString(),
    commit: headAtStart, // T12d: the START sha - what the steps actually ran
    headAtEnd, // and what HEAD had become by the end (differs only on a FAIL)
    // clean only if the steps both started and ended on a clean tree: a tree
    // dirty at start and reverted mid-run must not read as gated-clean
    cleanTree: treeAtStart.clean && treeAtEnd.clean,
    untracked: treeAtEnd.untracked,
    exit: verdict.status === "FAIL" ? 1 : gateExit(results),
    steps: results,
    leftovers: {
      stillListed: lo.stillListed,
      preExisting: lo.preExisting,
      pendingDeletes: lo.pendingDeletes,
    },
  };
  const reportPath = join(REPO, "gate-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const reportDetail = `gate-report.json commit=${headAtStart.slice(0, 7)} clean=${treeAtEnd.clean} untracked=${treeAtEnd.untracked}`;
  results.push({
    step: "report",
    status: verdict.status,
    ms: 0,
    detail: verdict.status === "FAIL" ? `${verdict.note} (${reportDetail})` : reportDetail,
  });
  console.log(`GATE report ${verdict.status} ${results[results.length - 1]?.detail ?? ""}`);

  process.exit(gateExit(results));
}

if (import.meta.main) {
  void main();
}
