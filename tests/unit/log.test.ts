// F2: where the disabled-config line goes (ADR-0001, review T1 F2).
import { afterAll, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, readFileSync, rmSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { logConfigProblem, logEvent, modelFromInput } from "../../plugin/src/log.ts";

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

// ADR-0022 decision 1: the model id grammar and the ONE log field. The bound
// (run-level) path is pinned through the spawned bins (stop.test.ts) - not
// bound here, because boundFields is process-global and bun test files share
// a process.
describe("model field (ADR-0022 d1)", () => {
  test("modelFromInput: the grammar accepts ids, rejects everything else", () => {
    expect(modelFromInput("local3.8-model-name-ud-q6_k_xl")).toBe("local3.8-model-name-ud-q6_k_xl");
    expect(modelFromInput("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelFromInput("a/b:c@d.e-f")).toBe("a/b:c@d.e-f");
    expect(modelFromInput("x".repeat(100))).toBe("x".repeat(100)); // cap inclusive
    expect(modelFromInput(undefined)).toBeUndefined();
    expect(modelFromInput("")).toBeUndefined();
    expect(modelFromInput("x".repeat(101))).toBeUndefined(); // 100-char cap
    expect(modelFromInput("gpt 5")).toBeUndefined(); // space
    expect(modelFromInput("model\ninjection")).toBeUndefined(); // newline, the one field we can never carry
    expect(modelFromInput("модель")).toBeUndefined(); // outside the class
    expect(modelFromInput({ model: "x" })).toBeUndefined();
    expect(modelFromInput(7)).toBeUndefined();
  });
  test("logEvent writes model when given, absent when not", () => {
    const dir = tmp();
    const t = { stateDir: dir, workspace: "fixture-ws", peer: "build" };
    logEvent(t, { hook: "recall", event: "injected", ok: true, ms: 5, model: "fixture-model.1" });
    logEvent(t, { hook: "recall", event: "empty", ok: true, ms: 5 });
    const ls = lines(join(dir, "log", "fixture-ws.log"));
    expect(ls[0]!.model).toBe("fixture-model.1");
    expect("model" in ls[1]!).toBe(false);
  });
});

describe("shown/used fields (ADR-0022 d3, B10)", () => {
  test("shown and used serialize after model and before pointer", () => {
    const dir = tmp();
    const t = { stateDir: dir, workspace: "fixture-ws", peer: "build" };
    logEvent(t, {
      hook: "session-start",
      event: "startup",
      ok: true,
      ms: 5,
      model: "fixture-model.1",
      shown: ["decision:d-0a0b0c0d", "lesson:qitem-20261126033123-b1d597bc0111f573"],
      used: ["decision:d-0a0b0c0d"],
      pointer: "shown",
    });
    const ls = lines(join(dir, "log", "fixture-ws.log"));
    expect(ls[0]!.shown).toEqual(["decision:d-0a0b0c0d", "lesson:qitem-20261126033123-b1d597bc0111f573"]);
    expect(ls[0]!.used).toEqual(["decision:d-0a0b0c0d"]);
    const keys = Object.keys(ls[0]!);
    expect(keys.indexOf("shown")).toBe(keys.indexOf("model") + 1);
    expect(keys.indexOf("used")).toBe(keys.indexOf("shown") + 1);
    expect(keys.indexOf("used")).toBe(keys.indexOf("pointer") - 1);
  });
  test("absent AND empty shown/used serialize as absent - lines stay byte-identical", () => {
    const dir = tmp();
    const t = { stateDir: dir, workspace: "fixture-ws", peer: "build" };
    logEvent(t, { hook: "recall", event: "empty", ok: true, ms: 5 });
    logEvent(t, { hook: "recall", event: "empty", ok: true, ms: 5, shown: [], used: [] });
    const ls = lines(join(dir, "log", "fixture-ws.log"));
    expect("shown" in ls[0]!).toBe(false);
    expect("used" in ls[0]!).toBe(false);
    expect("shown" in ls[1]!).toBe(false);
    expect("used" in ls[1]!).toBe(false);
  });
});

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
