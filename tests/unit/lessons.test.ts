// V5 (ADR-0019 decision 5, as decided 2026-11-13): lessons at the moment the
// work names a risky action. A claimed hand-off whose summary or first body
// line names a risky action shows the seat's OWN matching lore as one line
// per lesson beside the claim pointer. Checks (a)-(g) from the row brief.
// Everything here is local disk reads inside the pointer's existing 1 s
// budget and holdout arm: no model, no network for the lessons, no copy of
// lore anywhere (the log carries a count only, never lore text), no
// PreToolUse hook.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RISKY_WORDS,
  parseLoreFile,
  pickLessons,
  pointerLessons,
  riskyWordIn,
  type LoreFileReader,
  type LoreItem,
} from "../../plugin/src/lessons.ts";
import { fetchQueuePointerRow } from "../../plugin/src/daemon.ts";
import { startFakeDaemon } from "../support/fake-daemon.ts";
import { startFakeHoncho, type FakeHoncho } from "../support/fake-honcho.ts";
import { makeTempDir } from "../support/tempdir.ts";

const REPO = join(import.meta.dir, "..", "..");
const RECALL_BIN = join(REPO, "plugin/bin/recall.ts");
const WS = "ws";
const QID = "qitem-20261110194213-c286d1fd69407185";
const FOOTER = "↩ Reply: rig send x \"...\"";

// ---------------------------------------------------------------------------
// (b-pure) the risky word list, whole words, case-insensitive

describe("V5 riskyWordIn (fixed list, whole words, case-insensitive)", () => {
  test("the fixed list is exactly the brief's eleven words", () => {
    expect([...RISKY_WORDS].sort()).toEqual(
      ["delete", "deploy", "drop", "force", "publish", "push", "release",
        "remove", "reset", "rm", "tag"].sort(),
    );
  });

  test("whole words match, substrings do not; case-insensitive", () => {
    // the word returned is the first fixed-list hit, in LIST order:
    expect(riskyWordIn("git push the release candidate")).toBe("release");
    expect(riskyWordIn("PUBLISH the catalog")).toBe("publish");
    expect(riskyWordIn("rm -rf the cache dir")).toBe("rm");
    expect(riskyWordIn("remove the form field")).toBe("remove"); // NOT rm-in-form
    expect(riskyWordIn("fill in the form")).toBeNull();          // rm inside form
    expect(riskyWordIn("pushed the branch yesterday")).toBeNull(); // not whole
    expect(riskyWordIn("adds tags to the build")).toBeNull();      // tags != tag
    expect(riskyWordIn("re-push the branch")).toBe("push"); // a hyphen IS a boundary: re-push names a push
    expect(riskyWordIn("force")).toBe("force");
    expect(riskyWordIn("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lore file parsing: taxonomy gate, Moment line, frontmatter date

const loreDoc = (over: Partial<{ date: string; taxonomy: string }> = {}): string =>
  `---
taxonomy: ${over.taxonomy ?? "lore"}
stage: wip
method: "lived incident"
date: "${over.date ?? "2026-11-10T00:00:00Z"}"
position: "build@ws"
---

# A situation

## Situation

**Position:** \`build@ws\`

**Moment.** What is happening when this becomes useful.

**Reflex.** A tempting wrong response.

**Instead.** What to do.

**Because.** The evidence.
`;

describe("V5 parseLoreFile (taxonomy: lore gate; Moment line; date)", () => {
  test("taxonomy lore: slug, Moment text and date come back", () => {
    const it = parseLoreFile("careful-with-git-push.md", loreDoc({ date: "2026-11-11T08:00:00Z" }));
    expect(it).not.toBeNull();
    expect(it!.slug).toBe("careful-with-git-push.md");
    expect(it!.moment).toBe("What is happening when this becomes useful.");
    expect(it!.date).toBe("2026-11-11T08:00:00Z");
  });
  test("no frontmatter, or taxonomy not lore, is skipped (null)", () => {
    expect(parseLoreFile("a.md", "# just a heading\n")).toBeNull();
    expect(parseLoreFile("a.md", loreDoc({ taxonomy: "note" }))).toBeNull();
    expect(parseLoreFile("a.md", "")).toBeNull();
  });
  test("missing Moment line gives null (a pointer needs its Moment)", () => {
    const noMoment = loreDoc().replace("**Moment.** What is happening when this becomes useful.", "");
    expect(parseLoreFile("a.md", noMoment)).toBeNull();
  });
});

describe("V5 pickLessons (match by slug or Moment; max 2; newest date first)", () => {
  const li = (slug: string, moment: string, date: string): LoreItem => ({ slug, moment, date });
  test("a word in the slug or in the Moment matches; the rest do not", () => {
    const items = [
      li("careful-with-git-push.md", "an unrelated moment", "2026-11-09T00:00:00Z"),
      li("morning-blur.md", "before you push to the shared remote", "2026-11-10T00:00:00Z"),
      li("lunch.md", "nothing risky here", "2026-11-11T00:00:00Z"),
    ];
    const got = pickLessons(items, "push");
    expect(got.map((x) => x.slug)).toEqual(["morning-blur.md", "careful-with-git-push.md"]);
  });
  test("at most 2, newest date first (the frontmatter date is the key)", () => {
    const items = [
      li("a-push-one.md", "m", "2026-11-09T00:00:00Z"),
      li("a-push-two.md", "m", "2026-11-12T00:00:00Z"),
      li("a-push-three.md", "m", "2026-11-11T00:00:00Z"),
    ];
    expect(pickLessons(items, "push").map((x) => x.slug)).toEqual(
      ["a-push-two.md", "a-push-three.md"],
    );
  });
  test("slug word boundaries: a push slug needs the whole word", () => {
    expect(pickLessons([li("pushed-notes.md", "m", "2026-11-01T00:00:00Z")], "push")).toEqual([]);
    expect(pickLessons([li("the-push-rule.md", "m", "2026-11-01T00:00:00Z")], "push").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// the IO wrapper: the seat's own folder only, 50 files / 64 KB caps, skips

const lorePath = (root: string, seat: string, name: string): string =>
  join(root, "rigs", WS, "seats", seat, "lore", name);
const writeLore = (root: string, seat: string, name: string, text: string): void => {
  const dir = join(root, "rigs", WS, "seats", seat, "lore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

describe("V5 pointerLessons IO (own folder, caps, skips, lines)", () => {
  const cfgShaped = (root: string) =>
    ({ topologyRoot: root, sessionName: `build@${WS}` }) as never;

  test("(d) a non-lore file, a directory named *.md and an oversized file are skipped", () => {
    const root = makeTempDir("v5d-");
    try {
      writeLore(root, "build", "push-good.md", loreDoc({ date: "2026-11-10T00:00:00Z" }));
      writeLore(root, "build", "push-notaxonomy.md", loreDoc({ taxonomy: "note" }));
      writeLore(root, "build", "push-huge.md", loreDoc().replace("date: \"2026-11-10T00:00:00Z\"", "date: \"2026-11-12T00:00:00Z\"") + "\n" + "x".repeat(65 * 1024));
      mkdirSync(lorePath(root, "build", "push-adirectory.md"), { recursive: true });
      const got = pointerLessons(cfgShaped(root), "please push this");
      expect(got.count).toBe(1);
      expect(got.text).toContain("push-good.md");
      expect(got.text).not.toContain("notaxonomy");
      expect(got.text).not.toContain("huge");
      expect(got.text).not.toContain("adirectory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(c) another seat's folder is never read: the paths touched stay in own lore", () => {
    const root = makeTempDir("v5c-");
    try {
      writeLore(root, "build", "my-push.md", loreDoc());
      writeLore(root, "other", "push-not-mine.md", loreDoc());
      const touched: string[] = [];
      const spy: LoreFileReader = {
        list: (dir: string): string[] => {
          touched.push(dir);
          const { readdirSync } = require("node:fs") as typeof import("node:fs");
          return readdirSync(dir);
        },
        read: (file: string): string => {
          touched.push(file);
          return readFileSync(file, "utf8");
        },
        sizeIsFile: (file: string): number | null => {
          const { statSync } = require("node:fs") as typeof import("node:fs");
          try {
            const st = statSync(file);
            return st.isFile() ? st.size : null;
          } catch {
            return null;
          }
        },
      };
      const got = pointerLessons(cfgShaped(root), "push", spy);
      expect(got.count).toBe(1);
      expect(got.text).toContain("my-push.md");
      expect(got.text).not.toContain("not-mine");
      expect(touched.length).toBeGreaterThan(0);
      const own = join(root, "rigs", WS, "seats", "build", "lore");
      for (const p of touched) expect(p.startsWith(own)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(e-at-IO) at most 2 newest first, and the line shape with the trust tag", () => {
    const root = makeTempDir("v5e-");
    try {
      for (const [n, d] of [["a.md", "2026-11-09"], ["b.md", "2026-11-12"], ["c.md", "2026-11-11"]] as const) {
        writeLore(root, "build", `push-${n}`, loreDoc({ date: `${d}T00:00:00Z` }).replace(
          "What is happening when this becomes useful.",
          `before you push number ${n}`,
        ));
      }
      const got = pointerLessons(cfgShaped(root), "git push it");
      expect(got.count).toBe(2);
      const lines = got.text.split("\n");
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("seat:lore/push-b.md - before you push number b.md");
      expect(lines[0]).toMatch(/\[recorded\]$/); // trust class rides the shown line
      expect(lines[1]).toContain("seat:lore/push-c.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the Moment line is sanitizeVisible'd and capped at 120 before the tag", () => {
    const root = makeTempDir("v5cap-");
    try {
      const wild = `push now \u0000 \u200b tail ${"z".repeat(300)}`;
      writeLore(root, "build", "push-wild.md", loreDoc().replace(
        "What is happening when this becomes useful.",
        wild,
      ));
      const got = pointerLessons(cfgShaped(root), "push");
      expect(got.count).toBe(1);
      const line = got.text;
      const afterDash = line.slice(line.indexOf(" - ") + 3).replace(" [recorded]", "");
      expect(afterDash.length).toBeLessThanOrEqual(120);
      expect(got.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b\u2028\u2029]/u); // invisible controls stripped
      expect(got.text).toContain("[recorded]"); // the trust tag rides OUTSIDE the cap
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("(g-at-IO) a missing lore folder: no lessons, no error thrown", () => {
    const root = makeTempDir("v5g-");
    try {
      const got = pointerLessons(cfgShaped(root), "push");
      expect(got.count).toBe(0);
      expect(got.text).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("50-file cap: at most 50 files are read", () => {
    const root = makeTempDir("v5cap50-");
    try {
      for (let i = 0; i < 55; i++) writeLore(root, "build", `push-f${String(i).padStart(2, "0")}.md`, loreDoc());
      let reads = 0;
      const spy: LoreFileReader = {
        list: (dir: string): string[] => {
          const { readdirSync } = require("node:fs") as typeof import("node:fs");
          return readdirSync(dir);
        },
        read: (file: string): string => {
          reads += 1;
          return readFileSync(file, "utf8");
        },
        sizeIsFile: (file: string): number | null => {
          const { statSync } = require("node:fs") as typeof import("node:fs");
          try {
            const st = statSync(file);
            return st.isFile() ? st.size : null;
          } catch {
            return null;
          }
        },
      };
      const got = pointerLessons(cfgShaped(root), "push", spy);
      expect(reads).toBeLessThanOrEqual(50);
      expect(got.count).toBe(2); // max shown, but the READ cap is the check
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// the risk view on the verified row: the first body line, bounded (brief pt 1)

describe("V5 fetchQueuePointerRow: riskText carries summary AND first body line", () => {
  test("summary present: firstBodyLine still read, bounded 200, never the whole body", async () => {
    const daemon = await startFakeDaemon({
      item: {
        qitemId: QID,
        destinationSession: `build@${WS}`,
        summary: "push the release candidate",
        body: `the first body line names a deploy too${"y".repeat(500)}\nsecond line hidden`,
      },
    });
    try {
      const r = await fetchQueuePointerRow(daemon.url, QID);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.summary).toBe("push the release candidate");
      expect(r.firstBodyLine).toBe(`the first body line names a deploy too${"y".repeat(162)}`);
      expect(r.firstBodyLine.length).toBeLessThanOrEqual(200);
    } finally {
      daemon.close();
    }
  });
  test("no body: firstBodyLine is the empty string, not undefined", async () => {
    const daemon = await startFakeDaemon({
      item: { qitemId: QID, destinationSession: `build@${WS}`, summary: "plain summary", body: "" },
    });
    try {
      const r = await fetchQueuePointerRow(daemon.url, QID);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.firstBodyLine).toBe("");
    } finally {
      daemon.close();
    }
  });
});

// ---------------------------------------------------------------------------
// the bin wiring: checks (a)(b)(f)(g) + the no-pointer-block decision, on the
// same four gates and one arm as the pointer itself

async function runRecall(
  env: Record<string, string>,
  stdin: unknown,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, RECALL_BIN], {
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

const nudge = (sessionId: string): { prompt: string; session_id: string } => ({
  prompt: `From: daemon@${WS}\nTo: build@${WS}\n---\nQueue handoff: ${QID} - check your queue.\n---\n${FOOTER}`,
  session_id: sessionId,
});

async function mkRig(opts: {
  summary: string;
  body?: string;
  topo: string | null;
  extraEnv?: Record<string, string>;
  seedMemories?: boolean;
}): Promise<{
  env: Record<string, string>;
  dir: string;
  lines: () => Record<string, unknown>[];
  cleanup: () => Promise<void>;
}> {
  const fake: FakeHoncho = await startFakeHoncho();
  const delivered = [
    {
      outboxId: "ob-v5-1",
      destinationSession: `build@${WS}`,
      body: nudge("arm-only").prompt,
      deliveredAt: new Date().toISOString(),
    },
  ];
  const daemon = await startFakeDaemon({
    item: {
      qitemId: QID,
      destinationSession: `build@${WS}`,
      sourceSession: `daemon@${WS}`,
      tags: [],
      summary: opts.summary,
      body: opts.body ?? "a body line",
    },
    outbox: delivered,
  });
  if (opts.seedMemories ?? true) {
    fake.addConclusion(WS, {
      observer_id: "build",
      observed_id: "build",
      content: "conclusion note about trust behaviour",
      created_at: new Date().toISOString(),
    });
  }
  const dir = makeTempDir("v5bin-");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    HONCHO_STATE_DIR: dir,
    HONCHO_URL: fake.url,
    HONCHO_WORKSPACE: WS,
    HONCHO_PEER: "build",
    OPENRIG_SESSION_NAME: `build@${WS}`,
    OPENRIG_URL: daemon.url,
    ...(opts.topo !== null ? { HONCHO_TOPOLOGY_ROOT: opts.topo } : {}),
    ...(opts.extraEnv ?? {}),
  };
  return {
    env,
    dir,
    lines: () => {
      try {
        return readFileSync(join(dir, "log", `${WS}.log`), "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    cleanup: async () => {
      await fake.stop();
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A session_id whose arm is HELD at holdout 0.9 for this exact prompt
 * (the pointerArm formula: sha256(session + NUL + prompt) first 8 hex). */
function heldSession(prompt: string): string {
  for (let i = 0; i < 5000; i++) {
    const s = `h${i}`;
    const h = createHash("sha256").update(s + String.fromCharCode(0) + prompt, "utf8").digest("hex");
    if (Number.parseInt(h.slice(0, 8), 16) / 0x1_0000_0000 < 0.9) return s;
  }
  throw new Error("no held session found");
}

describe("V5 on the recall line (checks a, b, f, g + the no-pointer-block choice)", () => {
  test("(a) risky row: matching lessons show beside the pointer, by slug and by Moment", async () => {
    const topo = makeTempDir("v5at-");
    const rig = await mkRig({ summary: "git push the candidate to main", topo });
    try {
      writeLore(topo, "build", "careful-with-git-push.md", loreDoc({ date: "2026-11-11T00:00:00Z" }));
      writeLore(topo, "build", "morning-blur.md", loreDoc({ date: "2026-11-12T00:00:00Z" }).replace(
        "What is happening when this becomes useful.",
        "the moment before you push to the shared remote",
      ));
      const r = await runRecall(rig.env, nudge("c1"));
      expect(r.code).toBe(0);
      const o = JSON.parse(r.out) as { hookSpecificOutput: { additionalContext: string } };
      const block = o.hookSpecificOutput.additionalContext;
      expect(block).toContain("[openrig-honcho pointer"); // the pointer still shows
      expect(block).toContain("Your lesson: seat:lore/careful-with-git-push.md - ");
      expect(block).toContain("Your lesson: seat:lore/morning-blur.md - the moment before you push");
      expect(block).toContain("[recorded]"); // trust class on the shown line
      const ev = rig.lines().filter((l) => l.event === "pointer");
      expect(ev.length).toBe(1); // one event per run, still
      expect(ev[0].pointer).toBe("shown");
      expect(ev[0].lessons).toBe(2); // count only - never lore text in the log
      const logged = JSON.stringify(ev[0]);
      expect(logged).not.toContain("careful-with");
      expect(logged).not.toContain("shared remote");
    } finally {
      await rig.cleanup();
      rmSync(topo, { recursive: true, force: true });
    }
  });

  test("risk from the FIRST BODY LINE alone also shows lessons", async () => {
    const topo = makeTempDir("v5ab-");
    const rig = await mkRig({ summary: "tidy the docs wording", body: "also delete the stale notes\nmore", topo });
    try {
      writeLore(topo, "build", "delete-with-care.md", loreDoc());
      const r = await runRecall(rig.env, nudge("c1"));
      const o = JSON.parse(r.out) as { hookSpecificOutput: { additionalContext: string } };
      expect(o.hookSpecificOutput.additionalContext).toContain("Your lesson: seat:lore/delete-with-care.md");
    } finally {
      await rig.cleanup();
      rmSync(topo, { recursive: true, force: true });
    }
  });

  test("(b) a non-risky row shows no lesson lines", async () => {
    const topo = makeTempDir("v5bt-");
    const rig = await mkRig({ summary: "install trust exact match behaviour on upgrade", topo });
    try {
      writeLore(topo, "build", "careful-with-git-push.md", loreDoc());
      const r = await runRecall(rig.env, nudge("c1"));
      expect(r.code).toBe(0);
      const o = JSON.parse(r.out) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(o.hookSpecificOutput?.additionalContext ?? "").not.toContain("Your lesson");
      const ev = rig.lines().filter((l) => l.event === "pointer");
      expect(ev.length).toBe(1);
      expect(ev[0].lessons ?? 0).toBe(0);
    } finally {
      await rig.cleanup();
      rmSync(topo, { recursive: true, force: true });
    }
  });

  test("no-pointer-block case (DECISION, stated for ruling): empty memories still show the lesson", async () => {
    const topo = makeTempDir("v5nb-");
    const rig = await mkRig({ summary: "git push the candidate", topo, seedMemories: false });
    try {
      writeLore(topo, "build", "careful-with-git-push.md", loreDoc());
      const r = await runRecall(rig.env, nudge("c1"));
      expect(r.code).toBe(0);
      const o = JSON.parse(r.out) as { hookSpecificOutput: { additionalContext: string } };
      expect(o.hookSpecificOutput.additionalContext).toContain("Your lesson: seat:lore/careful-with-git-push.md");
      const ev = rig.lines().filter((l) => l.event === "pointer");
      expect(ev.length).toBe(1);
      expect(ev[0].lessons).toBe(1);
    } finally {
      await rig.cleanup();
      rmSync(topo, { recursive: true, force: true });
    }
  });

  test("(f) the held arm shows nothing and logs the held line", async () => {
    const topo = makeTempDir("v5ft-");
    const rig = await mkRig({
      summary: "git push the candidate",
      topo,
      extraEnv: { HONCHO_RECALL_HOLDOUT: "0.9" },
    });
    try {
      writeLore(topo, "build", "careful-with-git-push.md", loreDoc());
      const n = nudge(heldSession(nudge("arm-only").prompt));
      const r = await runRecall(rig.env, n);
      expect(r.code).toBe(0);
      expect(r.out).toBe(""); // held shows NOTHING - no lessons either
      const lines = rig.lines();
      const held = lines.filter((l) => l.pointer === "held");
      expect(held.length).toBe(1); // still exactly one event per run
      expect(JSON.stringify(held[0])).not.toContain("careful-with");
    } finally {
      await rig.cleanup();
      rmSync(topo, { recursive: true, force: true });
    }
  });

  test("(g) no lore folder: nothing shown, no error, exit 0", async () => {
    const rig = await mkRig({ summary: "git push the candidate", topo: null });
    try {
      const r = await runRecall(rig.env, nudge("c1"));
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      const o = JSON.parse(r.out) as { hookSpecificOutput?: { additionalContext?: string } };
      expect(o.hookSpecificOutput?.additionalContext ?? "").not.toContain("Your lesson");
      const ev = rig.lines().filter((l) => l.event === "pointer");
      expect(ev.length).toBe(1);
      expect(ev[0].lessons ?? 0).toBe(0);
    } finally {
      await rig.cleanup();
    }
  });

  test("no HONCHO_TOPOLOGY_ROOT with a real HOME default: an absent default folder is silent", async () => {
    const rig = await mkRig({ summary: "git push the candidate", topo: null });
    try {
      // HOME is the temp dir; the default chain gives HOME/.openrig/topology,
      // which does not exist: the run must behave exactly like today's.
      const r = await runRecall(rig.env, nudge("c1"));
      expect(r.code).toBe(0);
      expect(r.out).toContain("[openrig-honcho pointer"); // pointer itself unchanged
      expect(r.out).not.toContain("Your lesson");
    } finally {
      await rig.cleanup();
    }
  });
});
