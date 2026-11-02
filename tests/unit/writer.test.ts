// T6a: the prompt writer end-to-end against the FAKE server only, in tmp
// state dirs. Covers the qitem's nine scenarios: enveloped DM shaping +
// ensure-before-message + no auto-created sessions; owner text; the
// automation switch; redaction before the wire; chunk metadata; the mission
// change; the outage->replay round trip; the ADR-0002 free-n rule (list-ok
// and list-failing); and the bin as a child process (kill switch and garbage
// stdin must be exit 0 with zero bytes out).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import {  existsSync, readdirSync, readFileSync, rmSync  } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readSeatState, seatStatePath, setRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt, type WriterDeps } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho, type FakeRequest } from "../support/fake-honcho.ts";

const FIXED_TS = "2026-10-28T12:00:00.000Z";
const FIXED_SEC = Math.floor(Date.parse(FIXED_TS) / 1000);
const WS = "ws";
const SELF = "build";

const mk = async (over: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("writer-test-");
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
  const deps: WriterDeps = { client, now: () => FIXED_TS };
  return { fake, dir, config, deps };
};

// Same-rig envelope fixture: the rig in the addresses must equal
// config.workspace ("ws"), or attribute derives a cross-rig peer id.
const dm = (from: string, body: string) =>
  `From: ${from}@${WS}\nTo: ${SELF}@${WS}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;

const stored = (fake: FakeHoncho, session: string) => fake.state.messages.get(`${WS}/${session}`) ?? [];
const creates = (fake: FakeHoncho): FakeRequest[] =>
  fake.requests.filter(
    (r) => r.method === "POST" && r.path === `/v3/workspaces/${WS}/sessions`,
  );
const bodyOf = (r: FakeRequest): Record<string, unknown> => (r.body ?? {}) as Record<string, unknown>;
const noAutoCreated = (fake: FakeHoncho): boolean =>
  [...fake.state.sessions.values()].every((s) => s.auto_created === undefined);

describe("recordPrompt (T6a)", () => {
  test("enveloped DM: one message peer dev-build in build--general--1, scope general created BEFORE the message, nothing auto-created", async () => {
    const { fake, config, deps } = await mk();
    try {
      const out = await recordPrompt(
        { prompt: dm("dev-build", "hello from the other seat"), claudeSessionId: "c1" },
        config,
        deps,
      );
      expect(out).toEqual({
        action: "sent",
        session: "build--general--1",
        peer: "dev-build",
        n_msgs: 1 });
      const msgs = stored(fake, "build--general--1");
      expect(msgs.length).toBe(1);
      expect(msgs[0].peer_id).toBe("dev-build");
      expect(msgs[0].content).toBe("hello from the other seat");

      const createReqs = creates(fake);
      expect(createReqs.length).toBe(1);
      expect(bodyOf(createReqs[0]).id).toBe("build--general--1");
      expect(bodyOf(createReqs[0]).scopes).toEqual(["general"]);
      expect(bodyOf(createReqs[0]).peers).toEqual({
        owner: { observe_me: true, observe_others: false },
        build: { observe_me: true, observe_others: false },
        "dev-build": { observe_me: true, observe_others: false } });
      const createIdx = fake.requests.indexOf(createReqs[0]);
      const msgIdx = fake.requests.findIndex((r) => r.path.endsWith("/messages"));
      expect(createIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeLessThan(msgIdx);

      expect(noAutoCreated(fake)).toBe(true);
      const seat = readSeatState(seatStatePath(config.stateDir, WS, SELF));
      expect(seat?.ensured_session).toBe("build--general--1");
      expect(seat?.members).toContain("dev-build");
    } finally {
      await fake.stop();
    }
  });

  test("owner typed text lands as peer owner", async () => {
    const { fake, config, deps } = await mk();
    try {
      const out = await recordPrompt({ prompt: "please rerun the spool check" }, config, deps);
      expect(out.action).toBe("sent");
      const msgs = stored(fake, "build--general--1");
      expect(msgs.length).toBe(1);
      expect(msgs[0].peer_id).toBe("owner");
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("automation: HONCHO_RECORD_AUTOMATION false writes nothing at all; true lands as peer openrig", async () => {
    const prompt =
      "OpenRig-generated identity context (not a project task):\nrole guidance here\nEnd of generated identity context.";
    const off = await mk({ recordAutomation: false });
    try {
      const out = await recordPrompt({ prompt }, off.config, off.deps);
      expect(out).toEqual({ action: "skipped", reason: "not-recorded" });
      expect(off.fake.requests.length).toBe(0);
      expect(off.fake.state.sessions.size).toBe(0);
      expect(off.fake.state.messages.size).toBe(0);
    } finally {
      await off.fake.stop();
    }
    const on = await mk();
    try {
      const out = await recordPrompt({ prompt }, on.config, on.deps);
      expect(out.action).toBe("sent");
      expect(stored(on.fake, "build--general--1")[0].peer_id).toBe("openrig");
      expect(noAutoCreated(on.fake)).toBe(true);
    } finally {
      await on.fake.stop();
    }
  });

  test("a fake secret in a DM reaches the server only as [REDACTED:...]", async () => {
    const { fake, config, deps } = await mk();
    const secret = "sk-ant-api03-FAKEfake1234FAKEfake1234KEYS"; // made-up, right shape only // fake-secret
    try {
      await recordPrompt({ prompt: dm("dev-build", `the value ${secret} is in the log`) }, config, deps);
      const content = stored(fake, "build--general--1")[0].content as string;
      expect(content).toContain("[REDACTED:");
      expect(content).not.toContain(secret);
      expect(content).not.toContain("FAKEfake1234");
    } finally {
      await fake.stop();
    }
  });

  test("60000-char DM: 3 messages sharing one metadata.chunk.id, rejoin equal", async () => {
    const { fake, config, deps } = await mk();
    // "q", not "a": a 60 000-char run of hex digits IS the ADR-0003 hex64
    // secret shape, and redaction (correctly) eats it before chunking.
    const body = "q".repeat(60000);
    try {
      const out = await recordPrompt({ prompt: dm("dev-build", body) }, config, deps);
      expect(out.action === "sent" && out.n_msgs).toBe(3);
      const msgs = stored(fake, "build--general--1");
      expect(msgs.length).toBe(3);
      const ids = msgs.map((m) => (m.metadata as Record<string, Record<string, unknown>>).chunk.id);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[1]).toBe(ids[2]);
      expect(msgs.map((m) => (m.metadata as Record<string, { n: number }>).chunk.n)).toEqual([3, 3, 3]);
      expect(msgs.map((m) => (m.metadata as Record<string, { i: number }>).chunk.i)).toEqual([1, 2, 3]);
      expect(msgs.map((m) => m.content).join("")).toBe(body);
    } finally {
      await fake.stop();
    }
  });

  test("rig mission set to slice-07 between two prompts: the second lands in build--slice-07--1, scope mission-slice-07", async () => {
    const { fake, config, deps } = await mk();
    try {
      const p1 = await recordPrompt({ prompt: dm("dev-build", "first on general") }, config, deps);
      expect(p1.action === "sent" && p1.session).toBe("build--general--1");
      expect((await setRigMission(config.stateDir, WS, "slice-07", "test")).ok).toBe(true);
      const p2 = await recordPrompt({ prompt: dm("dev-build", "second on the slice") }, config, deps);
      expect(p2.action === "sent" && p2.session).toBe("build--slice-07--1");
      const create = creates(fake).find((r) => bodyOf(r).id === "build--slice-07--1");
      expect(create).toBeDefined();
      expect(bodyOf(create as FakeRequest).scopes).toEqual(["mission-slice-07"]);
      expect(stored(fake, "build--slice-07--1")[0].content).toBe("second on the slice");
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("outage: refuse for 3 prompts then ok + a 4th -> all 4 on the server in order, right scope, none auto-created", async () => {
    const { fake, config, deps } = await mk();
    try {
      fake.mode("refuse");
      for (let i = 0; i < 3; i++) {
        const out = await recordPrompt({ prompt: dm("dev-build", `m${i}`) }, config, deps);
        expect(out.action).toBe("spooled");
      }
      fake.mode("ok");
      const out4 = await recordPrompt({ prompt: dm("dev-build", "m3") }, config, deps);
      expect(out4.action).toBe("sent");

      // the prompts shared one session (fallback n from the first prompt's
      // failed list call - the state dir was empty and the server was down)
      const keys = [...fake.state.messages.keys()];
      expect(keys.length).toBe(1);
      expect(stored(fake, keys[0].slice(WS.length + 1)).map((m) => m.content)).toEqual([
        "m0",
        "m1",
        "m2",
        "m3",
      ]);
      expect(fake.state.scopes.get(`${WS}/general`)).toEqual([keys[0].slice(WS.length + 1)]);
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("free-n (T6c-fix): 150 stamped sessions for self + 50 for another peer -> n = 151 in ONE filtered call", async () => {
    const { fake, config, deps } = await mk();
    try {
      const seed = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      // 150 of ours in the scope: one page (cap 100) can never hold the max,
      // which is why the free-n check is a metadata filter, not a page scan.
      for (let i = 1; i <= 150; i++) {
        const r = await seed.createSession(`build--general--${i}`, {
          peers: {},
          scopes: ["general"],
          metadata: { rig_peer: SELF, mission: "general" } });
        expect(r.ok).toBe(true);
      }
      for (let i = 1; i <= 50; i++) {
        expect(
          (await seed.createSession(`other--general--${i}`, {
            peers: {},
            scopes: ["general"],
            metadata: { rig_peer: "other", mission: "general" } })).ok,
        ).toBe(true);
      }
      const out = await recordPrompt({ prompt: dm("dev-build", "the 151st") }, config, deps);
      expect(out.action === "sent" && out.session).toBe("build--general--151");
      const list = fake.requests.filter((r) => r.path.includes("/workspaces/ws/sessions/list"));
      expect(list.length).toBe(1); // the filter answered: no scan needed
      expect(list[0].path).toBe("/v3/workspaces/ws/sessions/list?size=1&reverse=true");
      expect(bodyOf(list[0])).toEqual({ filters: { metadata: { rig_peer: SELF, mission: "general" } } });
      // the new session carries the tags, or the next free-n would be blind
      const create = creates(fake).find((r) => bodyOf(r).id === "build--general--151");
      expect(bodyOf(create as FakeRequest).metadata).toEqual({ rig_peer: SELF, mission: "general" });
      // the other peer is unaffected: its filter sees only its own 50, on the
      // SAME fake (a fresh one would answer its own mint)
      const o = await recordPrompt(
        { prompt: `From: dev-build@${WS}\nTo: other@${WS}\n---\npeer check\n---\n↩ Reply: rig send x "..."` },
        { ...config, peer: "other", stateDir: makeTempDir("writer-test-") },
        deps,
      );
      expect(o.action === "sent" && o.session).toBe("other--general--51");
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("free-n with an empty filter answer scans by id prefix: untagged 1 and 2 -> n = 3", async () => {
    const { fake, config, deps } = await mk();
    try {
      const seed = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
      // UNTAGGED on purpose: the filter cannot see these, so free-n must fall
      // back to the id-prefix scan rather than mint a colliding --1 (F-T6c-1).
      expect((await seed.createSession("build--general--1", { peers: {}, scopes: ["general"] })).ok).toBe(true);
      expect((await seed.createSession("build--general--2", { peers: {}, scopes: ["general"] })).ok).toBe(true);
      const out = await recordPrompt({ prompt: dm("dev-build", "third time") }, config, deps);
      expect(out.action === "sent" && out.session).toBe("build--general--3");
      const list = fake.requests.filter((r) => r.path.includes("/workspaces/ws/sessions/list"));
      expect(list.length).toBe(2); // filter (empty) then the unfiltered scan
      expect(bodyOf(list[0])).toEqual({ filters: { metadata: { rig_peer: SELF, mission: "general" } } });
      expect(list[1].body).toBeUndefined();
      expect(list[1].path).toBe("/v3/workspaces/ws/sessions/list?size=100&reverse=true");
      expect(stored(fake, "build--general--3")[0].content).toBe("third time");
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("sessions/list failing: n = unix seconds of now(), session metadata n_fallback true", async () => {
    const { fake, config, deps } = await mk();
    try {
      fake.failPattern("/sessions/list");
      const out = await recordPrompt({ prompt: dm("dev-build", "no list, big n") }, config, deps);
      const session = `build--general--${FIXED_SEC}`;
      expect(out.action === "sent" && out.session).toBe(session);
      const create = creates(fake).find((r) => bodyOf(r).id === session);
      expect(create).toBeDefined();
      expect(bodyOf(create as FakeRequest).metadata).toEqual({
        rig_peer: SELF,
        mission: "general",
        n_fallback: true });
      expect(stored(fake, session)[0].content).toBe("no list, big n");
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("an epoch-fallback session is stamped, so the next free-n mints epoch+1 (not a second epoch)", async () => {
    const { fake, config, deps } = await mk();
    try {
      fake.failPattern("/sessions/list");
      const first = await recordPrompt({ prompt: dm("dev-build", "epoch session") }, config, deps);
      const epoch = `build--general--${FIXED_SEC}`;
      expect(first.action === "sent" && first.session).toBe(epoch);
      fake.failPattern(null);
      // fresh seat state (a crash lost it) with the epoch session on the server
      const again = await recordPrompt(
        { prompt: dm("dev-build", "after the crash") },
        { ...config, stateDir: makeTempDir("writer-test-") },
        deps,
      );
      expect(again.action === "sent" && again.session).toBe(`build--general--${FIXED_SEC + 1}`);
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });
});

// T6b item 1/4: the profile workspace (ADR-0002) - owner text ONLY, second
// client, session <ws>--<self>, own spool, nothing else ever lands there.
describe("profile workspace writes (T6b)", () => {
  const profOf = (fake: FakeHoncho, id: string) => fake.state.messages.get(`prof/${id}`) ?? [];
  const workspacesSeen = (fake: FakeHoncho): string[] => {
    const set = new Set<string>();
    for (const r of fake.requests) {
      const m = /^\/v3\/workspaces\/([^/]+)\//.exec(r.path);
      if (m) set.add(m[1]);
    }
    return [...set].sort();
  };

  test("owner prompt: one message in the rig session AND one in prof/ws--build, both peer owner, both redacted", async () => {
    const { fake, config, deps } = await mk({ profileWorkspace: "prof" });
    const secret = "sk-ant-api03-FAKEfake1234FAKEfake1234KEYS"; // made-up shape only // fake-secret
    try {
      const out = await recordPrompt({ prompt: `remember the value ${secret} from today` }, config, deps);
      expect(out.action).toBe("sent");
      const rig = stored(fake, "build--general--1");
      const prof = profOf(fake, `${WS}--build`);
      expect(rig.length).toBe(1);
      expect(prof.length).toBe(1);
      expect(rig[0].peer_id).toBe("owner");
      expect(prof[0].peer_id).toBe("owner");
      for (const m of [rig[0], prof[0]]) {
        expect(m.content).toContain("[REDACTED:");
        expect(m.content).not.toContain(secret);
      }
      // profile session ensured with owner-only peers, NO scopes, before the message
      const profCreate = fake.requests.find(
        (r) => r.method === "POST" && r.path === "/v3/workspaces/prof/sessions",
      );
      expect(profCreate).toBeDefined();
      expect(bodyOf(profCreate as FakeRequest).peers).toEqual({
        owner: { observe_me: true, observe_others: false } });
      expect(bodyOf(profCreate as FakeRequest).scopes).toBeUndefined();
      // profile sessions are session creations too, so they carry the ADR-0002 tags
      expect(bodyOf(profCreate as FakeRequest).metadata).toEqual({ rig_peer: SELF, mission: "general" });
      const createIdx = fake.requests.indexOf(profCreate as FakeRequest);
      const profMsgIdx = fake.requests.findIndex(
        (r) => r.path === `/v3/workspaces/prof/sessions/${WS}--build/messages`,
      );
      expect(createIdx).toBeGreaterThanOrEqual(0);
      expect(createIdx).toBeLessThan(profMsgIdx);
      expect(noAutoCreated(fake)).toBe(true);
    } finally {
      await fake.stop();
    }
  });

  test("peer DM and automation never write to the profile workspace", async () => {
    const dmCase = await mk({ profileWorkspace: "prof" });
    try {
      await recordPrompt({ prompt: dm("dev-build", "dm body for the seat") }, dmCase.config, dmCase.deps);
      expect(dmCase.fake.requests.some((r) => r.path.includes("/workspaces/prof/"))).toBe(false);
      expect(profOf(dmCase.fake, `${WS}--build`).length).toBe(0);
    } finally {
      await dmCase.fake.stop();
    }
    const autoCase = await mk({ profileWorkspace: "prof" });
    try {
      const out = await recordPrompt(
        { prompt: "OpenRig-generated identity context (not a project task):\nrole guidance here\nEnd of generated identity context." },
        autoCase.config,
        autoCase.deps,
      );
      expect(out.action).toBe("sent"); // lands in the rig workspace as peer openrig
      expect(autoCase.fake.requests.some((r) => r.path.includes("/workspaces/prof/"))).toBe(false);
    } finally {
      await autoCase.fake.stop();
    }
  });

  test("profileWorkspace unset: no request ever names a second workspace (X2)", async () => {
    const { fake, config, deps } = await mk();
    try {
      await recordPrompt({ prompt: "owner text with no profile set" }, config, deps);
      await recordPrompt({ prompt: dm("dev-build", "and a peer dm") }, config, deps);
      expect(workspacesSeen(fake)).toEqual([WS]);
    } finally {
      await fake.stop();
    }
  });
});

describe("bin/user-prompt.ts as a child process", () => {
  const REPO = join(import.meta.dir, "..", "..");
  const BIN = join(REPO, "plugin/bin/user-prompt.ts");

  const run = async (env: Record<string, string>, stdin: string) => {
    const p = Bun.spawn([process.execPath, BIN], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe" });
    p.stdin.write(stdin);
    p.stdin.end();
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return { code, out, err };
  };

  test("HONCHO_ENABLED=false: exit 0, zero bytes stdout+stderr, no log written", async () => {
    const dir = makeTempDir("writer-bin-");
    const r = await run(
      {
        HOME: dir,
        HONCHO_STATE_DIR: dir,
        HONCHO_ENABLED: "false",
        HONCHO_URL: "http://127.0.0.1:9/v3",
        HONCHO_WORKSPACE: WS,
        HONCHO_PEER: SELF },
      JSON.stringify({ prompt: "hi", session_id: "c1" }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
    // off means off: not even a log directory appears under the workspace
    expect(existsSync(join(dir, WS))).toBe(false);
  });

  test("garbage stdin: exit 0, zero bytes stdout+stderr", async () => {
    const dir = makeTempDir("writer-bin-");
    // HONCHO_URL missing -> config problem path; still total silence on the wires
    const r = await run({ HOME: dir, HONCHO_STATE_DIR: dir }, "not json {{{ ");
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });

  test("enabled with a real fake server: silent, and the message lands", async () => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("writer-bin-");
    try {
      const r = await run(
        {
          HOME: dir,
          HONCHO_STATE_DIR: dir,
          HONCHO_URL: fake.url,
          HONCHO_WORKSPACE: WS,
          HONCHO_PEER: SELF },
        JSON.stringify({ prompt: dm("dev-build", "hello from the hook"), session_id: "c9" }),
      );
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      expect(stored(fake, "build--general--1").map((m) => m.content)).toEqual([
        "hello from the hook",
      ]);
      expect(readdirSync(dir).length).toBeGreaterThan(0); // seat state was written
    } finally {
      await fake.stop();
    }
  });

  test("T14b-2 (ADR-0009): an attribution skip logs event:not-recorded, ok:true, and makes no request", async () => {
    // The pilot skipped lines are attribution skips (writer.ts, step a):
    // correct behaviour, so the log must not call it a failure. Real bin,
    // real attribution, no stubs: an OpenRig automation prompt with
    // HONCHO_RECORD_AUTOMATION unset (default false). HONCHO_URL points at a
    // CLOSED port, so any attempted write would leave a spool file under the
    // state dir - the skip returns before any client call, so none may exist.
    const dir = makeTempDir("writer-bin-skip-");
    try {
      const r = await run(
        {
          HOME: dir,
          HONCHO_STATE_DIR: dir,
          HONCHO_URL: "http://127.0.0.1:1/v3", // closed: a request would spool
          HONCHO_WORKSPACE: WS,
          HONCHO_PEER: SELF,
          // HONCHO_RECORD_AUTOMATION deliberately unset
        },
        JSON.stringify({
          prompt:
            `From: daemon@kernel\nTo: ${SELF}@${WS}\nSent: 10-31 03:00Z\n---\n`
            + "Queue nudge: qitem-20261031000000-0000000000000000 - check your queue.\n"
            + `---\n↩ Reply: rig send x "..."`,
          session_id: "c1" }),
      );
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toBe("");
      const lines = readFileSync(join(dir, "log", `${WS}.log`), "utf8")
        .trimEnd()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.length).toBe(1); // O1: exactly one event for the run
      expect(lines[0]!.event).toBe("not-recorded");
      expect(lines[0]!.ok).toBe(true);
      expect("session" in (lines[0] as object)).toBe(false);
      expect("n_msgs" in (lines[0] as object)).toBe(false);
      expect(existsSync(join(dir, WS, "spool"))).toBe(false); // no write was attempted
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("F2 (T8d-2 architect ruling 22:25Z): ensure once per session, not per prompt", () => {
  test("two prompts, one session -> exactly one POST /sessions; cache survives resolveSession", async () => {
    const { fake, config, deps } = await mk();
    try {
      for (const i of [1, 2]) {
        const out = await recordPrompt(
          { prompt: `f2 probe ${i}`, claudeSessionId: "c1" },
          config,
          deps,
        );
        expect(out.action).toBe("sent");
      }
      expect(creates(fake).length).toBe(1);
      const st = readSeatState(seatStatePath(config.stateDir, WS, SELF));
      expect(st?.ensured_session).toBe("build--general--1");
      expect(st?.members).toContain("owner");
      expect(st?.members).toContain(SELF);
    } finally {
      await fake.stop();
    }
  });
});

describe("T8d-3 (ADR-0006 a2abdbd): message configuration only ever suppresses", () => {
  test("ack sends enabled:false; a reasoning-true prompt sends NO configuration", async () => {
    const { fake, config, deps } = await mk();
    try {
      const ack = await recordPrompt({ prompt: "ok", claudeSessionId: "c1" }, config, deps);
      expect(ack.action).toBe("sent");
      const ackMsgs = stored(fake, "build--general--1");
      expect(ackMsgs.length).toBe(1);
      const cfg = ackMsgs[0].configuration as { reasoning?: { enabled?: boolean } } | undefined;
      expect(cfg?.reasoning?.enabled).toBe(false); // explicit suppression

      const real = await recordPrompt(
        { prompt: dm("dev-build", "please review the release notes when you get a chance"), claudeSessionId: "c1" },
        config,
        deps,
      );
      expect(real.action).toBe("sent");
      const all = stored(fake, "build--general--1");
      expect(all.length).toBe(2);
      // reasoning-true: no configuration field at all - the workspace default decides,
      // so deriver-disabled scratch workspaces cost the model server nothing
      expect(all[1].configuration).toBeUndefined();
    } finally {
      await fake.stop();
    }
  });
});
