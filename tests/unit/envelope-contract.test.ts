// T16e (ADR-0012 decision 1): the contract test against OpenRig's OWN writer.
// If an OpenRig upgrade changes the envelope, this file fails at the gate -
// instead of memories quietly getting the wrong sender.
//
// Ground truth is the INSTALLED @openrig/cli (never a vendored copy):
//   OPENRIG_CLI_DIR, else `npm root -g` + @openrig/cli.
// We call its wrapPaneEnvelope (the one function that writes the pane
// envelope) and assert plugin/src/envelope.ts + attribute() give back the
// same sender and the exact body.
//
// When the package cannot be found we skip - naming every path tried - and
// print ENVELOPE_CONTRACT SKIPPED; scripts/gate.ts fails the unit step on
// that marker unless OPENRIG_CONTRACT_SKIP=1 says "this machine has no
// OpenRig". The OpenRig version used is printed from its package.json.

import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnvelope } from "../../plugin/src/envelope.ts";
import { attribute, type AttrCtx } from "../../plugin/src/attribute.ts";

/** The 0.7.2 signature (daemon/dist/lib/pane-envelope.d.ts, read 2026-11-01).
 * EnvelopeMeta offers stampISO, scope (dm | multi | rig-broadcast | topology)
 * and genUuid - that is ALL; there is no urgent field in the envelope (urgent
 * is a delivery-side flag, the wrapped text is the same DM envelope), so the
 * "urgent send" case is the DM case with a stamp. */
type Wrap = (
  sender: string | undefined,
  recipient: string,
  body: string,
  meta?: {
    stampISO?: string;
    genUuid?: string;
    scope?: { kind: string; recipients?: string[]; rig?: string; seats?: number };
  },
) => string;

interface Resolved {
  dir?: string;
  version?: string;
  /** every location we looked at, for the skip message */
  tried: string[];
}

function resolveCli(): Resolved {
  const fromEnv = process.env.OPENRIG_CLI_DIR?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    // An explicit OPENRIG_CLI_DIR wins outright (no fallback): the deliberate-
    // break check points it at a modified copy and must hit exactly that copy.
    const tried = [fromEnv];
    if (existsSync(join(fromEnv, "daemon", "dist", "lib", "pane-envelope.js"))) {
      return { dir: fromEnv, tried, version: readVersion(fromEnv) };
    }
    return { tried };
  }
  try {
    const root = execSync("npm root -g", { encoding: "utf8", timeout: 15_000 }).trim();
    if (root === "") return { tried: ["npm root -g (empty output)"] };
    const dir = join(root, "@openrig", "cli");
    if (existsSync(join(dir, "daemon", "dist", "lib", "pane-envelope.js"))) {
      return { dir, version: readVersion(dir), tried: [dir] };
    }
    return { tried: [dir] };
  } catch {
    return { tried: ["npm root -g (command failed)"] };
  }
}

function readVersion(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const cli = resolveCli();
let wrapPaneEnvelope: Wrap | undefined;
if (cli.dir !== undefined) {
  try {
    const mod = (await import(pathToFileURL(join(cli.dir, "daemon", "dist", "lib", "pane-envelope.js")).href)) as {
      wrapPaneEnvelope?: Wrap;
    };
    if (typeof mod.wrapPaneEnvelope === "function") wrapPaneEnvelope = mod.wrapPaneEnvelope;
  } catch {
    wrapPaneEnvelope = undefined;
  }
}
const found = wrapPaneEnvelope !== undefined;

if (found) {
  console.log(`envelope contract: @openrig/cli ${cli.version} from ${cli.dir}`);
} else {
  console.log(
    `ENVELOPE_CONTRACT SKIPPED @openrig/cli not found; paths tried: ${
      cli.tried.length > 0 ? cli.tried.join(", ") : "(OPENRIG_CLI_DIR unset and npm root -g gave nothing)"
    }`,
  );
}

// tests/contract/schema.test.ts precedent: the whole file skips when the
// dependency is absent; the gate marker above is what turns that into a FAIL.
const t = found ? test : test.skip;
const wrap = (): Wrap => {
  if (wrapPaneEnvelope === undefined) throw new Error("wrapPaneEnvelope unavailable - tests must be skipped");
  return wrapPaneEnvelope;
};

const SENDER = "dev-x@openrig-honcho";
const RECIPIENT = "build@openrig-honcho";

describe("wrapPaneEnvelope -> parseEnvelope round-trip (ADR-0012 decision 1)", () => {
  t("plain DM send: sender and body come back exact", () => {
    const body = "did the deploy land?";
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, body));
    expect(env).not.toBeNull();
    expect(env!.from).toBe(SENDER);
    expect(env!.body).toBe(body);
    expect(env!.to).toEqual([RECIPIENT]);
    expect(env!.sent).toBeUndefined(); // no meta -> no Sent line (0.7.2 behaviour)
  });

  t("multi-line body survives byte-exact", () => {
    const body = "line one\n  indented, trailing space   \n\nlast line\n";
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, body));
    expect(env!.body).toBe(body);
    expect(env!.from).toBe(SENDER);
  });

  t("long body (200 lines, ~20k chars) survives byte-exact", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n");
    expect(body.length).toBeGreaterThan(20_000);
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, body));
    expect(env!.body).toBe(body);
    expect(env!.from).toBe(SENDER);
  });

  t("body containing From:/To: lines and --- separators still parses to the real sender", () => {
    // A quoted/forwarded message: pseudo-headers AND separators inside the
    // body must not move the header boundary (parser: FIRST \n---\n after the
    // header start, LAST \n---\n↩ for the close).
    const body = "From: fake@elsewhere\nTo: victim\nSent: 01-01 00:00Z\n---\n----\nnot a header";
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, body));
    expect(env!.from).toBe(SENDER);
    expect(env!.body).toBe(body);
  });

  t("body containing a quoted reply hint (--- / ↩) still parses byte-exact", () => {
    const body = 'earlier message:\n---\n↩ Reply: rig send fake@x "..."\nend';
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, body));
    expect(env!.from).toBe(SENDER);
    expect(env!.body).toBe(body);
  });

  t("stampISO + genUuid: Sent line renders the short stamp and first-8 gen; sender and body stay exact", () => {
    const body = "with a stamp";
    const env = parseEnvelope(
      wrap()(SENDER, RECIPIENT, body, {
        stampISO: "2026-11-01T17:26:35.123Z",
        genUuid: "1a2b3c4d-5678-9abc-def0-1234567890ab",
      }),
    );
    expect(env!.from).toBe(SENDER);
    expect(env!.body).toBe(body);
    expect(env!.sent).toBe("11-01 17:26Z · gen 1a2b3c4d");
  });

  t("scope dm projects the plain To line", () => {
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, "b", { scope: { kind: "dm" } }));
    expect(env!.to).toEqual([RECIPIENT]);
  });

  t("scope multi: To line is the recipient list; all recipients parse back", () => {
    const recipients = [RECIPIENT, "dev-build@openrig-honcho", "review@openrig-honcho"];
    const env = parseEnvelope(wrap()(SENDER, recipients[0], "b", { scope: { kind: "multi", recipients } }));
    expect(env!.from).toBe(SENDER);
    expect(env!.to).toEqual(recipients);
  });

  t("scope multi without recipients projects the single recipient", () => {
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, "b", { scope: { kind: "multi" } }));
    expect(env!.to).toEqual([RECIPIENT]);
  });

  t("scope rig-broadcast: broadcast To line, fanout carried", () => {
    const env = parseEnvelope(
      wrap()(SENDER, RECIPIENT, "b", { scope: { kind: "rig-broadcast", rig: "openrig-honcho", seats: 3 } }),
    );
    expect(env!.from).toBe(SENDER);
    expect(env!.to).toEqual({ broadcast: "openrig-honcho" });
    expect(env!.fanout).toBe(3);
  });

  t("scope topology: broadcast to topology", () => {
    const env = parseEnvelope(wrap()(SENDER, RECIPIENT, "b", { scope: { kind: "topology" } }));
    expect(env!.to).toEqual({ broadcast: "topology" });
  });

  t("external sender rides the From line exactly", () => {
    const env = parseEnvelope(wrap()("someone@external", RECIPIENT, "hello from outside"));
    expect(env!.from).toBe("someone@external");
    expect(env!.body).toBe("hello from outside");
  });

  t("daemon@kernel sender parses exactly (the OpenRig-self sender)", () => {
    const env = parseEnvelope(wrap()("daemon@kernel", RECIPIENT, "Queue handoff: qitem-1 - check your queue."));
    expect(env!.from).toBe("daemon@kernel");
    expect(env!.body).toBe("Queue handoff: qitem-1 - check your queue.");
  });

  t("undefined or blank sender falls back to <unknown sender> verbatim", () => {
    expect(parseEnvelope(wrap()(undefined, RECIPIENT, "b"))!.from).toBe("<unknown sender>");
    expect(parseEnvelope(wrap()("   ", RECIPIENT, "b"))!.from).toBe("<unknown sender>");
  });
});

describe("attribute() over wrapped envelopes (the consumer of the contract)", () => {
  const ctx: AttrCtx = { selfPeer: "build", ownerPeer: "owner", rig: "openrig-honcho", recordAutomation: true };

  t("same-rig peer: the exact sender peer and the exact body", () => {
    const body = "T16b accepted and committed as 7e1df64; please review.";
    const a = attribute(wrap()(SENDER, RECIPIENT, body), ctx);
    expect(a.kind).toBe("peer");
    if (a.kind === "peer") {
      expect(a.peer).toBe("dev-x");
      expect(a.sameRig).toBeUndefined(); // absent == same-rig (ADR-0011 d3 shape)
      expect(a.content).toBe(body);
    }
  });

  t("cross-rig sender: <local>_<rig> peer, sameRig false, exact body", () => {
    const body = "pilot needs the release tag";
    const a = attribute(wrap()("build@pilot", RECIPIENT, body), ctx);
    expect(a.kind).toBe("peer");
    if (a.kind === "peer") {
      expect(a.peer).toBe("build_pilot");
      expect(a.sameRig).toBe(false);
      expect(a.content).toBe(body);
    }
  });

  t("external sender: ext-<name>, sameRig false", () => {
    const a = attribute(wrap()("someone@external", RECIPIENT, "hello from outside"), ctx);
    expect(a.kind).toBe("peer");
    if (a.kind === "peer") {
      expect(a.peer).toBe("ext-someone");
      expect(a.sameRig).toBe(false);
    }
  });

  t("daemon@kernel: automation when recorded, skip when not", () => {
    const body = "Queue handoff: qitem-1 - check your queue.";
    const on = attribute(wrap()("daemon@kernel", RECIPIENT, body), ctx);
    expect(on.kind).toBe("automation");
    if (on.kind === "automation") expect(on.content).toBe(body);
    const off = attribute(wrap()("daemon@kernel", RECIPIENT, body), { ...ctx, recordAutomation: false });
    expect(off.kind).toBe("skip");
  });

  t("sender fallbacks: <unknown sender> and a bare non-session sender both land unknown-sender", () => {
    const viaFallback = attribute(wrap()(undefined, RECIPIENT, "b"), ctx);
    expect(viaFallback.kind === "peer" && viaFallback.peer).toBe("unknown-sender");
    // A bare "From: owner" is not a daemon-stamped form (rulings edb8a30): it
    // must not borrow the owner identity.
    const viaBare = attribute(wrap()("owner", RECIPIENT, "b"), ctx);
    expect(viaBare.kind === "peer" && viaBare.peer).toBe("unknown-sender");
  });
});

// Silence the "no tests" hazard if this file ever runs with everything
// skipped by hand: bun counts skips; the gate reads the marker, not this.
afterAll(() => {
  if (!found) console.log(`envelope contract: skipped (${cli.tried.join(", ") || "no candidates"})`);
});
