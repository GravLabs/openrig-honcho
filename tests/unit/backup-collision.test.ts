// C5b review (architect): backups are stamped per second, so an install and
// an uninstall inside the SAME SECOND both name <file>.<stamp> - and the
// second copy must not clobber the first. One pin per harness: the original
// pre-install bytes must still be there after the round trip. Pins are timed
// to start ~50 ms into a fresh second so both spawns land inside it.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;

const URL_ = "http://10.9.9.9/v3";
const WS = "honcho-bridge-scratch-backup";

/** sleep into the next second so the two spawns share one stamp second */
async function startNearSecondStart(): Promise<void> {
  await Bun.sleep(1050 - (Date.now() % 1000));
}

async function run(dir: string, extra: string[]): Promise<{ code: number; all: string }> {
  const p = Bun.spawn([BUN, BIN, dir, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CODEX_HOME: makeTempDir("backup-collision-home-") },
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  return { code: await p.exited, all: `${out}\n${err}` };
}

/** names in backups/ that carry the given file's stamp prefix */
const stamped = (dir: string, rel: string, prefix: string): string[] => {
  const bdir = join(dir, rel);
  if (!existsSync(bdir)) return [];
  return readdirSync(bdir).filter((f) => f.startsWith(prefix));
};

describe("same-second backups: the first copy is never overwritten", () => {
  test("codex: config.toml keeps its pre-install copy after install+uninstall", async () => {
    const dir = makeTempDir("backup-collision-cx-");
    const foreign = 'owner = "original bytes, must survive"\n';
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex/config.toml"), foreign);
    await startNearSecondStart();
    expect(
      (await run(dir, ["--harness", "codex", "--url", URL_, "--workspace", WS])).code,
      "install",
    ).toBe(0);
    expect(
      (await run(dir, ["--harness", "codex", "--uninstall"])).code,
      "uninstall",
    ).toBe(0);
    const names = stamped(dir, ".codex/openrig-honcho/backups", "config.toml.");
    // pre-fix this is ONE name: the uninstall copy clobbered the install one
    expect(names.length, `backups were: ${names.join(", ")}`).toBe(2);
    const contents = names.map((n) => readFileSync(join(dir, ".codex/openrig-honcho/backups", n), "utf8"));
    expect(contents.some((c) => c === foreign)).toBe(true); // the original bytes, on their own
    expect(contents.some((c) => c.includes("mcp_servers.rig_memory"))).toBe(true); // the installed copy
  });

  test("claude: settings.local.json keeps its pre-install copy after install+uninstall", async () => {
    const dir = makeTempDir("backup-collision-cl-");
    const foreign = '{\n  "env": {\n    "KEEP_ME": "original bytes, must survive"\n  }\n}\n';
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.local.json"), foreign);
    await startNearSecondStart();
    expect((await run(dir, ["--url", URL_, "--workspace", WS])).code, "install").toBe(0);
    expect((await run(dir, ["--uninstall"])).code, "uninstall").toBe(0);
    const names = stamped(dir, ".claude/openrig-honcho/backups", "settings.local.json.");
    expect(names.length, `backups were: ${names.join(", ")}`).toBe(2);
    const contents = names.map((n) =>
      readFileSync(join(dir, ".claude/openrig-honcho/backups", n), "utf8"),
    );
    expect(contents.some((c) => c === foreign)).toBe(true);
    expect(contents.some((c) => c.includes("KEEP_ME") && c.includes(WS))).toBe(true);
  });
});
