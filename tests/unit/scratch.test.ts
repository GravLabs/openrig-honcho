// T8d-3 (ADR-0006 a2abdbd): scratch workspaces must be created with the
// deriver disabled, so test traffic never costs the model server. Pure builder checks
// plus the architect's requested light check against the FAKE: the POST
// /workspaces request log carries the configuration. (The fake has no
// workspace-create route - it 404s - but every request including its body is
// logged, which is exactly what create traffic must show.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  readFileSync, rmSync, statSync  } from "node:fs";
import { join } from "node:path";
import { startFakeHoncho } from "../support/fake-honcho.ts";
import {
  DELETE_BACKOFF_MS,
  deleteScratchWorkspace,
  cleanupScratch,
  SCRATCH_DISAPPEAR_WINDOW_MS,
  scratchName,
  scratchWorkspace,
  scratchWorkspaceConfiguration } from "../support/scratch.ts";

describe("scratchWorkspaceConfiguration (T8d-3)", () => {
  test("default: all three deriver modules disabled", () => {
    expect(scratchWorkspaceConfiguration()).toEqual({
      reasoning: { enabled: false },
      summary: { enabled: false },
      dream: { enabled: false } });
  });

  test("opt-in deriver: undefined (no configuration sent, server defaults)", () => {
    expect(scratchWorkspaceConfiguration({ deriver: true })).toBeUndefined();
    expect(scratchWorkspaceConfiguration({ deriver: false })).toBeDefined();
  });
});

describe("create request against the fake (request log)", () => {
  const run = async (): Promise<Record<string, unknown> | undefined> => {
    const fake = await startFakeHoncho();
    const savedUrl = process.env.HONCHO_URL;
    process.env.HONCHO_URL = fake.url; // fake serves under /v3
    try {
      await scratchWorkspace().catch(() => undefined); // the fake 404s workspace-create by design
      const create = fake.requests.find((r) => r.method === "POST" && r.path === "/v3/workspaces");
      expect(create !== undefined, "the create request reached the fake").toBe(true);
      return create?.body as Record<string, unknown> | undefined;
    } finally {
      if (savedUrl === undefined) delete process.env.HONCHO_URL;
      else process.env.HONCHO_URL = savedUrl;
      fake.stop();
    }
  };

  test("body carries the full scratch configuration; id still the scratch name", async () => {
    const body = await run();
    expect(typeof body?.id).toBe("string");
    expect(String(body?.id).startsWith("honcho-bridge-scratch")).toBe(true);
    expect(body?.configuration).toEqual({
      reasoning: { enabled: false },
      summary: { enabled: false },
      dream: { enabled: false } });
  });

  test("deriver opt-in omits the configuration key entirely", async () => {
    const fake = await startFakeHoncho();
    const savedUrl = process.env.HONCHO_URL;
    process.env.HONCHO_URL = fake.url;
    try {
      await scratchWorkspace(undefined, { deriver: true }).catch(() => undefined);
      const create = fake.requests.find((r) => r.method === "POST" && r.path === "/v3/workspaces");
      expect(create !== undefined).toBe(true);
      expect("configuration" in (create?.body as object)).toBe(false);
    } finally {
      if (savedUrl === undefined) delete process.env.HONCHO_URL;
      else process.env.HONCHO_URL = savedUrl;
      fake.stop();
    }
  });
});

/** Fake with HONCHO_URL pointed at it for the duration (both fix suites). */
const withFake = async (
  run: (fake: Awaited<ReturnType<typeof startFakeHoncho>>) => Promise<void>,
): Promise<void> => {
  const fake = await startFakeHoncho();
  const savedUrl = process.env.HONCHO_URL;
  process.env.HONCHO_URL = fake.url;
  try {
    await run(fake);
  } finally {
    if (savedUrl === undefined) delete process.env.HONCHO_URL;
    else process.env.HONCHO_URL = savedUrl;
    fake.stop();
  }
};

// T8e-fix-2 (architect 01:46Z): a slow-but-accepted delete must not fail the
// gate. Against the FAKE with scripted DELETE answers; injectable sleep makes
// the ~45 s window instant.
describe("deleteScratchWorkspace retry window (T8e-fix-2)", () => {
  test("409 four times then 202 -> resolves, waits follow the schedule", async () => {
    await withFake(async (fake) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [409, 409, 409, 409, 202], { method: "DELETE" });
      const waits: number[] = [];
      await deleteScratchWorkspace(name, { sleep: async (ms) => void waits.push(ms) });
      expect(waits).toEqual([500, 1_000, 2_000, 4_000]);
      const dels = fake.requests.filter((r) => r.method === "DELETE" && r.path.includes(name));
      expect(dels.length).toBe(5); // four rejected + the accepting 202
    });
  });

  test("409 forever -> throws after the window with the last status only", async () => {
    await withFake(async (fake) => {
      const name = scratchName();
      fake.failPattern(`/${name}`, { status: 409 }); // constant, like a wedged delete queue
      const waits: number[] = [];
      let msg = "";
      await deleteScratchWorkspace(name, { sleep: async (ms) => void waits.push(ms) }).catch(
        (e: unknown) => void (msg = e instanceof Error ? e.message : String(e)),
      );
      expect(msg).toContain("delete failed after retries: HTTP 409");
      expect(msg).not.toContain("fake:"); // status only, never body text
      expect(waits).toEqual([...DELETE_BACKOFF_MS]); // the full ~45 s schedule spent
      expect(waits.reduce((a, b) => a + b, 0)).toBe(45_500);
      const dels = fake.requests.filter((r) => r.method === "DELETE" && r.path.includes(name));
      expect(dels.length).toBe(DELETE_BACKOFF_MS.length + 1);
    });
  });

  test("non-retryable status (400) is a hard no NOW, not after the window", async () => {
    await withFake(async (fake) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [400], { method: "DELETE" });
      const waits: number[] = [];
      let msg = "";
      await deleteScratchWorkspace(name, { sleep: async (ms) => void waits.push(ms) }).catch(
        (e: unknown) => void (msg = e instanceof Error ? e.message : String(e)),
      );
      expect(msg).toContain("delete failed: HTTP 400");
      expect(waits).toEqual([]);
    });
  });

  test("404 on the workspace DELETE means already-gone -> done", async () => {
    await withFake(async () => {
      // the fake has no workspace-DELETE route at all: it 404s, which under
      // T8e-fix-2 semantics is success (the deletion goal is proven by absence)
      await deleteScratchWorkspace(scratchName(), { sleep: async () => undefined });
    });
  });
});

// T8e-fix-3 (architect 02:16Z, ADR-0006 per run mode): heavy = DELETE
// accepted -> stop (gate's leftovers step is the disappearance proof);
// light = additionally poll out of workspaces/list (SCRATCH_DISAPPEAR_WINDOW_MS;
// 900 s since the ADR-0006 amendment 2026-10-30, T13d).
describe("cleanupScratch mode switch (T8e-fix-3)", () => {
  // T14f: these four tests prove the UNSET behaviour, so they must run with
  // HONCHO_GATE_DELETES absent - inside a real gate run the env IS set for
  // every step, and without this the light tests would take the new
  // accepted-and-record path (and write into the gate's own file).
  let savedGateDeletes: string | undefined;
  beforeEach(() => {
    savedGateDeletes = process.env.HONCHO_GATE_DELETES;
    delete process.env.HONCHO_GATE_DELETES;
  });
  afterEach(() => {
    if (savedGateDeletes === undefined) delete process.env.HONCHO_GATE_DELETES;
    else process.env.HONCHO_GATE_DELETES = savedGateDeletes;
  });

  test("heavy: accepted -> returns without ANY list poll", async () => {
    await withFake(async (fake) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
      const out = await cleanupScratch([name], {
        heavy: true,
        listWorkspaces: async () => {
          throw new Error("heavy must never poll the list");
        } });
      expect(out).toBe("accepted");
    });
  });

  test("mode comes from HONCHO_HEAVY_TESTS when not passed", async () => {
    await withFake(async (fake) => {
      const saved = process.env.HONCHO_HEAVY_TESTS;
      process.env.HONCHO_HEAVY_TESTS = "1";
      try {
        const name = scratchName();
        fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
        const out = await cleanupScratch([name], {
          listWorkspaces: async () => {
            throw new Error("env-heavy must never poll the list");
          } });
        expect(out).toBe("accepted");
      } finally {
        if (saved === undefined) delete process.env.HONCHO_HEAVY_TESTS;
        else process.env.HONCHO_HEAVY_TESTS = saved;
      }
    });
  });

  test("light: polls until the names are gone, on the 3 s schedule", async () => {
    await withFake(async (fake) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
      let calls = 0;
      const waits: number[] = [];
      const out = await cleanupScratch([name], {
        heavy: false,
        sleep: async (ms) => void waits.push(ms),
        listWorkspaces: async () => {
          calls += 1;
          return calls < 3 ? [name, "openrig"] : ["openrig"];
        } });
      expect(out).toBe("disappeared");
      expect(calls).toBe(3);
      expect(waits).toEqual([3000, 3000]);
    });
  });

  test(`light: still listed at the ${SCRATCH_DISAPPEAR_WINDOW_MS / 1000} s deadline with DELETE accepted -> passes as purge-pending (F5)`, async () => {
    // F5 (review R14 O3) FLIPS this pin: the DELETE here is accepted (202),
    // so this state is the async purge lag the gate's leftovers step passes
    // as "accepted deletes pending purge" - the light poll reaches the same
    // verdict instead of throwing. release.ts stays the release backstop.
    await withFake(async (fake) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
      const clock = { t: 0 };
      const out = await cleanupScratch([name], {
        heavy: false,
        now: () => clock.t,
        sleep: async (ms) => void (clock.t += ms),
        listWorkspaces: async () => [name] });
      expect(out).toBe("accepted"); // the gate's own verdict for this state
      expect(clock.t).toBe(SCRATCH_DISAPPEAR_WINDOW_MS); // the full window still spent
    });
  });
});

// T14f (ADR-0006 amendment 2026-10-31): inside a gate run (the gate sets
// HONCHO_GATE_DELETES=<abs path>) BOTH modes stop once every DELETE is
// accepted and append one {"name":..,"at":..} JSON line per name to that
// file - the gate's leftovers step passes pending deletes against it and
// release.ts refuses while any scratch is still listed. Unset: the mode
// switch above, unchanged.
describe("cleanupScratch with HONCHO_GATE_DELETES (T14f)", () => {
  const withGateFile = async (
    run: (fake: Awaited<ReturnType<typeof startFakeHoncho>>, file: string) => Promise<void>,
  ): Promise<void> => {
    const dir = makeTempDir("t14f-scratch-");
    const file = join(dir, "gate-deletes.jsonl");
    const saved = process.env.HONCHO_GATE_DELETES;
    process.env.HONCHO_GATE_DELETES = file;
    try {
      await withFake((fake) => run(fake, file));
    } finally {
      if (saved === undefined) delete process.env.HONCHO_GATE_DELETES;
      else process.env.HONCHO_GATE_DELETES = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const records = (file: string): { name?: string; at?: string }[] =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((s) => s.trim() !== "")
      .map((s) => JSON.parse(s) as { name?: string; at?: string });
  const noPoll = async (): Promise<string[]> => {
    throw new Error("gate-deletes mode must never poll the list");
  };

  test("heavy mode: accepted -> records the name, 0600 file, NO list poll", async () => {
    await withGateFile(async (fake, file) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
      const out = await cleanupScratch([name], { heavy: true, listWorkspaces: noPoll });
      expect(out).toBe("accepted");
      const recs = records(file);
      expect(recs.length).toBe(1);
      expect(recs[0].name).toBe(name);
      expect(Number.isNaN(Date.parse(String(recs[0].at)))).toBe(false);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  test("LIGHT mode with the env set: stops at accepted too, list never called (RED on main)", async () => {
    await withGateFile(async (fake, file) => {
      const name = scratchName();
      fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
      const out = await cleanupScratch([name], { heavy: false, listWorkspaces: noPoll });
      expect(out).toBe("accepted"); // main would poll here and throw
      expect(records(file).map((r) => r.name)).toEqual([name]);
    });
  });

  test("several calls append: one line per name, across modes", async () => {
    await withGateFile(async (fake, file) => {
      const n1 = scratchName();
      const n2 = scratchName();
      const n3 = scratchName();
      for (const n of [n1, n2, n3]) fake.scriptPattern(`/${n}`, [202], { method: "DELETE" });
      await cleanupScratch([n1], { heavy: true, listWorkspaces: noPoll });
      await cleanupScratch([n2, n3], { heavy: false, listWorkspaces: noPoll });
      expect(records(file).map((r) => r.name).sort()).toEqual([n1, n2, n3].sort());
    });
  });

  test("env set to blank is unset: light still polls to disappearance", async () => {
    const saved = process.env.HONCHO_GATE_DELETES;
    process.env.HONCHO_GATE_DELETES = "   ";
    try {
      await withFake(async (fake) => {
        const name = scratchName();
        fake.scriptPattern(`/${name}`, [202], { method: "DELETE" });
        let calls = 0;
        const out = await cleanupScratch([name], {
          heavy: false,
          sleep: async () => undefined,
          listWorkspaces: async () => {
            calls += 1;
            return calls < 2 ? [name] : [];
          } });
        expect(out).toBe("disappeared");
        expect(calls).toBe(2);
      });
    } finally {
      if (saved === undefined) delete process.env.HONCHO_GATE_DELETES;
      else process.env.HONCHO_GATE_DELETES = saved;
    }
  });
});
