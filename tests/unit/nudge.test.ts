// T8b (E11): the queue-nudge mission hint. Everything runs with an injected
// `run` - no unit test may spawn a real rig. Covers the brief's item 3:
// nudge parsing (valid, with Summary, wrong prefix, shell characters,
// over-long id), tag lookup (mission tag, no tag, exit 1, timeout, bad JSON),
// and the writer path (general + tagged nudge -> message lands in the mission
// session and mission.json says set_by "queue"; mission already set ->
// unchanged and no subprocess at all).

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../support/tempdir.ts";
import type { Config } from "../../plugin/src/env.ts";
import { createClient } from "../../plugin/src/honcho.ts";
import { readRigMission, setRigMission } from "../../plugin/src/missions.ts";
import {
  applyQueueMissionHint,
  createQueueRow,
  missionFromQitem,
  qitemIdFromNudge,
  rigArgvAllowed,
} from "../../plugin/src/nudge.ts";
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

// ADR-0021 decision 3 (X5 amended): the runner allowlist and the queue
// create shape. Everything runs with an injected `run` - no test here may
// spawn a real rig; refused shapes are refused before the runner is reached.
const CREATE_OK = [
  "queue", "create",
  "--destination", "lead@rigx",
  "--source", "stale-check@rigx", // the timer that runs the check is not a seat
  "--summary", "Stale review: 2 ledger entries may be out of date - run stale_review",
  "--body-file", "/state/stale/ws.notify.txt",
  "--tags", "openrig-honcho,stale-review",
  "--json",
];

describe("X5 runner allowlist + createQueueRow (ADR-0021 d3)", () => {
  test("rigArgvAllowed accepts exactly the two shapes", () => {
    expect(rigArgvAllowed("rig", ["queue", "show", QID, "--json"])).toBe(true);
    expect(rigArgvAllowed("rig", CREATE_OK)).toBe(true);
  });

  test("rigArgvAllowed refuses everything else, one refusal per rule", () => {
    const bads: [string, string[]][] = [
      ["bun", ["queue", "show", QID, "--json"]], // not rig
      ["rig", ["queue", "purge", QID, "--json"]], // unknown verb
      ["rig", ["queue", "show", QID]], // missing --json
      ["rig", ["queue", "show", "qitem-; rm", "--json"]], // id grammar
      ["rig", ["queue", "show", QID, "--json", "--extra"]], // over-long
      ["rig", ["queue", "create", "--destination", "lead@rig; rm", "--source", "stale-check@rigx", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // session
      ["rig", ["queue", "create", "--destination", `${"a".repeat(101)}@r`, "--source", "stale-check@r", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // session length
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // missing --source (the pre-timer 11-arg shape)
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "other@rigx", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // source not the fixed stale-check
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "stale-check@otherrig", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // source rig differs from destination rig
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "stale-check@rigx", "--summary", "x".repeat(161), "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // summary length
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "stale-check@rigx", "--summary", "two\nlines", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // summary newline
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "stale-check@rigx", "--summary", "s", "--body-file", "relative/b.txt", "--tags", "openrig-honcho,stale-review", "--json"]], // relative body
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "stale-check@rigx", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho", "--json"]], // tags
      ["rig", ["queue", "create", "--destination", "lead@rigx", "--source", "stale-check@rigx", "--summary", "s", "--body-file", "/s/b.txt", "--tags", "openrig-honcho,stale-review"]], // missing --json
    ];
    for (const [cmd, args] of bads) expect(rigArgvAllowed(cmd, args)).toBe(false);
    // the source flag is positional: right after --destination, nowhere else
    const misplaced = [...CREATE_OK];
    misplaced.splice(4, 2); // pull --source + value out from after --destination
    misplaced.splice(6, 0, "--source", "stale-check@rigx"); // push it past --summary
    expect(rigArgvAllowed("rig", misplaced)).toBe(false);
  });

  test("createQueueRow passes exactly the allowlisted argv with a 10 s budget", async () => {
    const dir = makeTempDir("nudge-cc-");
    mkdirSync(join(dir, "stale"));
    const body = join(dir, "stale", "ws.notify.txt");
    writeFileSync(body, "d-aaaa0001 21 days\n");
    chmodSync(body, 0o600); // the real caller (stale.ts:412) does; F-C now enforces it
    const calls: { cmd: string; args: string[]; t: number }[] = [];
    const ok = await createQueueRow(dir, "lead@rigx", "Stale review: 1 ledger entries may be out of date - run stale_review", body, {
      run: async (cmd, args, t) => {
        calls.push({ cmd, args, t });
        return { code: 0, stdout: "{}" };
      },
    });
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].cmd).toBe("rig");
    expect(calls[0].t).toBe(10000);
    expect(calls[0].args).toEqual([
      "queue", "create", "--destination", "lead@rigx",
      "--source", "stale-check@rigx", "--summary",
      "Stale review: 1 ledger entries may be out of date - run stale_review",
      "--body-file", body, "--tags", "openrig-honcho,stale-review", "--json",
    ]);
    expect(rigArgvAllowed(calls[0].cmd, calls[0].args)).toBe(true);
  });

  test("F-C (R25, probe D N2): a symlinked or non-0600 body file is refused", async () => {
    const dir = makeTempDir("nudge-fc-");
    mkdirSync(join(dir, "stale"));
    const run = async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: "{}" });
    // a symlink INSIDE the state dir whose content lives outside it: refused
    const link = join(dir, "stale", "ws.notify.txt");
    symlinkSync("/etc/hostname", link);
    expect(await createQueueRow(dir, "lead@rigx", "s", link, { run })).toBe(false);
    // a world-readable regular file (the probe N2 note): refused - mode 0600
    const plain = join(dir, "stale", "plain.txt");
    writeFileSync(plain, "d-aaaa0001 21 days\n"); // default 0644
    expect(await createQueueRow(dir, "lead@rigx", "s", plain, { run })).toBe(false);
    chmodSync(plain, 0o600); // a 0600 regular file: the standard shape, accepted
    expect(await createQueueRow(dir, "lead@rigx", "s", plain, { run })).toBe(true);
  });

  test("the argv carries --source stale-check@<rig of destination>: the timer is not a seat", async () => {
    // architect probe 2026-11-25: queue create from the systemd timer refuses
    // with "--source is required when OPENRIG_SESSION_NAME is not set"
    const dir = makeTempDir("nudge-src-");
    mkdirSync(join(dir, "stale"));
    const body = join(dir, "stale", "ws.notify.txt");
    writeFileSync(body, "d-aaaa0001 21 days\n");
    chmodSync(body, 0o600); // F-C: createQueueRow now requires the 0600 regular file
    const seen: string[][] = [];
    const ok = await createQueueRow(dir, "lead@deep-rig2", "s", body, {
      run: async (_c, args) => {
        seen.push(args);
        return { code: 0, stdout: "{}" };
      },
    });
    expect(ok).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0][4]).toBe("--source");
    expect(seen[0][5]).toBe("stale-check@deep-rig2");
    expect(rigArgvAllowed("rig", seen[0])).toBe(true);
  });

  test("every refusal returns false WITHOUT touching the runner; failures are false", async () => {
    const dir = makeTempDir("nudge-cr-");
    mkdirSync(join(dir, "stale"));
    const body = join(dir, "stale", "ws.notify.txt");
    writeFileSync(body, "d-aaaa0001 21 days\n");
    chmodSync(body, 0o600); // so the last assertions really reach the runner (F-C)
    const boom = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("the runner must not be reached for a refused shape");
    };
    expect(await createQueueRow(dir, "lead@rig; rm", "s", body, { run: boom })).toBe(false);
    expect(await createQueueRow(dir, "lead@rig", "x".repeat(161), body, { run: boom })).toBe(false);
    expect(await createQueueRow(dir, "lead@rig", "a\nb", body, { run: boom })).toBe(false);
    expect(await createQueueRow(dir, "lead@rig", "s", join(dir, "..", "outside.txt"), { run: boom })).toBe(false); // outside the state dir
    expect(await createQueueRow(dir, "lead@rig", "s", join(dir, "absent.txt"), { run: boom })).toBe(false); // not a file
    mkdirSync(join(dir, "adir"));
    expect(await createQueueRow(dir, "lead@rig", "s", join(dir, "adir"), { run: boom })).toBe(false); // a directory
    // a good shape with a failing run is still false, both ways
    expect(await createQueueRow(dir, "lead@rig", "ok summary", body, { run: async () => ({ code: 1, stdout: "" }) })).toBe(false);
    expect(await createQueueRow(dir, "lead@rig", "ok summary", body, {
      run: async () => {
        throw new Error("timeout");
      },
    })).toBe(false);
  });
});
