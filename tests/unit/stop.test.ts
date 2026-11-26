// T6b: the Stop reply writer against the FAKE server only, with tmp transcript
// JSONL files. Covers the qitem's reply scenarios: segment extraction (text
// blocks only, tool calls/results never, both blocks in one message, peer =
// self), E3 dedupe (same Stop once, different reply next turn, survives a
// prompt in between), stop_hook_active, the last_assistant_message fallback,
// the X2 workspace set across all three writers, and bin/stop.ts as a child
// process (kill switch and garbage stdin: exit 0, zero bytes out).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readSeatState, seatStatePath } from "../../plugin/src/missions.ts";
import { recordReply, scanUsedIds, scanUsedSplit, transcriptModel, turnAssistantText } from "../../plugin/src/stop.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";

const mk = async (over: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("stop-test-");
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: SELF,
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: true,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over };
  return { fake, dir, config, deps: { client, now: () => new Date().toISOString() } };
};

const u = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const uU = (text: string, uuid: string): string =>
  JSON.stringify({ uuid, type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const a = (text: string): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const A_TOOL = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } });
const U_TOOL_RESULT = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: "total 0" }] } });
const U_WAKEUP = JSON.stringify({
  type: "user",
  promptSource: "system",
  message: { role: "user", content: "task notification" } });

const transcript = (dir: string, name: string, lines: string[]): string => {
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, `${lines.join("\n")}\n`, { mode: 0o600 });
  return p;
};

const stored = (fake: FakeHoncho, session: string) => fake.state.messages.get(`${WS}/${session}`) ?? [];
const profMsgs = (fake: FakeHoncho) =>
  [...fake.state.messages.entries()].filter(([k]) => k.startsWith("prof/"));
const dm = (from: string, body: string) =>
  `From: ${from}@${WS}\nTo: ${SELF}@${WS}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;

describe("turnAssistantText (segment rule)", () => {
  test("text blocks after the last real prompt only; tool_use/tool_result stay mid-turn; wakeup is a boundary", () => {
    const dir = makeTempDir("stop-seg-");
    const tp = transcript(dir, "t", [
      u("older prompt"),
      a("older answer"),
      u("current prompt"),
      a("first part"),
      A_TOOL,
      U_TOOL_RESULT,
      a("second part"),
    ]);
    expect(turnAssistantText(tp, undefined)).toBe("first part\n\nsecond part");
    // a wakeup ends the segment: only text after it counts
    const tp2 = transcript(dir, "t2", [u("p"), a("before wakeup"), U_WAKEUP, a("after wakeup")]);
    expect(turnAssistantText(tp2, undefined)).toBe("after wakeup");
    // no prompt at all: only the payload fallback
    const tp3 = transcript(dir, "t3", [a("orphan")]);
    expect(turnAssistantText(tp3, undefined)).toBe("");
    expect(turnAssistantText(tp3, "payload copy")).toBe("payload copy");
    // payload fills in when it is not the last block yet
    expect(turnAssistantText(tp, "flushed late")).toBe("first part\n\nsecond part\n\nflushed late");
    expect(turnAssistantText(undefined, "only payload")).toBe("only payload");
    // corrupt lines are skipped, not fatal
    const tp4 = transcript(dir, "t4", [u("p"), "{ not json", a("kept")]);
    expect(turnAssistantText(tp4, undefined)).toBe("kept");
  });
});

// ADR-0022 decision 1 (Claude's Stop fallback): the newest assistant entry's
// message.model, validated; only the id is read, never entry text.
describe("transcriptModel (ADR-0022 d1)", () => {
  const aM = (text: string, model: unknown): string =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text }] } });
  test("newest assistant entry's message.model wins; no model key or no assistant entry means undefined", () => {
    const dir = makeTempDir("stop-txm-");
    const tp = transcript(dir, "m", [u("p"), aM("old answer", "old-model"), u("p2"), aM("new answer", "new-model-2.0")]);
    expect(transcriptModel(tp)).toBe("new-model-2.0");
    expect(transcriptModel(transcript(dir, "m2", [u("p"), a("no model on this one")]))).toBeUndefined();
    expect(transcriptModel(transcript(dir, "m3", [u("p")]))).toBeUndefined();
  });
  test("a rejected value on the NEWEST assistant entry is absent - never the older entry's id", () => {
    const dir = makeTempDir("stop-txm-");
    expect(transcriptModel(transcript(dir, "r1", [aM("old", "good-id"), aM("new", "bad model!")]))).toBeUndefined();
    expect(transcriptModel(transcript(dir, "r2", [aM("old", "good-id"), aM("new", "x".repeat(101))]))).toBeUndefined();
  });
  test("missing or unreadable file: undefined, no throw", () => {
    expect(transcriptModel(undefined)).toBeUndefined();
    expect(transcriptModel("")).toBeUndefined();
    expect(transcriptModel("/nonexistent/none.jsonl")).toBeUndefined();
  });
});

// ADR-0022 decision 3 (B10): which shown ids appear in the turn the Stop is
// already reading - text blocks + tool_use inputs + the harness message.
// Plain substring match; only shown ids can come back; nothing else leaves.
describe("scanUsedIds (ADR-0022 d3)", () => {
  const QID = "qitem-20261126033123-b1d597bc0111f573";
  test("a shown id cited in the turn's assistant text is used; an id not shown is never", () => {
    const dir = makeTempDir("stop-scan-");
    const tp = transcript(dir, "s1", [u("close the row"), a(`I applied the decision d-0a0b0c0d as written.`)]);
    expect(scanUsedIds(["decision:d-0a0b0c0d", "decision:d-11111111"], tp, undefined)).toEqual(["decision:d-0a0b0c0d"]);
    // cited in the message, but never shown -> cannot be `used`
    expect(scanUsedIds(["decision:d-99999999"], tp, "cites d-0a0b0c0d")).toEqual([]);
  });
  test("an id inside a tool_use input counts: a rig_memory arg and a queue command", () => {
    const dir = makeTempDir("stop-scan-");
    const tp = transcript(dir, "s2", [
      u("work"),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__rig_memory__retire", input: { id: "d-0a0b0c0d" } }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: `rig queue close ${QID} --reason done` } }] },
      }),
    ]);
    expect(scanUsedIds([`lesson:${QID}`, "decision:d-0a0b0c0d"], tp, undefined)).toEqual([
      "decision:d-0a0b0c0d",
      `lesson:${QID}`,
    ]);
  });
  test("no readable transcript: the harness message alone decides; empty shown = []", () => {
    expect(scanUsedIds([`pointer:${QID}`], "/nonexistent/none.jsonl", `closed ${QID} per the decision`)).toEqual([`pointer:${QID}`]);
    expect(scanUsedIds([], undefined, "anything")).toEqual([]);
  });
  test("only the current turn is scanned: pre-boundary mentions do not count", () => {
    const dir = makeTempDir("stop-scan-");
    const tp = transcript(dir, "s3", [
      u("older turn"),
      a("that turn cited d-0a0b0c0d"),
      u("new turn"),
      a("this one cites nothing"),
    ]);
    expect(scanUsedIds(["decision:d-0a0b0c0d"], tp, undefined)).toEqual([]);
  });
  // R27 F-V1: token-boundary match; short or all-letter conclusion ids are
  // never scanned (they collide with ordinary words).
  test("F-V1: d-ffff0001 is not found inside d-ffff00011 (token boundary)", () => {
    expect(scanUsedIds(["decision:d-ffff0001"], undefined, "look at d-ffff00011 instead")).toEqual([]);
    // the boundary-positive control: the same id alone in the text counts
    expect(scanUsedIds(["decision:d-ffff0001"], undefined, "used decision d-ffff0001 today")).toEqual([
      "decision:d-ffff0001",
    ]);
  });
  test("F-V1: conclusion:done is not found in \"The task is done.\"", () => {
    expect(scanUsedIds(["conclusion:done"], undefined, "The task is done.")).toEqual([]);
  });
  test("F-V1: conclusion:LEARNED is not found in \"LEARNED.md\"", () => {
    expect(scanUsedIds(["conclusion:LEARNED"], undefined, "I updated LEARNED.md.")).toEqual([]);
  });
  test("F-V1: a scannable conclusion (>=8 chars, has a digit) matches at boundaries", () => {
    expect(scanUsedIds(["conclusion:done-2026"], undefined, "note done-2026x, see done-2026 here")).toEqual([
      "conclusion:done-2026",
    ]);
  });
});

// R27 F-V2 (ADR-0022 d3 amendment): cited = assistant text / last message
// (an echo lives here); acted = a tool_use input (the v0.6 evidence count).
describe("scanUsedSplit (ADR-0022 d3 amendment)", () => {
  test("an echoed digest line is cited, not acted", () => {
    const dir = makeTempDir("stop-split-");
    const tp = transcript(dir, "e1", [
      u("work"),
      a("memory showed me: d-ffff0001 make a decision, so I restated the digest line d-ffff0001 verbatim."),
    ]);
    const { cited, acted } = scanUsedSplit(["decision:d-ffff0001"], tp, undefined);
    expect(cited).toEqual(["decision:d-ffff0001"]);
    expect(acted).toEqual([]);
  });
  test("a rig_memory supersedes argument is acted, not cited", () => {
    const dir = makeTempDir("stop-split-");
    const tp = transcript(dir, "e2", [
      u("work"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "mcp__rig_memory__supersede", input: { id: "d-ffff0001", reason: "done-2026 supersedes" } }],
        },
      }),
    ]);
    const { cited, acted } = scanUsedSplit(["decision:d-ffff0001", "conclusion:done-2026"], tp, undefined);
    // id only inside the tool input -> acted only; done-2026 is in the same
    // input JSON -> acted too (tool inputs are the acted haystack).
    expect(acted).toEqual(["conclusion:done-2026", "decision:d-ffff0001"]);
    expect(cited).toEqual([]);
  });
  test("user text never counts for either list", () => {
    const dir = makeTempDir("stop-split-");
    const tp = transcript(dir, "e3", [u("apply d-ffff0001 now"), a("acknowledged")]);
    const { cited, acted } = scanUsedSplit(["decision:d-ffff0001"], tp, undefined);
    expect(cited).toEqual([]);
    expect(acted).toEqual([]);
  });
  test("an id in text AND in a tool input lands in acted only; used union is unchanged", () => {
    const dir = makeTempDir("stop-split-");
    const tp = transcript(dir, "e4", [
      u("work"),
      a("I will use decision d-ffff0001 now"),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "apply d-ffff0001 per its terms" } }] },
      }),
    ]);
    const { cited, acted } = scanUsedSplit(["decision:d-ffff0001"], tp, undefined);
    expect(acted).toEqual(["decision:d-ffff0001"]); // acted wins over cited
    expect(cited).toEqual([]);
    expect(scanUsedIds(["decision:d-ffff0001"], tp, undefined)).toEqual(["decision:d-ffff0001"]); // union unchanged
  });
  test("text-only and input-only ids split cleanly; the compat union is sorted", () => {
    const dir = makeTempDir("stop-split-");
    const tp = transcript(dir, "e5", [
      u("work"),
      a("cited conclusion done-2026"),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "rig queue close qitem-20261126033123-b1d597bc0111f573" } }] },
      }),
    ]);
    const { cited, acted } = scanUsedSplit(
      ["conclusion:done-2026", "pointer:qitem-20261126033123-b1d597bc0111f573"],
      tp,
      "closed qitem-20261126033123-b1d597bc0111f573",
    );
    expect(cited).toEqual(["conclusion:done-2026"]);
    expect(acted).toEqual(["pointer:qitem-20261126033123-b1d597bc0111f573"]);
  });
});

describe("recordReply (T6b)", () => {
  test("prompt, text, tool_use, tool_result, text -> one reply message with both texts, no tool content, peer self, kind reply", async () => {
    const { fake, dir, config, deps } = await mk({ profileWorkspace: "prof" });
    try {
      const tp = transcript(dir, "turn", [u("do the thing"), a("first part"), A_TOOL, U_TOOL_RESULT, a("second part")]);
      const out = await recordReply({ transcript_path: tp, session_id: "c1" }, config, deps);
      expect(out).toEqual({ action: "sent", session: "build--general--1", peer: SELF, n_msgs: 1 });
      const msgs = stored(fake, "build--general--1");
      expect(msgs.length).toBe(1);
      expect(msgs[0].content).toBe("first part\n\nsecond part");
      expect(msgs[0].peer_id).toBe(SELF);
      expect((msgs[0].metadata as Record<string, unknown>).kind).toBe("reply");
      expect(msgs[0].content).not.toContain("Bash");
      expect(msgs[0].content).not.toContain("tool_result");
      // replies never touch the profile workspace
      expect(fake.requests.some((r) => r.path.includes("/workspaces/prof/"))).toBe(false);
      expect(profMsgs(fake).length).toBe(0);
    } finally {
      await fake.stop();
    }
  });

  test("same Stop twice -> recorded once; a different reply next turn -> recorded", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "turn", [u("q1"), a("answer one")]);
      const first = await recordReply({ transcript_path: tp }, config, deps);
      expect(first.action).toBe("sent");
      const again = await recordReply({ transcript_path: tp }, config, deps);
      expect(again).toEqual({ action: "skipped", reason: "duplicate" });
      expect(stored(fake, "build--general--1").length).toBe(1);
      expect(readSeatState(seatStatePath(config.stateDir, WS, SELF))?.last_reply_hash).toBeString();

      const tp2 = transcript(dir, "turn2", [u("q2"), a("answer two, genuinely different")]);
      const next = await recordReply({ transcript_path: tp2 }, config, deps);
      expect(next.action).toBe("sent");
      const msgs = stored(fake, "build--general--1");
      expect(msgs.length).toBe(2);
      expect(msgs[1].content).toBe("answer two, genuinely different");
    } finally {
      await fake.stop();
    }
  });

  test("dedupe survives a prompt rewriting seat state in between", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "turn", [u("q"), a("a steady answer")]);
      expect((await recordReply({ transcript_path: tp }, config, deps)).action).toBe("sent");
      expect((await recordPrompt({ prompt: dm("dev-build", "a peer message lands") }, config, deps)).action).toBe("sent");
      expect(await recordReply({ transcript_path: tp }, config, deps)).toEqual({ action: "skipped", reason: "duplicate" });
      expect(stored(fake, "build--general--1").map((m) => m.content)).toEqual([
        "a steady answer",
        "a peer message lands",
      ]);
    } finally {
      await fake.stop();
    }
  });

  // T6b-fix (ADR-0005 E3 per-turn amendment): the dedupe key is
  // (turn id + text), turn id = uuid of the boundary entry that opened the
  // turn; no readable transcript -> the text alone.
  test("T6b-fix: the same turn (uuid'd boundary) firing twice -> recorded once", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "turn", [uU("deploy please", "0f0f0f0f-0000-4000-8000-000000000001"), a("Deploy complete.")]);
      expect((await recordReply({ transcript_path: tp }, config, deps)).action).toBe("sent");
      expect(await recordReply({ transcript_path: tp }, config, deps)).toEqual({ action: "skipped", reason: "duplicate" });
      expect(stored(fake, "build--general--1").length).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  test("T6b-fix: identical text on two DIFFERENT turns (different uuids) -> two messages", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp1 = transcript(dir, "t1", [uU("task one", "0f0f0f0f-0000-4000-8000-0000000000a1"), a("Deploy complete.")]);
      expect((await recordReply({ transcript_path: tp1 }, config, deps)).action).toBe("sent");
      // a genuinely later turn repeated the same text for a different reason
      const tp2 = transcript(dir, "t2", [uU("task two", "0f0f0f0f-0000-4000-8000-0000000000b2"), a("Deploy complete.")]);
      expect((await recordReply({ transcript_path: tp2 }, config, deps)).action).toBe("sent");
      const msgs = stored(fake, "build--general--1");
      expect(msgs.length).toBe(2);
      expect(msgs[1].content).toBe("Deploy complete.");
    } finally {
      await fake.stop();
    }
  });

  test("T6b-fix: no readable transcript -> text-only dedupe, and it does not blind a later real turn", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      // payload-only, twice: same text -> the second is skipped
      expect((await recordReply({ last_assistant_message: "Status: nominal" }, config, deps)).action).toBe("sent");
      expect(await recordReply({ last_assistant_message: "Status: nominal" }, config, deps)).toEqual({ action: "skipped", reason: "duplicate" });
      // a real turn now says the same words: it has a turn id, so the hash
      // differs from the text-only one and the reply is recorded
      const tp = transcript(dir, "t", [uU("check status", "0f0f0f0f-0000-4000-8000-0000000000c3"), a("Status: nominal")]);
      expect((await recordReply({ transcript_path: tp }, config, deps)).action).toBe("sent");
      expect(stored(fake, "build--general--1").length).toBe(2);
      // an OLD-style transcript whose boundary has no uuid falls back to the
      // text alone: same text twice -> skipped
      const told = transcript(dir, "told", [u("legacy prompt"), a("Status: nominal")]);
      expect((await recordReply({ transcript_path: told }, config, deps)).action).toBe("sent"); // uuid turn's hash differs
      expect(await recordReply({ transcript_path: told }, config, deps)).toEqual({ action: "skipped", reason: "duplicate" });
    } finally {
      await fake.stop();
    }
  });

  test("stop_hook_active: nothing at all, zero requests", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "turn", [u("q"), a("a")]);
      const out = await recordReply({ transcript_path: tp, stop_hook_active: true }, config, deps);
      expect(out).toEqual({ action: "skipped" });
      expect(fake.requests.length).toBe(0);
    } finally {
      await fake.stop();
    }
  });

  test("no text anywhere: skipped, zero requests; missing transcript falls back to the payload", async () => {
    const empty = await mk();
    try {
      expect(await recordReply({}, empty.config, empty.deps)).toEqual({ action: "skipped" });
      expect(empty.fake.requests.length).toBe(0);
    } finally {
      await empty.fake.stop();
    }
    const fb = await mk();
    try {
      const out = await recordReply({ last_assistant_message: "payload-only reply" }, fb.config, fb.deps);
      expect(out.action).toBe("sent");
      expect(stored(fb.fake, "build--general--1")[0].content).toBe("payload-only reply");
    } finally {
      await fb.fake.stop();
    }
  });

  test("X2: across prompt-owner, prompt-peer and reply the workspaces written are exactly {ws, prof}", async () => {
    const { fake, dir, config, deps } = await mk({ profileWorkspace: "prof" });
    try {
      await recordPrompt({ prompt: "owner words for both places" }, config, deps);
      await recordPrompt({ prompt: dm("dev-build", "peer words for one place") }, config, deps);
      const tp = transcript(dir, "turn", [u("q"), a("reply words for one place")]);
      await recordReply({ transcript_path: tp }, config, deps);
      const seen = new Set<string>();
      for (const r of fake.requests) {
        const m = /^\/v3\/workspaces\/([^/]+)\//.exec(r.path);
        if (m) seen.add(m[1]);
      }
      expect([...seen].sort()).toEqual(["prof", WS]);
      expect(profMsgs(fake).length).toBe(1); // only the owner write
    } finally {
      await fake.stop();
    }
  });

  test("outage: the reply spools with its ensure and replays on the next write, kind reply kept", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "turn", [u("q"), a("spooled reply body")]);
      fake.mode("refuse");
      const out = await recordReply({ transcript_path: tp }, config, deps);
      expect(out.action).toBe("spooled");
      fake.mode("ok");
      const next = await recordReply({
        last_assistant_message: "later reply drains the spool first" }, config, deps);
      expect(next.action).toBe("sent");
      // one session for the whole outage (fallback n from the first failed
      // list), the seat state carries it, so both writes share one key
      const keys = [...fake.state.messages.keys()];
      expect(keys.length).toBe(1);
      const msgs = stored(fake, keys[0].slice(WS.length + 1));
      expect(msgs.map((m) => m.content)).toEqual([
        "spooled reply body",
        "later reply drains the spool first",
      ]);
      expect(msgs.map((m) => (m.metadata as Record<string, unknown>).kind)).toEqual(["reply", "reply"]);
    } finally {
      await fake.stop();
    }
  });
});

describe("bin/stop.ts as a child process", () => {
  const REPO = join(import.meta.dir, "..", "..");
  const BIN = join(REPO, "plugin/bin/stop.ts");

  const run = async (env: Record<string, string>, stdin: string, args: readonly string[] = []) => {
    const p = Bun.spawn([process.execPath, BIN, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(stdin);
    p.stdin.end();
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, out, err };
  };

  test("HONCHO_ENABLED=false: exit 0, zero bytes out", async () => {
    const dir = makeTempDir("stop-bin-");
    const r = await run(
      {
        HOME: dir,
        HONCHO_STATE_DIR: dir,
        HONCHO_ENABLED: "false",
        HONCHO_URL: "http://127.0.0.1:9/v3",
        HONCHO_WORKSPACE: WS,
        HONCHO_PEER: SELF },
      JSON.stringify({ transcript_path: "/nope.jsonl", last_assistant_message: "x", stop_hook_active: false }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });

  test("garbage stdin: exit 0, zero bytes out", async () => {
    const dir = makeTempDir("stop-bin-");
    const r = await run({ HOME: dir, HONCHO_STATE_DIR: dir }, "not json {{{ \u0000");
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });

  // ADR-0022 decision 1, end to end: a live config and an unreachable server
  // (port 9 refuses) still write the run's ONE O1 line - that line carries
  // model exactly when the run can know it.
  const aM = (text: string, model: unknown): string =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text }] } });
  const liveEnv = (dir: string): Record<string, string> => ({
    HOME: dir,
    HONCHO_STATE_DIR: dir,
    HONCHO_URL: "http://127.0.0.1:9/v3",
    HONCHO_WORKSPACE: WS,
    HONCHO_PEER: SELF,
  });
  const oneLine = (dir: string): Record<string, unknown> => {
    const raw = readFileSync(join(dir, "log", `${WS}.log`), "utf8").trim().split("\n");
    expect(raw).toHaveLength(1); // O1: exactly one line per run
    return JSON.parse(raw[0]!) as Record<string, unknown>;
  };

  test("ADR-0022: Claude Stop logs the transcript model on its line", async () => {
    const dir = makeTempDir("stop-bin-");
    const tp = transcript(dir, "tx", [uU("prompt", "u1"), aM("the answer", "fixture-model.1")]);
    const r = await run(liveEnv(dir), JSON.stringify({ transcript_path: tp, session_id: "s1", stop_hook_active: false }));
    expect(r.code).toBe(0);
    const line = oneLine(dir);
    expect([line.hook, line.model]).toEqual(["stop", "fixture-model.1"]);
  });
  test("ADR-0022: a rejected transcript model writes no model field", async () => {
    const dir = makeTempDir("stop-bin-");
    const tp = transcript(dir, "tx", [uU("prompt", "u1"), aM("the answer", "bad model!")]);
    const r = await run(liveEnv(dir), JSON.stringify({ transcript_path: tp, session_id: "s1", stop_hook_active: false }));
    expect(r.code).toBe(0);
    expect("model" in oneLine(dir)).toBe(false);
  });
  test("ADR-0022: Codex Stop takes model from the input; its transcript never speaks", async () => {
    const dir = makeTempDir("stop-bin-");
    const tp = transcript(dir, "tx", [aM("x", "transcript-model")]);
    const r = await run(
      liveEnv(dir),
      JSON.stringify({ last_assistant_message: "ok", model: "gpt-fixture-9", transcript_path: tp, session_id: "s", turn_id: "t1" }),
      ["--harness", "codex"],
    );
    expect(r.code).toBe(0);
    expect(oneLine(dir).model).toBe("gpt-fixture-9");
  });

  // B10 (ADR-0022 d3), end to end through the real bin: the session's shown
  // file + this turn decide `used`; ids only, never a byte of turn text.
  test("B10: a cited shown id rides used on the run's one line; no turn text lands in the log", async () => {
    const dir = makeTempDir("stop-bin-");
    const QID = "qitem-20261126033123-b1d597bc0111f573";
    mkdirSync(join(dir, WS, "shown"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, WS, "shown", `${createHash("sha256").update("s1", "utf8").digest("hex")}.json`),
      JSON.stringify({ at: new Date().toISOString(), ids: ["decision:d-0a0b0c0d", `lesson:${QID}`, "decision:d-99999999"] }),
      { mode: 0o600 },
    );
    const tp = transcript(dir, "tx", [
      uU("prompt", "u1"),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "fixture-model.1",
          content: [
            { type: "text", text: "Applied decision:d-0a0b0c0d, prose nobody logs verbatim." },
            { type: "tool_use", name: "Bash", input: { command: `rig queue close ${QID} --reason done` } },
          ],
        },
      }),
    ]);
    const r = await run(liveEnv(dir), JSON.stringify({ transcript_path: tp, session_id: "s1", stop_hook_active: false }));
    expect(r.code).toBe(0);
    const line = oneLine(dir);
    expect(line.model).toBe("fixture-model.1");
    expect(line.used).toEqual(["decision:d-0a0b0c0d", `lesson:${QID}`]);
    expect("shown" in line).toBe(false); // Stop logs used, never shown
    const raw = readFileSync(join(dir, "log", `${WS}.log`), "utf8");
    expect(raw).not.toContain("prose nobody logs"); // redaction: ids only
  });
});

// V1 (ADR-0019 decision 1): the Stop path saves ONE local checkpoint line
// per seat - first non-empty line of the final reply, sanitizeVisible'd and
// capped at 200, with its time - in a sibling file next to the seat state.
// Nothing goes to Honcho; empty/duplicate/stop_hook_active saves nothing and
// keeps the old line.
describe("recordReply V1 local checkpoint (ADR-0019 d1)", () => {
  const cpPath = (dir: string): string => join(dir, WS, "seats", `${SELF}.checkpoint.json`);
  const cpOf = (dir: string): { line: string; at: string } =>
    JSON.parse(readFileSync(cpPath(dir), "utf8")) as { line: string; at: string };

  test("multi-line reply: first non-empty line saved; a later reply is capped at 200", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "v1a", [u("q"), a("\n   \nF6 complete on row qitem-f6\nsecond line\nthird line")]);
      expect((await recordReply({ transcript_path: tp }, config, deps)).action).toBe("sent");
      const cp = cpOf(dir);
      expect(cp.line).toBe("F6 complete on row qitem-f6");
      expect(cp.at).toBeString();
      // a genuinely different reply replaces it, sanitized-then-capped
      const tp2 = transcript(dir, "v1b", [u("q2"), a("k".repeat(250))]);
      expect((await recordReply({ transcript_path: tp2 }, config, deps)).action).toBe("sent");
      expect(cpOf(dir).line).toBe("k".repeat(200));
    } finally {
      await fake.stop();
    }
  });

  test("secret-shaped token in the reply is masked in the saved line", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tok = `sk-ant-${"A".repeat(24)}`; // fake-secret
      const tp = transcript(dir, "v1s", [u("q"), a(`shipped with key ${tok} today`)]);
      expect((await recordReply({ transcript_path: tp }, config, deps)).action).toBe("sent");
      const line = cpOf(dir).line;
      expect(line).not.toContain(tok);
      expect(line).toContain("[REDACTED:");
      expect(line).toContain("shipped with key");
    } finally {
      await fake.stop();
    }
  });

  test("Codex shape (last_assistant_message + turn_id): the checkpoint is saved too", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const out = await recordReply(
        { last_assistant_message: "Codex seat: row closed", turn_id: "codex-turn-1" },
        config,
        deps,
      );
      expect(out.action).not.toBe("skipped");
      expect(cpOf(dir).line).toBe("Codex seat: row closed");
    } finally {
      await fake.stop();
    }
  });

  test("empty reply: skipped and the saved checkpoint file is byte-unchanged", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      const tp = transcript(dir, "v1k", [u("q"), a("a real line worth keeping")]);
      expect((await recordReply({ transcript_path: tp }, config, deps)).action).toBe("sent");
      const before = readFileSync(cpPath(dir));
      const empty = transcript(dir, "v1e", [u("q2"), a("   \n \n")]);
      expect(await recordReply({ transcript_path: empty }, config, deps)).toEqual({ action: "skipped" });
      expect(readFileSync(cpPath(dir)).equals(before)).toBe(true);
    } finally {
      await fake.stop();
    }
  });
});
