// C5a (ADR-0016 decision 9): a Codex run reads its settings from ONE owned
// file named by `--settings <absolute path>` next to `--harness codex`. The
// values merge UNDER the process environment; any problem with the file
// leaves the plugin off for the run exactly like a bad setting today: exit 0,
// nothing on stdout/stderr, and exactly one name-only line in _config.log.
// Everything here runs through the REAL bins against local fakes - no
// installer, no ~/.codex, no real server.

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { scratchName } from "../support/scratch.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURES = join(REPO, "tests/fixtures/codex");
const BIN = {
  sessionStart: join(REPO, "plugin/bin/session-start.ts"),
  userPrompt: join(REPO, "plugin/bin/user-prompt.ts"),
  recall: join(REPO, "plugin/bin/recall.ts"),
  mcp: join(REPO, "plugin/bin/mcp.ts"),
};

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

async function runBin(
  bin: string,
  stdinJson: Record<string, unknown>,
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, bin, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(JSON.stringify(stdinJson));
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

/** a mode-600 named pipe: NOT group/world readable, so only an isFile gate
 * can stop the read from blocking forever (F7). bun's node:fs has no
 * mkfifoSync, so use the coreutils tool. */
const mkFifo = (path: string): string => {
  const p = Bun.spawnSync(["mkfifo", "-m", "600", path]);
  if (p.exitCode !== 0) throw new Error(`mkfifo failed: ${p.stderr.toString()}`);
  return path;
};

/** runBin with a hard kill: a HANGING bin (F7) must fail this test, not the
 * whole suite. `hung` names the failure mode when the pin goes red. */
async function runBinTimed(
  bin: string,
  stdinJson: Record<string, unknown>,
  env: Record<string, string>,
  args: string[],
  timeoutMs = 3000,
): Promise<{ code: number; out: string; err: string; hung: boolean }> {
  const proc = Bun.spawn([process.execPath, bin, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(JSON.stringify(stdinJson));
  proc.stdin.end();
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    proc.kill(9);
  }, timeoutMs);
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, out, err, hung };
}

const CODEX = ["--harness", "codex"];

/** env of a real Codex seat: NO HONCHO_* at all (R0) except the state dir. */
const bareEnv = (stateDir: string): Record<string, string> => ({
  HOME: stateDir,
  HONCHO_STATE_DIR: stateDir,
});

/** a mode-600 settings file holding only HONCHO_* string values */
const settingsFile = (
  stateDir: string,
  values: Record<string, string>,
  name = "settings.json",
): string => {
  const path = join(stateDir, name);
  writeFileSync(path, JSON.stringify(values));
  chmodSync(path, 0o600);
  return path;
};

const configLog = (stateDir: string): string[] => {
  const path = join(stateDir, "log", "_config.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
};

const allMessages = (fake: FakeHoncho): Record<string, unknown>[] =>
  [...fake.state.messages.values()].flat();

describe("C5a: Codex settings from one owned file", () => {
  test(
    "a good mode-600 file drives the writer: every HONCHO_* value comes from the file",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c5a-ok-");
      const ws = scratchName();
      try {
        const file = settingsFile(stateDir, {
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: ws,
          HONCHO_PEER: "build",
          HONCHO_STATE_DIR: stateDir,
        });
        const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), bareEnv(stateDir), [
          ...CODEX,
          "--settings",
          file,
        ]);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(allMessages(fake).length).toBeGreaterThan(0);
        expect(configLog(stateDir)).toEqual([]); // a good file says nothing
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "a good file drives session-start: the injection arrives with the file's config",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c5a-ss-");
      const ws = scratchName();
      try {
        const file = settingsFile(stateDir, {
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: ws,
          HONCHO_PEER: "build",
          HONCHO_STATE_DIR: stateDir,
        });
        const args = [...CODEX, "--settings", file];
        // run 1 creates the Honcho session (empty state: silence is fine)
        await runBin(BIN.sessionStart, fixture("session_start.json"), bareEnv(stateDir), args);
        const seatFile = join(stateDir, ws, "seats", "build.json");
        expect(existsSync(seatFile)).toBe(true);
        const session = (JSON.parse(readFileSync(seatFile, "utf8")) as { session?: string }).session;
        expect(typeof session).toBe("string");
        fake.setSummary(ws, session as string, {
          short: "C5a settings digest line",
          created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        });
        fake.setPeerCard(ws, "build", ["Owns the memory bridge."]);
        await Bun.sleep(10);
        const r = await runBin(
          BIN.sessionStart,
          { ...fixture("session_start.json"), session_id: "c5a-ss-2" },
          bareEnv(stateDir),
          args,
        );
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        const parsed = JSON.parse(r.out) as {
          hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
        };
        expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
        expect((parsed.hookSpecificOutput?.additionalContext ?? "").length).toBeGreaterThan(0);
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  // One fresh state dir per case: logConfigProblem dedupes same-reason/hour
  // per file, so a shared dir could swallow the very line we assert.
  const badFile = async (name: string, fileArg: string): Promise<void> => {
    const stateDir = makeTempDir("c5a-bad-");
    const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), bareEnv(stateDir), [
      ...CODEX,
      "--settings",
      fileArg,
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
    const lines = configLog(stateDir);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(name);
  };

  test("missing file: one settings-missing line, plugin off, exit 0", async () => {
    await badFile("settings-missing", join(makeTempDir("c5a-m-"), "absent.json"));
  });

  test("not JSON: one settings-not-json line, plugin off, exit 0", async () => {
    const stateDir = makeTempDir("c5a-j-");
    const path = join(stateDir, "settings.json");
    writeFileSync(path, "{ not json");
    chmodSync(path, 0o600);
    await badFile("settings-not-json", path);
  });

  test("mode 644 file: one settings-world-readable line, plugin off, exit 0", async () => {
    const stateDir = makeTempDir("c5a-w-");
    const path = settingsFile(stateDir, { HONCHO_URL: "http://127.0.0.1:9/v3" });
    chmodSync(path, 0o644);
    await badFile("settings-world-readable", path);
  });

  test("relative path: one settings-relative-path line, plugin off, exit 0", async () => {
    await badFile("settings-relative-path", "relative-settings.json");
  });

  test("the --settings= form: one settings-bad-flag line, plugin off, exit 0", async () => {
    const stateDir = makeTempDir("c5a-eq-");
    const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), bareEnv(stateDir), [
      ...CODEX,
      "--settings=/etc/passwd",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
    const lines = configLog(stateDir);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("settings-bad-flag");
  });

  test(
    "a file whose only keys are non-HONCHO_* filters to nothing: the run is off with the plain missing-URL line",
    async () => {
      const stateDir = makeTempDir("c5a-nk-");
      const file = settingsFile(stateDir, {} as Record<string, string>);
      writeFileSync(file, JSON.stringify({ PATH: "/bin", HONCHO_URL: 42 }));
      chmodSync(file, 0o600);
      const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), bareEnv(stateDir), [
        ...CODEX,
        "--settings",
        file,
      ]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      // the stray key must not disable anything (no settings-* token); with
      // nothing left, loadConfig says what has always said: HONCHO_URL missing
      const lines = configLog(stateDir);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("HONCHO_URL");
      expect(lines[0]).not.toContain("settings-");
    },
  );

  test(
    "env wins over the file: the file's dead URL is overridden by the environment's live one",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c5a-env-");
      const ws = scratchName();
      try {
        const file = settingsFile(stateDir, {
          HONCHO_URL: "http://127.0.0.1:9/v3",
          HONCHO_WORKSPACE: ws,
          HONCHO_PEER: "build",
          HONCHO_STATE_DIR: stateDir,
        });
        const env = { ...bareEnv(stateDir), HONCHO_URL: fake.url };
        const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), env, [
          ...CODEX,
          "--settings",
          file,
        ]);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(allMessages(fake).length).toBeGreaterThan(0); // a dead URL could not do this
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "the Claude path ignores --settings entirely: a bogus path changes nothing",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c5a-cl-");
      const ws = scratchName();
      try {
        const env = {
          HOME: stateDir,
          HONCHO_STATE_DIR: stateDir,
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: ws,
          HONCHO_PEER: "build",
        };
        const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), env, [
          "--settings",
          join(stateDir, "nope-absent.json"), // no --harness: never read
        ]);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(allMessages(fake).length).toBeGreaterThan(0);
        expect(configLog(stateDir)).toEqual([]); // no --settings token, no complaint
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "HONCHO_RECALL=off in the file turns recall off silently, like the real variable",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c5a-ro-");
      const ws = scratchName();
      try {
        const file = settingsFile(stateDir, {
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: ws,
          HONCHO_PEER: "build",
          HONCHO_STATE_DIR: stateDir,
          HONCHO_RECALL: "off",
        });
        const prompt = [
          `From: dev-x@${ws}`,
          `To: build@${ws}`,
          "Sent: 11-09 01:20Z",
          "---",
          "What did we decide about the radio driver?",
          "---",
          `↩ Reply: rig send dev-x@${ws} "..."`,
        ].join("\n");
        const r = await runBin(
          BIN.recall,
          {
            session_id: "c5a-ro-1",
            cwd: stateDir,
            hook_event_name: "UserPromptSubmit",
            prompt,
          },
          bareEnv(stateDir),
          [...CODEX, "--settings", file],
        );
        expect(r.code).toBe(0);
        expect(r.out).toBe("");
        expect(r.err).toBe("");
        expect(configLog(stateDir)).toEqual([]); // off means off: nothing logged
        expect(existsSync(join(stateDir, "log", `${ws}.log`))).toBe(false); // no event line either
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "mcp accepts --harness codex + --settings: a missing file = disabled server, one _config.log line, clean stdout",
    async () => {
      const stateDir = makeTempDir("c5a-mcp-");
      const r = await runBin(BIN.mcp, {}, bareEnv(stateDir), [
        ...CODEX,
        "--settings",
        join(stateDir, "absent.json"),
      ]);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out).toBe(""); // protocol only; a disabled server says nothing unprompted
      const lines = configLog(stateDir);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("settings-missing");
    },
    60_000,
  );

  // ---- C5a2 (review F7 + O2), the two pins from report-c5a-db5cc21.md ----

  test(
    "F7: a mode-600 FIFO at the --settings path is named settings-not-a-file, never read (no hang)",
    async () => {
      const stateDir = makeTempDir("c5a2-fifo-");
      const fifo = mkFifo(join(stateDir, "settings.fifo")); // mode 600: the read is the hazard
      const r = await runBinTimed(
        BIN.userPrompt,
        fixture("user_prompt_submit.json"),
        bareEnv(stateDir),
        [...CODEX, "--settings", fifo],
      );
      expect(r.hung, "the run never exited: the read blocked on the FIFO (F7)").toBe(false);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      const lines = configLog(stateDir);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("settings-not-a-file");
    },
    30_000,
  );

  test("F7: the same FIFO cannot hang the MCP server either", async () => {
    const stateDir = makeTempDir("c5a2-mcp-");
    const fifo = mkFifo(join(stateDir, "s.fifo"));
    const r = await runBinTimed(BIN.mcp, {}, bareEnv(stateDir), [...CODEX, "--settings", fifo]);
    expect(r.hung, "the MCP server never answered with the FIFO settings path (F7)").toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    const lines = configLog(stateDir);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("settings-not-a-file");
  });

  test(
    "O2: a bad --harness next to --settings names harness-unknown-with-settings, not the missing URL",
    async () => {
      const stateDir = makeTempDir("c5a2-o2-");
      const file = settingsFile(stateDir, {
        HONCHO_URL: "http://127.0.0.1:9/v3",
        HONCHO_WORKSPACE: "w",
        HONCHO_PEER: "build",
        HONCHO_STATE_DIR: stateDir,
      });
      const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), bareEnv(stateDir), [
        "--harness",
        "codexx",
        "--settings",
        file,
      ]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      const lines = configLog(stateDir);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("harness-unknown-with-settings");
      expect(lines[0]).not.toContain("HONCHO_URL"); // the old, misleading line
    },
  );

  test(
    "O2 stays in scope: a bad --harness WITHOUT --settings keeps today's missing-URL line",
    async () => {
      const stateDir = makeTempDir("c5a2-o2b-");
      const r = await runBin(BIN.userPrompt, fixture("user_prompt_submit.json"), bareEnv(stateDir), [
        "--harness",
        "codexx",
      ]);
      expect(r.code).toBe(0);
      const lines = configLog(stateDir);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("HONCHO_URL");
      expect(lines[0]).not.toContain("harness-unknown-with-settings");
    },
  );
});
