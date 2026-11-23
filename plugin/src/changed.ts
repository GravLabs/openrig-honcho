// v0.5.9 (ADR-0019, amended 2026-11-23): "changed since" marks. A decision,
// status or lesson that names repository files is marked when any of those
// files changed after it was written, so a seat checks before acting on it
// (idea from the Cognee review, adapted: read-time, deterministic, no model,
// nothing stored). One `git log` per read in the seat's folder gives each
// file's last change time; every item is then compared in process.
//
// Never throws, never blocks: no git, not a repository, a slow or failing
// call, or no named paths all mean "no mark" - the view before v0.5.9.

import { spawnSync } from "node:child_process";

/** How far back a read looks (older items compare against this floor). */
export const LOOKBACK_DAYS = 60;
/** The git call's own time limit. */
export const GIT_TIMEOUT_MS = 400;
/** At most this many named paths per item are considered. */
export const PATHS_PER_ITEM = 8;
/** At most this much git output is read. */
const GIT_MAX_BYTES = 4 * 1024 * 1024;

const EXT = "ts|tsx|js|mjs|cjs|jsx|py|md|json|yaml|yml|toml|rs|go|cs|csproj|sln|sh|sql|java|kt|c|h|cpp|hpp|cfg|ini|txt|lock";
// a path with a folder (a/b/c.ext) or a bare file name with a known extension;
// quotes, backticks and brackets around it are fine, trailing punctuation is not part of it
const PATH_RE = new RegExp(
  String.raw`(?:^|[\s\x60'"(\[<])((?:[A-Za-z0-9_.@-]+/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:${EXT}))(?=$|[\s\x60'"),.:;!?\]>])`,
  "g",
);

/** The repository paths an item's text names (deduplicated, capped). */
export function namedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    let p = (m[1] as string).replace(/^\.\//, "");
    if (p.includes("..") || p.startsWith("/") || p.includes("://")) continue;
    p = p.replace(/\.$/, "");
    if (!out.includes(p)) out.push(p);
    if (out.length >= PATHS_PER_ITEM) break;
  }
  return out;
}

/** file (repository-relative) -> last change time in ms, from one git call. */
export type ChangeIndex = Map<string, number>;

/**
 * Parse `git log --name-only --format=@%ct` output: an "@<unix seconds>" line
 * starts each commit, then its file names. Newest first, so the first time a
 * file is seen is its last change.
 */
export function parseGitLog(out: string): ChangeIndex {
  const idx: ChangeIndex = new Map();
  let t = 0;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("@")) {
      const s = Number(line.slice(1));
      t = Number.isFinite(s) ? s * 1000 : 0;
      continue;
    }
    if (t > 0 && !idx.has(line)) idx.set(line, t);
  }
  return idx;
}

/** Runs git; injectable for tests. Returns stdout or null on any failure. */
export type GitRunner = (cwd: string, args: string[]) => string | null;

/**
 * R22 recheck F-T1/F-T2: the child's environment is the seat's, minus every
 * GIT_* variable - those can run a program inside our call (GIT_EXTERNAL_DIFF,
 * GIT_SSH_COMMAND, GIT_CONFIG_PARAMETERS ...) or point git at another
 * repository (GIT_DIR, GIT_WORK_TREE). Git then finds the repository from the
 * folder, as a seat's own `git` would. PATH, HOME and the rest are kept: git
 * needs them.
 */
export function gitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^GIT_/i.test(k)) out[k] = v;
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  return out;
}

/** A git runner with its own time limit (the outcome collector waits longer). */
export const makeGit = (timeoutMs: number): GitRunner => (cwd, args) => {
  try {
    // ADR-0006 X5 (amended 2026-11-23): the plugin's second named subprocess -
    // fixed binary, no shell, fsmonitor off, no GIT_* variable from the
    // environment (gitEnv); every caller passes --no-ext-diff --no-textconv
    // (R22 recheck: "-c diff.external=" names an empty program and breaks a
    // full diff, so it is not used)
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(process.env),
    });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout;
  } catch {
    return null;
  }
};

const realGit: GitRunner = makeGit(GIT_TIMEOUT_MS);

/** One git call covering every change since `sinceMs` (floored at LOOKBACK_DAYS). */
export function changeIndex(cwd: string | undefined, sinceMs: number, nowMs: number, git: GitRunner = realGit): ChangeIndex | null {
  if (cwd === undefined || cwd === "") return null;
  const floor = nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const since = Math.max(Number.isFinite(sinceMs) ? sinceMs : floor, floor);
  const out = git(cwd, [
    "log",
    `--since=@${Math.floor(since / 1000)}`,
    "--name-only",
    "--format=@%ct",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD",
  ]);
  return out === null ? null : parseGitLog(out);
}

/** How many of `paths` changed after `atMs` (a named path matches a changed
 * file equal to it or ending in "/<path>"). */
export function changedCount(idx: ChangeIndex, paths: string[], atMs: number): number {
  if (!Number.isFinite(atMs)) return 0;
  let n = 0;
  for (const p of paths) {
    for (const [f, t] of idx) {
      if ((f === p || f.endsWith(`/${p}`)) && t > atMs) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * The marks for a batch of items in one git call: id -> count of named files
 * changed since the item's time. Items naming no path, or with no change, are
 * absent. Any failure is an empty map.
 */
export function changedSince(
  cwd: string | undefined,
  items: { id: string; text: string; at: string }[],
  nowMs: number,
  git: GitRunner = realGit,
): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const named = items
      .map((i) => ({ ...i, paths: namedPaths(i.text), atMs: Date.parse(i.at) }))
      .filter((i) => i.paths.length > 0 && Number.isFinite(i.atMs));
    if (named.length === 0) return out;
    const idx = changeIndex(cwd, Math.min(...named.map((i) => i.atMs)), nowMs, git);
    if (idx === null || idx.size === 0) return out;
    for (const i of named) {
      const n = changedCount(idx, i.paths, i.atMs);
      if (n > 0) out.set(i.id, n);
    }
  } catch {
    /* no marks */
  }
  return out;
}

/** The visible words: "2 files it names changed since". */
export const changedLabel = (n: number): string =>
  n === 1 ? "1 file it names changed since" : `${n} files it names changed since`;

/** Time the git call needs left before a deadline, or it is skipped. */
export const MARK_MIN_LEFT_MS = GIT_TIMEOUT_MS + 100;

/**
 * Set `changed` on each entry (in place) whose named files changed since its
 * `at`. Skipped when less than MARK_MIN_LEFT_MS is left before `deadline`
 * (ms epoch; omit for no deadline). Entries without an id are left alone.
 */
export function markChanged(
  cwd: string | undefined,
  entries: { id?: string; content: string; at: string; changed?: number }[],
  now: string,
  deadline?: number,
  git: GitRunner | undefined = realGit,
): void {
  try {
    if (entries.length === 0) return;
    if (deadline !== undefined && deadline - Date.now() < MARK_MIN_LEFT_MS) return;
    const nowMs = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
    const withId = entries.filter((e) => typeof e.id === "string" && e.id !== "");
    const marks = changedSince(cwd, withId.map((e) => ({ id: e.id as string, text: e.content, at: e.at })), nowMs, git ?? realGit);
    for (const e of withId) {
      const n = marks.get(e.id as string);
      if (n !== undefined) e.changed = n;
    }
  } catch {
    /* no marks */
  }
}
