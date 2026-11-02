// T3: sender attribution (ADR-0003 "Classification"), one assertion per
// fixture in tests/fixtures/prompts/ on kind + peer + content (content = the
// body only: no envelope headers, no reply hint). Fixtures are synthesized;
// no real names, no secrets. Plus direct tests for parseEnvelope details the
// Attribution shape doesn't carry (sent line, broadcast fanout, malformed ->
// null) and for peerIdFromSession.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  attribute,
  peerIdFromSession,
  UNKNOWN_SENDER_PEER,
  type AttrCtx,
} from "../../plugin/src/attribute.ts";
import { parseEnvelope } from "../../plugin/src/envelope.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/prompts/${name}.txt`, import.meta.url), "utf8");

const ctx: AttrCtx = {
  selfPeer: "dev-build",
  ownerPeer: "owner",
  rig: "openrig-honcho",
  recordAutomation: true,
};
const ctxNoAuto: AttrCtx = { ...ctx, recordAutomation: false };

// 21 fixtures total (ls tests/fixtures/prompts/ | wc -l). One entry each.
const cases: Array<[name: string, expected: ReturnType<typeof attribute>]> = [
  ["enveloped-dm", {
    kind: "peer",
    peer: "dev-build",
    content: "The seam looks right, I am building against it now.",
    to: ["design-architect@openrig-honcho"],
  }],
  ["pasted-wrapped-dm", {
    kind: "peer",
    peer: "dev-build",
    content: "The seam looks right, I am building against it now.",
    to: ["design-architect@openrig-honcho"],
  }],
  ["multi-recipient-to", {
    kind: "peer",
    peer: "design-architect",
    content: "Both of you take a look at this interface.",
    to: ["dev-build@openrig-honcho", "dev-review@openrig-honcho"],
  }],
  ["rig-broadcast-to", {
    kind: "peer",
    peer: "design-architect",
    content: "Heads-up: the env contract changed, re-read the ADR.",
    to: { broadcast: "openrig-honcho" },
    fanout: 3,
  }],
  ["sent-with-gen-and-delivered", {
    kind: "peer",
    peer: "dev-review",
    content: "Attacked your module from six directions, two bugs found.",
    to: ["dev-build@openrig-honcho"],
  }],
  ["body-with-separators-and-quoted-envelope", {
    kind: "peer",
    peer: "design-architect",
    content:
      "Notes on your draft:\n\n" +
      "The parser must use the LAST separator as the close. For example a body\n" +
      "can contain a quoted envelope like this:\n\n" +
      "---\n" +
      "From: fake@nowhere.example\n" +
      "To: nobody@example\n" +
      "---\n" +
      "I am quoted body text, not a real header.\n" +
      "---\n" +
      "Keep parsing it that way.",
    to: ["dev-build@openrig-honcho"],
  }],
  ["daemon-kernel-sender", {
    kind: "automation",
    peer: "openrig",
    content: "Queue handoff: qitem-recovery-0000 - check your queue. Summary: Stuck sweep finding",
  }],
  ["system-health-sender", {
    kind: "automation",
    peer: "openrig",
    content: "Listener heartbeat lost for 4 minutes, inspect the daemon.",
  }],
  ["unknown-sender", {
    kind: "peer",
    peer: "unknown-sender",
    content: "A message arrived whose transport identity could not be resolved.",
    to: ["dev-build@openrig-honcho"],
  }],
  ["external-sender", {
    kind: "peer",
    peer: "ext-alice",
    sameRig: false, // T16a/ADR-0011 3: @external is not a seat of this rig
    content: "I am messaging from outside the fleet through the queue surface.",
    to: ["dev-build@openrig-honcho"],
  }],
  ["owner-external", {
    kind: "peer",
    peer: "owner",
    sameRig: false, // T16a/ADR-0011 3: via @external, not a rig seat
    content: "I am the owner messaging through the queue surface from outside the fleet.",
    to: ["dev-build@openrig-honcho"],
  }],
  ["cross-rig-sender", {
    kind: "peer",
    peer: "operator-agent_kernel",
    sameRig: false, // T16a/ADR-0011 3: From: rig != ours
    content: "Your rig needs a port released, coordinating now.",
    to: ["dev-build@openrig-honcho"],
  }],
  // Queue nudges arrive enveloped with the SOURCE seat as From
  // (queue-repository.js wrapPaneEnvelope(sourceSession, ...)), so they are
  // attributed to that seat, not to the automation peer.
  ["queue-nudge", {
    kind: "peer",
    peer: "design-architect",
    content:
      "Queue handoff: qitem-20261028050000-1234567890abcdef - check your queue. " +
      "Summary: T4 redaction spec for your review",
    to: ["dev-build@openrig-honcho"],
  }],
  ["identity-context", {
    kind: "automation",
    peer: "openrig",
    content:
      "OpenRig-generated identity context (not a project task):\n" +
      "dev-build@openrig-honcho\n" +
      "OpenRig session identity:\n" +
      "- rig: openrig-honcho\n" +
      "- pod: dev\n" +
      "- member: build\n" +
      "End of generated identity context.",
  }],
  ["plain-owner-text", {
    kind: "owner",
    peer: "owner",
    content: "what is the state of the memory plugin today?",
  }],
  ["fake-from-prefix", {
    kind: "owner",
    peer: "owner",
    content: "From: me\nTo: nobody\nI typed this by hand and there are no separators anywhere.",
  }],
  ["reminder-then-envelope", {
    kind: "peer",
    peer: "design-architect",
    content: "Reminder stripped, envelope still attributed to the architect.",
    to: ["dev-build@openrig-honcho"],
  }],
  ["text-around-pasted", {
    kind: "owner",
    peer: "owner",
    content:
      "Look at this text I pasted in:\n" +
      '<pasted_content id="27b1">\n' +
      "hello from the clipboard\n" +
      '</pasted_content id="27b1">\n' +
      "that is the whole message.",
  }],
  ["two-pasted-blocks", {
    kind: "owner",
    peer: "owner",
    content:
      '<pasted_content id="a1">\n' +
      "first paste\n" +
      '</pasted_content id="a1">\n' +
      '<pasted_content id="b2">\n' +
      "second paste\n" +
      '</pasted_content id="b2">',
  }],
  ["task-notification", { kind: "skip" }],
  ["slash-command", { kind: "skip" }],
];

describe("attribute: one assertion per fixture (kind, peer, content)", () => {
  for (const [name, expected] of cases) {
    test(name, () => {
      expect(attribute(fixture(name), ctx)).toEqual(expected);
    });
  }
});

describe("attribute: recordAutomation=false turns every automation into skip", () => {
  for (const name of ["identity-context", "daemon-kernel-sender", "system-health-sender"]) {
    test(name, () => {
      expect(attribute(fixture(name), ctxNoAuto)).toEqual({ kind: "skip" });
    });
  }
});

describe("attribute: inline edges", () => {
  test("empty prompt -> skip", () => {
    expect(attribute("", ctx)).toEqual({ kind: "skip" });
  });
  test("whitespace-only -> skip", () => {
    expect(attribute("  \n\t ", ctx)).toEqual({ kind: "skip" });
  });
  test("only a leading system-reminder -> skip after stripping", () => {
    expect(attribute("<system-reminder>nothing else here</system-reminder>", ctx)).toEqual({
      kind: "skip",
    });
  });
  test("bare slash command -> skip", () => {
    expect(attribute("/compact", ctx)).toEqual({ kind: "skip" });
  });
  test("slash-like text with args and no path injection -> owner (conservative)", () => {
    expect(attribute("/some random words", ctx).kind).toBe("owner");
  });
  test("slash-like text that IS an existing path -> owner, not a command", () => {
    const injected: AttrCtx = { ...ctx, isExistingPath: (p) => p === "/tmp" };
    const got = attribute("/tmp is missing", injected);
    expect(got.kind).toBe("owner");
    expect(got.kind === "owner" && got.content).toBe("/tmp is missing");
  });
  test("command name that is not a path -> skip, with the injection present", () => {
    const injected: AttrCtx = { ...ctx, isExistingPath: () => false };
    expect(attribute("/refocus please", injected)).toEqual({ kind: "skip" });
  });
});

describe("attribute: derived ids are validated (ADR-0003 f4f4b4c)", () => {
  const envFrom = (from: string) =>
    `From: ${from}\nTo: dev-build@openrig-honcho\n---\nbody\n---\n↩ Reply: rig send x "..."`;
  const unknown = (from: string) =>
    expect(attribute(envFrom(from), ctx)).toEqual({
      kind: "peer",
      peer: "unknown-sender",
      content: "body",
      to: ["dev-build@openrig-honcho"],
    });

  test('From "@" -> unknown-sender', () => unknown("@"));
  test('From "@external" -> "ext-" fails validation -> unknown-sender', () => unknown("@external"));
  test("sender with spaces -> unknown-sender", () => unknown("a b@openrig-honcho"));
  test("101-char local part -> unknown-sender", () => unknown(`${"a".repeat(101)}@openrig-honcho`));
  test("valid parts whose cross-rig join exceeds 100 -> unknown-sender", () =>
    unknown(`${"a".repeat(95)}@some-rig-name`)); // 95 + 1 + 13 = 109
  test("sender with a dot (not in the alphabet) -> unknown-sender", () =>
    unknown("alice.smith@openrig-honcho"));
  test("external name with a dot -> unknown-sender, not ext-alice.smith", () =>
    unknown("alice.smith@external"));

  test("100-char local part is still valid (boundary)", () => {
    const p = "a".repeat(100);
    const res = attribute(envFrom(`${p}@openrig-honcho`), ctx);
    expect(res.kind === "peer" && res.peer).toBe(p);
  });
  test("valid same-rig id unchanged", () => {
    const res = attribute(envFrom("alice_valid-1@openrig-honcho"), ctx);
    expect(res.kind === "peer" && res.peer).toBe("alice_valid-1");
  });
  test("valid external name unchanged", () => {
    const res = attribute(envFrom("bob@external"), ctx);
    expect(res.kind === "peer" && res.peer).toBe("ext-bob");
  });
  test("owner@external still maps to the configured owner peer", () => {
    const res = attribute(envFrom("owner@external"), ctx);
    expect(res.kind === "peer" && res.peer).toBe("owner");
  });
});

describe("parseEnvelope: details the Attribution shape drops", () => {
  test("Sent line kept verbatim, including gen and delivered parts", () => {
    expect(parseEnvelope(fixture("sent-with-gen-and-delivered"))?.sent).toBe(
      "10-28 04:12Z · gen 1a2b3c4d · delivered +12s",
    );
  });
  test("broadcast To parses to {broadcast} plus the seats count", () => {
    const env = parseEnvelope(fixture("rig-broadcast-to"));
    expect(env?.to).toEqual({ broadcast: "openrig-honcho" });
    expect(env?.fanout).toBe(3);
  });
  test("multi-recipient To parses to a trimmed array", () => {
    expect(parseEnvelope(fixture("multi-recipient-to"))?.to).toEqual([
      "dev-build@openrig-honcho",
      "dev-review@openrig-honcho",
    ]);
  });
  test("no fixture envelope without the ↩ close: malformed From: is null", () => {
    expect(parseEnvelope(fixture("fake-from-prefix"))).toBeNull();
  });
  test("closing separator is the LAST one: body keeps inner --- lines", () => {
    const env = parseEnvelope(fixture("body-with-separators-and-quoted-envelope"));
    expect(env?.body.startsWith("Notes on your draft:")).toBe(true);
    expect(env?.body.endsWith("Keep parsing it that way.")).toBe(true);
    expect(env?.body).toContain("From: fake@nowhere.example");
  });
  test("empty and junk inputs return null, never throw", () => {
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("---\n---\n")).toBeNull();
    expect(parseEnvelope("\n\n\n")).toBeNull();
    expect(parseEnvelope("From: a\nTo: b\n---\nbody without a reply hint")).toBeNull();
    expect(parseEnvelope("From: a\nNonsense: b\n---\nbody\n---\n↩ x")).toBeNull();
    expect(parseEnvelope("From: a\nTo: \n---\nbody\n---\n↩ x")).toBeNull();
  });
});

describe("peerIdFromSession", () => {
  test("same rig -> local part", () => {
    expect(peerIdFromSession("design-architect@openrig-honcho", "openrig-honcho")).toBe(
      "design-architect",
    );
  });
  test("other rig -> local_rig", () => {
    expect(peerIdFromSession("operator-agent@kernel", "openrig-honcho")).toBe(
      "operator-agent_kernel",
    );
  });
  test("no @ -> unchanged", () => {
    expect(peerIdFromSession("barename", "openrig-honcho")).toBe("barename");
  });
});

// Rulings edb8a30 (sender forms): a bare name in a well-formed envelope is
// not a daemon-stamped sender -> unknown-sender; owner@external stays owner.
describe("T4-fix: sender forms (edb8a30)", () => {
  const envFrom = (from: string) =>
    `From: ${from}\nTo: dev-build@openrig-honcho\n---\nbody\n---\n↩ Reply: rig send x "..."`;
  for (const from of ["owner", "Owner", "alice", "alice smith", "a@b@c", "@", "system"]) {
    test(`From: ${from} -> unknown-sender`, () => {
      const a = attribute(envFrom(from), ctx);
      expect(a.kind).toBe("peer");
      if (a.kind === "peer") expect(a.peer).toBe(UNKNOWN_SENDER_PEER);
    });
  }
  test("owner@external still resolves to the owner peer", () => {
    const a = attribute(envFrom("owner@external"), ctx);
    expect(a.kind).toBe("peer");
    if (a.kind === "peer") expect(a.peer).toBe(ctx.ownerPeer);
  });
  test("daemon@kernel and system:x keep automation", () => {
    for (const from of ["daemon@kernel", "system:health"]) {
      const a = attribute(envFrom(from), { ...ctx, recordAutomation: true });
      expect(a.kind).toBe("automation");
    }
  });
});
