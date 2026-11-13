// C5b (ADR-0016 decisions 4+7+9): install-project.ts --harness codex, spawned
// as the REAL bin against a temp seat folder and a temp CODEX_HOME (row).
// Since C5c the installer also maintains its own trust block in the temp
// user layer (trust cases are pinned in install-codex-trust.test.ts).
// Marked dummy values only - the marker word itself is not a secret.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;

const URL_ = "http://10.9.9.9/v3";
const WS = "honcho-bridge-scratch-c5b";
const CODEX_INSTALL = ["--harness", "codex", "--url", URL_, "--workspace", WS];

const BEGIN = "# BEGIN openrig-honcho rig_memory (managed - do not edit inside)";
const END = "# END openrig-honcho rig_memory";

/** a temp seat + a temp CODEX_HOME (never the real ~/.codex) */
function mkSeat(): { dir: string; codexHome: string; env: Record<string, string> } {
  const dir = makeTempDir("install-codex-");
  const codexHome = makeTempDir("install-codex-home-");
  return { dir, codexHome, env: { ...process.env, CODEX_HOME: codexHome } };
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

const HOOKS = (d: string) => join(d, ".codex/hooks.json");
const CONFIG = (d: string) => join(d, ".codex/config.toml");
const SETTINGS = (d: string) => join(d, ".codex/openrig-honcho/settings.json");
const RECORD = (d: string) => join(d, ".codex/openrig-honcho/install.json");
const BACKUPS = (d: string) => join(d, ".codex/openrig-honcho/backups");
const SKILLS = (d: string) => join(d, ".agents/skills/rig-memory");
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const backupNames = (d: string): string[] => (existsSync(BACKUPS(d)) ? readdirSync(BACKUPS(d)) : []);

describe("C5j: reinstall over a pre-C5j block refreshes it in place", () => {
  test("the env_vars line lands with a plain reinstall, nothing outside the block moves", async () => {
    const { dir, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    // make the seat look pre-C5j: our exact block minus the env_vars line
    const cfg = CONFIG(dir);
    const before = readFileSync(cfg, "utf8");
    const old = before
      .split("\n")
      .filter((l) => !l.startsWith("env_vars = "))
      .join("\n");
    expect(old).not.toBe(before); // the line we pretend away really exists
    writeFileSync(cfg, old);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("refreshed our managed rig_memory block in place");
    const after = readFileSync(cfg, "utf8");
    expect((Bun.TOML.parse(after) as any).mcp_servers.rig_memory.env_vars).toEqual([
      "OPENRIG_SESSION_NAME",
      "OPENRIG_URL",
    ]);
    // only that one line came back; the BEGIN/END framing and the rest are byte-equal
    expect(after).toBe(before);
  });
});

describe("codex install: create, idempotence, uninstall", () => {
  test("fresh seat: all four traces written in the Codex shapes, settings 600", async () => {
    const { dir, env } = mkSeat();
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    // hooks.json: PascalCase event keys, our flags on every command
    const h = readJson(HOOKS(dir));
    expect(Object.keys(h.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    expect(h.hooks.SessionStart[0].matcher).toContain("fork");
    const ups = h.hooks.UserPromptSubmit as any[];
    expect(ups.length).toBe(2); // recall first, user-prompt after, as Claude
    expect(ups[0].hooks[0].command).toContain("recall.ts");
    expect(ups[1].hooks[0].command).toContain("user-prompt.ts");
    for (const cmd of [
      h.hooks.SessionStart[0].hooks[0].command,
      ups[0].hooks[0].command,
      ups[1].hooks[0].command,
      h.hooks.Stop[0].hooks[0].command,
    ] as string[]) {
      expect(cmd).toContain("--harness codex");
      expect(cmd).toContain(`--settings "${SETTINGS(dir)}"`);
    }
    // config.toml: exactly our managed block, table header before any key
    const toml = readFileSync(CONFIG(dir), "utf8");
    expect(toml.startsWith(`${BEGIN}\n[mcp_servers.rig_memory]\n`)).toBe(true);
    expect(toml.trimEnd().endsWith(END)).toBe(true);
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    // the mcp args name THIS plugin's server, absolute like the hook commands
    expect(toml).toContain(join(REPO, "plugin/bin/mcp.ts"));
    // C5j: env_vars forwards EXACTLY the two non-HONCHO names mcp.ts reads
    // (Codex drops everything else from the environment), parsed not just
    // substringed, and HONCHO_* never appear - the settings file is their
    // only source on Codex (ADR-0016 d9)
    const parsed = Bun.TOML.parse(toml) as any;
    expect(parsed.mcp_servers.rig_memory.env_vars).toEqual(["OPENRIG_SESSION_NAME", "OPENRIG_URL"]);
    expect(toml).not.toContain("HONCHO_");
    // C5j: the install prints the exact status command for THIS seat
    expect(r.all).toContain(`status: bun run "${join(REPO, "plugin/bin/status.ts")}" --harness codex --settings "${SETTINGS(dir)}"`);
    // settings.json: our folder, mode 600, exactly the flag values
    expect(readJson(SETTINGS(dir))).toEqual({ HONCHO_URL: URL_, HONCHO_WORKSPACE: WS });
    expect(statMode(SETTINGS(dir))).toBe(0o600);
    // record + folder hygiene + skill
    const rec = readJson(RECORD(dir));
    expect(rec.harness).toBe("codex");
    expect(rec.hooksCreated).toBe(true);
    expect(rec.configCreated).toBe(true);
    expect(existsSync(join(dir, ".codex/openrig-honcho/.gitignore"))).toBe(true);
    expect(existsSync(join(SKILLS(dir), "SKILL.md"))).toBe(true);
  });

  const statMode = (p: string): number => {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    return statSync(p).mode & 0o777;
  };

  test("reinstall: nothing to change, no backups, files untouched", async () => {
    const { dir, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const before = { hooks: readFileSync(HOOKS(dir)), toml: readFileSync(CONFIG(dir)), set: readFileSync(SETTINGS(dir)) };
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("nothing to change (already installed)");
    expect(backupNames(dir)).toEqual([]);
    expect(readFileSync(HOOKS(dir)).equals(before.hooks)).toBe(true);
    expect(readFileSync(CONFIG(dir)).equals(before.toml)).toBe(true);
    expect(readFileSync(SETTINGS(dir)).equals(before.set)).toBe(true);
  });

  test("uninstall: back to the start, except backups/ and .gitignore stay", async () => {
    const { dir, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    // change one file so the uninstall has something to back up
    writeFileSync(SETTINGS(dir), JSON.stringify({ HONCHO_URL: "http://127.0.0.1:1/v3", HONCHO_WORKSPACE: WS }));
    chmodSync(SETTINGS(dir), 0o600);
    const r = await run(dir, ["--harness", "codex", "--uninstall"], env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(HOOKS(dir))).toBe(false);
    expect(existsSync(CONFIG(dir))).toBe(false);
    expect(existsSync(SETTINGS(dir))).toBe(false);
    expect(existsSync(RECORD(dir))).toBe(false);
    expect(existsSync(SKILLS(dir))).toBe(false);
    expect(existsSync(join(dir, ".codex/openrig-honcho/.gitignore"))).toBe(true);
    // C5d F8: two backups now - the settings.json we changed AND the
    // config.toml this install created and is removing (backup before rm).
    expect(backupNames(dir).length).toBe(2);
  });

  // O3 item 3 (ADR-0017): the Codex install accepts the same holdout setting
  // as the Claude install (one FLAG_ENV name for both harnesses), writes it
  // to the seat's settings file, and a reinstall keeps it. loadConfig's own
  // 0..0.9 rule is the installer's validator.
  test("O6 F-E: a reinstall WITHOUT --leader drops it; only the holdout carries, and says so", async () => {
    const { dir, env } = mkSeat();
    const r1 = await run(dir, [...CODEX_INSTALL, "--leader", "lead_x", "--recall-holdout", "0.4"], env);
    expect(r1.code).toBe(0);
    expect(readJson(SETTINGS(dir)).HONCHO_LEADER_PEER).toBe("lead_x");
    const r2 = await run(dir, CODEX_INSTALL, env); // revocation reinstall: no flags
    expect(r2.code).toBe(0);
    const s = readJson(SETTINGS(dir));
    expect(s.HONCHO_LEADER_PEER).toBeUndefined(); // the revocation now bites
    expect(s.HONCHO_RECALL_HOLDOUT).toBe("0.4"); // F-E: holdout-only carry-over
    expect(s.HONCHO_URL).toBe(URL_);
    expect(s.HONCHO_WORKSPACE).toBe(WS);
    expect(r2.all).toContain("holdout kept across reinstall: 0.4"); // one output line
  });

  test("O3 item 3: --recall-holdout lands in settings.json, a reinstall keeps it, a bad share refuses", async () => {
    const { dir, env } = mkSeat();
    const withHold = [...CODEX_INSTALL, "--recall-holdout", "0.5"];
    const held = { HONCHO_RECALL_HOLDOUT: "0.5", HONCHO_URL: URL_, HONCHO_WORKSPACE: WS };
    const r1 = await run(dir, withHold, env);
    expect(r1.code, r1.all).toBe(0);
    expect(readJson(SETTINGS(dir))).toEqual(held);
    // reinstall WITHOUT the flag: the holdout is ours, it is kept
    const r2 = await run(dir, CODEX_INSTALL, env);
    expect(r2.code, r2.all).toBe(0);
    expect(readJson(SETTINGS(dir))).toEqual(held);
    // reinstall WITH a new value: the flag wins
    const r3 = await run(dir, [...CODEX_INSTALL, "--recall-holdout", "0.2"], env);
    expect(r3.code, r3.all).toBe(0);
    expect(readJson(SETTINGS(dir))).toEqual({ ...held, HONCHO_RECALL_HOLDOUT: "0.2" });
    // an out-of-range share is loadConfig's refusal, zero writes
    const before = readFileSync(SETTINGS(dir), "utf8");
    const r4 = await run(dir, [...CODEX_INSTALL, "--recall-holdout", "0.95"], env);
    expect(r4.code).toBe(1);
    expect(r4.all).toContain("refusing bad input");
    expect(readFileSync(SETTINGS(dir), "utf8")).toBe(before);
    // uninstall removes the whole settings file, the holdout with it
    expect((await run(dir, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    expect(existsSync(SETTINGS(dir))).toBe(false);
  });

  test("F8: uninstall of a created config.toml leaves a backup - bytes typed inside our block survive", async () => {
    const { dir, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    expect(readFileSync(CONFIG(dir), "utf8").trimEnd().endsWith(END)).toBe(true);
    // the owner edits INSIDE our managed block - exactly the bytes that
    // leave with the block when the file is removed
    writeFileSync(CONFIG(dir), readFileSync(CONFIG(dir), "utf8").replace(END, `# owner note PLANTED-F8-MARKER\n${END}\n`));
    const r = await run(dir, ["--harness", "codex", "--uninstall"], env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(CONFIG(dir))).toBe(false); // it is gone...
    // ...and THE PIN: a backup file holds the planted marker. A test that
    // only asserted removal would pass without the F8 fix; this one dies.
    const held = backupNames(dir).filter((n) =>
      readFileSync(join(BACKUPS(dir), n), "utf8").includes("PLANTED-F8-MARKER"),
    );
    expect(held.length).toBe(1);
    expect(held[0]!.startsWith("config.toml.")).toBe(true);
  });

  test("foreign config.toml and hooks.json survive install AND uninstall byte for byte (TOML without trailing newline)", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const foreignToml = '[other]\nkey = "value"\ntrailing = 1'; // no trailing newline
    const foreignHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo foreign"}]}]}}';
    writeFileSync(CONFIG(dir), foreignToml);
    writeFileSync(HOOKS(dir), foreignHooks);
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const afterInstall = readFileSync(CONFIG(dir), "utf8");
    expect(afterInstall.startsWith(foreignToml)).toBe(true); // our bytes only appended
    expect(afterInstall.includes(BEGIN)).toBe(true);
    expect((await run(dir, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    // byte-for-byte back, including the missing trailing newline
    expect(readFileSync(CONFIG(dir), "utf8")).toBe(foreignToml);
    const h = readJson(HOOKS(dir));
    expect(JSON.stringify(h.hooks.PreToolUse)).toContain("echo foreign");
    expect(JSON.stringify(h)).not.toContain("session-start");
  });

  test("the TOML trap: a block appended after a [table.sub] still starts with its own header", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(CONFIG(dir), '[mcp_servers.other.env]\nSOME = "x"\n');
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const lines = readFileSync(CONFIG(dir), "utf8").split("\n");
    const b = lines.indexOf(BEGIN);
    expect(lines[b + 1]).toBe("[mcp_servers.rig_memory]"); // header before any key
  });
});

describe("codex install: refusals write nothing", () => {
  const refusedWith = async (dir: string, env: Record<string, string>, msg: string): Promise<void> => {
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain(msg);
    expect(existsSync(join(dir, ".codex/openrig-honcho/install.json"))).toBe(false);
  };

  test("config.toml with a foreign [mcp_servers.rig_memory] outside our block: refuse", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(CONFIG(dir), '[mcp_servers.rig_memory]\ncommand = "evil"\n');
    await refusedWith(dir, env, "exists outside our managed block");
    expect(readFileSync(CONFIG(dir), "utf8")).toContain("evil"); // untouched
  });

  test("a damaged managed block (BEGIN without END): refuse", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(CONFIG(dir), `${BEGIN}\n[mcp_servers.rig_memory]\n`);
    await refusedWith(dir, env, "managed block markers are damaged");
  });

  test("hooks.json that is not parseable JSON: refuse", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(HOOKS(dir), "{ not json");
    await refusedWith(dir, env, "not parseable JSON");
  });

  test("hooks.json running our bins from ANOTHER plugin folder: refuse", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      HOOKS(dir),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "bun run /other/openrig-honcho/plugin/bin/stop.ts" }] }],
        },
      }),
    );
    await refusedWith(dir, env, "different plugin folder");
  });

  test("user layer already running our hooks ($CODEX_HOME/hooks.json): refuse, user layer untouched", async () => {
    const { dir, codexHome, env } = mkSeat();
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "bun run /x/openrig-honcho/plugin/bin/stop.ts" }] }] },
      }),
    );
    const before = readFileSync(join(codexHome, "hooks.json"), "utf8");
    await refusedWith(dir, env, "already run in the Codex user layer");
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toBe(before);
  });

  test("user layer with our rig_memory server in config.toml: refuse", async () => {
    const { dir, codexHome, env } = mkSeat();
    writeFileSync(
      join(codexHome, "config.toml"),
      '[mcp_servers.rig_memory]\ncommand = "bun"\nargs = ["/x/openrig-honcho/plugin/bin/mcp.ts"]\n',
    );
    await refusedWith(dir, env, "already run in the Codex user layer");
  });

  test("a user layer that runs only the OpenRig relay: install proceeds", async () => {
    const { dir, codexHome, env } = mkSeat();
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/@openrig/cli/relay.cjs" }] }] },
      }),
    );
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
  });

  test("a symlinked .codex/hooks.json is refused, never followed", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const victim = join(dir, "victim.json");
    writeFileSync(victim, "{}\n");
    symlinkSync(victim, HOOKS(dir));
    await refusedWith(dir, env, "is a symlink");
  });

  test("a damaged install record, and one naming another plugin folder: refuse both ways", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex/openrig-honcho"), { recursive: true });
    writeFileSync(RECORD(dir), "{ nope");
    let r = await run(dir, CODEX_INSTALL, env);
    expect(r.code).toBe(1);
    expect(r.all).toContain("not parseable JSON");
    r = await run(dir, ["--harness", "codex", "--uninstall"], env);
    expect(r.code).toBe(1);
    writeFileSync(RECORD(dir), JSON.stringify({ version: 1, plugin: "/somewhere/else", harness: "codex", hooksCreated: true, hooksEvents: [], configCreated: false, configSep: false, configBlockAdded: false, skillsAdded: false }));
    r = await run(dir, ["--harness", "codex", "--uninstall"], env);
    expect(r.code).toBe(1);
    expect(r.all).toContain("different plugin path");
  });

  test("settings.json present without our record: refuse to overwrite a file we did not set", async () => {
    const { dir, env } = mkSeat();
    mkdirSync(join(dir, ".codex/openrig-honcho"), { recursive: true });
    writeFileSync(SETTINGS(dir, ), JSON.stringify({ HONCHO_URL: "http://owner.example/v3" }));
    chmodSync(SETTINGS(dir), 0o600);
    await refusedWith(dir, env, "without our install record");
    expect(readJson(SETTINGS(dir)).HONCHO_URL).toBe("http://owner.example/v3");
  });
});

describe("codex install: dry-run and the Claude default", () => {
  test("dry-run: keys and paths only, no values, nothing written", async () => {
    const { dir, env } = mkSeat();
    const r = await run(dir, ["--harness", "codex", "--url", "http://MARKED-VALUE.example/v3", "--workspace", WS, "--dry-run"], env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("dry-run");
    expect(r.all).toContain("settings.json: keys");
    expect(r.all).not.toContain("MARKED-VALUE");
    expect(existsSync(HOOKS(dir))).toBe(false);
    expect(existsSync(CONFIG(dir))).toBe(false);
    expect(existsSync(SETTINGS(dir))).toBe(false);
  });

  test("without --harness the Claude path installs (and writes no .codex files)", async () => {
    const { dir, env } = mkSeat();
    const r = await run(dir, ["--url", URL_, "--workspace", WS], env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(join(dir, ".claude/settings.local.json"))).toBe(true);
    expect(existsSync(HOOKS(dir))).toBe(false);
    expect(existsSync(CONFIG(dir))).toBe(false);
  });

  test("--harness with an unknown value: refuse before anything happens", async () => {
    const { dir, env } = mkSeat();
    const r = await run(dir, ["--harness", "copilot", "--url", URL_, "--workspace", WS], env);
    expect(r.code).toBe(1);
    expect(r.all).toContain("--harness takes claude or codex");
    expect(existsSync(HOOKS(dir))).toBe(false);
  });
});

describe("C5f F9: a seat inside a LINKED git worktree is refused", () => {
  // test-setup-only git (X5 constrains plugin/, not tests): a real
  // `git init` + `git worktree add` in temp folders - the same shape a real
  // seat gets, .git FILE pointing at <main>/.git/worktrees/<name>.
  const git = (cwd: string, ...args: string[]): void => {
    const p = Bun.spawnSync(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr?.toString() ?? ""}`);
  };

  test("refuses with zero writes and names the main checkout; a regular checkout installs", async () => {
    const repo = makeTempDir("install-c5f-repo-");
    git(repo, "init", "-q", ".");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    const wt = join(makeTempDir("install-c5f-wt-"), "wt");
    git(repo, "worktree", "add", "-q", "-b", "c5f-wt", wt);
    const seat = join(wt, "seat");
    mkdirSync(seat);
    const { codexHome, env } = mkSeat();
    const main = realpathSync(repo);
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code).toBe(1);
    expect(r.all).toContain("LINKED git worktree");
    expect(r.all).toContain(main); // names the folder Codex reads instead
    expect(r.all).toContain("nothing written");
    // zero writes: no project layer here (or in the worktree root), and the
    // user layer never created nor backed up (review pin: byte-identical, none)
    expect(existsSync(join(seat, ".codex"))).toBe(false);
    expect(existsSync(join(wt, ".codex"))).toBe(false);
    expect(readdirSync(seat)).toEqual([]);
    expect(readdirSync(codexHome)).toEqual([]);
    // positive control: a seat in a regular checkout (.git DIRECTORY above) installs
    const seat2 = join(repo, "seat2");
    mkdirSync(seat2);
    const r2 = await run(seat2, CODEX_INSTALL, env);
    expect(r2.code, r2.all).toBe(0);
    expect(existsSync(HOOKS(seat2))).toBe(true);
  });

  test("a .git FILE that is not the worktree shape (a submodule pointer) does not refuse", async () => {
    const { dir, env } = mkSeat();
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/modules/sub\n");
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(HOOKS(dir))).toBe(true);
  });
});

describe("install-codex: F4 dir modes + stale temp sweep (ADR-0018)", () => {
  const RECORD_DIR = (d: string) => join(d, ".codex", "openrig-honcho");

  test("a pre-existing record or backups folder at 0755 is tightened to 0700 by install", async () => {
    const seat = mkSeat();
    mkdirSync(BACKUPS(seat.dir), { recursive: true }); // creates the record dir too
    chmodSync(RECORD_DIR(seat.dir), 0o755);
    chmodSync(BACKUPS(seat.dir), 0o755);
    const r = await run(seat.dir, CODEX_INSTALL, seat.env);
    expect(r.code, r.all).toBe(0);
    expect(statSync(RECORD_DIR(seat.dir)).mode & 0o777).toBe(0o700);
    expect(statSync(BACKUPS(seat.dir)).mode & 0o777).toBe(0o700);
  });

  test("a dead pid's temp is swept in the seat AND the Codex home; live pid and lookalike survive", async () => {
    const seat = mkSeat();
    mkdirSync(join(seat.dir, ".codex"), { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited; // exited and reaped: kill(pid, 0) is ESRCH
    // the review leak: config.toml.tmp-<pid>-<x> in the CODEX_HOME held the
    // owner's merged config after a killed run; the seat's own temps too.
    const staleUserFull = join(seat.codexHome, `config.toml.tmp-${dead.pid}-def456`);
    const staleSeat = `${CONFIG(seat.dir)}.tmp-${dead.pid}-abc123`;
    writeFileSync(staleUserFull, "stale-user\n");
    writeFileSync(staleSeat, "stale-seat\n");
    const live = `${HOOKS(seat.dir)}.tmp-${process.pid}-live01`;
    writeFileSync(live, "live\n");
    const lookalike = `${CONFIG(seat.dir)}.tmp-notes`;
    writeFileSync(lookalike, "notes\n");
    const r = await run(seat.dir, CODEX_INSTALL, seat.env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(staleUserFull)).toBe(false);
    expect(existsSync(staleSeat)).toBe(false);
    expect(r.all).toContain("stale"); // one line: count + names only, never contents
    expect(readFileSync(live, "utf8")).toBe("live\n"); // live pid: still possibly mid-write
    expect(readFileSync(lookalike, "utf8")).toBe("notes\n"); // not our name shape
  });
});

describe("install-codex: F6 lock slot + stale wording (ADR-0018)", () => {
  const USER_LOCK = (home: string) => join(home, "openrig-honcho-install.lock");

  test("a DIRECTORY at the user-config lock slot is not a lock: refuse before any rename", async () => {
    const seat = mkSeat();
    mkdirSync(USER_LOCK(seat.codexHome), { recursive: true }); // a real folder at the slot
    const keep = join(USER_LOCK(seat.codexHome), "keep.txt");
    writeFileSync(keep, "keep\n");
    const r = await run(seat.dir, CODEX_INSTALL, seat.env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("is a directory");
    expect(r.all).toContain("not a lock file");
    expect(readFileSync(keep, "utf8")).toBe("keep\n"); // contents untouched
    expect(existsSync(CONFIG(seat.dir))).toBe(false); // nothing written to the seat
  });

  test("a dead-pid user-config lock prints the AFTER-THE-FACT line and proceeds", async () => {
    const seat = mkSeat();
    const dead = Bun.spawn(["true"]);
    await dead.exited; // reaped: the pid is gone
    writeFileSync(
      USER_LOCK(seat.codexHome),
      JSON.stringify({ pid: dead.pid, at: "2026-11-13T02:00:00.000Z" }),
      { mode: 0o600 },
    );
    const r = await run(seat.dir, CODEX_INSTALL, seat.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("Codex user config lock was stale");
    expect(r.all).toContain("and taken");
  });

  test("a live user-config lock: waited on, then the held-by refusal, no stale claim", async () => {
    const seat = mkSeat();
    writeFileSync(
      USER_LOCK(seat.codexHome),
      JSON.stringify({ pid: process.pid, at: "2026-11-13T02:00:00.000Z" }),
      { mode: 0o600 },
    );
    const r = await run(seat.dir, CODEX_INSTALL, { ...seat.env, HONCHO_CODEX_LOCK_WAIT_MS: "1" });
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain(`is held by pid ${process.pid}`);
    expect(r.all).not.toContain("stale"); // unchanged: waited on, never judged stale
  });
});
