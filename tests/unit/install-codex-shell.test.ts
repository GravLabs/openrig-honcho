// C5k (R11 F17): Codex runs our hook command lines through a shell
// (hooks/src/engine/command_runner.rs:444-459) and the install embeds the
// seat and plugin paths inside double quotes only - so R11 got code
// execution from a folder named 'pwn $(touch ...)' and silent memory-off
// from one with a double quote. The installer now refuses any such path
// (single quote, double quote, dollar, backtick, backslash, newline/CR)
// with zero writes, before the plan and the lock. Spaces must STILL work:
// the written SessionStart command, run through bash -lc with a stub bun,
// receives the seat settings path exactly. Temp folders only; the stub
// never calls the real server; no workspace is named at all (no install
// reaches the network on these paths anyway).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;
const URL_ = "http://10.9.9.9/v3";
const WS = "honcho-bridge-scratch-c5k";
const CODEX_INSTALL = ["--harness", "codex", "--url", URL_, "--workspace", WS];

const HOOKS = (d: string) => join(d, ".codex/hooks.json");
const SETTINGS = (d: string) => join(d, ".codex/openrig-honcho/settings.json");

async function run(dir: string, env: Record<string, string>): Promise<{ code: number; all: string }> {
  const p = Bun.spawn([BUN, BIN, dir, ...CODEX_INSTALL], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  return { code: await p.exited, all: `${out}\n${err}` };
}

describe("C5k F17: shell-unsafe seat paths refuse with zero writes", () => {
  const badNames: [string, string][] = [
    ["dollar-sign folder", 'pwn $(touch MARKER)'], // R11 marker 1: execution at hook time
    ["double-quote folder", 'a "b'], // R11 marker 2: silently-off memory
    ["backtick folder", "tick`id"],
    ["single-quote folder", "it's"],
  ];
  for (const [name, folder] of badNames) {
    test(`${name}: refused, nothing written`, async () => {
      const root = makeTempDir("c5k-");
      const dir = join(root, folder);
      mkdirSync(dir);
      const env = { ...process.env, CODEX_HOME: makeTempDir("c5k-home-") };
      const r = await run(dir, env);
      expect(r.code).not.toBe(0);
      expect(r.all).toContain("Refusing, nothing written");
      // zero writes: no trace of an install anywhere near the seat
      expect(existsSync(HOOKS(dir))).toBe(false);
      expect(existsSync(join(dir, ".codex"))).toBe(false);
      // and the marker shape itself: nothing was executed by US either
      expect(existsSync(join(root, "MARKER"))).toBe(false);
    });
  }

  test("a spaces folder still installs, and bash -lc hands the EXACT path through", async () => {
    const root = makeTempDir("c5k-");
    const dir = join(root, "my seat with spaces");
    mkdirSync(dir);
    const env = { ...process.env, CODEX_HOME: makeTempDir("c5k-home-") };
    const r = await run(dir, env);
    expect(r.code, r.all).toBe(0);
    const cmd: string = JSON.parse(readFileSync(HOOKS(dir), "utf8")).hooks.SessionStart[0].hooks[0].command;
    // stub bun: prints one argv line per line, so we see what the shell
    // handed to the bin after quote processing
    const stub = makeTempDir("c5k-stub-");
    writeFileSync(join(stub, "bun"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
    chmodSync(join(stub, "bun"), 0o755);
    const p = Bun.spawn(["bash", "-lc", cmd], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout as ReadableStream).text(),
      new Response(p.stderr as ReadableStream).text(),
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const argv = out.trim().split("\n");
    expect(argv[0]).toBe("run");
    expect(argv).toContain(SETTINGS(dir)); // the EXACT path, quotes consumed
    expect(argv).toContain(join(REPO, "plugin/bin/session-start.ts"));
    expect(argv.filter((a) => a.includes('"')).length).toBe(0); // no quote fragments leak through
  });
});
