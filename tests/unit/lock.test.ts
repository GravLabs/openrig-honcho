// T2c: locking + state-file hygiene (ADR-0006 S2, S3, X4). Local temp dirs
// only; nothing here touches the network or any real state dir.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { 
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync } from "node:fs";
import { readJson, withLock, writeJsonAtomic } from "../../plugin/src/lock.ts";

const tmp = (): string => makeTempDir("lock-test-");

describe("withLock: S3 concurrency", () => {
  test(
    "20 parallel processes increment the counter under the lock to exactly 20",
    async () => {
      const dir = tmp();
      const helper = new URL("../support/lock-counter.ts", import.meta.url).pathname;
      const kids = Array.from({ length: 20 }, () =>
        Bun.spawn([process.execPath, "run", helper, dir], { stdout: "pipe", stderr: "pipe" }),
      );
      const results = await Promise.all(
        kids.map(async (k) => ({
          // Bun 1.4.2 under `bun test` resolves Subprocess.exit with
          // undefined even for exit(7) and k.exitCode stays null - exit codes
          // carry NO signal here (proved by probe), so success is decided by
          // the helper's stdout "ok" marker and the counter, never by codes.
          okLine: (await new Response(k.stdout).text()).trim() === "ok",
          err: (await new Response(k.stderr).text()).trim().slice(0, 300) })),
      );
      const oks = results.filter((r) => r.okLine).length;
      if (oks !== 20) console.log("failed children:", JSON.stringify(results.filter((r) => !r.okLine), null, 1));
      expect(oks).toBe(20);
      const counter = readJson<{ n: number }>(`${dir}/counter.json`);
      if (counter?.n !== 20) {
        console.log("FORENSIC dir:", dir, "counter:", counter === null ? "unreadable/missing" : JSON.stringify(counter));
      }
      expect(counter?.n).toBe(20);
      expect(readdirSync(dir)).toEqual(["counter.json"]); // lock removed by every child
    },
    60_000,
  );

  test("stale lock (mtime 31 s ago) is taken over once and fn runs", async () => {
    const dir = tmp();
    const lock = `${dir}/lock`;
    writeFileSync(lock, "999999 2026-01-01T00:00:00.000Z\n");
    const old = (Date.now() - 31_000) / 1000;
    utimesSync(lock, old, old);
    const res = await withLock(dir, () => "ran");
    expect(res).toEqual({ ok: true, value: "ran" });
    expect(existsSync(lock)).toBe(false); // removed in finally
  });

  test("a fresh lock held elsewhere gives busy after ~2 s", async () => {
    const dir = tmp();
    writeFileSync(`${dir}/lock`, "999999 fresh\n");
    const t0 = Date.now();
    const res = await withLock(dir, () => "never runs");
    const elapsed = Date.now() - t0;
    expect(res).toEqual({ ok: false, reason: "busy" });
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(3000);
  }, 15_000);

  test("fn throwing inside -> {ok:false, reason:'error'} and the lock is gone", async () => {
    const dir = tmp();
    const res = await withLock(dir, () => {
      throw new Error("boom");
    });
    expect(res).toEqual({ ok: false, reason: "error" });
    expect(existsSync(`${dir}/lock`)).toBe(false);
  });

  test("X4 modes: created dir 0700, lock file 0600", async () => {
    const dir = `${tmp()}/seat`; // withLock creates it
    let lockMode = -1;
    await withLock(dir, () => {
      lockMode = statSync(`${dir}/lock`).mode & 0o777;
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(lockMode).toBe(0o600);
  });
});

describe("readJson: S2 corrupt/missing -> null", () => {
  test("missing file", () => {
    expect(readJson(`${tmp()}/nope.json`)).toBeNull();
  });
  test("empty file", () => {
    const p = `${tmp()}/e.json`;
    writeFileSync(p, "");
    expect(readJson(p)).toBeNull();
  });
  test("truncated JSON", () => {
    const p = `${tmp()}/t.json`;
    writeFileSync(p, '{"a":');
    expect(readJson(p)).toBeNull();
  });
  test("directory in place of the file", () => {
    const dir = tmp();
    mkdirSync(`${dir}/sub`);
    expect(readJson(`${dir}/sub`)).toBeNull();
  });
  test("valid JSON round-trips", () => {
    const p = `${tmp()}/v.json`;
    writeFileSync(p, '{"a":1}');
    expect(readJson<{ a: number }>(p)).toEqual({ a: 1 });
  });
});

describe("writeJsonAtomic: X4 modes + atomic replace", () => {
  test("file 0600, created parent 0700, content valid, replace works", () => {
    const base = tmp();
    const path = `${base}/seat/state.json`; // parent does not exist yet
    expect(writeJsonAtomic(path, { a: 1, s: "x" })).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${base}/seat`).mode & 0o777).toBe(0o700);
    expect(readJson(path)).toEqual({ a: 1, s: "x" });
    expect(writeJsonAtomic(path, { a: 2 })).toBe(true);
    expect(readJson(path)).toEqual({ a: 2 });
    expect(readdirSync(`${base}/seat`).sort()).toEqual(["state.json"]); // no tmp leftovers
  });

  test("unwritable target -> false, no throw, no leftover tmp", () => {
    const dir = tmp();
    // A directory where the tmp file would be renamed onto: rename onto a
    // non-empty directory fails -> the function reports false.
    mkdirSync(`${dir}/blocked`);
    writeFileSync(`${dir}/blocked/inner`, "x");
    expect(writeJsonAtomic(`${dir}/blocked`, { a: 1 })).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
