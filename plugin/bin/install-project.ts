// T12b (ADR-0008 Decision 1, amended 18:35Z): install the memory hooks into a
// PROJECT DIRECTORY so existing seats pick them up on resume, keeping their
// conversations. Merges into <dir>/.claude/settings.local.json and
// <dir>/.mcp.json, copies skills/rig-memory/, and reverses exactly its own
// changes with --uninstall.
//
// Binding rules from the operator amendment:
// - merge only: foreign keys, hook groups, servers and key ORDER are never
//   replaced, reordered or deleted; our hook groups append after existing
//   ones; our env keys are exactly the FLAG_ENV names;
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
//   the FLAG_ENV flag-name env keys (any other HONCHO_* key is foreign), our hook
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
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/env.ts";
import {
  codexEventLabel,
  codexHookKey,
  codexNormalizedTimeout,
  codexTrustedHash,
} from "../src/codex-trust.ts";

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

// C5b review (architect): the backup stamp is per second, so an install and
// an uninstall in the SAME SECOND name the same copy; the first copy must
// never be lost. The normal-case name stays exactly <file>.<stamp>; only a
// real collision appends -1, -2, ...
function uniqueBackupCopy(dir: string, name: string): string {
  let copy = join(dir, name);
  for (let i = 1; existsSync(copy); i++) copy = join(dir, `${name}-${i}`);
  return copy;
}
const FLAG_ENV: Record<string, string> = {
  "--url": "HONCHO_URL",
  "--workspace": "HONCHO_WORKSPACE",
  "--leader": "HONCHO_LEADER_PEER",
  "--profile-workspace": "HONCHO_PROFILE_WORKSPACE",
  "--owner-peer": "HONCHO_OWNER_PEER",
  // O3 item 3 (ADR-0017): the recall holdout share, the SAME setting on both
  // harnesses - Claude keeps it in settings.json env, Codex in the seat's
  // settings file, where a reinstall keeps it (see the carry-over there).
  "--recall-holdout": "HONCHO_RECALL_HOLDOUT",
};
const OUR_ENV_NAMES = Object.values(FLAG_ENV); // uninstall removes exactly these
const USAGE =
  "usage: bun run <plugin>/bin/install-project.ts <project dir> --url U --workspace W [--leader P] [--profile-workspace W] [--owner-peer P] [--recall-holdout N] [--dry-run] | ... <project dir> --uninstall [--dry-run]";

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

/** S4 (C5l): our user-backups folder, mode 700, never created or chmodded
 * through a symlink (the chmod would FOLLOW one). The re-check after mkdir
 * covers a link planted in the mkdir window; mkdir(recursive) on an
 * existing symlinked folder would otherwise silently succeed. */
function ensureBackupsDir700(dir: string): void {
  refuseSymlink(dir, "backups folder");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    die(`${dir}: the backups folder cannot be created - refusing, nothing written`);
  }
  refuseSymlink(dir, "backups folder");
  chmodSync(dir, 0o700); // the mkdir mode is filtered by the umask; pin it
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
 * C5l2: the shared guts of BOTH installer locks (the seat's install.lock
 * and the Codex user-config lock). Each learned the same lessons the hard
 * way - the user-config lock in the C5l 6-way burst (a seat's trust block
 * vanished with both installers exiting 0), the seat lock in C5l2 (same
 * class, found while reviewing that fix):
 *  - createLockAtomic: the lock must APPEAR WHOLE. Fill a per-pid side
 *    file, then hard-link it into place (a link never overwrites), so a
 *    reader sees our lock only in its whole, or not at all. The old
 *    open-then-write let waiters read an EMPTY lock while the holder was
 *    descheduled between the open and the write, judge the live holder
 *    "not readable JSON" garbage and rename a LIVE lock aside mid-fill -
 *    the fill then landed on the moved inode, the stealer took the slot,
 *    and both processes ran the critical section.
 *  - releaseLockOwned: remove the lock only while it still carries OUR
 *    bytes. A bare rm in the exit belt could delete the NEXT holder's lock
 *    (a waiter can grab the window between our finally-release and our
 *    exit-rm).
 *  - judgeLock: a lock whose RAW bytes still show a pid has a holder that
 *    is alive or dead BY PID - never garbage, never stale while it lives.
 */
const LOCK_PID_RE = /"pid"\s*:\s*(\d{1,9})(?:\D|$)/;

/** true: we hold it; false: the slot is taken; "enoent": the folder is
 * missing - the caller mkdirs its own folder and retries (never a bare
 * create there: a refusal may leave an empty folder, never a file). */
function createLockAtomic(path: string, bytes: string, label: string): true | false | "enoent" {
  const fill = `${path}.fill-${process.pid}`;
  try {
    writeFileSync(fill, bytes, { mode: 0o600 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT") return "enoent";
    die(`${label}: the fill file cannot be written (${code ?? "error"}) - refusing, nothing written`);
  }
  try {
    linkSync(fill, path); // the EEXIST test itself: atomic, never replaces
    try {
      unlinkSync(fill);
    } catch {
      /* our own leftover, best effort */
    }
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    try {
      unlinkSync(fill);
    } catch {
      /* best effort */
    }
    if (code === "EEXIST") return false;
    die(`${label}: ${path}: cannot be created (${code ?? "error"}) - refusing, nothing written`);
  }
}

/** Release: ours only. Absent or someone else's: leave it be. */
function releaseLockOwned(path: string, lockBytes: string): void {
  try {
    if (readFileSync(path, "utf8") === lockBytes) rmSync(path, { force: true });
  } catch {
    /* best effort: absent or taken over */
  }
}

/**
 * Read a lock we failed to create. Three re-reads cover a fill window
 * (T14c battery: a loser once read the winner mid-write, called the fresh
 * live lock garbage and stole it); ENOENT means the holder released it
 * while we looked, so the slot is free - never remove anything here.
 * C5l2: when the bytes still do not parse after the re-reads, scan them
 * for a pid before judging - a partly-written lock whose holder's pid is
 * visible belongs to a process that is alive or dead, and "garbage" would
 * steal a live holder's lock (the empty lock stays garbage: no pid inside
 * means no holder to be alive, and after the atomic create OUR installers
 * never leave one mid-fill anyway).
 * F6 (review R13): before any reading, lstat the slot. A non-REGULAR file
 * there - a directory is the R13 case - can never be our lock, so return
 * notLock with gone=false and judged=null: callers refuse BEFORE any rename
 * and write nothing. The ENOENT and regular-file flows below are unchanged.
 */
function judgeLock(path: string): {
  pid: number | null;
  why: string;
  gone: boolean;
  judged: string | null;
  notLock: string | null;
} {
  let notLock: string | null = null;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) notLock = st.isDirectory() ? "a directory" : "not a regular file";
  } catch {
    // unreadable slot (incl. ENOENT): today's read loop judges it as before
  }
  if (notLock !== null) return { pid: null, why: "", gone: false, judged: null, notLock };
  let pid: number | null = null;
  let why = "it is not readable JSON";
  let gone = false;
  let judged: string | null = null;
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
      if (reads === 2 && judged !== null) {
        const m = LOCK_PID_RE.exec(judged);
        const n = m ? Number(m[1]) : 0;
        if (n > 0) {
          pid = n;
          why = "";
        }
      }
      if (reads < 2) nap(50);
    }
  }
  return { pid, why, gone, judged, notLock: null };
}

/**
 * T14c (plan-v0.2, the D1 "partial" race), lock windows closed by T14e: one
 * install/uninstall apply per project at a time. The lock is
 * <recordDir>/install.lock, created ATOMICALLY since C5l2 (createLockAtomic:
 * fill file + hard link, so it appears whole) at 0600 and holding only
 * {"pid","at"} - never a value from the project. A live-pid lock refuses with
 * nothing written. A lock released while we look (ENOENT on the read) is
 * taken by ONE exclusive create, never by removing first (T14e(a): rm would
 * delete a third racer's lock created in that window). A dead-pid or garbage
 * lock is stale: moved aside, then - only after the move AND the take have
 * succeeded - said on ONE after-the-fact line (F6, review R13: the old
 * announce promised "taking it" before a move that can fail, and named a
 * wrong cause when it did). A non-regular file at the slot (a directory is
 * the R13 case) is not a lock at all: refuse before any rename, zero writes.
 * The move is an ATOMIC rename to
 * install.lock.stale-<pid> (T14e(b): two losers can no longer both rm+create
 * the same stale lock); if the renamed bytes are not what we judged, the
 * file is a fresher lock - rename it back when the slot is free and refuse.
 * Each takeover then takes the lock by one exclusive create - if that create
 * loses the race, refuse like a live one (no second takeover attempt). The
 * caller releases in the apply's finally; a process "exit" hook is the belt,
 * because die() exits without running finally blocks (an F3 preflight
 * refusal is exactly that path). Returns {path, release}; the release is
 * OWNED (releaseLockOwned), so a late belt can never delete the next
 * holder's lock. Never touches a foreign live lock - and since C5l2, not
 * even mid-fill: the pid inside a partly-written lock is read before any
 * judging, so a live holder is never garbage.
 *
 * TEST SEAM (T14e): HONCHO_INSTALL_SEAM_MS=1..10000 makes the taker pause
 * inside the two takeover windows (judging and taking over) after writing a
 * marker <recordDir>/install.seam<phase>.<pid>, so unit tests can open a
 * window deterministically instead of fishing for it with real racers.
 * Unset or invalid: no pause, no marker, production cost zero.
 */
function takeInstallLock(recordDir: string, what: string): { path: string; release: () => void } {
  const path = join(recordDir, "install.lock");
  const rawSeam = (process.env.HONCHO_INSTALL_SEAM_MS ?? "").trim();
  const seamMs = /^\d{1,5}$/.test(rawSeam) && Number(rawSeam) >= 1 && Number(rawSeam) <= 10_000 ? Number(rawSeam) : 0;
  const seam = (phase: number): void => {
    if (seamMs === 0) return;
    try {
      mkdirSync(recordDir, { recursive: true, mode: 0o700 }); // F4: ours means 700
      writeFileSync(join(recordDir, `install.seam${phase}.${process.pid}`), `${process.pid}\n`);
    } catch {
      // the marker is best effort; the pause is the point
    }
    nap(seamMs);
  };
  const lockBytes = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  const release = (): void => releaseLockOwned(path, lockBytes);
  const create = (): boolean => {
    for (let tries = 0; tries < 2; tries++) {
      const r = createLockAtomic(path, lockBytes, "install.lock");
      if (r !== "enoent") return r;
      if (tries === 1) die("install.lock: our folder cannot be created (ENOENT) - refusing, nothing written");
      // our folder (rule 1) is not there yet - the only write a refusal
      // could ever leave behind is this empty folder (F4: at 700), never a
      // file; tightening a PRE-EXISTING one happens later, at apply time
      try {
        mkdirSync(recordDir, { recursive: true, mode: 0o700 });
      } catch (e2) {
        const c2 = (e2 as { code?: string }).code;
        die(`install.lock: our folder cannot be created (${c2 ?? "error"}) - refusing, nothing written`);
      }
    }
    return false; // unreachable: each path returns or dies
  };
  const held = (): { path: string; release: () => void } => {
    process.on("exit", release); // belt: die() skips finally blocks
    return { path, release };
  };
  if (create()) return held();
  for (let staleTries = 0; staleTries < 1; staleTries++) {
    seam(1); // test window before judging (unset: no-op)
    // judged is the bytes we judged stale, for the T14e(b) re-check.
    // judgeLock: fill-window re-reads, ENOENT means free (never remove
    // anything), and C5l2 - a partly-written lock with a visible pid
    // belongs to a holder that is alive or dead, never stale while it
    // lives, never moved aside.
    const { pid, why, gone, judged, notLock } = judgeLock(path);
    if (notLock !== null) {
      // F6 (review R13): a directory (or any non-regular file) at the slot
      // is not a stale lock - refuse with the true cause BEFORE touching it.
      die(`install.lock: ${path} is in the lock slot but is ${notLock} - not a lock file: refusing, nothing written`);
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
      // F6: no announce here - the stale line is printed only after the
      // move-aside AND the take have both succeeded (below).
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
        if (create()) {
          // F6: after the fact - the folder WAS moved aside and the lock IS ours.
          console.log(
            `[${what}] install.lock was stale (${why || `pid ${pid} is not running`}): moved aside to ${basename(aside)} and taken`,
          );
          return held();
        }
      }
    }
  }
  die("install.lock: another install or uninstall is running in this project - refusing, nothing written");
}

/**
 * S2 (C5l, security review): parallel installs against ONE CODEX_HOME raced
 * on the shared user config - every process read the same old text and the
 * last rename won, erasing the other seats' trust blocks (the review lost a
 * block in 10 of 10 trials). A mode that reads or writes the user layer now
 * takes this lock from BEFORE the user-config read for the rest of the
 * process (held() = release on exit, the same belt as takeInstallLock, so
 * every die() path frees it too). A live holder is WAITED on (different
 * seats legitimately install at once) up to HONCHO_CODEX_LOCK_WAIT_MS
 * (default 60000; one install is sub-second, so a wait past that is a
 * crash, not a queue). A dead or garbage lock is judged and moved aside
 * with the T14e rules of the seat lock: fill-window re-reads, ENOENT means
 * free, and only the bytes we judged stale may be removed. Lock order is
 * one-way - user-config lock here, the seat's install.lock later, never the
 * reverse - so two installs can never cycle on each other. F6 (review R13)
 * applies the seat lock's two rules here too: the stale line is said only
 * after the move AND the take succeeded, and a non-regular file at the slot
 * (a directory) refuses before any rename with its own message, zero writes.
 */
function takeUserConfigLock(what: string): { path: string; release: () => void } {
  const dir = codexUserHome();
  const path = join(dir, "openrig-honcho-install.lock");
  const rawWait = (process.env.HONCHO_CODEX_LOCK_WAIT_MS ?? "").trim();
  const waitMs =
    /^\d{1,5}$/.test(rawWait) && Number(rawWait) >= 1 && Number(rawWait) <= 60_000 ? Number(rawWait) : 60_000;
  // OWNED release and ATOMIC appearance (C5l) - since C5l2 shared with the
  // seat lock through createLockAtomic / releaseLockOwned / judgeLock, see
  // their doc for the two races they close (empty-lock mid-fill judged
  // garbage in the 6-way burst; the bare exit-rm deleting the next
  // holder's lock in the finally-to-exit window).
  const lockBytes = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  const release = (): void => releaseLockOwned(path, lockBytes);
  const held = (): { path: string; release: () => void } => {
    process.on("exit", release); // belt: every die() path releases too
    return { path, release };
  };
  const create = (): boolean => {
    for (let tries = 0; tries < 2; tries++) {
      const r = createLockAtomic(path, lockBytes, "Codex user config lock");
      if (r !== "enoent") return r;
      if (tries === 1) die(`Codex user config lock: ${path}: the folder cannot be created - refusing, nothing written`);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        die(`Codex user config lock: ${path}: the folder cannot be created - refusing, nothing written`);
      }
    }
    return false; // unreachable
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (create()) return held();
    const { pid, why, gone, judged, notLock } = judgeLock(path);
    if (gone) continue; // released between the collide and the read: the slot is free
    if (notLock !== null) {
      // F6 (review R13): a directory (or any non-regular file) at the slot
      // is not a stale lock - refuse with the true cause BEFORE touching it.
      die(`Codex user config lock: ${path} is in the lock slot but is ${notLock} - not a lock file: refusing, nothing written`);
    }
    if (pid !== null && pidAlive(pid)) {
      if (Date.now() >= deadline) {
        die(`Codex user config lock: ${path} is held by pid ${pid} for over ${waitMs} ms - refusing, nothing written`);
      }
      nap(50);
      continue;
    }
    // F6: no announce here - the stale line is printed only after the
    // move-aside AND the take have both succeeded (below).
    const aside = `${path}.stale-${process.pid}`;
    let renamed = false;
    try {
      renameSync(path, aside);
      renamed = true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ENOENT") {
        die(`Codex user config lock: the stale lock cannot be moved aside (${code ?? "error"}) - refusing, nothing written`);
      }
      continue; // taken over first: one more exclusive create on the next lap
    }
    if (renamed) {
      // the moved file must still carry the bytes we judged stale
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
          /* best-effort restore; we refuse either way */
        }
        die("Codex user config lock: another install took it while we judged it stale - refusing, nothing written");
      }
      try {
        rmSync(aside, { force: true });
      } catch {
        /* the bytes were stale; nothing dangerous can remain */
      }
      if (create()) {
        // F6: after the fact - the file WAS moved aside and the lock IS ours.
        console.log(
          `[${what}] Codex user config lock was stale (${why || `pid ${pid} is not running`}): moved aside to ${basename(aside)} and taken`,
        );
        return held();
      }
    }
  }
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
  // ruling (b) 01:05Z: envAdded carries ONLY the FLAG_ENV flag names, no duplicates
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

/** F4 (ADR-0018): our folders are mode 700. Created at 0700 (the mkdir mode
 * is umask-filtered, so a wider result is pinned below); a pre-existing one
 * with ANY group/other bit is tightened to 0700. A pre-existing one already
 * narrow is left exactly as its owner set it. */
function ensureOurDir700(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // an existing folder or a racing creator: the tightening below decides
  }
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {
    // best effort against a racing installer; we never follow a folder we
    // could not stat
  }
}

/** F7: tighten ALREADY EXISTING folders of ours to 0700 without ever creating
 * them (an idempotent nothing-to-change run must still create nothing). The
 * v0.5.2 pilots kept 0775 record/backups folders because ensureOurDir700 sat
 * inside the record-write branch; a no-write or skill-only run never reached
 * it. Returns the RELATIVE names of folders whose mode was actually tightened. */
function tightenExistingOurs(dirs: [string, string][]): string[] {
  const names: string[] = [];
  for (const [dir, rel] of dirs) {
    try {
      const st = statSync(dir);
      if (st.isDirectory() && (st.mode & 0o077) !== 0) {
        chmodSync(dir, 0o700);
        names.push(rel);
      }
    } catch {
      // no such folder (ENOENT: the normal case here) or a racing installer
    }
  }
  return names;
}

/** F4: the sweep reuses pidAlive (T14c, above): EPERM counts as running, only
 * ESRCH means dead. The exact suffix writeTemp produces: .tmp-<digits>-<lowercase base36>. */
const TMP_SUFFIX_RE = /^\.tmp-(\d+)-[0-9a-z]+$/;

/** F4: a killed install leaves our own temps behind (the review saw
 * config.toml.tmp-* in the Codex home holding the owner's merged config).
 * Sweep ONLY files named exactly <ours>.tmp-<pid>-<rand> in the folders we
 * write, and only when that pid is dead; every other name is left untouched.
 * Returns the swept basenames - never contents. */
function sweepStaleTemps(targets: string[]): string[] {
  const swept: string[] = [];
  for (const target of targets) {
    const dir = dirname(target);
    const base = basename(target);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // the folder is not there (yet): nothing of ours can be in it
    }
    for (const name of names) {
      if (!name.startsWith(base)) continue;
      const m = TMP_SUFFIX_RE.exec(name.slice(base.length));
      if (m === null) continue;
      try {
        const full = join(dir, name);
        if (!statSync(full).isFile()) continue; // folders are never touched
        if (pidAlive(Number(m[1]))) continue; // live: possibly mid-write
        unlinkSync(full); // a planted symlink is removed, never followed
        swept.push(name);
      } catch {
        // racing installer won the file first: best effort
      }
    }
  }
  return swept;
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

/** F3 (ADR-0018): OUR plugin path as a WHOLE path, never a substring. A
 * sibling folder whose path merely STARTS with ours (<...>/openrig-honcho-
 * old, <...>/openrig-honcho2) is NOT ours - the old substring match claimed
 * it, so install replaced it and uninstall removed it. A match counts only
 * when PLUGIN_DIR is followed by a path separator, the end of the string,
 * or a character that cannot continue a path segment (quote, whitespace,
 * punctuation). PLUGIN_DIR is regex-escaped. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OUR_PATH_RE = new RegExp(`${escapeRe(PLUGIN_DIR)}(?![A-Za-z0-9._\\-])`);

/** Our hook group / server iff any string value names the plugin path. */
function namesPlugin(v: unknown): boolean {
  if (typeof v === "string") return OUR_PATH_RE.test(v);
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
  /** C5b (ADR-0016): "claude" (default, today's path) or "codex". */
  harness: "claude" | "codex";
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let dryRun = false;
  let uninstall = false;
  let harness: "claude" | "codex" = "claude";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--uninstall") uninstall = true;
    else if (a === "--harness") {
      // C5b: the strict space form only (same rule the hook bins use);
      // "--harness=..." matches no branch below and dies as unknown.
      const v = argv[i + 1];
      if (v !== "claude" && v !== "codex") die(`--harness takes claude or codex, got ${JSON.stringify(v ?? "")}`);
      harness = v;
      i++;
    } else if (a in FLAG_ENV) {
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
  return { dir, flags, dryRun, uninstall, harness };
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
    // O3 item 3: the holdout flag goes through loadConfig's own 0..0.9 rule.
    HONCHO_RECALL_HOLDOUT: flags.get("HONCHO_RECALL_HOLDOUT"),
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

  // env: only the FLAG_ENV flag names; foreign keys (anything not ours) are never
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
  // (v0.1.1 install) all present names count as added, as v0.1.1 did.
  // Any other HONCHO_* key is foreign in both modes.
  if (isJsonObject(settings.env)) {
    const env = settings.env as Json;
    const candidates = record !== null ? record.envAdded : OUR_ENV_NAMES;
    const removed = candidates.filter((k) => k in env);
    // rule 4 (architect 03:58Z): EVERY HONCHO_* key still present is named,
    // not just our names - a foreign HONCHO_* the owner has must be visible
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
  // C5b (ADR-0016 decisions 4+7+9): the Codex project layer is a separate,
  // self-contained apply - the Claude code below is untouched by a codex run.
  if (args.harness === "codex") {
    mainCodex(args);
    return;
  }
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
    // F7: a run that writes nothing else still closes our existing folders;
    // never creates them, never runs on --dry-run (review D6 stands).
    const tightened = args.dryRun ? [] : tightenExistingOurs([[recordDir, RECORD_DIR_REL], [backupsDir, BACKUPS_REL]]);
    if (tightened.length > 0) {
      console.log(`${what} ${args.dir}: tightened ${tightened.join(" and ")} to mode 700; nothing else to change`);
    } else {
      console.log(`${what} ${args.dir}: nothing to change (already ${args.uninstall ? "clean" : "installed"})`);
    }
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
  const lock = takeInstallLock(recordDir, what);

  // F4: sweep our own temp files left by a dead installer (exact name shape,
  // dead pid only, files only). The dry-run returned before the lock, so a
  // dry-run can never reach this. One line printed, only when names were
  // removed, and it names files - never contents.
  const swept = sweepStaleTemps([settingsPath, mcpPath, recordPath]);
  if (swept.length > 0) console.log(`${what}: swept ${swept.length} stale temp file(s): ${swept.join(", ")}`);

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

  // F7: this run writes something but may skip the record branch below (the
  // skill-only v0.5.2 reinstall): existing folders of ours still get tightened
  // here, without creating anything (the branch creates them when it runs).
  // After the F3 preflight, so a refusal still writes nothing at all.
  const tightened = tightenExistingOurs([[recordDir, RECORD_DIR_REL], [backupsDir, BACKUPS_REL]]);
  if (tightened.length > 0) console.log(`${what}: tightened ${tightened.join(" and ")} to mode 700`);

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
    const copy = uniqueBackupCopy(backupsDir, `${basename(path)}.${stamp}`);
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
      ensureOurDir700(recordDir); // F4: ours means 700, wider pre-existing gets tightened
      ensureOurDir700(backupsDir);
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
    // path; C5l2: the release is OWNED, so a late belt can never delete the
    // next holder's lock)
    lock.release();
  }
  console.log(`${what} ${args.dir}: done`);
}

// ---------------------------------------------------------------------------
// C5b (ADR-0016 decisions 4, 7 and 9): the Codex project layer.
//
// What --harness codex writes, in the seat folder <dir>:
//   .codex/hooks.json          SessionStart, UserPromptSubmit and Stop under
//                              PascalCase event keys (snake_case is ignored
//                              by Codex, probe C1 3); recall and user-prompt
//                              both run on UserPromptSubmit, recall first,
//                              exactly as in the Claude install; every
//                              command carries --harness codex and
//                              --settings <abs path of our settings file>.
//   .codex/config.toml         ONLY a clearly delimited managed block with
//                              [mcp_servers.rig_memory] (default_tools_approval_mode
//                              = "approve", the one key that lets an
//                              approval_policy="never" seat call our tools,
//                              probe C1 round 2; env_vars forwards
//                              OPENRIG_SESSION_NAME/OPENRIG_URL, without
//                              which the C1 probe-era full-env assumption
//                              fails on a real seat, C5j). The table header comes
//                              first, so no key can land in a preceding
//                              sub-table (the probe's TOML trap). Nothing
//                              outside the block is ever rewritten.
//   .agents/skills/rig-memory/ the skill (Codex reads .agents/skills, C1 6).
//   .codex/openrig-honcho/     settings.json (0600 - the HONCHO_* values from
//                              the same flags the Claude install takes; a
//                              real Codex seat has none, R0), install.json
//                              (the record), backups/ and .gitignore "*".
//
// Same guarantees as the Claude path: only adds; never overwrites a value it
// did not set; --dry-run names keys and paths, never values; refuses with
// zero writes on unparseable JSON, a damaged managed block, a foreign
// rig_memory table, symlinked targets, unwritable files, a damaged record or
// a record naming another plugin folder. No double hooks: refuse when our
// hooks or our rig_memory server already run in the USER layer ($CODEX_HOME,
// default ~/.codex) or in the project layer from another install. The only
// thing this installer ever writes into the user layer is its OWN delimited
// [hooks.state] trust block for the hooks it added (C5c), after a dated
// backup into our seat backups/; uninstall removes exactly it. Project trust
// is checked and named when missing, never granted. A Codex seat whose
// ANCESTOR folder already runs our hooks skips hooks entirely (C5d, the
// ADR-0010 shape): the record notes hooksSkipped with that folder, every
// other trace installs, no trust is touched, and uninstall of the inner seat
// never looks at or writes the ancestor's files. Every run prints the user
// config path it resolves (C5d), so a defaulted ~/.codex is visible at once.
// Uninstall removes exactly what the record lists, including the managed
// blocks - and backs up a config.toml it creates and now removes (F8), so
// owner bytes typed inside our block survive in backups/.
// ---------------------------------------------------------------------------

const CODEX_HOOKS_REL = join(".codex", "hooks.json");
const CODEX_CONFIG_REL = join(".codex", "config.toml");
const CODEX_SKILLS_REL = join(".agents", "skills", "rig-memory");
const CODEX_RECORD_DIR_REL = join(".codex", "openrig-honcho");
const CODEX_SETTINGS_REL = join(CODEX_RECORD_DIR_REL, "settings.json");
const CODEX_INSTALL_JSON_REL = join(CODEX_RECORD_DIR_REL, "install.json");
const CODEX_BACKUPS_REL = join(CODEX_RECORD_DIR_REL, "backups");
const CODEX_BLOCK_BEGIN = "# BEGIN openrig-honcho rig_memory (managed - do not edit inside)";
const CODEX_BLOCK_END = "# END openrig-honcho rig_memory";
/** A [mcp_servers.rig_memory] table header or any of its sub-tables. */
const RIG_MEMORY_TABLE_RE = /^\s*\[\s*mcp_servers\s*\.\s*rig_memory(\s*\.\s*[^\]]+)?\s*\]/m;
/** All five bins, for the user-layer double-hook scan. */
const OUR_BIN_ANY_RE = /(?:^|[/\\])bin[/\\](?:session-start|recall|user-prompt|stop|mcp)\.ts/;

interface CodexRecord {
  version: 2;
  plugin: string;
  harness: "codex";
  /** hooks.json was created by us (vs edited into an existing file). */
  hooksCreated: boolean;
  /** events we appended our groups to (unproved pre-record groups are found
   * by namesPlugin at uninstall anyway; this lists what we claim). */
  hooksEvents: string[];
  /** config.toml was created by us (vs our block appended to an existing file). */
  configCreated: boolean;
  /** a trailing newline we had to add before appending the block - the
   * uninstall takes it back out so the file returns byte for byte. */
  configSep: boolean;
  configBlockAdded: boolean;
  skillsAdded: boolean;
  // C5c (record v2): user-layer hook trust. v1 records load with the
  // defaults - a v1 install predates trust and wrote none.
  /** our trust block was added to $CODEX_HOME/config.toml */
  trustBlockAdded: boolean;
  /** the [hooks.state."<key>"] keys inside our trust block, sorted */
  trustKeys: string[];
  /** a trailing newline we added before appending the trust block - the
   * uninstall takes it back out when the block ran to EOF */
  trustSep: boolean;
  /** $CODEX_HOME/config.toml was created by us (vs our block appended) */
  userConfigCreated: boolean;
  // C5d (the ADR-0010 shape on the Codex side):
  /** hooks were skipped because an ancestor folder already runs our hooks
   * for this seat (Codex layers project folders from the cwd upward); holds
   * that ancestor's directory. Unset = hooks installed normally. v2 only -
   * a skip cannot predate the record that describes it. */
  hooksSkipped?: string;
}

/** Rule 6 as in the Claude path: unreadable, wrong shape or another plugin
 * path refuses BOTH directions with zero writes. Messages name the file. */
function loadCodexRecord(path: string): CodexRecord | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    die(`${CODEX_INSTALL_JSON_REL}: exists but is not parseable JSON - refusing, nothing written`);
  }
  const bad = `${CODEX_INSTALL_JSON_REL}: not a valid install record - refusing, nothing written`;
  if (!isJsonObject(parsed)) die(bad);
  const keySet = Object.keys(parsed).sort().join(",");
  const keySetV1 =
    "configBlockAdded,configCreated,configSep,harness,hooksCreated,hooksEvents,plugin,skillsAdded,version";
  const keySetV2 =
    "configBlockAdded,configCreated,configSep,harness,hooksCreated,hooksEvents,plugin,skillsAdded," +
    "trustBlockAdded,trustKeys,trustSep,userConfigCreated,version";
  // C5d: hooksSkipped is the only optional key, and only on v2 (a skipped
  // install is written by this version; an absent key means a normal one).
  const keySetV2Skipped =
    "configBlockAdded,configCreated,configSep,harness,hooksCreated,hooksEvents,hooksSkipped,plugin," +
    "skillsAdded,trustBlockAdded,trustKeys,trustSep,userConfigCreated,version";
  if (keySet !== keySetV1 && keySet !== keySetV2 && keySet !== keySetV2Skipped) die(bad);
  const v2 = keySet === keySetV2 || keySet === keySetV2Skipped;
  if ((parsed.version !== 1 && parsed.version !== 2) || parsed.harness !== "codex") die(bad);
  if (typeof parsed.plugin !== "string") die(bad);
  if (parsed.plugin !== PLUGIN_DIR) {
    die(`${CODEX_INSTALL_JSON_REL}: names a different plugin path than this one - refusing, nothing written`);
  }
  for (const k of ["hooksCreated", "configCreated", "configSep", "configBlockAdded", "skillsAdded"] as const) {
    if (typeof parsed[k] !== "boolean") die(bad);
  }
  if (
    !Array.isArray(parsed.hooksEvents) ||
    !parsed.hooksEvents.every((e: unknown) => typeof e === "string") ||
    new Set(parsed.hooksEvents as unknown[]).size !== (parsed.hooksEvents as unknown[]).length
  )
    die(bad);
  let trustKeys: string[] = [];
  if (v2) {
    for (const k of ["trustBlockAdded", "trustSep", "userConfigCreated"] as const) {
      if (typeof parsed[k] !== "boolean") die(bad);
    }
    if (
      !Array.isArray(parsed.trustKeys) ||
      !parsed.trustKeys.every((e: unknown) => typeof e === "string") ||
      new Set(parsed.trustKeys as unknown[]).size !== (parsed.trustKeys as unknown[]).length
    )
      die(bad);
    trustKeys = [...(parsed.trustKeys as string[])].sort();
  }
  let hooksSkipped: string | undefined;
  if (parsed.hooksSkipped !== undefined) {
    if (parsed.version !== 2 || typeof parsed.hooksSkipped !== "string" || parsed.hooksSkipped === "") die(bad);
    hooksSkipped = parsed.hooksSkipped;
  }
  // v1 loads as v2 with trust defaults; the file on disk upgrades on the
  // next record-changing run.
  return {
    version: 2,
    plugin: parsed.plugin,
    harness: "codex",
    hooksCreated: parsed.hooksCreated as boolean,
    hooksEvents: [...(parsed.hooksEvents as string[])].sort(),
    configCreated: parsed.configCreated as boolean,
    configSep: parsed.configSep as boolean,
    configBlockAdded: parsed.configBlockAdded as boolean,
    skillsAdded: parsed.skillsAdded as boolean,
    trustBlockAdded: v2 ? (parsed.trustBlockAdded as boolean) : false,
    trustKeys,
    trustSep: v2 ? (parsed.trustSep as boolean) : false,
    userConfigCreated: v2 ? (parsed.userConfigCreated as boolean) : false,
    ...(hooksSkipped !== undefined ? { hooksSkipped } : {}),
  };
}

/** The hook groups a Codex seat runs: the Claude install's groups, same
 * order and timeouts, with the two Codex flags appended (decision 9).
 * C5l2: the plugin folder is a parameter (defaulting to OURS) so the
 * ancestor-skip check can rebuild the exact bytes a DIFFERENT copy of this
 * plugin left in an ancestor - nothing else passes it. */
function codexHookGroups(settingsAbs: string, pluginDir: string = PLUGIN_DIR): Json {
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
 * Our whole managed block, header before any key (the probe's TOML trap).
 * C5j (L1 live finding): Codex starts a stdio MCP server with ONLY its
 * DEFAULT_ENV_VARS (HOME, LOGNAME, PATH, SHELL, USER, LANG, LC_ALL, TERM,
 * TMPDIR, TZ) plus the names the server entry lists in env_vars
 * (rust-v0.167.0 rmcp-client/src/utils.rs:16-25 and :163; names forwarded
 * from Codex's own environment, config/src/mcp_types.rs:103 and :399).
 * Without this line OPENRIG_SESSION_NAME/OPENRIG_URL never reach
 * bin/mcp.ts (live: "mcp: HONCHO_PEER is required (or set
 * OPENRIG_SESSION_NAME)", _config.log 12:30:15Z) - hooks work because they
 * get the full environment. Those two are EVERY non-HONCHO variable
 * bin/mcp.ts and src/ read besides HOME (which is already defaulted);
 * HONCHO_* are NEVER forwarded by name - on Codex the settings file is
 * their only source (ADR-0016 decision 9).
 */
function codexMcpBlock(settingsAbs: string): string {
  const q = (s: string): string => JSON.stringify(s); // TOML basic string
  return `${[
    CODEX_BLOCK_BEGIN,
    `[${SERVER_NAME.replace("rig_memory", "mcp_servers.rig_memory")}]`,
    `command = ${q("bun")}`,
    `args = [${[join(PLUGIN_DIR, "bin", "mcp.ts"), "--harness", "codex", "--settings", settingsAbs].map(q).join(", ")}]`,
    `default_tools_approval_mode = ${q("approve")}`,
    `env_vars = [${["OPENRIG_SESSION_NAME", "OPENRIG_URL"].map(q).join(", ")}]`,
    CODEX_BLOCK_END,
  ].join("\n")}\n`;
}

/** Locate our managed block; a half-present one is damage, not absence. */
function findCodexBlock(text: string): { begin: number; end: number } | null {
  const lines = text.split("\n");
  const begins = lines.map((l, i) => (l === CODEX_BLOCK_BEGIN ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (l === CODEX_BLOCK_END ? i : -1)).filter((i) => i >= 0);
  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || (ends[0] as number) <= (begins[0] as number)) {
    die(`${CODEX_CONFIG_REL}: our managed block markers are damaged - refusing, nothing written`);
  }
  return { begin: begins[0] as number, end: ends[0] as number };
}

const outsideCodexBlock = (text: string, block: { begin: number; end: number } | null): string => {
  if (block === null) return text;
  const lines = text.split("\n");
  return [...lines.slice(0, block.begin), ...lines.slice(block.end + 1)].join("\n");
};

/** "Something in this text runs our hooks or serves our rig_memory from an
 * openrig-honcho folder" - the double-hook shape, per file text. */
const runsOurHooksText = (text: string): boolean =>
  OPENRIG_HONCHO_SEGMENT_RE.test(text) && (OUR_BIN_ANY_RE.test(text) || RIG_MEMORY_TABLE_RE.test(text));

/** Decision 4: nothing may fire twice. Scan the user layer READ-ONLY (the
 * only thing we later write there is our trust block - hex hashes and path
 * keys, which match none of these patterns) and refuse on any shape of our
 * hooks or our rig_memory server there. */
function refuseCodexUserLayerDup(): void {
  const rawHome = (process.env.CODEX_HOME ?? "").trim();
  const codexHome = rawHome !== "" ? resolve(rawHome) : join(process.env.HOME ?? "", ".codex");
  for (const f of ["hooks.json", "config.toml"]) {
    let text: string;
    try {
      text = readFileSync(join(codexHome, f), "utf8");
    } catch {
      continue; // absent or unreadable: nothing of ours runs there
    }
    if (runsOurHooksText(text)) {
      die(
        `${join(codexHome, f)}: our hooks or the ${SERVER_NAME} server already run in the Codex user layer - ` +
          "refusing to install a second copy, nothing written",
      );
    }
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
function projectRootMarkers(userCfgText: string | undefined): { markers: string[]; problem: string | null } {
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
/**
 * C5d (the ADR-0010 decision-1 shape on the Codex side): does an ANCESTOR of
 * this folder already run our hooks? Codex layers project folders by walking
 * from the seat up to the root, reading each .codex/ folder it finds
 * (config/src/loader/mod.rs, the comment near line 134), so a second hooks
 * file below an ancestor that runs our hooks would fire every hook twice.
 * Detection is by content, like the Claude scan - but since C5l (S1) by
 * EXACT content: a group deep-equal to one this installer writes for the
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
type AncestorScan = {
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

function findAncestorWithOurCodexHooks(dir: string, markers: string[]): AncestorScan {
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

/** The hooks.json container shapes we may merge into (F1 as in Claude). */
function checkCodexHooksContainers(cur: Json): void {
  if (cur.hooks !== undefined && !isJsonObject(cur.hooks)) {
    die(`${CODEX_HOOKS_REL}: hooks is not an object - refusing, nothing written`);
  }
  if (isJsonObject(cur.hooks)) {
    for (const [event, groups] of Object.entries(cur.hooks as Json)) {
      if (!Array.isArray(groups)) {
        die(`${CODEX_HOOKS_REL}: hooks.${event} is not an array - refusing, nothing written`);
      }
    }
  }
}

// --- C5c: user-layer hook trust (ADR-0016 decision 7) ------------------------
// Codex fires a project hook only when its current hash equals the
// [hooks.state."<key>"].trusted_hash recorded in the USER layer (state is
// read from user + session-flag layers only: hooks/src/config_rules.rs:8-35;
// exact string equality: discovery.rs:1000-1017; untrusted = silently
// skipped in exec). plugin/src/codex-trust.ts carries the key and hash
// recipe derived from Codex rust-v0.167.0 and cross-checked against hashes
// Codex itself wrote. Our tables live in OUR OWN delimited block in
// $CODEX_HOME/config.toml, separate from OpenRig's relay block; uninstall
// removes exactly them. The installer never grants PROJECT trust - it only
// checks and says plainly when the seat folder is not a trusted project
// (trusting a project enables all its project-local config, hooks and exec
// policies, wider than what this plugin was approved to touch).

// C5e: ONE managed trust block PER SEAT. Several Codex seats share one
// CODEX_HOME by default (a rig has several seats), so the markers name this
// seat's absolute path: each install finds, writes and removes only its own
// block, and other seats' blocks are foreign content it never touches.
const TRUST_MARK_BEGIN = "# BEGIN openrig-honcho hooks trust";
const TRUST_MARK_END = "# END openrig-honcho hooks trust";
const trustBeginFor = (seatDir: string): string =>
  `${TRUST_MARK_BEGIN} for ${seatDir} (managed - do not edit inside)`;
const trustEndFor = (seatDir: string): string => `${TRUST_MARK_END} for ${seatDir}`;
/** The pre-C5e markers (fe8ff04, eb9b8d9): no seat path. Recognised for
 * migration only - a legacy block belongs to the seat whose keys it holds. */
const LEGACY_TRUST_BEGIN = `${TRUST_MARK_BEGIN} (managed - do not edit inside)`;
const LEGACY_TRUST_END = TRUST_MARK_END;
/** True when a [hooks.state] key belongs to this exact seat: the key is
 * "{hooks.json abs}:{event}:{group}:{handler}", so the path part must match
 * in full - not merely as a string prefix of a nested seat's path. */
const keyIsOurs = (key: string, hooksJsonAbs: string): boolean => key.startsWith(`${hooksJsonAbs}:`);

/**
 * F10 (C5f): the seat folder as Codex will see it. Codex resolves the cwd
 * before deriving hook keys and looking up project trust, so a seat handed
 * in through a symlink would get trust keys in the link spelling that
 * nothing ever matches - four untrusted hooks and memory silently off,
 * while the installer printed trusted. realpath once, at the top; every
 * derived path below shares that one spelling. A not-yet-existing tail is
 * rebuilt under its resolved parent (the folder may be created at apply
 * time; F3 preflight judges writability).
 */
function realSeatDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realSeatDir(parent), basename(p));
  }
}

/**
 * F9 (C5f): is this seat inside a LINKED git worktree? Codex reads a linked
 * worktree's project layer from the same relative folder in the MAIN
 * CHECKOUT (config/src/loader/mod.rs:1148-1157), so hooks installed into
 * the worktree are never read - zero hooks for that cwd. The shape is the
 * first .git entry on the upward walk being a FILE whose gitdir points
 * inside a /.git/worktrees/ folder (submodule gitdirs point under modules/
 * and are not this case; a .git DIRECTORY is a regular checkout, fine).
 * Returns the main checkout folder Codex would read, or null. Same walk
 * projectTrustState stage 3 uses; no subprocess (X5).
 */
function linkedWorktreeRoot(seatDir: string): string | null {
  for (let cur = seatDir; ; ) {
    const git = join(cur, ".git");
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(git);
    } catch {
      /* no .git entry here: keep walking upward */
    }
    if (st !== null) {
      if (!st.isFile()) return null; // a .git directory: regular checkout
      let gitdir: string | null = null;
      try {
        const m = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
        if (m !== null) gitdir = m[1]!.trim();
      } catch {
        /* unreadable pointer: not decided here */
      }
      if (gitdir !== null) {
        const i = gitdir.lastIndexOf("/.git/worktrees/");
        if (i > 0) return gitdir.slice(0, i); // <main>/.git/worktrees/<name>
      }
      return null; // .git file but not the linked-worktree shape
    }
    const up = dirname(cur);
    if (up === cur) return null; // reached the root
    cur = up;
  }
}

/**
 * F17 (C5k, R11): which character in this path could the Codex hook SHELL
 * mis-run? Codex runs each hook command line through a shell
 * (hooks/src/engine/command_runner.rs:444-459), and our command embeds the
 * plugin and seat paths as double-quoted shell words: a folder named
 * 'pwn $(touch /tmp/MARKER)' EXECUTES at hook time, and a folder carrying
 * a double quote silently breaks every hook (the review R11 repro). The
 * status line the install prints has the same quoting and a human PASTES
 * it. Decision (architect, C5k): refuse the characters double quoting
 * cannot vouch for - single quote, double quote, dollar, backtick,
 * backslash, newline (CR counted with it) - rather than fight the shell
 * per feature. Returns the offending class name, or null when safe.
 *
 * S3 (C5l, security review): the seat path also lands inside a TOML basic
 * string of the user config (every trust key). TOML forbids raw C0
 * characters and DEL in strings and comments, so one such path lands there
 * the whole user config stops parsing for EVERY seat in that CODEX_HOME
 * (the review's DEL repro). Refuse them like the other classes; TAB stays
 * allowed (fine in both shells and in TOML strings).
 */
function shellUnsafePath(p: string): string | null {
  const classes: [string, string][] = [
    ["'", "single quote"],
    ['"', "double quote"],
    ["$", "dollar sign"],
    ["`", "backtick"],
    ["\\", "backslash"],
    ["\n", "newline"],
    ["\r", "carriage return"],
  ];
  for (const [ch, name] of classes) if (p.includes(ch)) return name;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c === 0x7f) return "DEL (0x7f)";
    if (c < 0x20 && c !== 0x09) return `control character 0x${c.toString(16).padStart(2, "0")}`;
  }
  return null;
}

/** $CODEX_HOME, default ~/.codex (same resolution as the dup scan). */
function codexUserHome(): string {
  const rawHome = (process.env.CODEX_HOME ?? "").trim();
  return rawHome !== "" ? resolve(rawHome) : join(process.env.HOME ?? "", ".codex");
}

interface TrustEntry {
  key: string;
  hash: string;
  event: string;
}

/** One [hooks.state."<key>"] trusted_hash table per handler we add; enabled
 * is left absent, which Codex reads as on (discovery.rs:1019-1021). The
 * markers name this seat (C5e), so the block is findable by its owner only. */
function buildTrustBlock(seatDir: string, entries: TrustEntry[]): string {
  const q = (s: string): string => JSON.stringify(s); // TOML basic string
  return `${[
    trustBeginFor(seatDir),
    ...entries.flatMap((e) => [`[hooks.state.${q(e.key)}]`, `trusted_hash = ${q(e.hash)}`]),
    trustEndFor(seatDir),
  ].join("\n")}\n`;
}

/**
 * Locate THIS seat's trust block (C5e). Its own markers first. Otherwise a
 * LEGACY (pre-C5e, path-less) block that holds at least one key of this
 * exact seat is adopted for migration: it is rewritten in the new form on
 * the next write, and uninstall strips it whole. A legacy block without this
 * seat's keys is another seat's - foreign content, never touched. Damage
 * refuses THIS seat only: an unbalanced pair of its own markers, a legacy
 * fragment holding its keys, two legacy blocks holding them, or a legacy
 * block surviving next to its new one.
 */
function locateTrustBlock(
  text: string,
  label: string,
  seatDir: string,
  hooksJsonAbs: string,
): { begin: number; end: number; legacy: boolean } | null {
  const lines = text.split("\n");
  const ownBegin = trustBeginFor(seatDir);
  const ownEnd = trustEndFor(seatDir);
  const nb = lines.map((l, i) => (l === ownBegin ? i : -1)).filter((i) => i >= 0);
  const ne = lines.map((l, i) => (l === ownEnd ? i : -1)).filter((i) => i >= 0);
  if (nb.length !== 0 || ne.length !== 0) {
    if (nb.length !== 1 || ne.length !== 1 || (ne[0] as number) <= (nb[0] as number)) {
      die(`${label}: our managed trust block for this seat has damaged markers - refusing, nothing written`);
    }
  }
  // legacy blocks and whether each holds a key of this exact seat
  const holdsOurs = (inner: string[]): boolean =>
    trustStateKeys(inner.join("\n")).some((k) => keyIsOurs(k, hooksJsonAbs));
  const legacyOurs: { begin: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== LEGACY_TRUST_BEGIN) continue;
    let j = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k] === LEGACY_TRUST_END) {
        j = k;
        break;
      }
      if (lines[k] === LEGACY_TRUST_BEGIN) break; // begins nest: damage below
    }
    if (j === -1) {
      // orphan (unpaired or BEGIN-before-BEGIN): ours only if our keys live in it
      if (holdsOurs(lines.slice(i + 1))) {
        die(
          `${label}: a damaged legacy trust block holds this seat's keys - refusing, nothing written; ` +
            "repair or remove the block by hand",
        );
      }
      continue; // another seat's damage is not this seat's business
    }
    if (holdsOurs(lines.slice(i + 1, j))) legacyOurs.push({ begin: i, end: j });
    i = j;
  }
  if (legacyOurs.length > 1) {
    die(`${label}: two legacy trust blocks hold this seat's keys - refusing, nothing written`);
  }
  if (legacyOurs.length === 1) {
    if (nb.length === 1) {
      die(
        `${label}: this seat has a legacy trust block AND its per-seat one - refusing, nothing written; ` +
          "remove one by hand",
      );
    }
    return { begin: (legacyOurs[0] as { begin: number }).begin, end: (legacyOurs[0] as { begin: number }).end, legacy: true };
  }
  if (nb.length === 1) return { begin: nb[0] as number, end: ne[0] as number, legacy: false };
  return null;
}

/** Keys of the [hooks.state.*] tables inside a text (block inner content). */
function trustStateKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/);
    if (m !== null) out.push(m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : (m[2] as string));
  }
  return out;
}

/**
 * The trusted_hash recorded OUTSIDE our block for one exact state key -
 * undefined when the entry is absent, null when a table for it exists
 * without a trusted_hash, else the recorded value. Both TOML quoting styles
 * count. This is what a Codex /hooks approval of our project's hooks would
 * have written, and what a stale or conflicting entry looks like.
 */
function outsideTrustHash(entry: string, outside: string): string | null | undefined {
  const esc = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^\\s*\\[\\s*hooks\\s*\\.\\s*state\\s*\\.\\s*("${esc}"|'${esc}')\\s*\\]\\s*(?:#.*)?$`);
  let found: string | null | undefined;
  let inTable = false;
  for (const line of outside.split("\n")) {
    if (headerRe.test(line)) {
      inTable = true;
      if (found === undefined) found = null;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inTable = false;
      continue;
    }
    if (!inTable || found !== null) continue;
    const m = line.match(/^\s*trusted_hash\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/);
    if (m !== null) {
      found = m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : (m[2] as string);
    }
  }
  return found;
}

/**
 * The keys and hashes Codex will compute for OUR handlers in the hooks file
 * as it will stand after this run (hooks/src/lib.rs:125-135: group and
 * handler indexes count EVERY group in the file, ours and foreign alike).
 * S1 (C5l, security review): a group is OURS only when it deep-equals one of
 * the groups we build in codexHookGroups(settingsAbs) for that event - never
 * by naming the plugin path somewhere inside it. A trusted_hash vouches for
 * EXACTLY its command string (the review's repro: a PreToolUse group
 * "touch /tmp/X # <PLUGIN_DIR>" carried our path in a comment and got
 * trusted). An installer must never vouch for a command it did not write.
 * Unknown events, foreign or edited groups get no entry; unknown handler
 * shapes are skipped (checkCodexHooksContainers has already refused
 * malformed ones).
 */
function computeTrustEntries(hooksObj: Json | undefined, hooksJsonAbs: string, wanted: Json): TrustEntry[] {
  const out: TrustEntry[] = [];
  if (hooksObj === undefined) return out;
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (codexEventLabel(event) === null) continue; // not a Codex event
    const ours = asArray(wanted[event]);
    if (ours === undefined) continue; // not an event we write groups for
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isJsonObject(group) || !ours.some((wg) => deepEqual(wg, group))) return;
      const matcher = typeof group.matcher === "string" ? group.matcher : null;
      if (!Array.isArray(group.hooks)) return;
      (group.hooks as unknown[]).forEach((h, handlerIndex) => {
        if (!isJsonObject(h) || h.type !== "command" || typeof h.command !== "string") return;
        out.push({
          key: codexHookKey(hooksJsonAbs, event, groupIndex, handlerIndex),
          hash: codexTrustedHash(event, matcher, {
            command: h.command,
            timeoutSec: codexNormalizedTimeout(event, typeof h.timeout === "number" ? h.timeout : undefined),
            async: h.async === true,
          }),
          event,
        });
      });
    });
  }
  return out;
}

/** The trusted [projects."<path>"] keys of a user config text
 * (protocol/src/config_types.rs:640-645: trust_level "trusted", lowercase). */
function trustedProjectKeys(userCfgText: string): Set<string> {
  const out = new Set<string>();
  let cur: string | null = null;
  let trustedCur = false;
  const close = (): void => {
    if (cur !== null && trustedCur) out.add(cur);
    cur = null;
    trustedCur = false;
  };
  for (const line of userCfgText.split("\n")) {
    const h = line.match(/^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/);
    if (/^\s*\[/.test(line)) {
      close();
      if (h !== null) cur = h[1] !== undefined ? (JSON.parse(`"${h[1]}"`) as string) : (h[2] as string);
      continue;
    }
    if (cur !== null && /^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/.test(line)) trustedCur = true;
  }
  close();
  return out;
}

/** project_root_markers (config/src/project_root_markers.rs:5): the default
 * is [".git"]; a set list replaces it, and an empty list means Codex treats
 * the cwd itself as the project root (our stage-1 lookup already covers
 * that, so the marker walk is skipped). */
function rootMarkers(userCfgText: string): string[] | null {
  const m = userCfgText.match(/^\s*project_root_markers\s*=\s*\[([^\]]*)\]/m);
  if (m === null) return [".git"];
  const items = [...m[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? (x[2] as string));
  return items.length > 0 ? items : null;
}

/**
 * Would Codex load this seat's project layer at all? Same lookup as
 * config/src/loader/mod.rs (decision_for_dir 1083-1126, construction
 * 1467-1484, per-dir check 1863-1882): a trusted entry for
 * [canonical(seat), seat], else for the project root (nearest ancestor with
 * a root marker) under both spellings, else for the git worktree root.
 */
function projectTrustState(seatDir: string, userCfgText: string | undefined): boolean {
  if (userCfgText === undefined) return false;
  const trusted = trustedProjectKeys(userCfgText);
  if (trusted.size === 0) return false;
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const hit = (p: string): boolean => trusted.has(p) || trusted.has(canonical(p));
  if (hit(seatDir)) return true;
  const markers = rootMarkers(userCfgText);
  if (markers !== null) {
    for (let cur = seatDir; ; ) {
      if (markers.some((mk) => existsSync(join(cur, mk)))) {
        if (hit(cur)) return true;
        break;
      }
      const up = dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  // stage 3 - the git worktree root: the nearest ancestor holding a .git
  // entry, a directory (normal checkout) or a file (linked worktree,
  // submodule). That is exactly what git rev-parse --show-toplevel reports
  // in both shapes (git-utils discovers by walking for .git), and it keeps
  // plugin/ subprocess-free (X5).
  for (let cur = seatDir; ; ) {
    if (existsSync(join(cur, ".git"))) {
      if (hit(cur)) return true;
      break;
    }
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

function mainCodex(args: Args): void {
  // F10 (C5f): one canonical spelling for everything derived below (F9's
  // walk and the ancestor scan included), because Codex matches on the
  // resolved path.
  const dir = realSeatDir(args.dir);
  const hooksPath = join(dir, CODEX_HOOKS_REL);
  const configPath = join(dir, CODEX_CONFIG_REL);
  const skillsPath = join(dir, CODEX_SKILLS_REL);
  const recordDir = join(dir, CODEX_RECORD_DIR_REL);
  const recordPath = join(dir, CODEX_INSTALL_JSON_REL);
  const settingsPath = join(dir, CODEX_SETTINGS_REL); // absolute: dir was resolved
  const backupsDir = join(dir, CODEX_BACKUPS_REL);
  const userConfigPath = join(codexUserHome(), "config.toml"); // C5c trust
  // S4 (C5l): the user config can hold other servers' tokens; its backups
  // stay inside CODEX_HOME, in a folder of ours (700) with 600 files -
  // never beside the seat's own files, which travel with the project.
  const userBackupsDir = join(codexUserHome(), "openrig-honcho", "backups");
  const what = args.uninstall ? "uninstall" : "install";

  if (!args.uninstall) validateFlags(args.flags);

  // F4: every target we may touch is refused as a symlink before it is read.
  for (const [p, label] of [
    [join(dir, ".codex"), ".codex"],
    [hooksPath, CODEX_HOOKS_REL],
    [configPath, CODEX_CONFIG_REL],
    [skillsPath, CODEX_SKILLS_REL],
    [recordDir, CODEX_RECORD_DIR_REL],
    [recordPath, CODEX_INSTALL_JSON_REL],
    [settingsPath, CODEX_SETTINGS_REL],
    [backupsDir, CODEX_BACKUPS_REL],
    [userConfigPath, "Codex user config"], // C5c: the one file outside the seat we may write
    [userBackupsDir, "Codex user backups folder"], // S4 (C5l): where its backups go
  ] as const) {
    refuseSymlink(p, label);
  }

  const record = loadCodexRecord(recordPath);
  if (args.uninstall && record === null) {
    console.log(`uninstall ${dir}: no openrig-honcho Codex install record; nothing to change`);
    return;
  }
  if (!args.uninstall) {
    // F17 (C5k) + S3 (C5l): no path this installer embeds in a shell-quoted
    // hook command (or prints for a human to paste, or writes into a TOML
    // string) may carry a character the double quoting and TOML strings
    // cannot vouch for - see shellUnsafePath. Refuse FIRST, before the plan
    // and BOTH locks, so zero writes and no trust line can ever vouch for a
    // command the shell would mis-run. Checked on the CANONICAL seat path
    // (realSeatDir above), so a link cannot smuggle an unsafe spelling in.
    // Uninstall stays allowed: removing traces embeds no shell line.
    // C5l: moved above the user-config read and its lock (S2) so the
    // refusal really is zero-write.
    for (const p of [dir, join(dir, CODEX_SETTINGS_REL), PLUGIN_DIR]) {
      const bad = shellUnsafePath(p);
      if (bad !== null) {
        die(
          `${p}: the path contains a ${bad}. Codex runs hook commands through a shell and this installer ` +
            `quotes the seat and plugin paths in double quotes only, so such a path could execute or ` +
            `silently break hooks (and the printed status line). Refusing, nothing written - move the ` +
            `seat or the plugin to a folder without that character`,
        );
      }
    }
    refuseCodexUserLayerDup();
    // project-layer leftovers from ANOTHER install are decided by the text
    // scans below (hooksCur / configText naming our bins from elsewhere).
  }

  const hooksCur = readTarget(hooksPath, CODEX_HOOKS_REL);
  if (hooksCur !== undefined) checkCodexHooksContainers(hooksCur);
  let configText: string | undefined;
  if (existsSync(configPath)) {
    try {
      configText = readFileSync(configPath, "utf8");
    } catch (e) {
      die(`${CODEX_CONFIG_REL}: cannot read (${(e as { code?: string }).code ?? "error"}) - refusing, nothing written`);
    }
  }
  const block = configText === undefined ? null : findCodexBlock(configText);
  // S2 (C5l): serialise the WHOLE user-layer window - this read, the plan
  // it feeds, and the rename that lands the plan (which re-reads first) -
  // against any other install pointed at the same CODEX_HOME. The lock is
  // taken before the first byte of the user config is read, held for the
  // process (exit-hook belt), and released explicitly in the apply's
  // finally. The seat's install.lock (taken later) keeps the seat's own
  // files safe; it never protected this shared file. DRY-RUN takes NO lock
  // and writes nothing (review D6 stays true): a lock file would itself be
  // a write, and a dry-run plan read under a momentary race is harmless.
  const userLock = args.dryRun ? null : takeUserConfigLock(what);
  // C5c: the user layer is the only place Codex reads hook trust from
  // (hooks/src/config_rules.rs:8-35), so it is read here in full; the only
  // thing we ever write into it is our own delimited trust block.
  let userCfgText: string | undefined;
  if (existsSync(userConfigPath)) {
    try {
      userCfgText = readFileSync(userConfigPath, "utf8");
    } catch (e) {
      die(`${userConfigPath}: cannot read (${(e as { code?: string }).code ?? "error"}) - refusing, nothing written`);
    }
  }
  const trustBlock =
    userCfgText === undefined ? null : locateTrustBlock(userCfgText, userConfigPath, dir, hooksPath);
  // F15 (C5g) / F16 (C5h): the nested-seat root rule uses the markers Codex
  // uses: project_root_markers from the USER layer (where the marker is set
  // in practice; Codex's managed and CLI layers are out of scope here),
  // default [".git"]. An EMPTY list disables root detection - no ancestor
  // ever loads, so no skip. A problem - the key holding a non-string-array
  // value, or the file not parsing as TOML at all - keeps .git AND is
  // printed, and in BOTH cases the sentence is true: Codex refuses the
  // whole config (review-c5g-z.py z1/z1b: a scalar or mixed array loads 0
  // hooks even at the ancestor's own cwd).
  const rootMarkers = projectRootMarkers(userCfgText);
  if (!args.uninstall && rootMarkers.problem !== null) {
    console.log(
      `warning: ${userConfigPath}: ${rootMarkers.problem} - Codex itself refuses the whole config ` +
        `(no hooks run); fix it there. This check keeps the .git default`,
    );
  }

  // No double hooks from another install in the PROJECT layer either: our bin
  // or server shape that is not OUR plugin path refuses (the record check has
  // already refused a record naming another plugin).
  if (!args.uninstall) {
    // (F17 + S3 path refusals moved above, ahead of both locks - see C5l.)
    // F9 (C5f): a linked-worktree seat can never run our hooks - Codex reads
    // that relative folder in the MAIN CHECKOUT instead. Refuse with zero
    // writes before the plan, so the trusted line can never vouch for a
    // seat Codex will not read; the message names the folder Codex reads.
    const worktreeRoot = linkedWorktreeRoot(dir);
    if (worktreeRoot !== null) {
      die(
        `${CODEX_HOOKS_REL}: this seat is inside a LINKED git worktree. Codex reads a linked worktree's ` +
          `project hooks from the same folder in the main checkout (${worktreeRoot}), so hooks installed ` +
          `here would never run. Install against ${worktreeRoot}, or a seat folder outside a linked ` +
          `worktree; this installer never writes into the main checkout. Refusing, nothing written`,
      );
    }
    if (hooksCur !== undefined && runsOurHooksText(JSON.stringify(hooksCur)) && !OUR_PATH_RE.test(JSON.stringify(hooksCur))) {
      die(`${CODEX_HOOKS_REL}: openrig-honcho hooks from a different plugin folder are installed - refusing, nothing written`);
    }
    if (configText !== undefined) {
      const out = outsideCodexBlock(configText, block);
      if (RIG_MEMORY_TABLE_RE.test(out)) {
        die(`${CODEX_CONFIG_REL}: ${SERVER_NAME} exists outside our managed block and is not ours - refusing, nothing written`);
      }
      if (runsOurHooksText(out)) {
        die(`${CODEX_CONFIG_REL}: openrig-honcho hooks or server from a different plugin folder are installed - refusing, nothing written`);
      }
      if (block !== null) {
        const inner = configText.split("\n").slice(block.begin, block.end + 1).join("\n");
        if (!OUR_PATH_RE.test(inner)) {
          die(`${CODEX_CONFIG_REL}: the managed block exists but is not ours - refusing, nothing written`);
        }
      }
    }
  }

  // C5d (the ADR-0010 shape): read-only ancestor scan - install direction
  // only; uninstall never walks ancestors. C5l3 (fix 3): a PARTIAL ancestor
  // (some of our groups, not all) refuses the install with zero writes -
  // skipping would turn off the events it dropped, installing would fire
  // the events it holds twice. It lands before the plan and every temp;
  // the user-config lock held here is released by its own exit belt.
  const ancestorScan: AncestorScan = args.uninstall
    ? { skip: null, partial: null }
    : findAncestorWithOurCodexHooks(dir, rootMarkers.markers);
  if (ancestorScan.partial !== null) {
    const p = ancestorScan.partial;
    die(
      `${p.dir}: runs SOME of our hooks (${p.held.join(", ")}) but not all (missing ${p.missing.join(", ")}) ` +
        `- skipping would leave this seat without ${p.missing.join(", ")} and installing would fire ` +
        `${p.held.join(", ")} twice - refusing, nothing written; complete or remove our groups in that ` +
        `ancestor's ${CODEX_HOOKS_REL}`,
    );
  }
  const ancestorHooksDir = ancestorScan.skip;

  const lines: string[] = [];

  // --- the plan -------------------------------------------------------------
  let settingsNext: string | null = null;
  let hooksNext: Json | null = null;
  let hooksRemoved = false;
  let configNext: string | null = null; // full new file text
  let configRemoved = false; // uninstall: remove the file
  let userConfigNext: string | null = null; // C5c: user config full new text
  let userConfigRemoved = false; // uninstall: we created it and it is empty
  const nextRecord: CodexRecord = {
    version: 2,
    plugin: PLUGIN_DIR,
    harness: "codex",
    hooksCreated: record?.hooksCreated ?? false,
    hooksEvents: [...(record?.hooksEvents ?? [])],
    configCreated: record?.configCreated ?? false,
    configSep: record?.configSep ?? false,
    configBlockAdded: record?.configBlockAdded ?? false,
    skillsAdded: record?.skillsAdded ?? false,
    trustBlockAdded: record?.trustBlockAdded ?? false,
    trustKeys: [...(record?.trustKeys ?? [])].sort(),
    trustSep: record?.trustSep ?? false,
    userConfigCreated: record?.userConfigCreated ?? false,
  };

  // O3 item 3 (ADR-0017) as corrected by F-E (R15 Part 2): ONLY the holdout
  // carries across a reinstall. Carrying every key meant a reinstall that
  // DROPPED --leader kept leadership (a revocation printed nothing and
  // revoked nothing). The holdout is the one carry because it is a
  // measurement stance: it must not flip because of a routine reinstall.
  // Every other key behaves exactly as at 11fc779: flags set it, omitting a
  // flag drops it. This file is still ours alone (an unrecorded one is
  // refused); foreign hand-added spellings stay outside our rewrite.
  const carried: Record<string, string> = {};
  // O7 N4 (second security pass): the carried value must survive loadConfig's
  // OWN 0..0.9 rule (env.ts, identical regex and bounds) or it is dropped -
  // a hand-edited or corrupted setting used to ride along AND be printed
  // raw, ANSI escapes included. What is kept and printed is the PARSED
  // number, never the stored string.
  let carryInvalid = false;
  if (record !== null && existsSync(settingsPath)) {
    try {
      const prev: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (prev !== null && typeof prev === "object" && !Array.isArray(prev)) {
        const hold = (prev as Record<string, unknown>)["HONCHO_RECALL_HOLDOUT"];
        if (typeof hold === "string" && hold !== "") {
          const raw = hold.trim();
          if (/^\d+(?:\.\d+)?$/.test(raw) && Number(raw) >= 0 && Number(raw) <= 0.9) {
            carried["HONCHO_RECALL_HOLDOUT"] = String(Number(raw));
          } else {
            carryInvalid = true;
          }
        }
      }
    } catch {
      // unreadable or not JSON: ours, replaced from the flags as before
    }
  }
  const flagSettings = Object.fromEntries(args.flags);
  const settingsObj = { ...carried, ...flagSettings };
  if (!("HONCHO_RECALL_HOLDOUT" in flagSettings)) {
    if (carried["HONCHO_RECALL_HOLDOUT"] !== undefined) {
      lines.push(
        `holdout kept across reinstall: ${carried["HONCHO_RECALL_HOLDOUT"]} (pass --recall-holdout to change it)`,
      );
    } else if (carryInvalid) {
      lines.push("holdout dropped (invalid)");
    }
  }
  const settingsContent = `${JSON.stringify(Object.fromEntries(Object.entries(settingsObj).sort()), null, 2)}\n`;
  let skipLineAt = -1; // C5d: index of the ancestor-skip line, if any

  if (args.uninstall) {
    // remove exactly the record's traces; foreign content byte-identical
    // C5d: an install that skipped hooks added none here, so uninstall
    // removes none - and it never walks or writes ancestors either (the
    // ancestor's hooks file is a different seat's own trace).
    // S1 (C5l): "ours" here is EXACT equality with a group this installer
    // writes (same settings path), not a path mention: foreign groups that
    // merely NAME our plugin folder are owner content and stay.
    const ourGroups = codexHookGroups(settingsPath);
    const isOurCodexGroup = (event: string, g: unknown): boolean =>
      (asArray(ourGroups[event]) ?? []).some((wg) => deepEqual(wg, g));
    if (hooksCur !== undefined && record.hooksSkipped === undefined) {
      const stripped = structuredClone(hooksCur) as Json;
      let touched = false;
      if (isJsonObject(stripped.hooks)) {
        const hooks = stripped.hooks as Json;
        for (const event of Object.keys(hooks)) {
          const arr = asArray(hooks[event]);
          if (arr === undefined) continue;
          const kept = arr.filter((g) => !isOurCodexGroup(event, g));
          if (kept.length !== arr.length) {
            hooks[event] = kept; // empty arrays stay (container rule)
            touched = true;
            lines.push(`hooks.json: removed our groups from ${event}`);
          }
        }
      }
      const empty =
        isJsonObject(stripped.hooks) &&
        Object.values(stripped.hooks as Json).every((v) => Array.isArray(v) && v.length === 0);
      const onlyHooks = Object.keys(stripped).every((k) => k === "hooks" || k === "description");
      if (touched && record.hooksCreated && empty && onlyHooks) {
        hooksRemoved = true; // we created it and nothing foreign is left
        lines.push("hooks.json: remove (this install created it)");
      } else if (touched) {
        hooksNext = stripped;
      }
    }
    if (configText !== undefined && block !== null) {
      const keptLines = configText.split("\n").filter((_, i) => i < block.begin || i > block.end);
      let text = keptLines.join("\n");
      // undo our separator newline ONLY when the block still ran to EOF; if
      // the owner wrote content after it, that newline is theirs now
      const blockAtEof = configText.split("\n").slice(block.end + 1).every((l) => l.trim() === "");
      if (record.configSep && blockAtEof && text.endsWith("\n")) text = text.slice(0, -1);
      if (record.configCreated && text.trim() === "") {
        configRemoved = true;
        lines.push("config.toml: remove (this install created it)");
      } else {
        configNext = text;
        lines.push("config.toml: removed our managed block (everything outside it untouched)");
      }
    }
    // C5c: remove our trust block from the user layer; everything written
    // outside it (OpenRig's own block, the owner's tables) stays untouched.
    if (record.trustBlockAdded || record.userConfigCreated || record.trustKeys.length > 0) {
      if (userCfgText === undefined) {
        lines.push("trust: the Codex user config is absent; nothing to remove there");
      } else if (trustBlock === null) {
        if (record.userConfigCreated && userCfgText.trim() === "") {
          userConfigRemoved = true;
          lines.push(`trust: remove ${userConfigPath} (this install created it and it holds nothing now)`);
        } else {
          lines.push("trust: our managed trust block is not in the Codex user config (already removed?)");
        }
      } else {
        const keptLines = userCfgText.split("\n").filter((_, i) => i < trustBlock.begin || i > trustBlock.end);
        let text = keptLines.join("\n");
        const blockAtEof = userCfgText.split("\n").slice(trustBlock.end + 1).every((l) => l.trim() === "");
        if (record.trustSep && blockAtEof && text.endsWith("\n")) text = text.slice(0, -1);
        if (record.userConfigCreated && text.trim() === "") {
          userConfigRemoved = true;
          lines.push(`trust: remove ${userConfigPath} (this install created it)`);
        } else {
          userConfigNext = text;
          lines.push(
            "trust: removed our managed trust block from the Codex user config (everything outside it untouched)",
          );
        }
      }
    }
    if (existsSync(settingsPath)) {
      lines.push(`${CODEX_SETTINGS_REL}: remove (our settings file)`);
    }
    if (record.skillsAdded && existsSync(skillsPath)) {
      lines.push(`skills: remove ${CODEX_SKILLS_REL} (the folder is ours)`);
    }
    lines.push(`record: remove ${CODEX_INSTALL_JSON_REL} (backups/ and .gitignore stay)`);
  } else {
    // install / reinstall
    if (existsSync(settingsPath) && record === null) {
      die(`${CODEX_SETTINGS_REL}: exists without our install record - refusing to overwrite a file we did not set, nothing written`);
    }
    if (!existsSync(settingsPath) || readFileSync(settingsPath, "utf8") !== settingsContent) {
      settingsNext = settingsContent;
      const keysOut = Object.entries(settingsObj).sort().map(([k]) => k);
      lines.push(`settings.json: ${keysOut.length > 0 ? `keys ${keysOut.join(", ")} (names only - no values echoed)` : "write (empty)"}`);
    }
    // --- hooks (C5d: or the deliberate skip of them) ------------------------
    if (ancestorHooksDir !== null) {
      // The ancestor already runs our hooks for seats opened in this folder
      // (Codex layers project folders from the seat upward), so writing ours
      // here would fire every hook twice. Install everything except hooks;
      // if an earlier install of ours put hooks here, remove them in place
      // (foreign groups keep their order). The ancestor's files are never
      // written.
      skipLineAt = lines.length;
      lines.push(`hooks: skipped, ${ancestorHooksDir} already runs them for this folder`);
      if (hooksCur !== undefined && isJsonObject(hooksCur.hooks)) {
        // S1 (C5l): only EXACT groups of ours are removed here too - a
        // foreign group naming our path stays (see the uninstall branch).
        const ourGroups = codexHookGroups(settingsPath);
        const stripped = structuredClone(hooksCur) as Json;
        const hooks = stripped.hooks as Json;
        let touched = false;
        for (const event of Object.keys(hooks)) {
          const arr = asArray(hooks[event]);
          if (arr === undefined) continue;
          const ours = asArray(ourGroups[event]) ?? [];
          const kept = arr.filter((g) => !ours.some((wg) => deepEqual(wg, g)));
          if (kept.length !== arr.length) {
            hooks[event] = kept; // empty arrays stay (container rule)
            touched = true;
            lines.push(`hooks.json: removed our groups from ${event} (an ancestor runs the hooks)`);
          }
        }
        if (touched) hooksNext = stripped;
      }
      // This seat owns no hooks: the record says so and names the ancestor,
      // so uninstall leaves hooks alone and never looks upward.
      nextRecord.hooksCreated = false;
      nextRecord.hooksEvents = [];
      nextRecord.hooksSkipped = ancestorHooksDir;
    } else {
      const wanted = codexHookGroups(settingsPath);
      if (hooksCur === undefined) nextRecord.hooksCreated = true;
      const hooksTarget = structuredClone(hooksCur ?? {}) as Json;
      const hooksObj = (hooksTarget.hooks ?? {}) as Json;
      const addedEvents: string[] = [];
      for (const [event, groups] of Object.entries(wanted)) {
        const existing = asArray(hooksObj[event]) ?? [];
        const ours = structuredClone(groups) as unknown[];
        // S1 (C5l): the replacement position and the duplicate sweep are
        // decided by EXACT equality with our groups, never by a path
        // mention - an owner-EDITED copy of our group is foreign content
        // now (we keep it, Codex leaves it untrusted, and our fresh group
        // joins after it). Reinstall never silently overwrites an edit.
        const isOurs = (g: unknown): boolean => (groups as unknown[]).some((wg) => deepEqual(wg, g));
        const firstOurs = existing.findIndex(isOurs);
        let nextGroups: unknown[];
        if (firstOurs === -1) {
          nextGroups = [...existing, ...ours];
        } else {
          nextGroups = [
            ...existing.slice(0, firstOurs),
            ...ours,
            ...existing.filter((g, i) => i > firstOurs && !isOurs(g)),
          ];
        }
        if (!deepEqual(existing, nextGroups)) {
          hooksObj[event] = nextGroups;
          addedEvents.push(event);
        }
      }
      if (addedEvents.length > 0) {
        hooksTarget.hooks = hooksObj;
        hooksNext = hooksTarget;
        lines.push(`hooks.json: our groups for ${addedEvents.join(", ")}`);
        for (const ev of addedEvents) if (!nextRecord.hooksEvents.includes(ev)) nextRecord.hooksEvents.push(ev);
        nextRecord.hooksEvents.sort();
      }
    }
    const blockText = codexMcpBlock(settingsPath);
    if (configText === undefined) {
      configNext = blockText;
      nextRecord.configCreated = true;
      nextRecord.configBlockAdded = true;
      nextRecord.configSep = false;
      lines.push(`config.toml: create with our managed ${SERVER_NAME} block`);
    } else if (block === null) {
      const sep = !configText.endsWith("\n");
      configNext = configText + (sep ? "\n" : "") + blockText;
      nextRecord.configBlockAdded = true;
      nextRecord.configSep = sep;
      lines.push(`config.toml: append our managed ${SERVER_NAME} block (nothing outside it changes)`);
    } else {
      const inner = `${configText.split("\n").slice(block.begin, block.end + 1).join("\n")}\n`;
      if (inner !== blockText) {
        // keep every line outside the block exactly; the trailing "" element
        // (when the file ends with a newline) is preserved by the filter, so
        // the join restores the file's exact trailing-newline state
        const keptLines = configText.split("\n").filter((_, i) => i < block.begin || i > block.end);
        keptLines.splice(block.begin, 0, ...blockText.replace(/\n$/, "").split("\n"));
        configNext = keptLines.join("\n");
        lines.push(`config.toml: refreshed our managed ${SERVER_NAME} block in place`);
      }
    }
    if (skillsDiffer(skillsPath)) {
      lines.push("skills: copy skills/rig-memory/ to .agents/skills/ (the folder is ours)");
      nextRecord.skillsAdded = true;
    }
    // --- C5c: trust for exactly our handlers, in the user layer ------------
    // C5d: a skipped install writes no hooks, so it records no trust - and
    // it stays out of the shared user block entirely (the ancestor's keys
    // live there and are not this seat's to reconcile).
    if (ancestorHooksDir === null) {
      const hooksFinal = (hooksNext ?? hooksCur ?? {}) as Json;
      const entries = computeTrustEntries(
        isJsonObject(hooksFinal.hooks) ? (hooksFinal.hooks as Json) : undefined,
        hooksPath, // the seat's own hooks.json, absolute (cwd spelling stable)
        codexHookGroups(settingsPath), // S1 (C5l): only these exact groups are ours
      );
      const outside =
        userCfgText === undefined
          ? ""
          : trustBlock === null
            ? userCfgText
            : [
                ...userCfgText.split("\n").slice(0, trustBlock.begin),
                ...userCfgText.split("\n").slice(trustBlock.end + 1),
              ].join("\n");
      const desired: TrustEntry[] = [];
      for (const e of entries) {
        const found = outsideTrustHash(e.key, outside);
        if (found === e.hash) {
          lines.push(`trust: ${e.event} already trusted in the user layer outside our block, same hash (left as is)`);
          continue;
        }
        if (found === null) {
          die(
            `${userConfigPath}: a [hooks.state] table for our ${e.event} hook exists outside our trust block ` +
              "without a trusted_hash - refusing, nothing written",
          );
        }
        if (found !== undefined) {
          die(
            `${userConfigPath}: our ${e.event} hook is already trusted there with a different hash, outside our ` +
              "managed trust block - trust it once in Codex (/hooks) or remove that entry; refusing, nothing written",
          );
        }
        desired.push(e);
      }
      const trustText = buildTrustBlock(dir, desired);
      nextRecord.trustKeys = desired.map((e) => e.key).sort();
      if (userCfgText === undefined && desired.length > 0) {
        userConfigNext = trustText;
        nextRecord.userConfigCreated = true;
        nextRecord.trustBlockAdded = true;
        nextRecord.trustSep = false;
        lines.push(`trust: create ${userConfigPath} with our managed trust block (${desired.length} keys)`);
      } else if (userCfgText !== undefined && trustBlock === null && desired.length > 0) {
        const sep = !userCfgText.endsWith("\n");
        userConfigNext = userCfgText + (sep ? "\n" : "") + trustText;
        nextRecord.trustBlockAdded = true;
        nextRecord.trustSep = sep;
        lines.push(
          `trust: append our managed trust block (${desired.length} keys) to ${userConfigPath}; nothing outside it changes`,
        );
      } else if (trustBlock !== null) {
        const inner = userCfgText!.split("\n").slice(trustBlock.begin, trustBlock.end + 1);
        const known = new Set([...desired.map((e) => e.key), ...(record?.trustKeys ?? [])]);
        const foreign = trustStateKeys(inner.join("\n")).filter((k) => !known.has(k));
        if (foreign.length > 0) {
          die(
            `${userConfigPath}: our managed trust block contains [hooks.state] keys we did not write - ` +
              "refusing, nothing written",
          );
        }
        nextRecord.trustBlockAdded = true;
        if (`${inner.join("\n")}\n` !== trustText) {
          const keptLines = userCfgText!.split("\n").filter((_, i) => i < trustBlock.begin || i > trustBlock.end);
          keptLines.splice(trustBlock.begin, 0, ...trustText.replace(/\n$/, "").split("\n"));
          userConfigNext = keptLines.join("\n");
          lines.push(
            trustBlock.legacy
              ? `trust: rewrote the legacy (path-less) trust block holding this seat's keys into its per-seat form (${desired.length} keys)`
              : `trust: refreshed our managed trust block in place (${desired.length} keys)`,
          );
        }
      }
    }
  }

  const recordChanged = args.uninstall ? record !== null : record === null || !deepEqual(nextRecord, record);
  if (!args.uninstall && recordChanged) {
    lines.push(
      `record: install.json (hooksCreated: ${nextRecord.hooksCreated}; configBlockAdded: ${nextRecord.configBlockAdded}; skillsAdded: ${nextRecord.skillsAdded}` +
        `${ancestorHooksDir !== null ? `; hooksSkipped: ${ancestorHooksDir}` : ""})`,
    );
  }
  if (skipLineAt >= 0 && !recordChanged && lines.length === 1) {
    // a pure no-op re-run of a skipped install: the skip line alone would
    // hide the standard "nothing to change (already installed)" verdict
    lines.length = 0;
  }

  // C5d: name the user layer this run reads and may write, every mode. An
  // unset CODEX_HOME silently defaults to ~/.codex; that must be visible at
  // once (real incident 2026-11-09: a proof script without the export wrote
  // the trust block into the owner's own user config before anyone looked).
  console.log(
    `[${args.dryRun ? "dry-run" : what}] user config: ${userConfigPath}` +
      ((process.env.CODEX_HOME ?? "").trim() === "" ? " (CODEX_HOME unset - the ~/.codex default)" : ""),
  );

  // C5c: CHECK project trust and say it plainly (never grant it - trusting a
  // project enables ALL its project-local config, hooks and exec policies;
  // that is seat setup, the operator's call). One line, names the missing
  // entry, echoes no values.
  if (!args.uninstall) {
    const trusted = projectTrustState(dir, userCfgText);
    console.log(
      `[${args.dryRun ? "dry-run" : what}] project trust: ${
        trusted
          ? "trusted - Codex loads this seat's project layer"
          : `NOT trusted - add [projects."${dir}"] trust_level = "trusted" to ${userConfigPath} ` +
            "(seat setup; this installer never grants project trust)"
      }`,
    );
  }

  // C5j (L1 finding): a Codex seat's config lives ONLY in its settings
  // file, so a bare status reads no config and prints memory: DISABLED.
  // Print the exact status command for THIS seat, every install mode.
  if (!args.uninstall) {
    console.log(
      `[${args.dryRun ? "dry-run" : what}] status: bun run "${join(PLUGIN_DIR, "bin", "status.ts")}" ` +
        `--harness codex --settings "${settingsPath}"`,
    );
  }

  if (lines.length === 0) {
    console.log(`${what} ${dir}: nothing to change (already ${args.uninstall ? "clean" : "installed"})`);
    return;
  }
  for (const l of lines) console.log(`[${args.dryRun ? "dry-run" : what}] ${l}`);
  if (args.dryRun) {
    console.log("[dry-run] no files written, no backups taken");
    return; // dry-run takes no lock and writes nothing (review D6)
  }

  const lock = takeInstallLock(recordDir, what);

  // F4: the same sweep as the Claude path; the user layer is a target too -
  // that CODEX_HOME is where a killed run left config.toml.tmp-* holding the
  // owner's merged config. One line, names only, only when names were removed.
  const swept = sweepStaleTemps([settingsPath, hooksPath, configPath, userConfigPath, recordPath]);
  if (swept.length > 0) console.log(`${what}: swept ${swept.length} stale temp file(s): ${swept.join(", ")}`);

  // F3 preflight: every write this run makes must be possible now.
  if (hooksNext !== null || hooksRemoved) {
    ensureDirWritable(join(dir, ".codex"), CODEX_HOOKS_REL);
    if (existsSync(hooksPath)) ensureFileWritable(hooksPath, CODEX_HOOKS_REL);
  }
  if (configNext !== null || configRemoved) {
    ensureDirWritable(join(dir, ".codex"), CODEX_CONFIG_REL);
    if (existsSync(configPath)) ensureFileWritable(configPath, CODEX_CONFIG_REL);
  }
  if (!args.uninstall) ensureDirWritable(join(dir, ".agents", "skills"), CODEX_SKILLS_REL);
  if (settingsNext !== null && existsSync(settingsPath)) ensureFileWritable(settingsPath, CODEX_SETTINGS_REL);
  ensureDirWritable(recordDir, CODEX_INSTALL_JSON_REL);
  if (existsSync(recordPath)) ensureFileWritable(recordPath, CODEX_INSTALL_JSON_REL);
  ensureDirWritable(backupsDir, CODEX_BACKUPS_REL);
  if (userConfigNext !== null || userConfigRemoved) {
    ensureDirWritable(codexUserHome(), "Codex user config");
    if (existsSync(userConfigPath)) ensureFileWritable(userConfigPath, "Codex user config");
  }
  if (userConfigNext !== null) {
    // S4 (C5l): the destination folder of the user-config backup exists
    // before any temp is written, so a refusal here really is zero-write.
    ensureBackupsDir700(userBackupsDir);
  }

  // staged apply, same shape as the Claude path: temps first, then backups,
  // then renames (record BEFORE the seat's files, ruling (c)), then copies.
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backups: string[] = [];
  // S4 (C5l): a backup is never written or chmodded through a symlink.
  // uniqueBackupCopy's existsSync CANNOT see a dangling symlink, so lstat
  // the chosen name before copying and refuse (not silently re-pick), and
  // look again before the chmod would follow a swapped link.
  const safeCopy = (src: string, toDir: string, name: string): string => {
    const copy = uniqueBackupCopy(toDir, name);
    refuseSymlink(copy, "backup copy");
    cpSync(src, copy);
    refuseSymlink(copy, "backup copy");
    chmodSync(copy, 0o600);
    return copy;
  };
  const backup = (path: string): void => {
    if (!existsSync(path)) return;
    const copy = safeCopy(path, backupsDir, `${basename(path)}.${stamp}`);
    backups.push(basename(copy));
    console.log(`backup: ${basename(copy)} (mode 600)`);
  };
  // S4 (C5l): the user config can carry other servers' tokens - its copies
  // stay in CODEX_HOME (700 folder, 600 files), never in the seat folder.
  const backupUser = (path: string): void => {
    if (!existsSync(path)) return;
    ensureBackupsDir700(userBackupsDir);
    const copy = safeCopy(path, userBackupsDir, `${basename(path)}.${stamp}`);
    backups.push(basename(copy));
    console.log(`backup: ${basename(copy)} (mode 600)`);
  };

  const targets: { label: string; path: string; tmp: string }[] = [];
  const done: string[] = [];
  let recordTmp: string | null = null;
  let settingsTmp: string | null = null;
  const dropTemps = (): void => {
    for (const p of [recordTmp, settingsTmp]) {
      if (p !== null) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
    for (const t of targets) {
      try {
        rmSync(t.tmp, { force: true });
      } catch {
        /* the temp file may already be gone */
      }
    }
  };
  // F20 (C5l3): a refusal reached INSIDE the staged apply (refuseSymlink in
  // safeCopy, or any die()) ends the process directly - the catch below
  // never runs, so until now every temp survived: config.toml.tmp-* in
  // CODEX_HOME holding the MERGED user config (owner lines + our block,
  // mode 600), plus the seat's own temps, invisible to later installs and
  // to --uninstall. The same exit belt the two locks use covers every
  // die()/process.exit path; it does NOT cover SIGKILL - a kill -9
  // mid-apply still leaves a temp; the F4 sweep after the lock (ADR-0018)
  // removes it on the next install or uninstall once its pid is dead.
  let beltOn = false;
  const armTempBelt = (): void => {
    if (!beltOn) {
      process.on("exit", dropTemps);
      beltOn = true;
    }
  };
  const disarmTempBelt = (): void => {
    if (beltOn) {
      process.off("exit", dropTemps);
      beltOn = false;
    }
  };
  try {
    armTempBelt(); // before the first temp can exist; no-op if there are none
    ensureOurDir700(recordDir); // F4: ours means 700, wider pre-existing gets tightened
    ensureOurDir700(backupsDir);
    const gitignore = join(recordDir, ".gitignore");
    if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");

    if (settingsNext !== null) {
      settingsTmp = writeTemp(settingsPath, settingsNext, 0o600); // recordDir exists (above)
    }
    if (hooksNext !== null) {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      const keepMode = existsSync(hooksPath) ? statSync(hooksPath).mode & 0o777 : 0o644;
      const content = `${JSON.stringify(hooksNext, null, detectIndent(hooksPath))}\n`;
      targets.push({ label: CODEX_HOOKS_REL, path: hooksPath, tmp: writeTemp(hooksPath, content, keepMode) });
    }
    if (configNext !== null) {
      mkdirSync(join(dir, ".codex"), { recursive: true });
      const keepMode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o644;
      targets.push({ label: CODEX_CONFIG_REL, path: configPath, tmp: writeTemp(configPath, configNext, keepMode) });
    }
    if (userConfigNext !== null) {
      // C5c: the user layer joins the SAME staged apply - temp, dated
      // backup, then rename. S4 (C5l): the backup goes to our CODEX_HOME
      // folder (backupUser), not beside the seat's files.
      mkdirSync(codexUserHome(), { recursive: true });
      const keepMode = existsSync(userConfigPath) ? statSync(userConfigPath).mode & 0o777 : 0o600;
      targets.push({
        label: "Codex user config",
        path: userConfigPath,
        tmp: writeTemp(userConfigPath, userConfigNext, keepMode),
      });
    }
    if (recordChanged && !args.uninstall) {
      recordTmp = writeTemp(recordPath, `${JSON.stringify(nextRecord, null, 2)}\n`, 0o600);
    }

    // S2 (C5l): the last check before ANYTHING is renamed or backed up -
    // the user config must still hold exactly the bytes we read under the
    // lock at the top of this run. The lock serialises cooperating
    // installers; this re-read catches every OTHER writer (Codex itself,
    // an owner edit, a foreign tool) and aborts while the only files this
    // run has created are the temps, which the abort drops.
    // HONCHO_USERCFG_SEAM_MS (test-only, like HONCHO_INSTALL_SEAM_MS) opens
    // the read-to-rename window deterministically and marks it.
    if (userConfigNext !== null || userConfigRemoved) {
      const rawSeam = (process.env.HONCHO_USERCFG_SEAM_MS ?? "").trim();
      const seamMs =
        /^\d{1,5}$/.test(rawSeam) && Number(rawSeam) >= 1 && Number(rawSeam) <= 10_000 ? Number(rawSeam) : 0;
      if (seamMs > 0) {
        try {
          mkdirSync(recordDir, { recursive: true });
          writeFileSync(join(recordDir, `install.seamucfg.${process.pid}`), `${process.pid}\n`);
        } catch {
          /* the marker is best effort; the pause is the point */
        }
        nap(seamMs);
      }
      let now: string | undefined;
      if (existsSync(userConfigPath)) {
        try {
          now = readFileSync(userConfigPath, "utf8");
        } catch (e) {
          dropTemps();
          die(
            `${userConfigPath}: cannot be re-read before the rename (${(e as { code?: string }).code ?? "error"}) ` +
              `- refusing, nothing renamed`,
          );
        }
      }
      if (now !== userCfgText) {
        dropTemps();
        die(
          `${userConfigPath}: changed while this ${what} was planned (another writer or an owner edit landed ` +
            `between our read and our rename) - refusing, nothing renamed; rerun the ${what}`,
        );
      }
    }

    for (const t of targets) {
      // S4 (C5l): the user config's copy goes to CODEX_HOME, not the seat.
      if (t.label === "Codex user config") backupUser(t.path);
      else backup(t.path);
    }
    if (settingsTmp !== null) backup(settingsPath);
    if (recordTmp !== null) {
      renameSync(recordTmp, recordPath); // record BEFORE the seat's files
      recordTmp = null;
      done.push(CODEX_INSTALL_JSON_REL);
    }
    if (settingsTmp !== null) {
      renameSync(settingsTmp, settingsPath);
      settingsTmp = null;
      done.push(CODEX_SETTINGS_REL);
    }
    for (const t of targets) {
      renameSync(t.tmp, t.path);
      done.push(t.label);
    }
    disarmTempBelt(); // every temp has become its real file; nothing left to drop
    if (hooksRemoved) {
      rmSync(hooksPath, { force: true });
      done.push(`removed ${CODEX_HOOKS_REL}`);
    }
    if (configRemoved) {
      // F8 (C5d): a file this install created can carry owner content by
      // uninstall time - bytes typed INSIDE our managed block leave with the
      // block when the file goes, so a copy lands in backups/ first.
      backup(configPath);
      rmSync(configPath, { force: true });
      done.push(`removed ${CODEX_CONFIG_REL}`);
    }
    if (userConfigRemoved) {
      // no backup: we created this file and it holds nothing but our own
      // block by the time this branch runs (owner content would have gone
      // through userConfigNext with a backup instead)
      rmSync(userConfigPath, { force: true });
      done.push(`removed ${userConfigPath}`);
    }
    if (!args.uninstall && skillsDiffer(skillsPath)) {
      mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
      rmSync(skillsPath, { recursive: true, force: true });
      cpSync(join(PLUGIN_DIR, "skills", "rig-memory"), skillsPath, { recursive: true });
      done.push(CODEX_SKILLS_REL);
    }
    if (args.uninstall) {
      // settings goes even when only settings existed - the record owns it.
      // It is the one removed file holding owner-supplied values, so it gets
      // a copy in backups/ first (mechanical files are rebuilt from flags).
      backup(settingsPath);
      rmSync(settingsPath, { force: true });
      if (record.skillsAdded) rmSync(skillsPath, { recursive: true, force: true });
      done.push(`removed ${CODEX_SETTINGS_REL}`);
      // the record goes LAST; backups/ and .gitignore stay
      rmSync(recordPath, { force: true });
      done.push(`removed ${CODEX_INSTALL_JSON_REL}`);
    }
  } catch {
    dropTemps();
    disarmTempBelt(); // the drop ran here; the belt need not repeat it
    die(`partial: ${done.join(", ") || "none"}; backups: ${backups.join(", ") || "none"}`);
  } finally {
    lock.release(); // C5l2: owned, exactly like the user-config lock below
    if (userLock !== null) {
      // S2 (C5l): owned release (removes only OUR bytes); the exit-hook
      // belt repeats it for every die() path, harmlessly if already ours.
      userLock.release();
    }
  }
  console.log(`${what} ${dir}: done`);
}

if (import.meta.main) {
  main();
}
