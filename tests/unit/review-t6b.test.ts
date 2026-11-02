// dev.review battery for T6b (owner profile writes + Stop reply writer with
// dedupe) at pin 8f4706a (qitem-20261028145321-484daa78c39997d2).
// Contract: ADR-0002 "Profile workspace" (owner-typed prompts only, session
// <ws>--<peer>, peer owner only, NOTHING else ever written there); ADR-0003
// "Replies" (Stop records turn assistant text; tool calls/results never) and
// "Each message recorded once"; ADR-0005 E3 (dedupe by segment-hash);
// ADR-0006 X2 (only two workspaces ever written).
// Attack list per the architect's qitem; identical-replies-on-two-turns was
// the ruling question, ruled per-turn at c5c63ff (amendment 85e010c) and
// retargeted to the fixed contract at this pin, with the no-uuid fallback
// documented separately.
// Local tmp dirs + 127.0.0.1 fakes only; no real server, no secrets.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { createHash } from "node:crypto";
import {  chmodSync, existsSync, readFileSync, rmSync, writeFileSync  } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readSeatState, seatStatePath, setRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt } from "../../plugin/src/writer.ts";
import { recordReply, turnAssistantText } from "../../plugin/src/stop.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const STOP_BIN = fileURLToPath(new URL("../../plugin/bin/stop.ts", import.meta.url));
const WS = "ws";
const PROF = "prof";
const FIXED_TS = "2026-10-28T12:00:00.000Z";
// fake shapes only (same as review-t4/t5/t6a)
const ANTH = "sk-ant-RevFake0123456789abcdefGHIJKL"; // fake-secret

const mkWriter = async (over: Partial<Config> = {}) => {
  const fake = await startFakeHoncho();
  const dir = makeTempDir("rev-t6b-");
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
  const config: Config = {
    enabled: true,
    url: fake.url,
    workspace: WS,
    peer: "lead",
    observeOthers: false,
    ownerPeer: "owner",
    profileWorkspace: null,
    recordAutomation: false,
    apiKey: "k",
    stateDir: dir,
    timeoutMs: 2000,
    ...over };
  return { fake, dir, config, deps: { client, now: () => FIXED_TS } };
};

const withProfile = () => mkWriter({ profileWorkspace: PROF });

const storedIn = (fake: FakeHoncho, ws: string, session: string) =>
  fake.state.messages.get(`${ws}/${session}`) ?? [];
const contents = (msgs: Array<Record<string, unknown>>): string[] =>
  msgs.map((m) => m.content as string);
const profPaths = (fake: FakeHoncho) => fake.requests.filter((r) => r.path.includes(`/${PROF}/`));

const envelope = (from: string, body: string) =>
  `From: ${from}\nTo: lead@${WS}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// transcript entry builders (shapes stop.ts parses)
const u = (text: string, uuid?: string) =>
  JSON.stringify({
    ...(uuid !== undefined ? { uuid } : {}),
    type: "user",
    message: { content: [{ type: "text", text }] } });
const a = (...texts: string[]) =>
  JSON.stringify({
    type: "assistant",
    message: { content: texts.map((t) => ({ type: "text", text: t })) } });
const writeTranscript = (dir: string, lines: string[], name = "t.jsonl"): string => {
  const p = join(dir, name);
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
};

const readLog = (dir: string, ws = WS): string => {
  try {
    return readFileSync(join(dir, "log", `${ws}.log`), "utf8");
  } catch {
    return "";
  }
};

// ---------- X2 / owner-only profile gate ----------

describe("R-T6b X2: only owner-class writes reach the profile", () => {
  test("owner-typed text lands in BOTH workspaces; profile copy is session <ws>--<peer>, peer owner, kind owner", async () => {
    const t = await withProfile();
    try {
      const out = await recordPrompt({ prompt: "owner typed a task about widgets", claudeSessionId: "c1" }, t.config, t.deps);
      expect(out.action).toBe("sent");
      const rigMsgs = storedIn(t.fake, WS, "lead--general--1");
      expect(contents(rigMsgs)).toEqual(["owner typed a task about widgets"]);
      const profMsgs = storedIn(t.fake, PROF, `${WS}--lead`);
      expect(contents(profMsgs)).toEqual(["owner typed a task about widgets"]);
      expect((profMsgs[0] as { peer_id: string }).peer_id).toBe("owner");
      expect((profMsgs[0] as { metadata: { kind: string } }).metadata.kind).toBe("owner");
      // X2: exactly the two configured workspaces were touched...
      expect([...t.fake.state.workspaces].sort()).toEqual([PROF, WS]);
      // ...and the profile session exists ONLY there (no ws--lead on rig paths)
      expect(
        t.fake.requests.some((r) => r.path.includes(`/${WS}/`) && r.path.includes(`${WS}--lead`)),
      ).toBe(false);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("peer DM: nothing reaches the profile even with it configured", async () => {
    const t = await withProfile();
    try {
      await recordPrompt({ prompt: envelope("x@other", "peer body here") }, t.config, t.deps);
      expect(profPaths(t.fake).length).toBe(0);
      expect(t.fake.state.workspaces.has(PROF)).toBe(false);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("owner@external: kind is 'peer' with peer id 'owner' - NO profile write (id match is not kind match)", async () => {
    const t = await withProfile();
    try {
      await recordPrompt({ prompt: envelope("owner@external", "external owner says hi") }, t.config, t.deps);
      expect(profPaths(t.fake).length).toBe(0);
      const rig = storedIn(t.fake, WS, "lead--general--1");
      expect((rig[0] as { peer_id: string; metadata: { kind: string } }).peer_id).toBe("owner");
      expect((rig[0] as { metadata: { kind: string } }).metadata.kind).toBe("peer");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("automation WITH record on: recorded in the rig ws, never in the profile", async () => {
    const t = await mkWriter({ profileWorkspace: PROF, recordAutomation: true });
    try {
      await recordPrompt({ prompt: envelope("daemon@kernel", "automated nudge body") }, t.config, t.deps);
      expect(profPaths(t.fake).length).toBe(0);
      expect(storedIn(t.fake, WS, "lead--general--1").length).toBe(1);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("unknown sender: never in the profile", async () => {
    const t = await withProfile();
    try {
      await recordPrompt({ prompt: envelope("<unknown sender>", "who even is this") }, t.config, t.deps);
      expect(profPaths(t.fake).length).toBe(0);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a Stop reply never writes the profile even when it is configured", async () => {
    const t = await withProfile();
    try {
      const out = await recordReply({ last_assistant_message: "the turn answer, substantive" }, t.config, t.deps);
      expect(out.action).toBe("sent");
      expect(profPaths(t.fake).length).toBe(0);
      expect(t.fake.state.workspaces.has(PROF)).toBe(false);
      const msgs = storedIn(t.fake, WS, "lead--general--1");
      expect((msgs[0] as { peer_id: string; metadata: { kind: string } }).peer_id).toBe("lead");
      expect((msgs[0] as { metadata: { kind: string } }).metadata.kind).toBe("reply");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("profile unset: owner text touches ONLY the rig ws; no profile spool dir is ever made", async () => {
    const t = await mkWriter(); // profileWorkspace null
    try {
      await recordPrompt({ prompt: "owner text, no profile configured", claudeSessionId: "c1" }, t.config, t.deps);
      expect([...t.fake.state.workspaces]).toEqual([WS]);
      expect(existsSync(join(t.dir, PROF))).toBe(false);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

// ---------- profile outage: separate spool, replayed into the profile only ----------

describe("R-T6b profile spool", () => {
  test("profile outage: rig write succeeds, profile entry spools under <state>/<prof>/, recovery replays both into the profile session in order", async () => {
    const t = await withProfile();
    try {
      t.fake.failPattern(`/${PROF}/`); // 500 on every profile path only
      const out = await recordPrompt({ prompt: "first owner text during outage", claudeSessionId: "c1" }, t.config, t.deps);
      expect(out.action).toBe("sent"); // the profile failure never poisons the main outcome
      expect(contents(storedIn(t.fake, WS, "lead--general--1"))).toEqual(["first owner text during outage"]);
      expect(storedIn(t.fake, PROF, `${WS}--lead`).length).toBe(0);
      const profSpool = join(t.dir, PROF, "spool", "lead.jsonl");
      expect(existsSync(profSpool)).toBe(true);
      const spooled = JSON.parse(readFileSync(profSpool, "utf8").split("\n")[0] as string) as {
        session: string;
        ensure?: { create: { id: string } };
      };
      expect(spooled.session).toBe(`${WS}--lead`); // replay knows its own session
      expect(spooled.ensure?.create.id).toBe(`${WS}--lead`); // ... and how to ensure it

      t.fake.failPattern(null);
      await recordPrompt({ prompt: "second owner text after recovery", claudeSessionId: "c2" }, t.config, t.deps);
      expect(contents(storedIn(t.fake, PROF, `${WS}--lead`))).toEqual([
        "first owner text during outage",
        "second owner text after recovery",
      ]);
      // drained: the E1 protocol recreates the live file EMPTY (0600), so the
      // contract is zero lines, not absence
      const liveNow = existsSync(profSpool) ? readFileSync(profSpool, "utf8").split("\n").filter((l) => l !== "") : [];
      expect(liveNow).toEqual([]);
      // profile traffic NEVER touches the rig workspace's sessions and vice versa
      const profSessionIds = new Set(
        profPaths(t.fake)
          .map((r) => /\/sessions\/([^/?]+)/.exec(r.path)?.[1])
          .filter((s): s is string => s !== undefined),
      );
      expect([...profSessionIds]).toEqual([`${WS}--lead`]);
      for (const m of storedIn(t.fake, PROF, `${WS}--lead`)) {
        expect((m as { metadata: { kind: string } }).metadata.kind).toBe("owner");
      }
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

// ---------- transcript segment logic ----------

describe("R-T6b transcript parsing", () => {
  test("tool_use and tool_result are never recorded; plain text blocks are, in order, joined", async () => {
    const t = await mkWriter();
    try {
      const tp = writeTranscript(t.dir, [
        u("do the thing"),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "working on it" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "SECRET_TOOL_INPUT xyz" } },
            ] } }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "TOOL_RESULT_BODY pqr" }] } }),
        a("final answer"),
      ]);
      const out = await recordReply({ transcript_path: tp, last_assistant_message: "final answer" }, t.config, t.deps);
      expect(out.action).toBe("sent");
      const text = contents(storedIn(t.fake, WS, "lead--general--1")).join("");
      expect(text).toBe("working on it\n\nfinal answer");
      expect(text).not.toContain("SECRET_TOOL_INPUT");
      expect(text).not.toContain("TOOL_RESULT_BODY");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("isMeta skill entries do NOT end the walk-back (assistant text before them still belongs to the turn)", () => {
    const dir = makeTempDir("rev-t6b-tx-");
    try {
      const tp = writeTranscript(dir, [
        u("start task"),
        a("answer-part-one"),
        JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "skill launched" }] } }),
        a("answer-part-two"),
      ]);
      expect(turnAssistantText(tp, "answer-part-two")).toBe("answer-part-one\n\nanswer-part-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("system wakeups and task-notifications START a segment: text from before them is not re-sent", () => {
    const dir = makeTempDir("rev-t6b-tx-");
    try {
      const tp = writeTranscript(dir, [
        u("original prompt"),
        a("old answer from last turn"),
        JSON.stringify({ type: "user", promptSource: "system", message: { content: [] } }),
        a("woken answer"),
      ]);
      expect(turnAssistantText(tp, "woken answer")).toBe("woken answer");
      const tp2 = writeTranscript(dir, [
        u("p"), a("stale"),
        JSON.stringify({ type: "user", origin: { kind: "task-notification" }, message: { content: [] } }),
        a("fresh"),
      ], "t2.jsonl");
      expect(turnAssistantText(tp2, "fresh")).toBe("fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("string-content entries (older transcripts): user strings are boundaries, assistant strings are text", () => {
    const dir = makeTempDir("rev-t6b-tx-");
    try {
      const tp = writeTranscript(dir, [
        JSON.stringify({ role: "user", content: "typed prompt" }),
        JSON.stringify({ role: "assistant", content: "one" }),
        JSON.stringify({ role: "assistant", content: "two" }),
      ]);
      expect(turnAssistantText(tp, "two")).toBe("one\n\ntwo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt lines are skipped, valid ones survive, nothing throws", () => {
    const dir = makeTempDir("rev-t6b-tx-");
    try {
      const tp = writeTranscript(dir, [
        u("prompt"),
        "NOT-JSON {{{",
        a("good block"),
        '{"type":"assistant","message":', // torn line
      ]);
      expect(turnAssistantText(tp, "good block")).toBe("good block");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or unreadable transcript -> the payload's last_assistant_message is used", () => {
    const dir = makeTempDir("rev-t6b-tx-");
    try {
      expect(turnAssistantText(join(dir, "nope.jsonl"), "payload copy")).toBe("payload copy");
      const locked = join(dir, "locked.jsonl");
      writeTranscript(dir, [u("x"), a("never seen")], "locked.jsonl");
      chmodSync(locked, 0o000);
      try {
        expect(turnAssistantText(locked, "payload after unreadable")).toBe("payload after unreadable");
      } finally {
        chmodSync(locked, 0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flush race: the payload copy fills in when the last block differs, and never duplicates when it matches", () => {
    const dir = makeTempDir("rev-t6b-tx-");
    try {
      const tp = writeTranscript(dir, [u("p"), a("partial thought")]);
      expect(turnAssistantText(tp, "full final answer")).toBe("partial thought\n\nfull final answer");
      expect(turnAssistantText(tp, "partial thought")).toBe("partial thought"); // no dup
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no transcript, no payload, whitespace payload -> skipped, no request, no seat state", async () => {
    const t = await mkWriter();
    try {
      expect((await recordReply({}, t.config, t.deps)).action).toBe("skipped");
      expect((await recordReply({ last_assistant_message: "   \n " }, t.config, t.deps)).action).toBe("skipped");
      expect(t.fake.requests.length).toBe(0);
      expect(existsSync(seatStatePath(t.dir, WS, "lead"))).toBe(false);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("huge turn text: full pipeline inside a sane budget - redacted whole, chunked contiguously, reassembles exactly", async () => {
    const t = await mkWriter();
    try {
      const body = `q${"z".repeat(1_200_000)}m${"y".repeat(1_200_000)}`;
      const tp = writeTranscript(t.dir, [u("big task"), a(body)]);
      const t0 = Date.now();
      const out = await recordReply({ transcript_path: tp, last_assistant_message: body }, t.config, t.deps);
      const ms = Date.now() - t0;
      expect(out.action).toBe("sent");
      if (out.action !== "skipped") expect(out.n_msgs).toBeGreaterThan(50); // chunked
      const msgs = storedIn(t.fake, WS, "lead--general--1");
      const re = msgs
        .map((m) => ({ content: m.content as string, meta: m.metadata as { chunk?: { i: number; n: number } } }))
        .sort((x, y) => (x.meta.chunk?.i ?? 1) - (y.meta.chunk?.i ?? 1))
        .map((x) => x.content)
        .join("");
      expect(re).toBe(body);
      expect(msgs[0]!.metadata as unknown).toBeTruthy();
      expect(ms).toBeLessThan(10_000); // hook budget sanity: a 2.4MB turn must not hang the hook
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

// ---------- E3 dedupe ----------

describe("R-T6b E3 dedupe", () => {
  test("the same segment twice: second is skipped, one message on the server, hash stored, log line", async () => {
    const t = await mkWriter();
    try {
      const first = await recordReply({ last_assistant_message: "identical segment text" }, t.config, t.deps);
      expect(first.action).toBe("sent");
      const second = await recordReply({ last_assistant_message: "identical segment text" }, t.config, t.deps);
      expect(second.action).toBe("skipped");
      expect(storedIn(t.fake, WS, "lead--general--1").length).toBe(1);
      const state = readSeatState(seatStatePath(t.dir, WS, "lead"));
      expect(state?.last_reply_hash).toBe(sha256("identical segment text"));
      expect(readLog(t.dir)).toContain("duplicate segment");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("stop_hook_active: skipped outright, even with fresh text and no prior hash", async () => {
    const t = await mkWriter();
    try {
      const out = await recordReply(
        { last_assistant_message: "brand new answer", stop_hook_active: true },
        t.config,
        t.deps,
      );
      expect(out.action).toBe("skipped");
      expect(t.fake.requests.length).toBe(0);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  // RETARGETED at the T6b-fix pin (c5c63ff, ADR-0005 amendment 85e010c; the
  // architect's 16:34Z instruction): this documented the pre-fix loss as a
  // ruling question; the ruling landed as per-turn hashing. With uuid'd
  // boundary entries - real transcripts always have them - the identical text
  // on a genuinely different turn is now RECORDED, while the same turn
  // re-firing is still skipped.
  test("T6b-fix contract: identical reply text on two DIFFERENT turns (uuid boundaries) -> both recorded; same-turn re-fire still skipped", async () => {
    const t = await mkWriter();
    try {
      const turn1 = writeTranscript(t.dir, [u("task one", "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), a("Deploy complete.")], "turn1.jsonl");
      const o1 = await recordReply({ transcript_path: turn1, last_assistant_message: "Deploy complete." }, t.config, t.deps);
      expect(o1.action).toBe("sent");
      // the SAME turn re-fires (Stop on wakeup): same uuid, same text -> skipped
      const o1b = await recordReply({ transcript_path: turn1, last_assistant_message: "Deploy complete." }, t.config, t.deps);
      expect(o1b.action).toBe("skipped");
      expect(storedIn(t.fake, WS, "lead--general--1").length).toBe(1);
      // a genuinely later turn produced the same text for a different reason
      const turn2 = writeTranscript(t.dir, [u("task two", "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), a("Deploy complete.")], "turn2.jsonl");
      const o2 = await recordReply({ transcript_path: turn2, last_assistant_message: "Deploy complete." }, t.config, t.deps);
      expect(o2.action).toBe("sent");
      expect(storedIn(t.fake, WS, "lead--general--1").length).toBe(2);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("T6b-fix fallback (documented): no uuid on the boundary entry -> hash degrades to the text, second identical reply is skipped", async () => {
    const t = await mkWriter();
    try {
      const turn1 = writeTranscript(t.dir, [u("task one"), a("Deploy complete.")], "turn1.jsonl");
      const o1 = await recordReply({ transcript_path: turn1, last_assistant_message: "Deploy complete." }, t.config, t.deps);
      expect(o1.action).toBe("sent");
      // no-transcript payload-only call: no boundary -> text-only fallback
      const o2 = await recordReply({ last_assistant_message: "Deploy complete." }, t.config, t.deps);
      expect(o2.action).toBe("skipped");
      expect(storedIn(t.fake, WS, "lead--general--1").length).toBe(1);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("last_reply_hash survives resolveSession rewrites and stays seat-level across mission switches", async () => {
    const t = await mkWriter();
    try {
      await recordReply({ last_assistant_message: "answer to remember" }, t.config, t.deps);
      const hash = readSeatState(seatStatePath(t.dir, WS, "lead"))?.last_reply_hash;
      expect(hash).toBe(sha256("answer to remember"));
      // a prompt write rewrites the seat state (new session for the new mission)
      await setRigMission(t.dir, WS, "slice-07", "review");
      await recordPrompt({ prompt: "owner moves on", claudeSessionId: "c2" }, t.config, t.deps);
      expect(readSeatState(seatStatePath(t.dir, WS, "lead"))?.last_reply_hash).toBe(hash); // carried through
      // dedupe still bites in the NEW session - it is seat-level
      const again = await recordReply({ last_assistant_message: "answer to remember" }, t.config, t.deps);
      expect(again.action).toBe("skipped");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a crash before store does NOT burn the dedupe: exploding client -> skipped, no hash, the next real run records", async () => {
    const t = await mkWriter();
    try {
      const boom = {
        createSession: async () => ({ ok: true, data: {} }),
        addSessionPeers: async () => ({ ok: true, data: {} }),
        listScopeSessions: async () => ({ ok: true, data: { items: [] } }),
        addMessages: async () => {
          throw new Error("transport died mid-send");
        } } as never;
      const out = await recordReply({ last_assistant_message: "worth retrying" }, t.config, {
        client: boom,
        now: t.deps.now });
      expect(out.action).toBe("skipped");
      const st = readSeatState(seatStatePath(t.dir, WS, "lead"));
      expect(st?.last_reply_hash).toBeUndefined();
      expect(readLog(t.dir)).toContain("unexpected");
      const retry = await recordReply({ last_assistant_message: "worth retrying" }, t.config, t.deps);
      expect(retry.action).toBe("sent");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

// ---------- routing / E5 / E2 on the reply path ----------

describe("R-T6b reply routing and content pipeline", () => {
  test("mission switch mid-conversation: each reply lands in the CURRENT mission session", async () => {
    const t = await mkWriter();
    try {
      const o1 = await recordReply({ last_assistant_message: "answer under general" }, t.config, t.deps);
      expect(o1.action === "sent" && o1.session).toBe("lead--general--1");
      await setRigMission(t.dir, WS, "slice-07", "review");
      const o2 = await recordReply({ last_assistant_message: "answer under the slice" }, t.config, t.deps);
      expect(o2.action === "sent" && o2.session).toBe("lead--slice-07--1");
      expect(contents(storedIn(t.fake, WS, "lead--slice-07--1"))).toEqual(["answer under the slice"]);
      expect(contents(storedIn(t.fake, WS, "lead--general--1"))).toEqual(["answer under general"]);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("an ack reply is stored but reasons false; a substantive reply reasons true (E5)", async () => {
    const t = await mkWriter();
    try {
      await recordReply({ last_assistant_message: "ok" }, t.config, t.deps);
      const ack = storedIn(t.fake, WS, "lead--general--1")[0] as {
        configuration: { reasoning: { enabled: boolean } };
        metadata: { kind: string };
      };
      expect(ack.metadata.kind).toBe("reply"); // still stored for context
      expect(ack.configuration.reasoning.enabled).toBe(false);
      await recordReply({ last_assistant_message: "The migration finished; all 42 rows verified against the fixture." }, t.config, t.deps);
      const real = storedIn(t.fake, WS, "lead--general--1")[1] as {
        configuration?: unknown;
      };
      // T8d-3 retarget: reasoning-true OMITS configuration; only the ack
      // suppression above carries {reasoning:{enabled:false}}.
      expect(real.configuration).toBeUndefined();
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("a secret straddling the chunk boundary is gone from EVERY chunk (redaction runs on the whole reply first, E2)", async () => {
    const t = await mkWriter();
    try {
      const body = `z${"z".repeat(23_988)}${ANTH}${"y".repeat(1_000)}`; // key crosses the 24000 cut
      const out = await recordReply({ last_assistant_message: body }, t.config, t.deps);
      expect(out.action).toBe("sent");
      const msgs = storedIn(t.fake, WS, "lead--general--1");
      expect(msgs.length).toBeGreaterThan(1);
      for (const m of msgs) expect(m.content as string).not.toContain("sk-ant-RevFake");
      const joined = contents(msgs).join("");
      expect(joined).toContain("[REDACTED:anthropic]");
      expect(joined.length).toBeLessThan(body.length);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

// ---------- the Stop bin ----------

describe("R-T6b stop bin (silence rules)", () => {
  const runBin = async (dir: string, stdin: unknown, env: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, STOP_BIN], {
      stdin: stdin === undefined ? "ignore" : Buffer.from(JSON.stringify(stdin)),
      stdout: "pipe",
      stderr: "pipe",
      env });
    const code = await proc.exited;
    return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
  };

  test("valid Stop payload: silent exit 0 and the reply is recorded with kind reply", async () => {
    const t = await mkWriter();
    try {
      const r = await runBin(t.dir, { session_id: "c9", last_assistant_message: "reply from the real bin" }, {
        HOME: "/tmp", PATH: "/usr/bin:/bin",
        HONCHO_ENABLED: "1", HONCHO_URL: t.fake.url, HONCHO_WORKSPACE: WS,
        HONCHO_PEER: "lead", HONCHO_OWNER_PEER: "owner", HONCHO_API_KEY: "k",
        HONCHO_STATE_DIR: t.dir });
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      const msgs = storedIn(t.fake, WS, "lead--general--1");
      expect(contents(msgs)).toEqual(["reply from the real bin"]);
      expect((msgs[0] as { metadata: { kind: string } }).metadata.kind).toBe("reply");
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("garbage stdin: exit 0, silent, nothing sent", async () => {
    const t = await mkWriter();
    try {
      const proc = Bun.spawn([process.execPath, STOP_BIN], {
        stdin: Buffer.from("this is not json {{{"),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          HOME: "/tmp", PATH: "/usr/bin:/bin",
          HONCHO_ENABLED: "1", HONCHO_URL: t.fake.url, HONCHO_WORKSPACE: WS,
          HONCHO_PEER: "lead", HONCHO_API_KEY: "k", HONCHO_STATE_DIR: t.dir } });
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(await new Response(proc.stdout).text()).toBe("");
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(t.fake.requests.length).toBe(0);
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("kill switch: exit 0, silent, NOTHING logged and nothing sent", async () => {
    const t = await mkWriter();
    try {
      const r = await runBin(t.dir, { last_assistant_message: "should never ship" }, {
        HOME: "/tmp", PATH: "/usr/bin:/bin",
        HONCHO_ENABLED: "0", HONCHO_URL: t.fake.url, HONCHO_WORKSPACE: WS,
        HONCHO_PEER: "lead", HONCHO_API_KEY: "k", HONCHO_STATE_DIR: t.dir });
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      expect(t.fake.requests.length).toBe(0);
      expect(readLog(t.dir)).toBe(""); // the kill-switch reason is never logged
    } finally {
      await t.fake.stop();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
