// T8b (E11): the queue-nudge mission hint. Everything runs with an injected
// `run` - no unit test may spawn a real rig. Covers the brief's item 3:
// nudge parsing (valid, with Summary, wrong prefix, shell characters,
// over-long id), tag lookup (mission tag, no tag, exit 1, timeout, bad JSON),
// and the writer path (general + tagged nudge -> message lands in the mission
// session and mission.json says set_by "queue"; mission already set ->
// unchanged and no subprocess at all).

import { describe, expect, test } from "bun:test";
import { makeTempDir } from "../support/tempdir.ts";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readRigMission, setRigMission } from "../../plugin/src/missions.ts";
import { applyQueueMissionHint, missionFromQitem, qitemIdFromNudge } from "../../plugin/src/nudge.ts";
import { recordPrompt, type WriterDeps } from "../../plugin/src/writer.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";

const WS = "ws";
const SELF = "build";
const QID = "qitem-20261028183410-09900900714af038";
const nudge = (id: string, summary?: string) =>
  `Queue handoff: ${id} - check your queue.${summary !== undefined ? ` Summary: ${summary}` : ""}`;

describe("qitemIdFromNudge (E11 parsing)", () => {
  test("accepts the bare nudge and the nudge with a Summary", () => {
    expect(qitemIdFromNudge(nudge(QID))).toBe(QID);
    expect(qitemIdFromNudge(nudge(QID, "T8b: mission hint from queue nudges (E11)"))).toBe(QID);
  });

  test("rejects wrong prefix, non-anchored text, shell characters, over-long ids", () => {
    expect(qitemIdFromNudge(`please ${nudge(QID)}`)).toBeNull();
    expect(qitemIdFromNudge(`item handoff: ${QID} - check your queue.`)).toBeNull();
    expect(qitemIdFromNudge(nudge("qitem-; rm -rf /"))).toBeNull();
    expect(qitemIdFromNudge(nudge("qitem-$(whoami)"))).toBeNull();
    expect(qitemIdFromNudge(nudge("qitem-back`tick`"))).toBeNull();
    expect(qitemIdFromNudge(nudge(`qitem-${"a".repeat(81)}`))).toBeNull();
    expect(qitemIdFromNudge("a plain prompt")).toBeNull();
    expect(qitemIdFromNudge("")).toBeNull();
  });

  test("accepts an id at the 80-char limit (boundary, not off-by-one)", () => {
    const id = `qitem-${"a".repeat(74)}`; // 6 + 74 = 80
    expect(id.length).toBe(80);
    expect(qitemIdFromNudge(nudge(id))).toBe(id);
  });
});

describe("missionFromQitem (E11 lookup, injected run)", () => {
  const ok = (tags: unknown[]) => async () => ({ code: 0, stdout: JSON.stringify({ tags }) });

  test("mission:<x> tag answers the normalised mission (ADR-0002)", async () => {
    const m = await missionFromQitem(QID, { run: ok(["v0.1", "T8b", "mission:Slice 07!"]) });
    expect(m).toBe("slice-07");
  });

  test("no mission tag, empty tag, non-string tags -> null", async () => {
    expect(await missionFromQitem(QID, { run: ok(["v0.1", "T8b"]) })).toBeNull();
    expect(await missionFromQitem(QID, { run: ok(["mission:"]) })).toBeNull();
    expect(await missionFromQitem(QID, { run: ok([7, null, "mission"] as unknown[]) })).toBeNull();
    expect(await missionFromQitem(QID, { run: async () => ({ code: 0, stdout: "{}" }) })).toBeNull();
  });

  test("non-zero exit -> null", async () => {
    expect(await missionFromQitem(QID, { run: async () => ({ code: 1, stdout: "{}" }) })).toBeNull();
  });

  test("timeout (runner rejects) -> null, never throws", async () => {
    expect(await missionFromQitem(QID, { run: async () => {
      throw Object.assign(new Error("timed out"), { killed: true });
    } })).toBeNull();
  });

  test("bad JSON on stdout -> null", async () => {
    expect(await missionFromQitem(QID, { run: async () => ({ code: 0, stdout: "not json" }) })).toBeNull();
  });

  test("an id that is not the validated grammar is refused without any subprocess", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { code: 0, stdout: JSON.stringify({ tags: ["mission:auth"] }) };
    };
    expect(await missionFromQitem("qitem-; rm -rf /", { run })).toBeNull();
    expect(await missionFromQitem("../../etc/passwd", { run })).toBeNull();
    expect(await missionFromQitem(`qitem-${"a".repeat(81)}`, { run })).toBeNull();
    expect(calls).toBe(0);
  });

  test("the rig call is argv-arrayed with no shell, 3 s budget", async () => {
    const seen: [string, string[], number][] = [];
    await missionFromQitem(QID, {
      run: async (cmd, args, timeoutMs) => {
        seen.push([cmd, args, timeoutMs]);
        return { code: 0, stdout: JSON.stringify({ tags: ["mission:auth"] }) };
      } });
    expect(seen.length).toBe(1);
    const [cmd, args, timeoutMs] = seen[0];
    expect(cmd).toBe("rig");
    expect(args).toEqual(["queue", "show", QID, "--json"]);
    expect(timeoutMs).toBe(3000);
  });
});

describe("applyQueueMissionHint + recordPrompt (E11 writer path)", () => {
  const mk = async (over: Partial<Config> = {}) => {
    const fake: FakeHoncho = await startFakeHoncho();
    const dir = makeTempDir("nudge-test-");
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
    const deps: WriterDeps = { client, now: () => "2026-10-28T12:00:00.000Z" };
    return { fake, dir, config, deps };
  };
  // A handoff nudge is a PEER message (the queue nudge envelope): attribute()
  // must classify it as kind "peer" for the hint to run.
  const handoff = (body: string) =>
    `From: daemon@${WS}\nTo: ${SELF}@${WS}\n---\n${body}\n---\n↩ Reply: rig send x "..."`;
  const tagRun = (tags: unknown[]) =>
    (async () => ({ code: 0, stdout: JSON.stringify({ tags }) })) as WriterDeps["queueHintRun"];

  test("rig mission general + tagged nudge: message lands in the mission session, set_by queue", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      deps.queueHintRun = tagRun(["v0.1", "T8b", "mission:auth"]);
      const out = await recordPrompt({ prompt: handoff(nudge(QID)) }, config, deps);
      expect(out.action === "sent" && out.session).toBe("build--auth--1");
      expect(out.action === "sent" && out.peer).toBe("daemon");
      const rig = readRigMission(dir, WS);
      expect(rig.mission).toBe("auth");
      expect(rig.set_by).toBe("queue");
      // and the nudge message itself is in that mission session
      const msgs = fake.state.messages.get(`${WS}/build--auth--1`) ?? [];
      expect(msgs.length).toBe(1);
      expect(String(msgs[0].content)).toContain("Queue handoff:");
    } finally {
      await fake.stop();
    }
  });

  test("rig mission already set: unchanged, no subprocess, message in its session", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      await setRigMission(dir, WS, "slice-x", "build");
      let calls = 0;
      deps.queueHintRun = (async () => {
        calls += 1;
        return { code: 0, stdout: JSON.stringify({ tags: ["mission:auth"] }) };
      }) as WriterDeps["queueHintRun"];
      const out = await recordPrompt({ prompt: handoff(nudge(QID)) }, config, deps);
      expect(out.action === "sent" && out.session).toBe("build--slice-x--1");
      expect(calls).toBe(0);
      expect(readRigMission(dir, WS).mission).toBe("slice-x");
    } finally {
      await fake.stop();
    }
  });

  test("no mission tag: mission stays general, message in build--general--1", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      deps.queueHintRun = tagRun(["v0.1", "T8b"]);
      const out = await recordPrompt({ prompt: handoff(nudge(QID)) }, config, deps);
      expect(out.action === "sent" && out.session).toBe("build--general--1");
      expect(readRigMission(dir, WS).mission).toBe("general");
    } finally {
      await fake.stop();
    }
  });

  test("hint failure (exit 1, timeout, bad JSON) records the nudge into general", async () => {
    for (const run of [
      (async () => ({ code: 1, stdout: "" })) as WriterDeps["queueHintRun"],
      (async () => {
        throw new Error("timeout");
      }) as WriterDeps["queueHintRun"],
      (async () => ({ code: 0, stdout: "{" })) as WriterDeps["queueHintRun"],
    ]) {
      const { fake, dir, config, deps } = await mk();
      try {
        deps.queueHintRun = run;
        const out = await recordPrompt({ prompt: handoff(nudge(QID)) }, config, deps);
        expect(out.action === "sent" && out.session).toBe("build--general--1");
        expect(readRigMission(dir, WS).mission).toBe("general");
      } finally {
        await fake.stop();
      }
    }
  });

  test("an ordinary owner prompt runs no subprocess and changes nothing", async () => {
    const { fake, dir, config, deps } = await mk();
    try {
      let calls = 0;
      deps.queueHintRun = (async () => {
        calls += 1;
        return { code: 0, stdout: "{}" };
      }) as WriterDeps["queueHintRun"];
      const out = await recordPrompt({ prompt: "owner typed a normal sentence" }, config, deps);
      expect(out.action === "sent" && out.session).toBe("build--general--1");
      expect(calls).toBe(0);
      expect(readRigMission(dir, WS).mission).toBe("general");
    } finally {
      await fake.stop();
    }
  });

  test("applyQueueMissionHint is a silent no-op when the runner is absent and rig is unreachable", async () => {
    const { config } = await mk();
    // default run -> real execFile; PATH is emptied so `rig` cannot be found
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      await expect(applyQueueMissionHint(nudge(QID), config, {})).resolves.toBeUndefined();
    } finally {
      process.env.PATH = saved;
    }
  });
});
