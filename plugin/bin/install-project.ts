// T12b (ADR-0008 Decision 1, amended 18:35Z): install the memory hooks into a
// PROJECT DIRECTORY so existing seats pick them up on resume, keeping their
// conversations. Merges into <dir>/.claude/settings.local.json and
// <dir>/.mcp.json, copies skills/rig-memory/, and reverses exactly its own
// changes with --uninstall.
//
// Binding rules from the operator amendment:
// - merge only: foreign keys, hook groups, servers and key ORDER are never
//   replaced, reordered or deleted; our hook groups append after existing
//   ones; our env keys are exactly the five flag names;
// - never read out, print, log or copy any env VALUE from the target - output
//   names keys and hook events only; error text never carries file content
//   (a JSON parse error message can quote it, so raw parse errors are dropped);
// - "rig_memory" in disabledMcpjsonServers -> refuse (exit 1, zero writes);
// - backups <file>.bak-openrig-honcho-<UTC stamp> at mode 0600; atomic write
//   (temp in the same dir, fsync, rename); settings.local.json ends 0600,
//   .mcp.json keeps its existing mode;
// - idempotent: a second run changes nothing and writes no backup;
// - uninstall reverts ONLY an install from THIS plugin path: a hook group or
//   mcpServers.rig_memory naming PLUGIN_DIR is the proof; without it
//   uninstall changes nothing at all (F2). With it, it removes exactly the
//   five flag-name env keys (any other HONCHO_* key is foreign), our hook
//   groups, the server, our enabledMcpjsonServers entry and the skill folder.
//   It NEVER deletes a container key (hooks, hooks.<event>, env,
//   enabledMcpjsonServers, mcpServers): our entries come out, empty
//   containers stay (architect ruling 19:18Z);
// - an existing key of the wrong type (hooks not an object, hooks.<event>
//   not an array, env not an object, enabledMcpjsonServers or
//   disabledMcpjsonServers not an array, mcpServers not an object) is
//   refused, never replaced (F1) - on uninstall exactly as on install;
// - a target (settings.local.json, .mcp.json, the skills folder) that is a
//   symlink is refused, never followed or replaced (F4);
// - before ANY write every planned write is checked for writability (F3);
//   writes are then staged - all temp files, then backups, then renames,
//   then the skill copy - so a late failure reports
//   "partial: <files>; backups: <names>" and exits 1;
// - never any API key: there is no key flag and HONCHO_API_KEY is never
//   written or printed.
//
// T13b (ADR-0008 "Amendment 2026-10-30 (v0.1.2)", binding): one folder of
// ours, <dir>/.claude/openrig-honcho/, holds install.json (0600), backups/
// (each <file name>.<UTC stamp>, 0600) and a .gitignore containing "*", so
// nothing is ever written to the project root again.
// - the record is names only, never values:
//   {"version":1,"plugin":"<PLUGIN_DIR>","envAdded":[names],"enabledAdded":bool};
//   a re-run unions envAdded and keeps enabledAdded true once true; an
//   idempotent re-run still writes nothing;
// - a flag-name key already present: in the record (or a v0.1.1 install
//   proven from this path - rule 5 BEFORE rule 3), it is ours and a re-run
//   may change it; otherwise the same value is left alone and NOT recorded,
//   and a different value refuses with zero writes naming the key only;
// - uninstall removes only recorded env names, and the enabled entry only if
//   enabledAdded; plus our hooks/server/skills as before; then removes
//   install.json (backups/ and .gitignore stay). Output names what it
//   removed and which HONCHO_* names it left. No record but our hooks/server
//   present (a v0.1.1 install): present names count as added and the output
//   says so; a valid record naming this plugin path is itself proof, even
//   with hooks and server hand-removed;
// - a record that is unreadable, the wrong shape, names another plugin path,
//   or is a symlink (as is the folder itself): refuse, zero writes, in BOTH
//   directions;
// - staged apply renames install.json BEFORE settings.local.json (a crash in
//   between leaves a record of names not yet written - harmless on uninstall -
//   never settings without a record);
// - T14c (plan-v0.2), closed by T14e: the apply of install AND uninstall is
//   serialised by an exclusive lock .claude/openrig-honcho/install.lock
//   (0600, holding only {"pid","at"}), taken after every refusal and before
//   the first write. A live-pid lock refuses with nothing written. A lock
//   released while we check it is taken by ONE exclusive create - never by
//   removing first (a third racer's fresh lock must not be deleted). A dead
//   or garbage lock is announced stale and moved aside with an atomic rename
//   to install.lock.stale-<pid>; the moved bytes must still be what we judged
//   (else it is a fresher lock: rename it back and refuse); two losers can
//   then never both win the same stale lock. --dry-run takes no lock. The
//   lock is released in the apply's finally and on process exit, so a run of
//   ours leaves no lock behind; the folder's .gitignore (already *) covers it
//   and the record never lists it. HONCHO_INSTALL_SEAM_MS (1..10000, test
//   seam only) pauses the taker inside the two takeover windows.

import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/env.ts";

/** Synchronous short wait (bun has no sleepSync export on this host's
 * version; Atomics.wait on a fresh SAB is the import-free primitive). */
const nap = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const PLUGIN_DIR = realpathSync(join(import.meta.dir, ".."));
const SERVER_NAME = "rig_memory";
const SETTINGS_REL = join(".claude", "settings.local.json");
const MCP_REL = ".mcp.json";
const SKILLS_REL = join(".claude", "skills", "rig-memory");
// T13b: the one folder of ours - record, backups and .gitignore; the project
// root gets nothing any more (ADR-0008 amendment 2026-10-30, rule 1).
const RECORD_DIR_REL = join(".claude", "openrig-honcho");
const INSTALL_JSON_REL = join(RECORD_DIR_REL, "install.json");
const BACKUPS_REL = join(RECORD_DIR_REL, "backups");
const FLAG_ENV: Record<string, string> = {
  "--url": "HONCHO_URL",
  "--workspace": "HONCHO_WORKSPACE",
  "--leader": "HONCHO_LEADER_PEER",
  "--profile-workspace": "HONCHO_PROFILE_WORKSPACE",
  "--owner-peer": "HONCHO_OWNER_PEER",
};
const OUR_ENV_NAMES = Object.values(FLAG_ENV); // uninstall removes exactly these
const USAGE =
  "usage: bun run <plugin>/bin/install-project.ts <project dir> --url U --workspace W [--leader P] [--profile-workspace W] [--owner-peer P] [--dry-run] | ... <project dir> --uninstall [--dry-run]";

function die(msg: string): never {
  console.error(`install-project: ${msg}`);
  process.exit(1);
}

type Json = Record<string, unknown>;

const isJsonObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asArray = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

/** F4: a symlinked target is refused, never followed or replaced. A path is
 * not an env value; naming it in the message is allowed and wanted. */
function refuseSymlink(path: string, label: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ENOENT") die(`${label}: cannot inspect (${code ?? "error"}) - refusing, nothing written`);
    return; // absent: fine
  }
  if (st.isSymbolicLink()) {
    die(`${label}: ${path} is a symlink - refusing to follow or replace it, nothing written`);
  }
}

/** F1: an existing key of the wrong type is refused, never replaced - the
 * same checks on install and uninstall. Messages name the file and the key
 * only, never a value. */
function checkContainers(cur: { settings?: Json; mcp?: Json }): void {
  const s = cur.settings;
  if (s !== undefined) {
    if (s.hooks !== undefined && !isJsonObject(s.hooks)) {
      die(`${SETTINGS_REL}: hooks is not an object - refusing, nothing written`);
    }
    if (isJsonObject(s.hooks)) {
      for (const [event, groups] of Object.entries(s.hooks)) {
        if (!Array.isArray(groups)) {
          die(`${SETTINGS_REL}: hooks.${event} is not an array - refusing, nothing written`);
        }
      }
    }
    if (s.env !== undefined && !isJsonObject(s.env)) {
      die(`${SETTINGS_REL}: env is not an object - refusing, nothing written`);
    }
    if (s.enabledMcpjsonServers !== undefined && !Array.isArray(s.enabledMcpjsonServers)) {
      die(`${SETTINGS_REL}: enabledMcpjsonServers is not an array - refusing, nothing written`);
    }
    if (s.disabledMcpjsonServers !== undefined && !Array.isArray(s.disabledMcpjsonServers)) {
      die(`${SETTINGS_REL}: disabledMcpjsonServers is not an array - refusing, nothing written`);
    }
  }
  const m = cur.mcp;
  if (m !== undefined && m.mcpServers !== undefined && !isJsonObject(m.mcpServers)) {
    die(`${MCP_REL}: mcpServers is not an object - refusing, nothing written`);
  }
}

/** F2: "installed from this plugin path" = a hook group or
 * mcpServers.rig_memory whose content names PLUGIN_DIR. Env keys and the
 * enabled entry are NAMES an owner or a foreign install could have written,
 * so they are proof of nothing on their own. */
function installedFromOurPath(cur: { settings?: Json; mcp?: Json }): boolean {
  if (cur.settings !== undefined && isJsonObject(cur.settings.hooks)) {
    for (const groups of Object.values(cur.settings.hooks as Json)) {
      if (namesPlugin(groups)) return true;
    }
  }
  if (cur.mcp !== undefined && isJsonObject(cur.mcp.mcpServers)) {
    if (namesPlugin((cur.mcp.mcpServers as Json)[SERVER_NAME])) return true;
  }
  return false;
}

/** T15b (ADR-0010 decision 1): "ours in an ancestor" = a hook command naming
 * one of our four bins inside a folder named openrig-honcho. The ancestor is
 * a different copy of the plugin (pilot's own), so PLUGIN_DIR cannot
 * decide it - the folder NAME and the bin names do. */
const OPENRIG_HONCHO_SEGMENT_RE = /(?:^|[/\\])openrig-honcho[/\\]/;
const OUR_BIN_SEGMENT_RE = /(?:^|[/\\])bin[/\\](?:session-start|recall|user-prompt|stop)\.ts/;

const namesOurBin = (v: unknown): boolean => {
  if (typeof v === "string")
    return OPENRIG_HONCHO_SEGMENT_RE.test(v) && OUR_BIN_SEGMENT_RE.test(v);
  if (Array.isArray(v)) return v.some(namesOurBin);
  if (isJsonObject(v)) return Object.values(v).some(namesOurBin);
  return false;
};

/** Every ancestor of dir, parent first up to the filesystem root: does its
 * .claude/settings.local.json or .claude/settings.json run our hooks for it?
 * READ-ONLY - the whole check never writes; an unreadable or invalid ancestor
 * file is ignored for this check. Returns the first such ancestor dir. */
function findAncestorWithOurHooks(dir: string): string | null {
  let cur = dirname(dir);
  for (;;) {
    for (const rel of [join(".claude", "settings.local.json"), join(".claude", "settings.json")]) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(cur, rel), "utf8"));
        if (isJsonObject(parsed) && isJsonObject(parsed.hooks)) {
          for (const groups of Object.values(parsed.hooks as Json)) {
            if (Array.isArray(groups) && groups.some((g) => namesOurBin(g))) return cur;
          }
        }
      } catch {
        // absent, unreadable or invalid: ignored for this check
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return null; // reached the root
    cur = parent;
  }
}

/** F3 preflight: the directory must exist and be writable+traversable, or be
 * reachable through writable ancestors (mkdir -p will create it later). */
function ensureDirWritable(dir: string, label: string): void {
  if (existsSync(dir)) {
    try {
      accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
    } catch {
      die(`${label}: directory ${dir} is not writable - refusing, nothing written`);
    }
    return;
  }
  ensureDirWritable(dirname(dir), label);
}

/** F3 preflight: an existing target file must be readable and writable. */
function ensureFileWritable(path: string, label: string): void {
  try {
    accessSync(path, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    die(`${label}: file ${path} is not readable+writable - refusing, nothing written`);
  }
}

/** T14c: does the pid exist? EPERM means it exists and is not ours to
 * signal - that still counts as running. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code !== "ESRCH"; // ESRCH: no such process; anything else: assume running
  }
}

/**
 * T14c (plan-v0.2, the D1 "partial" race), lock windows closed by T14e: one
 * install/uninstall apply per project at a time. The lock is
 * <recordDir>/install.lock, created exclusive ("wx") at 0600 and holding only
 * {"pid","at"} - never a value from the project. A live-pid lock refuses with
 * nothing written. A lock released while we look (ENOENT on the read) is
 * taken by ONE exclusive create, never by removing first (T14e(a): rm would
 * delete a third racer's lock created in that window). A dead-pid or garbage
 * lock is stale: announced, then moved aside by an ATOMIC rename to
 * install.lock.stale-<pid> (T14e(b): two losers can no longer both rm+create
 * the same stale lock); if the renamed bytes are not what we judged, the
 * file is a fresher lock - rename it back when the slot is free and refuse.
 * Each takeover then takes the lock by one exclusive create - if that create
 * loses the race, refuse like a live one (no second takeover attempt). The
 * caller releases in the apply's finally; a process "exit" hook is the belt,
 * because die() exits without running finally blocks (an F3 preflight
 * refusal is exactly that path). Returns the lock path. Never touches a
 * foreign live lock.
 *
 * TEST SEAM (T14e): HONCHO_INSTALL_SEAM_MS=1..10000 makes the taker pause
 * inside the two takeover windows (judging and taking over) after writing a
 * marker <recordDir>/install.seam<phase>.<pid>, so unit tests can open a
 * window deterministically instead of fishing for it with real racers.
 * Unset or invalid: no pause, no marker, production cost zero.
 */
function takeInstallLock(recordDir: string, what: string): string {
  const path = join(recordDir, "install.lock");
  const rawSeam = (process.env.HONCHO_INSTALL_SEAM_MS ?? "").trim();
  const seamMs = /^\d{1,5}$/.test(rawSeam) && Number(rawSeam) >= 1 && Number(rawSeam) <= 10_000 ? Number(rawSeam) : 0;
  const seam = (phase: number): void => {
    if (seamMs === 0) return;
    try {
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(join(recordDir, `install.seam${phase}.${process.pid}`), `${process.pid}\n`);
    } catch {
      // the marker is best effort; the pause is the point
    }
    nap(seamMs);
  };
  const create = (): boolean => {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "EEXIST") return false;
        if (code === "ENOENT" && tries === 0) {
          // our folder (rule 1) is not there yet - the only write a refusal
          // could ever leave behind is this empty folder, never a file
          try {
            mkdirSync(recordDir, { recursive: true });
          } catch (e2) {
            const c2 = (e2 as { code?: string }).code;
            die(`install.lock: our folder cannot be created (${c2 ?? "error"}) - refusing, nothing written`);
          }
          continue;
        }
        die(`install.lock: cannot be created (${code ?? "error"}) - refusing, nothing written`);
      }
    }
    return false; // unreachable: each path returns or dies
  };
  const held = (): string => {
    process.on("exit", () => {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    });
    return path;
  };
  if (create()) return held();
  for (let staleTries = 0; staleTries < 1; staleTries++) {
    seam(1); // test window before judging (unset: no-op)
    let pid: number | null = null;
    let why = "it is not readable JSON";
    let gone = false;
    let judged: string | null = null; // the bytes we judged stale, for the T14e(b) re-check
    // The holder fills the file right after the exclusive create; a read that
    // lands inside that fill window sees empty or half-written content and
    // must NOT call a fresh live lock garbage (found by the T14c race
    // battery - it let the loser steal the winner's lock). Re-read a few
    // times before judging; a writer dead mid-fill stays garbage after that.
    // ENOENT means the holder finished and released it while we looked - a
    // free lock, not a stale one (also seen by the battery).
    for (let reads = 0; reads < 3; reads++) {
      try {
        const raw = readFileSync(path, "utf8");
        judged = raw;
        const o = JSON.parse(raw) as { pid?: unknown };
        if (typeof o.pid === "number" && Number.isInteger(o.pid) && o.pid > 0) {
          pid = o.pid;
          why = "";
        } else {
          why = "no usable pid in it";
        }
        break; // valid JSON: not a fill window, judge it as it stands
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") {
          gone = true;
          break;
        }
        if (reads < 2) nap(50);
      }
    }
    if (!gone && pid !== null && pidAlive(pid)) {
      die(`install.lock: another install or uninstall is running in this project (pid ${pid}) - refusing, nothing written`);
    }
    seam(2); // test window before taking over (unset: no-op)
    if (gone) {
      console.log(`[${what}] install.lock was released as we checked it: taking it`);
      // T14e(a): no removal here. Between our ENOENT read and this moment a
      // third racer can have created a fresh lock; removing would delete it.
      // One exclusive create: ours if the slot is free, refuse otherwise.
      if (create()) return held();
    } else {
      console.log(
        `[${what}] install.lock is stale (${why || `pid ${pid} is not running`}): moving it aside and taking it`,
      );
      // T14e(b): the atomic rename replaces rm+create - two losers that both
      // judged the same file stale can now never both hold: only one rename
      // wins; the other sees ENOENT (or the winner's fresh lock) and takes
      // the slot by a single exclusive create, or refuses.
      const aside = `${path}.stale-${process.pid}`;
      let renamed = false;
      try {
        renameSync(path, aside);
        renamed = true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code !== "ENOENT") {
          die(`install.lock: the stale lock cannot be moved aside (${code ?? "error"}) - refusing, nothing written`);
        }
        // taken over first: one exclusive create, no second guess
        if (create()) return held();
      }
      if (renamed) {
        // the moved file must still carry the bytes we judged; anything else
        // is a fresher lock we just stole - put it back and refuse
        let moved: string | null = null;
        let unreadable = false;
        try {
          moved = readFileSync(aside, "utf8");
        } catch {
          unreadable = true;
        }
        if (unreadable || moved !== judged) {
          try {
            if (!existsSync(path)) renameSync(aside, path);
          } catch {
            // best-effort restore; we refuse either way
          }
          die("install.lock: another install or uninstall is running in this project - refusing, nothing written");
        }
        try {
          rmSync(aside, { force: true }); // only our judged-stale bytes
        } catch {
          // nothing dangerous can remain: the bytes were stale
        }
        if (create()) return held();
      }
    }
  }
  die("install.lock: another install or uninstall is running in this project - refusing, nothing written");
}

/** Parse a target that may not exist. NEVER echoes content: JSON parse error
 * messages can quote the file text, so they are swallowed by design. */
function readTarget(path: string, label: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(`${label}: cannot read (${(e as { code?: string }).code ?? "error"}) - refusing, nothing written`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    die(`${label}: exists but is not parseable JSON - refusing, nothing written`);
  }
  if (!isJsonObject(parsed)) {
    die(`${label}: exists but is not a JSON object - refusing, nothing written`);
  }
  return parsed;
}

/** The install record (ADR-0008 amendment 2026-10-30, rule 2): names only,
 * never values. */
interface InstallRecord {
  version: number;
  plugin: string;
  envAdded: string[];
  enabledAdded: boolean;
  /** T15b (ADR-0010 decision 1): set on installs that skipped hooks because
   * this ancestor folder already runs them; records its directory. Unset
   * records (and v0.2.0 files on disk) keep today's exact shape. */
  hooksSkipped?: string;
}

/** Rule 6: a record that is unreadable, the wrong shape or names another
 * plugin path refuses BOTH directions with zero writes. Callers have already
 * refused symlinked paths (F4). Messages name the file, never content. */
function loadInstallRecord(path: string): InstallRecord | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    die(`${INSTALL_JSON_REL}: exists but is not parseable JSON - refusing, nothing written`);
  }
  const bad = `${INSTALL_JSON_REL}: not a valid install record - refusing, nothing written`;
  if (!isJsonObject(parsed)) die(bad);
  // T15b: hooksSkipped is the only optional key; every other shape (missing,
  // extra, or other keys) still refuses. An absent hooksSkipped is a normal
  // v0.2.0 record.
  const keySet = Object.keys(parsed).sort().join(",");
  if (keySet !== "enabledAdded,envAdded,plugin,version" && keySet !== "enabledAdded,envAdded,hooksSkipped,plugin,version")
    die(bad);
  if (parsed.version !== 1) die(bad);
  if (typeof parsed.plugin !== "string") die(bad);
  if (typeof parsed.enabledAdded !== "boolean") die(bad);
  // ruling (b) 01:05Z: envAdded carries ONLY the five flag names, no duplicates
  const names = OUR_ENV_NAMES as readonly string[];
  if (
    !Array.isArray(parsed.envAdded) ||
    !parsed.envAdded.every((n: unknown) => typeof n === "string" && names.includes(n)) ||
    new Set(parsed.envAdded as unknown[]).size !== (parsed.envAdded as unknown[]).length
  ) {
    die(bad);
  }
  if (parsed.plugin !== PLUGIN_DIR) {
    die(`${INSTALL_JSON_REL}: names a different plugin path than this one - refusing, nothing written`);
  }
  let hooksSkipped: string | undefined;
  if (parsed.hooksSkipped !== undefined) {
    if (typeof parsed.hooksSkipped !== "string" || parsed.hooksSkipped === "") die(bad);
    hooksSkipped = parsed.hooksSkipped;
  }
  return {
    version: 1,
    plugin: parsed.plugin,
    envAdded: [...(parsed.envAdded as string[])],
    enabledAdded: parsed.enabledAdded,
    ...(hooksSkipped !== undefined ? { hooksSkipped } : {}),
  };
}

/** Keep the file's own indentation style (first indented line); default 2. */
function detectIndent(path: string): string | number {
  try {
    const text = readFileSync(path, "utf8");
    const m = /^([ \t]+)/m.exec(text.slice(text.indexOf("\n") + 1));
    if (m?.[1] !== undefined) return m[1].includes("\t") ? "\t" : m[1].length;
  } catch {
    /* new file */
  }
  return 2;
}

/** F3 staging: temp in the same dir, fsync, exact mode; the rename comes
 * later, after every temp file is on disk (atomicWrite split). */
function writeTemp(path: string, content: string, mode: number): string {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode); // openSync's mode is umask-filtered; force the exact mode
  return tmp;
}

/** Deep-replace ${CLAUDE_PLUGIN_ROOT} in every string of a JSON value. */
function subst(v: unknown): unknown {
  if (typeof v === "string") return v.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_DIR);
  if (Array.isArray(v)) return v.map(subst);
  if (isJsonObject(v)) {
    const out: Json = {};
    for (const [k, val] of Object.entries(v)) out[k] = subst(val);
    return out;
  }
  return v;
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Our hook group / server iff any string value contains the plugin path. */
function namesPlugin(v: unknown): boolean {
  if (typeof v === "string") return v.includes(PLUGIN_DIR);
  if (Array.isArray(v)) return v.some(namesPlugin);
  if (isJsonObject(v)) return Object.values(v).some(namesPlugin);
  return false;
}

function loadPluginFragments(): { hooks: Json; mcp: Json } {
  let hooksFile: unknown;
  let mcpFile: unknown;
  try {
    hooksFile = JSON.parse(readFileSync(join(PLUGIN_DIR, "hooks", "hooks.json"), "utf8"));
    mcpFile = JSON.parse(readFileSync(join(PLUGIN_DIR, "mcp-servers.json"), "utf8"));
  } catch (e) {
    die(`cannot read the plugin's own hooks/hooks.json or mcp-servers.json (${(e as { code?: string }).code ?? "error"})`);
  }
  if (!isJsonObject(hooksFile) || !isJsonObject(hooksFile.hooks) || !isJsonObject(mcpFile)) {
    die("the plugin's own hooks/hooks.json or mcp-servers.json is malformed");
  }
  return { hooks: subst(hooksFile.hooks) as Json, mcp: subst(mcpFile) as Json };
}

interface Args {
  dir: string;
  flags: Map<string, string>;
  dryRun: boolean;
  uninstall: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let dryRun = false;
  let uninstall = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--uninstall") uninstall = true;
    else if (a in FLAG_ENV) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) die(`${a} needs a value\n  ${USAGE}`);
      // every flag maps to a HONCHO_* name by construction, so a foreign
      // env key can never be written from here
      flags.set(FLAG_ENV[a] as string, v);
      i++;
    } else if (a.startsWith("--")) die(`unknown flag ${a}\n  ${USAGE}`);
    else positionals.push(a);
  }
  if (positionals.length !== 1) die(`expected exactly one project directory\n  ${USAGE}`);
  const dir = resolve(positionals[0] as string);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`project directory ${dir} does not exist`);
  if (uninstall && flags.size > 0) die(`--uninstall takes no value flags\n  ${USAGE}`);
  if (!uninstall && !(flags.has("HONCHO_URL") && flags.has("HONCHO_WORKSPACE"))) {
    die(`--url and --workspace are required (or use --uninstall)\n  ${USAGE}`);
  }
  return { dir, flags, dryRun, uninstall };
}

/** env.ts is the single validator: the flag values go through the exact same
 * loadConfig rules with dummy peer/state values. Disabled reasons name
 * variables only - safe to print. */
function validateFlags(flags: Map<string, string>): void {
  const res = loadConfig({
    HONCHO_URL: flags.get("HONCHO_URL"),
    HONCHO_WORKSPACE: flags.get("HONCHO_WORKSPACE"),
    HONCHO_LEADER_PEER: flags.get("HONCHO_LEADER_PEER"),
    HONCHO_PROFILE_WORKSPACE: flags.get("HONCHO_PROFILE_WORKSPACE"),
    HONCHO_OWNER_PEER: flags.get("HONCHO_OWNER_PEER"),
    HONCHO_PEER: "install-check",
    HONCHO_STATE_DIR: "/tmp/install-check",
  });
  if (!res.enabled) die(`refusing bad input: ${res.reason}`);
}

interface Plan {
  settings: Json | null; // null: file needs no change (not written, no backup)
  mcp: Json | null;
  skills: boolean;
  lines: string[]; // NAMES only - key names and hook events, never values
  nextRecord?: InstallRecord; // set when install.json must be (re)written
  removeRecord: boolean; // uninstall with a record: remove install.json last
}

function planInstall(
  cur: { settings?: Json; mcp?: Json },
  flags: Map<string, string>,
  fragments: { hooks: Json; mcp: Json },
  record: InstallRecord | null,
  v011: boolean, // no record, but an install proven from this plugin path
  ancestorHooksDir: string | null, // T15b: nearest ancestor already running our hooks
): Plan {
  const lines: string[] = [];
  if (v011) {
    // rule 5 says so (T13c): the same explanation uninstall gives
    lines.push("no install record: treating present names as added (v0.1.1 install)");
  }
  const settings = structuredClone(cur.settings ?? {}) as Json;

  // hooks: a re-run replaces OUR groups at the position they already hold
  // (T14b, pilot v0.1.2: ours had moved after the OpenRig activity
  // relay); only an event without our group appends ours after the foreign
  // ones. Foreign groups keep their relative order either way.
  // F1 has already refused any wrong-typed container, so every shape here
  // is object-or-absent / array-or-absent.
  let skipLineAt = -1;
  if (ancestorHooksDir !== null) {
    // T15b (ADR-0010 decision 1): the ancestor's settings apply to seats
    // opened in this folder, so adding ours here would run every hook twice.
    // Install everything except hooks; if an earlier install put ours here,
    // remove them in place (foreign groups keep their order). The ancestor
    // file itself is never written.
    skipLineAt = lines.length;
    lines.push(`hooks: skipped, ${ancestorHooksDir} already runs them for this folder`);
    if (isJsonObject(settings.hooks)) {
      const hooksHere = settings.hooks;
      for (const [event, groups] of Object.entries(hooksHere)) {
        const arr = asArray(groups);
        if (arr === undefined) continue;
        const kept = arr.filter((g) => !namesPlugin(g));
        if (kept.length !== arr.length) {
          hooksHere[event] = kept;
          lines.push(`settings: removed our hooks from ${event} (an ancestor runs them)`);
        }
      }
    }
  } else {
    const hooksTarget = (settings.hooks ?? {}) as Json;
    const hookEvents: string[] = [];
    const hookReplaced = new Set<string>();
    for (const [event, groups] of Object.entries(fragments.hooks)) {
      const existing = asArray(hooksTarget[event]) ?? [];
      const ours = structuredClone(groups) as unknown[];
      const firstOurs = existing.findIndex((g) => namesPlugin(g));
      let next: unknown[];
      if (firstOurs === -1) {
        next = [...existing, ...ours]; // no hook of ours for this event: append
      } else {
        // replace our block in place; a foreign group that sat BETWEEN two of
        // ours lands after the block - a shape our fragments never produce
        hookReplaced.add(event);
        next = [
          ...existing.slice(0, firstOurs),
          ...ours,
          ...existing.filter((g, i) => i > firstOurs && !namesPlugin(g)),
        ];
      }
      if (!deepEqual(existing, next)) {
        hooksTarget[event] = next;
        hookEvents.push(event);
      }
    }
    if (hookEvents.length > 0) {
      settings.hooks = hooksTarget;
      const noted = hookEvents.map((ev) =>
        hookReplaced.has(ev) ? `${ev} (replaced in place)` : `${ev} (appended after existing groups)`,
      );
      lines.push(`settings: our hooks for ${noted.join(", ")}`);
    }
  }

  // env: only the five flag names; foreign keys (anything not ours) are never
  // touched; replacing an existing key keeps its position in the object.
  // Rule 3/5 (T13b): a present key is only ours to change if the record lists
  // it or a v0.1.1 install from this path makes present names ours. A foreign
  // same-value key is left and NOT recorded; a foreign different value is a
  // zero-writes refusal naming the key only (never a value).
  const envNote: string[] = [];
  if (flags.size > 0) {
    const env = (settings.env ?? {}) as Json;
    for (const [key, value] of flags) {
      if (key in env) {
        const ours = v011 || (record?.envAdded ?? []).includes(key);
        if (!ours) {
          if (env[key] === value) continue; // owner's key, same value: leave it, do not record
          die(`${SETTINGS_REL}: env.${key} already exists and is not ours - refusing to overwrite a value we did not set, nothing written`);
        }
      }
      if (env[key] !== value) {
        env[key] = value;
        envNote.push(key);
      }
    }
    if (envNote.length > 0) {
      settings.env = env;
      lines.push(`settings: env keys ${envNote.join(", ")} (names only - no values echoed)`);
    }
  }

  // enabledMcpjsonServers: append ours if missing, keep every existing entry.
  // enabledAdded records ONLY an entry this install appended; a v0.1.1
  // install's present entry counts as ours (rule 5).
  let enabledAdded = record?.enabledAdded ?? false;
  const enabled = asArray(settings.enabledMcpjsonServers) ?? [];
  if (!enabled.includes(SERVER_NAME)) {
    settings.enabledMcpjsonServers = [...enabled, SERVER_NAME];
    enabledAdded = true;
    lines.push(`settings: enabledMcpjsonServers += ${SERVER_NAME}`);
  } else if (v011 && !enabledAdded) {
    enabledAdded = true;
  }

  const settingsChanged = !deepEqual(settings, cur.settings ?? {});

  // .mcp.json: mcpServers.<ours>; a foreign rig_memory is refused, not replaced
  const mcp = structuredClone(cur.mcp ?? {}) as Json;
  const servers = (mcp.mcpServers ?? {}) as Json;
  const wanted = fragments.mcp[SERVER_NAME];
  const existingServer = servers[SERVER_NAME];
  if (existingServer !== undefined && !namesPlugin(existingServer) && !deepEqual(existingServer, wanted)) {
    die(`${MCP_REL}: mcpServers.${SERVER_NAME} exists and is not ours - refusing to overwrite it, nothing written`);
  }
  let mcpChanged = false;
  if (!deepEqual(existingServer, wanted)) {
    servers[SERVER_NAME] = structuredClone(wanted);
    mcp.mcpServers = servers;
    mcpChanged = true;
    lines.push(`${MCP_REL}: mcpServers.${SERVER_NAME} ${existingServer === undefined ? "added" : "replaced"}`);
  }

  const skills = skillsDiffer(join(cur0, SKILLS_REL));
  if (skills) lines.push("skills: copy skills/rig-memory/ (the folder is ours)");

  // the record (rule 2): a re-run UNIONS envAdded and keeps enabledAdded
  // true once true; names never leave except by uninstall (ruling (e)).
  const envAdded = new Set(record?.envAdded ?? []);
  if (v011) {
    const envNow = (cur.settings?.env ?? {}) as Json;
    for (const n of OUR_ENV_NAMES) if (n in envNow) envAdded.add(n); // rule 5 basis
  }
  for (const n of envNote) envAdded.add(n);
  const nextRecord: InstallRecord = {
    version: 1,
    plugin: PLUGIN_DIR,
    envAdded: [...envAdded].sort(),
    enabledAdded,
    ...(ancestorHooksDir !== null ? { hooksSkipped: ancestorHooksDir } : {}),
  };
  const recordChanged = record === null || !deepEqual(nextRecord, record);
  if (recordChanged) {
    lines.push(
      `record: install.json (envAdded: ${nextRecord.envAdded.join(", ") || "none"}; enabledAdded: ${nextRecord.enabledAdded}` +
        `${ancestorHooksDir !== null ? `; hooksSkipped: ${ancestorHooksDir}` : ""})`,
    );
  }
  if (skipLineAt >= 0 && !settingsChanged && !mcpChanged && !skills && !recordChanged) {
    // a pure no-op re-run of a skipped install: the skip line alone would
    // hide the standard "nothing to change (already installed)" verdict
    lines.length = 0;
  }

  return {
    settings: settingsChanged ? settings : null,
    mcp: mcpChanged ? mcp : null,
    skills,
    lines,
    nextRecord: recordChanged ? nextRecord : undefined,
    removeRecord: false,
  };
}

// uninstall removes exactly OUR entries and never deletes a container key
// (hooks, hooks.<event>, env, enabledMcpjsonServers, mcpServers): a container
// that ends up empty stays empty on disk - 19:18Z ruling. The caller has
// already proven an install from this plugin path (F2) and refused any
// wrong-typed container (F1).
function planUninstall(cur: { settings?: Json; mcp?: Json }, record: InstallRecord | null): Plan {
  const lines: string[] = [];
  const settings = structuredClone(cur.settings ?? {}) as Json;
  if (record === null) {
    lines.push("no install record: treating present names as added (v0.1.1 install)"); // rule 5
  }

  // T15b: an install that skipped hooks added none here, so uninstall
  // removes none - and it never walks or writes ancestors either.
  if (record?.hooksSkipped === undefined && isJsonObject(settings.hooks)) {
    const hooks = settings.hooks as Json;
    for (const event of Object.keys(hooks)) {
      const arr = asArray(hooks[event]);
      if (arr === undefined) continue;
      const kept = arr.filter((g) => !namesPlugin(g));
      if (kept.length !== arr.length) {
        hooks[event] = kept; // an empty array stays (container rule)
        lines.push(`settings: removed our hooks from ${event}`);
      }
    }
  }

  // rule 4 (T13b): with a record, ONLY its envAdded names go; without one
  // (v0.1.1 install) all five present names count as added, as v0.1.1 did.
  // Any other HONCHO_* key is foreign in both modes.
  if (isJsonObject(settings.env)) {
    const env = settings.env as Json;
    const candidates = record !== null ? record.envAdded : OUR_ENV_NAMES;
    const removed = candidates.filter((k) => k in env);
    // rule 4 (architect 03:58Z): EVERY HONCHO_* key still present is named,
    // not just our five - a foreign HONCHO_* the owner has must be visible
    const left = Object.keys(env).filter((k) => k.startsWith("HONCHO_") && !removed.includes(k));
    for (const k of removed) delete env[k];
    if (removed.length > 0) lines.push(`settings: removed env keys ${removed.join(", ")}`);
    if (left.length > 0) lines.push(`settings: left env keys ${left.join(", ")} (not added by this install)`);
  }

  // the enabled entry goes only when the record says WE appended it (or,
  // without a record, as v0.1.1 did - rule 5)
  const enabled = asArray(settings.enabledMcpjsonServers);
  if (enabled !== undefined && enabled.includes(SERVER_NAME) && (record === null || record.enabledAdded)) {
    settings.enabledMcpjsonServers = enabled.filter((x) => x !== SERVER_NAME); // [] stays
    lines.push(`settings: enabledMcpjsonServers -= ${SERVER_NAME}`);
  } else if (enabled !== undefined && enabled.includes(SERVER_NAME)) {
    lines.push(`settings: left enabledMcpjsonServers entry ${SERVER_NAME} (not added by this install)`);
  }

  const mcp = structuredClone(cur.mcp ?? {}) as Json;
  if (isJsonObject(mcp.mcpServers)) {
    const servers = mcp.mcpServers as Json;
    if (servers[SERVER_NAME] !== undefined && namesPlugin(servers[SERVER_NAME])) {
      delete servers[SERVER_NAME]; // the empty mcpServers object stays
      lines.push(`${MCP_REL}: removed mcpServers.${SERVER_NAME}`);
    }
  }

  const skills = existsSync(join(cur0, SKILLS_REL));
  if (skills) lines.push(`skills: remove ${SKILLS_REL} (the folder is ours)`);

  // rule 4: the record goes last; backups/ and .gitignore stay. Even if
  // every other trace was removed by hand, a present record is removed.
  const removeRecord = record !== null;
  if (removeRecord) lines.push(`record: remove ${INSTALL_JSON_REL} (backups/ and .gitignore stay)`);

  return {
    settings: !deepEqual(settings, cur.settings ?? {}) ? settings : null,
    mcp: !deepEqual(mcp, cur.mcp ?? {}) ? mcp : null,
    skills,
    lines,
    removeRecord,
  };
}

// the project dir for skillsDiffer; set once at main entry, used read-only
let cur0 = "";

function walkFiles(dir: string, prefix: string, into: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) walkFiles(join(dir, e.name), rel, into);
    else if (e.isFile()) into.push(rel);
  }
}

function skillsDiffer(dst: string): boolean {
  const src = join(PLUGIN_DIR, "skills", "rig-memory");
  const srcFiles: string[] = [];
  const dstFiles: string[] = [];
  walkFiles(src, "", srcFiles);
  walkFiles(dst, "", dstFiles);
  if (srcFiles.sort().join("|") !== dstFiles.sort().join("|")) return true;
  return srcFiles.some((f) => {
    try {
      return !readFileSync(join(src, f)).equals(readFileSync(join(dst, f)));
    } catch {
      return true;
    }
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  cur0 = args.dir;
  const settingsPath = join(args.dir, SETTINGS_REL);
  const mcpPath = join(args.dir, MCP_REL);
  const skillsPath = join(args.dir, SKILLS_REL);
  const recordDir = join(args.dir, RECORD_DIR_REL);
  const recordPath = join(args.dir, INSTALL_JSON_REL);
  const backupsDir = join(args.dir, BACKUPS_REL);

  if (!args.uninstall) validateFlags(args.flags);

  // F4: a symlinked target is refused before it is ever read (install and
  // uninstall, dry-run included - the check is about the file, not the mode)
  refuseSymlink(settingsPath, SETTINGS_REL);
  refuseSymlink(mcpPath, MCP_REL);
  refuseSymlink(skillsPath, SKILLS_REL);
  // rule 6: the folder, the record and backups/ are refused as symlinks in
  // BOTH directions before the record is ever read
  refuseSymlink(recordDir, RECORD_DIR_REL);
  refuseSymlink(recordPath, INSTALL_JSON_REL);
  refuseSymlink(backupsDir, BACKUPS_REL);

  // CHECK EVERY TARGET BEFORE ANY WRITE (no mkdir, no copy before this point;
  // a refusal here writes nothing at all)
  const cur = { settings: readTarget(settingsPath, SETTINGS_REL), mcp: readTarget(mcpPath, MCP_REL) };
  // F1: an existing key of the wrong type is refused, never replaced
  checkContainers(cur);
  if (!args.uninstall) {
    const disabled = asArray(cur.settings?.disabledMcpjsonServers) ?? [];
    if (disabled.includes(SERVER_NAME)) {
      die(`${SERVER_NAME} is in disabledMcpjsonServers - it was disabled on purpose; refusing to override, nothing written`);
    }
  }

  const what = args.uninstall ? "uninstall" : "install";

  // T13b: the record is read for both directions (rule 6 refuses a broken
  // one, zero writes). A valid record naming this path is itself proof of
  // the install (ruling (d)), so uninstall proceeds even with the hooks and
  // server hand-removed; otherwise F2's hook/server proof stands.
  const record = loadInstallRecord(recordPath);
  const proof = installedFromOurPath(cur);
  if (args.uninstall && record === null && !proof) {
    console.log(`uninstall ${args.dir}: not installed from ${PLUGIN_DIR}; nothing to change`);
    return;
  }

  const fragments = args.uninstall ? { hooks: {}, mcp: {} } : loadPluginFragments();
  // T15b (ADR-0010 decision 1): read-only ancestor scan - install direction
  // only; uninstall never walks ancestors.
  const ancestorHooksDir = args.uninstall ? null : findAncestorWithOurHooks(args.dir);
  // ruling (a): rule 5 BEFORE rule 3 - no record plus an install proven
  // from this plugin path makes every present name ours.
  const plan = args.uninstall
    ? planUninstall(cur, record)
    : planInstall(cur, args.flags, fragments, record, record === null && proof, ancestorHooksDir);

  if (plan.lines.length === 0) {
    console.log(`${what} ${args.dir}: nothing to change (already ${args.uninstall ? "clean" : "installed"})`);
    return;
  }
  for (const l of plan.lines) console.log(`[${args.dryRun ? "dry-run" : what}] ${l}`);
  if (args.dryRun) {
    console.log("[dry-run] no files written, no backups taken");
    return; // dry-run takes no lock and writes nothing (review D6)
  }

  // T14c: serialise the apply - taken after every refusal (rule 6, symlinks,
  // containers, the plan) and before the first write. The apply's finally
  // releases it; the exit hook registered at take-off covers die() paths
  // (the F3 preflight refusal below exits without running finally blocks).
  const lockPath = takeInstallLock(recordDir, what);

  // F3 preflight: every write this run will make must be possible NOW, or we
  // refuse with nothing written.
  if (plan.settings !== null) {
    ensureDirWritable(join(args.dir, ".claude"), SETTINGS_REL);
    if (existsSync(settingsPath)) ensureFileWritable(settingsPath, SETTINGS_REL);
  }
  if (plan.mcp !== null) {
    ensureDirWritable(args.dir, MCP_REL);
    if (existsSync(mcpPath)) ensureFileWritable(mcpPath, MCP_REL);
  }
  if (plan.skills) {
    ensureDirWritable(join(args.dir, ".claude", "skills"), SKILLS_REL);
    if (existsSync(skillsPath)) ensureDirWritable(skillsPath, SKILLS_REL);
  }
  if (plan.nextRecord !== undefined || plan.removeRecord) {
    ensureDirWritable(recordDir, INSTALL_JSON_REL);
    if (existsSync(recordPath)) ensureFileWritable(recordPath, INSTALL_JSON_REL);
  }
  if (plan.settings !== null || plan.mcp !== null) ensureDirWritable(backupsDir, BACKUPS_REL);

  // staged apply (F3): all temp files first, then backups, then renames,
  // then the skill copy, then the record removal. A late failure names
  // exactly what happened. T13b: backups go under .claude/openrig-honcho/
  // backups/ as <file name>.<UTC stamp> (0600) - nothing lands in the
  // project root; install.json is renamed BEFORE settings.local.json
  // (ruling (c)): a crash in between leaves a record of names not yet
  // written (harmless: absent keys are skipped on uninstall), never
  // settings without a record.
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backups: string[] = [];
  const backup = (path: string): void => {
    if (!existsSync(path)) return; // new file: nothing to back up
    const copy = join(backupsDir, `${basename(path)}.${stamp}`);
    cpSync(path, copy);
    chmodSync(copy, 0o600);
    backups.push(basename(copy));
    console.log(`backup: ${basename(copy)} (mode 600)`);
  };

  const targets: { label: string; path: string; tmp: string }[] = [];
  const done: string[] = [];
  let recordTmp: string | null = null;
  try {
    // the one folder of ours (rule 1); .gitignore is written only when
    // absent, so an idempotent re-run still writes nothing
    if (plan.settings !== null || plan.mcp !== null || plan.nextRecord !== undefined || plan.removeRecord) {
      mkdirSync(recordDir, { recursive: true });
      mkdirSync(backupsDir, { recursive: true });
      const gitignore = join(recordDir, ".gitignore");
      if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
    }
    if (plan.settings !== null) {
      mkdirSync(join(args.dir, ".claude"), { recursive: true });
      const content = `${JSON.stringify(plan.settings, null, detectIndent(settingsPath))}\n`;
      targets.push({ label: SETTINGS_REL, path: settingsPath, tmp: writeTemp(settingsPath, content, 0o600) });
    }
    if (plan.mcp !== null) {
      const keepMode = existsSync(mcpPath) ? statSync(mcpPath).mode & 0o777 : 0o644;
      const content = `${JSON.stringify(plan.mcp, null, detectIndent(mcpPath))}\n`;
      targets.push({ label: MCP_REL, path: mcpPath, tmp: writeTemp(mcpPath, content, keepMode) });
    }
    if (plan.nextRecord !== undefined) {
      const content = `${JSON.stringify(plan.nextRecord, null, 2)}\n`;
      recordTmp = writeTemp(recordPath, content, 0o600);
    }
    for (const t of targets) backup(t.path);
    if (recordTmp !== null) {
      renameSync(recordTmp, recordPath); // BEFORE settings (ruling (c))
      recordTmp = null;
      done.push(INSTALL_JSON_REL);
    }
    for (const t of targets) {
      renameSync(t.tmp, t.path);
      done.push(t.label);
    }
    if (plan.skills) {
      if (args.uninstall) {
        rmSync(skillsPath, { recursive: true, force: true });
      } else {
        mkdirSync(join(args.dir, ".claude", "skills"), { recursive: true });
        rmSync(skillsPath, { recursive: true, force: true });
        cpSync(join(PLUGIN_DIR, "skills", "rig-memory"), skillsPath, { recursive: true });
      }
      done.push(SKILLS_REL);
    }
    if (plan.removeRecord) {
      // rule 4: the record goes LAST; backups/ and .gitignore stay
      rmSync(recordPath, { force: true });
      done.push(`removed ${INSTALL_JSON_REL}`);
    }
  } catch {
    if (recordTmp !== null) {
      try {
        rmSync(recordTmp, { force: true });
      } catch {
        /* best effort */
      }
    }
    for (const t of targets) {
      try {
        rmSync(t.tmp, { force: true });
      } catch {
        /* best effort: the temp file may already be gone */
      }
    }
    die(`partial: ${done.join(", ") || "none"}; backups: ${backups.join(", ") || "none"}`);
  } finally {
    // T14c: release the apply lock (the exit hook repeats this for the die()
    // path; force:true makes the double removal harmless)
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  }
  console.log(`${what} ${args.dir}: done`);
}

if (import.meta.main) {
  main();
}
