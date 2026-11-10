// C2 (ADR-0016): the harness seam, driven through the REAL bins with the
// three scrubbed Codex fixtures (tests/fixtures/codex/, paths /home/test) and
// `--harness codex`. Everything runs against local fakes - no real Honcho,
// no Strata, no Codex CLI. The Claude path's byte-identity is guarded by the
// untouched existing suites (recall-bin, once-bins, review-t6a/t6b, digest).
//
// Proved here: session-start injects with hookEventName SessionStart;
// source "fork" behaves as resume (context_start untouched, log event
// "resume"); user-prompt records the fixture prompt under the config peer;
// recall output carries hookEventName UserPromptSubmit; stop records
// last_assistant_message and never reads the transcript, even when the
// transcript_path exists.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import { scratchName } from "../support/scratch.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const REPO = join(import.meta.dir, "..", "..");
const FIXTURES = join(REPO, "tests/fixtures/codex");
const BIN = {
  sessionStart: join(REPO, "plugin/bin/session-start.ts"),
  userPrompt: join(REPO, "plugin/bin/user-prompt.ts"),
  stop: join(REPO, "plugin/bin/stop.ts"),
  recall: join(REPO, "plugin/bin/recall.ts"),
};

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

async function runBin(
  bin: string,
  stdinJson: Record<string, unknown>,
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, bin, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  proc.stdin.write(JSON.stringify(stdinJson));
  proc.stdin.end();
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

const CODEX = ["--harness", "codex"];

const baseEnv = (stateDir: string, ws: string, url: string): Record<string, string> => ({
  HOME: stateDir,
  HONCHO_STATE_DIR: stateDir,
  HONCHO_URL: url,
  HONCHO_WORKSPACE: ws,
  HONCHO_PEER: "build",
});

/** all stored messages across every `<ws>/<session>` key */
const allMessages = (fake: FakeHoncho): Record<string, unknown>[] =>
  [...fake.state.messages.values()].flat();

describe("C2 harness seam: Codex fixtures through the bins", () => {
  test(
    "session-start with --harness codex injects a digest with hookEventName SessionStart",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c2-ss-");
      const ws = scratchName();
      try {
        const env = baseEnv(stateDir, ws, fake.url);
        // run 1 creates the Honcho session (empty state: silence is fine)
        await runBin(BIN.sessionStart, fixture("session_start.json"), env, CODEX);
        const seatFile = join(stateDir, ws, "seats", "build.json");
        expect(existsSync(seatFile)).toBe(true);
        const session = (JSON.parse(readFileSync(seatFile, "utf8")) as { session?: string }).session;
        expect(typeof session).toBe("string");
        // seed what the reader renders, then re-run with a different stdin
        fake.setSummary(ws, session as string, {
          short: "C2 digest probe line",
          created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        });
        fake.setPeerCard(ws, "build", ["Owns the memory bridge."]);
        await Bun.sleep(10);
        const r = await runBin(
          BIN.sessionStart,
          { ...fixture("session_start.json"), session_id: "c2-ss-2" },
          env,
          CODEX,
        );
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        const parsed = JSON.parse(r.out) as {
          hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
        };
        expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
        expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe("string");
        expect((parsed.hookSpecificOutput?.additionalContext ?? "").length).toBeGreaterThan(0);
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "session-start treats Codex source fork as resume: context_start untouched, log event resume",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c2-fork-");
      const ws = scratchName();
      try {
        const env = baseEnv(stateDir, ws, fake.url);
        const seatFile = join(stateDir, ws, "seats", "build.json");
        const contextStart = (): string | undefined =>
          existsSync(seatFile)
            ? (JSON.parse(readFileSync(seatFile, "utf8")) as { context_start?: string }).context_start
            : undefined;

        await runBin(BIN.sessionStart, { ...fixture("session_start.json"), session_id: "c2-f1" }, env, CODEX);
        const afterStartup = contextStart();
        expect(typeof afterStartup).toBe("string");

        await Bun.sleep(10);
        const r = await runBin(
          BIN.sessionStart,
          { ...fixture("session_start.json"), session_id: "c2-f1", source: "fork" },
          env,
          CODEX,
        );
        expect(r.code).toBe(0);
        // resume semantics: the old context mark survives
        expect(contextStart()).toBe(afterStartup);
        const log = readFileSync(join(stateDir, "log", `${ws}.log`), "utf8");
        expect(log.includes('"event":"resume"')).toBe(true);
        expect(log.includes("unknown-source")).toBe(false);
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "user-prompt with --harness codex records the fixture prompt under the config peer, silently",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c2-up-");
      const ws = scratchName();
      try {
        const env = baseEnv(stateDir, ws, fake.url);
        const fx = fixture("user_prompt_submit.json");
        const r = await runBin(BIN.userPrompt, fx, env, CODEX);
        expect(r.code).toBe(0);
        expect(r.out).toBe(""); // the writer NEVER touches stdout
        expect(r.err).toBe("");
        const msgs = allMessages(fake);
        expect(msgs.length).toBeGreaterThan(0);
        const prompt = String(fx.prompt);
        const recorded = msgs.find((m) => JSON.stringify(m).includes(prompt.slice(0, 48)));
        expect(recorded).toBeDefined();
        // a plain (non-relay) prompt attributes to the owner sender - exactly
        // the Claude contract (attribute.test pins it); the seat peer owns
        // the session the message lands in.
        expect(recorded?.peer_id).toBe("owner");
        expect([...fake.state.messages.keys()].some((k) => k.startsWith(`${ws}/`))).toBe(true);
        expect([...(fake.state.peers.get(ws) ?? [])]).toContain("build");
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );

  test(
    "recall with --harness codex returns its block with hookEventName UserPromptSubmit",
    async () => {
      // minimal inline fake: every conclusions query answers one distinct
      // item 2 h old (the shape and age the recall-bin fake proves renders)
      const requests: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const u = new URL(req.url);
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          requests.push(u.pathname);
          const filters = (body?.filters ?? {}) as Record<string, string>;
          const observer = filters.observer ?? "build";
          const observed = filters.observed ?? "build";
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
      const stateDir = makeTempDir("c2-rec-");
      const ws = scratchName();
      try {
        const env = { ...baseEnv(stateDir, ws, `http://127.0.0.1:${server.port}/v3`), HONCHO_RECALL_NOVELTY: "off" };
        // recall acts on peer-routed prompts (the OpenRig From-header shape,
        // identical on both harnesses); a plain prompt is the logged,
        // correct not-peer no-op pinned by recall-bin.test.ts
        // the daemon-stamped envelope recall-bin pins (envelope.ts splits on
        // the last "\n---\n↩")
        const fx = {
          ...fixture("user_prompt_submit.json"),
          prompt: [
            `From: dev-x@${ws}`,
            `To: build@${ws}`,
            "Sent: 11-08 21:00Z",
            "---",
            "What did we decide about the radio driver?",
            "---",
            `↩ Reply: rig send dev-x@${ws} "..."`,
          ].join("\n"),
        };
        const r = await runBin(BIN.recall, fx, env, CODEX);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        const parsed = JSON.parse(r.out) as {
          hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
        };
        expect(parsed.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
        expect((parsed.hookSpecificOutput?.additionalContext ?? "").length).toBeGreaterThan(0);
      } finally {
        server.stop(true);
      }
    },
    60_000,
  );

  test(
    "stop with --harness codex records last_assistant_message and never reads the transcript",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c2-stop-");
      const ws = scratchName();
      try {
        // a REAL transcript file at the fixture path: if the transcript were
        // consulted at all (its text or a parse failure), these assertions
        // could not hold
        const transcript = join(stateDir, "rollout.jsonl");
        writeFileSync(transcript, '{"type":"assistant","message":"ZZZ-TRANSCRIPT-MARKER"}\n');
        const env = baseEnv(stateDir, ws, fake.url);
        const fx = {
          ...fixture("stop.json"),
          transcript_path: transcript,
          last_assistant_message: "CODEX-REPLY-MARKER the reply Codex reports",
        };
        const r = await runBin(BIN.stop, fx, env, CODEX);
        expect(r.code).toBe(0);
        expect(r.out).toBe(""); // stop NEVER touches stdout
        expect(r.err).toBe("");
        const dump = JSON.stringify(allMessages(fake));
        expect(dump.includes("CODEX-REPLY-MARKER")).toBe(true);
        expect(dump.includes("ZZZ-TRANSCRIPT-MARKER")).toBe(false);
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );
});

// C2b: the two findings from the R1 review at b549019, pinned as repo tests.
// The F1 case is the port of the reviewer's B3
// (review-c2-attack.test.ts, kept outside the repo):
// it FAILS at b549019 and passes with the fix.
describe("C2b: Codex turn identity and the harness flag trace", () => {
  // the reviewer's real-shaped Codex rollout (never parsed by our code -
  // its presence is the point: Codex must not consult it)
  const codexRollout = (term: string): string =>
    [
      { timestamp: "2026-11-08T20:00:00.000Z", type: "session_meta", payload: { id: "01a1bd04", timestamp: "2026-11-08T20:00:00.000Z", cwd: "/home/test/work", originator: "codex_cli" } },
      { timestamp: "2026-11-08T20:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: "2026-11-08T20:00:02.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "system style rules" }] } },
      { timestamp: "2026-11-08T20:00:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `we ratified the ${term} spec` }] } },
      { timestamp: "2026-11-08T20:00:04.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: `thinking about ${term}` }] } },
      { timestamp: "2026-11-08T20:00:05.000Z", type: "response_item", payload: { type: "function_call", name: "exec", arguments: "{\"cmd\":\"ls\"}" } },
      { timestamp: "2026-11-08T20:00:06.000Z", type: "response_item", payload: { type: "function_call_output", output: `raw tool output mentioning ${term}` } },
      { timestamp: "2026-11-08T20:00:07.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `the ${term} spec is settled` }] } },
      { timestamp: "2026-11-08T20:00:08.000Z", type: "event_msg", payload: { type: "agent_message", message: `the ${term} spec is settled` } },
      { timestamp: "2026-11-08T20:00:09.000Z", type: "token_usage_record", payload: { total_tokens: 1234 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";

  test(
    "F1 (B3): ADR-0005 E3 for Codex - the same reply text on two different turns is recorded twice",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c2b-b3-");
      const ws = scratchName();
      try {
        const rollout = join(stateDir, "rollout.jsonl");
        writeFileSync(rollout, codexRollout("radio-driver-calibration-9182"));
        const env = baseEnv(stateDir, ws, fake.url);
        const text = "DONE: the patch is in, nothing else to do.";
        const stopRun = (turnId: string, reply: string) =>
          runBin(
            BIN.stop,
            {
              ...fixture("stop.json"),
              transcript_path: rollout,
              turn_id: turnId,
              session_id: "b3-s",
              last_assistant_message: reply,
            },
            env,
            CODEX,
          );
        const count = (needle: string) =>
          allMessages(fake).filter((m) => JSON.stringify(m).includes(needle)).length;

        await stopRun("turn-one", text);
        const after1 = count("DONE: the patch");
        expect(after1).toBe(1);
        await stopRun("turn-two", text); // same text, a different turn
        const after2 = count("DONE: the patch");
        // two turns, two records (the turn id is in the payload Codex sends)
        expect(after2).toBe(2);
        await stopRun("turn-three", "REPLIED-BUT-BUSY: waiting on the radio driver.");
        expect(count("REPLIED-BUT-BUSY")).toBe(1);
        // past the once-guard window, so only the E3 hash can still suppress
        await Bun.sleep(6_000);
        await stopRun("turn-four", text);
        expect(count("DONE: the patch")).toBe(3);
      } finally {
        await fake.stop();
      }
    },
    120_000,
  );

  const badSpellings: Array<[string, string[]]> = [
    ["missing value", ["--harness"]],
    ["equals form", ["--harness=codex"]],
    ["wrong case", ["--harness", "Codex"]],
    ["typo", ["--harness", "codexx"]],
    ["empty value", ["--harness", ""]],
  ];
  for (const [label, args] of badSpellings) {
    test(
      `F3+C2c: --harness ${label} writes ONE log line carrying harness_unknown: 1, exits 0, behaves as claude`,
      async () => {
        const fake = await startFakeHoncho();
        const stateDir = makeTempDir("c2b-f3-");
        const ws = scratchName();
        try {
          const env = baseEnv(stateDir, ws, fake.url);
          // source fork discriminates: claude -> unknown-source no-op
          const r = await runBin(
            BIN.sessionStart,
            { ...fixture("session_start.json"), source: "fork" },
            env,
            args,
          );
          expect(r.code).toBe(0);
          expect(r.out).toBe("");
          expect(r.err).toBe("");
          const log = readFileSync(join(stateDir, "log", `${ws}.log`), "utf8");
          const lines = log.trim() === "" ? [] : log.trim().split("\n");
          // C2c (review F4): O1 holds - the flag rides the run's own line.
          expect(lines.length).toBe(1);
          expect(lines[0].includes('"harness_unknown":1')).toBe(true);
          expect(log.includes('"event":"harness-unknown"')).toBe(false);
          expect(lines[0].includes('"event":"unknown-source"')).toBe(true); // claude behaviour
          expect(log.includes('"event":"resume"')).toBe(false);
        } finally {
          await fake.stop();
        }
      },
      60_000,
    );
  }

  test(
    "F3 control: correct --harness codex and no flag leave no harness_* trace",
    async () => {
      const fake = await startFakeHoncho();
      const stateDir = makeTempDir("c2b-f3c-");
      const ws = scratchName();
      try {
        const env = baseEnv(stateDir, ws, fake.url);
        for (const args of [CODEX, []]) {
          const r = await runBin(
            BIN.sessionStart,
            { ...fixture("session_start.json"), session_id: `ok-${args.length}`, source: "startup" },
            env,
            args,
          );
          expect(r.code).toBe(0);
          await Bun.sleep(10);
        }
        const log = readFileSync(join(stateDir, "log", `${ws}.log`), "utf8");
        expect(log.includes("harness-unknown")).toBe(false);
        expect(log.includes("harness_unknown")).toBe(false);
      } finally {
        await fake.stop();
      }
    },
    60_000,
  );
});

// C4 (ADR-0016, review F2): the novelty filter reads Codex rollouts. Ported
// from the reviewer's attack test C2 (report-c2-b549019.md F2): before the
// fix the Codex case filtered NOTHING (dropped_known 0, the already-known
// item injected again); after it the rollout behaves like a Claude
// transcript. Only user/assistant message text counts as known - never
// reasoning, tool calls or tool output. No real server: an inline
// conclusions fake answers the three recall queries.
describe("C4 novelty filter on Codex rollouts", () => {
  const TERM = "zephyr-gasket";

  // three DISTINCT items: the minimum block needs >= 2 shown, so dropping
  // the one known item still leaves a renderable block (reviewer's C2 rule).
  const startConclusions = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const filters = (body?.filters ?? {}) as Record<string, string>;
        const observer = filters.observer ?? "build";
        const observed = filters.observed ?? "build";
        const mk = (n: number, content: string) => ({
          id: `concl-${observer}-${observed}-${n}`,
          content,
          observer_id: observer,
          observed_id: observed,
          created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        });
        return Response.json([
          mk(1, `the ${TERM} is set and done`),
          mk(2, "the antenna mast is set and done, with the timeout still in force"),
          mk(3, "the test bench keeps its own timeout and its own driver log"),
        ]);
      },
    });

  // the daemon-stamped envelope the recall bin routes on (recall-bin style);
  // the rig in the header must be the run's own workspace or recall logs not-rig
  const envelope = (ws: string): string =>
    [
      `From: dev-x@${ws}`,
      `To: build@${ws}`,
      "Sent: 11-08 21:00Z",
      "---",
      "What did we decide about the radio driver?",
      "---",
      `↩ Reply: rig send dev-x@${ws} "..."`,
    ].join("\n");

  const lastCount = (log: string, field: string): number => {
    const m = [...log.matchAll(new RegExp(`"${field}":(\\d+)`, "g"))];
    return m.length === 0 ? 0 : Number(m[m.length - 1][1]);
  };

  const rolloutRecall = async (
    server: ReturnType<typeof Bun.serve>,
    rolloutText: string,
    opts: { args: string[]; session: string },
  ): Promise<{ code: number; out: string; err: string; log: string; stateDir: string; ws: string }> => {
    const stateDir = makeTempDir("c4-");
    const ws = scratchName();
    const file = join(stateDir, "rollout.jsonl");
    writeFileSync(file, rolloutText);
    const env = baseEnv(stateDir, ws, `http://127.0.0.1:${server.port}/v3`);
    const r = await runBin(
      BIN.recall,
      {
        session_id: opts.session,
        transcript_path: file,
        cwd: stateDir,
        hook_event_name: "UserPromptSubmit",
        prompt: envelope(ws),
      },
      env,
      opts.args,
    );
    return { ...r, log: readFileSync(join(stateDir, "log", `${ws}.log`), "utf8"), stateDir, ws };
  };

  test(
    "C4: a Codex rollout holding an item's only distinctive term drops it (reviewer C2, flipped)",
    async () => {
      const server = startConclusions();
      try {
        const rollout = readFileSync(join(FIXTURES, "rollout_novelty.jsonl"), "utf8");
        const r = await rolloutRecall(server, rollout, { args: CODEX, session: "c4-drop" });
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(r.out.includes(TERM)).toBe(false); // the known item dropped
        expect(r.out.includes("antenna mast")).toBe(true); // the block still renders
        expect(lastCount(r.log, "dropped_known")).toBeGreaterThanOrEqual(1);
        expect(lastCount(r.log, "rollout_seen")).toBe(1); // the codex path ran
        expect(r.log.includes("rollout_unreadable")).toBe(false);
        expect(r.log.includes("rollout_bad_lines")).toBe(false); // fixture parses clean
      } finally {
        server.stop(true);
      }
    },
    120_000,
  );

  test(
    "C4: terms in Codex reasoning or tool output only do NOT drop the item",
    async () => {
      const server = startConclusions();
      try {
        const rollout = [
          { timestamp: "2026-11-08T20:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
          { timestamp: "2026-11-08T20:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "how is the new part doing" }] } },
          { timestamp: "2026-11-08T20:00:03.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: `thinking about ${TERM}` }] } },
          { timestamp: "2026-11-08T20:00:04.000Z", type: "response_item", payload: { type: "function_call_output", output: `raw tool output mentioning ${TERM}` } },
          { timestamp: "2026-11-08T20:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the new part is fine" }] } },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n";
        const r = await rolloutRecall(server, rollout, { args: CODEX, session: "c4-toolout" });
        expect(r.code).toBe(0);
        expect(r.out.includes(TERM)).toBe(true); // nothing known from reasoning/tool output
        expect(lastCount(r.log, "dropped_known")).toBe(0);
        expect(lastCount(r.log, "rollout_seen")).toBe(1);
        expect(r.log.includes("rollout_bad_lines")).toBe(false);
      } finally {
        server.stop(true);
      }
    },
    120_000,
  );

  test(
    "C4: an unparseable rollout degrades to no terms, logged once as counts, exit 0",
    async () => {
      const server = startConclusions();
      try {
        const r = await rolloutRecall(server, "NOT JSON AT ALL\nEVEN LESS JSON {{{\n", { args: CODEX, session: "c4-garbage" });
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(r.out.includes(TERM)).toBe(true); // no terms -> nothing dropped
        expect(lastCount(r.log, "rollout_seen")).toBe(1);
        expect(lastCount(r.log, "rollout_bad_lines")).toBeGreaterThanOrEqual(1);
      } finally {
        server.stop(true);
      }
    },
    120_000,
  );

  test(
    "C4 control: the Claude transcript path drops the known item and logs no rollout_* field",
    async () => {
      const server = startConclusions();
      try {
        const transcript = [
          { type: "user", uuid: "u-c4", timestamp: "2026-11-08T20:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `we ratified the ${TERM} spec` }] } },
          { type: "assistant", uuid: "a-c4", timestamp: "2026-11-08T20:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "agreed" }] } },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n";
        const r = await rolloutRecall(server, transcript, { args: [], session: "c4-claude" });
        expect(r.code).toBe(0);
        expect(r.out.includes(TERM)).toBe(false);
        expect(r.out.includes("antenna mast")).toBe(true);
        expect(lastCount(r.log, "dropped_known")).toBeGreaterThanOrEqual(1);
        expect(r.log.includes("rollout_")).toBe(false); // Claude lines byte-identical
      } finally {
        server.stop(true);
      }
    },
    120_000,
  );

  test(
    "C4 add-on (architect 00:51Z): a Codex recall with NO transcript_path logs no rollout_seen",
    async () => {
      const server = startConclusions();
      const stateDir = makeTempDir("c4-notp-");
      const ws = scratchName();
      try {
        // same Codex novelty run as rolloutRecall, minus transcript_path:
        // no path means no rollout was seen - the field must not appear,
        // while the novelty pipeline itself still runs (block renders)
        const r = await runBin(
          BIN.recall,
          {
            session_id: "c4-no-transcript",
            cwd: stateDir,
            hook_event_name: "UserPromptSubmit",
            prompt: envelope(ws),
          },
          baseEnv(stateDir, ws, `http://127.0.0.1:${server.port}/v3`),
          ["--harness", "codex"],
        );
        expect(r.code).toBe(0);
        expect(r.out.includes("antenna mast")).toBe(true);
        const log = readFileSync(join(stateDir, "log", `${ws}.log`), "utf8");
        expect(log.includes("rollout_seen")).toBe(false);
        expect(log.includes("rollout_unreadable")).toBe(false);
        expect(log.includes("rollout_bad_lines")).toBe(false);
      } finally {
        server.stop(true);
      }
    },
    120_000,
  );
});

// C2c (ADR-0016, review F4): ONE log line per hook run (O1). The unresolved
// --harness flag rides the run's own event as the whitelisted field
// harness_unknown: 1 (no separate event), and a Codex Stop run with no
// usable turn_id carries no_turn_id: 1 so the text-only E3 fallback is
// visible. Ported from the reviewer's D5 (report-c2b-aef1840.md,
// ohr-c2b/tests/unit/review-c2b-attack.test.ts) and the flipped C2 pin
// (ohr-c2 line 193: a bad spelling must now leave a trace, not none).
describe("C2c one log line per run, flag fields on the event", () => {
  const spellings: Array<[string, string[], boolean]> = [
    ["no flag", [], false],
    ["--harness codex", CODEX, false],
    ["--harness claude", ["--harness", "claude"], false],
    ["--harness at end", ["--harness"], true],
    ["--harness=codex", ["--harness=codex"], true],
    ["--harness Codex", ["--harness", "Codex"], true],
    ["--harness empty", ["--harness", ""], true],
    ["--harness codexx", ["--harness", "codexx"], true],
  ];

  const logLines = (stateDir: string, ws: string): string[] => {
    const log = readFileSync(join(stateDir, "log", `${ws}.log`), "utf8");
    return log.trim() === "" ? [] : log.trim().split("\n");
  };

  test(
    "D5 (ported): one line per run on all four bins x every spelling; harness_unknown only on bad ones; exit 0, clean stderr",
    async () => {
      const fake = await startFakeHoncho();
      try {
        for (const [binName, bin] of Object.entries(BIN)) {
          for (const [label, argv, expectUnknown] of spellings) {
            const stateDir = makeTempDir("c2c-d5-");
            const ws = scratchName();
            const env = baseEnv(stateDir, ws, fake.url);
            const stdin =
              binName === "sessionStart"
                ? { session_id: "d5-ss", cwd: stateDir, source: "startup" }
                : binName === "stop"
                  ? { session_id: "d5-st", last_assistant_message: "D5 REPLY TEXT" }
                  : { session_id: "d5-up", cwd: stateDir, prompt: "please check the radio driver build" };
            const r = await runBin(bin, stdin, env, argv);
            const lines = logLines(stateDir, ws);
            const where = `${binName}/${label}`;
            expect(r.code, where).toBe(0);
            expect(r.err, where).toBe("");
            expect(lines.length, `O1 violated on ${where}: ${String(lines.length)} lines`).toBe(1);
            expect(lines[0].includes('"harness-unknown"'), where).toBe(false); // no separate event
            expect(lines[0].includes('"harness_unknown":1'), where).toBe(expectUnknown);
          }
        }
      } finally {
        await fake.stop();
      }
    },
    300_000,
  );

  test(
    "flipped C2 pin (ported): a bad --harness spelling leaves a trace in the log (it was silent at b549019)",
    async () => {
      const fake = await startFakeHoncho();
      try {
        for (const [label, argv, expectUnknown] of spellings) {
          if (!expectUnknown) continue;
          const stateDir = makeTempDir("c2c-pin-");
          const ws = scratchName();
          const env = baseEnv(stateDir, ws, fake.url);
          const r = await runBin(
            BIN.sessionStart,
            { ...fixture("session_start.json"), source: "startup" },
            env,
            argv,
          );
          expect(r.code).toBe(0);
          expect(logLines(stateDir, ws)[0].includes('"harness_unknown":1')).toBe(true);
        }
      } finally {
        await fake.stop();
      }
    },
    120_000,
  );

  test(
    "C2c: Codex Stop without a usable turn_id carries no_turn_id: 1; a usable one or Claude carries none",
    async () => {
      const fake = await startFakeHoncho();
      try {
        const runs: Array<[string, string[], Record<string, unknown>, boolean]> = [
          ["codex missing turn_id", CODEX, {}, true],
          ["codex empty turn_id", CODEX, { turn_id: "" }, true],
          ["codex with turn_id", CODEX, { turn_id: "t-c2c" }, false],
          ["claude without turn_id", [], {}, false],
        ];
        for (const [label, args, extra, expectNoTurn] of runs) {
          const stateDir = makeTempDir("c2c-nti-");
          const ws = scratchName();
          const env = baseEnv(stateDir, ws, fake.url);
          const r = await runBin(
            BIN.stop,
            {
              session_id: "c2c-nti",
              last_assistant_message: `C2C NTI REPLY ${label}`,
              transcript_path: join(stateDir, "absent-rollout.jsonl"), // missing: like Codex
              ...extra,
            },
            env,
            args,
          );
          expect(r.code, label).toBe(0);
          const lines = logLines(stateDir, ws);
          expect(lines.length, label).toBe(1);
          expect(lines[0].includes('"no_turn_id":1'), label).toBe(expectNoTurn);
        }
      } finally {
        await fake.stop();
      }
    },
    120_000,
  );
});
