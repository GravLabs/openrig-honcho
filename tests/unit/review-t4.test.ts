// Review T4 (dev.review): redaction attacks (ADR-0003 "Redaction" table +
// "Encoded secrets" + "Rulings from review T4") and T3-fix-2 boundary checks
// ("Derived ids are validated"). Original verdict pinned at c3d6050; the
// re-review refresh (at pin 9006791) updates the two assertions the rulings
// changed (URL path tokens now redacted; glued same-shape strata = 2 matches)
// and adds the ruled-behaviour battery. F-1/F-1b now expect PASS per edb8a30.
//
// HARD LIMIT honoured: every secret below is a SYNTHETIC fake built from
// fixed literals in this file. No real value is read, printed or committed;
// the last describe() proves no long env var value on this host appears in
// this file's own bytes, without ever printing one.
//
// F-1/F-1b/F-2 keep their F- ids as the filed-finding trail; after the
// architect's rulings (edb8a30 + 10-28 11:03Z) all of them assert the RULED
// behaviour, so the file is fully green at 9006791.
import { describe, expect, test } from "bun:test";
import { redact } from "../../plugin/src/redact.ts";
import { attribute } from "../../plugin/src/attribute.ts";

// ---------- synthesized fake secret shapes (never real values) ----------
const FAKE_ANT_TAIL = "RevFake0123456789abcdefGHIJKL"; // 29 chars, [A-Za-z0-9_-]
const ANTH = `sk-ant-${FAKE_ANT_TAIL}`;
const STR_TAIL = "abcdefghij0123456789klmnopqrstuv"; // 32 lowercase alnum
const STR = `strata_${STR_TAIL}`;
const JWT = "eyJRevFakeHeader1.RevFakePayloadX.RevFakeSignature"; // fake-secret
const HEX64 = "0123456789abcdef".repeat(4); // 64 lc hex
const SHA40 = "0123456789abcdef0123456789abcdef01234567"; // 40 lc hex (git SHA shape)
// A real %-encoded opaque token: plain letters/digits with %XX for specials.
const PCTOK = "opaque1234RevFake%2FValueToken42xyz%3D%3D%2Bend"; // 45, up+low+digit, %2F inside — fake-secret
const OPAQUE40 = "Ab1cDe2fGh3iJk4lAb1cDe2fGh3iJk4lAb1cDe2f"; // exactly 40, up+low+digit — fake-secret
const PEM_PAIRED =
  "-----BEGIN RSA PRIVATE KEY-----\n" +
  "TUVBSU5PVEFSRUFMS0VZMTIzNDU2Nzg5YWJjZGVmZ2hpamtsTW9ja0JvRHkzNg==\n" + // fake-secret
  "-----END RSA PRIVATE KEY-----";

// Oracle copies of the impl patterns (module-private there) for post-scan.
const RX_ANTHROPIC = /sk-ant-[A-Za-z0-9_-]{20,}/;
const RX_STRATA = /strata_[0-9a-z]{32,}/;
const RX_JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const RX_HEX64 = /\b[0-9a-f]{64,}\b/;
const RX_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

// ------------------------------- 1. shapes -------------------------------
describe("T4-1 each ADR shape redacts once, with its kind label", () => {
  const cases: Array<[string, string, string, string]> = [
    ["anthropic", `model key ${ANTH} saved`, "anthropic", FAKE_ANT_TAIL],
    ["strata", `strata token ${STR}`, "strata", STR_TAIL],
    ["jwt", `jwt here ${JWT}`, "jwt", "RevFakeSignature"],
    ["bearer(label)", `Authorization: Bearer Ab1cReviewTokenValue12`, "bearer", "Ab1cReviewTokenValue12"], // fake-secret
    ["basic(label)", `Authorization: Basic UGVvcGxlVXNlclBhc3Mx`, "bearer", "UGVvcGxlVXNlclBhc3Mx"], // fake-secret
    ["bearer(bare)", `bearer AbCdEfGhIjKlMn123456`, "bearer", "AbCdEfGhIjKlMn123456"], // fake-secret
    ["pem", `key:\n${PEM_PAIRED}\ndone`, "pem", "TUVBSU5PVEFSRUFMS0VZ"],
    ["assignment", "API_KEY=SuperFakeValue123", "assignment", "SuperFakeValue123"], // fake-secret
    ["json-secret", '{"api_key": "jsonFakeValue123"}', "json-secret", "jsonFakeValue123"], // fake-secret
    ["hex64", `commit ${HEX64} pushed`, "hex64", HEX64],
    ["opaque", `blob ${OPAQUE40} inline`, "opaque", OPAQUE40],
    ["opaque %-encoded", `tok ${PCTOK} end`, "opaque", PCTOK],
  ];
  for (const [name, input, kind, fake] of cases) {
    test(name, () => {
      const r = redact(input);
      expect(r.counts[kind]).toBeGreaterThanOrEqual(1);
      expect(r.text).toContain(`[REDACTED:${kind}]`);
      expect(r.text).not.toContain(fake);
    });
  }

  test("exact marker format", () => {
    expect(redact(ANTH).text).toBe("[REDACTED:anthropic]");
  });

  test("empty input -> empty counts, unchanged", () => {
    const r = redact("");
    expect(r.text).toBe("");
    expect(Object.keys(r.counts).length).toBe(0);
  });

  test("'basic ' bare word is deliberately NOT a bearer label (ADR 70ee11e)", () => {
    const r = redact("basic AbCdEfGhIjKlMn123456 is prose");
    expect(r.counts.bearer).toBeUndefined();
  });
});

// --------------------------- 2. just-outside -----------------------------
describe("T4-2 shape boundaries: just-outside values are kept untouched", () => {
  const kept: Array<[string, string]> = [
    ["anthropic tail 19", `sk-ant-${FAKE_ANT_TAIL.slice(0, 19)}`],
    ["strata tail 31", `strata_${STR_TAIL.slice(0, 31)}`],
    ["jwt 7-char segs", "eyJRevHead1.RevPayl.RevSign"],
    ["bearer value 15", "Authorization: Bearer Abc123Defg45678"],
    ["assignment value 7", "API_KEY=1234567"],
    ["json value 7", '{"api_key": "1234567"}'],
    ["hex63", "0123456789abcdef0123456789abcdef0123456789abcde"],
    ["git SHA 40", SHA40],
    ["opaque 39", "Ab1".repeat(13)],
    ["opaque no upper", "ab1".repeat(15)],
    ["opaque no lower", "AB1".repeat(15)],
    ["opaque no digit", "AbCd".repeat(15)],
    ["path run", `/home/user/projects/${OPAQUE40}/src`],
    ["home path run", `~/${OPAQUE40}/x`],
    // "url path run" MOVED to the T4-fix battery: rulings edb8a30 redact URL
    // path tokens (scheme+host kept), so this is no longer a kept case.
    ["prose", "the quick brown fox reviews 0123456789 redaction daily"],
  ];
  for (const [name, input] of kept) {
    test(name, () => {
      const r = redact(input);
      expect(r.text).toBe(input);
      expect(Object.keys(r.counts).length).toBe(0);
    });
  }

  test("just-inside values redact: 20-tail, 32-strata, 16-bearer, 8-assign, 40-opaque, 64-hex", () => {
    expect(redact(`sk-ant-${FAKE_ANT_TAIL.slice(0, 20)}`).counts.anthropic).toBe(1);
    expect(redact(STR).counts.strata).toBe(1);
    expect(redact("Authorization: Bearer Abc123Defg456789").counts.bearer).toBe(1);
    expect(redact("API_KEY=12345678").counts.assignment).toBe(1); // fake-secret
    expect(redact(`x ${"Ab1".repeat(13)}c y`).counts.opaque).toBe(1);
    expect(redact(`commit ${HEX64} x`).counts.hex64).toBe(1);
  });

  test("token in a URL query IS opaque (only path/URL runs are exempt)", () => {
    const r = redact(`https://api.example.com/v1?k=${OPAQUE40}`);
    expect(r.counts.opaque).toBe(1);
    expect(r.text).not.toContain(OPAQUE40);
  });
});

// ------------------------- 3. spans and collisions -----------------------
describe("T4-3 span collisions and table-order consequences", () => {
  test("jwt inside 'Bearer' consumed once by jwt, bearer guard skips it", () => {
    const r = redact(`Authorization: Bearer ${JWT}`);
    expect(r.counts).toEqual({ jwt: 1 });
    expect(r.text).toContain("[REDACTED:jwt]");
    expect(r.text).not.toContain("[REDACTED:bearer]");
    expect(r.text).not.toContain("eyJ");
  });

  test("'API_TOKEN=<jwt>': jwt wins, assignment name kept, assignment not counted", () => {
    const r = redact(`API_TOKEN=${JWT}`);
    expect(r.counts).toEqual({ jwt: 1 });
    expect(r.text).toContain("API_TOKEN=[REDACTED:jwt]");
  });

  test("'API_KEY=<64hex>' counts assignment, not hex64 (name kept)", () => {
    const r = redact(`API_KEY=${HEX64}`);
    expect(r.counts).toEqual({ assignment: 1 });
    expect(r.text).toBe("API_KEY=[REDACTED:assignment]");
  });

  test("two separated anthropic keys count twice", () => {
    expect(redact(`${ANTH} and ${ANTH}`).counts.anthropic).toBe(2);
  });

  test("secret inside literal marker text is still caught", () => {
    const r = redact(`[REDACTED:${ANTH}]`);
    expect(r.counts.anthropic).toBe(1);
    expect(r.text).not.toContain(FAKE_ANT_TAIL);
  });

  test("literal marker text survives and the adjacent real key is caught", () => {
    const r = redact(`[REDACTED:anthropic] then ${ANTH}`);
    expect(r.counts.anthropic).toBe(1);
    expect(countOf(r.text, "[REDACTED:anthropic]")).toBe(2);
    expect(r.text).not.toContain(FAKE_ANT_TAIL);
  });
});

// ------------------------------- 4. PEM ----------------------------------
describe("T4-4 PEM: paired shape only", () => {
  test("paired LF block -> pem 1, whole block replaced", () => {
    const r = redact(PEM_PAIRED);
    expect(r.counts).toEqual({ pem: 1 });
    expect(r.text).toBe("[REDACTED:pem]");
  });

  test("CRLF block -> pem 1", () => {
    const r = redact(PEM_PAIRED.replace(/\n/g, "\r\n"));
    expect(r.counts).toEqual({ pem: 1 });
  });

  test("two paired blocks -> pem 2", () => {
    expect(redact(`${PEM_PAIRED} x ${PEM_PAIRED}`).counts.pem).toBe(2);
  });

  test("unterminated BEGIN: pem never counts it; the key-shaped body line is still opaque-redacted", () => {
    const body = "TUVBSU5PVEFSRUFMS0VZMTIzNDU2Nzg5YWJjZGVmZ2hpamtsTW9ja0JvRHkzNg=="; // fake-secret
    const r = redact(`-----BEGIN RSA PRIVATE KEY-----\n${body}\n(still writing)`);
    expect(r.counts.pem).toBeUndefined();
    expect(r.counts.opaque).toBe(1);
    expect(r.text).not.toContain(body);
  });

  test("PUBLIC KEY block is not secret material -> untouched", () => {
    const input =
      "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiSpublixonlynocifher\n-----END PUBLIC KEY-----";
    const r = redact(input);
    expect(r.counts.pem).toBeUndefined();
    expect(r.text).toBe(input);
  });
});

// --------------------- 5. reassembly / fixed point -----------------------
describe("T4-5 reassembly and fixed point", () => {
  test("prefix-glued shapes still redact: s+ANTH, x+STR, ey+JWT", () => {
    expect(redact(`s${ANTH}`).counts.anthropic).toBe(1);
    expect(redact(`x${STR}`).counts.strata).toBe(1); // the "strata_" literal survives gluing
    expect(redact(`ey${JWT}`).counts.jwt).toBe(1);
  });

  test("redact(redact(x)) is a fixed point in text and counts", () => {
    const battery = [
      `model key ${ANTH} saved`,
      `strata token ${STR}`,
      `jwt here ${JWT}`,
      `Authorization: Bearer ${JWT}`,
      `Authorization: Basic UGVvcGxlVXNlclBhc3Mx`, // fake-secret
      `key:\n${PEM_PAIRED}`,
      "API_KEY=SuperFakeValue123", // fake-secret
      '{"api_key": "jsonFakeValue123"}', // fake-secret
      `commit ${HEX64} pushed`,
      `blob ${OPAQUE40} inline`,
    ].join("\n");
    const r1 = redact(battery);
    // the catch{} fallback would return the input unchanged with empty counts
    expect(r1.text).not.toBe(battery);
    expect(r1.counts).toEqual({
      anthropic: 1,
      strata: 1,
      jwt: 2,
      bearer: 1,
      pem: 1,
      assignment: 1,
      "json-secret": 1,
      hex64: 1,
      opaque: 1,
    });
    const r2 = redact(r1.text);
    expect(r2.text).toBe(r1.text);
    expect(Object.keys(r2.counts)).toEqual([]);
  });

  test("json-secret keeps the blob parseable", () => {
    const r = redact('{"access_token": "veryfakevalue999", "user": "bob"}'); // fake-secret
    expect(r.counts).toEqual({ "json-secret": 1 });
    const parsed = JSON.parse(r.text);
    expect(parsed.access_token).toBe("[REDACTED:json-secret]");
    expect(parsed.user).toBe("bob");
  });

  // F-1 (filed at c3d6050, ruled FIX by edb8a30 "glued secrets"): two same-
  // shape secrets glued with NO separator are now TWO matches, no body
  // survives. Refreshed at pin 9006791 to expect the ruled behaviour.
  test("F-1 (ruled): glued strata -> two matches, no body survives", () => {
    const r = redact(STR + STR);
    expect(r.counts.strata).toBe(2);
    expect(r.text).toBe("[REDACTED:strata][REDACTED:strata]");
    const r3 = redact(STR + STR + STR);
    expect(r3.counts.strata).toBe(3);
    expect(r3.text).not.toContain(STR_TAIL);
  });

  // F-1b (same ruling): glued jwt pair -> two matches, no raw segment.
  test("F-1b (ruled): adjacent jwt secrets -> two matches, no segment survives", () => {
    const r = redact(JWT + JWT);
    expect(r.counts.jwt).toBe(2);
    expect(r.text).toBe("[REDACTED:jwt][REDACTED:jwt]");
    expect(r.text).not.toContain("RevFakePayloadX");
    expect(r.text).not.toContain("RevFakeSignature");
  });

  // F-2 (filed at the re-review, ruled ACCEPTED DOCUMENTED GAP by the
  // architect 10-28 11:03Z): cross-KIND glue - `API_KEY` is composed only of
  // anthropic body-class chars ([A-Za-z0-9_-]), so the lazy body extends
  // across "API_KEY" and stops at "=", orphaning the value. Contrived
  // zero-separator input; values >= 40 with upper+lower+digit are still
  // caught by opaque. Asserted as documented behaviour: short survives, long
  // redacted.
  test("F-2 (ruled gap): cross-kind glue - short value survives, long one is redacted", () => {
    const shortR = redact(`${ANTH}API_KEY=SuperFakeValue123`); // fake-secret
    expect(shortR.text).toBe("[REDACTED:anthropic]=SuperFakeValue123"); // documented gap
    expect(shortR.counts).toEqual({ anthropic: 1 });
    const long = "SuperFakeValueLongEnough42ToBeCaughtByOpaqueRule"; // 48, mixed class — fake-secret
    const longR = redact(`${ANTH}API_KEY=${long}`);
    expect(longR.text).not.toContain(long);
    expect(longR.counts).toEqual({ anthropic: 1, opaque: 1 });
  });

  test("cross-kind glue orders that ARE safe (documented behaviour)", () => {
    expect(redact(STR + ANTH).text).not.toContain(FAKE_ANT_TAIL); // anthropic runs first, keeps its own shape
    expect(redact(ANTH + STR).text).not.toContain(STR_TAIL); // anthropic class covers strata: whole run replaced
    expect(redact(STR + JWT).text).not.toContain("RevFakePayloadX"); // survivor >=40 mixed -> opaque backstop
    expect(redact(STR + `{"access_token": "jsonFakeValue123"}`).text).not.toContain("jsonFakeValue123"); // fake-secret
  });
});

// ------------------------------- 6. fuzz ---------------------------------
describe("T4-6 S1 fuzz: 10 000 mutations of fixtures + fakes, never throws, no shape survives", () => {
  test("redact() never throws and its unguarded shapes never survive", async () => {
    const dir = new URL("../fixtures/prompts/", import.meta.url);
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(dir.pathname)).sort();
    expect(entries.length).toBeGreaterThanOrEqual(21);
    const corpus: string[] = [];
    for (const n of entries) corpus.push(await Bun.file(`${dir.pathname}/${n}`).text());
    corpus.push(ANTH, STR, JWT, HEX64, OPAQUE40, PEM_PAIRED, "API_KEY=x", "{}", SHA40);

    const tokens = [
      "sk-ant-", "strata_", "eyJ", "Bearer ", "Authorization: Basic ", "-----BEGIN RSA PRIVATE KEY-----",
      "-----END RSA PRIVATE KEY-----", "API_KEY=", '"access_token": "', OPAQUE40, FAKE_ANT_TAIL,
      "[REDACTED:anthropic]", "[REDACTED:opaque]", "%40", "://", "---", '"', "'", " ", "\n", "sk-an", "strata",
    ];
    let s = 123456789;
    const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);

    for (let i = 0; i < 10_000; i++) {
      let t = corpus[Math.floor(rnd() * corpus.length)];
      const muts = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < muts; m++) {
        const op = Math.floor(rnd() * 5);
        const pos = Math.floor(rnd() * (t.length + 1));
        if (op === 0) t = t.slice(0, pos);
        else if (op === 1) t = t.slice(pos);
        else if (op === 2) t = t.slice(0, pos) + tokens[Math.floor(rnd() * tokens.length)] + t.slice(pos);
        else if (op === 3) t = t.slice(0, pos) + t.slice(pos + 1 + Math.floor(rnd() * 30));
        else t = t + tokens[Math.floor(rnd() * tokens.length)];
      }
      let r: ReturnType<typeof redact> | undefined;
      expect(() => { r = redact(t); }).not.toThrow();
      expect(typeof r!.text).toBe("string");
      // silent catch{} means text unchanged + counts empty on secret-bearing
      // input; every count must be a positive integer
      for (const v of Object.values(r!.counts)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      // post-scan: the unguarded kinds must not match their own output
      expect(r!.text).not.toMatch(RX_ANTHROPIC);
      expect(r!.text).not.toMatch(RX_STRATA);
      expect(r!.text).not.toMatch(RX_JWT);
      expect(r!.text).not.toMatch(RX_HEX64);
      expect(r!.text).not.toMatch(RX_PEM);
    }
  });
});

// ------------------------------- 7. perf ---------------------------------
describe("T4-7 2 MB prompt stays far inside the hook budget", () => {
  test("2 MB with 40 injected fakes: < 500 ms, all fakes gone", () => {
    const line = "review filler prose 0123456789 abcdefghijklmnopQRSTUVW xyz.\n";
    let big = "";
    for (let i = 0; big.length < 2 * 1024 * 1024; i++) {
      big += line;
      if (i % 10_000 === 0) big += `${ANTH}\n${JWT}\n`;
    }
    expect(big.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
    const t0 = performance.now();
    const r = redact(big);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(r.counts.anthropic).toBeGreaterThanOrEqual(1);
    expect(r.text).not.toContain(FAKE_ANT_TAIL);
    expect(r.text).not.toContain("RevFakePayloadX");
  });
});

// ----------------------- 8. T3-fix-2 derived ids -------------------------
describe("T3-fix-2 derived-id boundary (ADR-0003 'Derived ids are validated')", () => {
  const ctx = { selfPeer: "dev-review", ownerPeer: "owner", rig: "openrig-honcho", recordAutomation: false };
  const ENVID = (from: string) =>
    `From: ${from}\nTo: dev-review@openrig-honcho\n---\nbody\n---\n↩ Reply: rig send x "..."`;
  const peerOf = (from: string) => attribute(ENVID(from), ctx);

  // Every peer id attribute() can emit must itself be a legal Honcho peer id.
  const PEER_RE = /^[A-Za-z0-9_-]{1,100}$/;

  test("invalid derived ids -> unknown-sender, always kind peer (never owner/profile)", () => {
    const invalid = [
      "@",                                  // architect probe
      "@external",                          // empty external name
      "a b@rig",                            // space
      "a b@openrig-honcho",
      "dév@rig",                            // accent
      "é@external",                         // non-ascii ext name
      `${"a".repeat(101)}@openrig-honcho`,  // 101-char local, same rig
      `${"a".repeat(101)}@x-rig`,           // 101-char local, cross rig
      `${"a".repeat(100)}@x-rig`,           // composed 100+1+5 > 100
      `ext@external${"x".repeat(99)}@`,     // weird multi-at
      `${"x".repeat(99)}@external`,         // composed ext-99 = 103 > 100
      "tab\tdev@x-rig",                     // tab inside local
    ];
    for (const from of invalid) {
      const res = peerOf(from);
      expect(res.kind).toBe("peer");
      if (res.kind === "peer") {
        expect(res.peer).toBe("unknown-sender");
        expect(PEER_RE.test(res.peer)).toBe(true);
      }
    }
  });

  test("valid derived ids still map per ADR (no over-redaction of identity)", () => {
    const ok: Array<[string, string]> = [
      ["dev-build@openrig-honcho", "dev-build"],
      ["operator-agent@kernel", "operator-agent_kernel"],
      ["owner@external", "owner"],           // owner name wins, kind peer
      ["bob@external", "ext-bob"],
      ["<unknown sender>", "unknown-sender"],
      [`${"a".repeat(100)}@openrig-honcho`, "a".repeat(100)], // exactly 100 kept
      [`${"y".repeat(96)}@external`, `ext-${"y".repeat(96)}`], // composed exactly 100
    ];
    for (const [from, want] of ok) {
      const res = peerOf(from);
      expect(res.kind).toBe("peer");
      if (res.kind === "peer") {
        expect(res.peer).toBe(want);
        expect(PEER_RE.test(res.peer)).toBe(true);
      }
    }
  });

  test("owner@external is kind peer (profile write keys on kind owner, so no profile touch)", () => {
    const res = peerOf("owner@external");
    expect(res.kind).toBe("peer");
  });

  test("malformed pseudo-headers still fall to owner, unchanged by T3-fix-2", () => {
    expect(peerOf("").kind).toBe("owner");           // From: <empty> -> not an envelope
    expect(attribute(ENVID("   ").replace("From:    ", "From:  \t"), ctx).kind).toBe("owner");
  });
});

// ------------------- 9. T4-fix rulings battery (edb8a30) -----------------
describe("T4R-1 lazy bodies: single long bodies are consumed whole", () => {
  for (const [name, body] of [
    ["strata 33", "ab1".repeat(11)],
    ["strata 64", STR_TAIL + STR_TAIL],
    ["strata 200", "a1b2".repeat(50)],
  ] as Array<[string, string]>) {
    test(name, () => {
      const r = redact(`x strata_${body} y`);
      expect(r.counts).toEqual({ strata: 1 });
      expect(r.text).toBe("x [REDACTED:strata] y");
    });
  }

  for (const n of [20, 40, 120]) {
    test(`anthropic tail ${n}`, () => {
      const r = redact(`k sk-ant-${"aB1c".repeat(n / 4)} end`);
      expect(r.counts).toEqual({ anthropic: 1 });
      expect(r.text).toBe("k [REDACTED:anthropic] end");
    });
  }

  test("jwt with 50-char segments consumed whole", () => {
    const seg = "Ab1cDe2fGh".repeat(5);
    const r = redact(`t eyJ${seg}.${seg}.${seg} y`);
    expect(r.counts).toEqual({ jwt: 1 });
    expect(r.text).toBe("t [REDACTED:jwt] y");
  });

  test("glued anthropic pair -> two exact markers", () => {
    expect(redact(ANTH + ANTH).text).toBe("[REDACTED:anthropic][REDACTED:anthropic]");
  });

  test("glued strata pair keeps the assignment name if glued after one", () => {
    const r = redact(`API_TOKEN=${STR}${STR}`);
    expect(r.counts.strata).toBe(2);
    expect(r.text).toBe("API_TOKEN=[REDACTED:strata][REDACTED:strata]");
  });
});

describe("T4R-2 URL handling per ruling: scheme+host excluded, path/query checked", () => {
  test("path token redacted, scheme+host kept", () => {
    const r = redact(`fetch https://host.example/${OPAQUE40} done`);
    expect(r.counts).toEqual({ opaque: 1 });
    expect(r.text).toBe("fetch https://host.example[REDACTED:opaque] done");
  });

  test("uppercase scheme behaves the same", () => {
    const r = redact(`HTTPS://host.example/${OPAQUE40}`);
    expect(r.counts.opaque).toBe(1);
    expect(r.text).not.toContain(OPAQUE40);
  });

  test("mixed-class path without a token: over-redaction is the safe direction", () => { // fake-secret
    // A >=40 path with upper+lower+digit is indistinguishable from a token;
    // the ruling accepts collateral here. Documented, not filed.
    const r = redact("see https://host.example/Docs/Report2026SummaryPageThreeAndSomeMoreWords first"); // fake-secret
    expect(r.counts.opaque).toBe(1);
    expect(r.text).toContain("https://host.example[REDACTED:opaque]");
  });

  test("docs path without mixed class kept", () => {
    const input = "https://host.example/docs/getting-started-v2-and-a-few-more-words-here";
    const r = redact(input);
    expect(r.text).toBe(input);
    expect(Object.keys(r.counts).length).toBe(0);
  });

  test("bare host kept; a mixed-class token AS the host is kept (ruling excludes host)", () => {
    const r = redact(`h https://${OPAQUE40}/ x`);
    expect(r.text).toContain(OPAQUE40); // documented consequence of the host exclusion
    expect(r.counts.opaque).toBeUndefined();
  });

  test("schemeless //host/<token> is a URL: path redacted, host kept (T4-fix-2 88e1754)", () => {
    // Flipped per the deferral note: ruled a URL by the architect (10-28
    // 11:03Z), fixed by build in 88e1754. Rerun probes at the pin before the
    // flip: text "see //host.example[REDACTED:opaque]", counts {opaque:1}.
    const r = redact(`see //host.example/${OPAQUE40}`);
    expect(r.counts).toEqual({ opaque: 1 });
    expect(r.text).toBe("see //host.example[REDACTED:opaque]");
  });

  test("short path kept, query token still redacted", () => {
    const r = redact(`https://host.example/v1?k=${OPAQUE40}`);
    expect(r.counts.opaque).toBe(1);
    expect(r.text).toContain("/v1");
    expect(r.text).not.toContain(OPAQUE40);
  });
});

describe("T4R-3 json keys case-insensitive, kept case, parseable, idempotent", () => {
  for (const key of ["Access_Token", "REFRESH_TOKEN", "Id_Token", "API_KEY", "App_Secret", "CLIENT_SECRET"]) {
    test(key, () => {
      const r = redact(`{"${key}": "caseFakeValue9"}`);
      expect(r.counts).toEqual({ "json-secret": 1 });
      expect(r.text).toContain(`"${key}": "[REDACTED:json-secret]"`); // original case kept
      expect(() => JSON.parse(r.text)).not.toThrow();
      expect(redact(r.text).counts).toEqual({});
    });
  }
});

describe("T4R-4 ruled battery: exact counts then a fixed point", () => {
  test("combined input: exact counts, second pass changes nothing", () => {
    const battery = [
      `a ${STR}${STR} b`,
      ANTH + ANTH,
      `{"Access_Token": "caseFakeValue9"}`, // fake-secret
      `fetch https://host.example/${OPAQUE40} done`,
      "https://host.example/docs/getting-started-v2-and-a-few-more-words-here",
      `/home/user/${OPAQUE40}/src`,
    ].join("\n");
    const r1 = redact(battery);
    expect(r1.counts).toEqual({ strata: 2, anthropic: 2, "json-secret": 1, opaque: 1 });
    const r2 = redact(r1.text);
    expect(r2.text).toBe(r1.text);
    expect(Object.keys(r2.counts)).toEqual([]);
  });
});

describe("T4R-5 sender forms (ruling: non-daemon forms are unknown-sender)", () => {
  const ctx = { selfPeer: "dev-review", ownerPeer: "owner", rig: "openrig-honcho", recordAutomation: false };
  const ENVID = (from: string) =>
    `From: ${from}\nTo: dev-review@openrig-honcho\n---\nbody\n---\n↩ Reply: rig send x "..."`;

  test("non-daemon-form senders -> unknown-sender, kind peer (never owner)", () => {
    for (const from of ["owner", "hi", "a", "user@", "@rig", "a b@c", "a@b@c", "dev@rig@extra", "system x", "owner two@x"]) {
      const res = attribute(ENVID(from), ctx);
      expect(res.kind).toBe("peer");
      if (res.kind === "peer") expect(res.peer).toBe("unknown-sender");
    }
  });

  test("daemon forms still map, and the special senders keep their rulings", () => {
    const ok: Array<[string, string]> = [
      ["dev-build@openrig-honcho", "dev-build"],
      ["a@b", "a_b"],
      ["owner@openrig-honcho", "owner"], // <local>@<rig> form; local equals ownerPeer (pre-existing collision, kind peer)
      ["bob@external", "ext-bob"],
      ["owner@external", "owner"],
      ["<unknown sender>", "unknown-sender"],
      ["dév@rig", "unknown-sender"], // daemon form, but derived id fails the charset
    ];
    for (const [from, want] of ok) {
      const res = attribute(ENVID(from), ctx);
      expect(res.kind).toBe("peer");
      if (res.kind === "peer") expect(res.peer).toBe(want);
    }
  });

  test("automation senders unaffected by the form gate", () => {
    expect(attribute(ENVID("daemon@kernel"), ctx).kind).toBe("skip");
    expect((attribute(ENVID("system:health"), { ...ctx, recordAutomation: true }) as any).peer).toBe("openrig");
  });
});

// --------------------------- 10. no-real-secret guard --------------------
describe("T4-9 no real credential value from this host appears in this test file", () => {
  test("no env var value (>= 8 chars) is embedded in review-t4.test.ts bytes", async () => {
    // F18 (R11): the floor must not depend on WHICH host runs it - a Codex
    // seat has no credential-shaped variable by design, and the suite was
    // 1611/1 there. Plant a marked dummy so the loop always has at least
    // one known subject. The value is built from fragments so THIS file's
    // bytes never contain the whole string the loop searches for - the
    // check stays honest on its own file too. Deleted in finally so no
    // later child spawn inherits it.
    const planted = ["mark", "ed-dummy", "-value-7f3a"].join("");
    process.env.CODEX_SCANTOOL_DUMMY = planted;
    try {
      const src = await Bun.file(new URL("./review-t4.test.ts", import.meta.url)).text();
      let checked = 0;
      for (const [name, value] of Object.entries(process.env)) {
        if (!value || value.length < 8) continue;
        if (!/HONCHO|ANTHROPIC|OPENAI|CODEX|AWS|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) continue;
        expect(src).not.toContain(value); // boolean check; the value is never printed
        checked++;
      }
      // honest floor: the check must actually have compared something meaningful
      expect(checked).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.CODEX_SCANTOOL_DUMMY;
    }
  });
});
