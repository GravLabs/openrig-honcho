// T8d-1 item 3: the gate's repo scan (ADR-0006 X5/X6, precision rule
// ADR-0007). `bun run scripts/scan.ts` exits 1 on any failure. Never prints a
// matched value - only file:line:kind.
//
// (a) secret scan: redact() over every tracked file (git ls-files) and every
//     file under release/ when it exists. FAIL on the high-confidence kinds
//     (anthropic, strata, jwt, pem, hex64, opaque, json-secret, gittoken - F1,
//     ADR-0018: GitHub and GitLab tokens, the redact.ts gittoken rule). assignment/
//     bearer matches whose value is code (contains ( [ . $ / { or is an
//     env-var-name token) are LISTED, not failed; any other such match fails.
//     ZONES (ADR-0007, amended a9ee84a): under .claude/skills/ (vendored
//     upstream docs) every match is LISTED, never failed. Under tests/ a
//     high-confidence match PASSES (lists) only when the line carries the
//     marker `fake-secret` - an unmarked high-confidence match FAILS, so a
//     real secret pasted into a test by accident is caught. A code-value
//     assignment/bearer match stays LISTED in tests/ too (the amendment marks
//     synthetic VALUES, not env lookups - the architect's ~42-line estimate
//     is the HIGH set); a non-code assignment/bearer match in tests/ follows
//     the same marker rule: marked LISTED, unmarked FAILED. Elsewhere the
//     base rules are strict.
// (b) zero runtime deps: no node_modules under plugin/, and no package.json
//     (tracked or under release/) with a non-empty dependency map.
// (c) exactly ONE execFile( in plugin/, in plugin/src/nudge.ts; no bare
//     exec(, no spawn(, no shell: true, no eval(, no new Function; the
//     child_process module is importable only in nudge.ts (a bare `.exec(`
//     on a RegExp - the 6 existing call sites - is not the child_process
//     surface; the import check is what closes that door).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { redact } from "../plugin/src/redact.ts";

export interface Finding {
  file: string;
  line: number; // 0 = file-level finding
  kind: string;
  why: string;
}

export interface ScanResult {
  files: number;
  fails: Finding[];
  lists: Finding[];
  notes: string[];
  ok: boolean;
  summary: string;
}

const HIGH = ["anthropic", "strata", "jwt", "pem", "hex64", "opaque", "json-secret", "gittoken"];
const TESTS_PREFIX = "tests/";
const SKILLS_PREFIX = ".claude/skills/";
/** Architect ruling 04:06Z (T9): release checksums ship lowercase "<64hex>
 * <space><space><path>" lines, which the hex64 rule would fail on every
 * future gate. EXACTLY that line shape inside a file named SHA256SUMS
 * directly under release/v<something>/ is not a finding; every other line of
 * that file, and the same line anywhere else, is scanned normally. */
const SUMS_FILE = /^release\/v[^/]+\/SHA256SUMS$/;
const SUMS_LINE = /^[0-9a-f]{64}  \S+$/;
/** ADR-0007 (a9ee84a): the substring a tests/ line must carry for a synthetic
 * secret-shaped value to pass the high-confidence (and non-code low) rules. */
export const FAKE_MARKER = "fake-secret";

// Value extractors mirror redact.ts's own patterns exactly, so "matched or
// not" (redact's verdict) and "what is the value" (this scan's verdict)
// agree. Kept as factories: fresh lastIndex per line.
const assignVals = (): RegExp =>
  new RegExp(String.raw`\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["']?([^\s"']{8,})`, "gi");
const bearerVals = (): RegExp =>
  new RegExp(String.raw`(?:authorization:\s*(?:bearer|basic)\s+|bearer\s+)(\S{16,})`, "gi");

const isCodeValue = (v: string): boolean =>
  /[(\/[\].${]/.test(v) || /^[A-Z][A-Z0-9_]{2,}$/.test(v); // call/path/index/attr/interp or an env-var NAME token

const collect = (re: RegExp, line: string): string[] => {
  const out: string[] = [];
  let m = re.exec(line);
  while (m !== null) {
    out.push(m[1] as string);
    m = re.exec(line);
  }
  return out;
};

const walkFiles = (dir: string, prefix: string, into: Map<string, string>): void => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) walkFiles(abs, rel, into);
    else if (e.isFile()) into.set(rel, abs);
  }
};

export function scanRepo(root: string): ScanResult {
  const fails: Finding[] = [];
  const lists: Finding[] = [];
  const notes: string[] = [];
  let fileCount = 0;

  const fail = (file: string, line: number, kind: string, why: string): void => {
    fails.push({ file, line, kind, why });
  };
  const list = (file: string, line: number, kind: string, why: string): void => {
    lists.push({ file, line, kind, why });
  };

  // --- gather targets: tracked files + release/ ---
  // Architect 22:45Z (review observation): a scan of nothing is not a pass.
  // A git ls-files ERROR (e.g. a non-git dir) or a ZERO file list fails the
  // scan outright - silent degradation to release/ would print PASS over an
  // unscanned tree.
  const targets = new Map<string, string>(); // rel -> abs
  let tracked: string[] = [];
  let lsFilesOk = true;
  try {
    tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split("\n").filter((s) => s !== "");
  } catch {
    lsFilesOk = false;
    fail("(scan)", 0, "git_ls_files", "git ls-files failed (not a git repo?) - a scan of nothing is not a pass");
  }
  if (lsFilesOk && tracked.length === 0) {
    fail("(scan)", 0, "no_tracked_files", "git ls-files returned zero files - a scan of nothing is not a pass");
  }
  for (const rel of tracked) {
    const abs = join(root, rel);
    if (existsSync(abs) && statSync(abs).isFile()) targets.set(rel, abs);
  }
  walkFiles(join(root, "release"), "release", targets);

  // --- (a) secret scan ---
  for (const [rel, abs] of targets) {
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      notes.push(`unreadable, skipped: ${rel}`);
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      notes.push(`binary, skipped: ${rel}`);
      continue;
    }
    fileCount += 1;
    const inTests = rel.startsWith(TESTS_PREFIX);
    const skillsOnly = !inTests && rel.startsWith(SKILLS_PREFIX);
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] as string;
      if (SUMS_FILE.test(rel) && SUMS_LINE.test(ln)) continue; // the ruled sums shape
      const marked = ln.includes(FAKE_MARKER); // ADR-0007 tests/ marker
      let counts: Record<string, number>;
      try {
        counts = redact(ln).counts;
      } catch {
        continue;
      }
      for (const k of HIGH) {
        if ((counts[k] ?? 0) > 0) {
          if (skillsOnly) list(rel, i + 1, k, "listed zone (vendored examples)");
          else if (inTests && marked) list(rel, i + 1, k, "tests/ line marked fake-secret");
          else if (inTests) fail(rel, i + 1, k, "high-confidence secret shape in tests/ without the fake-secret marker");
          else fail(rel, i + 1, k, "high-confidence secret shape");
        }
      }
      for (const k of ["assignment", "bearer"]) {
        if ((counts[k] ?? 0) === 0) continue;
        const vals = collect(k === "assignment" ? assignVals() : bearerVals(), ln);
        const placeholder = (v: string): boolean => v.startsWith("<"); // <value>, <64hex>: doc template markers
        if (skillsOnly) {
          list(rel, i + 1, k, "listed zone (vendored examples)");
        } else if (vals.length === 0) {
          list(rel, i + 1, k, "value not extractable");
        } else if (vals.some((v) => isCodeValue(v) || placeholder(v))) {
          list(rel, i + 1, k, vals.some(isCodeValue) ? "code value" : "placeholder value");
        } else if (inTests && marked) {
          list(rel, i + 1, k, "tests/ line marked fake-secret");
        } else if (inTests) {
          fail(rel, i + 1, k, "assignment/bearer match with a non-code value in tests/ without the fake-secret marker");
        } else {
          fail(rel, i + 1, k, "assignment/bearer match with a non-code value");
        }
      }
    }
  }

  // --- (b) zero runtime deps ---
  const nmWalk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const childRel = `${rel}/${e.name}`;
      if (e.name === "node_modules") fail(childRel, 0, "node_modules", "plugin/ must ship zero dependencies");
      else nmWalk(join(dir, e.name), childRel);
    }
  };
  nmWalk(join(root, "plugin"), "plugin");

  for (const [rel, abs] of targets) {
    if (!rel.endsWith("package.json")) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    } catch {
      notes.push(`package.json unparseable: ${rel}`);
      continue;
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const map = pkg[field];
      if (map && typeof map === "object" && Object.keys(map as object).length > 0) {
        fail(rel, 0, field, "package.json declares dependencies");
      }
    }
  }

  // --- (c) the one subprocess ---
  const subFiles = [...targets.entries()].filter(([rel]) => /(^|\/)plugin\//.test(rel) && rel.endsWith(".ts"));
  let execFileTotal = 0;
  let execFileOutsideNudge = 0;
  for (const [rel, abs] of subFiles) {
    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const isNudge = rel === "plugin/src/nudge.ts";
    for (const m of text.matchAll(/\bexecFile\s*\(/g)) {
      execFileTotal += 1;
      void m;
      if (!isNudge) execFileOutsideNudge += 1;
    }
    for (const m of text.matchAll(/exec\s*\(/g)) {
      const before = text[(m.index as number) - 1];
      if (before !== ".") fail(rel, lineOf(text, m.index as number), "exec", "bare exec( is forbidden (X5)");
    }
    // no dot-exemption here: Bun.spawn / child_process.spawn are real
    // subprocesses; only RegExp's .exec( needs the receiver check
    for (const m of text.matchAll(/\bspawn\s*\(/g)) fail(rel, lineOf(text, m.index as number), "spawn", "spawn( is forbidden (X5)");
    for (const m of text.matchAll(/shell\s*:\s*true/g)) fail(rel, lineOf(text, m.index as number), "shell", "shell: true is forbidden (X5)");
    for (const m of text.matchAll(/\beval\s*\(/g)) {
      const before = text[(m.index as number) - 1];
      if (before !== ".") fail(rel, lineOf(text, m.index as number), "eval", "eval( is forbidden (X5)");
    }
    for (const m of text.matchAll(/\bnew\s+Function\b/g)) fail(rel, lineOf(text, m.index as number), "new_function", "new Function is forbidden (X5)");
    if (!isNudge && /from\s+["']node:child_process["']|require\(\s*["']node:child_process["']\s*\)/.test(text)) {
      fail(rel, 0, "child_process_import", "only plugin/src/nudge.ts may import child_process (X5)");
    }
  }
  // "exactly one" only binds trees that carry the full plugin layout (the
  // nudge call site exists); stripped trees still get every forbidden check
  const fullPlugin = [...targets.keys()].some((rel) => /(^|\/)plugin\/src\/nudge\.ts$/.test(rel));
  if (fullPlugin) {
    if (execFileTotal !== 1) fail("plugin", 0, "exec_file_count", `expected exactly 1 execFile( in plugin/, found ${execFileTotal}`);
    else if (execFileOutsideNudge > 0) fail("plugin", 0, "exec_file_location", `execFile( outside plugin/src/nudge.ts: ${execFileOutsideNudge}`);
  }

  const ok = fails.length === 0;
  const summary = `scan: ${ok ? "PASS" : "FAIL"} files=${fileCount} fails=${fails.length} listed=${lists.length}${notes.length > 0 ? ` notes=${notes.length}` : ""}`;
  return { files: fileCount, fails, lists, notes, ok, summary };
}

const lineOf = (text: string, idx: number): number => {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") n += 1;
  return n;
};

/** The ONLY printed representation of a finding - structurally cannot carry
 * a matched value, only file:line:kind. */
export const formatFinding = (f: Finding, tag: string): string => `${tag} ${f.file}:${f.line}:${f.kind}`;

export function render(r: ScanResult): string {
  const out: string[] = [];
  // `why` is a fixed phrase, never a matched value (see Finding's callers)
  for (const f of r.fails) out.push(`${formatFinding(f, "FAIL")} ${f.why}`);
  for (const f of r.lists) out.push(formatFinding(f, "LIST"));
  for (const n of r.notes) out.push(`NOTE ${n}`);
  out.push(r.summary);
  return out.join("\n");
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const result = scanRepo(root);
  console.log(render(result));
  process.exit(result.ok ? 0 : 1);
}
