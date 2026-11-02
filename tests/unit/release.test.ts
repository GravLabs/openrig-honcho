// T9: tests for the PURE parts of scripts/release.ts - gateAllows (the
// designed-red guard: every refusal must be shown to FIRE, not just exist),
// the version argument rule, and the SHA256SUMS body shape. T13a adds the
// copy-fidelity helpers: compareTrees runs on TEMP dirs, parseLsFilesStage
// on git's real -s output (one tiny temp git repo), the rest on fixtures.
// No network anywhere.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { execSync, spawnSync } from "node:child_process";
import {  cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync  } from "node:fs";
import { dirname, join } from "node:path";
import {
  compareTrees,
  gateAllows,
  gatedCommitBody,
  parseLsFilesStage,
  scratchClearCheck,
  scratchClearVerdict,
  sumsBody,
  unexpectedPluginFiles,
  validVersion } from "../../scripts/release.ts";
import { redact } from "../../plugin/src/redact.ts";

const HEAD = "a".repeat(40);

const step = (status: "PASS" | "FAIL") => ({ step: "unit", status });
const green = {
  commit: HEAD,
  cleanTree: true,
  exit: 0,
  steps: [step("PASS"), { step: "leftovers", status: "PASS" }] };

describe("gateAllows: the green path opens exactly once", () => {
  test("green report for the current HEAD -> ok", () => {
    expect(gateAllows(green, HEAD)).toEqual({ ok: true });
  });
});

describe("gateAllows: every refusal FIRES (designed-red)", () => {
  test("missing / unparsable / non-object report is refused", () => {
    for (const bad of [null, undefined, "not json", 7, []]) {
      const v = gateAllows(bad, HEAD);
      expect(v.ok, `refuses ${JSON.stringify(bad)}`).toBe(false);
    }
  });
  test("a non-green gate exit is refused", () => {
    const v = gateAllows({ ...green, exit: 1 }, HEAD);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain("not 0");
  });
  test("a gate from another commit is refused - the stale-report attack", () => {
    const v = gateAllows({ ...green, commit: "b".repeat(40) }, HEAD);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain("rerun bun run gate");
  });
  test("a dirty tree at gate time is refused", () => {
    expect(gateAllows({ ...green, cleanTree: false }, HEAD).ok).toBe(false);
  });
  test("ANY non-PASS step is refused and named (leftovers-FAIL report)", () => {
    const v = gateAllows(
      { ...green, steps: [step("PASS"), { step: "leftovers", status: "FAIL" }] },
      HEAD,
    );
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain("leftovers=FAIL");
  });
  test("steps missing or empty is refused (a report of nothing is no proof)", () => {
    expect(gateAllows({ ...green, steps: [] }, HEAD).ok).toBe(false);
    expect(gateAllows({ commit: HEAD, cleanTree: true, exit: 0 }, HEAD).ok).toBe(false);
  });
  test("a PASS with a wrong casing/word is NOT a pass (fail-safe read)", () => {
    expect(gateAllows({ ...green, steps: [{ step: "unit", status: "pass" }] }, HEAD).ok).toBe(false);
  });
});

describe("validVersion", () => {
  test("plain X.Y.Z only", () => {
    expect(validVersion("0.1.0")).toBe(true);
    for (const bad of [undefined, "", "v0.1.0", "0.1", "0.1.0.2", "0.1.0-rc1", "0.1.0/"]) {
      expect(validVersion(bad), `rejects ${String(bad)}`).toBe(false);
    }
  });
});

describe("sumsBody", () => {
  test("sorted, lowercase digest, two spaces, relative path, trailing newline", () => {
    const body = sumsBody([
      ["openrig-honcho/bin/stop.ts", "ab".repeat(32)],
      ["openrig-honcho/.claude-plugin/plugin.json", "cd".repeat(32)],
    ]);
    const lines = body.split("\n");
    expect(lines.length).toBe(3); // exactly two entries + trailing newline
    expect(lines[0]?.split("  ")[1]).toBe("openrig-honcho/.claude-plugin/plugin.json"); // sorted by PATH (digest first, sha256sums shape)
    expect(lines[0]).toBe(`${"cd".repeat(32)}  openrig-honcho/.claude-plugin/plugin.json`);
  });

  test("THE COUPLING, pinned (architect ruling 04:06Z): every emitted line matches the scan exemption shape exactly, and is a hex64 match without it", () => {
    // value assembled at runtime so the scan never sees a 64-char literal here
    const hex = "f".repeat(64);
    const line = sumsBody([["openrig-honcho/bin/stop.ts", hex]]).trimEnd();
    expect(/^[0-9a-f]{64}  \S+$/.test(line)).toBe(true); // the ruled scan-exemption line shape
    expect(redact(line).counts["hex64"]).toBe(1); // why the exemption is needed
  });
});

describe("compareTrees (T13a: the copy must be byte-exact vs the gated tree)", () => {
  const base = makeTempDir("reltree-test-");
  const tree = (name: string, files: Record<string, string>): string => {
    const dir = join(base, name);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  test("identical trees -> no differences", () => {
    const a = tree("same-a", { "a.ts": "one", "sub/b.md": "two" });
    const b = tree("same-b", { "a.ts": "one", "sub/b.md": "two" });
    expect(compareTrees(a, b)).toEqual([]);
  });

  test("an extra file on EACH side is named, with the direction", () => {
    const a = tree("extra-a", { shared: "x", only_a: "1" });
    const b = tree("extra-b", { shared: "x", only_b: "2" });
    expect(compareTrees(a, b)).toEqual([
      { path: "only_a", kind: "only-in-a" },
      { path: "only_b", kind: "only-in-b" },
    ]);
  });

  test("one changed byte -> differs", () => {
    const a = tree("diff-a", { f: "aaaa" });
    const b = tree("diff-b", { f: "aaab" });
    expect(compareTrees(a, b)).toEqual([{ path: "f", kind: "differs" }]);
  });

  test("node_modules is excluded on BOTH sides, exactly as listFiles does", () => {
    const a = tree("nm-a", { f: "x", "node_modules/pkg/i.js": "one" });
    const b = tree("nm-b", { f: "x", "node_modules/pkg/i.js": "TWO DIFFERENT" });
    expect(compareTrees(a, b)).toEqual([]);
  });
});

describe("gatedCommitBody (T13a: GATED_COMMIT content shape)", () => {
  test("exactly the 40-hex commit and ONE trailing newline", () => {
    const body = gatedCommitBody("c".repeat(40));
    expect(body).toBe(`${"c".repeat(40)}\n`);
    expect(/^[0-9a-f]{40}\n$/.test(body)).toBe(true);
  });
});

describe("parseLsFilesStage (T13a: expected set + rule B1 symlinks)", () => {
  test("regular modes become the file set; mode 120000 becomes a symlink", () => {
    const out = [
      `100644 ${"1".repeat(40)} 0\tplugin/a.ts`,
      `100755 ${"2".repeat(40)} 0\tplugin/bin/stop.ts`,
      `120000 ${"3".repeat(40)} 0\tplugin/link`,
    ].join("\n");
    expect(parseLsFilesStage(out)).toEqual({
      files: ["plugin/a.ts", "plugin/bin/stop.ts"],
      symlinks: ["plugin/link"] });
  });

  test("empty output -> empty sets", () => {
    expect(parseLsFilesStage("")).toEqual({ files: [], symlinks: [] });
  });

  test("REAL git output shape: a temp repo with a tracked symlink reports mode 120000", () => {
    const dir = makeTempDir("reltree-git-");
    execSync("git init -q .", { cwd: dir });
    writeFileSync(join(dir, "real.ts"), "content\n");
    symlinkSync("real.ts", join(dir, "link"));
    execSync("git add -A", { cwd: dir });
    const parsed = parseLsFilesStage(execSync("git ls-files -s .", { cwd: dir, encoding: "utf8" }));
    expect(parsed.files).toEqual(["real.ts"]);
    expect(parsed.symlinks).toEqual(["link"]); // rule B1 refuses this in plugin/
  });
});

describe("unexpectedPluginFiles (T13a 00:59Z amendment: untracked/ignored refuse)", () => {
  test("clean plugin/ -> nothing", () => {
    expect(unexpectedPluginFiles("")).toEqual([]);
    expect(unexpectedPluginFiles("\n")).toEqual([]);
  });

  test("an UNTRACKED file in plugin/ is named -> the release refuses", () => {
    expect(unexpectedPluginFiles("?? plugin/scratch.ts\n")).toEqual(["plugin/scratch.ts"]);
  });

  test("an IGNORED file in plugin/ is named -> the release refuses", () => {
    expect(unexpectedPluginFiles("!! plugin/ignored.log\n")).toEqual(["plugin/ignored.log"]);
  });

  test("a collapsed untracked DIRECTORY line is named, not missed (review 02:05Z #4)", () => {
    expect(unexpectedPluginFiles("?? plugin/d/\n")).toEqual(["plugin/d/"]);
  });

  test("an untracked SYMLINK arrives as ?? and is named too (rule B1, untracked side)", () => {
    expect(unexpectedPluginFiles("?? plugin/sneaky-link\n")).toEqual(["plugin/sneaky-link"]);
  });

  test("tracked-change lines are NOT this rule - the dirty check owns them", () => {
    expect(unexpectedPluginFiles(" M plugin/src/writer.ts\nM  plugin/bin/stop.ts\n")).toEqual([]);
  });

  test("mixed porcelain: only ?? and !! survive", () => {
    const out = " M plugin/src/writer.ts\n?? plugin/extra\n!! plugin/build\n";
    expect(unexpectedPluginFiles(out)).toEqual(["plugin/extra", "plugin/build"]);
  });
});

// T14f (ADR-0006 amendment 2026-10-31): the gate now proves deletes ACCEPTED,
// not purged, so the release refuses while the server still lists ANY
// honcho-bridge-scratch* - or while the list itself cannot answer. Pure half:
describe("scratchClearCheck (T14f: no scratch may still be listed at release time)", () => {
  test("no scratch listed -> ok, whatever else is on the server", () => {
    expect(scratchClearCheck([])).toEqual({ ok: true });
    expect(scratchClearCheck(["openrig", "orca", "pilot", "owner-profile"])).toEqual({ ok: true });
  });

  test("one listed scratch id refuses, naming it", () => {
    const v = scratchClearCheck(["openrig", "honcho-bridge-scratch-a"]);
    if (v.ok) throw new Error("expected a refusal");
    expect(v.reason).toContain("1 honcho-bridge-scratch* workspace(s) still listed");
    expect(v.reason).toContain("honcho-bridge-scratch-a");
    expect(v.fix).toContain("rerun bun run gate");
  });

  test("many listed: exact count, first five named, the rest elided", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `honcho-bridge-scratch-${i}`);
    const v = scratchClearCheck(ids);
    if (v.ok) throw new Error("expected a refusal");
    expect(v.reason).toContain("7 honcho-bridge-scratch*");
    expect(v.reason).toContain("honcho-bridge-scratch-4");
    expect(v.reason).not.toContain("honcho-bridge-scratch-5");
    expect(v.reason).toContain("…");
  });
});

describe("scratchClearVerdict (T14f: the seam - a failed list is a refusal, never empty)", () => {
  test("a throwing lister refuses with the fact and the cannot-prove reason", async () => {
    const v = await scratchClearVerdict(async () => {
      throw new Error("HTTP 500");
    });
    if (v.ok) throw new Error("expected a refusal");
    expect(v.reason).toContain("workspaces/list failed: HTTP 500");
    expect(v.reason).toContain("cannot prove");
  });

  test("a clean list passes straight through", async () => {
    expect(await scratchClearVerdict(async () => ["openrig"])).toEqual({ ok: true });
  });

  test("a listed scratch id from the lister refuses exactly like the pure check", async () => {
    const v = await scratchClearVerdict(async () => ["honcho-bridge-scratch-late"]);
    if (v.ok) throw new Error("expected a refusal");
    expect(v.reason).toContain("honcho-bridge-scratch-late");
  });
});

describe("refusal ordering on a scratch clone (architect 02:05Z rerun + review 02:05Z #1/#5)", () => {
  // The REAL script runs with REPO = the clone; the working-tree scripts
  // replace the clone's (the code under test is uncommitted). Every fixture
  // change is COMMITTED (scripts/ is tracked - an uncommitted swap would
  // trip the dirty check before the rule being probed). gate-report.json is
  // left UNTRACKED, so the tracked-clean check still passes. Nothing outside
  // the temp dir is touched; no server, no push (clone is local file copy).
  const makeClone = (fixture: (clone: string) => void): { clone: string; head: string } => {
    const origin = join(import.meta.dir, "..", "..");
    const dir = makeTempDir("reltree-clone-");
    const clone = join(dir, "clone");
    execSync(`git clone -q "${origin}" clone`, { cwd: dir });
    rmSync(join(clone, "scripts"), { recursive: true, force: true });
    cpSync(join(origin, "scripts"), join(clone, "scripts"), { recursive: true });
    fixture(clone);
    execSync("git add -A", { cwd: clone });
    execSync('git -c user.email=build@local -c user.name=build commit -q --allow-empty -m "T13a fixture"', { cwd: clone });
    const head = execSync("git rev-parse HEAD", { cwd: clone, encoding: "utf8" }).trim();
    writeFileSync(
      join(clone, "gate-report.json"),
      JSON.stringify({
        commit: head,
        cleanTree: true,
        exit: 0,
        steps: [{ step: "unit", status: "PASS" }, { step: "leftovers", status: "PASS" }] }),
    );
    return { clone, head };
  };

  // T14f: the pre-copy scratch check talks to HONCHO_URL, so the tests that
  // reach it point the clone at a LOCAL fake (never the real server). The
  // fake answers POST /v3/workspaces/list with the scripted ids (or a
  // status). It must run in THIS process, so those spawns are async
  // Bun.spawn - spawnSync would block the event loop and the fake could
  // never answer (the same fact T14e pinned).
  const makeListFake = (opts: { status?: number; scratchIds?: string[] } = {}) => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        requests.push(`${req.method} ${u.pathname}${u.search}`);
        if (opts.status !== undefined) return new Response("fake down", { status: opts.status });
        const items = (opts.scratchIds ?? []).map((id) => ({
          id,
          created_at: new Date().toISOString() }));
        return Response.json({ items, total: items.length, page: 1, size: 100, pages: 1 });
      } });
    const port = server.port as number;
    return {
      url: `http://127.0.0.1:${port}/v3`,
      requests,
      stop: (): void => void server.stop(true) };
  };

  const runReleaseCloneAsync = async (
    clone: string,
    ver: string,
    url: string,
  ): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn([process.execPath, "run", "scripts/release.ts", ver], {
      cwd: clone,
      env: { ...process.env, HONCHO_URL: url },
      stdout: "pipe",
      stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    return { code, out, err };
  };

  test("tracked symlink in plugin/: refuse exit 1, the copy dir is NEVER created", () => {
    const { clone } = makeClone((c) => symlinkSync("nowhere", join(c, "plugin", "probe-link")));
    const r = spawnSync(process.execPath, ["run", "scripts/release.ts", "9.9.9"], { cwd: clone, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("RELEASE REFUSED");
    expect(r.stdout).toContain("plugin/probe-link");
    expect(existsSync(join(clone, "release", "v9.9.9"))).toBe(false); // refusal wrote NOTHING (review #5)
  }, 60_000);

  test("scan step failure AFTER sums: GATED_COMMIT stays ABSENT", async () => {
    // release/v* comes from the clone, so remove it (committed) and use the
    // clone's own plugin.json version to get PAST the pre-copy checks. The
    // fake shape is JOINED IN MY PROCESS and its literal lives ONLY in the
    // clone's file (the scan reads raw bytes); this test file keeps only the
    // fragments. The inner scan must read it as a plugin/ HIGH.
    // T14f update: this test must reach the copy, so it now passes the new
    // pre-copy scratch check too - against a LOCAL fake listing NO scratch
    // (async spawn for that reason; the real server is never contacted).
    const shape = ["sk-", "ant-", "0123456789ABCDEFGHIJ0123456789ABCDEFGHIJ"].join("-");
    const { clone } = makeClone((c) => {
      rmSync(join(c, "release"), { recursive: true, force: true });
      writeFileSync(join(c, "plugin", "probe-secret.ts"), `const KEY = "${shape}";\n`);
    });
    const ver = String(
      (JSON.parse(readFileSync(join(clone, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version,
    );
    const fake = makeListFake(); // empty list = server caught up, proceed to build
    try {
      const r = await runReleaseCloneAsync(clone, ver, fake.url);
      expect(r.code).toBe(1);
      expect(r.out).toContain("RELEASE REFUSED");
      expect(r.out).toContain("repo scan"); // the refusal IS the scan step (not validate et al.)
      expect(existsSync(join(clone, "release", `v${ver}`, "SHA256SUMS"))).toBe(true); // failed AFTER sums
      expect(existsSync(join(clone, "release", `v${ver}`, "GATED_COMMIT"))).toBe(false); // written LAST (review #1)
    } finally {
      fake.stop();
    }
  }, 120_000);

  test("release/v<ver> is a plain file (C12): the designed refusal, not a raw ENOTDIR", () => {
    // review C12: with release/v<ver> occupied by a FILE the copy threw a raw
    // ENOTDIR. Wanted: refuse with fact/reason/fix before anything is written.
    const versionOf = (c: string): string =>
      String((JSON.parse(readFileSync(join(c, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version);
    const { clone } = makeClone((c) => {
      rmSync(join(c, "release"), { recursive: true, force: true });
      mkdirSync(join(c, "release"), { recursive: true });
      writeFileSync(join(c, "release", `v${versionOf(c)}`), "a plain file where a directory must go\n");
    });
    const ver = versionOf(clone);
    const r = spawnSync(process.execPath, ["run", "scripts/release.ts", ver], { cwd: clone, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("RELEASE REFUSED");
    expect(r.stdout).toContain(`release/v${ver} exists and is not a directory`);
    expect(r.stderr).not.toContain("ENOTDIR"); // the refusal, not a crash
    expect(statSync(join(clone, "release", `v${ver}`)).isFile()).toBe(true); // refusal wrote nothing (review #5 rule)
  }, 60_000);

  // T14f (ADR-0006 amendment 2026-10-31): a green gate no longer proves the
  // server PURGED the scratch workspaces, so the release itself refuses
  // before any copy while one is listed - or while the list cannot answer.
  test("T14f: a scratch workspace still listed -> REFUSED before any copy, nothing written", async () => {
    const versionOf = (c: string): string =>
      String((JSON.parse(readFileSync(join(c, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version);
    const { clone } = makeClone((c) => rmSync(join(c, "release"), { recursive: true, force: true }));
    const ver = versionOf(clone);
    // short on purpose: a long digit/letter run here trips the repo's own
    // ADR-0007 opaque-token scan (self-test in scan.test.ts) on this file
    const scratch = "honcho-bridge-scratch-late-purge";
    const fake = makeListFake({ scratchIds: [scratch] });
    try {
      const r = await runReleaseCloneAsync(clone, ver, fake.url);
      expect(r.code).toBe(1);
      expect(r.out).toContain("RELEASE REFUSED");
      expect(r.out).toContain("still listed");
      expect(r.out).toContain(scratch);
      expect(existsSync(join(clone, "release", `v${ver}`))).toBe(false); // refusal wrote NOTHING
      expect(fake.requests.length).toBe(1); // read-only: exactly the list request
      expect(fake.requests[0]).toContain("POST /v3/workspaces/list");
    } finally {
      fake.stop();
    }
  }, 60_000);

  test("T14f: the workspaces list FAILS -> REFUSED too, nothing written (failed list != empty list)", async () => {
    const versionOf = (c: string): string =>
      String((JSON.parse(readFileSync(join(c, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version);
    const { clone } = makeClone((c) => rmSync(join(c, "release"), { recursive: true, force: true }));
    const ver = versionOf(clone);
    const fake = makeListFake({ status: 500 });
    try {
      const r = await runReleaseCloneAsync(clone, ver, fake.url);
      expect(r.code).toBe(1);
      expect(r.out).toContain("RELEASE REFUSED");
      expect(r.out).toContain("workspaces/list failed");
      expect(existsSync(join(clone, "release", `v${ver}`))).toBe(false); // refusal wrote NOTHING
    } finally {
      fake.stop();
    }
  }, 60_000);
});
