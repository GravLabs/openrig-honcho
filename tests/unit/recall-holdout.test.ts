// T18b (ADR-0013 decision 2, architect option-c ruling 2026-11-04 15:27Z):
// the recall hook's randomized holdout, spawned for real against a local
// Bun.serve fake (same harness shape as recall-bin.test.ts). Pinned here:
// the arm assignment is deterministic (same session + prompt, two fresh
// state dirs -> same arm, matching the pinned hash formula); the share
// over 200 distinct (session, prompt) runs at 0.5 is within the ADR's ±5%;
// a held run prints NOTHING, logs arm "held", still writes the seen file
// (so the item never resurfaces in that session) and the private held
// entry (0600); and with the setting unset or "0" stdout is byte-identical
// and no "arm" key or held file appears anywhere (today's behavior,
// unchanged). No real Honcho calls; scratch-named workspaces anyway.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { scratchName } from "../support/scratch.ts";

const REPO = join(import.meta.dir, "..", "..");
const BIN = join(REPO, "plugin/bin/recall.ts");

/** ok-mode fake: per-pair distinct conclusions, created 2 h ago (above the
 * 30-minute context floor) - a block always renders. Copied shape from
 * recall-bin.test.ts, trimmed to what the holdout needs. */
function makeFakeOk(): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const filters = (body?.filters ?? {}) as Record<string, string>;
      const observer = filters.observer ?? "unknown";
      const observed = filters.observed ?? "";
      return Response.json([
        {
          id: `concl-${observer}-${observed}`,
          content: `fact from ${observer} about ${observed}`,
          observer_id: observer,
          observed_id: observed,
          created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        },
      ]);
    },
  });
  return { port: server.port as number, stop: (): void => void server.stop(true) };
}

const baseEnv = (
  stateDir: string,
  ws: string,
  port: number,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  HOME: stateDir,
  HONCHO_STATE_DIR: stateDir,
  HONCHO_URL: `http://127.0.0.1:${port}/v3`,
  HONCHO_WORKSPACE: ws,
  HONCHO_PEER: "build",
  ...extra,
});

async function runBin(
  env: Record<string, string>,
  stdin: unknown,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(JSON.stringify(stdin));
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

// Same formula as plugin/bin/recall.ts: first 8 hex digits of sha256 over
// session id + NUL + raw prompt, mapped to [0,1) via 2^32, < share -> held.
const armOf = (share: number, session: string, prompt: string): "held" | "shown" =>
  Number.parseInt(
    createHash("sha256").update(session + String.fromCharCode(0) + prompt, "utf8").digest("hex").slice(0, 8),
    16,
  ) /
    0x1_0000_0000 <
  share
    ? "held"
    : "shown";

const peerPrompt = (ws: string, body: string): string =>
  [
    `From: dev-x@${ws}`,
    `To: build@${ws}`,
    "Sent: 10-30 09:00Z",
    "---",
    body,
    "---",
    `↩ Reply: rig send dev-x@${ws} "..."`,
  ].join("\n");

const logEvents = (stateDir: string, ws: string): Record<string, unknown>[] => {
  const file = join(stateDir, "log", `${ws}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((s) => s !== "")
    .map((s) => JSON.parse(s) as Record<string, unknown>);
};

/** T15a once-guard: a byte-identical stdin within 5 s leaves as
 * duplicate-run. To replay the SAME event in the SAME state dir (the held
 * resurfacing check), age this run's marker first. */
const ageRecallMarker = (stateDir: string, ws: string, stdin: unknown): void => {
  const key = createHash("sha256")
    .update("recall" + String.fromCharCode(0) + JSON.stringify(stdin), "utf8")
    .digest("hex");
  const t = new Date(Date.now() - 5_100);
  utimesSync(join(stateDir, ws, "once", key), t, t);
};

function fresh(
  fn: (stateDir: string, ws: string, port: number) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const stateDir = makeTempDir("t18b-");
    const fake = makeFakeOk();
    try {
      await fn(stateDir, scratchName(), fake.port);
    } finally {
      fake.stop();
    }
  };
}

describe("recall holdout bin (T18b)", () => {
  test(
    "determinism: same session + prompt -> same arm in two fresh state dirs",
    fresh(async (stateDir, ws, port) => {
      const session = "det-session-1";
      const prompt = peerPrompt(ws, "did the deploy land, question one?");
      const dirB = makeTempDir("t18b-");
      const env = baseEnv(stateDir, ws, port, { HONCHO_RECALL_HOLDOUT: "0.9" });
      const a = await runBin(env, { session_id: session, prompt });
      const b = await runBin(baseEnv(dirB, ws, port, { HONCHO_RECALL_HOLDOUT: "0.9" }), {
        session_id: session,
        prompt,
      });
      expect([a.code, b.code, a.err, b.err]).toEqual([0, 0, "", ""]);
      const armA = logEvents(stateDir, ws).find((e) => e.event === "injected")?.arm;
      const armB = logEvents(dirB, ws).find((e) => e.event === "injected")?.arm;
      expect(armA).toBeDefined();
      expect(armA).toBe(armB);
      // the hook's choice matches the pinned formula, not just itself
      expect(armA).toBe(armOf(0.9, session, prompt));
      if (armA === "held") {
        expect(a.out).toBe("");
        expect(b.out).toBe("");
      } else {
        expect(a.out).toBe(b.out); // shown: both print the block
        expect(a.out).toContain("additionalContext");
      }
    }),
    30_000,
  );

  test(
    "share: 200 distinct (session, prompt) runs at 0.5 split within ±5%",
    fresh(async (stateDir, ws, port) => {
      const env = baseEnv(stateDir, ws, port, { HONCHO_RECALL_HOLDOUT: "0.5" });
      for (let start = 0; start < 200; start += 20) {
        await Promise.all(
          Array.from({ length: 20 }, (_, k) => {
            const i = start + k;
            // distinct session AND body each run: the seen file and the
            // once-guard must never silence a sample
            return runBin(env, {
              session_id: `hs-${i}`,
              prompt: peerPrompt(ws, `did the deploy land, number ${i}?`),
            });
          }),
        );
      }
      const events = logEvents(stateDir, ws);
      expect(events.filter((e) => e.event === "duplicate-run").length).toBe(0);
      expect(events.filter((e) => e.event === "empty").length).toBe(0);
      const arms = events.filter((e) => e.event === "injected").map((e) => e.arm);
      expect(arms.length).toBe(200);
      const held = arms.filter((a) => a === "held").length;
      // The workspace name is random and sits in the prompt, so this sample
      // differs every run: a +-5% bound here failed ~13% of runs by chance
      // alone. Assert the exact count the pinned formula gives for this sample;
      // the share itself is checked on fixed inputs in the next test.
      let expected = 0;
      for (let i = 0; i < 200; i++) {
        if (armOf(0.5, `hs-${i}`, peerPrompt(ws, `did the deploy land, number ${i}?`)) === "held") expected++;
      }
      expect(held).toBe(expected);
    }),
    120_000,
  );

  test("share: the formula splits fixed inputs at 0.5 within +-5% (ADR-0013)", () => {
    let held = 0;
    for (let i = 0; i < 2000; i++) {
      if (armOf(0.5, `hs-${i}`, peerPrompt("fixed-rig", `did the deploy land, number ${i}?`)) === "held") held++;
    }
    expect(held).toBeGreaterThanOrEqual(900);
    expect(held).toBeLessThanOrEqual(1100);
  });

  test(
    "a held run: no stdout, log arm held, seen file written, private held entry 0600, item never resurfaces",
    fresh(async (stateDir, ws, port) => {
      const body = "the probe body, held on purpose?";
      const prompt = peerPrompt(ws, body);
      // pick a session whose arm is "held" at 0.9 by the pinned formula:
      // deterministic, no flake
      let session = "";
      for (let i = 1; i < 200; i++) {
        if (armOf(0.9, `holdprobe-${i}`, prompt) === "held") {
          session = `holdprobe-${i}`;
          break;
        }
      }
      expect(session).not.toBe(""); // at 0.9 the first probe almost surely hits
      const env = baseEnv(stateDir, ws, port, { HONCHO_RECALL_HOLDOUT: "0.9" });
      const stdinObj = { session_id: session, prompt };
      const r = await runBin(env, stdinObj);
      expect([r.code, r.err]).toEqual([0, ""]);
      expect(r.out).toBe(""); // a held block never reaches stdout
      const injected = logEvents(stateDir, ws).filter((e) => e.event === "injected");
      expect(injected.length).toBe(1);
      expect(injected[0]).toMatchObject({ hook: "recall", event: "injected", ok: true, arm: "held" });
      expect(typeof injected[0].n_items).toBe("number");
      expect(Number(injected[0].n_items)).toBeGreaterThan(0);
      // seen state updated exactly as for a shown block
      const seenFile = join(stateDir, ws, "seats", "build.recall.json");
      expect(existsSync(seenFile)).toBe(true);
      const seen = JSON.parse(readFileSync(seenFile, "utf8")) as { session?: string; ids: string[] };
      expect(seen.session).toBe(session);
      expect(seen.ids.length).toBeGreaterThan(0);
      // the private held entry (option c): exact prompt hash, rendered text, 0600
      const heldFile = join(stateDir, ws, "seats", "build.held.jsonl");
      expect(statSync(heldFile).mode & 0o777).toBe(0o600);
      const he = JSON.parse(readFileSync(heldFile, "utf8").trim()) as {
        session: string;
        prompt_sha256: string;
        n_items: number;
        text: string;
      };
      expect(he.session).toBe(session);
      expect(he.prompt_sha256).toBe(createHash("sha256").update(prompt, "utf8").digest("hex"));
      expect(he.text).toContain("[openrig-honcho ");
      // replay of the same prompt in the same session: the held item is
      // already seen -> silence, and no second held entry or injected event
      ageRecallMarker(stateDir, ws, stdinObj);
      const r2 = await runBin(env, stdinObj);
      expect(r2.out).toBe("");
      const after = logEvents(stateDir, ws);
      expect(after.filter((e) => e.event === "injected").length).toBe(1);
      expect(after.some((e) => e.event === "empty")).toBe(true);
      expect(readFileSync(heldFile, "utf8").trim().split("\n").length).toBe(1);
    }),
    30_000,
  );

  test(
    "unset vs 0: stdout byte-identical, no arm key, no held file (today's behavior)",
    fresh(async (stateDir, ws, port) => {
      const stdinObj = { session_id: "zero-session", prompt: peerPrompt(ws, "did the deploy land at all?") };
      const a = await runBin(baseEnv(stateDir, ws, port), stdinObj);
      const dirB = makeTempDir("t18b-");
      const b = await runBin(baseEnv(dirB, ws, port, { HONCHO_RECALL_HOLDOUT: "0" }), stdinObj);
      expect(a.out).toBe(b.out);
      expect(a.out).toContain("additionalContext"); // still shown, as today
      for (const d of [stateDir, dirB]) {
        const injected = logEvents(d, ws).filter((e) => e.event === "injected");
        expect(injected.length).toBe(1);
        expect("arm" in injected[0]).toBe(false); // logs unchanged
        expect(existsSync(join(d, ws, "seats", "build.held.jsonl"))).toBe(false);
      }
    }),
    30_000,
  );
});
