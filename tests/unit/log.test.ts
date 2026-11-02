// F2: where the disabled-config line goes (ADR-0001, review T1 F2).
import { afterAll, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, readFileSync, rmSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { logConfigProblem } from "../../plugin/src/log.ts";

const tmps: string[] = [];
function tmp(): string {
  const d = makeTempDir("honcho-log-test-");
  tmps.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function configLog(base: string): string {
  return join(base, "log", "_config.log");
}

function lines(file: string): Record<string, string>[] {
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, string>);
}

describe("logConfigProblem", () => {
  test("two runs in a row write the line once", () => {
    const home = tmp();
    const env = { HOME: home };
    logConfigProblem(env, "UserPromptSubmit", "HONCHO_WORKSPACE is required");
    logConfigProblem(env, "UserPromptSubmit", "HONCHO_WORKSPACE is required");
    const l = lines(configLog(join(home, ".openrig-honcho")));
    expect(l.length).toBe(1);
    expect(l[0].hook).toBe("UserPromptSubmit");
    expect(l[0].reason).toBe("HONCHO_WORKSPACE is required");
    expect(Number.isFinite(Date.parse(l[0].ts))).toBe(true);
  });

  test("a different reason adds a second line", () => {
    const home = tmp();
    const env = { HOME: home };
    logConfigProblem(env, "UserPromptSubmit", "HONCHO_WORKSPACE is required");
    logConfigProblem(env, "SessionStart", "HONCHO_URL is required");
    const l = lines(configLog(join(home, ".openrig-honcho")));
    expect(l.length).toBe(2);
    expect(l[1].reason).toBe("HONCHO_URL is required");
  });

  test("the same reason again after an hour is written again", () => {
    const home = tmp();
    const env = { HOME: home };
    const file = configLog(join(home, ".openrig-honcho"));
    const oldTs = new Date(Date.now() - 3700_000).toISOString();
    logConfigProblem(env, "Stop", "HONCHO_PEER is required");
    // Backdate the only line to just over an hour ago.
    writeFileSync(file, `${JSON.stringify({ ts: oldTs, hook: "Stop", reason: "HONCHO_PEER is required" })}\n`);
    logConfigProblem(env, "Stop", "HONCHO_PEER is required");
    expect(lines(file).length).toBe(2);
  });

  test("absolute HONCHO_STATE_DIR wins over HOME; a relative one falls back to HOME", () => {
    const home = tmp();
    const state = tmp();
    logConfigProblem({ HOME: home, HONCHO_STATE_DIR: state }, "Stop", "r1");
    expect(existsSync(configLog(state))).toBe(true);
    expect(existsSync(join(home, ".openrig-honcho"))).toBe(false);

    const home2 = tmp();
    logConfigProblem({ HOME: home2, HONCHO_STATE_DIR: "relative/dir" }, "Stop", "r2");
    expect(existsSync(configLog(join(home2, ".openrig-honcho")))).toBe(true);
  });

  test("neither base: nothing at all, no throw", () => {
    expect(() => logConfigProblem({ HOME: "", HONCHO_STATE_DIR: "" }, "Stop", "r3")).not.toThrow();
    expect(() =>
      logConfigProblem({ HOME: "", HONCHO_STATE_DIR: "not/absolute" }, "Stop", "r3"),
    ).not.toThrow();
  });

  test("an unparseable last line does not suppress a new write", () => {
    const home = tmp();
    // First call creates the directory; then corrupt the file it wrote.
    logConfigProblem({ HOME: home }, "Stop", "warmup");
    const file = configLog(join(home, ".openrig-honcho"));
    writeFileSync(file, "this is not json\n");
    logConfigProblem({ HOME: home }, "Stop", "r4");
    const raw = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(raw.length).toBe(2);
    expect(raw[1]).toContain('"reason":"r4"');
  });
});

describe("bin stubs log disabled config (and never the kill switch)", () => {
  const repo = join(import.meta.dir, "..", "..");

  async function runStub(stub: string, extraEnv: Record<string, string>): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    const proc = Bun.spawn([process.execPath, "run", join(repo, "plugin", "bin", `${stub}.ts`)], {
      cwd: repo,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: extraEnv });
    const code = await proc.exited;
    return {
      code,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text() };
  }

  test("disabled config: one line per run pair, no secret value, clean exit", async () => {
    const home = tmp();
    const env = {
      HOME: home,
      HONCHO_URL: "http://localhost:8000/v3",
      // no HONCHO_WORKSPACE / HONCHO_PEER -> disabled
      HONCHO_API_KEY: "sk-ant-fakekey-DO-NOT-LOG-0123456789abcdef", // fake-secret
    };
    const first = await runStub("user-prompt", env);
    const second = await runStub("user-prompt", env);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stdout).toBe("");
    expect(first.stderr).toBe("");
    const l = lines(configLog(join(home, ".openrig-honcho")));
    expect(l.length).toBe(1); // deduped across processes
    expect(l[0].hook).toBe("UserPromptSubmit");
    expect(l[0].reason).toContain("HONCHO_WORKSPACE");
    const file = readFileSync(configLog(join(home, ".openrig-honcho")), "utf8");
    expect(file).not.toContain("sk-ant-fakekey");
  });

  test("kill switch: no file anywhere", async () => {
    const home = tmp();
    const res = await runStub("session-start", { HOME: home, HONCHO_ENABLED: "false" });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
    expect(existsSync(join(home, ".openrig-honcho"))).toBe(false);
  });

  test("mcp stub: disabled config logged, kill switch silent", async () => {
    const home = tmp();
    const bad = await runStub("mcp", { HOME: home, HONCHO_URL: "http://x:8002/v3" });
    expect(bad.code).toBe(0);
    expect(existsSync(configLog(join(home, ".openrig-honcho")))).toBe(true);
    const home2 = tmp();
    const off = await runStub("mcp", { HOME: home2, HONCHO_ENABLED: "0" });
    expect(off.code).toBe(0);
    expect(existsSync(join(home2, ".openrig-honcho"))).toBe(false);
  });
});
