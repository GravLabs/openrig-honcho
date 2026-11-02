// Review T3 (dev.review). Pure attribution attacks per ADR-0003 and the
// architect's qitem list. Expecting-fail cases marked with F-.
import { describe, expect, test } from "bun:test";
import { attribute } from "../../plugin/src/attribute.ts";
import { parseEnvelope as parseEnv } from "../../plugin/src/envelope.ts";

const ctxOff = { selfPeer: "dev-review", ownerPeer: "owner", rig: "openrig-honcho", recordAutomation: false };
const ctxOn = { ...ctxOff, recordAutomation: true };

const ENV = (from: string, body: string, to = "dev-review@openrig-honcho") =>
  `From: ${from}\nTo: ${to}\n---\n${body}\n---\n↩ Reply: rig send design-architect@openrig-honcho "..."`;

const PASTED = (inner: string, id = "p1") =>
  `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;

describe("T3 unwrap (ADR-0003 Unwrapping)", () => {
  test("one whole-prompt paste block with matching ids unwraps to peer", () => {
    const res = attribute(PASTED(ENV("dev-build@openrig-honcho", "hi")), ctxOff);
    expect(res.kind).toBe("peer");
    if (res.kind === "peer") expect(res.peer).toBe("dev-build");
  });

  test("text around the paste block -> no unwrap -> owner", () => {
    const res = attribute("look:\n" + PASTED(ENV("dev-build@openrig-honcho", "hi")), ctxOff);
    expect(res.kind).toBe("owner");
  });

  test("two paste blocks with DIFFERENT ids -> no unwrap -> owner", () => {
    const p = PASTED(ENV("dev-build@openrig-honcho", "a"), "x") + "\n" + PASTED(ENV("dev-build@openrig-honcho", "b"), "y");
    expect(attribute(p, ctxOff).kind).toBe("owner");
  });

  // F-1: two paste blocks with the SAME id — ADR: "two blocks means it is not
  // unwrapped" -> class 4 (owner). Greedy backreference in PASTED_BLOCK makes
  // the whole two-block string match "exactly one block", so this currently
  // unwraps and the first envelope gets trusted: kind "peer", not "owner".
  test("F-1: two paste blocks with the SAME id -> no unwrap -> owner", () => {
    const p = PASTED(ENV("dev-build@openrig-honcho", "first")) + "\n" + PASTED(ENV("dev-build@openrig-honcho", "second"));
    expect(attribute(p, ctxOff).kind).toBe("owner");
  });

  test("mismatched ids -> no unwrap -> owner", () => {
    const p = `<pasted_content id="a">\n${ENV("dev-build@openrig-honcho", "hi")}\n</pasted_content id="b">`;
    expect(attribute(p, ctxOff).kind).toBe("owner");
  });

  test("leading system-reminders are stripped, then the envelope counts", () => {
    const p = `<system-reminder>\nnote\n</system-reminder>\n${ENV("dev-build@openrig-honcho", "hi")}`;
    expect(attribute(p, ctxOff).kind).toBe("peer");
  });

  test("empty paste block unwraps to empty -> skip", () => {
    expect(attribute(PASTED(""), ctxOff).kind).toBe("skip");
  });
});

describe("T3 envelope well-formedness", () => {
  // F-2: an envelope with an EMPTY sender is trusted and attributes to peer
  // "" — a garbage identity in shared memory. No contract defines an empty
  // peer id; a well-formed header must carry a non-empty sender, else it is a
  // malformed pseudo-header and falls to class 3/4 (owner).
  test("F-2: envelope with empty From value does not create a '' peer", () => {
    const res = attribute(ENV("", "hi"), ctxOff);
    expect(res.kind).toBe("owner");
    if (res.kind === "peer") expect(res.peer).not.toBe("");
  });

  test("From: with no space is not a header -> owner", () => {
    expect(attribute("From:x\nTo: y\n---\nb\n---\n↩ h", ctxOff).kind).toBe("owner");
  });

  test("four header lines -> not an envelope -> owner", () => {
    expect(attribute(`From: a@${"r"}\nTo: t\nSent: 10-28 04:00Z\nExtra: x\n---\nb\n---\n↩ h`, ctxOff).kind).toBe("owner");
  });

  test("empty To value -> not an envelope -> owner", () => {
    expect(attribute(ENV("dev-build@openrig-honcho", "hi", ""), ctxOff).kind).toBe("owner");
  });

  test("closing --- with no reply-hint line -> no envelope -> owner", () => {
    expect(attribute("From: a@r\nTo: t\n---\nbody\n---\nno hint here", ctxOff).kind).toBe("owner");
  });

  test("owner text then a full envelope -> owner", () => {
    const p = "check this:\n" + ENV("dev-build@openrig-honcho", "quoted");
    expect(attribute(p, ctxOff).kind).toBe("owner");
  });
});

describe("T3 closing-separator hazard (quoted envelope in body)", () => {
  const quoted = ENV("someone@else-rig", "inner body").replace(/↩/, "↩");
  const body = `earlier line\n---\nmid dash\n---\nquoted envelope:\n${quoted}\ntrailing`;
  const outer = ENV("dev-build@openrig-honcho", body);

  test("peer is the outer sender, body intact", () => {
    const res = attribute(outer, ctxOff);
    expect(res.kind).toBe("peer");
    if (res.kind === "peer") {
      expect(res.peer).toBe("dev-build");
      expect(res.content).toBe(body);
    }
  });

  test("body whose last line is a quoted reply-hint keeps everything", () => {
    const b2 = `body then hint line:\n---\n↩ quoted`;
    const res = attribute(ENV("dev-build@openrig-honcho", b2), ctxOff);
    expect(res.kind).toBe("peer");
    if (res.kind === "peer") expect(res.content).toBe(b2);
  });
});

describe("T3 To parsing", () => {
  const e = (to: string) => parseEnv(ENV("dev-build@openrig-honcho", "b", to));
  test("comma list", () => expect(e("a@r1, b@r2")?.to).toEqual(["a@r1", "b@r2"]));
  test("rig broadcast with seats", () => {
    const env = e("broadcast to pilot (3 seats)");
    expect(env?.to).toEqual({ broadcast: "pilot" });
    expect(env?.fanout).toBe(3);
  });
  test("topology broadcast", () => expect(e("broadcast to topology")?.to).toEqual({ broadcast: "topology" }));
  test("attribution passes To through", () => {
    const res = attribute(ENV("dev-build@openrig-honcho", "b", "broadcast to pilot (3 seats)"), ctxOff);
    expect(res.kind === "peer" && res.fanout).toBe(3);
  });
});

describe("T3 sender mapping", () => {
  const peerOf = (from: string) => attribute(ENV(from, "b"), ctxOff);
  test("same rig -> local part", () => expect(peerOf("dev-build@openrig-honcho").kind === "peer" && (peerOf("dev-build@openrig-honcho") as any).peer).toBe("dev-build"));
  test("cross rig -> local_rig", () => expect((peerOf("ops-admin@other-rig") as any).peer).toBe("ops-admin_other-rig"));
  test("<unknown sender> -> unknown-sender", () => expect((peerOf("<unknown sender>") as any).peer).toBe("unknown-sender"));
  test("external matching owner -> owner peer", () => expect((peerOf("owner@external") as any).peer).toBe("owner"));
  test("external other -> ext-<name>", () => expect((peerOf("guest@external") as any).peer).toBe("ext-guest"));
  test("daemon@kernel -> skip when automation off", () => expect(peerOf("daemon@kernel").kind).toBe("skip"));
  test("system:* -> openrig when automation on", () => {
    const res = attribute(ENV("system:health", "b"), ctxOn);
    expect(res.kind).toBe("automation");
    if (res.kind === "automation") expect(res.peer).toBe("openrig");
  });
});

describe("T3 automation marker + harness content", () => {
  const idc = "OpenRig-generated identity context (not a project task):\nwhatever\nEnd of generated identity context.";
  test("identity context -> skip when off, openrig when on", () => {
    expect(attribute(idc, ctxOff).kind).toBe("skip");
    expect((attribute(idc, ctxOn) as any).peer).toBe("openrig");
  });
  test("identity marker mid-text is NOT automation -> owner", () => {
    expect(attribute("notes first\n" + idc, ctxOff).kind).toBe("owner");
  });
  for (const h of [
    "<task-notification>x</task-notification>",
    "<system-reminder>standalone</system-reminder>",
    "<command-name>/compact</command-name>",
    "/compact",
    "/ns:cmd args",
    "<<HEREDOC>>",
  ]) {
    test(`harness content skipped: ${h.slice(0, 24)}`, () => expect(attribute(h, ctxOff).kind).toBe("skip"));
  }
  test("typed path with args stays owner (conservative slash rule)", () => {
    expect(attribute("/tmp is missing", ctxOff).kind).toBe("owner");
  });
  test("empty and whitespace prompts skip", () => {
    expect(attribute("", ctxOff).kind).toBe("skip");
    expect(attribute("  \n\t ", ctxOff).kind).toBe("skip");
  });
});

describe("T3 S1 fuzz: 5000 mutations of the fixtures, zero throws", () => {
  test("attribute() never throws on mutated fixtures", async () => {
    const dir = new URL("../fixtures/prompts/", import.meta.url);
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(dir.pathname)).sort();
    expect(entries.length).toBeGreaterThanOrEqual(21);
    const fixtures: string[] = [];
    for (const n of entries) fixtures.push(await Bun.file(`${dir.pathname}/${n}`).text());

    const tokens = [
      "From: dev-build@openrig-honcho\n", "To: x@y\n", "Sent: 10-28 04:00Z\n", "---",
      "↩ Reply: x", '<pasted_content id="p">', '</pasted_content id="p">',
      "<system-reminder>", "</system-reminder>", "OpenRig-generated identity context (not a project task):",
      "\n", " ", "From: \n", "@external",
    ];
    let s = 42;
    const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
    const ctxs = [ctxOff, ctxOn];

    for (let i = 0; i < 5000; i++) {
      let t = fixtures[Math.floor(rnd() * fixtures.length)];
      const muts = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < muts; m++) {
        const op = Math.floor(rnd() * 4);
        const pos = Math.floor(rnd() * (t.length + 1));
        if (op === 0) t = t.slice(0, pos);
        else if (op === 1) t = t.slice(pos);
        else if (op === 2) t = t.slice(0, pos) + tokens[Math.floor(rnd() * tokens.length)] + t.slice(pos);
        else t = t.slice(0, pos) + t.slice(pos + 1 + Math.floor(rnd() * 50));
      }
      const ctx = ctxs[i % 2];
      let res: ReturnType<typeof attribute> | undefined;
      expect(() => { res = attribute(t, ctx); }).not.toThrow();
      const kind = res!.kind;
      expect(["skip", "peer", "owner", "automation"]).toContain(kind);
      if (kind !== "skip") {
        expect(typeof (res as any).peer).toBe("string");
        expect(typeof (res as any).content).toBe("string");
      }
    }
  });
});
