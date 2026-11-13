// T12b: plugin/bin/install-project.ts spawned as the real bin against temp
// dirs. The fixture carries the pilot key set (env with token-shaped
// values, permissions.deny, foreign hooks on four events, statusLine,
// enabledPlugins, enabledMcpjsonServers) with DUMMY marked values only.
// Binding assertions from the 18:35Z amendment: foreign content identical
// after install AND uninstall, key order unchanged, the dummy token never
// appears in ANY output path (install, dry-run, uninstall, every error),
// settings 600 + backups 600, refusal writes nothing at all.
// Nothing here is a real secret; marked lines follow the tests/ zone rule.
// T12c adds the last describe: F1-F4 refusals + the container rule (uninstall
// never deletes a container key), complementing tests/unit/review-t12-installer.test.ts.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import {  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync  } from "node:fs";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;

// marked dummy values (the marker word itself is not a secret shape)
const TOKEN = "fake-secret-not-a-token";
const MODEL = "qwen-fake-secret-model";

const settingsFixture = {
  env: { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_MODEL: MODEL, CLAUDE_NOTES_MODE: "fake-secret-off" },
  permissions: { deny: ["Read(./.env)", "Read(./secrets/**)"] },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "echo rig-managed-session" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo rig-managed-prompt" }] }],
    Stop: [{ hooks: [{ type: "command", command: "echo rig-managed-stop" }] }],
    Notification: [{ hooks: [{ type: "command", command: "echo rig-managed-notify" }] }] },
  statusLine: { type: "command", command: "echo statusline" },
  enabledPlugins: { "some-plugin@market": true },
  enabledMcpjsonServers: ["other_server"],
  disabledMcpjsonServers: [] as string[] };

const mcpFixture = { mcpServers: { other_server: { command: "echo", args: ["other"] } } };

function mkProject(opts: { settings?: unknown; mcp?: unknown; modes?: { settings?: number; mcp?: number } } = {}): string {
  const dir = makeTempDir("install-test-");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  if (opts.settings !== undefined) {
    const text = typeof opts.settings === "string" ? opts.settings : `${JSON.stringify(opts.settings, null, 2)}\n`;
    writeFileSync(join(dir, ".claude/settings.local.json"), text);
    chmodSync(join(dir, ".claude/settings.local.json"), opts.modes?.settings ?? 0o600);
  }
  if (opts.mcp !== undefined) {
    writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify(opts.mcp, null, 2)}\n`);
    chmodSync(join(dir, ".mcp.json"), opts.modes?.mcp ?? 0o640);
  }
  return dir;
}

// T13b: backups live under our folder now - <name>.<UTC stamp>, 0600
const BACKUPS = (dir: string) => join(dir, ".claude", "openrig-honcho", "backups");
const backupNames = (dir: string): string[] => (existsSync(BACKUPS(dir)) ? readdirSync(BACKUPS(dir)) : []);

async function run(dir: string, extra: string[]): Promise<{ code: number; all: string }> {
  const p = Bun.spawn([BUN, BIN, dir, ...extra], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  return { code: await p.exited, all: `${out}\n${err}` };
}

const INSTALL = ["--url", "http://10.9.9.9/v3", "--workspace", "honcho-bridge-scratch-inst"];
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const readBytes = (p: string): Buffer => readFileSync(p);
const SETTINGS = (d: string) => join(d, ".claude/settings.local.json");
const MCP = (d: string) => join(d, ".mcp.json");

describe("install-project: fresh install", () => {
  test("empty project: files created, ours present, modes 600/new, no backup for new files", async () => {
    const dir = mkProject();
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    const s = readJson(SETTINGS(dir));
    expect(s.env.HONCHO_URL).toBe("http://10.9.9.9/v3");
    expect(s.env.HONCHO_WORKSPACE).toBe("honcho-bridge-scratch-inst");
    expect(s.enabledMcpjsonServers).toEqual(["rig_memory"]);
    expect(Object.keys(s.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    const m = readJson(MCP(dir));
    expect(m.mcpServers.rig_memory.args[1]).toContain("/plugin/bin/mcp.ts");
    expect(statSync(SETTINGS(dir)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, ".claude/skills/rig-memory/SKILL.md"))).toBe(true);
    expect(backupNames(dir)).toEqual([]); // new files: nothing to back up
  });
});

describe("install-project: merge over the pilot-shaped fixture", () => {
  test("foreign keys/values byte-identical, key order kept, ours appended after existing groups", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const before = readBytes(SETTINGS(dir));
    const r = await run(dir, [...INSTALL, "--leader", "lead-seat"]);
    expect(r.code, r.all).toBe(0);
    const s = readJson(SETTINGS(dir));
    // every original key present, same ORDER (all our targets already existed)
    expect(Object.keys(s)).toEqual(Object.keys(settingsFixture));
    // foreign env: untouched values, our keys appended after them
    expect(Object.keys(s.env)).toEqual([...Object.keys(settingsFixture.env), "HONCHO_URL", "HONCHO_WORKSPACE", "HONCHO_LEADER_PEER"]);
    for (const [k, v] of Object.entries(settingsFixture.env)) expect(s.env[k]).toBe(v);
    // foreign hooks first and intact on all four events; ours appended
    // (T14d-2: UserPromptSubmit carries two of ours - recall first, writer after)
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"] as const) {
      expect(s.hooks[ev][0]).toEqual(settingsFixture.hooks[ev][0]);
      const ours = ev === "UserPromptSubmit" ? 2 : 1;
      expect(s.hooks[ev].length).toBe(1 + ours);
      for (let i = 1; i <= ours; i++) expect(JSON.stringify(s.hooks[ev][i])).toContain("/plugin/bin/");
    }
    expect(JSON.stringify(s.hooks.UserPromptSubmit[1])).toContain("bin/recall.ts");
    expect(JSON.stringify(s.hooks.UserPromptSubmit[2])).toContain("bin/user-prompt.ts");
    expect(s.hooks.Notification).toEqual(settingsFixture.hooks.Notification); // no hook of ours
    expect(s.permissions).toEqual(settingsFixture.permissions);
    expect(s.statusLine).toEqual(settingsFixture.statusLine);
    expect(s.enabledPlugins).toEqual(settingsFixture.enabledPlugins);
    expect(s.enabledMcpjsonServers).toEqual(["other_server", "rig_memory"]);
    expect(s.disabledMcpjsonServers).toEqual([]);
    // .mcp.json: foreign server kept, ours added, foreign mode kept
    const m = readJson(MCP(dir));
    expect(m.mcpServers.other_server).toEqual(mcpFixture.mcpServers.other_server);
    expect(Object.keys(m.mcpServers)).toEqual(["other_server", "rig_memory"]);
    expect(statSync(MCP(dir)).mode & 0o777).toBe(0o640);
    // T13b: BOTH changed files are backed up under our folder at 600, the
    // settings backup carries the before-state, and nothing lands in the
    // project root any more.
    const backs = backupNames(dir);
    expect(backs.length).toBe(2);
    const sBack = backs.find((f) => f.startsWith("settings.local.json."));
    expect(sBack).toBeDefined();
    expect(readBytes(join(BACKUPS(dir), sBack as string)).equals(before)).toBe(true);
    expect(backs.some((f) => f.startsWith(".mcp.json."))).toBe(true);
    for (const f of backs) expect(statSync(join(BACKUPS(dir), f)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes("bak-openrig-honcho")).length).toBe(0);
    // no value ever printed - not foreign ones, not our flag values
    for (const secret of [TOKEN, MODEL, "10.9.9.9", "honcho-bridge-scratch-inst", "lead-seat"]) {
      expect(r.all).not.toContain(secret);
    }
  });

  test("idempotence: second run is byte-identical and writes no new backup", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    const sBytes = readBytes(SETTINGS(dir));
    const mBytes = readBytes(MCP(dir));
    const backsBefore = backupNames(dir).length;
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("nothing to change");
    expect(readBytes(SETTINGS(dir)).equals(sBytes)).toBe(true);
    expect(readBytes(MCP(dir)).equals(mBytes)).toBe(true);
    const backsAfter = backupNames(dir).length;
    expect(backsAfter).toBe(backsBefore);
  });

  test("re-running with a different flag value replaces exactly that key, order kept", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    await run(dir, INSTALL);
    const r = await run(dir, ["--url", "http://10.8.8.8:8002/v3", "--workspace", "honcho-bridge-scratch-inst"]);
    expect(r.code, r.all).toBe(0);
    const s = readJson(SETTINGS(dir));
    expect(s.env.HONCHO_URL).toBe("http://10.8.8.8:8002/v3");
    expect(Object.keys(s.env)).toEqual([...Object.keys(settingsFixture.env), "HONCHO_URL", "HONCHO_WORKSPACE"]);
  });

  test("T14b-2 (pilot v0.1.2): a re-run replaces our hook groups in place; foreign groups never move", async () => {
    const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    const afterFirst = readJson(SETTINGS(dir));
    // capture the canonical groups the installer wrote, per event (T14d-2:
    // UserPromptSubmit carries two of ours - recall then writer)
    const ours: Record<string, unknown[]> = {};
    for (const ev of EVENTS) ours[ev] = afterFirst.hooks[ev].slice(1);
    // the pilot shape: another manager appended a group AFTER ours (the
    // OpenRig activity relay), and one of our groups drifted (stale timeout)
    const relay = { hooks: [{ type: "command", command: "echo rig-managed-relay" }] };
    const s = readJson(SETTINGS(dir));
    for (const ev of EVENTS) {
      s.hooks[ev].push(relay);
      s.hooks[ev][ours[ev].length].hooks[0].timeout = 99; // our last group per event
    }
    writeFileSync(SETTINGS(dir), `${JSON.stringify(s, null, 2)}\n`);
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    const s2 = readJson(SETTINGS(dir));
    for (const ev of EVENTS) {
      expect(s2.hooks[ev].length).toBe(2 + ours[ev].length);
      expect(s2.hooks[ev][0]).toEqual(settingsFixture.hooks[ev][0]); // foreign first, unmoved
      expect(s2.hooks[ev].slice(1, 1 + ours[ev].length)).toEqual(ours[ev]); // ours repaired AT their positions, not the end
      expect(s2.hooks[ev][1 + ours[ev].length]).toEqual(relay); // the later foreign group unmoved
    }
    expect(r.all).toContain("replaced in place");
    expect(r.all).not.toContain("appended after existing groups");
  });
});

describe("install-project: refusals write NOTHING at all", () => {
  async function noWrites(dir: string, extra: string[], expectCode = 1): Promise<string> {
    const sBefore = existsSync(SETTINGS(dir)) ? readBytes(SETTINGS(dir)) : null;
    const mBefore = existsSync(MCP(dir)) ? readBytes(MCP(dir)) : null;
    const r = await run(dir, extra);
    expect(r.code, r.all).toBe(expectCode);
    if (sBefore !== null) expect(readBytes(SETTINGS(dir)).equals(sBefore)).toBe(true);
    else expect(existsSync(SETTINGS(dir))).toBe(false);
    if (mBefore !== null) expect(readBytes(MCP(dir)).equals(mBefore)).toBe(true);
    expect(backupNames(dir)).toEqual([]); // a refusal never writes backups either
    expect(existsSync(join(dir, ".claude/skills/rig-memory"))).toBe(false);
    return r.all;
  }

  test("non-object JSON target (array) refuses; output never carries file text", async () => {
    const dir = mkProject({ settings: [1, TOKEN], mcp: mcpFixture }); // array + token baked in
    const all = await noWrites(dir, INSTALL);
    expect(all).toContain("not a JSON object");
    expect(all).not.toContain(TOKEN);
  });

  test("unparseable JSON refuses with no parser echo", async () => {
    const dir = mkProject({ settings: `{ "env": { "ANTHROPIC_AUTH_TOKEN": "${TOKEN}"`, mcp: mcpFixture });
    const all = await noWrites(dir, INSTALL);
    expect(all).toContain("not parseable JSON");
    expect(all).not.toContain(TOKEN);
  });

  test("rig_memory in disabledMcpjsonServers: refused, nothing overridden or written", async () => {
    const dir = mkProject({ settings: { ...settingsFixture, disabledMcpjsonServers: ["rig_memory"] }, mcp: mcpFixture });
    const all = await noWrites(dir, INSTALL);
    expect(all).toContain("disabledMcpjsonServers");
    expect(readJson(SETTINGS(dir)).enabledMcpjsonServers).toEqual(["other_server"]); // untouched
  });

  test("a FOREIGN rig_memory server is refused, not overwritten", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: { mcpServers: { rig_memory: { command: "someone-elses-binary" } } } });
    const all = await noWrites(dir, INSTALL);
    expect(all).toContain("not ours");
    expect(readJson(MCP(dir)).mcpServers.rig_memory.command).toBe("someone-elses-binary");
  });

  test("bad flag input: env.ts rules refuse; the bad VALUE is never echoed", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const r = await run(dir, ["--url", "https://api.honcho.dev/v3", "--workspace", "secret-session-name"]);
    expect(r.code).toBe(1);
    expect(r.all).toContain("HONCHO_URL");
    expect(r.all).not.toContain("secret-session-name");
    expect(existsSync(join(dir, ".claude/skills/rig-memory"))).toBe(false);
  });
});

describe("install-project: dry-run writes nothing", () => {
  test("plan names keys and events only; no file, no backup, no skills, no values", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const sBefore = readBytes(SETTINGS(dir));
    const mBefore = readBytes(MCP(dir));
    const r = await run(dir, [...INSTALL, "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(readBytes(SETTINGS(dir)).equals(sBefore)).toBe(true);
    expect(readBytes(MCP(dir)).equals(mBefore)).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/rig-memory"))).toBe(false);
    expect(r.all).toContain("dry-run");
    expect(r.all).toContain("HONCHO_URL"); // names...
    for (const secret of [TOKEN, MODEL, "10.9.9.9", "honcho-bridge-scratch-inst"]) expect(r.all).not.toContain(secret); // ...never values
  });
});

describe("install-project: uninstall removes exactly ours", () => {
  test("round trip restores foreign content and order; foreign HONCHO_* and other servers survive", async () => {
    const settingsWithForeignHoncho = {
      ...settingsFixture,
      env: { ...settingsFixture.env, HONCHO_STATE_DIR: "/tmp/foreign-state" }, // NOT one of our five names
    };
    const dir = mkProject({ settings: settingsWithForeignHoncho, mcp: mcpFixture });
    const origS = readJson(SETTINGS(dir));
    const origM = readJson(MCP(dir));
    expect((await run(dir, INSTALL)).code).toBe(0);
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    const s = readJson(SETTINGS(dir));
    expect(JSON.stringify(Object.keys(s))).toBe(JSON.stringify(Object.keys(origS)));
    expect(s).toEqual(origS);
    expect(s.env.HONCHO_STATE_DIR).toBe("/tmp/foreign-state"); // left alone: not one of the five
    expect(s.env.HONCHO_URL).toBeUndefined();
    expect(s.hooks.Notification).toBeDefined();
    expect(s.hooks.SessionStart).toEqual(settingsFixture.hooks.SessionStart);
    expect(readJson(MCP(dir))).toEqual(origM);
    expect(existsSync(join(dir, ".claude/skills/rig-memory"))).toBe(false);
    // uninstall output names keys only
    for (const secret of [TOKEN, MODEL, "10.9.9.9"]) expect(r.all).not.toContain(secret);
    // idempotent uninstall
    const r2 = await run(dir, ["--uninstall"]);
    expect(r2.all).toContain("nothing to change");
  });

  test("uninstall never deletes a container key: empty containers stay (19:18Z ruling)", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] }, mcp: { mcpServers: {} } });
    expect((await run(dir, INSTALL)).code).toBe(0);
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    const s = readJson(SETTINGS(dir));
    expect("env" in s && "hooks" in s && "enabledMcpjsonServers" in s).toBe(true);
    expect(s.env).toEqual({});
    expect(s.enabledMcpjsonServers).toEqual([]);
    for (const ev of Object.keys(s.hooks)) expect(s.hooks[ev]).toEqual([]);
    expect(readJson(MCP(dir))).toEqual({ mcpServers: {} });
  });
});

describe("install-project: F3 whole-path ownership (ADR-0018)", () => {
  // A sibling folder whose path STARTS with ours is NOT ours. The old
  // substring match claimed these: install replaced the group, uninstall
  // removed it. PLUGIN is the same realpath the bin computes (line 117).
  const PLUGIN = realpathSync(join(REPO, "plugin"));
  const sibOld = { hooks: [{ type: "command", command: `bun run "${PLUGIN}-old/bin/session-start.ts"` }] };
  const sib2 = { hooks: [{ type: "command", command: `bun run ${PLUGIN}2/bin/stop.ts` }] };

  test("sibling plugin-path hook groups survive install AND uninstall; ours still round-trips", async () => {
    const dir = mkProject({
      settings: { env: {}, hooks: { SessionStart: [sibOld], Stop: [sib2] }, enabledMcpjsonServers: [] as string[] },
      mcp: { mcpServers: {} } });
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    let s = readJson(SETTINGS(dir));
    // sibling kept FIRST (append rule), ours added beside it
    expect(s.hooks.SessionStart.length).toBe(2);
    expect(JSON.stringify(s.hooks.SessionStart[0])).toBe(JSON.stringify(sibOld));
    expect(JSON.stringify(s.hooks.SessionStart[1])).toContain(join(PLUGIN, "bin", "session-start.ts"));
    expect(s.hooks.Stop.length).toBe(2);
    expect(JSON.stringify(s.hooks.Stop[0])).toBe(JSON.stringify(sib2));
    expect(JSON.stringify(s.hooks.Stop[1])).toContain(join(PLUGIN, "bin", "stop.ts"));
    const r2 = await run(dir, ["--uninstall"]);
    expect(r2.code, r2.all).toBe(0);
    s = readJson(SETTINGS(dir));
    expect(s.hooks).toEqual({ SessionStart: [sibOld], Stop: [sib2], UserPromptSubmit: [] });
    expect(readJson(MCP(dir))).toEqual({ mcpServers: {} });
  });
});

describe("install-project: F4 dir modes + stale temp sweep (ADR-0018)", () => {
  const RECORD_DIR = (d: string) => join(d, ".claude", "openrig-honcho");

  test("a pre-existing record or backups folder at 0755 is tightened to 0700 by install", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] as string[] }, mcp: { mcpServers: {} } });
    mkdirSync(BACKUPS(dir), { recursive: true }); // creates the record dir too
    chmodSync(RECORD_DIR(dir), 0o755);
    chmodSync(BACKUPS(dir), 0o755);
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(statSync(RECORD_DIR(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(BACKUPS(dir)).mode & 0o777).toBe(0o700);
  });

  test("a dead pid's temp is swept; a live pid's and a lookalike survive; --dry-run sweeps nothing", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] as string[] }, mcp: { mcpServers: {} } });
    const dead = Bun.spawn(["true"]);
    await dead.exited; // exited and reaped: kill(pid, 0) is ESRCH
    const stale = `${SETTINGS(dir)}.tmp-${dead.pid}-abc123`;
    writeFileSync(stale, "stale\n");
    const live = `${MCP(dir)}.tmp-${process.pid}-live01`;
    writeFileSync(live, "live\n");
    const lookalike = `${MCP(dir)}.tmp-notes`;
    writeFileSync(lookalike, "notes\n");
    const rd = await run(dir, [...INSTALL, "--dry-run"]);
    expect(rd.code, rd.all).toBe(0);
    expect(existsSync(stale)).toBe(true); // the dry-run takes no lock and writes NOTHING
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(r.all).toContain("stale"); // one line: count + names only, never contents
    expect(readFileSync(live, "utf8")).toBe("live\n"); // live pid: still possibly mid-write
    expect(readFileSync(lookalike, "utf8")).toBe("notes\n"); // not our name shape
  });
});

describe("install-project: F6 lock slot + stale wording (ADR-0018)", () => {
  const LOCK = (d: string) => join(d, ".claude", "openrig-honcho", "install.lock");
  const plant = (d: string, body: string): void => {
    mkdirSync(join(d, ".claude", "openrig-honcho"), { recursive: true });
    writeFileSync(LOCK(d), body, { mode: 0o600 });
  };

  test("a DIRECTORY at the lock slot is not a lock: refuse before any rename, zero writes", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const before = readBytes(SETTINGS(dir));
    mkdirSync(LOCK(dir), { recursive: true }); // someone's real folder sits at the slot
    const keep = join(LOCK(dir), "keep.txt");
    writeFileSync(keep, "keep\n");
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("is a directory");
    expect(r.all).toContain("not a lock file");
    expect(readFileSync(keep, "utf8")).toBe("keep\n"); // contents untouched
    expect(readBytes(SETTINGS(dir)).equals(before)).toBe(true); // nothing written
    expect(backupNames(dir)).toEqual([]);
  });

  test("a dead-pid lock prints the AFTER-THE-FACT line: was stale, moved aside, taken", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited; // reaped: the pid is gone
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    plant(dir, JSON.stringify({ pid: dead.pid, at: "2026-11-13T02:00:00.000Z" }));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("was stale");
    expect(r.all).toContain("moved aside to");
    expect(r.all).toContain("and taken");
    expect(r.all).not.toContain("is stale"); // nothing claims a move before it can fail
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBe("http://10.9.9.9/v3");
  });

  test("a live-pid lock keeps its refusal exactly: same message, no stale claim", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    plant(dir, JSON.stringify({ pid: process.pid, at: "2026-11-13T02:00:00.000Z" }));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain(`another install or uninstall is running in this project (pid ${process.pid})`);
    expect(r.all).not.toContain("stale"); // unchanged: never judged, never announced
  });
});

describe("install-project: F7 tighten existing folders on runs that skip the record branch", () => {
  // F7 (operator finding, v0.5.2 pilots): ensureOurDir700 sat inside the
  // record-write branch, so a skill-only or nothing-to-change re-run left a
  // 0775 record/backups folder 0775. F4's pins only covered writes.
  const RECORD_DIR = (d: string) => join(d, ".claude", "openrig-honcho");
  const SKILLS = (d: string) => join(d, ".claude", "skills", "rig-memory");
  const installOnce = async (dir: string): Promise<void> => {
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
  };

  test("a nothing-to-change reinstall tightens both 0775 folders to 0700 and names them", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] as string[] }, mcp: { mcpServers: {} } });
    await installOnce(dir);
    chmodSync(RECORD_DIR(dir), 0o775);
    chmodSync(BACKUPS(dir), 0o775);
    const r2 = await run(dir, INSTALL);
    expect(r2.code, r2.all).toBe(0);
    expect(statSync(RECORD_DIR(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(BACKUPS(dir)).mode & 0o777).toBe(0o700);
    expect(r2.all).toContain("tightened");
    expect(r2.all).toContain("openrig-honcho/backups"); // names the folders
    expect(r2.all).not.toContain("nothing to change"); // honest verdict instead
  });

  test("a skill-only reinstall (the v0.5.2 pilot case) tightens both folders", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] as string[] }, mcp: { mcpServers: {} } });
    await installOnce(dir);
    rmSync(SKILLS(dir), { recursive: true, force: true }); // now ONLY skills plans
    chmodSync(RECORD_DIR(dir), 0o775);
    chmodSync(BACKUPS(dir), 0o775);
    const r2 = await run(dir, INSTALL);
    expect(r2.code, r2.all).toBe(0);
    expect(r2.all).toContain("skills:"); // confirms the record branch was skipped
    expect(statSync(RECORD_DIR(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(BACKUPS(dir)).mode & 0o777).toBe(0o700);
  });

  test("--dry-run leaves 0775 folders at 0775 and still says nothing to change", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] as string[] }, mcp: { mcpServers: {} } });
    await installOnce(dir);
    chmodSync(RECORD_DIR(dir), 0o775);
    chmodSync(BACKUPS(dir), 0o775);
    const rd = await run(dir, [...INSTALL, "--dry-run"]);
    expect(rd.code, rd.all).toBe(0);
    expect(statSync(RECORD_DIR(dir)).mode & 0o777).toBe(0o775);
    expect(statSync(BACKUPS(dir)).mode & 0o777).toBe(0o775);
    expect(rd.all).toContain("nothing to change"); // unchanged verdict, untouched folders
    expect(rd.all).not.toContain("tighten");
  });

  test("a nothing-to-change run creates nothing: a missing backups folder stays missing", async () => {
    const dir = mkProject({ settings: { env: {}, hooks: {}, enabledMcpjsonServers: [] as string[] }, mcp: { mcpServers: {} } });
    await installOnce(dir);
    rmSync(BACKUPS(dir), { recursive: true, force: true });
    const r2 = await run(dir, INSTALL);
    expect(r2.code, r2.all).toBe(0);
    expect(existsSync(BACKUPS(dir))).toBe(false); // F7 tightens, never creates
    expect(r2.all).toContain("nothing to change");
    expect(statSync(RECORD_DIR(dir)).mode & 0o777).toBe(0o700);
  });
});

describe("install-project: T12c rules (F1-F4 + the container rule)", () => {
  test("F1 uninstall side too: wrong-typed hooks refuses the uninstall with zero writes", async () => {
    const dir = mkProject({ settings: { hooks: "foreign-string", env: { HONCHO_URL: "http://10.9.9.9/v3" } }, mcp: { mcpServers: {} } });
    const before = readBytes(SETTINGS(dir));
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("hooks is not an object");
    expect(readBytes(SETTINGS(dir)).equals(before)).toBe(true);
  });

  test("F2: uninstall with no install from our path changes NOTHING (owner names and folder survive)", async () => {
    const dir = mkProject({
      settings: { enabledMcpjsonServers: ["rig_memory"], env: { HONCHO_URL: "http://owners-own-route/v3" } },
      mcp: { mcpServers: {} } });
    mkdirSync(join(dir, ".claude", "skills", "rig-memory"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "rig-memory", "SKILL.md"), "owner wrote this\n");
    const before = readBytes(SETTINGS(dir));
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("not installed from");
    expect(readBytes(SETTINGS(dir)).equals(before)).toBe(true); // env keys and the name: untouched
    expect(existsSync(join(dir, ".claude", "skills", "rig-memory", "SKILL.md"))).toBe(true);
    expect(backupNames(dir)).toEqual([]);
  });

  test("F3: an existing target file that is not writable refuses BEFORE any write", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    chmodSync(MCP(dir), 0o444);
    const sBefore = readBytes(SETTINGS(dir));
    const mBefore = readBytes(MCP(dir));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain(".mcp.json");
    expect(r.all).toContain("nothing written");
    expect(readBytes(SETTINGS(dir)).equals(sBefore)).toBe(true);
    expect(readBytes(MCP(dir)).equals(mBefore)).toBe(true);
    expect(backupNames(dir)).toEqual([]);
  });

  test("F4: a symlinked .mcp.json is refused; link and target survive; settings untouched", async () => {
    const dir = mkProject({ settings: settingsFixture });
    writeFileSync(join(dir, "mcp-target.json"), `${JSON.stringify(mcpFixture, null, 2)}\n`);
    symlinkSync("../mcp-target.json", MCP(dir));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain(".mcp.json");
    expect(lstatSync(MCP(dir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "mcp-target.json"), "utf8")).toContain("other_server");
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBeUndefined(); // nothing at all written
    expect(backupNames(dir)).toEqual([]);
  });

  test("F4: a symlinked skills folder is refused; nothing is copied through the link", async () => {
    const dir = mkProject({ settings: { env: {} } });
    const elsewhere = join(dir, "elsewhere-skills");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    symlinkSync("../elsewhere-skills", join(dir, ".claude", "skills", "rig-memory"));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("rig-memory");
    expect(lstatSync(join(dir, ".claude", "skills", "rig-memory")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(elsewhere, "SKILL.md"))).toBe(false);
  });
});

describe("install-project: file mode discipline", () => {
  test("settings ends 600 even when it started 644; a new settings is 600; backups 600", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture, modes: { settings: 0o644 } });
    await run(dir, INSTALL);
    expect(statSync(SETTINGS(dir)).mode & 0o777).toBe(0o600);
    const backs = backupNames(dir);
    expect(backs.length).toBeGreaterThan(0);
    for (const f of backs) expect(statSync(join(BACKUPS(dir), f)).mode & 0o777).toBe(0o600);
  });
});

// T13b (ADR-0008 amendment 2026-10-30): the install record and the folder.
describe("install-project: T13b install record (ADR-0008 amendment)", () => {
  const PLUGIN = realpathSync(join(REPO, "plugin"));
  const RECORD = (d: string) => join(d, ".claude/openrig-honcho/install.json");
  const GITIGNORE = (d: string) => join(d, ".claude/openrig-honcho/.gitignore");
  const writeRecord = (d: string, text: string): void => {
    mkdirSync(join(d, ".claude", "openrig-honcho"), { recursive: true });
    writeFileSync(RECORD(d), text);
  };
  // a v0.1.1 install: hooks/server name PLUGIN_DIR, no record
  const v011Settings = (env: Record<string, string>, enabled: string[]): Record<string, unknown> => ({
    env,
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `bun run "${PLUGIN}/bin/hooks/run.ts"` }] }] },
    enabledMcpjsonServers: enabled });
  const v011Mcp = { mcpServers: { rig_memory: { command: "bun", args: ["run", `${PLUGIN}/bin/mcp.ts`] } } };

  test("install writes record + folder + .gitignore; record 0600; project root stays clean", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, [...INSTALL, "--leader", "lead-seat"])).code).toBe(0);
    expect(readJson(RECORD(dir))).toEqual({
      version: 1,
      plugin: PLUGIN,
      envAdded: ["HONCHO_LEADER_PEER", "HONCHO_URL", "HONCHO_WORKSPACE"], // sorted, names only
      enabledAdded: true });
    expect(statSync(RECORD(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(GITIGNORE(dir), "utf8")).toBe("*\n");
    expect(readdirSync(dir).sort()).toEqual([".claude", ".mcp.json"]); // nothing else in the root
    expect(readdirSync(join(dir, ".claude")).includes("openrig-honcho")).toBe(true);
  });

  test("idempotent re-run writes no byte anywhere: record, .gitignore and backups untouched", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    await run(dir, INSTALL);
    const recB = readBytes(RECORD(dir));
    const giB = readBytes(GITIGNORE(dir));
    const nBacks = backupNames(dir).length;
    const r = await run(dir, INSTALL);
    expect(r.all).toContain("nothing to change");
    expect(readBytes(RECORD(dir)).equals(recB)).toBe(true);
    expect(readBytes(GITIGNORE(dir)).equals(giB)).toBe(true);
    expect(backupNames(dir).length).toBe(nBacks);
  });

  test("record unions across re-runs; a re-run without a flag leaves key and record entry (ruling (e))", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, [...INSTALL, "--leader", "lead-seat"])).code).toBe(0);
    expect((await run(dir, [...INSTALL, "--owner-peer", "own-seat"])).code).toBe(0);
    expect(readJson(RECORD(dir)).envAdded).toEqual([
      "HONCHO_LEADER_PEER",
      "HONCHO_OWNER_PEER",
      "HONCHO_URL",
      "HONCHO_WORKSPACE",
    ]);
    const r = await run(dir, INSTALL); // no --leader, no --owner-peer
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("nothing to change");
    expect(readJson(RECORD(dir)).envAdded).toContain("HONCHO_LEADER_PEER");
    const env = readJson(SETTINGS(dir)).env;
    expect("HONCHO_LEADER_PEER" in env).toBe(true);
    expect("HONCHO_OWNER_PEER" in env).toBe(true);
  });

  test("a pre-existing key with the SAME value is left, not recorded, and survives uninstall", async () => {
    const dir = mkProject({ settings: { env: { HONCHO_URL: "http://10.9.9.9/v3" } }, mcp: mcpFixture });
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(readJson(RECORD(dir)).envAdded).toEqual(["HONCHO_WORKSPACE"]); // the owner's key is not ours
    const r2 = await run(dir, ["--uninstall"]);
    expect(r2.code, r2.all).toBe(0);
    expect(r2.all).toContain("left env keys HONCHO_URL");
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBe("http://10.9.9.9/v3");
  });

  test("a pre-existing key with a DIFFERENT value refuses with zero writes, naming the key only", async () => {
    const dir = mkProject({ settings: { env: { HONCHO_URL: "http://not-ours/v3" } }, mcp: mcpFixture });
    const before = readBytes(SETTINGS(dir));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("env.HONCHO_URL"); // names the key...
    expect(r.all).not.toContain("not-ours"); // ...never the value
    expect(r.all).toContain("nothing written");
    expect(readBytes(SETTINGS(dir)).equals(before)).toBe(true);
    expect(existsSync(join(dir, ".claude", "openrig-honcho"))).toBe(false); // not even the folder
  });

  test("a pre-existing rig_memory enabled entry (first install) survives uninstall", async () => {
    const dir = mkProject({
      settings: { env: {}, enabledMcpjsonServers: ["other_server", "rig_memory"] },
      mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    expect(readJson(RECORD(dir)).enabledAdded).toBe(false); // we appended nothing
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("left enabledMcpjsonServers entry rig_memory");
    expect(readJson(SETTINGS(dir)).enabledMcpjsonServers).toEqual(["other_server", "rig_memory"]);
  });

  test("v0.1.1 install (no record): uninstall removes our present names and says so", async () => {
    const dir = mkProject({
      settings: v011Settings({ HONCHO_URL: "u1", HONCHO_WORKSPACE: "w1", HONCHO_FOREIGN: "keep-me" }, ["other_server", "rig_memory"]),
      mcp: v011Mcp });
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("no install record: treating present names as added (v0.1.1 install)");
    expect(readJson(SETTINGS(dir)).env).toEqual({ HONCHO_FOREIGN: "keep-me" }); // foreign HONCHO_* kept
    expect(readJson(SETTINGS(dir)).enabledMcpjsonServers).toEqual(["other_server"]);
    expect(readJson(MCP(dir)).mcpServers.rig_memory).toBeUndefined();
    expect(backupNames(dir).length).toBe(2); // both rewritten files are backed up in our folder
  });

  test("install over a v0.1.1 install changes our names and writes the record (rule 5 before rule 3)", async () => {
    const dir = mkProject({
      settings: v011Settings({ HONCHO_URL: "http://old/v3", HONCHO_WORKSPACE: "honcho-bridge-scratch-old" }, ["rig_memory"]),
      mcp: v011Mcp });
    const r = await run(dir, INSTALL); // different values than the v0.1.1 install's
    expect(r.code, r.all).toBe(0); // NOT a rule-3 refusal: no record + our proof
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBe("http://10.9.9.9/v3");
    expect(readJson(RECORD(dir))).toEqual({
      version: 1,
      plugin: PLUGIN,
      envAdded: ["HONCHO_URL", "HONCHO_WORKSPACE"],
      enabledAdded: true, // rule 5: the present entry counts as added
    });
  });

  test("T13c: install and dry-run over a v0.1.1 install say so; a fresh install does not", async () => {
    const dir = mkProject({
      settings: v011Settings({ HONCHO_URL: "http://old/v3", HONCHO_WORKSPACE: "honcho-bridge-scratch-old" }, ["rig_memory"]),
      mcp: v011Mcp });
    const dry = await run(dir, [...INSTALL, "--dry-run"]);
    expect(dry.code, dry.all).toBe(0);
    expect(dry.all).toContain("no install record: treating present names as added (v0.1.1 install)");
    expect(existsSync(join(dir, ".claude", "openrig-honcho"))).toBe(false); // dry-run still writes nothing
    const real = await run(dir, INSTALL);
    expect(real.code, real.all).toBe(0);
    expect(real.all).toContain("no install record: treating present names as added (v0.1.1 install)");
    const fresh = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const f = await run(fresh, INSTALL);
    expect(f.code, f.all).toBe(0);
    expect(f.all).not.toContain("v0.1.1 install"); // first installs stay silent about v0.1.1
  });

  test("ruling (d): a valid record is uninstall proof even with the hooks and server hand-removed", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    const s = readJson(SETTINGS(dir));
    delete s.hooks;
    writeFileSync(SETTINGS(dir), `${JSON.stringify(s, null, 2)}\n`);
    const m = readJson(MCP(dir));
    delete m.mcpServers.rig_memory;
    writeFileSync(MCP(dir), `${JSON.stringify(m, null, 2)}\n`);
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("not installed from");
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBeUndefined();
    expect(existsSync(RECORD(dir))).toBe(false);
  });

  test("crash-window shape: a record naming keys settings does not have uninstalls cleanly", async () => {
    // the state ruling (c) can leave: install.json renamed, settings not yet
    const dir = mkProject({ settings: { env: { KEEP: "1" } } });
    writeRecord(dir, `${JSON.stringify({ version: 1, plugin: PLUGIN, envAdded: ["HONCHO_URL", "HONCHO_WORKSPACE"], enabledAdded: false }, null, 2)}\n`);
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0); // absent names are skipped
    expect(readJson(SETTINGS(dir)).env).toEqual({ KEEP: "1" });
    expect(existsSync(RECORD(dir))).toBe(false);
  });

  const badRecords: Array<[string, unknown]> = [
    ["corrupt", "this is not json {{{"],
    ["wrong version", { version: 2, plugin: PLUGIN, envAdded: [], enabledAdded: true }],
    ["foreign env name (ruling (b))", { version: 1, plugin: PLUGIN, envAdded: ["HONCHO_MALLORY"], enabledAdded: false }],
    ["duplicate names (ruling (b))", { version: 1, plugin: PLUGIN, envAdded: ["HONCHO_URL", "HONCHO_URL"], enabledAdded: false }],
    ["missing key", { version: 1, plugin: PLUGIN, envAdded: [] }],
    ["extra key", { version: 1, plugin: PLUGIN, envAdded: [], enabledAdded: false, note: "x" }],
    ["another plugin path", { version: 1, plugin: "/somewhere/else/plugin", envAdded: [], enabledAdded: false }],
  ];
  for (const [label, rec] of badRecords) {
    test(`rule 6: ${label} record refuses BOTH directions with zero writes`, async () => {
      const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
      writeRecord(dir, typeof rec === "string" ? rec : `${JSON.stringify(rec, null, 2)}\n`);
      const before = { s: readBytes(SETTINGS(dir)), m: readBytes(MCP(dir)), r: readBytes(RECORD(dir)) };
      for (const extra of [INSTALL, ["--uninstall"]]) {
        const r = await run(dir, extra);
        expect(r.code, `${label} ${extra.join(" ")}: ${r.all}`).toBe(1);
        expect(r.all).toContain("install.json");
        expect(r.all).toContain("nothing written");
        expect(readBytes(SETTINGS(dir)).equals(before.s)).toBe(true);
        expect(readBytes(MCP(dir)).equals(before.m)).toBe(true);
        expect(readBytes(RECORD(dir)).equals(before.r)).toBe(true);
      }
      expect(backupNames(dir)).toEqual([]);
    });
  }

  test("rule 6: a symlinked record or folder is refused; the link and its target survive", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    writeFileSync(join(dir, "planted.json"), "{}\n");
    mkdirSync(join(dir, ".claude", "openrig-honcho"), { recursive: true });
    symlinkSync("../../planted.json", RECORD(dir));
    let r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("symlink");
    expect(lstatSync(RECORD(dir)).isSymbolicLink()).toBe(true);

    const dir2 = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    mkdirSync(join(dir2, "elsewhere-folder"));
    symlinkSync("../elsewhere-folder", join(dir2, ".claude", "openrig-honcho"));
    r = await run(dir2, ["--uninstall"]);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("symlink");
    expect(lstatSync(join(dir2, ".claude", "openrig-honcho")).isSymbolicLink()).toBe(true);
  });

  test("dry-run prints the same names and creates NOTHING - not even the folder", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const r = await run(dir, [...INSTALL, "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("record: install.json");
    expect(r.all).toContain("no files written");
    expect(existsSync(join(dir, ".claude", "openrig-honcho"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([".claude", ".mcp.json"]);
  });

  test("no value ever appears in ANY output across a record round trip (seeded fake secrets)", async () => {
    const seeded = {
      ...settingsFixture,
      env: { ...settingsFixture.env, HONCHO_FOREIGN: "sk-fake-secret-foreign-not-a-key" } };
    const dir = mkProject({ settings: seeded, mcp: mcpFixture });
    const r1 = await run(dir, [...INSTALL, "--leader", "lead-seat"]);
    const r2 = await run(dir, ["--uninstall"]);
    for (const out of [r1.all, r2.all]) {
      expect(out).not.toContain("sk-fake-secret-foreign");
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain("lead-seat");
    }
    // rule 4 (03:58Z): the LEFT name is stated (names only, never the value)
    expect(r2.all).toContain("left env keys HONCHO_FOREIGN");
    expect(readJson(SETTINGS(dir)).env.HONCHO_FOREIGN).toBe("sk-fake-secret-foreign-not-a-key");
  });
});

describe("install-project: T14c apply lock", () => {
  const LOCK = (d: string) => join(d, ".claude", "openrig-honcho", "install.lock");
  const plantLock = (d: string, body: string): void => {
    mkdirSync(join(d, ".claude", "openrig-honcho"), { recursive: true });
    writeFileSync(LOCK(d), body, { mode: 0o600 });
  };

  test("live-pid lock refuses: exit 1, settings byte-identical, the foreign lock untouched", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const before = readBytes(SETTINGS(dir));
    plantLock(dir, JSON.stringify({ pid: process.pid, at: "2026-10-31T03:00:00.000Z" }));
    const lockBefore = readBytes(LOCK(dir));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain(`another install or uninstall is running in this project (pid ${process.pid})`);
    expect(readBytes(SETTINGS(dir)).equals(before)).toBe(true); // nothing written
    expect(readBytes(LOCK(dir)).equals(lockBefore)).toBe(true); // someone else's: never touched
    expect(backupNames(dir)).toEqual([]);
    expect(existsSync(join(dir, ".claude", "skills", "rig-memory"))).toBe(false);
  });

  test("dead-pid lock is stale: said in the output, taken over, nothing left after the install", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited; // reaped: the pid is gone
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    plantLock(dir, JSON.stringify({ pid: dead.pid, at: "2026-10-31T03:00:00.000Z" }));
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("stale");
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBe("http://10.9.9.9/v3");
    expect(readJson(join(dir, ".claude", "openrig-honcho", "install.json")).plugin).toContain("openrig-honcho");
    expect(existsSync(LOCK(dir))).toBe(false); // released
  });

  test("garbage lock is stale: said in the output, taken over, nothing left after the install", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    plantLock(dir, "this is not JSON at all\n");
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("stale");
    expect(readJson(SETTINGS(dir)).env.HONCHO_URL).toBe("http://10.9.9.9/v3");
    expect(existsSync(LOCK(dir))).toBe(false); // released
  });

  test("dry-run takes no lock and still creates no folder", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    const r = await run(dir, [...INSTALL, "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(join(dir, ".claude", "openrig-honcho"))).toBe(false);
    expect(existsSync(LOCK(dir))).toBe(false);
  });

  test("no lock is left after a successful install, a refusal and an uninstall", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    expect(existsSync(LOCK(dir))).toBe(false); // success releases
    // a refusal AFTER the lock was taken (F3 preflight: unwritable target) -
    // the lock goes with the refusal
    const dir2 = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    chmodSync(MCP(dir2), 0o444);
    const r2 = await run(dir2, INSTALL);
    expect(r2.code, r2.all).toBe(1);
    expect(r2.all).toContain("not readable+writable");
    expect(existsSync(LOCK(dir2))).toBe(false);
    expect((await run(dir, ["--uninstall"])).code).toBe(0);
    expect(existsSync(LOCK(dir))).toBe(false); // uninstall leaves no lock behind
  });
});

// ---------------------------------------------------------------------------
// T14e-1: v0.1.2 -> v0.2 upgrade and uninstall proof with the recall group.

describe("install-project: v0.1.2 upgrade to v0.2 (T14e)", () => {
  const RECORD = (d: string) => join(d, ".claude/openrig-honcho", "install.json");

  // the v0.1.2 shape: a real install of THIS plugin with the recall group
  // taken back out - exactly one UserPromptSubmit group of ours (the writer)
  // with the foreign group before it; the foreign secret-shaped env value,
  // permissions.deny and the foreign Notification hook come from the
  // pilot fixture. install.json is the real record of this plugin path.
  const mkV012 = async (): Promise<string> => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    const s = readJson(SETTINGS(dir));
    s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit.filter(
      (g: unknown) => !JSON.stringify(g).includes("bin/recall.ts"),
    );
    expect(s.hooks.UserPromptSubmit.length).toBe(2); // foreign + writer
    writeFileSync(SETTINGS(dir), `${JSON.stringify(s, null, 2)}\n`);
    return dir;
  };

  // everything except our hook groups, as one string: byte identity and key
  // order for ALL foreign content, before vs after
  const foreignOnly = (s: { hooks: Record<string, unknown[]> } & Record<string, unknown>): string => {
    const hooks = {} as Record<string, unknown[]>;
    for (const ev of Object.keys(s.hooks)) {
      hooks[ev] = s.hooks[ev].filter((g) => !JSON.stringify(g).includes("/plugin/bin/"));
    }
    return JSON.stringify({ ...s, hooks });
  };

  test("upgrade: our block becomes [recall, writer] at the writer's position; foreign bytes identical; envAdded kept; no secret echo", async () => {
    const dir = await mkV012();
    const before = readJson(SETTINGS(dir));
    const beforeForeign = foreignOnly(before);
    const envAddedBefore = readJson(RECORD(dir)).envAdded;
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    const after = readJson(SETTINGS(dir));
    expect(after.hooks.UserPromptSubmit.length).toBe(3);
    expect(after.hooks.UserPromptSubmit[0]).toEqual(settingsFixture.hooks.UserPromptSubmit[0]); // foreign unmoved
    expect(JSON.stringify(after.hooks.UserPromptSubmit[1])).toContain("bin/recall.ts");
    expect(JSON.stringify(after.hooks.UserPromptSubmit[2])).toContain("bin/user-prompt.ts");
    expect(foreignOnly(after)).toBe(beforeForeign);
    expect(readJson(RECORD(dir)).envAdded).toEqual(envAddedBefore);
    for (const secret of [TOKEN, MODEL]) expect(r.all).not.toContain(secret);
  });

  test("uninstall after the upgrade removes BOTH our UserPromptSubmit groups; settings equal to the pre-install file", async () => {
    const dir = await mkV012();
    expect((await run(dir, INSTALL)).code).toBe(0);
    const r = await run(dir, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    const s = readJson(SETTINGS(dir));
    expect(s.hooks.UserPromptSubmit).toEqual(settingsFixture.hooks.UserPromptSubmit); // foreign only, in order
    expect(JSON.stringify(Object.keys(s))).toBe(JSON.stringify(Object.keys(settingsFixture)));
    expect(s).toEqual(settingsFixture);
    expect(JSON.stringify(readJson(MCP(dir)))).toBe(JSON.stringify(mcpFixture));
  });

  test("only the recall group deleted: a re-run puts it back inside our block, foreign unmoved", async () => {
    const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
    expect((await run(dir, INSTALL)).code).toBe(0);
    const before = readJson(SETTINGS(dir));
    before.hooks.UserPromptSubmit = before.hooks.UserPromptSubmit.filter(
      (g: unknown) => !JSON.stringify(g).includes("bin/recall.ts"),
    );
    writeFileSync(SETTINGS(dir), `${JSON.stringify(before, null, 2)}\n`);
    const r = await run(dir, INSTALL);
    expect(r.code, r.all).toBe(0);
    const after = readJson(SETTINGS(dir));
    expect(after.hooks.UserPromptSubmit.length).toBe(3);
    expect(JSON.stringify(after.hooks.UserPromptSubmit[1])).toContain("bin/recall.ts"); // restored inside the block
    expect(JSON.stringify(after.hooks.UserPromptSubmit[2])).toContain("bin/user-prompt.ts");
    expect(foreignOnly(after)).toBe(foreignOnly(before));
  });
});

// ---------------------------------------------------------------------------
// T14e-2: the two lock windows. The window tests use the installer's test
// seam (HONCHO_INSTALL_SEAM_MS): the taker pauses inside each takeover
// window after writing a marker, so the test opens exactly the window under
// test and puts a live lock into it. The last test races two real losers on
// one dead lock (the seam-free path) seven times.

describe("install-project: the T14e lock windows", () => {
  const RECORD = (d: string) => join(d, ".claude/openrig-honcho", "install.json");
  const REC = (d: string) => join(d, ".claude", "openrig-honcho");
  const LOCKF = (d: string) => join(REC(d), "install.lock");

  const spawnTake = (dir: string, extra: string[], seam: boolean) =>
    Bun.spawn([BUN, BIN, dir, ...extra], {
      stdout: "pipe",
      stderr: "pipe",
      env: seam ? { ...process.env, HONCHO_INSTALL_SEAM_MS: "1200" } : process.env });

  const collect = async (p: ReturnType<typeof spawnTake>): Promise<{ code: number; all: string }> => {
    const [out, err] = await Promise.all([
      new Response(p.stdout as ReadableStream).text(),
      new Response(p.stderr as ReadableStream).text(),
    ]);
    return { code: await p.exited, all: `${out}\n${err}` };
  };

  const waitFor = async (file: string, budgetMs = 10_000): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs) {
      if (existsSync(file)) return true;
      await Bun.sleep(15);
    }
    return false;
  };

  const deadPid = async (): Promise<number> => {
    const d = Bun.spawn(["true"]);
    await d.exited;
    return d.pid;
  };

  const seedLock = (dir: string, pid: number): void => {
    mkdirSync(REC(dir), { recursive: true });
    writeFileSync(LOCKF(dir), `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`);
  };

  test(
    "window (a): released as we checked - a third racer's live lock is NOT removed, we refuse and write nothing",
    async () => {
      const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
      seedLock(dir, await deadPid());
      const p = spawnTake(dir, INSTALL, true);
      // the create lost; inside the window before judging the holder releases
      expect(await waitFor(join(REC(dir), `install.seam1.${p.pid}`)), "seam1 marker").toBe(true);
      rmSync(LOCKF(dir));
      // the read saw the release (gone); now inside the takeover window a
      // third racer takes the lock - the old code would rmSync right over it
      expect(await waitFor(join(REC(dir), `install.seam2.${p.pid}`)), "seam2 marker").toBe(true);
      writeFileSync(LOCKF(dir), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      const r = await collect(p);
      expect(r.code, r.all).toBe(1);
      expect(r.all).toContain("refusing");
      expect(readJson(LOCKF(dir)).pid).toBe(process.pid); // the live lock survived: not removed
      expect(existsSync(RECORD(dir))).toBe(false); // the loser wrote nothing
      expect(readdirSync(REC(dir)).some((f) => f.includes("install.lock.stale"))).toBe(false);
    },
    25_000,
  );

  test(
    "window (b): judged stale but really replaced - the fresher bytes are put back and we refuse",
    async () => {
      const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
      seedLock(dir, await deadPid());
      const p = spawnTake(dir, INSTALL, true);
      // we judged the dead-pid lock stale; inside the takeover window a live
      // racer's content replaces the file - the old code would rm it and win
      expect(await waitFor(join(REC(dir), `install.seam2.${p.pid}`)), "seam2 marker").toBe(true);
      writeFileSync(LOCKF(dir), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      const r = await collect(p);
      expect(r.code, r.all).toBe(1);
      expect(r.all).toContain("refusing");
      expect(readJson(LOCKF(dir)).pid).toBe(process.pid); // the fresher lock was restored, not eaten
      expect(existsSync(RECORD(dir))).toBe(false);
      expect(readdirSync(REC(dir)).some((f) => f.includes(".stale-"))).toBe(false);
    },
    25_000,
  );

  test(
    "two real losers on one dead lock, 7 times: no corruption, at most one takeover announcement, always one installed block",
    async () => {
      for (let i = 0; i < 7; i++) {
        const dir = mkProject({ settings: settingsFixture, mcp: mcpFixture });
        seedLock(dir, await deadPid());
        const a = spawnTake(dir, INSTALL, false);
        const b = spawnTake(dir, INSTALL, false);
        const [ra, rb] = await Promise.all([collect(a), collect(b)]);
        // each loser either took its turn or refused; never another exit
        expect([0, 1]).toContain(ra.code);
        expect([0, 1]).toContain(rb.code);
        const s = readJson(SETTINGS(dir)); // parses: no torn final bytes
        expect(s.hooks.UserPromptSubmit.length).toBe(3); // exactly [foreign, recall, writer]
        expect(JSON.stringify(s.hooks.UserPromptSubmit[1])).toContain("bin/recall.ts");
        expect(readJson(RECORD(dir)).envAdded).toContain("HONCHO_URL");
        expect(existsSync(LOCKF(dir))).toBe(false);
        expect(readdirSync(REC(dir)).some((f) => f.includes(".stale-"))).toBe(false);
      }
    },
    120_000,
  );
});

// T15b (ADR-0010 decision 1): a parent folder's .claude/settings.local.json
// applies to seats opened in its subfolders, so an install there already runs
// our hooks for this folder. A subfolder install then SKIPS hooks (everything
// else installs), removes ours if an earlier install added them, and never
// writes outside the target. The ancestor is recognised by a hook command
// naming one of our four bins inside a folder named openrig-honcho - a decoy
// path under /home/x names a clone we never touch.
describe("install-project: T15b ancestor hook guard", () => {
  const RECORD = (d: string) => join(d, ".claude/openrig-honcho/install.json");
  const PSETTINGS = (d: string, file: string) => join(d, ".claude", file);
  const OUR_CLONE = "/home/x/clone/openrig-honcho/plugin/bin";
  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

  // one group per event, all four bins - a real ancestor install's shape,
  // from a DIFFERENT plugin dir (pilot's own copy of the repo)
  const ancestorOurs = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `bun run "${OUR_CLONE}/session-start.ts"` }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: `bun run "${OUR_CLONE}/recall.ts"` }] }],
      Stop: [{ hooks: [{ type: "command", command: `bun run "${OUR_CLONE}/stop.ts"` }] }] } };
  const ancestorForeign = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo parent-foreign" }] }] } };

  // outer (the ancestor) / pods (the target), both temp; caller seeds the
  // ancestor file it wants
  function mkNested(): { outer: string; inner: string } {
    const outer = makeTempDir("install-anc-");
    mkdirSync(join(outer, ".claude"), { recursive: true });
    const inner = join(outer, "pods");
    mkdirSync(inner);
    return { outer, inner };
  }

  test("ancestor settings.local.json runs our hooks: everything installs except hooks", async () => {
    const { outer, inner } = mkNested();
    writeFileSync(PSETTINGS(outer, "settings.local.json"), `${JSON.stringify(ancestorOurs, null, 2)}\n`);
    const before = sha(readFileSync(PSETTINGS(outer, "settings.local.json")));
    const r = await run(inner, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooks: skipped, ${outer} already runs them for this folder`);
    const s = readJson(SETTINGS(inner));
    expect(s.hooks).toBeUndefined(); // no hooks key at all here
    expect(s.env.HONCHO_URL).toBe("http://10.9.9.9/v3"); // env still installs
    expect(s.env.HONCHO_WORKSPACE).toBe("honcho-bridge-scratch-inst");
    expect(s.enabledMcpjsonServers).toContain("rig_memory"); // enabled list too
    expect(readJson(MCP(inner)).mcpServers.rig_memory).toBeDefined(); // .mcp.json is NOT inherited
    expect(existsSync(join(inner, ".claude/skills/rig-memory/SKILL.md"))).toBe(true); // skill too
    expect(readJson(RECORD(inner)).hooksSkipped).toBe(outer); // record names the ancestor
    expect(sha(readFileSync(PSETTINGS(outer, "settings.local.json")))).toBe(before); // ancestor untouched
    rmSync(outer, { recursive: true, force: true });
  });

  test("ancestor settings.json (not .local) also skips hooks", async () => {
    const { outer, inner } = mkNested();
    writeFileSync(PSETTINGS(outer, "settings.json"), `${JSON.stringify(ancestorOurs, null, 2)}\n`);
    const r = await run(inner, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooks: skipped, ${outer} already runs them for this folder`);
    expect(readJson(SETTINGS(inner)).hooks).toBeUndefined();
    rmSync(outer, { recursive: true, force: true });
  });

  test("ancestor with ONLY foreign hooks: no skip, today's behaviour", async () => {
    const { outer, inner } = mkNested();
    writeFileSync(PSETTINGS(outer, "settings.local.json"), `${JSON.stringify(ancestorForeign, null, 2)}\n`);
    const r = await run(inner, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    const s = readJson(SETTINGS(inner));
    expect(Object.keys(s.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]); // installed as today
    expect(readJson(RECORD(inner)).hooksSkipped).toBeUndefined(); // record keeps the old key set
    expect(Object.keys(readJson(RECORD(inner))).sort().join(",")).toBe("enabledAdded,envAdded,plugin,version");
    rmSync(outer, { recursive: true, force: true });
  });

  test("ancestor file is invalid JSON: ignored for the check, hooks install", async () => {
    const { outer, inner } = mkNested();
    writeFileSync(PSETTINGS(outer, "settings.local.json"), "{{{not json");
    const r = await run(inner, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(Object.keys(readJson(SETTINGS(inner)).hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    rmSync(outer, { recursive: true, force: true });
  });

  test("our hooks here AND an ancestor runs them: ours removed here, foreign unmoved", async () => {
    const { outer, inner } = mkNested();
    // seed the inner with the pilot-shaped fixture and a completed install (no ancestor yet)
    mkdirSync(join(inner, ".claude"), { recursive: true });
    writeFileSync(SETTINGS(inner), `${JSON.stringify(settingsFixture, null, 2)}\n`);
    expect((await run(inner, INSTALL)).code).toBe(0);
    expect(Object.keys(readJson(SETTINGS(inner)).hooks.SessionStart).length).toBeGreaterThan(0);
    // now the parent gets an install of its own
    writeFileSync(PSETTINGS(outer, "settings.local.json"), `${JSON.stringify(ancestorOurs, null, 2)}\n`);
    const before = sha(readFileSync(PSETTINGS(outer, "settings.local.json")));
    const r = await run(inner, INSTALL);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooks: skipped, ${outer} already runs them for this folder`);
    const s = readJson(SETTINGS(inner));
    // every event keeps exactly the fixture's foreign groups, in order, ours gone
    for (const ev of Object.keys(settingsFixture.hooks)) {
      expect(s.hooks[ev]).toEqual(settingsFixture.hooks[ev as keyof typeof settingsFixture.hooks]);
    }
    expect(readJson(RECORD(inner)).hooksSkipped).toBe(outer);
    expect(sha(readFileSync(PSETTINGS(outer, "settings.local.json")))).toBe(before);
    rmSync(outer, { recursive: true, force: true });
  });

  test("uninstall after a skipped install: settings back to pre-install, ancestor never touched", async () => {
    const { outer, inner } = mkNested();
    writeFileSync(PSETTINGS(outer, "settings.local.json"), `${JSON.stringify(ancestorOurs, null, 2)}\n`);
    const ancestorBefore = sha(readFileSync(PSETTINGS(outer, "settings.local.json")));
    mkdirSync(join(inner, ".claude"), { recursive: true });
    writeFileSync(SETTINGS(inner), `${JSON.stringify(settingsFixture, null, 2)}\n`);
    writeFileSync(MCP(inner), `${JSON.stringify(mcpFixture, null, 2)}\n`);
    expect((await run(inner, INSTALL)).code).toBe(0);
    expect(readJson(SETTINGS(inner)).hooks).toEqual(settingsFixture.hooks); // only the fixture's foreign groups; ours never added
    const r = await run(inner, ["--uninstall"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("removed our hooks"); // nothing of ours was here to remove
    const sAfter = readJson(SETTINGS(inner));
    expect(JSON.stringify(Object.keys(sAfter))).toBe(JSON.stringify(Object.keys(settingsFixture))); // key order kept
    expect(sAfter).toEqual(settingsFixture); // equal as data
    expect(readJson(SETTINGS(inner)).env.ANTHROPIC_AUTH_TOKEN).toBe(TOKEN); // foreign env restored
    expect(readJson(MCP(inner))).toEqual(mcpFixture);
    expect(existsSync(RECORD(inner))).toBe(false);
    expect(existsSync(join(inner, ".claude/skills/rig-memory"))).toBe(false);
    expect(sha(readFileSync(PSETTINGS(outer, "settings.local.json")))).toBe(ancestorBefore);
    rmSync(outer, { recursive: true, force: true });
  });

  test("--dry-run with an ancestor: says the same, changes nothing", async () => {
    const { outer, inner } = mkNested();
    writeFileSync(PSETTINGS(outer, "settings.local.json"), `${JSON.stringify(ancestorOurs, null, 2)}\n`);
    const before = sha(readFileSync(PSETTINGS(outer, "settings.local.json")));
    const r = await run(inner, [...INSTALL, "--dry-run"]);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooks: skipped, ${outer} already runs them for this folder`);
    expect(existsSync(SETTINGS(inner))).toBe(false); // nothing written
    expect(existsSync(join(inner, ".claude"))).toBe(false); // not even the folder
    expect(sha(readFileSync(PSETTINGS(outer, "settings.local.json")))).toBe(before);
    rmSync(outer, { recursive: true, force: true });
  });
});
