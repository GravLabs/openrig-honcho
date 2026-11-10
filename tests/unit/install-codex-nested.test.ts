// C5d (the ADR-0010 shape on the Codex side): a Codex seat inside a folder
// whose ANCESTOR already runs our hooks skips hooks entirely - the record
// names the ancestor (hooksSkipped), everything else installs, the shared
// user-layer trust block stays untouched, and the inner uninstall never
// looks at or writes the ancestor's files. Temp seats and a temp CODEX_HOME
// only; marked dummy values.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;

const URL_ = "http://10.9.9.9/v3";
const WS = "honcho-bridge-scratch-c5d";
const CODEX_INSTALL = ["--harness", "codex", "--url", URL_, "--workspace", WS];

const BEGIN = "# BEGIN openrig-honcho rig_memory (managed - do not edit inside)";

function mkSeat(): { dir: string; codexHome: string; env: Record<string, string> } {
  // F12 (C5f): Codex only loads ancestor layers up to the project root
  // marker (.git, file or directory), so every skip fixture needs a marker
  // root joining the two folders - like a real repo, not bare /tmp.
  const root = makeTempDir("install-c5d-root-");
  mkdirSync(join(root, ".git"));
  const dir = join(root, "outer-seat");
  mkdirSync(dir);
  const codexHome = makeTempDir("install-c5d-home-");
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
const USER_CFG = (h: string) => join(h, "config.toml");
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const backupNames = (d: string): string[] => (existsSync(BACKUPS(d)) ? readdirSync(BACKUPS(d)) : []);
const USER_URL = ["--url", URL_, "--workspace", WS]; // Claude default harness

describe("codex nested seat: skip with hooksSkipped, everything else installs", () => {
  test("inner install skips hooks, names the ancestor, leaves the ancestor and user layer untouched", async () => {
    const outer = mkSeat();
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    const outerHooksBefore = readFileSync(HOOKS(outer.dir));
    const userBefore = readFileSync(USER_CFG(outer.codexHome));

    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooks: skipped, ${outer.dir} already runs them for this folder`);
    expect(r.all).toContain(`hooksSkipped: ${outer.dir}`);

    // no hooks of its own - the file was never created
    expect(existsSync(HOOKS(inner))).toBe(false);
    // the record says so and names the ancestor
    const rec = readJson(RECORD(inner));
    expect(rec.hooksSkipped).toBe(outer.dir);
    expect(rec.hooksCreated).toBe(false);
    expect(rec.hooksEvents).toEqual([]);
    // everything ELSE installs as usual
    expect(readFileSync(CONFIG(inner), "utf8")).toContain(BEGIN);
    expect(readJson(SETTINGS(inner))).toEqual({ HONCHO_URL: URL_, HONCHO_WORKSPACE: WS });
    expect(existsSync(join(SKILLS(inner), "SKILL.md"))).toBe(true);
    expect(rec.configBlockAdded).toBe(true);
    expect(rec.skillsAdded).toBe(true);
    // the ancestor's own hooks file is byte-identical, and the skipped
    // install stayed out of the shared user-layer trust block entirely
    expect(readFileSync(HOOKS(outer.dir)).equals(outerHooksBefore)).toBe(true);
    expect(readFileSync(USER_CFG(outer.codexHome)).equals(userBefore)).toBe(true);
    // and it recorded no trust of its own
    expect(rec.trustBlockAdded).toBe(false);
    expect(rec.trustKeys).toEqual([]);
  });

  test("reinstall of a skipped seat: nothing to change, no backups, bytes untouched", async () => {
    const outer = mkSeat();
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    expect((await run(inner, CODEX_INSTALL, outer.env)).code).toBe(0);
    const before = {
      config: readFileSync(CONFIG(inner)),
      settings: readFileSync(SETTINGS(inner)),
      record: readFileSync(RECORD(inner)),
    };
    expect(backupNames(inner)).toEqual([]);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("nothing to change (already installed)");
    expect(backupNames(inner)).toEqual([]);
    expect(readFileSync(CONFIG(inner)).equals(before.config)).toBe(true);
    expect(readFileSync(SETTINGS(inner)).equals(before.settings)).toBe(true);
    expect(readFileSync(RECORD(inner)).equals(before.record)).toBe(true);
  });

  test("inner uninstall: inner traces gone, outer files and user layer byte-identical", async () => {
    const outer = mkSeat();
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    expect((await run(inner, CODEX_INSTALL, outer.env)).code).toBe(0);
    const snap = {
      outerHooks: readFileSync(HOOKS(outer.dir)),
      outerConfig: readFileSync(CONFIG(outer.dir)),
      outerRecord: readFileSync(RECORD(outer.dir)),
      userCfg: readFileSync(USER_CFG(outer.codexHome)),
    };
    const r = await run(inner, ["--harness", "codex", "--uninstall"], outer.env);
    expect(r.code, r.all).toBe(0);
    // the inner seat is back to the start (its record went last)
    expect(existsSync(HOOKS(inner))).toBe(false);
    expect(existsSync(CONFIG(inner))).toBe(false);
    expect(existsSync(SETTINGS(inner))).toBe(false);
    expect(existsSync(RECORD(inner))).toBe(false);
    expect(existsSync(SKILLS(inner))).toBe(false);
    // the OUTER seat is untouched, byte for byte, and never consulted
    expect(readFileSync(HOOKS(outer.dir)).equals(snap.outerHooks)).toBe(true);
    expect(readFileSync(CONFIG(outer.dir)).equals(snap.outerConfig)).toBe(true);
    expect(readFileSync(RECORD(outer.dir)).equals(snap.outerRecord)).toBe(true);
    expect(readFileSync(USER_CFG(outer.codexHome)).equals(snap.userCfg)).toBe(true);
    expect(readJson(RECORD(outer.dir)).hooksSkipped).toBeUndefined();
  });

  test("a Claude-only ancestor does NOT skip the Codex install", async () => {
    const outer = mkSeat();
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(outer.dir, USER_URL, outer.env)).code).toBe(0); // Claude path
    expect(existsSync(join(outer.dir, ".claude/settings.local.json"))).toBe(true);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(existsSync(HOOKS(inner))).toBe(true); // Codex does not read .claude
    expect(readJson(RECORD(inner)).hooksSkipped).toBeUndefined();
  });

  test("an ancestor whose .codex/hooks.json runs foreign commands does NOT skip", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".codex"), { recursive: true });
    const foreign = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] },
    });
    writeFileSync(HOOKS(outer.dir), foreign);
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(existsSync(HOOKS(inner))).toBe(true);
    expect(readFileSync(HOOKS(outer.dir), "utf8")).toBe(foreign); // scan is read-only
  });

  // C5l S1: the skip predicate is EXACT equality with what our installer
  // writes for the ANCESTOR's own settings path - the fixture is that exact
  // Stop group, key order included (deepEqual is JSON.stringify order).
  const exactStopGroup = (ancestor: string) => ({
    hooks: [
      {
        type: "command",
        command:
          `bun run "${join(REPO, "plugin/bin/stop.ts")}" --harness codex ` +
          `--settings "${join(ancestor, ".codex/openrig-honcho/settings.json")}"`,
        timeout: 30,
      },
    ],
  });

  // C5l3 (fix 3) FLIPS this pin: ONE exact group used to skip (the first
  // test of this kind in C5d). It must not: a Stop-only ancestor turns
  // SessionStart and UserPromptSubmit off for every seat below it, while
  // installing would fire the event it DOES hold twice. The safe side is a
  // refusal that names the ancestor and the events.
  test("C5l3: an ancestor holding ONE of our groups only partially runs ours: refuse, zero writes", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".codex"), { recursive: true });
    writeFileSync(HOOKS(outer.dir), JSON.stringify({ hooks: { Stop: [exactStopGroup(outer.dir)] } }));
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).not.toBe(0);
    expect(r.all).toContain(`${outer.dir}: runs SOME of our hooks`);
    expect(r.all).toContain("Stop"); // what it holds
    expect(r.all).toContain("SessionStart"); // and what it dropped
    expect(r.all).not.toContain("hooks: skipped");
    // zero writes: the seat is untouched and the user layer never opened
    expect(existsSync(join(inner, ".codex"))).toBe(false);
    expect(existsSync(USER_CFG(outer.codexHome))).toBe(false);
  });

  test("C5l S1: a near-miss ancestor group (our bin, no --settings) does NOT skip", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".codex"), { recursive: true });
    // the PRE-C5l fixture shape: names our bin, is not one of our groups.
    // Skipping on it would let the seat trust an ancestor that runs
    // something else; not skipping is the safe side.
    writeFileSync(
      HOOKS(outer.dir),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `bun run ${join(REPO, "plugin/bin/stop.ts")} --harness codex` }] }],
        },
      }),
    );
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(existsSync(HOOKS(inner))).toBe(true);
  });

  // C5l2 (finding 3) + C5l3 (fixes 2 and 3) together define the skip rule:
  // rebuild our groups with the plugin folder READ FROM the ancestor's own
  // command (the quoted folder before /bin/<our bin>.ts, inside a folder
  // named openrig-honcho, whose bin files must EXIST - C5l3 F21), and skip
  // only when the ancestor holds EVERY one of our groups in EVERY event -
  // C5l3 fix 3, so a cross-copy fixture needs the full four-group shape.
  const OUR_BINS = ["session-start.ts", "recall.ts", "user-prompt.ts", "stop.ts"];
  const mkCopyTree = (): string => {
    // a stand-in for another plugin copy: like every real copy it sits
    // inside a folder named openrig-honcho, and (C5l3) its bins exist -
    // a folder whose bins are gone is a GHOST and runs nobody's hooks
    const copyRoot = join(makeTempDir("c5l3-copy-"), "openrig-honcho", "plugin");
    mkdirSync(join(copyRoot, "bin"), { recursive: true });
    for (const b of OUR_BINS) writeFileSync(join(copyRoot, "bin", b), "// stub\n");
    return copyRoot;
  };
  const crossCopyHooksFile = (ancestor: string, copyRoot: string): string => {
    const cmd = (n: string): string =>
      `bun run "${join(copyRoot, "bin", n)}" --harness codex ` +
      `--settings "${join(ancestor, ".codex/openrig-honcho/settings.json")}"`;
    // EXACTLY the four groups that copy's installer left (key order = the
    // stringify order): the full shape, since C5l3 the only one that skips
    return JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|clear|compact|fork",
            hooks: [{ type: "command", command: cmd("session-start.ts"), timeout: 8 }],
          },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: cmd("recall.ts"), timeout: 5 }] },
          { hooks: [{ type: "command", command: cmd("user-prompt.ts"), timeout: 30, async: true }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: cmd("stop.ts"), timeout: 30 }] }],
      },
    });
  };

  test("C5l3: the partial refusal writes nothing - an existing user config stays byte-exact", async () => {
    const outer = mkSeat();
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    // an owner trims the ancestor file down to just our Stop group
    writeFileSync(HOOKS(outer.dir), JSON.stringify({ hooks: { Stop: [exactStopGroup(outer.dir)] } }));
    const userBefore = readFileSync(USER_CFG(outer.codexHome));
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code).not.toBe(0);
    expect(r.all).toContain(`${outer.dir}: runs SOME of our hooks`); // names the ancestor
    expect(readFileSync(USER_CFG(outer.codexHome)).equals(userBefore)).toBe(true);
    expect(existsSync(join(inner, ".codex"))).toBe(false); // the seat is as it was
  });

  test("C5l3: uninstall works under a trimmed (partial) ancestor - a seat is always removable", async () => {
    const outer = mkSeat();
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(inner, CODEX_INSTALL, outer.env)).code).toBe(0); // skipped inner, outer still full
    writeFileSync(HOOKS(outer.dir), JSON.stringify({ hooks: { Stop: [exactStopGroup(outer.dir)] } }));
    const outerHooks = readFileSync(HOOKS(outer.dir));
    const r = await run(inner, ["--harness", "codex", "--uninstall"], outer.env);
    expect(r.code, r.all).toBe(0); // uninstall never consults the ancestor (C5d rule kept)
    expect(existsSync(RECORD(inner))).toBe(false);
    expect(existsSync(SETTINGS(inner))).toBe(false);
    expect(readFileSync(HOOKS(outer.dir)).equals(outerHooks)).toBe(true); // ancestor untouched
  });

  test("C5l2: an ancestor installed from a DIFFERENT plugin copy still skips", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".codex"), { recursive: true });
    writeFileSync(HOOKS(outer.dir), crossCopyHooksFile(outer.dir, mkCopyTree()));
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooks: skipped, ${outer.dir} already runs them for this folder`);
    expect(existsSync(HOOKS(inner))).toBe(false);
    expect(readJson(RECORD(inner)).hooksSkipped).toBe(outer.dir);
  });

  test("C5l3 F21: an ancestor whose plugin copy was DELETED does NOT skip - the child runs its own hooks", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".codex"), { recursive: true });
    const ghostCopy = mkCopyTree();
    writeFileSync(HOOKS(outer.dir), crossCopyHooksFile(outer.dir, ghostCopy));
    rmSync(ghostCopy, { recursive: true, force: true }); // the copy is gone: nobody runs there
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(existsSync(HOOKS(inner))).toBe(true); // not a partial either: no candidate matches
    expect(readJson(RECORD(inner)).hooksCreated).toBe(true);
  });

  test("C5l2: a cross-copy look-alike OUTSIDE an openrig-honcho folder does NOT skip", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".codex"), { recursive: true });
    // same command shape AND existing bins, so the ONLY disqualifier left
    // is the missing openrig-honcho segment: not our ancestor's hooks
    const lookAlike = join(makeTempDir("c5l2-fake-"), "plugin");
    mkdirSync(join(lookAlike, "bin"), { recursive: true });
    for (const b of OUR_BINS) writeFileSync(join(lookAlike, "bin", b), "// stub\n");
    writeFileSync(HOOKS(outer.dir), crossCopyHooksFile(outer.dir, lookAlike));
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(existsSync(HOOKS(inner))).toBe(true);
  });
});

describe("codex user config path is always printed (C5d)", () => {
  test("dry-run and install name the resolved user config; an unset CODEX_HOME says so", async () => {
    const { dir, codexHome, env } = mkSeat();
    const d = await run(dir, [...CODEX_INSTALL, "--dry-run"], env);
    expect(d.code, d.all).toBe(0);
    expect(d.all).toContain(`user config: ${join(codexHome, "config.toml")}`);
    const i = await run(dir, CODEX_INSTALL, env);
    expect(i.code, i.all).toBe(0);
    expect(i.all).toContain(`user config: ${join(codexHome, "config.toml")}`);
    expect(i.all).not.toContain("CODEX_HOME unset");
    // no CODEX_HOME at all: the fallback must be announced on the same
    // line. DRY-RUN ONLY - a real run without the export would resolve to
    // this machine's own ~/.codex, which no test may write (hard limit).
    const { dir: d2, env: env2 } = mkSeat();
    delete env2.CODEX_HOME;
    const u = await run(d2, [...CODEX_INSTALL, "--dry-run"], env2);
    expect(u.code, u.all).toBe(0);
    expect(u.all).toContain("CODEX_HOME unset - the ~/.codex default");
    expect(u.all).toContain(join(process.env.HOME ?? "", ".codex", "config.toml"));
  });
});

describe("C5f F10 (m3b): a symlinked ancestor path still skips with the real ancestor named", () => {
  test("installing the inner seat through a link to the outer still fires the skip", async () => {
    const outer = mkSeat();
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    const link = `${outer.dir}-link`;
    symlinkSync(outer.dir, link);
    // the seat handed in THROUGH THE LINK of its ancestor
    const r = await run(join(link, "inner-seat"), CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    const rec = readJson(RECORD(inner));
    expect(rec.hooksSkipped).toBe(outer.dir); // the REAL ancestor, not the link
    expect(existsSync(HOOKS(inner))).toBe(false);
    // and the inner's own paths name the real ancestor in its printout too
    expect(r.all).toContain(`hooks: skipped, ${outer.dir} already runs them`);
  });
});

describe("C5f F12 (review F12): the skip needs a root marker that joins the folders", () => {
  test("no marker anywhere above: NO skip - the inner installs its own hooks", async () => {
    const root = makeTempDir("install-c5d-nomark-");
    const outer = join(root, "outer-seat");
    mkdirSync(outer);
    const inner = join(outer, "inner-seat");
    mkdirSync(inner);
    const codexHome = makeTempDir("install-c5d-home-");
    const env = { ...process.env, CODEX_HOME: codexHome };
    expect((await run(outer, CODEX_INSTALL, env)).code).toBe(0);
    const r = await run(inner, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    const rec = readJson(RECORD(inner));
    expect(rec.hooksSkipped).toBeUndefined();
    expect(rec.hooksCreated).toBe(true);
    expect(existsSync(HOOKS(inner))).toBe(true); // the inner runs its own hooks
    // and it owns its own trust keys (4), under its own hooks path
    expect(rec.trustKeys.length).toBe(4);
    expect(rec.trustKeys.every((k: string) => k.startsWith(`${HOOKS(inner)}:`))).toBe(true);
  });

  test("a marker BETWEEN the folders: NO skip - Codex's walk stops below the ancestor", async () => {
    const outer = mkSeat();
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    const mid = join(outer.dir, "mid");
    mkdirSync(mid);
    mkdirSync(join(mid, ".git")); // project root below the ancestor
    const inner = join(mid, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(readJson(RECORD(inner)).hooksSkipped).toBeUndefined();
    expect(existsSync(HOOKS(inner))).toBe(true);
  });

  test("the marker AT the ancestor still joins them: skip fires", async () => {
    const outer = mkSeat();
    mkdirSync(join(outer.dir, ".git")); // the ancestor is itself the project root
    const inner = join(outer.dir, "inner-seat");
    mkdirSync(inner);
    expect((await run(outer.dir, CODEX_INSTALL, outer.env)).code).toBe(0);
    const r = await run(inner, CODEX_INSTALL, outer.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooksSkipped: ${outer.dir}`); // the root layer loads
    expect(existsSync(HOOKS(inner))).toBe(false);
  });
});

describe("C5g F15 + C5h F16 (review F15/F16): project_root_markers from the user layer drives the rule", () => {
  // A fixture WITHOUT the .git root mkSeat plants - these cases are about
  // what the configured markers do. Absent and EMPTY stay distinct: absent
  // means [".git"]; empty DISABLES root detection in Codex (loader/mod.rs),
  // so no ancestor ever loads.
  function mkLayout(userCfg: string | null): {
    root: string;
    outer: string;
    env: Record<string, string>;
  } {
    const root = makeTempDir("install-c5g-");
    const outer = join(root, "outer-seat");
    mkdirSync(outer);
    const codexHome = makeTempDir("install-c5g-home-");
    if (userCfg !== null) writeFileSync(join(codexHome, "config.toml"), userCfg);
    return { root, outer, env: { ...process.env, CODEX_HOME: codexHome } };
  }

  test("pin 1 - absent setting: the .git default stands, package.json is not a marker", async () => {
    const f = mkLayout(null);
    writeFileSync(join(f.root, "package.json"), "{}\n");
    expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
    const inner = join(f.outer, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, f.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    expect(existsSync(HOOKS(inner))).toBe(true);
  });

  test("pin 2 - custom marker package.json (review x6): the ancestor joins and the skip fires", async () => {
    const f = mkLayout('project_root_markers = ["package.json"]\n');
    writeFileSync(join(f.root, "package.json"), "{}\n");
    expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
    const inner = join(f.outer, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, f.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`hooksSkipped: ${f.outer}`);
    expect(existsSync(HOOKS(inner))).toBe(false);
  });

  test("pin 3 - EMPTY list (review x7): root detection off, no skip, own 4 hooks", async () => {
    const f = mkLayout("project_root_markers = []\n");
    mkdirSync(join(f.root, ".git")); // must NOT fall back to the .git default
    writeFileSync(join(f.root, "package.json"), "{}\n");
    expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
    const inner = join(f.outer, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, f.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).not.toContain("hooks: skipped");
    const rec = readJson(RECORD(inner));
    expect(rec.hooksSkipped).toBeUndefined();
    expect(rec.hooksCreated).toBe(true);
    expect(rec.trustKeys.length).toBe(4); // its own four, under its own path
    expect(rec.trustKeys.every((k: string) => k.startsWith(`${HOOKS(inner)}:`))).toBe(true);
  });

  test("scalar value: keep the .git default AND say so, naming the Codex consequence (z1)", async () => {
    const f = mkLayout('project_root_markers = "package.json"\n');
    writeFileSync(join(f.root, "package.json"), "{}\n");
    expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
    const inner = join(f.outer, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, f.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("project_root_markers is not an array of strings");
    expect(r.all).toContain("Codex itself refuses the whole config"); // TRUE here: z1 loads 0 hooks
    expect(r.all).not.toContain("hooks: skipped"); // .git default: package.json is not a marker
    expect(existsSync(HOOKS(inner))).toBe(true);
  });

  test("mixed array (string + number): the same warning, still true (z1b)", async () => {
    const f = mkLayout('project_root_markers = ["package.json", 5]\n');
    writeFileSync(join(f.root, "package.json"), "{}\n");
    expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
    const inner = join(f.outer, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, f.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("project_root_markers is not an array of strings");
    expect(r.all).toContain("Codex itself refuses the whole config");
    expect(r.all).not.toContain("hooks: skipped"); // .git default: package.json is not a marker
    expect(existsSync(HOOKS(inner))).toBe(true);
  });

  test("whole file does not parse as TOML: say SO (not the marker wording), keep .git", async () => {
    const f = mkLayout("this is not = = toml\n");
    writeFileSync(join(f.root, "package.json"), "{}\n");
    expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0); // install still proceeds
    const inner = join(f.outer, "inner-seat");
    mkdirSync(inner);
    const r = await run(inner, CODEX_INSTALL, f.env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("does not parse as TOML");
    expect(r.all).toContain("Codex itself refuses the whole config");
    expect(r.all).not.toContain("project_root_markers is not an array of strings"); // not blamed on the key
    expect(r.all).not.toContain("hooks: skipped"); // .git default: package.json is not a marker
    expect(existsSync(HOOKS(inner))).toBe(true);
    // READ-ONLY for the marker read: our TOML never serialises back over
    // the file - the only change is the managed trust block APPENDED, so
    // the original bytes stand as the prefix.
    const after = readFileSync(join(f.env.CODEX_HOME, "config.toml"), "utf8");
    expect(after.startsWith("this is not = = toml\n")).toBe(true);
    expect(after).toContain("# BEGIN openrig-honcho hooks trust");
  });

  // C5h (review F16): Codex reads real TOML, so the three shapes it accepts
  // must drive the skip - before the Bun.TOML fix each one printed the
  // refusal warning and fell back to .git, and the inner installed its own
  // hooks anyway: the F15 double load (review x.py g6/g7/g8, w.py measured
  // 8 hooks where 4 were loaded from the ancestor).
  const validShapes: [string, string][] = [
    ["multi-line array", 'project_root_markers = [\n  "package.json",\n]\n'], // x.py g6
    ["trailing comma", 'project_root_markers = ["package.json",]\n'], // x.py g7
    ["single-quoted string", "project_root_markers = ['package.json']\n"], // x.py g8
  ];
  for (const [name, cfg] of validShapes) {
    test(`C5h F16 - ${name}: Codex accepts it, so the marker counts and the skip fires`, async () => {
      const f = mkLayout(cfg);
      writeFileSync(join(f.root, "package.json"), "{}\n");
      expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
      const inner = join(f.outer, "inner-seat");
      mkdirSync(inner);
      const r = await run(inner, CODEX_INSTALL, f.env);
      expect(r.code, r.all).toBe(0);
      expect(r.all).not.toContain("Codex itself refuses the whole config"); // a LIE for these shapes
      expect(r.all).toContain(`hooksSkipped: ${f.outer}`);
      expect(existsSync(HOOKS(inner))).toBe(false); // no second set: Codex loads the ancestor 4, not 8
    });
  }

  // C5i (review s13/s14): an EMPTY-STRING entry. The old hand parser refused
  // the array; Bun.TOML accepts it, and real Codex (review s13/s14) then
  // stops root detection AT THE SEAT and runs the seat's own 4 hooks - so
  // the honest outcome is NO skip and own hooks, exactly what we do: a ""
  // joined onto a folder is that folder, which makes the seat itself the
  // root. A tidy-up that treats "" as "no entry" would fake a skip Codex
  // never honours; these pins keep it from happening quietly.
  const emptyEntryShapes: [string, string][] = [
    ["s13 - package.json plus an empty entry", 'project_root_markers = ["package.json", ""]\n'],
    ["s14 - only an empty entry", 'project_root_markers = [""]\n'],
  ];
  for (const [name, cfg] of emptyEntryShapes) {
    test(`C5i - ${name}: no skip (the seat is itself a root), own hooks, no warning`, async () => {
      const f = mkLayout(cfg);
      writeFileSync(join(f.root, "package.json"), "{}\n");
      expect((await run(f.outer, CODEX_INSTALL, f.env)).code).toBe(0);
      const inner = join(f.outer, "inner-seat");
      mkdirSync(inner);
      const r = await run(inner, CODEX_INSTALL, f.env);
      expect(r.code, r.all).toBe(0);
      expect(r.all).not.toContain("Codex itself refuses the whole config"); // valid TOML, valid array
      expect(r.all).not.toContain("hooks: skipped"); // a skip here would be dishonest: Codex stops at the seat
      const rec = readJson(RECORD(inner));
      expect(rec.hooksSkipped).toBeUndefined();
      expect(rec.hooksCreated).toBe(true); // the seat runs its own, like Codex measures
      expect(existsSync(HOOKS(inner))).toBe(true);
    });
  }
});
