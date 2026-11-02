// Child-process helper for lock.test.ts (S3 proof): increments
// <dir>/counter.json under the seat lock, exactly as two overlapping hooks
// would share state. Exits non-zero if the lock was busy or errored.
import { readJson, withLock, writeJsonAtomic } from "../../plugin/src/lock.ts";

const dir = process.argv[2] ?? "";
const counter = `${dir}/counter.json`;
const res = await withLock(dir, () => {
  const n = ((readJson<{ n?: number }>(counter)?.n ?? 0) as number) + 1;
  writeJsonAtomic(counter, { n });
});
// Exit codes are unreliable under `bun test` (Subprocess.exit resolves
// undefined even for exit(7)), so success is marked on stdout: exactly one
// "ok" line per fully-successful child, written after the file is on disk.
if (res.ok) {
  process.stdout.write("ok\n");
  process.exit(0);
}
process.exit(1);
