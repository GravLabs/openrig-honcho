// ADR-0021 (v0.5.12) decisions 1+2: ONE place answers "do our hooks run for
// this folder?". The installer (plugin/bin/install-project.ts) uses it to
// decide the no-double-run skip; status (plugin/bin/status.ts) uses it to
// tell a seat whose config works but whose hooks never fire - a pods/ subfolder of a plain folder,
// found 2026-11-25: Claude Code applies an ancestor's settings to a subfolder
// only inside the same git working tree, and that pilot root is not a repository, so
// its root's hooks never covered its pods seats.
//
// The "ours" test is the T15b matcher (ADR-0010 decision 1): a hook command
// naming one of our four bins inside a folder named openrig-honcho. An
// ancestor is a different copy of the plugin (a pilot's own clone), so
// PLUGIN_DIR cannot decide it - the folder NAME and the bin names do.
// READ-ONLY and subprocess-free (ADR-0006 X5): every check here only opens
// files that exist; an unreadable or invalid file is ignored.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

type Json = Record<string, unknown>;
const isJsonObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const OPENRIG_HONCHO_SEGMENT_RE = /(?:^|[/\\])openrig-honcho[/\\]/;
export const OUR_BIN_SEGMENT_RE = /(?:^|[/\\])bin[/\\](?:session-start|recall|user-prompt|stop)\.ts/;

export const namesOurBin = (v: unknown): boolean => {
  if (typeof v === "string")
    return OPENRIG_HONCHO_SEGMENT_RE.test(v) && OUR_BIN_SEGMENT_RE.test(v);
  if (Array.isArray(v)) return v.some(namesOurBin);
  if (isJsonObject(v)) return Object.values(v).some(namesOurBin);
  return false;
};

/** N-G24 (R25 recheck): the identity that applies to the RUNNING plugin's own
 * hooks/hooks.json. That file IS the plugin Claude Code loaded, so a copy
 * installed under a different folder name still runs these bins - there only
 * the bin-name test applies (after the placeholder expansion). The full T15b
 * matcher (folder segment + bin) keeps guarding settings files and ancestors,
 * where it is exactly what stops OTHER copies from counting as coverage. */
export const namesOurPluginBin = (v: unknown): boolean => {
  if (typeof v === "string") return OUR_BIN_SEGMENT_RE.test(v);
  if (Array.isArray(v)) return v.some(namesOurPluginBin);
  if (isJsonObject(v)) return Object.values(v).some(namesOurPluginBin);
  return false;
};

/** The two settings files of a folder, the order Claude's own precedence
 * gives them here (local first). */
function settingsFiles(dir: string): string[] {
  return [join(dir, ".claude", "settings.local.json"), join(dir, ".claude", "settings.json")];
}

/** Does this settings file run our hooks (its hooks object names our bins)? */
function settingsRunOurHooks(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(parsed) || !isJsonObject(parsed.hooks)) return false;
    for (const groups of Object.values(parsed.hooks as Json)) {
      if (Array.isArray(groups) && groups.some((g) => namesOurBin(g))) return true;
    }
  } catch {
    // absent, unreadable or invalid: ignored
  }
  return false;
}

/** The nearest folder at or above dir holding a `.git` entry - the folder's
 * git working-tree root (ADR-0021 decision 1). The entry counts whether it is
 * a directory or a file (linked worktrees use a file); found by walking up
 * the filesystem, no subprocess. */
function findWorkingTreeRoot(dir: string): string | null {
  for (let probe = dir; ; probe = dirname(probe)) {
    try {
      lstatSync(join(probe, ".git")); // no follow needed: entry present either way
      return probe;
    } catch {
      // absent: keep walking up
    }
    const up = dirname(probe);
    if (up === probe) return null; // filesystem root, no .git anywhere at or above
  }
}

/** ADR-0010 decision 1 bounded by ADR-0021 decision 1: the nearest ancestor
 * of dir that already runs our hooks FOR dir - which requires the same git
 * working tree. Outside any working tree no ancestor covers dir (Claude
 * would not apply it either), so nothing is "already running" and the
 * installer must write hooks into dir. Inside a tree, ancestors at or below
 * the working-tree root are checked parent first; an ancestor above the root
 * is ignored. Returns the ancestor folder and the file that names our bins,
 * or null. */
export function findAncestorWithOurHooksFile(dir: string): { dir: string; file: string } | null {
  const root = findWorkingTreeRoot(dir);
  if (root === null) return null;
  // F-A (R25): when the seat IS the working-tree root there is no ancestor
  // at or below it (ADR-0021 decision 1: the ancestor must sit AT OR BELOW
  // the root). Without this the walk started at dirname(dir) - already above
  // the root - tested it and climbed to /, which inverted the plain-folder fix:
  // the root seat of every pilot hit exactly this.
  if (dir === root) return null;
  let cur = dirname(dir);
  for (;;) {
    for (const f of settingsFiles(cur)) {
      if (settingsRunOurHooks(f)) return { dir: cur, file: f };
    }
    if (cur === root) return null; // the working-tree root is the highest ancestor that counts
    const parent = dirname(cur);
    if (parent === cur) return null; // reached the filesystem root
    cur = parent;
  }
}

/** The installer's shape of the answer: the ancestor folder, or null. */
export function findAncestorWithOurHooks(dir: string): string | null {
  return findAncestorWithOurHooksFile(dir)?.dir ?? null;
}

export interface HookCoverage {
  present: boolean;
  /** the settings/hooks file that runs our hooks, when found. */
  where: string | null;
  /** set when the coverage came from an ANCESTOR layer (F-B): the folder of
   * that layer, so status can say "hooks come from <ancestor>". */
  from?: string;
}

/** Do our hooks run for the folder `cwd`, for this harness (ADR-0021
 * decision 2)?
 * - Claude (default): our bins appear in <cwd>/.claude/settings.local.json,
 *   <cwd>/.claude/settings.json, the user's <home>/.claude/settings.json, or
 *   an ancestor that the working-tree rule says applies.
 * - Codex: hooks.json sits beside the folder holding the seat's --settings
 *   file (pods/.codex/hooks.json for pods/.codex/openrig-honcho/settings.json)
 *   and names our bins; failing that, an ancestor layer of the same Codex
 *   project may run our hooks (the installer's legitimate hook-skipped shape
 *   - F-B): the SAME scan the installer uses decides, so status and the
 *   installer cannot disagree. `settingsPath` must already be absolute.
 *   `codexHome` is the Codex home holding config.toml (for the root markers);
 *   defaults to <home>/.codex. */
export function findHookCoverage(o: {
  cwd: string;
  home: string;
  harness: "claude" | "codex";
  settingsPath?: string | null;
  codexHome?: string;
  /** item 5 (R25 amendment): the CALLER's CLAUDE_PLUGIN_ROOT env value, or
   * null. Probed 25 Nov (throwaway --plugin-dir session): Claude Code sets
   * CLAUDE_PLUGIN_ROOT in the MCP server env, so the server and the status
   * bin can both pass it. When set, <root>/hooks/hooks.json is a coverage
   * source: plugin-mode seats get their hooks from the plugin, not settings. */
  pluginRoot?: string | null;
}): HookCoverage {
  if (o.harness === "codex") {
    if (!o.settingsPath) return { present: false, where: null };
    const seatFolder = dirname(dirname(o.settingsPath));
    const hooksJson = join(seatFolder, "hooks.json");
    try {
      if (namesOurBin(JSON.parse(readFileSync(hooksJson, "utf8"))))
        return { present: true, where: hooksJson };
    } catch {
      // absent, unreadable or invalid
    }
    // F-B (R25, probe C S2): the installer writes NO hooks.json here when a
    // FULL ancestor in the same Codex project already runs our hooks
    // (hook-skipped, record hooksSkipped). Accept exactly that coverage -
    // never the record's hooksSkipped field alone: the ancestor's own
    // hooks.json bytes must still pass the scan here.
    const markers = projectRootMarkers(readCodexUserConfig(o.codexHome ?? join(o.home, ".codex"))).markers;
    const scan = findAncestorWithOurCodexHooks(seatFolder, markers);
    if (scan.skip !== null) {
      const ancFile = join(scan.skip, ".codex", "hooks.json");
      try {
        if (namesOurBin(JSON.parse(readFileSync(ancFile, "utf8"))))
          return { present: true, where: ancFile, from: scan.skip };
      } catch {
        // removed after install: the scan passed on bytes that are gone;
        // no ancestor runs our hooks any more - not covered (S2 variant)
      }
    }
    return { present: false, where: null };
  }
  for (const f of [...settingsFiles(o.cwd), join(o.home, ".claude", "settings.json")]) {
    if (settingsRunOurHooks(f)) return { present: true, where: f };
  }
  const anc = findAncestorWithOurHooksFile(o.cwd);
  if (anc !== null) return { present: true, where: anc.file };
  // item 5 (R25 amendment): plugin mode. With --plugin-dir / enabledPlugins
  // the hooks come from the plugin's own hooks/hooks.json; settings name no
  // bins at all, so without this a covered seat reads hooks: missing (probe
  // A T12; the T21 runs load the plugin this way). ${CLAUDE_PLUGIN_ROOT} is
  // a literal in the file - expand it exactly as Claude Code does before
  // the identity test, so the matcher sees the command the runner runs.
  // N-G24: this file is the RUNNING plugin's own, so only the bin-name test
  // applies here (a renamed plugin copy still runs); see namesOurPluginBin.
  if (o.pluginRoot) {
    const ph = join(o.pluginRoot, "hooks", "hooks.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(ph, "utf8").replaceAll("${CLAUDE_PLUGIN_ROOT}", o.pluginRoot));
      if (isJsonObject(parsed) && namesOurPluginBin(parsed)) return { present: true, where: ph, from: o.pluginRoot };
    } catch {
      // absent, unreadable or invalid: plugin mode does not hold
    }
  }
  return { present: false, where: null };
}

// ---------- the Codex project-layer scan: moved VERBATIM from ----------
// plugin/bin/install-project.ts (F-B, R25). The installer decides the
// hook-skip with it and status now re-derives the same answer with it, so
// the two cannot disagree (probe C S2). Still READ-ONLY and subprocess-free
// (ADR-0006 X5): it only opens files that exist.

const PLUGIN_DIR = realpathSync(join(import.meta.dir, "..")); // = plugin root, as the installer computes it
export const CODEX_RECORD_DIR_REL = join(".codex", "openrig-honcho");
export const CODEX_SETTINGS_REL = join(CODEX_RECORD_DIR_REL, "settings.json");
// one-liners the installer keeps its own copies of; identity, not policy
const asArray = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The Codex user config.toml text, or undefined when absent/unreadable. */
function readCodexUserConfig(codexHome: string): string | undefined {
  try {
    return readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * F15 (C5g, review F15) / F16 (C5h, review F16): the root markers Codex
 * uses are configurable - project_root_markers in the config (codex
 * config/src/project_root_markers.rs, default [".git"]), and an EMPTY list
 * DISABLES root detection. So absent (=> [".git"]) and empty (=> no marker
 * ever matches, nothing above the seat loads) mean different things and
 * stay distinct here. F16: Codex reads real TOML - multi-line arrays,
 * trailing commas and single-quoted strings all count - so the reader is
 * Bun.TOML (built in, READ-ONLY: the file is never written back through
 * it), not a hand-rolled single-line guesser; a warning that Codex refuses
 * the config must be TRUE, not a parser limitation. Absent: [.git]. An
 * array of strings, the empty array included: used as given. Anything else
 * (a scalar, an array with a non-string) and a file that does not parse at
 * all come back as problem + the .git default, and the caller says so in
 * the install output - in both cases Codex really does refuse the config.
 * User layer only (ADR-0016): Codex discovers roots from the layers merged
 * BEFORE project discovery - managed and CLI layers are out of scope.
 */
export function projectRootMarkers(userCfgText: string | undefined): { markers: string[]; problem: string | null } {
  if (userCfgText === undefined) return { markers: [".git"], problem: null };
  let doc: Record<string, unknown>;
  try {
    doc = Bun.TOML.parse(userCfgText) as Record<string, unknown>;
  } catch (e) {
    const msg = String((e as Error).message ?? e).split("\n")[0] ?? "";
    return { markers: [".git"], problem: `does not parse as TOML (${msg})` };
  }
  if (doc.project_root_markers === undefined) return { markers: [".git"], problem: null }; // ABSENT
  const v = doc.project_root_markers;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return { markers: v as string[], problem: null }; // strings only; [] = detection OFF
  }
  return { markers: [".git"], problem: "project_root_markers is not an array of strings" };
}

/** The hook groups a Codex seat runs: the Claude install's groups, same
 * order and timeouts, with the two Codex flags appended (decision 9).
 * C5l2: the plugin folder is a parameter (defaulting to OURS) so the
 * ancestor-skip check can rebuild the exact bytes a DIFFERENT copy of this
 * plugin left in an ancestor - nothing else passes it. */
export function codexHookGroups(settingsAbs: string, pluginDir: string = PLUGIN_DIR): Json {
  const tail = `--harness codex --settings "${settingsAbs}"`;
  const bin = (n: string): string => join(pluginDir, "bin", n);
  return {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact|fork",
        hooks: [{ type: "command", command: `bun run "${bin("session-start.ts")}" ${tail}`, timeout: 8 }],
      },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: `bun run "${bin("recall.ts")}" ${tail}`, timeout: 5 }] },
      {
        hooks: [{ type: "command", command: `bun run "${bin("user-prompt.ts")}" ${tail}`, timeout: 30, async: true }],
      },
    ],
    // Stop is SYNC on Codex (unlike the Claude file): codex-rs
    // hooks/src/engine/command_runner.rs:190-196 aborts all async hook tasks
    // at shutdown, and codex exec reaches shutdown right after dispatching
    // the async Stop - the write never lands (live proof run 1, 04:21Z). A
    // sync handler is awaited by the dispatcher, so the last memory write of
    // a session cannot be outrun by the process exiting.
    Stop: [
      { hooks: [{ type: "command", command: `bun run "${bin("stop.ts")}" ${tail}`, timeout: 30 }] },
    ],
  };
}

/**
 * C5d (the ADR-0010 decision-1 shape on the Codex side): does an ANCESTOR of
 * this folder already run our hooks? Codex layers project folders by walking
 * from the seat up to the root, reading each .codex/ folder it finds
 * (config/src/loader/mod.rs, the comment near line 134), so a second hooks
 * file below an ancestor that runs our hooks would fire every hook twice.
 * Detection is by content, like the Claude scan - but since C5l (S1) by
 * EXACT content: a group deep-equal to one the installer writes for the
 * ANCESTOR's own settings path (rebuilt with codexHookGroups) - and since
 * C5l2 (finding 3) rebuilt with the PLUGIN FOLDER THE ANCESTOR'S OWN
 * COMMAND NAMES, so an ancestor installed from a different copy of this
 * plugin (another checkout, a packaged copy) still skips instead of
 * double-firing: the skip only WITHHOLDS our own hooks, it grants nothing.
 * Naming our bin or our path in any other shape is not proof that Codex
 * fires OUR hooks there, and skipping on such "proof" would leave the seat
 * running nobody's hooks. READ-ONLY: unreadable or invalid ancestor files
 * are ignored for this check.
 *
 * C5l3 (fix 3): ANY one matching group used to skip. That is unsafe in the
 * other direction: an ancestor whose file was trimmed to one event turns
 * the OTHER events off for every seat below it if we skip, while our own
 * install would make the event it DOES hold fire twice. So: skip only on
 * a FULL ancestor (every one of our groups, in every event); an ancestor
 * holding SOME but not all is a REFUSAL with zero writes (the caller
 * names it and its events); holding none of ours is normal install.
 *
 * F12 (C5f, review F12): Codex loads ancestor project layers only UP TO the
 * project root marker (markers: the configured project_root_markers, default
 * [".git"]: codex config/src/loader/mod.rs:1468 and 1835-1880 with
 * project_root_markers.rs:5). An ancestor above that marker, or with no
 * marker anywhere, is NEVER loaded for this seat - skipping on it would
 * leave the seat running zero hooks. So the first ancestor with our hooks
 * counts only when the upward walk reaches a root marker at or above it; a
 * marker below it stops the search, and no marker to the filesystem root
 * finds nothing (an EMPTY markers list disables root detection that way,
 * matching Codex - F15). Returns that ancestor dir, parent first, or null.
 */
/** C5l2 (finding 3): the plugin folders an ancestor's OWN commands name,
 * in our exact run-shape - bun run "<folder>/bin/<our bin>.ts" … - where
 * the folder sits inside a folder named openrig-honcho, the one shape a
 * copy of our plugin tree runs from. C5l3 (F21): the named bin file must
 * EXIST - a copy deleted after install is a ghost that runs nobody's
 * hooks, and skipping on it would leave the seat running zero hooks (the
 * exact harm the skip is meant to prevent, inverted). De-duplicated; []
 * when nothing matches, so a near-miss command (unquoted, no --settings,
 * foreign shape) yields no candidate and the match falls back to OUR copy
 * - which it fails. */
const ANCESTOR_PLUGIN_DIR_RE = /"([^"]+)[/\\]bin[/\\](session-start|recall|user-prompt|stop)\.ts"/g;
function ancestorCodexPluginDirs(hooks: Json): string[] {
  const dirs = new Set<string>();
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isJsonObject(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks as unknown[]) {
        if (!isJsonObject(h)) continue;
        const cmd: unknown = h.command;
        if (typeof cmd !== "string") continue;
        for (const m of cmd.matchAll(ANCESTOR_PLUGIN_DIR_RE)) {
          const folder = m[1] as string;
          if (folder === "" || !OPENRIG_HONCHO_SEGMENT_RE.test(`${folder}/`)) continue;
          if (existsSync(join(folder, "bin", `${m[2] as string}.ts`))) dirs.add(folder);
        }
      }
    }
  }
  return [...dirs];
}

/** The C5l3 shape the ancestor scan returns: the nearest FULL ancestor to
 * skip on, and the nearest PARTIAL one (some groups held, not all) that
 * must instead refuse the install. A full ancestor anywhere wins: we then
 * write no hooks at all and add no double-fire, whatever sits above. */
export type AncestorScan = {
  skip: string | null;
  partial: { dir: string; held: string[]; missing: string[] } | null;
};

/** Classify one ancestor file against our groups rebuilt per candidate
 * plugin folder: FULL when every group of ours appears under its own
 * event (for some candidate), PARTIAL when some but not all appear (the
 * candidate with the most matches names the events), NONE otherwise. */
function classifyAncestor(hooksObj: Json, settings: string): { full: boolean; held: string[]; missing: string[] } {
  const cands = ancestorCodexPluginDirs(hooksObj);
  let best: { held: string[]; missing: string[] } | null = null;
  let bestMatched = 0;
  for (const pd of cands.length > 0 ? cands : [PLUGIN_DIR]) {
    const ourGroups = codexHookGroups(settings, pd);
    const held: string[] = [];
    const missing: string[] = [];
    let matched = 0;
    let required = 0;
    for (const [event, ours] of Object.entries(ourGroups)) {
      const want = asArray(ours) ?? [];
      required += want.length;
      const theirs = asArray(hooksObj[event]) ?? [];
      const n = theirs.filter((g) => want.some((wg) => deepEqual(wg, g))).length;
      if (n > 0) held.push(event);
      if (n < want.length) missing.push(event);
      matched += Math.min(n, want.length);
    }
    if (required > 0 && matched === required) return { full: true, held: [], missing: [] };
    if (matched > bestMatched) {
      bestMatched = matched;
      best = { held, missing };
    }
  }
  return { full: false, held: best?.held ?? [], missing: best?.missing ?? [] };
}

export function findAncestorWithOurCodexHooks(dir: string, markers: string[]): AncestorScan {
  const hasMarker = (p: string): boolean => markers.some((m) => existsSync(join(p, m)));
  if (hasMarker(dir)) return { skip: null, partial: null }; // the seat IS the project root: no ancestor loads
  let skip: string | null = null;
  let partial: AncestorScan["partial"] = null;
  let cur = dirname(dir);
  for (;;) {
    if (skip === null) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(cur, ".codex", "hooks.json"), "utf8"));
        if (isJsonObject(parsed) && isJsonObject(parsed.hooks)) {
          // S1 (C5l): rebuilt from the ANCESTOR's own settings path - the
          // exact bytes our installer would have left there - and compared
          // with deepEqual, never by substring. C5l2: the rebuild runs
          // once per LIVE plugin folder the ancestor's commands name (its
          // own copy included), so a different copy of this plugin still
          // matches; with no candidate the only one is OURS, and a
          // near-miss or a ghost copy matches nothing and does not skip.
          const verdict = classifyAncestor(parsed.hooks as Json, join(cur, CODEX_SETTINGS_REL));
          if (verdict.full) skip = cur;
          else if (verdict.held.length > 0 && partial === null) {
            partial = { dir: cur, held: verdict.held, missing: verdict.missing };
          }
        }
      } catch {
        // absent, unreadable or invalid: ignored for this check
      }
    }
    if (hasMarker(cur)) return { skip, partial }; // the root layer loads; above it nothing does
    const parent = dirname(cur);
    if (parent === cur) return { skip: null, partial: null }; // no marker to the fs root: no ancestor layer loads
    cur = parent;
  }
}
