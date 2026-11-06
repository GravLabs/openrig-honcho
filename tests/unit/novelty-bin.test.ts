// T19c (ADR-0014 decision 4): the recall hook's novelty filter, SPAWNED for
// real against a local Bun.serve fake (same harness shape as
// recall-holdout.test.ts; no real Honcho calls; scratch-named workspaces
// anyway). Pinned here: items whose distinctive terms are all known from
// the transcript tail (+ the message itself) are dropped with the new
// dropped_known count; a block that filters down to exactly one item is not
// shown at all (dropped_small 1, the empty event: nothing injected); zero
// items stays the plain empty event; a missing or oversized transcript
// window behaves exactly as the row says; HONCHO_RECALL_NOVELTY=off is
// byte-identical to today (all items shown, no new log keys); and the
// holdout arm is chosen on the FINAL filtered block (a held entry holds
// the filtered text; a suppressed block never reaches the arm and writes
// no held entry).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchName } from "../support/scratch.ts";
import { heldPath } from "../../plugin/src/held.ts";
import { TAIL_BYTES } from "../../plugin/src/terms.ts";

const REPO = join(import.meta.dir, "..", "..");
const BIN = join(REPO, "plugin/bin/recall.ts");

/** The three conclusions, created 2 h ago (over the context floor). Every
 * distinct token is listed so each test can aim the known set exactly:
 * A = {zephyrium, antenna}; B = {kettleboard, shipment, slipped};
 * C = {tarpaulin, warehouse, friday}. */
const ITEMS = [
  { id: "c-nov-a", content: "zephyrium antenna" },
  { id: "c-nov-b", content: "kettleboard shipment slipped" },
  { id: "c-nov-c", content: "tarpaulin warehouse friday" },
];

function makeFakeOk(): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      return Response.json(
        ITEMS.map((c) => ({
          ...c,
          observer_id: "build",
          observed_id: "dev-x",
          created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        })),
      );
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

const entry = (type: "user" | "assistant", text: string): string =>
  JSON.stringify({ type, message: { content: [{ type: "text", text }] } });

/** One scenario per fresh (stateDir, ws): no seen carry-over, no
 * once-marker collision. The prompt body makes "zephyrium" and
 * "kettleboard" + "shipment" known via the MESSAGE itself. */
const BODY = "Did the zephyrium retune land? Filing the kettleboard shipment slip now?";

// Same formula as plugin/bin/recall.ts (pinned by recall-holdout.test.ts):
// first 8 hex of sha256 over session + NUL + raw prompt, / 2^32, < share.
const armOf = (share: number, session: string, prompt: string): "held" | "shown" =>
  Number.parseInt(
    createHash("sha256").update(session + String.fromCharCode(0) + prompt, "utf8").digest("hex").slice(0, 8),
    16,
  ) /
    0x1_0000_0000 <
  share
    ? "held"
    : "shown";

async function run(opts: {
  transcriptLines?: string[];
  transcriptRawBytes?: Buffer;
  transcriptPathOverride?: string; // points at a file that may not exist
  env?: Record<string, string>;
  session?: string;
  ws?: string; // pin the workspace when the prompt text must be reproducible
}): Promise<{ code: number; out: string; log: Record<string, unknown>; ws: string; stateDir: string; prompt: string }> {
  const fake = makeFakeOk();
  const stateDir = makeTempDir("novelty-bin-");
  const ws = opts.ws ?? scratchName();
  let transcriptPath: string | undefined = opts.transcriptPathOverride;
  if (opts.transcriptLines !== undefined || opts.transcriptRawBytes !== undefined) {
    transcriptPath = join(stateDir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      opts.transcriptRawBytes ?? Buffer.from(opts.transcriptLines!.join("\n") + "\n", "utf8"),
    );
  }
  const prompt = peerPrompt(ws, BODY);
  const r = await runBin(baseEnv(stateDir, ws, fake.port, opts.env ?? {}), {
    session_id: opts.session ?? "nov-session",
    prompt,
    ...(transcriptPath !== undefined ? { transcript_path: transcriptPath } : {}),
  });
  fake.stop();
  const evs = logEvents(stateDir, ws);
  return { code: r.code, out: r.out, log: evs[evs.length - 1] ?? {}, ws, stateDir, prompt };
}

describe("T19c novelty filter (hook level)", () => {
  test("known-from-transcript + known-from-message items drop; the rest injects with dropped_known", async () => {
    const r = await run({
      transcriptLines: [entry("assistant", "the antenna got a fresh printed mount")],
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("kettleboard");
    expect(r.out).toContain("tarpaulin");
    expect(r.out).not.toContain("zephyrium antenna"); // A: zephyrium (message) + antenna (transcript)
    expect(r.log.event).toBe("injected");
    expect(r.log.n_items).toBe(2);
    expect(r.log.dropped_known).toBe(1);
    expect(r.log.dropped_small).toBeUndefined();
  });

  test("filtered down to exactly one item: nothing shown, dropped_small 1, empty event", async () => {
    const r = await run({
      transcriptLines: [
        entry("assistant", "the antenna got a fresh printed mount"),
        entry("user", "the kettleboard shipment slipped again"),
      ],
    });
    expect(r.out).toBe("");
    expect(r.log.event).toBe("empty");
    expect(r.log.bytes).toBe(0);
    expect(r.log.n_items).toBe(0);
    expect(r.log.dropped_known).toBe(2); // A and B known; C alone -> suppressed
    expect(r.log.dropped_small).toBe(1);
  });

  test("zero items known-filtered: plain empty, no dropped_small (ruling 23:52Z)", async () => {
    const r = await run({
      transcriptLines: [
        entry("assistant", "the antenna mount and the kettleboard shipment slipped"),
        entry("user", "tarpaulin over the warehouse before friday"),
      ],
    });
    expect(r.out).toBe("");
    expect(r.log.event).toBe("empty");
    expect(r.log.dropped_known).toBe(3);
    expect(r.log.dropped_small).toBeUndefined();
  });

  test("missing path, unreadable file and empty transcript: no filter, dropped_known 0", async () => {
    for (const opts of [
      {}, // no transcript_path at all
      { transcriptPathOverride: "/nonexistent-dir-9x7/nov.jsonl" }, // unreadable
      { transcriptRawBytes: Buffer.from("", "utf8") }, // empty file
    ]) {
      const r = await run(opts);
      expect(r.code).toBe(0);
      expect(r.log.event).toBe("injected");
      expect(r.log.n_items).toBe(3); // today's block: nothing was known
      expect(r.log.dropped_known).toBe(0);
    }
  });

  test("only the LAST TAIL_BYTES are read: a term in the head is not known; in the tail it is", async () => {
    const head = entry("assistant", "headpineapple and zephyrium and antenna live far in the head");
    const filler = entry("user", "padding filler entries " + "padding filler entries ".repeat(400));
    const parts = [head];
    while (Buffer.byteLength(parts.join("\n")) < TAIL_BYTES + 60_000) parts.push(filler);
    // head variant: the tail says nothing about the antenna
    const rawHead = Buffer.from([...parts, entry("assistant", "nothing relevant here")].join("\n") + "\n", "utf8");
    const a = await run({ transcriptRawBytes: rawHead });
    expect(a.log.event).toBe("injected");
    expect(a.log.dropped_known).toBe(0); // antenna NOT known (head is outside the window)
    expect(a.out).toContain("zephyrium antenna");

    // tail variant: identical size, the antenna term inside the last TAIL_BYTES
    const rawTail = Buffer.from([...parts, entry("assistant", "the antenna is at the very tail")].join("\n") + "\n", "utf8");
    const b = await run({ transcriptRawBytes: rawTail });
    expect(b.log.dropped_known).toBe(1);
    expect(b.out).not.toContain("zephyrium antenna");
  });

  test("HONCHO_RECALL_NOVELTY=off: today's behavior byte for byte, no new log keys", async () => {
    const r = await run({
      transcriptLines: [entry("assistant", "the antenna kettleboard shipment slipped tarpaulin warehouse friday zephyrium")],
      env: { HONCHO_RECALL_NOVELTY: "off" },
    });
    expect(r.log.event).toBe("injected");
    expect(r.log.n_items).toBe(3); // nothing filtered: today
    expect("dropped_known" in r.log).toBe(false);
    expect("dropped_small" in r.log).toBe(false);
  });

  test("holdout takes its arm on the FINAL filtered block; suppressed blocks never reach it", async () => {
    // HONCHO_RECALL_HOLDOUT caps at 0.9 (env gate); the session id is
    // chosen so the pinned hash formula puts this run in the held arm.
    // 2 items survive the filter -> held, and the HELD text is the FILTERED block.
    const ws = scratchName();
    const promptFor = peerPrompt(ws, BODY);
    let session = "";
    for (let i = 1; i <= 100; i++) {
      const s = `nov-held-${i}`;
      if (armOf(0.9, s, promptFor) === "held") {
        session = s;
        break;
      }
    }
    expect(session).not.toBe("");
    const held = await run({
      transcriptLines: [entry("assistant", "the antenna got a fresh printed mount")],
      env: { HONCHO_RECALL_HOLDOUT: "0.9" },
      session,
      ws,
    });
    expect(held.out).toBe("");
    expect(held.log.event).toBe("injected");
    expect(held.log.arm).toBe("held");
    expect(held.log.dropped_known).toBe(1);
    const heldRaw = readFileSync(heldPath(held.stateDir, held.ws, "build"), "utf8");
    expect(heldRaw).toContain("kettleboard");
    expect(heldRaw).not.toContain("zephyrium antenna");

    // filter leaves 1 -> suppressed BEFORE the arm: empty event, no arm key,
    // and no held entry exists at all (same always-held session).
    const sup = await run({
      transcriptLines: [
        entry("assistant", "the antenna mount"),
        entry("user", "the kettleboard shipment slipped again"),
      ],
      env: { HONCHO_RECALL_HOLDOUT: "0.9" },
      session,
    });
    expect(sup.log.event).toBe("empty");
    expect("arm" in sup.log).toBe(false);
    expect(existsSync(heldPath(sup.stateDir, sup.ws, "build"))).toBe(false);
  });
});
