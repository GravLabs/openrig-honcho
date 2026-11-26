// ADR-0021 decision 2 (v0.5.12, row B2): status reports whether our hooks
// actually run for this seat, and a relative --settings path resolves against
// the current folder instead of reporting the seat disabled. Unit tests drive
// findHookCoverage / readSettingsFile directly over temp folders; the bin
// tests run the REAL status bin against the local fake honcho. Nothing here
// touches the real ~/.claude, ~/.codex or the real server.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { scratchName } from "../support/scratch.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { codexHookGroups, findHookCoverage } from "../../plugin/src/hookCoverage.ts";
import { readSettingsFile } from "../../plugin/src/settings.ts";
import { autoMemoryState } from "../../plugin/src/status.ts";

const REPO = join(import.meta.dir, "..", "..");
const CLONE = "/home/x/clone/openrig-honcho/bin"; // decoy: a clone we never touch
const OUR_HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `bun run "${CLONE}/session-start.ts"` }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `bun run "${CLONE}/recall.ts"` }] }],
    Stop: [{ hooks: [{ type: "command", command: `bun run "${CLONE}/stop.ts"` }] }] } };
const FOREIGN_HOOKS = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };

const LOCAL = (d: string): string => join(d, ".claude", "settings.local.json");
const putSettings = (dir: string, file: string, obj: unknown): string => {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const path = join(dir, ".claude", file);
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return path;
};

describe("hookCoverage: findHookCoverage, claude harness", () => {
  test("own settings.local.json runs our hooks", () => {
    const cwd = makeTempDir("hc-local-");
    const f = putSettings(cwd, "settings.local.json", OUR_HOOKS);
    expect(findHookCoverage({ cwd, home: makeTempDir("hc-home-"), harness: "claude" }))
      .toEqual({ present: true, where: f });
  });

  test("project settings.json (not .local) covers it", () => {
    const cwd = makeTempDir("hc-proj-");
    const f = putSettings(cwd, "settings.json", OUR_HOOKS);
    expect(findHookCoverage({ cwd, home: makeTempDir("hc-home-"), harness: "claude" }).where).toBe(f);
  });

  test("the user's ~/.claude/settings.json covers it", () => {
    const cwd = makeTempDir("hc-cwd-");
    const home = makeTempDir("hc-home-");
    const f = putSettings(home, "settings.json", OUR_HOOKS);
    expect(findHookCoverage({ cwd, home, harness: "claude" }).where).toBe(f);
  });

  test("ancestor inside the same git working tree covers it", () => {
    const root = makeTempDir("hc-git-");
    mkdirSync(join(root, ".git"));
    const f = putSettings(root, "settings.local.json", OUR_HOOKS);
    const cwd = join(root, "pods");
    mkdirSync(cwd);
    expect(findHookCoverage({ cwd, home: makeTempDir("hc-home-"), harness: "claude" }).where).toBe(f);
  });

  test("ancestor with NO working tree covers nothing (plain-folder shape)", () => {
    const root = makeTempDir("hc-nogit-"); // temp: no .git anywhere at or above
    putSettings(root, "settings.local.json", OUR_HOOKS);
    const cwd = join(root, "pods");
    mkdirSync(cwd);
    expect(findHookCoverage({ cwd, home: makeTempDir("hc-home-"), harness: "claude" }))
      .toEqual({ present: false, where: null });
  });

  test("ancestor ABOVE the working-tree root covers nothing", () => {
    const outer = makeTempDir("hc-above-");
    putSettings(outer, "settings.local.json", OUR_HOOKS);
    const repo = join(outer, "repo");
    mkdirSync(repo);
    mkdirSync(join(repo, ".git"));
    const cwd = join(repo, "pods");
    mkdirSync(cwd);
    expect(findHookCoverage({ cwd, home: makeTempDir("hc-home-"), harness: "claude" }).present).toBe(false);
  });

  test("F-A (R25): seat IS the working-tree root - nothing above it counts", () => {
    // probe A T3 / probe C S4: a seat folder that is itself the git root,
    // with our hooks only in a folder ABOVE that root (every pilot's
    // root seat hit exactly this). Claude applies nothing from
    // above the root, so the installer must write and status must say miss.
    const outer = makeTempDir("hc-fa-");
    putSettings(outer, "settings.local.json", OUR_HOOKS);
    const repo = join(outer, "repo");
    mkdirSync(repo);
    mkdirSync(join(repo, ".git"));
    expect(findHookCoverage({ cwd: repo, home: makeTempDir("hc-home-"), harness: "claude" }))
      .toEqual({ present: false, where: null });
  });

  test("item 5 (R25 amendment): plugin-mode Claude seat - the plugin hooks.json counts", () => {
    const outer = makeTempDir("hc-pm-");
    const proot = join(outer, "openrig-honcho"); // identity: a folder named openrig-honcho (T15b)
    mkdirSync(join(proot, "hooks"), { recursive: true });
    const seat = makeTempDir("hc-pm-seat-"); // settings name no bins (enabledPlugins only)
    // plugin root set WITHOUT a hooks.json: still missing
    expect(findHookCoverage({ cwd: seat, home: makeTempDir("hc-home-"), harness: "claude", pluginRoot: proot }).present)
      .toBe(false);
    // the real plugin/hooks/hooks.json shape: ${CLAUDE...} literal, expanded
    // by findHookCoverage exactly as Claude Code expands it at load time
    const cmd = 'bun run "' + "${CLAUDE_PLUGIN_ROOT}" + '/bin/session-start.ts"';
    writeFileSync(
      join(proot, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: cmd }] }] } }),
    );
    const hit = findHookCoverage({ cwd: seat, home: makeTempDir("hc-home-"), harness: "claude", pluginRoot: proot });
    expect(hit.present).toBe(true);
    expect(hit.where).toBe(join(proot, "hooks", "hooks.json"));
    expect(hit.from).toBe(proot); // human line: hooks come from <plugin root>
  });

  test("N-G24 (R25 recheck): plugin mode tests ONLY the bin name - a renamed plugin copy still covers", () => {
    // probe G G7/G10: the release ships the folder as plugin/, so the OLD
    // rule (openrig-honcho segment required) read hooks: missing for a live
    // plugin seat. <pluginRoot>/hooks/hooks.json is the RUNNING plugin's own
    // file: there only the bin-name test applies after the expansion.
    const seat = makeTempDir("hc-ng24-seat-");
    const mkPlugin = (leaf: string, bin: string): string => {
      const proot = join(makeTempDir("hc-ng24-"), leaf);
      mkdirSync(join(proot, "hooks"), { recursive: true });
      writeFileSync(
        join(proot, "hooks", "hooks.json"),
        JSON.stringify({
          hooks: { UserPromptSubmit: [{ hooks: [{ type: "command",
            command: 'bun run "' + "${CLAUDE_PLUGIN_ROOT}" + "/bin/" + bin + '.ts"' }] }] },
        }),
      );
      return proot;
    };
    const renamed = mkPlugin("rig-memory", "recall"); // no openrig-honcho segment anywhere
    const hit = findHookCoverage({ cwd: seat, home: makeTempDir("hc-home-"), harness: "claude", pluginRoot: renamed });
    expect(hit.present).toBe(true);
    expect(hit.from).toBe(renamed);
    // bin-name-only still means OUR bins: bin/other.ts is not coverage (G8 shape)
    const foreign = mkPlugin("rig-memory", "other");
    expect(findHookCoverage({ cwd: seat, home: makeTempDir("hc-home-"), harness: "claude", pluginRoot: foreign }).present)
      .toBe(false);
  });

  test("ancestor with ONLY foreign hooks covers nothing", () => {
    const root = makeTempDir("hc-fore-");
    mkdirSync(join(root, ".git"));
    putSettings(root, "settings.local.json", FOREIGN_HOOKS);
    const cwd = join(root, "pods");
    mkdirSync(cwd);
    expect(findHookCoverage({ cwd, home: makeTempDir("hc-home-"), harness: "claude" }).present).toBe(false);
  });
});

describe("hookCoverage: findHookCoverage, codex harness", () => {
  const seat = (): { s: string; settings: string } => {
    const s = makeTempDir("hc-cx-");
    const dir = join(s, ".codex", "openrig-honcho");
    mkdirSync(dir, { recursive: true });
    const settings = join(dir, "settings.json");
    writeFileSync(settings, '{"HONCHO_URL":"http://127.0.0.1:9/v3"}\n');
    chmodSync(settings, 0o600);
    return { s, settings };
  };

  test("hooks.json beside the settings folder names our bins: present", () => {
    const { s, settings } = seat();
    const hooksJson = join(s, ".codex", "hooks.json");
    writeFileSync(hooksJson, `${JSON.stringify(OUR_HOOKS, null, 2)}\n`);
    expect(findHookCoverage({ cwd: s, home: makeTempDir("hc-home-"), harness: "codex", settingsPath: settings }))
      .toEqual({ present: true, where: hooksJson });
  });

  test("no hooks.json: absent", () => {
    const { s, settings } = seat();
    expect(findHookCoverage({ cwd: s, home: makeTempDir("hc-home-"), harness: "codex", settingsPath: settings }).present)
      .toBe(false);
  });

  test("no --settings path at all: absent", () => {
    const { s } = seat();
    expect(findHookCoverage({ cwd: s, home: makeTempDir("hc-home-"), harness: "codex", settingsPath: null }).present)
      .toBe(false);
  });

  test("F-B (R25, probe C S2): a hook-skipped seat is covered by its FULL ancestor layer", () => {
    const root = makeTempDir("hc-cx-root-");
    mkdirSync(join(root, ".git")); // the default root marker sits at the project root
    mkdirSync(join(root, ".codex", "openrig-honcho"), { recursive: true });
    const ancSettings = join(root, ".codex", "openrig-honcho", "settings.json");
    writeFileSync(ancSettings, '{"HONCHO_URL":"http://127.0.0.1:9/v3"}\n');
    const ancHooks = join(root, ".codex", "hooks.json");
    // EXACTLY the bytes the installer leaves there: the full group set
    // rebuilt against the ANCESTOR's own settings path (C5l)
    writeFileSync(ancHooks, `${JSON.stringify({ hooks: codexHookGroups(ancSettings) }, null, 2)}\n`);
    // the hook-skipped seat: settings only, NO own hooks.json
    const pods = join(root, "pods");
    mkdirSync(join(pods, ".codex", "openrig-honcho"), { recursive: true });
    const settings = join(pods, ".codex", "openrig-honcho", "settings.json");
    writeFileSync(settings, '{"HONCHO_URL":"http://127.0.0.1:9/v3"}\n');
    chmodSync(settings, 0o600);
    const home = makeTempDir("hc-home-"); // no config.toml: default markers [".git"]
    const r = findHookCoverage({ cwd: pods, home, harness: "codex", settingsPath: settings });
    expect(r.present).toBe(true);
    expect(r.where).toBe(ancHooks);
    expect(r.from).toBe(root); // status words it "hooks come from <ancestor>"
    // the S2 variant: ancestor file removed after install - never trust
    // the skip shape alone, the bytes must still be there
    rmSync(ancHooks);
    expect(findHookCoverage({ cwd: pods, home, harness: "codex", settingsPath: settings }).present).toBe(false);
  });
});

describe("settings: relative --settings resolves against cwd (ADR-0021 d2)", () => {
  test("a relative path reads the file under the current folder", () => {
    const dir = makeTempDir("hc-rel-");
    const before = process.cwd();
    try {
      process.chdir(dir);
      writeFileSync(join(dir, "rel-settings.json"), '{"HONCHO_URL":"http://127.0.0.1:9/v3","HONCHO_PEER":"p"}\n');
      chmodSync(join(dir, "rel-settings.json"), 0o600);
      const r = readSettingsFile(["--harness", "codex", "--settings", "rel-settings.json"]);
      expect(r.problem).toBeNull();
      expect(r.vars.HONCHO_URL).toBe("http://127.0.0.1:9/v3");
    } finally {
      process.chdir(before);
    }
  });

  test("a relative path to an absent file reports settings-missing, not settings-relative-path", () => {
    const dir = makeTempDir("hc-rel-abs-");
    const before = process.cwd();
    try {
      process.chdir(dir);
      const r = readSettingsFile(["--harness", "codex", "--settings", "nope-settings.json"]);
      expect(r.problem).toBe("settings-missing");
    } finally {
      process.chdir(before);
    }
  });
});

describe("status bin: hooks line + exit code + relative --settings", () => {
  const spawnStatus = async (
    cwd: string,
    env: Record<string, string>,
    args: string[],
  ): Promise<{ code: number; out: string; err: string }> => {
    const p = Bun.spawn([process.execPath, join(REPO, "plugin/bin/status.ts"), ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    return { code: await p.exited, out, err };
  };

  const baseEnv = (dir: string, url: string, over: Record<string, string> = {}): Record<string, string> => ({
    HOME: dir,
    HONCHO_STATE_DIR: dir,
    HONCHO_URL: url,
    HONCHO_WORKSPACE: scratchName(),
    HONCHO_PEER: "hookcov-test-peer",
    HONCHO_API_KEY: "sk-ant-HookCovBinFake0123456789abcdefG", // fake-secret
    HONCHO_TIMEOUT_MS: "2000",
    ...over });

  test("claude seat without hooks: exit 1, hooks.present false, the exact line", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    try {
      const seatDir = makeTempDir("hc-bin-nohooks-"); // no settings anywhere, HOME apart
      const home = makeTempDir("hc-bin-home-");
      const env = { ...baseEnv(home, fake.url), HOME: home, HONCHO_STATE_DIR: home };
      const j = await spawnStatus(seatDir, env, ["--json"]);
      expect(j.code, j.out + j.err).toBe(1);
      const parsed = JSON.parse(j.out) as Record<string, any>;
      expect(parsed.hooks).toEqual({ present: false, where: null });
      expect(parsed.healthy).toBe(false);
      const h = await spawnStatus(seatDir, env, []);
      expect(h.out).toContain(
        `hooks: missing - this seat records nothing and is shown no memory; run the install in ${seatDir}`,
      );
    } finally {
      await fake.stop();
    }
  });

  test("codex seat, RELATIVE --settings: works, hooks from hooks.json, exit 0", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    try {
      const s = makeTempDir("hc-bin-cx-");
      const dir = join(s, ".codex", "openrig-honcho");
      mkdirSync(dir, { recursive: true });
      const settingsPath = join(dir, "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: scratchName(),
          HONCHO_PEER: "hookcov-cx-peer",
          HONCHO_API_KEY: "sk-ant-HookCovCxFake0123456789abcdefHI", // fake-secret
          HONCHO_TIMEOUT_MS: "2000",
        }, null, 2) + "\n",
      );
      chmodSync(settingsPath, 0o600);
      writeFileSync(join(s, ".codex", "hooks.json"), `${JSON.stringify(OUR_HOOKS, null, 2)}\n`);
      const env = { HOME: s, HONCHO_STATE_DIR: s }; // NO HONCHO_*: settings file is the only source
      const r = await spawnStatus(s, env, [
        "--harness", "codex", "--settings", ".codex/openrig-honcho/settings.json", "--json",
      ]);
      expect(r.code, r.out + r.err).toBe(0);
      const j = JSON.parse(r.out) as Record<string, any>;
      expect(j.healthy).toBe(true);
      expect(j.hooks.present).toBe(true);
      expect(j.hooks.where).toBe(join(s, ".codex", "hooks.json"));
    } finally {
      await fake.stop();
    }
  });

  // ADR-0021 decision 6: one auto-memory line; on does NOT make the seat unhealthy.
  test("claude seat with our key: exit 0, the off line, auto_memory in JSON", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    try {
      const seatDir = makeTempDir("hc-bin-am-off-");
      const home = makeTempDir("hc-bin-am-home-");
      putSettings(seatDir, "settings.local.json", { ...OUR_HOOKS, autoMemoryEnabled: false });
      const env = { ...baseEnv(home, fake.url), HOME: home, HONCHO_STATE_DIR: home };
      const r = await spawnStatus(seatDir, env, []);
      expect(r.code, r.out + r.err).toBe(0); // hooks present: healthy
      expect(r.out).toContain(`auto-memory: off - autoMemoryEnabled=false in ${LOCAL(seatDir)}`);
      const j = await spawnStatus(seatDir, env, ["--json"]);
      const am = JSON.parse(j.out).auto_memory;
      expect(am.off).toBe(true);
      expect(am.detail).toContain("settings.local.json"); // N-R26-3: names the file
    } finally {
      await fake.stop();
    }
  });

  test("claude seat WITHOUT the key stays healthy: the on line, default and true variants", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    try {
      const seatDir = makeTempDir("hc-bin-am-on-");
      const home = makeTempDir("hc-bin-am-home2-");
      const env = { ...baseEnv(home, fake.url), HOME: home, HONCHO_STATE_DIR: home };
      putSettings(seatDir, "settings.local.json", OUR_HOOKS); // no key at all
      const r1 = await spawnStatus(seatDir, env, []);
      expect(r1.code, r1.out + r1.err).toBe(0); // on is NOT unhealthy
      expect(r1.out).toContain("auto-memory: on - no autoMemoryEnabled in "); // N-R26-3: names all three, then the default
      expect(r1.out).toContain("(Claude default: on)");
      putSettings(seatDir, "settings.local.json", { ...OUR_HOOKS, autoMemoryEnabled: true }); // user's own
      const r2 = await spawnStatus(seatDir, env, []);
      expect(r2.code, r2.out + r2.err).toBe(0);
      expect(r2.out).toContain(`auto-memory: on - autoMemoryEnabled=true in ${LOCAL(seatDir)}`);
    } finally {
      await fake.stop();
    }
  });
});

describe("autoMemoryState (ADR-0021 d6, N-R26-3 precedence)", () => {
  test("absent everywhere: on with the default detail naming the chain", () => {
    const dir = makeTempDir("am-absent-");
    const home = makeTempDir("am-home-");
    const st = autoMemoryState(dir, home);
    expect(st.off).toBe(false);
    expect(st.detail).toContain("(Claude default: on)");
    expect(st.detail).toContain(join(dir, ".claude", "settings.local.json"));
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("a present-but-unreadable folder-local file is the honest answer", () => {
    const dir = makeTempDir("am-broken-");
    const home = makeTempDir("am-home2-");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.local.json"), "{{{not json\n");
    const st = autoMemoryState(dir, home);
    expect(st.off).toBe(false);
    expect(st.detail).toContain("no readable JSON");
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("the first source that sets the key wins: local, then project, then user", () => {
    const home = makeTempDir("am-home3-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify({ autoMemoryEnabled: false }, null, 2)}\n`);
    const a = makeTempDir("am-user-"); // nothing in the folder: the user file decides
    expect(autoMemoryState(a, home)).toEqual({
      off: true,
      detail: `autoMemoryEnabled=false in ${join(home, ".claude", "settings.json")}`,
    });
    const b = makeTempDir("am-proj-"); // project false wins over user false (first setter)
    putSettings(b, "settings.json", { autoMemoryEnabled: false });
    expect(autoMemoryState(b, home).detail).toContain(join(b, ".claude", "settings.json"));
    const c = makeTempDir("am-local-"); // local true beats project false
    putSettings(c, "settings.json", { autoMemoryEnabled: false });
    putSettings(c, "settings.local.json", { autoMemoryEnabled: true });
    const sc = autoMemoryState(c, home);
    expect(sc.off).toBe(false);
    expect(sc.detail).toContain(join(c, ".claude", "settings.local.json"));
    expect(sc.detail).toContain("autoMemoryEnabled=true");
    for (const d of [home, a, b, c]) rmSync(d, { recursive: true, force: true });
  });
});
