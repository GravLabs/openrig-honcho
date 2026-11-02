// T8d-2 item 1 (ADR-0006 R1/R2/R3/S5): the REAL hook bins as child processes
// against the fake server in every failure mode. Nothing here imports the
// plugin in-process - every action is `bun plugin/bin/<hook>.ts` with stdin
// fixtures, so the budgets and the silence contract are measured around a
// real process, exactly as Claude Code would run them. Fake only: no network.
//
// One-line summary printed at the end (counts, max durations) for the gate.

import { afterAll, describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  readFileSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { startFakeHoncho, type FakeHoncho, type FakeMode } from "../support/fake-honcho.ts";

const REPO = join(import.meta.dir, "..", "..");
const BIN = {
  "session-start": join(REPO, "plugin/bin/session-start.ts"),
  "user-prompt": join(REPO, "plugin/bin/user-prompt.ts"),
  stop: join(REPO, "plugin/bin/stop.ts") } as const;
type BinName = keyof typeof BIN;

const WS = "chaos-ws";
const SELF = "chaos-peer";
const SESS = `${SELF}--general--1`; // the default-mission session (ADR-0002 naming)

// R3 budgets (ms, measured around the child process)
const BUDGET: Record<BinName, number> = {
  "session-start": 4_500,
  "user-prompt": 10_000,
  stop: 10_000 };

// R3 measures HOOK overhead (spawn + own work + one bounded request), it is
// NOT a network guard: slow-mode's 2000 ms reply is cut by HONCHO_TIMEOUT_MS=
// 1500 well inside the budgets, so a slow server can never push a run past
// them on its own (review note 00:09Z).
const MODES: Array<{ m: FakeMode; env?: Record<string, string>; delayMs?: number }> = [
  { m: "ok" },
  { m: "refuse" },
  { m: "500" },
  { m: "hang", env: { HONCHO_TIMEOUT_MS: "200" } }, // a hanging server must end in the client timeout, not the hook waiting forever
  { m: "slow", delayMs: 2_000 },
];

const summary = { runs: 0, maxMs: { "session-start": 0, "user-prompt": 0, stop: 0 } as Record<BinName, number> };
const fakes: FakeHoncho[] = [];
const startFake = async (): Promise<FakeHoncho> => {
  const f = await startFakeHoncho();
  fakes.push(f);
  return f;
};

afterAll(() => {
  const line = `CHAOS SUMMARY runs=${summary.runs} maxMs[session-start]=${summary.maxMs["session-start"]} maxMs[user-prompt]=${summary.maxMs["user-prompt"]} maxMs[stop]=${summary.maxMs.stop}`;
  console.log(line);
});

const baseEnv = (dir: string, fake: FakeHoncho, over: Record<string, string> = {}): Record<string, string> => ({
  HOME: dir,
  HONCHO_STATE_DIR: dir,
  HONCHO_URL: fake.url,
  HONCHO_WORKSPACE: WS,
  HONCHO_PEER: SELF,
  HONCHO_LEADER_PEER: SELF, // this seat is its own leader: prompts get reasoning per E5 as usual
  HONCHO_TIMEOUT_MS: "1500",
  ...over });

interface BinRun {
  code: number;
  out: string;
  err: string;
  ms: number;
}

async function runBin(bin: BinName, env: Record<string, string>, stdin: unknown): Promise<BinRun> {
  const t0 = Date.now();
  const p = Bun.spawn([process.execPath, BIN[bin]], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe" });
  const sink = p.stdin as unknown as { write(d: string): void; end(): void };
  sink.write(`${JSON.stringify(stdin)}\n`);
  sink.end();
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  const code = await p.exited;
  const ms = Date.now() - t0;
  summary.runs += 1;
  if (ms > summary.maxMs[bin]) summary.maxMs[bin] = ms;
  return { code, out, err, ms };
}

const stdinFor = (bin: BinName, n: number, dir: string): Record<string, unknown> => {
  if (bin === "session-start") return { session_id: "claude-1", source: "startup", cwd: dir };
  if (bin === "user-prompt") return { session_id: "claude-1", prompt: `chaos ${bin} probe ${n} [C-${n}]` };
  const tp = join(dir, `tr-${n}.jsonl`);
  writeFileSync(
    tp,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `probe ${n} question` }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `probe ${n} answer [C-${n}]` }] } }),
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  return { session_id: "claude-1", transcript_path: tp };
};

describe("R3: real bins meet the hook budgets in EVERY mode", () => {
  for (const bin of Object.keys(BIN) as BinName[]) {
    for (const spec of MODES) {
      const label = spec.m === "slow" ? "slow(2s)" : spec.m;
      test(`${bin} / ${label}: exit 0, silent stderr, budget, stdout contract`, async () => {
        const fake = await startFake();
        const dir = makeTempDir("chaos-r3-");
        const env = baseEnv(dir, fake, spec.env ?? {});
        fake.mode(spec.m, spec.delayMs !== undefined ? { delayMs: spec.delayMs } : undefined);
        const r = await runBin(bin, env, stdinFor(bin, 1, dir));
        expect(r.code, `exit code, stderr: ${r.err.slice(0, 200)}`).toBe(0);
        expect(r.err).toBe(""); // stderr empty, always
        expect(r.ms).toBeLessThanOrEqual(BUDGET[bin]);
        if (bin === "session-start") {
          if (r.out !== "") {
            // only the SessionStart JSON line, and nothing after it
            const parsed = JSON.parse(r.out) as { hookSpecificOutput?: { hookEventName?: string } };
            expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
          }
        } else {
          expect(r.out).toBe(""); // user-prompt and stop never print
        }
        fake.stop();
      }, 60_000);
    }
  }
});

describe("R1: 20 refused prompts then 5 ok - nothing lost, nothing reordered", () => {
  test("25 prompts all land on the fake, in order, scoped, no auto_created, spool empty", async () => {
    const fake = await startFake();
    const dir = makeTempDir("chaos-r1-");
    const env = baseEnv(dir, fake);
    fake.mode("refuse");
    for (let i = 1; i <= 20; i++) {
      const r = await runBin("user-prompt", env, { session_id: "claude-1", prompt: `r1 prompt ${i} [R1-${i}]` });
      expect(r.code).toBe(0);
    }
    fake.mode("ok");
    for (let i = 21; i <= 25; i++) {
      const r = await runBin("user-prompt", env, { session_id: "claude-1", prompt: `r1 prompt ${i} [R1-${i}]` });
      expect(r.code).toBe(0);
    }
    // the writer used the free-n fallback while the fake refused sessions/list,
    // so take the session key from the fake instead of assuming `<peer>--general--1`
    const keys = [...fake.state.messages.keys()];
    expect(keys.length).toBe(1);
    const key = keys[0] as string;
    const sid = key.slice(WS.length + 1);
    const stored = fake.state.messages.get(key) ?? [];
    expect(stored.length).toBe(25);
    // exact order: the spooled 20 replay oldest-first BEFORE the live 5
    const order = stored.map((m) => {
      const t = String((m as { content?: string }).content ?? "");
      const i = t.match(/\[R1-(\d+)\]/)?.[1];
      return i === undefined ? -1 : Number(i);
    });
    expect(order).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    // right scope, no implicit creation anywhere
    for (const s of fake.state.sessions.values()) {
      expect(s.auto_created).toBeUndefined();
    }
    expect(fake.state.scopes.get(`${WS}/general`) ?? []).toContain(sid);
    // spool drained: live file empty, no replay residue
    const spoolDir = join(dir, WS, "spool");
    let spoolBytes = 0;
    for (const f of ["chaos-peer.jsonl", "chaos-peer.replay.jsonl"]) {
      try {
        spoolBytes += readFileSync(join(spoolDir, f), "utf8").trim().length;
      } catch {
        /* absent counts as empty */
      }
    }
    expect(spoolBytes).toBe(0);
    fake.stop();
  }, 180_000);
});

describe("R2: hang -> maybe_sent spool -> replay carries replay_of", () => {
  test("only maybe_sent entries duplicate, and each duplicate pair is original + replay_of copy", async () => {
    const fake = await startFake();
    const dir = makeTempDir("chaos-r2-");
    // first prompt under ok so the ensure (createSession) lands: the hang must
    // then hit the MESSAGE send, which is what makes an entry maybe_sent. An
    // ensure failure spools maybe_sent:false by design (nothing was sent).
    // F2 (fixed per architect 22:25Z ruling): resolveSession now carries
    // ensured_session/members, so all three hung runs skip the ensure, hit the
    // send, and spool maybe_sent:true.
    const ok0 = baseEnv(dir, fake);
    fake.mode("ok");
    expect((await runBin("user-prompt", ok0, { session_id: "claude-1", prompt: "r2 seed [R2-0]" })).code).toBe(0);
    const env = baseEnv(dir, fake, { HONCHO_TIMEOUT_MS: "200" });
    fake.mode("hang");
    for (let i = 1; i <= 3; i++) {
      const rHung = await runBin("user-prompt", env, { session_id: "claude-1", prompt: `r2 hung ${i} [R2-${i}]` });
      expect(rHung.code).toBe(0); // timeout is spooled, never a crash
    }
    // the spool holds all three as maybe_sent. Each run's replay-first pass
    // RENAMED the live file to <peer>.replay.jsonl and left the rest there,
    // so read both files together.
    const readSpool = (name: string): Array<{ maybe_sent: boolean; messages: Array<Record<string, unknown>> }> => {
      try {
        return readFileSync(join(dir, WS, "spool", name), "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as { maybe_sent: boolean; messages: Array<Record<string, unknown>> });
      } catch {
        return [];
      }
    };
    const spool = [...readSpool("chaos-peer.replay.jsonl"), ...readSpool("chaos-peer.jsonl")];
    expect(spool.length).toBe(3);
    for (const e of spool) expect(e.maybe_sent).toBe(true);
    const hungCids = new Set(
      spool.flatMap((e) => e.messages.map((m) => String((m.metadata as Record<string, unknown> | undefined)?.client_id ?? ""))),
    );
    expect(hungCids.size).toBe(3);
    // recovery: the next ok run replays them with metadata.replay_of
    fake.mode("ok");
    const env2 = baseEnv(dir, fake);
    const r = await runBin("user-prompt", env2, { session_id: "claude-1", prompt: "r2 recovered [R2-rec]" });
    expect(r.code).toBe(0);
    const stored = fake.state.messages.get(`${WS}/${SESS}`) ?? [];
    const byCid = new Map<string, Array<Record<string, unknown>>>();
    for (const m of stored) {
      const meta = (m as { metadata?: Record<string, unknown> }).metadata ?? {};
      const cid = String(meta.client_id ?? "");
      byCid.set(cid, [...(byCid.get(cid) ?? []), m as Record<string, unknown>]);
    }
    let dups = 0;
    let replayCopies = 0;
    for (const [cid, list] of byCid) {
      expect(cid).not.toBe("");
      if (list.length > 1) {
        dups += 1;
        expect(list.length).toBe(2); // hang can produce at most one duplicate per entry
        const withReplay = list.filter((m) => {
          const meta = (m.metadata ?? {}) as Record<string, unknown>;
          return meta.replay_of === cid;
        });
        expect(withReplay.length).toBe(1); // the second copy is the replay, marked
        replayCopies += 1;
      } else {
        // a single copy may be the replay of an original the hung server
        // stored without acking; it is still one delivered message. Only
        // maybe_sent entries may ever carry replay_of.
        const meta = (list[0]?.metadata ?? {}) as Record<string, unknown>;
        if (meta.replay_of !== undefined) expect(hungCids.has(cid)).toBe(true);
      }
    }
    // duplicates happen ONLY for the three hung (maybe_sent) prompts
    expect(dups).toBeLessThanOrEqual(3);
    for (const [cid, list] of byCid) {
      if (list.length > 1) expect(hungCids.has(cid)).toBe(true);
    }
    expect(replayCopies).toBe(dups);
    const rec = stored.filter((m) => String((m as { content?: string }).content ?? "").includes("[R2-rec]"));
    expect(rec.length).toBe(1);
    expect(((rec[0] as { metadata?: Record<string, unknown> }).metadata ?? {}).replay_of).toBeUndefined();
    fake.stop();
  }, 120_000);
});

describe("S5: user-prompt and stop for one turn, started together, 20x", () => {
  test("each pair lands prompt-before-reply by created_at", async () => {
    const fake = await startFake();
    const dir = makeTempDir("chaos-s5-");
    const env = baseEnv(dir, fake);
    for (let i = 1; i <= 20; i++) {
      const tp = join(dir, `s5-${i}.jsonl`);
      // F1 (fixed per architect 22:25Z ruling): the reply's created_at comes
      // from the transcript timestamp of the last assistant text block. The
      // fixture stamps the assistant line 2 s AFTER the turn opened - turn
      // semantics (submit -> work -> answer), which is exactly what the race
      // must preserve regardless of when each hook process happens to run.
      const tOpen = new Date();
      const tAnswer = new Date(tOpen.getTime() + 2_000);
      writeFileSync(
        tp,
        [
          JSON.stringify({ type: "user", timestamp: tOpen.toISOString(), message: { role: "user", content: [{ type: "text", text: `s5 turn ${i} question [Q-${i}]` }] } }),
          JSON.stringify({ type: "assistant", timestamp: tAnswer.toISOString(), message: { role: "assistant", content: [{ type: "text", text: `s5 turn ${i} answer [A-${i}]` }] } }),
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      const [rp, rs] = await Promise.all([
        runBin("user-prompt", env, { session_id: "claude-1", prompt: `s5 turn ${i} question [Q-${i}]` }),
        runBin("stop", env, { session_id: "claude-1", transcript_path: tp }),
      ]);
      expect(rp.code).toBe(0);
      expect(rs.code).toBe(0);
    }
    const stored = (fake.state.messages.get(`${WS}/${SESS}`) ?? []) as Array<Record<string, unknown>>;
    const allWith = (tag: string): Array<Record<string, unknown>> =>
      stored.filter((m) => String(m.content ?? "").includes(tag));
    for (let i = 1; i <= 20; i++) {
      const qs = allWith(`[Q-${i}]`);
      const as = allWith(`[A-${i}]`);
      // race hygiene, strict: exactly one prompt and one reply per turn (no
      // double-record through the seat lock), nothing else invented
      expect(qs.length, `turn ${i}: exactly one prompt recorded`).toBe(1);
      expect(as.length, `turn ${i}: exactly one reply recorded`).toBe(1);
      // S5 strict (architect ruling 22:25Z): prompt strictly before reply by
      // created_at - the reply stamps the transcript's assistant timestamp.
      const qc = String((qs[0] as { created_at?: string }).created_at ?? "");
      const ac = String((as[0] as { created_at?: string }).created_at ?? "");
      expect(qc < ac, `turn ${i}: prompt ${qc} must be before reply ${ac}`).toBe(true);
    }
    expect(stored.length).toBe(40);
    fake.stop();
  }, 300_000);
});
