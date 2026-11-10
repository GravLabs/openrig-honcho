// C5l (independent security review of v0.4.0): four installer fixes, each
// pinned by a test that FAILS on the released code and passes after the fix.
//   S1 (HIGH)  trust is granted, removed and skipped on EXACT equality with
//              what codexHookGroups() writes - never on a path substring;
//              a planted PreToolUse group "touch MARKER # <PLUGIN_DIR>"
//              must get no trusted_hash and must never run.
//   S3 (MED)   C0 control characters (except tab) and DEL are refused in
//              every embedded path like the other shell-unsafe classes: the
//              TOML comment lines would otherwise break the whole user
//              config for every seat in that CODEX_HOME.
//   S4 (LOW)   backups of the USER config (which can hold other servers'
//              tokens) land inside CODEX_HOME in our own 700 folder with
//              600 files, never in the seat folder; and no backup is ever
//              written or chmodded through a symlink (lstat first, refuse).
//   S2 (HIGH)  parallel installs against one CODEX_HOME serialise on a lock
//              in that home (held from the user-config read through the
//              rename), and a config that changed under us aborts the apply
//              before ANY rename. HONCHO_CODEX_LOCK_WAIT_MS (like the
//              install-lock seam) lets a test pin the refusal;
//              HONCHO_USERCFG_SEAM_MS opens the read-to-rename window.
// Temp seats, temp CODEX_HOME only; the ws name is scratch-named; nothing
// here reaches the network (installs never do on these paths).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { scratchName } from "../support/scratch.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;
const PLUGIN = join(REPO, "plugin"); // the PLUGIN_DIR the installer embeds
const URL_ = "http://10.9.9.9/v3";
const WS = scratchName(); // honcho-bridge-scratch* (hard limit); never written
const CODEX_INSTALL = ["--harness", "codex", "--url", URL_, "--workspace", WS];

const TRUST_BEGIN = "# BEGIN openrig-honcho hooks trust";

const HOOKS = (d: string) => join(d, ".codex/hooks.json");
const SETTINGS = (d: string) => join(d, ".codex/openrig-honcho/settings.json");
const RECORD = (d: string) => join(d, ".codex/openrig-honcho/install.json");
const BACKUPS = (d: string) => join(d, ".codex/openrig-honcho/backups");
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

/** one temp seat + one temp CODEX_HOME (never the real ~/.codex) */
function mkHome(): { codexHome: string; env: Record<string, string> } {
  const codexHome = makeTempDir("c5l-home-");
  return { codexHome, env: { ...process.env, CODEX_HOME: codexHome } };
}

async function run(
  dir: string,
  extra: string[],
  env: Record<string, string>,
): Promise<{ code: number; all: string }> {
  const p = Bun.spawn([BUN, BIN, dir, ...extra], { stdout: "pipe", stderr: "pipe", env });
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  return { code: await p.exited, all: `${out}\n${err}` };
}

const userCfg = (home: string): string => join(home, "config.toml");
const trustLines = (home: string): string[] =>
  existsSync(userCfg(home))
    ? readFileSync(userCfg(home), "utf8").split("\n").filter((l) => l.startsWith("trusted_hash"))
    : [];

describe("S1: trust is granted for EXACTLY our groups, never by substring", () => {
  test("a planted PreToolUse group naming the plugin path gets NO trusted_hash and never runs", async () => {
    const { dir: seat, env } = { ...mkHome(), dir: makeTempDir("c5l-s1-") };
    mkdirSync(join(seat, ".codex"), { recursive: true });
    const mark = join(seat, "MARKER-NEVER-RUN");
    // the review's repro shape: any string in the group carries PLUGIN_DIR
    writeFileSync(
      HOOKS(seat),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: `touch ${mark} # ${PLUGIN}`, timeout: 1 }] },
          ],
        },
      }),
    );
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    // exactly our four handlers are vouched for: session_start, ups:0, ups:1, stop
    const hashes = trustLines(env.CODEX_HOME!);
    expect(hashes.length, r.all).toBe(4);
    const toml = readFileSync(userCfg(env.CODEX_HOME!), "utf8");
    expect(toml).not.toContain(":pre_tool_use:"); // the planted key is NOT in the block
    expect(readJson(RECORD(seat)).trustKeys.length).toBe(4);
    // the group itself keeps its bytes (the merge never touches foreign events)
    expect(readJson(HOOKS(seat)).hooks.PreToolUse.length).toBe(1);
    expect(existsSync(mark)).toBe(false); // and nothing we trusted would run it
  });

  test("a foreign group INSIDE our event, naming the plugin path: no hash, kept on reinstall", async () => {
    const { dir: seat, env } = { ...mkHome(), dir: makeTempDir("c5l-s1b-") };
    expect((await run(seat, CODEX_INSTALL, env)).code).toBe(0);
    const planted = { hooks: [{ type: "command", command: `echo planted # ${PLUGIN}`, timeout: 1 }] };
    const h = readJson(HOOKS(seat));
    h.hooks.Stop.push(planted); // second Stop group, ours still at index 0
    writeFileSync(HOOKS(seat), `${JSON.stringify(h, null, 2)}\n`);
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(trustLines(env.CODEX_HOME!).length).toBe(4); // stop:1:0 stays untrusted
    expect(readJson(HOOKS(seat)).hooks.Stop).toContainEqual(planted); // and is NOT removed
  });

  test("uninstall keeps a foreign group that merely names the plugin path", async () => {
    const { dir: seat, env } = { ...mkHome(), dir: makeTempDir("c5l-s1c-") };
    expect((await run(seat, CODEX_INSTALL, env)).code).toBe(0);
    const planted = { hooks: [{ type: "command", command: `echo keepme # ${PLUGIN}`, timeout: 1 }] };
    const h = readJson(HOOKS(seat));
    h.hooks.Stop.push(planted);
    writeFileSync(HOOKS(seat), `${JSON.stringify(h, null, 2)}\n`);
    const r = await run(seat, ["--harness", "codex", "--uninstall"], env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(HOOKS(seat))).toBe(true); // foreign content keeps the file alive
    expect(readJson(HOOKS(seat)).hooks.Stop).toContainEqual(planted);
  });
});

describe("S3: control characters in an embedded path refuse like the other classes", () => {
  const bad: [string, string][] = [
    ["DEL (0x7f) in the seat folder", "del\x7fseat"],
    ["control char 0x01 in the seat folder", "ctl\x01seat"],
  ];
  for (const [name, folder] of bad) {
    test(`${name}: refused, nothing written`, async () => {
      const root = makeTempDir("c5l-s3-");
      const dir = join(root, folder);
      mkdirSync(dir);
      const { env } = mkHome();
      const r = await run(dir, CODEX_INSTALL, env);
      expect(r.code).not.toBe(0);
      expect(r.all).toContain("Refusing, nothing written");
      expect(existsSync(join(dir, ".codex"))).toBe(false);
    });
  }

  test("a tab in the seat folder is still fine (C0 except tab stays allowed)", async () => {
    const root = makeTempDir("c5l-s3-");
    const dir = join(root, "tab\there");
    mkdirSync(dir);
    const { env } = mkHome();
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(HOOKS(dir))).toBe(true);
  });
});

describe("S4: user-config backups live in CODEX_HOME, never through a symlink", () => {
  const USER_BACKUPS = (home: string) => join(home, "openrig-honcho", "backups");

  test("the second seat's install backs the user config up under CODEX_HOME (700 dir, 600 file), not in the seat", async () => {
    const { codexHome, env } = mkHome();
    const s1 = makeTempDir("c5l-s4a-");
    const s2 = makeTempDir("c5l-s4b-");
    expect((await run(s1, CODEX_INSTALL, env)).code).toBe(0);
    const before = readFileSync(userCfg(codexHome), "utf8");
    const r = await run(s2, CODEX_INSTALL, env); // appends block 2 -> backup of v1
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(userCfg(codexHome), "utf8")).not.toBe(before); // it really changed
    const dir = USER_BACKUPS(codexHome);
    expect(existsSync(dir)).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const names = readdirSync(dir).filter((n) => n.startsWith("config.toml."));
    expect(names.length).toBe(1);
    expect(statSync(join(dir, names[0]!)).mode & 0o777).toBe(0o600);
    // and the held bytes are exactly the pre-change user config
    expect(readFileSync(join(dir, names[0]!), "utf8")).toBe(before);
    // no copy of the USER config inside the seat any more
    expect(readdirSync(BACKUPS(s2)).some((n) => n.startsWith("config.toml."))).toBe(false);
  });

  test("a symlinked user-backups folder is refused, the target stays empty, nothing renamed", async () => {
    const { codexHome, env } = mkHome();
    const s1 = makeTempDir("c5l-s4c-");
    const s2 = makeTempDir("c5l-s4d-");
    expect((await run(s1, CODEX_INSTALL, env)).code).toBe(0);
    const before = readFileSync(userCfg(codexHome), "utf8");
    const elsewhere = makeTempDir("c5l-s4-elsewhere-");
    mkdirSync(join(codexHome, "openrig-honcho"), { recursive: true });
    // seat 1's install may already have created the real folder; the attack
    // replaces it with a link to somewhere else
    rmSync(join(codexHome, "openrig-honcho", "backups"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(codexHome, "openrig-honcho", "backups"));
    const r = await run(s2, CODEX_INSTALL, env);
    expect(r.code).not.toBe(0);
    expect(r.all).toContain("is a symlink");
    expect(readdirSync(elsewhere)).toEqual([]); // nothing followed the link
    expect(readFileSync(userCfg(codexHome), "utf8")).toBe(before); // nothing renamed
  });
});

describe("S2: one CODEX_HOME serialises installs; a changed config aborts the apply", () => {
  test("6 parallel installs into one CODEX_HOME keep all 6 trust blocks (5 rounds)", async () => {
    for (let round = 1; round <= 5; round++) {
      const { codexHome, env } = mkHome();
      const seats = Array.from({ length: 6 }, () => makeTempDir("c5l-s2-"));
      const results = await Promise.all(seats.map((s) => run(s, CODEX_INSTALL, env)));
      for (const r of results) expect(r.code, r.all).toBe(0);
      const toml = readFileSync(userCfg(codexHome), "utf8");
      const blocks = toml.split("\n").filter((l) => l.startsWith(TRUST_BEGIN)).length;
      // THE REVIEW'S LOSS: one seat's block vanished in 10/10 trials before
      // the fix; every round must end with all six, and a parseable config.
      expect(blocks, `round ${round}: only ${blocks} of 6 trust blocks survived`).toBe(6);
      expect(() => Bun.TOML.parse(toml)).not.toThrow();
      for (const s of seats) expect(readJson(RECORD(s)).trustKeys.length).toBe(4);
    }
  }, 60000);

  test("a live user-config lock blocks an install with a refusal and zero writes", async () => {
    const { codexHome, env } = mkHome();
    const seat = makeTempDir("c5l-s2live-");
    writeFileSync(
      join(codexHome, "openrig-honcho-install.lock"),
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
    );
    const r = await run(seat, CODEX_INSTALL, { ...env, HONCHO_CODEX_LOCK_WAIT_MS: "200" });
    expect(r.code).not.toBe(0);
    expect(r.all).toContain("user config lock");
    expect(existsSync(join(seat, ".codex"))).toBe(false);
    expect(existsSync(userCfg(codexHome))).toBe(false);
  });

  test("a stale user-config lock (dead pid) is taken over, then released", async () => {
    const { codexHome, env } = mkHome();
    const seat = makeTempDir("c5l-s2stale-");
    const lock = join(codexHome, "openrig-honcho-install.lock");
    writeFileSync(lock, `${JSON.stringify({ pid: 2147483646, at: new Date().toISOString() })}\n`);
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(lock)).toBe(false); // released at exit
    expect(trustLines(codexHome).length).toBe(4);
  });

  test("the user config changed between our read and our rename: refuse, nothing renamed", async () => {
    const { codexHome, env } = mkHome();
    const s1 = makeTempDir("c5l-s2r-");
    const s2 = makeTempDir("c5l-s2r2-");
    expect((await run(s1, CODEX_INSTALL, env)).code).toBe(0);
    // open the read-to-rename window on the second install (test seam, off
    // in production exactly like HONCHO_INSTALL_SEAM_MS)
    const p = Bun.spawn([BUN, BIN, s2, ...CODEX_INSTALL], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...env, HONCHO_USERCFG_SEAM_MS: "1500" },
    });
    const record = join(s2, ".codex/openrig-honcho");
    const t0 = Date.now();
    let marker = "";
    while (Date.now() - t0 < 4000) {
      if (existsSync(record)) {
        marker = readdirSync(record).find((n) => n.startsWith("install.seamucfg.")) ?? "";
        if (marker !== "") break;
      }
      await Bun.sleep(25);
    }
    expect(marker, "the seam marker never appeared (seam not in place)").not.toBe("");
    // an owner edit lands inside the window
    writeFileSync(userCfg(codexHome), `${readFileSync(userCfg(codexHome), "utf8")}# owner edit IN THE WINDOW\n`);
    const out = await new Response(p.stdout as ReadableStream).text();
    const err = await new Response(p.stderr as ReadableStream).text();
    const code = await p.exited;
    expect(code).not.toBe(0);
    expect(`${out}\n${err}`).toContain("changed while this install was planned");
    // the edit survives and no trace of seat 2 was renamed
    expect(readFileSync(userCfg(codexHome), "utf8")).toContain("# owner edit IN THE WINDOW");
    expect(readFileSync(userCfg(codexHome), "utf8")).not.toContain(s2);
    expect(existsSync(RECORD(s2))).toBe(false);
  });
});

describe("C5l2: the seat lock never judges a live holder stale", () => {
  test("a partly-written seat lock with a live pid is NEVER stale: refuse, zero writes", async () => {
    const { codexHome, env } = mkHome();
    const seat = makeTempDir("c5l2-seatlock-");
    const record = join(seat, ".codex/openrig-honcho");
    mkdirSync(record, { recursive: true });
    const lock = join(record, "install.lock");
    // the open-then-write shape caught mid-fill: the bytes start with a
    // pid and stop before the JSON closes. The holder here is this very
    // test process - if the installer reads these bytes, judges them
    // garbage and moves them aside, it has stolen a LIVE holder's lock,
    // which is exactly the C5l user-config bug on the seat side.
    writeFileSync(lock, `{"pid":${process.pid},"at":"2026-11-10T00:00:00.000Z`);
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code).not.toBe(0);
    expect(r.all).toContain(`pid ${process.pid}`);
    expect(r.all).not.toContain("is stale"); // never garbage, never moved aside
    expect(readFileSync(lock, "utf8")).toContain(`"pid":${process.pid}`); // bytes intact
    expect(readdirSync(record).filter((n) => n.includes(".stale-"))).toEqual([]);
    // zero writes: nothing installed in the seat or the user layer
    expect(existsSync(HOOKS(seat))).toBe(false);
    expect(existsSync(RECORD(seat))).toBe(false);
    expect(existsSync(userCfg(codexHome))).toBe(false);
  });

  test("an EMPTY seat lock (no pid readable) is still garbage: taken over, install proceeds", async () => {
    // the honest limit of the fix: an empty lock carries no pid, so no
    // holder can be shown alive; after the C5l2 create (fill file + hard
    // link, the lock appears whole) OUR installers never leave one mid-
    // fill, so an empty lock is a crashed old-style writer: stale stays.
    const { codexHome, env } = mkHome();
    const seat = makeTempDir("c5l2-emptylock-");
    const record = join(seat, ".codex/openrig-honcho");
    mkdirSync(record, { recursive: true });
    writeFileSync(join(record, "install.lock"), "");
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(HOOKS(seat))).toBe(true);
    expect(existsSync(userCfg(codexHome))).toBe(true);
  });
});

describe("C5l3 F20: a refusal inside the staged apply leaves no temps behind", () => {
  test("a dangling symlink at the next backup name: refused, and no .tmp- file anywhere", async () => {
    const { codexHome, env } = mkHome();
    const seat = makeTempDir("c5l3-f20-");
    const original = '# owner line\nkeep = "me"\n';
    writeFileSync(userCfg(codexHome), original, { mode: 0o600 });
    const backups = join(codexHome, "openrig-honcho", "backups");
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    // uniqueBackupCopy's existsSync cannot see a dangling link, so a link
    // planted at the names the apply is about to choose gets picked, and
    // refuseSymlink then ENDS THE PROCESS inside the apply - after the
    // temps exist and before the catch can drop them (reviewer F20: a
    // 600-mode config.toml.tmp-* holding the MERGED config - owner lines
    // plus our block - stayed in CODEX_HOME through a later successful
    // install AND an uninstall).
    for (let s = 0; s <= 5; s++) {
      const stamp = new Date(Date.now() + s * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const n = join(backups, `config.toml.${stamp}`);
      if (!existsSync(n)) symlinkSync(join(codexHome, "nothing-here"), n);
    }
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code).not.toBe(0);
    expect(r.all).toContain("is a symlink");
    // THE FIX (exit belt on dropTemps): not one temp survives the refusal…
    expect(readdirSync(codexHome).filter((n) => n.includes(".tmp-"))).toEqual([]);
    const record = join(seat, ".codex", "openrig-honcho");
    expect(existsSync(record) ? readdirSync(record).filter((n) => n.includes(".tmp-")) : []).toEqual([]);
    // …and the owner file is byte-identical: nothing was renamed
    expect(readFileSync(userCfg(codexHome), "utf8")).toBe(original);
  });
});
