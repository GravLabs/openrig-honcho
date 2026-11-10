// C5c (ADR-0016 decision 7): the installer records hook trust in the user
// layer and CHECKS project trust without ever granting it. Real bin, temp
// seat, temp CODEX_HOME (never ~/.codex). The hash check rebuilds the Rust
// identity recipe in this file - independently of plugin/src/codex-trust.ts
// (which its own suite pins against the Rust golden vector) - so a wrong
// wiring of events, matchers, timeouts, async flags or indexes is caught
// here, not shared between both sides.

import { describe, expect, test } from "bun:test";
import { makeTempDir, trackTempDir } from "../support/tempdir.ts";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const REPO = new URL("../..", import.meta.url).pathname;
const BIN = join(REPO, "plugin/bin/install-project.ts");
const BUN = process.execPath;

const URL_ = "http://10.9.9.9/v3";
const WS = "honcho-bridge-scratch-c5c";
const CODEX_INSTALL = ["--harness", "codex", "--url", URL_, "--workspace", WS];

// C5e: one trust block per seat, markers naming the seat absolute path.
const TRUST_MARK_BEGIN = "# BEGIN openrig-honcho hooks trust";
const TRUST_MARK_END = "# END openrig-honcho hooks trust";
const trustBeginFor = (seatDir: string): string =>
  `${TRUST_MARK_BEGIN} for ${seatDir} (managed - do not edit inside)`;
const trustEndFor = (seatDir: string): string => `${TRUST_MARK_END} for ${seatDir}`;
/** pre-C5e markers (fe8ff04, eb9b8d9) - used only to plant legacy blocks */
const LEGACY_TRUST_BEGIN = `${TRUST_MARK_BEGIN} (managed - do not edit inside)`;
const LEGACY_TRUST_END = TRUST_MARK_END;

const HOOKS = (d: string) => join(d, ".codex/hooks.json");
const SETTINGS = (d: string) => join(d, ".codex/openrig-honcho/settings.json");
const RECORD = (d: string) => join(d, ".codex/openrig-honcho/install.json");
const BACKUPS = (d: string) => join(d, ".codex/openrig-honcho/backups");
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

function mkSeat(): { dir: string; codexHome: string; userCfg: string; env: Record<string, string> } {
  const dir = makeTempDir("install-trust-");
  const codexHome = makeTempDir("install-trust-home-");
  return {
    dir,
    codexHome,
    userCfg: join(codexHome, "config.toml"),
    env: { ...process.env, CODEX_HOME: codexHome },
  };
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

// --- independent re-implementation of the Codex hash recipe (test-only) ----

function sortAll(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortAll);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      o[k] = sortAll((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

/** identity {event_name, matcher?, hooks:[{async,command,timeout,type}]} ->
 * sha256 over the sorted compact JSON (fingerprint.rs:54-66). Timeouts are
 * already the normalized values for our events (pass-through >= 1). */
function rustHash(eventLabel: string, matcher: string | null, h: any): string {
  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    hooks: [
      {
        async: h.async === true,
        command: h.command,
        timeout: h.timeout ?? 600,
        type: "command",
      },
    ],
  };
  if (matcher !== null) identity.matcher = matcher;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortAll(identity)), "utf8").digest("hex")}`;
}

/** The 4 expected {key, hash} from the hooks.json the installer wrote. */
function expectedEntries(dir: string): { key: string; hash: string }[] {
  const hooksFile = readJson(HOOKS(dir)).hooks as Record<string, any[]>;
  const out: { key: string; hash: string }[] = [];
  for (const [event, groups] of Object.entries(hooksFile)) {
    const label = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    groups.forEach((g: any, gi: number) => {
      const ours = String(JSON.stringify(g)).includes("openrig-honcho");
      if (!ours) return;
      (g.hooks as any[]).forEach((h: any, hi: number) => {
        out.push({
          key: `${HOOKS(dir)}:${label}:${gi}:${hi}`,
          hash: rustHash(label, typeof g.matcher === "string" ? g.matcher : null, h),
        });
      });
    });
  }
  return out;
}

const trustTables = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  let key: string | null = null;
  for (const line of text.split("\n")) {
    const h = line.match(/^\[hooks\.state\."(.*)"\]\s*$/);
    if (h !== null) {
      key = h[1] as string;
      continue;
    }
    const t = line.match(/^trusted_hash = "(sha256:[0-9a-f]{64})"$/);
    if (key !== null && t !== null) {
      out.set(key, t[1] as string);
      key = null;
    }
  }
  return out;
};

describe("C5c: install writes our trust block in the user layer", () => {
  test("fresh install into an absent user config: our 4 keys, exact hashes, own block", async () => {
    const { dir, userCfg, env } = mkSeat();
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(userCfg)).toBe(true);
    const text = readFileSync(userCfg, "utf8");
    expect(text.startsWith(`${trustBeginFor(dir)}\n`)).toBe(true);
    expect(text.trimEnd().endsWith(trustEndFor(dir))).toBe(true);
    const tables = trustTables(text);
    const want = expectedEntries(dir);
    expect(want.length).toBe(4); // session_start, ups:0, ups:1, stop
    expect([...tables.keys()].sort()).toEqual(want.map((w) => w.key).sort());
    for (const w of want) expect(tables.get(w.key)).toBe(w.hash);
    // the exact keys the row names
    expect([...tables.keys()]).toContain(`${HOOKS(dir)}:session_start:0:0`);
    expect([...tables.keys()]).toContain(`${HOOKS(dir)}:user_prompt_submit:0:0`);
    expect([...tables.keys()]).toContain(`${HOOKS(dir)}:user_prompt_submit:1:0`);
    expect([...tables.keys()]).toContain(`${HOOKS(dir)}:stop:0:0`);
    // record lists the keys and the trust block
    const rec = readJson(RECORD(dir));
    expect(rec.version).toBe(2);
    expect(rec.trustBlockAdded).toBe(true);
    expect(rec.userConfigCreated).toBe(true);
    expect(rec.trustKeys).toEqual(want.map((w) => w.key).sort());
  });

  test("reinstall: nothing to change, check line still printed, no backups", async () => {
    const { dir, userCfg, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const before = readFileSync(userCfg, "utf8");
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("nothing to change (already installed)");
    expect(r.all).toContain("project trust: NOT trusted"); // no projects entry
    expect(readFileSync(userCfg, "utf8")).toBe(before);
    expect(existsSync(BACKUPS(dir)) ? readdirSync(BACKUPS(dir)) : []).toEqual([]);
  });

  test("drift inside our block is repaired in place on the next install", async () => {
    const { dir, userCfg, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const key = `${HOOKS(dir)}:session_start:0:0`;
    const text = readFileSync(userCfg, "utf8");
    const real = trustTables(text).get(key)!;
    const fake = `sha256:${"e".repeat(64)}`;
    writeFileSync(userCfg, text.replace(`trusted_hash = "${real}"`, `trusted_hash = "${fake}"`));
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("trust: refreshed our managed trust block in place");
    const after = trustTables(readFileSync(userCfg, "utf8"));
    expect(after.get(key)).not.toBe(fake);
    for (const w of expectedEntries(dir)) expect(after.get(w.key)).toBe(w.hash);
  });

  test("append into an existing user config (no trailing newline) and byte-restore on uninstall", async () => {
    const { dir, userCfg, env } = mkSeat();
    const foreign = '[mcp_servers.user_own]\ncommand = "echo"\n# end of owner file'; // no trailing \n
    writeFileSync(userCfg, foreign);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    const text = readFileSync(userCfg, "utf8");
    expect(text.startsWith(`${foreign}\n${trustBeginFor(dir)}`)).toBe(true); // sep newline added
    expect(readJson(RECORD(dir)).trustSep).toBe(true);
    expect((await run(dir, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    expect(readFileSync(userCfg, "utf8")).toBe(foreign); // byte for byte
    expect(trustTables(readFileSync(userCfg, "utf8")).size).toBe(0);
  });

  test("foreign blocks and tables around ours survive untouched", async () => {
    const { dir, userCfg, env } = mkSeat();
    const relay =
      '# BEGIN openrig relay hooks trust (managed)\n[hooks.state."/r/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"\n# END openrig relay hooks trust\n'; // fake-secret
    writeFileSync(userCfg, `${relay}\n[projects."/other"]\ntrust_level = "trusted"\n`);
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const text = readFileSync(userCfg, "utf8");
    expect(text.startsWith(relay)).toBe(true); // foreign block untouched, ours appended
    expect((await run(dir, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    expect(readFileSync(userCfg, "utf8")).toBe(`${relay}\n[projects."/other"]\ntrust_level = "trusted"\n`);
  });

  test("uninstall removes the block and deletes a file we created and emptied", async () => {
    const { dir, userCfg, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    expect((await run(dir, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    expect(existsSync(userCfg)).toBe(false); // we created it, only our block was in it
  });

  test("record v1 (a C5b install) upgrades: trust is added, record goes v2", async () => {
    const { dir, userCfg, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    // roll the state back to exactly what C5b left: no user file, v1 record
    rmSync(userCfg);
    const rec = readJson(RECORD(dir));
    for (const k of ["trustBlockAdded", "trustKeys", "trustSep", "userConfigCreated"]) delete rec[k];
    rec.version = 1;
    writeFileSync(RECORD(dir), JSON.stringify(rec));
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("trust: create");
    expect(readJson(RECORD(dir)).version).toBe(2);
    expect(trustTables(readFileSync(userCfg, "utf8")).size).toBe(4);
  });
});

describe("C5c: refusals on the user layer write nothing", () => {
  test("our key outside our block with a different hash: refuse, zero writes", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(
      userCfg,
      `[hooks.state."${HOOKS(dir)}:session_start:0:0"]\ntrusted_hash = "sha256:${"d".repeat(64)}"\n`,
    );
    const before = readFileSync(userCfg, "utf8");
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("different hash");
    expect(existsSync(HOOKS(dir))).toBe(false);
    expect(existsSync(RECORD(dir))).toBe(false);
    expect(readFileSync(userCfg, "utf8")).toBe(before);
  });

  test("our key outside our block with the SAME hash: skip that key, note it", async () => {
    const { dir, userCfg, env } = mkSeat();
    // pre-install once in a copy to learn the real command strings is not
    // possible here; instead install fully, then move one table outside and
    // remove it from the block by hand, and rerun: it must come back NOT
    // duplicated and the run must note it.
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    const tables = trustTables(readFileSync(userCfg, "utf8"));
    const key = `${HOOKS(dir)}:stop:0:0`;
    const hash = tables.get(key)!;
    const stripped = readFileSync(userCfg, "utf8")
      .split("\n")
      .filter((l) => l !== `[hooks.state."${key}"]` && !(l === `trusted_hash = "${hash}"`))
      .join("\n");
    writeFileSync(userCfg, `[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n\n${stripped}`);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("already trusted in the user layer outside our block, same hash");
    const after = trustTables(readFileSync(userCfg, "utf8"));
    expect(after.has(key)).toBe(true); // exactly once in total
    expect([...after.keys()].filter((k) => k === key).length).toBe(1);
    expect(after.size).toBe(4); // 3 in the block + 1 outside
  });

  test("a [hooks.state] table for our key with no trusted_hash: refuse", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, `[hooks.state."${HOOKS(dir)}:stop:0:0"]\nenabled = true\n`);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("without a trusted_hash");
    expect(existsSync(RECORD(dir))).toBe(false);
  });

  test("a foreign key inside our trust block: refuse", async () => {
    const { dir, userCfg, env } = mkSeat();
    // C5e: planted in THIS seat's own block - only this seat's block is
    // policed for foreign keys, so the markers must name this seat.
    writeFileSync(
      userCfg,
      `${trustBeginFor(dir)}\n[hooks.state."/x/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"\n${trustEndFor(dir)}\n`,
    );
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("keys we did not write");
    expect(existsSync(RECORD(dir))).toBe(false);
  });

  test("damaged trust block markers (this seat's own): refuse", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, `${trustBeginFor(dir)}\n# no end marker\n`);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("damaged markers");
  });

  test("symlinked user config: refuse before anything is read as ours", async () => {
    const { dir, codexHome, env } = mkSeat();
    const real = join(codexHome, "elsewhere.toml");
    writeFileSync(real, "");
    symlinkSync(real, join(codexHome, "config.toml"));
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("symlink");
    expect(existsSync(HOOKS(dir))).toBe(false);
  });

  test("unwritable existing user config: refuse in preflight, seat files not written", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, '[other]\nx = 1\n');
    chmodSync(userCfg, 0o444);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("not readable+writable");
    expect(existsSync(HOOKS(dir))).toBe(false);
    chmodSync(userCfg, 0o644);
  });
});

describe("C5c: project trust is checked, never granted", () => {
  test("an entry naming the seat itself: trusted", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, `[projects."${dir}"]\ntrust_level = "trusted"\n`);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("project trust: trusted");
    // and it did NOT write any projects entry of its own
    const after = readFileSync(userCfg, "utf8");
    expect(after).toContain(`[projects."${dir}"]\ntrust_level = "trusted"\n`);
    expect(after.match(/\[projects\./g)?.length).toBe(1);
  });

  test("an entry naming only the git repo root, seat inside it: trusted", async () => {
    const { dir, userCfg, env } = mkSeat();
    // make the seat folder the root of a repo, seat = repo/pods
    const repo = makeTempDir("trust-repo-");
    const seat = join(repo, "pods");
    mkdirSync(seat);
    const git = Bun.spawnSync(["git", "-C", repo, "init", "-q"], { encoding: "utf8" });
    expect(git.exitCode).toBe(0);
    writeFileSync(userCfg, `[projects."${repo}"]\ntrust_level = "trusted"\n`);
    const r = await run(seat, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("project trust: trusted");
  });

  test("no matching entry: one plain line naming the missing entry, no values", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, '[projects."/somewhere/else"]\ntrust_level = "trusted"\n');
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain(`project trust: NOT trusted - add [projects."${dir}"] trust_level = "trusted" to ${userCfg}`);
    expect(r.all).not.toContain(URL_); // no values echoed
    // dry-run says it too (fresh home; dry-run writes nothing anywhere)
    const dry = mkSeat();
    const d = await run(dry.dir, [...CODEX_INSTALL, "--dry-run"], dry.env);
    expect(d.all).toContain("project trust: NOT trusted");
    expect(existsSync(dry.userCfg)).toBe(false);
    expect(existsSync(HOOKS(dry.dir))).toBe(false);
  });

  test("check line is about the PROJECT dir only: a non-matching trust_level value does not count", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, `[projects."${dir}"]\ntrust_level = "untrusted"\n`);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("project trust: NOT trusted");
  });
});

// --- C5e: several Codex seats share one CODEX_HOME --------------------------
// One managed block per seat (markers name the seat absolute path). Each
// install finds, writes and removes ONLY its own block; other seats' blocks
// are foreign content. A legacy (pre-C5e, path-less) block is adopted by the
// seat whose keys it holds and rewritten in the per-seat form.

/** a second seat sharing an existing temp CODEX_HOME */
function mkSeatIn(codexHome: string): { dir: string; env: Record<string, string> } {
  return {
    dir: makeTempDir("install-trust-seat-"),
    env: { ...process.env, CODEX_HOME: codexHome },
  };
}

/** the inner lines of one seat's block, by its own markers */
function blockInner(text: string, seatDir: string): string[] {
  const lines = text.split("\n");
  const b = lines.indexOf(trustBeginFor(seatDir));
  const e = lines.indexOf(trustEndFor(seatDir));
  expect(b).toBeGreaterThanOrEqual(0);
  expect(e).toBeGreaterThan(b);
  return lines.slice(b + 1, e);
}

describe("C5e: two seats, one CODEX_HOME", () => {
  test("both install in either order; each block holds exactly its own keys; reinstalls are no-ops", async () => {
    for (const flip of [false, true]) {
      const home = makeTempDir("install-trust-home-");
      const first = mkSeatIn(home);
      const second = mkSeatIn(home);
      const a = flip ? second : first;
      const b = flip ? first : second;
      expect((await run(a.dir, CODEX_INSTALL, a.env)).code, a.dir).toBe(0);
      const rb = await run(b.dir, CODEX_INSTALL, b.env);
      expect(rb.code, rb.all).toBe(0);
      const text = readFileSync(join(home, "config.toml"), "utf8");
      for (const seat of [a, b]) {
        const want = expectedEntries(seat.dir);
        expect(want.length).toBe(4);
        const inner = trustTables(blockInner(text, seat.dir).join("\n"));
        expect([...inner.keys()].sort()).toEqual(want.map((w) => w.key).sort());
        for (const w of want) expect(inner.get(w.key)).toBe(w.hash);
        expect(readJson(RECORD(seat.dir)).trustKeys).toEqual(want.map((w) => w.key).sort());
      }
      // reinstall each: nothing to change and NO new backups (seat b's own
      // install already backed up the user config before appending - the
      // pin is that a no-op reinstall adds none)
      const before = readFileSync(join(home, "config.toml"), "utf8");
      const backupsBefore = [a, b].map((s) => (existsSync(BACKUPS(s.dir)) ? readdirSync(BACKUPS(s.dir)) : []));
      for (const seat of [a, b]) {
        const r = await run(seat.dir, CODEX_INSTALL, seat.env);
        expect(r.code, r.all).toBe(0);
        expect(r.all).toContain("nothing to change (already installed)");
      }
      expect([a, b].map((s) => (existsSync(BACKUPS(s.dir)) ? readdirSync(BACKUPS(s.dir)) : []))).toEqual(backupsBefore);
      expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);
    }
  });

  test("uninstalling one seat leaves the other's block and the rest byte-identical", async () => {
    const home = makeTempDir("install-trust-home-");
    const owner = '# owner layer\nmodel = "x"\n';
    writeFileSync(join(home, "config.toml"), owner);
    const a = mkSeatIn(home);
    const b = mkSeatIn(home);
    expect((await run(a.dir, CODEX_INSTALL, a.env)).code).toBe(0);
    const afterA = readFileSync(join(home, "config.toml"), "utf8");
    expect((await run(b.dir, CODEX_INSTALL, b.env)).code).toBe(0);
    expect((await run(b.dir, ["--harness", "codex", "--uninstall"], b.env)).code).toBe(0);
    // back to exactly what seat A's install alone produced - owner bytes and
    // A's block untouched, B's block gone without a trace
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(afterA);
    expect(afterA.startsWith(owner)).toBe(true);
    // and A still works on its own afterwards
    expect((await run(a.dir, CODEX_INSTALL, a.env)).all).toContain("nothing to change (already installed)");
    expect((await run(a.dir, ["--harness", "codex", "--uninstall"], a.env)).code).toBe(0);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(owner);
  });

  test("damage to seat A's block refuses seat A only; seat B installs and uninstalls around it", async () => {
    const home = makeTempDir("install-trust-home-");
    const a = mkSeatIn(home);
    const b = mkSeatIn(home);
    expect((await run(a.dir, CODEX_INSTALL, a.env)).code).toBe(0);
    const cfg = join(home, "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(`${trustEndFor(a.dir)}\n`, ""));
    const damaged = readFileSync(cfg, "utf8");
    const ra = await run(a.dir, CODEX_INSTALL, a.env);
    expect(ra.code).toBe(1);
    expect(ra.all).toContain("damaged markers");
    const rb = await run(b.dir, CODEX_INSTALL, b.env);
    expect(rb.code, rb.all).toBe(0);
    expect((await run(b.dir, ["--harness", "codex", "--uninstall"], b.env)).code).toBe(0);
    // A's damaged bytes are exactly what B saw - never touched, never "repaired"
    expect(readFileSync(cfg, "utf8")).toBe(damaged);
  });
});

describe("C5e: legacy (pre-C5e) block migration", () => {
  /** install once in an isolated home, then hand the seat a home whose
   * config holds the same block in the OLD path-less marker form. */
  async function seatWithLegacyBlock(opts: { dropEnd?: boolean; foreignKeys?: boolean } = {}): Promise<
    { dir: string; userCfg: string; env: Record<string, string>; block: string }
  > {
    const { dir, userCfg, env } = mkSeat();
    expect((await run(dir, CODEX_INSTALL, env)).code).toBe(0);
    let text = readFileSync(userCfg, "utf8");
    text = text.replace(trustBeginFor(dir), LEGACY_TRUST_BEGIN).replace(trustEndFor(dir), LEGACY_TRUST_END);
    if (opts.foreignKeys === true) {
      // PURELY another seat's legacy block: none of this seat's keys in it
      text = `${LEGACY_TRUST_BEGIN}\n[hooks.state."/elsewhere/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:${"b".repeat(64)}"\n${LEGACY_TRUST_END}\n`;
    }
    if (opts.dropEnd === true) text = text.replace(`${LEGACY_TRUST_END}\n`, "");
    // a NEW temp home for the same seat: the record still names this plugin,
    // the seat's own files are in place, only the user layer moved
    const home2 = makeTempDir("install-trust-home2-");
    const userCfg2 = join(home2, "config.toml");
    writeFileSync(userCfg2, text);
    return { dir, userCfg: userCfg2, env: { ...env, CODEX_HOME: home2 }, block: text };
  }

  test("a legacy block holding this seat's keys is adopted and rewritten in per-seat form", async () => {
    const { dir, userCfg, env } = await seatWithLegacyBlock();
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(r.all).toContain("rewrote the legacy (path-less) trust block");
    const after = readFileSync(userCfg, "utf8");
    expect(after).not.toContain(LEGACY_TRUST_BEGIN);
    expect(after.startsWith(`${trustBeginFor(dir)}\n`)).toBe(true);
    expect(after.trimEnd().endsWith(trustEndFor(dir))).toBe(true);
    const want = expectedEntries(dir);
    const tables = trustTables(after);
    expect([...tables.keys()].sort()).toEqual(want.map((w) => w.key).sort());
    for (const w of want) expect(tables.get(w.key)).toBe(w.hash);
    // and the next reinstall is the normal no-op
    expect((await run(dir, CODEX_INSTALL, env)).all).toContain("nothing to change (already installed)");
  });

  test("a legacy block holding ANOTHER seat's keys is foreign content: untouched, install proceeds", async () => {
    const { dir, userCfg, env } = await seatWithLegacyBlock({ foreignKeys: true });
    const before = readFileSync(userCfg, "utf8");
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    const after = readFileSync(userCfg, "utf8");
    // our own block joined the file; the legacy one survives inside it byte-wise
    expect(after.startsWith(`${LEGACY_TRUST_BEGIN}\n`)).toBe(true);
    expect(after).toContain(trustBeginFor(dir));
    expect(after).toContain("/elsewhere/.codex/hooks.json:stop:0:0");
    // uninstall removes ONLY ours
    expect((await run(dir, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    expect(readFileSync(userCfg, "utf8")).toBe(before);
  });

  test("a damaged legacy block holding this seat's keys refuses this seat", async () => {
    const { dir, userCfg, env } = await seatWithLegacyBlock({ dropEnd: true });
    const before = readFileSync(userCfg, "utf8");
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toContain("damaged legacy trust block");
    expect(readFileSync(userCfg, "utf8")).toBe(before); // refused with zero writes
  });

  test("a damaged legacy block WITHOUT our keys does not concern this seat", async () => {
    const { dir, userCfg, env } = mkSeat();
    writeFileSync(userCfg, `${LEGACY_TRUST_BEGIN}\n# someone's half block, no keys\n`);
    const r = await run(dir, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(userCfg, "utf8")).toContain(`${LEGACY_TRUST_BEGIN}\n# someone's half block, no keys\n`);
  });
});

describe("C5f F10: a seat handed in through a symlink installs under its real path", () => {
  test("keys, markers, hooks and settings name the real path; reinstall via the link is a no-op", async () => {
    const { dir, userCfg, env } = mkSeat();
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    trackTempDir(link);
    const real = realpathSync(dir);
    const r = await run(link, CODEX_INSTALL, env);
    expect(r.code, r.all).toBe(0);
    const text = readFileSync(userCfg, "utf8");
    expect(text).toContain(trustBeginFor(real));
    expect(text).not.toContain(link); // no link spelling anywhere in the user layer
    const tables = trustTables(text);
    expect(tables.size).toBe(4);
    for (const k of tables.keys()) expect(k.startsWith(`${HOOKS(real)}:`)).toBe(true);
    // the project layer too: hooks commands and settings never say the link
    expect(readFileSync(HOOKS(real), "utf8")).not.toContain(link);
    expect(readFileSync(join(link, ".codex/openrig-honcho/settings.json"), "utf8")).not.toContain(link);
    // the record sits under the canonical seat (the link resolves to it)
    expect(existsSync(join(link, ".codex/openrig-honcho/install.json"))).toBe(true);
    // reinstall THROUGH THE LINK agrees with the canonicalisation: no-op
    expect((await run(link, CODEX_INSTALL, env)).all).toContain("nothing to change (already installed)");
  });

  test("uninstall through the link AND through the real path both work; names keep the real spelling", async () => {
    // install through the link, uninstall through the link
    const a = mkSeat();
    const aLink = `${a.dir}-link`;
    symlinkSync(a.dir, aLink);
    trackTempDir(aLink);
    expect((await run(aLink, CODEX_INSTALL, a.env)).code).toBe(0);
    expect((await run(aLink, ["--harness", "codex", "--uninstall"], a.env)).code).toBe(0);
    expect(existsSync(a.userCfg)).toBe(false); // we created it, only our block was in it
    expect(existsSync(HOOKS(a.dir))).toBe(false);
    expect(existsSync(RECORD(a.dir))).toBe(false);
    // F8's backup of the seat config exists under the real seat and its name
    // carries no link spelling (review pin: record/backup names unchanged)
    const names = existsSync(BACKUPS(a.dir)) ? readdirSync(BACKUPS(a.dir)) : [];
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => !n.includes("-link"))).toBe(true);
    // install through the REAL path, uninstall through the link
    const b = mkSeat();
    const bLink = `${b.dir}-link`;
    symlinkSync(b.dir, bLink);
    trackTempDir(bLink);
    expect((await run(b.dir, CODEX_INSTALL, b.env)).code).toBe(0);
    expect((await run(bLink, ["--harness", "codex", "--uninstall"], b.env)).code).toBe(0);
    expect(existsSync(b.userCfg)).toBe(false);
    expect(existsSync(HOOKS(b.dir))).toBe(false);
  });

  test("F13: link-spelled and real-spelled ops are ONE seat - user config returns to its start bytes", async () => {
    // review F13 (R7): install by link, install by real, uninstall by link,
    // uninstall by real. Pre-C5f these were two records and two trust-block
    // spellings; the second uninstall reported "no install record" and the
    // real-spelled block stayed ownerless forever. With the C5f realpath all
    // four ops hit the same canonical seat, so the planted bytes below are
    // what must remain - byte for byte.
    const { dir, userCfg, env } = mkSeat();
    const start = "# owner note PLANTED-F13 - keep byte-identical\n";
    writeFileSync(userCfg, start);
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    trackTempDir(link);
    expect((await run(link, CODEX_INSTALL, env)).code).toBe(0);
    expect((await run(dir, CODEX_INSTALL, env)).all).toContain("nothing to change (already installed)");
    expect((await run(link, ["--harness", "codex", "--uninstall"], env)).code).toBe(0);
    const r2 = await run(dir, ["--harness", "codex", "--uninstall"], env);
    expect(r2.code, r2.all).toBe(0);
    expect(readFileSync(userCfg, "utf8")).toBe(start);
  });
});
