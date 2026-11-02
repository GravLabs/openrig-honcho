// File locking + state-file hygiene (ADR-0006 S2/S3/X4): a seat's async
// UserPromptSubmit and Stop hooks are separate processes that can overlap, so
// every read-modify-write of seat state goes through withLock; corrupt or
// missing state is treated as missing (S2); everything on disk is private
// (X4: dirs 0700, files 0600). Local files only - no network, no env.
// Public functions never throw: a broken state dir must degrade a hook to a
// logged no-op, not a crash loop.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type LockResult<T> = { ok: true; value: T } | { ok: false; reason: "busy" | "error" };

const LOCK_NAME = "lock";
const RETRY_MS = 25; // poll interval while waiting (S3)
const WAIT_MS = 2000; // give up after this -> {ok:false, reason:"busy"} (S3)
const STALE_MS = 30000; // a lock this old is stale; remove and retry once (S3)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** O_EXCL create; true = we hold it. Cleans up a created-but-unwritable fd. */
function tryAcquire(lockPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "wx", 0o600); // O_CREAT | O_EXCL, private (X4)
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    try {
      if (fd !== undefined) unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed by write path */
      }
    }
  }
}

/**
 * Run fn under an exclusive lock on dir (`<dir>/lock`). Returns busy (never
 * ran fn) if the lock could not be taken within 2 s, error if acquiring or
 * fn itself failed. The lock is always removed in a finally. Never throws.
 */
export async function withLock<T>(
  dir: string,
  fn: () => T | Promise<T>,
): Promise<LockResult<T>> {
  let acquired = false;
  let lockPath = "";
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); // X4
    lockPath = `${dir}/${LOCK_NAME}`;
    const deadline = Date.now() + WAIT_MS;
    let staleRemoved = false; // "remove a stale lock and retry once"
    for (;;) {
      if (tryAcquire(lockPath)) {
        acquired = true;
        break;
      }
      if (!staleRemoved) {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
            staleRemoved = true;
            try {
              unlinkSync(lockPath);
            } catch {
              /* someone else replaced it; keep waiting */
            }
            continue; // retry once immediately
          }
        } catch {
          /* vanished between EEXIST and stat; keep waiting */
        }
      }
      if (Date.now() >= deadline) return { ok: false, reason: "busy" };
      await sleep(RETRY_MS);
    }
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    if (acquired) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

/** S2: missing, empty, truncated, non-JSON, or a directory -> null. Never throws. */
export function readJson<T>(path: string): T | null {
  try {
    if (statSync(path).isDirectory()) return null;
    const raw = readFileSync(path, "utf8");
    if (raw.trim() === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomic private write (X4): mkdir -p parent 0700, write a unique temp file
 * 0600, rename over path. Returns success; never throws.
 */
export function writeJsonAtomic(path: string, value: unknown): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    return false;
  }
}
