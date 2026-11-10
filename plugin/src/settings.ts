// C5a (ADR-0016 decision 9): how a Codex seat gets its settings. The Codex
// install writes the seat's HONCHO_* values to one file it owns (mode 600)
// and passes its ABSOLUTE path to every hook and to the rig_memory server as
// `--settings <path>`, next to `--harness codex`. The values merge UNDER the
// process environment (a real variable always wins); loadConfig stays pure
// and unchanged - this module only produces the merged record it reads.
//
// Failure rule (row: "the plugin stays off for that run exactly as it does
// today with a bad setting"): any problem with the file - missing,
// unreadable, not JSON, group/world readable, not a regular file (F7), a
// relative or absent path, the --settings= form - is reported as one name-only token for _config.log and
// the hook exits 0 with the plugin off. A token names the problem; it never
// carries a path, a key or a value.
import { readFileSync, statSync } from "node:fs";

export interface SettingsOutcome {
  /** The HONCHO_* string values the file holds ({} when no --settings flag). */
  vars: Record<string, string>;
  /** null when the file was fine; otherwise the problem token. */
  problem: string | null;
}

/** The path a --settings flag names, or null when the flag is absent. The
 * space-separated form is the only one accepted (same strictness as the
 * harness flag); `--settings=...` yields "" so the caller reports it. */
function settingsPath(argv: readonly string[]): string | null {
  const i = argv.findIndex((a) => a === "--settings" || a.startsWith("--settings="));
  if (i < 0) return null;
  if (argv[i] !== "--settings") return ""; // the = form: wrong shape, never read
  const value = argv[i + 1];
  return typeof value === "string" && value !== "" ? value : "";
}

/**
 * Read the --settings file for a Codex run. Call it only when the resolved
 * harness is codex - the Claude path never passes --settings, and under
 * claude the flag is ignored (decision 9). Returns the values to merge under
 * process.env, or a problem token naming why the plugin must stay off.
 */
export function readSettingsFile(argv: readonly string[]): SettingsOutcome {
  const path = settingsPath(argv);
  if (path === null) return { vars: {}, problem: null }; // no flag: today's path
  if (path === "") return { vars: {}, problem: "settings-bad-flag" };
  if (!path.startsWith("/")) return { vars: {}, problem: "settings-relative-path" };
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (err) {
    return {
      vars: {},
      problem: (err as { code?: string }).code === "ENOENT" ? "settings-missing" : "settings-unreadable",
    };
  }
  // Group/world readable means another user can read the seat's settings
  // (an API key lives in there): refuse the file, never a silent read.
  if ((st.mode & 0o044) !== 0) return { vars: {}, problem: "settings-world-readable" };
  // C5a2 (review F7): read ONLY a regular file. statSync passes a FIFO or a
  // device and readFileSync then blocks forever - a hung hook waits on the
  // turn - so name it instead of ever opening it. isFile is the real gate;
  // /dev/zero-style devices only tripped the mode check by their 0666.
  if (!st.isFile()) return { vars: {}, problem: "settings-not-a-file" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { vars: {}, problem: "settings-unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { vars: {}, problem: "settings-not-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { vars: {}, problem: "settings-not-json" };
  }
  // Keep ONLY HONCHO_* names with string values. Anything else in the file is
  // not settings and is dropped silently (the file is our installer's own;
  // a stray key must not disable the plugin, and must not become an env var).
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (k.startsWith("HONCHO_") && typeof v === "string") vars[k] = v;
  }
  return { vars, problem: null };
}

/**
 * C5a2 (review O2): --settings only takes effect once the harness resolves
 * to codex, so a misspelled --harness beside --settings silently drops the
 * file - and a bare Codex seat (no HONCHO_* in the environment) then blames
 * the missing URL. When the --harness token was present but unresolved AND
 * --settings is present, name the real cause instead. A run with no
 * --harness token at all (the Claude path) is unchanged. Token only - the
 * misspelling itself is never logged.
 */
export function harnessUnknownWithSettings(
  argv: readonly string[],
  flagUnknown: boolean,
): string | null {
  if (!flagUnknown) return null;
  return argv.some((a) => a === "--settings" || a.startsWith("--settings="))
    ? "harness-unknown-with-settings"
    : null;
}
