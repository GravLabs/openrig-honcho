// v0.2.2 final review battery (review seat, pin 16e5076, OFFLINE ONLY - every
// byte here stays against fake-honcho / fake-daemon / temp dirs; no real
// server, no scratch workspaces touched).
//
// Coverage policy: tests/unit/writer-outbox.test.ts and
// tests/unit/mcp-search.test.ts already pin the build's happy paths; this
// file attacks only the gaps: a peer-forged nudge body (VF1/VF1b), secret-
// shaped and invalid mission tags (VF2), outbox stamp edges (VF3), the
// verify pass changing nothing (VF4), the serial double-fetch budget (VF5),
// redact-before-send and odd `about` on the search tool (VD), the wall-timeout
// branch and the slow-pair partial matrix (VD3/VD4), and the device-code rule
// edges (VC). FINDING-prefixed tests assert the SAFE behaviour and fail while
// the defect stands; OBSERVATION-prefixed tests pin the CURRENT behaviour for
// the architect to rule on and are expected to flip red if the ruling fixes it.
//
// No raw invisible characters: the envelope footer is written as a
// \u21a9 escape, per the review seat's source-discipline memory.

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readRigMission } from "../../plugin/src/missions.ts";
import { recordPrompt, type WriterDeps } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { startFakeDaemon, type FakeDaemon, type FakeDaemonOpts } from "../support/fake-daemon.ts";
import { handleLine } from "../../plugin/src/mcp.ts";
import { redact } from "../../plugin/src/redact.ts";

const FIXED_TS = "2026-10-28T12:00:00.000Z";
const T0 = Date.parse(FIXED_TS);
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const WS = "ws";
const SELF = "build";
const SESSION = `${SELF}@${WS}`;
const FOOTER = "\u21a9 Reply: rig send x \"...\""; // the visible footer char, escaped

// ---- writer fixtures (same shape as tests/unit/writer-outbox.test.ts) ----

const mkW = async (daemonOpts: FakeDaemonOpts | "none" = "none", configOver: Partial<Config> = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("rv022w-");
  let daemon: FakeDaemon | undefined;
  const daemonUrl = daemonOpts === "none" ? undefined : (daemon = await startFakeDaemon(daemonOpts)).url;
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
    ...(daemonUrl !== undefined ? { daemonUrl } : {}),
    sessionName: SESSION,
    ...configOver,
  };
  const deps: WriterDeps = { client, now: () => FIXED_TS };
  const cleanup = () => {
    daemon?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { fake, dir, config, deps, cleanup };
};

const dm = (from: string, body: string) =>
  `From: ${from}@${WS}\nTo: ${SELF}@${WS}\n---\n${body}\n---\n${FOOTER}`;

// A real daemon nudge arrives From: daemon@<this rig> with the qitem body.
const nudge = (qid: string) =>
  `From: daemon@${WS}\nTo: ${SELF}@${WS}\n---\nQueue handoff: ${qid} - check your queue.\n---\n${FOOTER}`;

const allMsgs = (fake: FakeHoncho): Array<Record<string, unknown>> =>
  [...fake.state.messages.values()].flat();
const msgOf = (fake: FakeHoncho, needle: string): Record<string, unknown> => {
  const m = allMsgs(fake).find((x) => typeof x.content === "string" && x.content.includes(needle));
  if (m === undefined) throw new Error(`no stored message containing "${needle}"`);
  return m;
};
const metaOf = (fake: FakeHoncho, needle: string): Record<string, unknown> =>
  msgOf(fake, needle).metadata as Record<string, unknown>;

// ---- search fixtures (same shape as tests/unit/mcp-search.test.ts) ----

const NOW = "2026-11-01T12:00:00.000Z";
const mkS = async (over: { timeoutMs?: number } = {}) => {
  const fake: FakeHoncho = await startFakeHoncho();
  const dir = makeTempDir("rv022s-");
  const timeoutMs = over.timeoutMs ?? 2000;
  const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs });
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
    timeoutMs,
  };
  const deps = { config, client, now: () => NOW };
  const call = async (args: Record<string, unknown>): Promise<Record<string, any>> => {
    const line = await handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: args } }),
      deps,
    );
    expect(line).not.toBeNull();
    return JSON.parse(line as string) as Record<string, any>;
  };
  const textOf = (r: Record<string, any>): string => String(r.result.content[0].text);
  const logLines = (): Record<string, unknown>[] => {
    const file = join(dir, "log", `${WS}.log`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return { fake, dir, client, call, textOf, logLines, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ===========================================================================
describe("VF1 nudge override: who may move the sender (ADR-0012 d3)", () => {
  test(
    "VF1 FINDING: a peer TYPING a nudge-shaped body must keep its own sender (wrong-sender invariant)",
    async () => {
      // The daemon's own nudges arrive From: daemon@<rig> (outbox
      // wake-intent entries, daemon.ts header). But the override in
      // writer.ts keys ONLY on the body regex - nothing checks that this
      // prompt's own From says daemon. A same-rig peer that types (or
      // forwards/quotes) the exact nudge text with a live qitem id gets its
      // message re-attributed to the item's sourceSession. Expected-safe
      // assertion below; it fails while the gate is body-only.
      const body = "Queue handoff: qitem-live-1 - check your queue. (heads-up, saw this cross the wire)";
      const prompt = dm("dev-x", body);
      const t = await mkW({ item: { sourceSession: "design-architect@ws", tags: [] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        expect(out.action !== "skipped" && out.peer).toBe("dev-x"); // NOT design-architect
        expect(msgOf(t.fake, "qitem-live-1").peer_id).toBe("dev-x");
      } finally {
        t.cleanup();
      }
    },
  );

  test(
    "VF1b FINDING: an item whose sourceSession is ANOTHER rig must not pull a foreign peer into this rig's memory",
    async () => {
      // cls.kind === "peer" with sameRig:false also replaces eff.peer
      // (writer.ts:583). ADR-0011 d3 exists because this rig's conclusions
      // about foreign-rig peers were thin and wrong in the pilot - a queue
      // item must not smuggle one in as a stored sender. Safe assertion:
      // the stored sender stays the local daemon, never a *_other-rig peer.
      const prompt = nudge("qitem-cross-1");
      const t = await mkW({ item: { sourceSession: "worker@other-rig", tags: [] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        const peer = String(msgOf(t.fake, "qitem-cross-1").peer_id);
        expect(peer).not.toContain("other-rig");
      } finally {
        t.cleanup();
      }
    },
  );
});

describe("VF2 mission tags on the fetched item (writer.ts:594-600)", () => {
  test(
    "VF2a OBSERVATION: a secret-shaped mission tag becomes the mission name verbatim (lowered) - no redaction on that path",
    async () => {
      // normalizeMission keeps the tag's characters (lower-cased, charset
      // [a-z0-9_-], 60 cap) - so a token-shaped tag lands as the session
      // name, and session names DO leave the seat. Pinned as CURRENT
      // behaviour for the architect to rule on; flips red if redaction or
      // rejection is added here.
      const secret = "ghp-AbC01234567890abcdefghij"; // fake-secret
      const prompt = nudge("qitem-tag-1");
      const t = await mkW({ item: { sourceSession: "arch-x@ws", tags: [`mission:${secret}`] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        // FLIPPED (review 22:07Z note, T16j ruling): the tag now goes
        // through the mission(id) secret-shape refusal - mission unchanged,
        // the refusal logged as a reason class, the value nowhere.
        expect(readRigMission(t.dir, WS).mission).toBe("general");
        const keys = [...t.fake.state.messages.keys()];
        expect(keys.some((k) => k.includes(secret.toLowerCase()))).toBe(false);
        const logFile = join(t.dir, "log", `${WS}.log`);
        expect(existsSync(logFile)).toBe(true);
        const logText = readFileSync(logFile, "utf8");
        expect(logText).toContain('"event":"refused"');
        expect(logText).toContain('"error_class":"refused"');
        expect(logText.toLowerCase()).not.toContain(secret.toLowerCase());
      } finally {
        t.cleanup();
      }
    },
  );

  test(
    "VF2b an invalid mission tag cannot leave the seat on any mission",
    async () => {
      const prompt = nudge("qitem-tag-2");
      const t = await mkW({ item: { sourceSession: "arch-x@ws", tags: ["mission:***"] } });
      try {
        const out = await recordPrompt({ prompt }, t.config, t.deps);
        expect(out.action).toBe("sent");
        expect(readRigMission(t.dir, WS).mission).toBe("general");
      } finally {
        t.cleanup();
      }
    },
  );
});

describe("VF3-VF5 outbox verify edges (ADR-0012 d2)", () => {
  test("VF3a an entry older than 10 minutes never verifies", async () => {
    const prompt = dm("arch", "stale stamp must read unverified VF3a");
    const t = await mkW({
      outbox: [
        { outboxId: "obx-stale", senderSession: "arch@ws", destinationSession: SESSION, body: prompt, tsDispatched: iso(-11 * 60_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
      expect(metaOf(t.fake, "VF3a").sender_verified).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("VF3b a future stamp never verifies (no clock-skew grace)", async () => {
    const prompt = dm("arch", "future stamp must read unverified VF3b");
    const t = await mkW({
      outbox: [
        { outboxId: "obx-future", senderSession: "arch@ws", destinationSession: SESSION, body: prompt, tsDispatched: iso(+120_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
    } finally {
      t.cleanup();
    }
  });

  test("VF3c the trailing newline on the HOOK side (outbox body exact) still verifies", async () => {
    const body = dm("arch", "hook-side newline must still match VF3c");
    const t = await mkW({
      outbox: [
        { outboxId: "obx-nl", senderSession: "arch@ws", destinationSession: SESSION, body, tsDispatched: iso(-5_000) },
      ] });
    try {
      const out = await recordPrompt({ prompt: `${body}\n` }, t.config, t.deps);
      expect(out.action !== "skipped" && out.verify).toBe("verified");
      expect(metaOf(t.fake, "VF3c").outbox_id).toBe("obx-nl");
    } finally {
      t.cleanup();
    }
  });

  test("VF4 the verify pass changes nothing: same content, same sender, with match, miss, and no daemon", async () => {
    const needle = "content must be byte-equal across all three VF4";
    const prompt = dm("arch", needle);
    const run1 = await mkW({
      outbox: [
        { outboxId: "obx-v4", senderSession: "arch@ws", destinationSession: SESSION, body: prompt, tsDispatched: iso(-5_000) },
      ] });
    const run2 = await mkW({ outbox: [] });
    const run3 = await mkW("none");
    try {
      const o1 = await recordPrompt({ prompt }, run1.config, run1.deps);
      const o2 = await recordPrompt({ prompt }, run2.config, run2.deps);
      const o3 = await recordPrompt({ prompt }, run3.config, run3.deps);
      expect([o1.action, o2.action, o3.action]).toEqual(["sent", "sent", "sent"]);
      const c1 = String(msgOf(run1.fake, needle).content);
      const c2 = String(msgOf(run2.fake, needle).content);
      const c3 = String(msgOf(run3.fake, needle).content);
      expect(c1).toBe(c2);
      expect(c2).toBe(c3);
      const p1 = String(msgOf(run1.fake, needle).peer_id);
      const p2 = String(msgOf(run2.fake, needle).peer_id);
      const p3 = String(msgOf(run3.fake, needle).peer_id);
      expect([p1, p2, p3]).toEqual(["arch", "arch", "arch"]);
      expect(allMsgs(run1.fake).length).toBe(allMsgs(run2.fake).length);
      expect(allMsgs(run2.fake).length).toBe(allMsgs(run3.fake).length);
      expect(o1.action !== "skipped" && o1.verify).toBe("verified");
      expect(o2.action !== "skipped" && o2.verify).toBe("unverified");
      expect("verify" in (o3 as Record<string, unknown>)).toBe(false);
    } finally {
      run1.cleanup();
      run2.cleanup();
      run3.cleanup();
    }
  });

  test("VF5 nudge + verify: two serial daemon fetches stay inside their budgets and still write", async () => {
    // Both daemon calls (item fetch + outbox fetch) run serially on the same
    // prompt, each with its own 1 s budget. The writer is async (never the
    // turn), but the brief asks whether the check can delay the write past
    // budget - the serial worst case must stay ~2 s, not unbounded.
    // Case A: replies at 900 ms each - both succeed, honest unverified
    // (empty outbox), ~1.8 s total. Case B: replies at 1500 ms - both abort
    // at 1 s, unchecked, ~2 s total.
    const prompt = nudge("qitem-slow-1");
    const a = await mkW({ item: { sourceSession: "arch-x@ws", tags: [] }, outbox: [], delayMs: 900 });
    try {
      const t0 = Date.now();
      const out = await recordPrompt({ prompt }, a.config, a.deps);
      const elapsed = Date.now() - t0;
      expect(out.action).toBe("sent");
      expect(out.action !== "skipped" && out.verify).toBe("unverified");
      expect(elapsed).toBeGreaterThanOrEqual(1600); // both 900 ms replies paid
      expect(elapsed).toBeLessThan(2600);
    } finally {
      a.cleanup();
    }
    const b = await mkW({ item: { sourceSession: "arch-x@ws", tags: [] }, outbox: [], delayMs: 1500 });
    try {
      const t0 = Date.now();
      const out = await recordPrompt({ prompt }, b.config, b.deps);
      const elapsed = Date.now() - t0;
      expect(out.action).toBe("sent");
      expect(out.action !== "skipped" && out.verify).toBe("unchecked"); // aborted at budget
      expect(elapsed).toBeGreaterThanOrEqual(1800); // two 1 s aborts
      expect(elapsed).toBeLessThan(2800); // and nothing beyond them
    } finally {
      b.cleanup();
    }
  });
});

describe("VD search tool gaps (redact-before-send, odd about, wall matrix)", () => {
  test("VD1 FINDING if redaction slips: a secret in query/about never reaches the server", async () => {
    // mcp.ts:237-239 redacts query and about BEFORE the requests. The build
    // pins display redaction; the wire side is pinned here: the recorded
    // fake-server request bodies must not carry the raw marked values.
    const h = await mkS();
    try {
      const query = "why API_TOKEN=AbC01234567890xyz rotate"; // fake-secret
      const about = "see sk-ant-FAKEfake123456789012"; // fake-secret
      const r = await h.call({ query, about });
      expect(h.textOf(r)).toBeDefined();
      const wire = h.fake.requests
        .filter((q) => q.path.includes("conclusions/query") || q.path.endsWith("/search"))
        .map((q) => JSON.stringify(q.body));
      expect(wire.length).toBeGreaterThan(0);
      for (const body of wire) {
        expect(body).not.toContain("AbC01234567890xyz");
        expect(body).not.toContain("FAKEfake123456789012");
      }
      const qb = wire.filter((b) => b.includes("[REDACTED"));
      expect(qb.length).toBe(wire.length); // every call went out redacted
    } finally {
      await h.fake.stop();
      h.cleanup();
    }
  });

  test("VD2 odd about: whitespace-only means no-about; an arbitrary string is just a filter value", async () => {
    const h = await mkS();
    try {
      await h.call({ query: "vd2a", about: "   " });
      const blank = h.fake.requests
        .filter((q) => q.path.includes("conclusions/query"))
        .map((q) => JSON.stringify((q.body as Record<string, any>).filters))
        .sort();
      expect(blank).toEqual(
        [
          JSON.stringify({ observer: SELF, observed: SELF }),
          JSON.stringify({ observer: "scope.general", observed: SELF }),
        ].sort(),
      );
      h.fake.requests.length = 0;
      const r = await h.call({ query: "vd2b", about: "scope.admin" });
      expect(r.result.isError).toBeUndefined();
      const obs = h.fake.requests
        .filter((q) => q.path.includes("conclusions/query"))
        .map((q) => JSON.stringify((q.body as Record<string, any>).filters));
      expect(obs).toContain(JSON.stringify({ observer: "scope.general", observed: "scope.admin" }));
      expect(obs).toContain(JSON.stringify({ observer: SELF, observed: "scope.admin" }));
    } finally {
      await h.fake.stop();
      h.cleanup();
    }
  });

  test("VD3 every call slow: the 3 s wall answers 'search timed out: nothing returned', not an empty success", async () => {
    // The build pins the all-500 error text ("search failed: ..."); the
    // timeout branch (nothing settled by the wall) is pinned here. Client
    // timeout is raised above the wall so the jobs are still in flight when
    // it fires - that is the only way to reach wallHit.
    const h = await mkS({ timeoutMs: 9000 });
    try {
      h.fake.mode("slow", { delayMs: 3400 });
      const t0 = Date.now();
      const r = await h.call({ query: "vd3" });
      const elapsed = Date.now() - t0;
      expect(r.result.isError).toBe(true);
      expect(h.textOf(r)).toContain("search timed out: nothing returned");
      expect(elapsed).toBeGreaterThanOrEqual(2800); // it waited to the wall
      expect(elapsed).toBeLessThan(5000); // and not to the client timeout
    } finally {
      await h.fake.stop();
      h.cleanup();
    }
  });

  test("VD4 slow conclusions pairs, fast messages: Messages renders and the note counts 1 of 3", async () => {
    // The build's wall test slowed the MESSAGE call; the pair-slow cell of
    // the matrix (both conclusions pairs unfinished, messages finished) is
    // pinned here: render what finished + "(search incomplete: 1 of 3 ...)"
    // + logExtra partial 2.
    const h = await mkS({ timeoutMs: 9000 });
    try {
      await h.client.addMessages("s1", [{ peer_id: "review", content: "vd4 the rate limiter was the flaky one" }]);
      h.fake.slowPattern("conclusions/query", 3400);
      const r = await h.call({ query: "vd4" });
      const text = h.textOf(r);
      expect(r.result.isError).toBeUndefined();
      expect(text).toContain("Messages:");
      expect(text).toContain("vd4 the rate limiter was the flaky one");
      expect(text).toContain("(search incomplete: 1 of 3 calls returned)");
      const ev = h.logLines().find((l) => l.event === "tool:search");
      expect(ev?.partial).toBe(2);
      expect(ev?.n_msgs).toBe(1);
    } finally {
      await h.fake.stop();
      h.cleanup();
    }
  });
});

describe("VU install loop on a v0.2.1-shape layout (release README 'nothing should change')", () => {
  test(
    "VU install -> second run changes no byte -> uninstall returns the tree byte-for-byte",
    async () => {
      // v0.2.1 project installs carry exactly the hooks/env/server shape the
      // current installer emits (README: "the hooks and settings are the
      // same as v0.2.1"), so the upgrade ceremony on such a layout IS this
      // loop. Foreign content must survive untouched at every step.
      const REPO = new URL("../..", import.meta.url).pathname;
      const BIN = join(REPO, "plugin/bin/install-project.ts");
      const dir = makeTempDir("rv022u-");
      try {
        mkdirSync(join(dir, ".claude"), { recursive: true });
        const foreign = {
          env: { CLAUDE_NOTES_MODE: "fake-secret-off" },
          permissions: { deny: ["Read(./.env)"] },
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
            UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo foreign-prompt" }] }] },
          enabledMcpjsonServers: ["other_server"] };
        const foreignMcp = { mcpServers: { other_server: { command: "echo", args: ["other"] } } };
        writeFileSync(join(dir, ".claude/settings.local.json"), `${JSON.stringify(foreign, null, 2)}\n`);
        writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify(foreignMcp, null, 2)}\n`);
        const settingsPath = join(dir, ".claude/settings.local.json");
        const mcpPath = join(dir, ".mcp.json");
        const beforeS = readFileSync(settingsPath);
        const beforeM = readFileSync(mcpPath);
        const flags = ["--url", "http://10.9.9.9/v3", "--workspace", "honcho-bridge-scratch-review022"];
        const run = async (): Promise<number> => {
          const p = Bun.spawn([process.execPath, BIN, dir, ...flags], { stdout: "pipe", stderr: "pipe" });
          await p.exited;
          return p.exitCode ?? -1;
        };
        expect(await run()).toBe(0);
        const firstS = readFileSync(settingsPath);
        const firstM = readFileSync(mcpPath);
        expect(firstS.equals(beforeS)).toBe(false); // the install really did something
        expect(await run()).toBe(0); // the README's re-run ceremony
        expect(readFileSync(settingsPath).equals(firstS)).toBe(true);
        expect(readFileSync(mcpPath).equals(firstM)).toBe(true);
        // The bin's usage line pins the bare form: `... <dir> --uninstall`
        // takes no value flags (it refuses with exit 1 if you bring them).
        const un = Bun.spawn([process.execPath, BIN, dir, "--uninstall"], { stdout: "pipe", stderr: "pipe" });
        await un.exited;
        expect(un.exitCode).toBe(0);
        // Exact uninstall = our names all gone, foreign content intact. The
        // 19:18Z ruling keeps container keys we created (the empty hooks
        // event "Stop" stays) - pinned by install-project.test.ts, so the
        // settings comparison here is against foreign + that empty
        // container; .mcp.json has no such addition and must be byte-exact.
        expect(readFileSync(mcpPath).equals(beforeM)).toBe(true);
        const after = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(after.env.CLAUDE_NOTES_MODE).toBe("fake-secret-off");
        expect(Object.keys(after.env).filter((k) => k.startsWith("HONCHO_"))).toEqual([]);
        expect(after.enabledMcpjsonServers).toEqual(["other_server"]);
        expect(after.hooks.SessionStart).toEqual(foreign.hooks.SessionStart);
        expect(after.hooks.UserPromptSubmit).toEqual(foreign.hooks.UserPromptSubmit);
        expect(after.hooks.Stop).toEqual([]);
        expect(after.permissions).toEqual(foreign.permissions);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("VC device-code redaction edges (redact.ts rule 10)", () => {
  test("VC1 masks: mixed run near devicelogin; all-letters glued after the word code", () => {
    const a = redact("sign in at https://microsoft.com/devicelogin and enter ABCDE1FG now");
    expect(a.counts["device-code"]).toBe(1);
    expect(a.text).toContain("[REDACTED:device-code]");
    expect(a.text).toContain("devicelogin"); // words stay, code only masked
    expect(a.text).not.toContain("ABCDE1FG");
    const b = redact("the device code GHJKLMNP expired before I used it");
    expect(b.counts["device-code"]).toBe(1);
    expect(b.text).not.toContain("GHJKLMNP");
  });

  test("VC2 does NOT mask: far from context; all digits; 10-char runs; lowercase; 40-char SHA", () => {
    const far = `devicelogin ${"x".repeat(250)} ABCDE1FG done`;
    const r1 = redact(far);
    expect(r1.counts["device-code"]).toBeUndefined();
    expect(r1.text).toContain("ABCDE1FG");
    const r2 = redact("devicelogin says code 12345678 but all-digits is not the shape");
    expect(r2.counts["device-code"]).toBeUndefined();
    expect(r2.text).toContain("12345678");
    const r3 = redact("devicelogin shows A10B9C8D7E which is ten chars (SHA territory)");
    expect(r3.counts["device-code"]).toBeUndefined();
    const sha = "a".repeat(40);
    const r4 = redact(`devicelogin docs, commit ${sha} shipped`);
    expect(r4.counts["device-code"]).toBeUndefined();
    expect(r4.counts["hex64"]).toBeUndefined(); // 40 < 64
    expect(r4.text).toContain(sha);
  });

  test(
    "VC3 OBSERVATION (flips red if the ruling tightens the rule): dashed, newline-split and lowercase codes survive raw near devicelogin",
    () => {
      // Real device sign-in codes ship 8 upper-case chars commonly DISPLAYED
      // with a dash (AAAA-BBBB); a user who pastes that exact display, or
      // whose run wrapped across a newline, or who typed the
      // case-insensitive code in lower case, gets NO mask. Pinned as
      // current behaviour for the architect to weigh.
      // FLIPPED (review 22:07Z note, T16j ruling): the dashed 4-4 form
      // near device-login words now masks. Lowercase and newline-split
      // lines below stay as written (unmasked).
      const dashed = redact("devicelogin told me to enter the code ABCD-1234 at the prompt");
      expect(dashed.counts["device-code"]).toBe(1);
      expect(dashed.text).toContain("[REDACTED:device-code]");
      expect(dashed.text).not.toContain("ABCD-1234");
      const split = redact("devicelogin said enter ABCD\n1234 at the prompt");
      expect(split.counts["device-code"]).toBeUndefined();
      const lower = redact("devicelogin code abcde1fg - pasted as typed");
      expect(lower.counts["device-code"]).toBeUndefined();
      expect(lower.text).toContain("abcde1fg");
    },
  );
});
