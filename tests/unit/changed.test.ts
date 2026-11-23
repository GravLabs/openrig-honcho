// v0.5.9 (ADR-0019 amended 2026-11-23): "changed since" marks. Pure parts with
// a fake git runner, plus one real throwaway repository for the git call.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import {
  type GitRunner,
  LOOKBACK_DAYS,
  PATHS_PER_ITEM,
  changeIndex,
  changedCount,
  changedLabel,
  changedSince,
  gitEnv,
  makeGit,
  MARK_MIN_LEFT_MS,
  markChanged,
  namedPaths,
  parseGitLog,
} from "../../plugin/src/changed.ts";
import { renderContinuity } from "../../plugin/src/inject.ts";
import { pointerLessons } from "../../plugin/src/lessons.ts";
import { pointerItems } from "../../plugin/src/pointer.ts";

const NOW = Date.parse("2026-11-23T04:00:00Z");
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

describe("namedPaths", () => {
  test("folder paths and bare file names with a known extension", () => {
    expect(namedPaths("fixed plugin/src/inject.ts and README.md today")).toEqual(["plugin/src/inject.ts", "README.md"]);
  });
  test("quotes, backticks, brackets and trailing punctuation", () => {
    expect(namedPaths("see `src/a.ts`, (docs/b.md). and 'c.json'; [d/e.yaml]")).toEqual([
      "src/a.ts",
      "docs/b.md",
      "c.json",
      "d/e.yaml",
    ]);
  });
  test("leading ./ dropped; absolute, parent and URL paths refused", () => {
    expect(namedPaths("./src/x.ts /etc/passwd.txt ../up/y.ts https://h.example/a/b.md")).toEqual(["src/x.ts"]);
  });
  test("versions, ids and plain words are not paths", () => {
    expect(namedPaths("release v0.5.8 for qitem-2026 d-1a2b3c4d e.g. stuff")).toEqual([]);
  });
  test("deduplicated and capped", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts f${i}.ts`).join(" ");
    const got = namedPaths(many);
    expect(got.length).toBe(PATHS_PER_ITEM);
    expect(new Set(got).size).toBe(got.length);
  });
});

describe("parseGitLog", () => {
  test("newest-first: a file's first time is its last change", () => {
    const out = `@200\n\na.ts\nb/c.ts\n\n@100\n\na.ts\nd.md\n`;
    const idx = parseGitLog(out);
    expect(idx.get("a.ts")).toBe(200_000);
    expect(idx.get("b/c.ts")).toBe(200_000);
    expect(idx.get("d.md")).toBe(100_000);
  });
  test("names before any commit line, or under a broken time, are ignored", () => {
    const idx = parseGitLog(`orphan.ts\n@nope\nx.ts\n@50\ny.ts\n`);
    expect(idx.has("orphan.ts")).toBe(false);
    expect(idx.has("x.ts")).toBe(false);
    expect(idx.get("y.ts")).toBe(50_000);
  });
});

describe("changedCount", () => {
  const idx = new Map([
    ["plugin/src/inject.ts", 300],
    ["README.md", 100],
  ]);
  test("exact and suffix matches after the item's time", () => {
    expect(changedCount(idx, ["src/inject.ts", "README.md"], 200)).toBe(1);
    expect(changedCount(idx, ["src/inject.ts", "README.md"], 50)).toBe(2);
  });
  test("a suffix must start at a folder boundary", () => {
    expect(changedCount(idx, ["ject.ts"], 0)).toBe(0);
  });
  test("a change at exactly the item's time is not after it", () => {
    expect(changedCount(idx, ["README.md"], 100)).toBe(0);
  });
  test("an unparsable time marks nothing", () => {
    expect(changedCount(idx, ["README.md"], Number.NaN)).toBe(0);
  });
});

describe("changeIndex", () => {
  test("one call, since the oldest item, floored at the lookback", () => {
    const calls: string[][] = [];
    const git: GitRunner = (_cwd, args) => {
      calls.push(args);
      return "";
    };
    const old = NOW - (LOOKBACK_DAYS + 30) * 86_400_000;
    changeIndex("/repo", old, NOW, git);
    const floor = Math.floor((NOW - LOOKBACK_DAYS * 86_400_000) / 1000);
    expect(calls).toEqual([["log", `--since=@${floor}`, "--name-only", "--format=@%ct", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD"]]);
    const recent = NOW - 86_400_000;
    changeIndex("/repo", recent, NOW, git);
    expect(calls[1]?.[1]).toBe(`--since=@${Math.floor(recent / 1000)}`);
  });
  test("no folder, or git failing, is no index", () => {
    const git: GitRunner = () => null;
    expect(changeIndex(undefined, 0, NOW, git)).toBeNull();
    expect(changeIndex("", 0, NOW, git)).toBeNull();
    expect(changeIndex("/repo", 0, NOW, git)).toBeNull();
  });
});

describe("changedSince", () => {
  const log = `@${sec("2026-11-22T12:00:00Z")}\nplugin/src/inject.ts\n@${sec("2026-11-20T12:00:00Z")}\ndocs/adr/0019.md\n`;
  const git: GitRunner = () => log;
  const items = [
    { id: "d-1", text: "inject.ts keeps the 1 s budget; see docs/adr/0019.md", at: "2026-11-21T00:00:00Z" },
    { id: "d-2", text: "both src/inject.ts and docs/adr/0019.md", at: "2026-11-19T00:00:00Z" },
    { id: "d-3", text: "no files named here", at: "2026-11-01T00:00:00Z" },
    { id: "d-4", text: "README.md is fine", at: "2026-11-01T00:00:00Z" },
    { id: "d-5", text: "src/inject.ts", at: "not a date" },
  ];
  test("counts per item; unnamed, unchanged and undated items are absent", () => {
    const m = changedSince("/repo", items, NOW, git);
    expect([...m.entries()].sort()).toEqual([
      ["d-1", 1],
      ["d-2", 2],
    ]);
  });
  test("git is called once, and not at all when nothing names a path", () => {
    let n = 0;
    const counting: GitRunner = (...a) => {
      n++;
      return git(...a);
    };
    changedSince("/repo", items, NOW, counting);
    expect(n).toBe(1);
    changedSince("/repo", [items[2] as (typeof items)[number]], NOW, counting);
    expect(n).toBe(1);
  });
  test("a failing or throwing git is no marks, never an error", () => {
    expect(changedSince("/repo", items, NOW, () => null).size).toBe(0);
    expect(
      changedSince("/repo", items, NOW, () => {
        throw new Error("boom");
      }).size,
    ).toBe(0);
  });
});

describe("changedLabel", () => {
  test("singular and plural", () => {
    expect(changedLabel(1)).toBe("1 file it names changed since");
    expect(changedLabel(3)).toBe("3 files it names changed since");
  });
});

describe("real git", () => {
  const g = (cwd: string, args: string[], date?: string): void => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? "" };
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  test("a throwaway repository: marks follow real commits; not a repository is no marks", () => {
    const dir = makeTempDir("changed-");
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    g(repo, ["init", "-q"]);
    g(repo, ["config", "user.email", "t@example.invalid"]);
    g(repo, ["config", "user.name", "t"]);
    g(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "src", "a.ts"), "1\n");
    writeFileSync(join(repo, "b.md"), "1\n");
    g(repo, ["add", "."]);
    g(repo, ["commit", "-qm", "one"], "2026-11-20T00:00:00Z");
    writeFileSync(join(repo, "src", "a.ts"), "2\n");
    g(repo, ["commit", "-qam", "two"], "2026-11-22T00:00:00Z");
    const items = [
      { id: "x", text: "src/a.ts and b.md", at: "2026-11-21T00:00:00Z" },
      { id: "y", text: "src/a.ts", at: "2026-11-22T06:00:00Z" },
    ];
    const m = changedSince(repo, items, NOW);
    expect([...m.entries()]).toEqual([["x", 1]]);
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(changedSince(plain, items, NOW).size).toBe(0);
  });
});

describe("markChanged and the digest label", () => {
  const log = `@${sec("2026-11-22T12:00:00Z")}\nplugin/src/inject.ts\n`;
  const git: GitRunner = () => log;
  const mk = () => [
    { id: "d-aaaaaaaa", content: "keep src/inject.ts under 1 s", at: "2026-11-21T00:00:00Z", kind: "decision" as const },
    { id: "d-bbbbbbbb", content: "nothing named", at: "2026-11-21T00:00:00Z", kind: "decision" as const },
  ];
  test("sets changed in place, only on entries with a change", () => {
    const ds = mk();
    markChanged("/repo", ds, "2026-11-23T04:00:00Z", undefined, git);
    expect((ds[0] as { changed?: number }).changed).toBe(1);
    expect("changed" in (ds[1] as object)).toBe(false);
  });
  test("skipped when the deadline leaves too little time; never calls git", () => {
    let n = 0;
    const ds = mk();
    markChanged("/repo", ds, "2026-11-23T04:00:00Z", Date.now() + MARK_MIN_LEFT_MS - 50, () => {
      n++;
      return log;
    });
    expect(n).toBe(0);
    expect("changed" in (ds[0] as object)).toBe(false);
  });
  test("the digest shows the words on the entry's label; unmarked entries are byte-identical", () => {
    const ds = mk();
    const before = renderContinuity({ now: "2026-11-23T04:00:00Z", decisions: mk() });
    markChanged("/repo", ds, "2026-11-23T04:00:00Z", undefined, git);
    const after = renderContinuity({ now: "2026-11-23T04:00:00Z", decisions: ds });
    expect(after).toContain("d-aaaaaaaa, 2 d ago, 1 file it names changed since");
    const lineB = (t: string) => t.split("\n").find((l) => l.startsWith("d-bbbbbbbb"));
    expect(lineB(after)).toBe(lineB(before));
    expect(lineB(after)).toBeDefined();
  });
});

describe("lesson and pointer marks", () => {
  const log = `@${sec("2026-11-22T12:00:00Z")}\nscripts/release.sh\n`;
  const lore = [
    "---",
    "taxonomy: lore",
    'date: "2026-11-20T00:00:00Z"',
    "---",
    "**Moment.** Ran the release without the checksum step.",
    "",
    "The fix lives in scripts/release.sh, step 4.",
  ].join("\n");
  const reader = {
    list: () => ["release-checksum.md"],
    read: () => lore,
    sizeIsFile: () => lore.length,
  };
  const cfg = { topologyRoot: "/t", sessionName: "build@rig" } as never;
  test("a lesson naming a changed file (in its body, not its Moment) says so; the body is never shown", () => {
    const got = pointerLessons(cfg, "cut the release", reader, (items) => changedSince("/repo", items, NOW, () => log));
    expect(got.count).toBe(1);
    expect(got.text).toContain("Ran the release without the checksum step. (1 file it names changed since)");
    expect(got.text).not.toContain("step 4");
  });
  test("no marker function, or one that throws, is today's line", () => {
    const plain = pointerLessons(cfg, "cut the release", reader);
    const broken = pointerLessons(cfg, "cut the release", reader, () => {
      throw new Error("x");
    });
    expect(plain.text).not.toContain("changed since");
    expect(broken.text).toBe(plain.text);
  });
  test("pointer titles carry the mark after the cut; no map is today's items", () => {
    const snap = {
      memories: [{ id: "c1", content: "edit plugin/src/inject.ts", trust: "derived" as const }],
      messages: [],
      superseded: undefined,
    };
    expect(pointerItems(snap)[0]?.mark).toBeUndefined();
    expect(pointerItems(snap, new Map([[0, 2]]))[0]?.mark).toBe(" (2 files it names changed since)");
  });
});

describe("R22 recheck F-T1/F-T2: no GIT_* variable reaches the child", () => {
  test("gitEnv drops every GIT_* key and keeps the rest", () => {
    const e = gitEnv({ PATH: "/bin", HOME: "/h", GIT_DIR: "/x", GIT_EXTERNAL_DIFF: "/y", git_work_tree: "/z", GIT_CONFIG_PARAMETERS: "'a.b=c'" });
    expect(e).toEqual({ PATH: "/bin", HOME: "/h", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  });
  test("real git: GIT_DIR in the seat env cannot redirect marks; GIT_EXTERNAL_DIFF cannot run a program", () => {
    const g = (cwd: string, args: string[], date?: string): string => {
      const env = { ...gitEnv(process.env), GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? "" };
      const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const dir = makeTempDir("changed-env-");
    const mkRepo = (name: string, file: string): string => {
      const repo = join(dir, name);
      mkdirSync(repo, { recursive: true });
      g(repo, ["init", "-q"]);
      g(repo, ["config", "user.email", "t@example.invalid"]);
      g(repo, ["config", "user.name", "t"]);
      g(repo, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(repo, file), "1\n");
      g(repo, ["add", "."]);
      g(repo, ["commit", "-qm", "one"], "2026-11-20T00:00:00Z");
      writeFileSync(join(repo, file), "2\n");
      g(repo, ["commit", "-qam", "two"], "2026-11-22T00:00:00Z");
      return repo;
    };
    const own = mkRepo("own", "own.ts");
    const other = mkRepo("other", "app.ts");
    const marker = join(dir, "ran.txt");
    const prog = join(dir, "extdiff.sh");
    writeFileSync(prog, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(prog, 0o755);
    const saved = { d: process.env.GIT_DIR, x: process.env.GIT_EXTERNAL_DIFF };
    try {
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_EXTERNAL_DIFF = prog;
      // the item names app.ts, which changed only in the OTHER repository
      const m = changedSince(own, [{ id: "a", text: "app.ts and own.ts", at: "2026-11-21T00:00:00Z" }], NOW);
      expect([...m.entries()]).toEqual([["a", 1]]); // own.ts only
      const out = makeGit(5000)(own, ["diff", "HEAD~1", "HEAD"]);
      expect(out).toContain("own.ts");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (saved.d === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.d;
      if (saved.x === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = saved.x;
    }
  });
});
