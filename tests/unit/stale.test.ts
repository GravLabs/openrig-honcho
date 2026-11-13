// V4 (ADR-0019 decision 4): stale proposals. Checks (a)-(f) from the row
// brief, all against a FAKE OpenAI-compatible server and the fake Honcho -
// never a real model, never the real server. (a) a rule-classified entry is
// never proposed; (b) ids not in force or not older are dropped; (c) the key
// comes only from the named env var, unset refuses, the key never reaches
// output or state; (d) the leader digest shows the retire call, a non-leader
// does not; (e) gone after 3 showings or once the old entry is retired;
// (f) a rerun reclassifies and rechecks nothing new.
// Ledger entry ids here are d- + 8 HEX (the grammar parseEntry enforces).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../plugin/src/env.ts";
import { createClient, type Conclusion } from "../../plugin/src/honcho.ts";
import { buildInjection, type ReaderDeps } from "../../plugin/src/reader.ts";
import { LEDGER_PEER, formatEntry, formatRetire } from "../../plugin/src/ledger.ts";
import {
  readStaleState,
  runStaleCheck,
  staleStatePath,
  takeStaleForDigest,
  writeStaleState,
  type ModelTarget,
  type StaleState,
} from "../../plugin/src/stale.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { makeTempDir } from "../support/tempdir.ts";

const WS = "ws";
const SELF = "build";
const SESSION = "build@testrig";
const NOW = "2026-11-04T12:00:00.000Z";
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

// marker words keep prompt-dispatch in the fake model unambiguous
const O1 = "d-aaaa0001"; // in force, state, old
const O2 = "d-aaaa0002"; // old but RETIRED
const R1 = "d-aaaa0003"; // a standing rule (classified "rule")
const N1 = "d-aaaa0004"; // the new entry (this is what gets checked)
const N2 = "d-aaaa0005"; // newer than N1 (so not a candidate FOR N1)
const NEW = "d-aaaa0006"; // arrives only in the rerun test

const ent = (id: string, kind: "decision" | "approval" | "status", fact: string): string =>
  formatEntry({ kind, id, scope: "mission", fact });

const concl = (id: string, content: string, atMs: number): Conclusion => ({
  id: `concl-${id}`,
  content,
  observer_id: "lead",
  observed_id: LEDGER_PEER,
  created_at: ago(atMs),
});

// O1/O2 are DECISIONS: a newer status supersedes an older one (the V3 ledger
// rule), so a status candidate would not be in force once N1's status lands.
const baseItems = (): Conclusion[] => [
  concl(R1, ent(R1, "decision", "charlie: never bump the version aggressively"), 6 * HOUR),
  concl(O1, ent(O1, "decision", "alfa: ship v1 from tag a1b2c3"), 5 * HOUR),
  concl(O2, ent(O2, "decision", "bravo: hold the migration for review"), 4 * HOUR),
  concl(N1, ent(N1, "status", "delta: main moved to v2"), 1 * HOUR),
];

const mkConfig = (stateDir: string, over: Partial<Config> = {}): Config => ({
  enabled: true,
  url: "http://127.0.0.1:9/v3",
  workspace: WS,
  peer: SELF,
  observeOthers: false,
  ownerPeer: "owner",
  profileWorkspace: null,
  recordAutomation: true,
  apiKey: "k",
  stateDir,
  timeoutMs: 2000,
  digest: true,
  leaderPeer: SELF,
  sessionName: SESSION,
  ...over,
});

// ---------------------------------------------------------------------------
// fake OpenAI-compatible server: one route answers every request. Bodies are
// recorded so a test can pin the wire shape and the Authorization header.

interface FakeModel {
  url: string; // includes /v1, exactly as the flag takes it
  bodies: Record<string, unknown>[];
  auths: (string | null)[];
  prompts(): string[];
  stop(): void;
}

async function startFakeModel(reply: (prompt: string) => unknown): Promise<FakeModel> {
  const bodies: Record<string, unknown>[] = [];
  const auths: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      auths.push(req.headers.get("authorization"));
      const msgs = body.messages as { content?: unknown }[] | undefined;
      const prompt = typeof msgs?.[0]?.content === "string" ? (msgs[0].content as string) : "";
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply(prompt)) } }] });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    bodies,
    auths,
    prompts: () =>
      bodies.map((b) => {
        const m = (b.messages as { content: string }[])[0];
        return m.content;
      }),
    stop: () => server.stop(true),
  };
}

// the default script: R1 is the rule; N1 (delta) proposes everything it can,
// and the accept-side filters are what the checks pin.
const scriptReply = (p: string): unknown => {
  if (p.includes("Classify one entry")) return { class: p.includes(R1) ? "rule" : "state" };
  if (p.includes("delta") && p.includes("NEW entry"))
    return {
      stale: [
        { id: R1, why: "the version rule changed" },
        { id: O1, why: "the status was replaced" },
      ],
    };
  return { stale: [] };
};

const target = (url: string, key = "test-key-never-shown"): ModelTarget => ({ // fake-secret
  url,
  model: "fake-model",
  key,
  timeoutMs: 5000,
});

describe("V4 stale-check: runStaleCheck against a fake model", () => {
  test("(a) a rule-classified entry is never proposed, wire shape pinned", async () => {
    const dir = makeTempDir("stale-a-");
    const model = await startFakeModel(scriptReply);
    try {
      const cfg = mkConfig(dir);
      const r = await runStaleCheck(cfg, target(model.url), baseItems());
      expect(r.error).toBeUndefined();
      expect(r.classified).toBe(4); // R1, O1, O2, N1
      expect(r.added).toBe(1); // O1 only - R1 came back in the model answer but is a rule
      const st = readStaleState(dir, WS);
      expect(st).not.toBeNull();
      expect(st!.classes[R1]).toBe("rule");
      expect(st!.classes[O1]).toBe("state");
      expect(st!.classes[N1]).toBe("state");
      expect(st!.proposals.map((p) => p.oldId)).toEqual([O1]);
      expect(st!.proposals[0].newId).toBe(N1);
      // the PROMPT body's EARLIER section carries O1 but never R1
      const promptBody = model.prompts().find((p) => p.includes("You maintain a team"));
      expect(promptBody).toBeDefined();
      expect(promptBody).toContain(O1);
      expect(promptBody).not.toContain(R1);
      // one request at a time, temperature 0, json_object, thinking off
      // 4 classify + 2 prompt: on a first run EVERY entry is "newer than the
      // last run", and O2 (4h ago) has O1 (5h ago) as an older state candidate.
      expect(model.bodies.length).toBe(6);
      for (const b of model.bodies) {
        expect(b.temperature).toBe(0);
        expect(b.response_format).toEqual({ type: "json_object" });
        expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
      }
    } finally {
      model.stop();
    }
  });

  test("(b) only ids really in force AND older are accepted", async () => {
    const dir = makeTempDir("stale-b-");
    const items = [
      ...baseItems(),
      concl(`ret-${O2}`, formatRetire(O2, "obsolete"), 3 * HOUR),
      concl(N2, ent(N2, "status", "echo: newest entry"), 30 * 60_000),
    ];
    const reply = (p: string): unknown => {
      if (p.includes("Classify one entry")) return { class: p.includes(R1) ? "rule" : "state" };
      if (p.includes("delta")) return { stale: [{ id: O1 }, { id: O2 }, { id: N2 }] };
      return { stale: [] };
    };
    const model = await startFakeModel(reply);
    try {
      const r = await runStaleCheck(mkConfig(dir), target(model.url), items);
      expect(r.added).toBe(1);
      const st = readStaleState(dir, WS)!;
      expect(st.proposals.map((p) => p.oldId)).toEqual([O1]); // O2 retired, N2 not older
    } finally {
      model.stop();
    }
  });

  test("(f) rerun: zero calls; one new entry: only it is classified and checked", async () => {
    const dir = makeTempDir("stale-f-");
    const model = await startFakeModel(scriptReply);
    try {
      const cfg = mkConfig(dir);
      await runStaleCheck(cfg, target(model.url), baseItems());
      const n0 = model.bodies.length;
      const r2 = await runStaleCheck(cfg, target(model.url), baseItems());
      expect(r2.classified).toBe(0);
      expect(r2.checked).toBe(0);
      expect(model.bodies.length).toBe(n0); // no reclassify, no recheck
      const r3 = await runStaleCheck(cfg, target(model.url), [
        ...baseItems(),
        concl(NEW, ent(NEW, "status", "foxtrot: latest release shipped"), 10 * 60_000),
      ]);
      expect(r3.classified).toBe(1);
      expect(r3.checked).toBe(1);
      const fresh = model.prompts().slice(n0);
      expect(fresh.filter((p) => p.includes("Classify one entry")).length).toBe(1);
      expect(fresh.filter((p) => p.includes("Classify one entry"))[0]).toContain("foxtrot");
      const pf = fresh.find((p) => p.includes("You maintain a team"));
      expect(pf).toContain("foxtrot");
      expect(pf).toContain(O1); // older state candidates offered
      expect(pf).not.toContain(R1); // rule excluded
    } finally {
      model.stop();
    }
  });
});

describe("V4 stale-check: the bin and the digest", () => {
  const BIN = join(import.meta.dir, "..", "..", "plugin", "bin", "stale-check.ts");
  const KEY = "not-a-secret-stale-key"; // fake-secret

  const runBin = async (
    env: Record<string, string>,
    args: string[],
  ): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  };

  test("(c) the key comes only from the named env var; unset refuses; it never leaks", async () => {
    const fake: FakeHoncho = await startFakeHoncho();
    const model = await startFakeModel(scriptReply);
    const dir = makeTempDir("stale-c-");
    try {
      fake.addConclusion(WS, {
        content: ent(O1, "decision", "alfa: ship v1 from tag a1b2c3"),
        observer_id: SELF,
        observed_id: LEDGER_PEER,
        created_at: ago(5 * HOUR),
      });
      fake.addConclusion(WS, {
        content: ent(N1, "status", "delta: main moved to v2"),
        observer_id: SELF,
        observed_id: LEDGER_PEER,
        created_at: ago(1 * HOUR),
      });
      const base: Record<string, string> = {
        HOME: dir,
        HONCHO_STATE_DIR: dir,
        HONCHO_URL: fake.url,
        HONCHO_WORKSPACE: WS,
        HONCHO_PEER: SELF,
        HONCHO_LEADER_PEER: SELF,
        HONCHO_API_KEY: "k",
      };
      const args = ["--url", model.url, "--model", "fake-model", "--key-env", "STALE_TEST_KEY"];
      // unset -> refuse, naming ONLY the variable
      const off = await runBin(base, args);
      expect(off.code).toBe(1);
      expect(off.err).toContain("STALE_TEST_KEY");
      expect(model.bodies.length).toBe(0);
      // set -> run, counts only, the key reaches the model but nothing else
      const on = await runBin({ ...base, STALE_TEST_KEY: KEY }, args);
      expect(on.code).toBe(0);
      expect(on.out).toMatch(
        /entries classified: \d+ \| entries checked: \d+ \| proposals added: \d+ \| model seconds: [\d.]+/,
      );
      expect(on.out).not.toContain(KEY);
      expect(on.err).not.toContain(KEY);
      expect(model.auths).toContain(`Bearer ${KEY}`);
      const stateText = readFileSync(staleStatePath(dir, WS), "utf8");
      expect(stateText).not.toContain(KEY);
      expect(JSON.parse(stateText).proposals.map((p: { oldId: string }) => p.oldId)).toEqual([O1]);
    } finally {
      model.stop();
      await fake.stop();
    }
  });

  // digest-side fixtures share one leader setup
  const leaderSetup = async (): Promise<{
    fake: FakeHoncho;
    dir: string;
    config: Config;
    deps: ReaderDeps;
  }> => {
    const fake = await startFakeHoncho();
    const dir = makeTempDir("stale-d-");
    const client = createClient({ url: fake.url, workspace: WS, apiKey: "k", timeoutMs: 2000 });
    const config = mkConfig(dir, { url: fake.url });
    fake.addConclusion(WS, {
      content: ent(O1, "status", "alfa: main is at v1"),
      observer_id: SELF,
      observed_id: LEDGER_PEER,
      session_id: "lead--m1--1",
      created_at: ago(4 * HOUR),
    });
    const st: StaleState = {
      version: 1,
      classes: { [O1]: "state", [N1]: "state" },
      lastCheckedAt: ago(1 * HOUR),
      proposals: [
        { oldId: O1, newId: N1, why: "a newer status replaced it", oldAt: ago(4 * HOUR), at: ago(1 * HOUR), shown: 0 },
      ],
    };
    writeStaleState(dir, WS, st);
    return { fake, dir, config, deps: { client, now: () => NOW } };
  };

  test("(d) the leader digest shows the retire call; a non-leader digest does not", async () => {
    const { fake, dir, config, deps } = await leaderSetup();
    try {
      const out = await buildInjection({ source: "startup", claudeSessionId: "claude-2" }, config, deps);
      expect(out).toContain("Possibly stale");
      expect(out).toContain(`retire(${O1})`);
      expect(out).toContain("[derived]");
      expect(readStaleState(dir, WS)!.proposals[0].shown).toBe(1); // persisted
      // same state, non-leader seat: nothing shown, no count burned
      const out2 = await buildInjection(
        { source: "startup", claudeSessionId: "claude-3" },
        { ...config, leaderPeer: "boss" },
        deps,
      );
      expect(out2).not.toContain("Possibly stale");
      expect(readStaleState(dir, WS)!.proposals[0].shown).toBe(1);
    } finally {
      await fake.stop();
    }
  });

  test("(e1) after 3 showings the proposal is gone from the digest", async () => {
    const { fake, dir, config, deps } = await leaderSetup();
    try {
      // showing 1
      await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, deps);
      // showings 2 and 3
      for (const cid of ["c2", "c3"]) {
        const out = await buildInjection({ source: "resume", claudeSessionId: cid }, config, deps);
        expect(out).toContain("Possibly stale");
      }
      expect(readStaleState(dir, WS)!.proposals[0].shown).toBe(3);
      // 4th start: gone, and no extra ledger read for it
      const out = await buildInjection({ source: "startup", claudeSessionId: "c4" }, config, deps);
      expect(out).not.toContain("Possibly stale");
    } finally {
      await fake.stop();
    }
  });

  test("(e2) once the old entry is retired the proposal drops out", async () => {
    const { fake, dir, config, deps } = await leaderSetup();
    try {
      fake.addConclusion(WS, {
        content: formatRetire(O1, "replaced by the v2 status"),
        observer_id: SELF,
        observed_id: LEDGER_PEER,
        session_id: "lead--m1--1",
        created_at: ago(30 * 60_000),
      });
      const out = await buildInjection({ source: "startup", claudeSessionId: "c1" }, config, deps);
      expect(out).not.toContain("Possibly stale");
      expect(readStaleState(dir, WS)!.proposals.length).toBe(0); // dropped and persisted
    } finally {
      await fake.stop();
    }
  });

  test("takeStaleForDigest: max 2, newest first, shown++ only for picked", () => {
    const st: StaleState = {
      version: 1,
      classes: {},
      lastCheckedAt: null,
      proposals: [
        { oldId: "d-00000001", newId: "d-0000000a", why: "a", oldAt: ago(9 * HOUR), at: ago(3 * HOUR), shown: 0 },
        { oldId: "d-00000002", newId: "d-0000000a", why: "b", oldAt: ago(9 * HOUR), at: ago(2 * HOUR), shown: 0 },
        { oldId: "d-00000003", newId: "d-0000000a", why: "c", oldAt: ago(9 * HOUR), at: ago(1 * HOUR), shown: 0 },
        { oldId: "d-00000004", newId: "d-0000000a", why: "gone", oldAt: ago(9 * HOUR), at: ago(4 * HOUR), shown: 0 },
      ],
    };
    const inForce = new Set(["d-00000001", "d-00000002", "d-00000003"]); // 4 retired
    const picked = takeStaleForDigest(st, inForce, 2);
    expect(picked.shown.map((p) => p.oldId)).toEqual(["d-00000003", "d-00000002"]); // newest first
    expect(picked.dirty).toBe(true);
    expect(st.proposals.find((p) => p.oldId === "d-00000004")).toBeUndefined(); // retired dropped
    expect(st.proposals.find((p) => p.oldId === "d-00000001")!.shown).toBe(0); // not picked
    expect(st.proposals.find((p) => p.oldId === "d-00000002")!.shown).toBe(1);
  });
});
