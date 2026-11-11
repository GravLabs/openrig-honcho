// T4: redaction (ADR-0003 "Redaction" table, 9 kinds). HARD LIMIT: every
// value here is synthesized from the table's shapes with a seeded RNG - no
// real value is ever read, printed or copied; no variable file is opened.
// The ADR table is the only source for the shapes below.

import { describe, expect, test } from "bun:test";
import { redact } from "../../plugin/src/redact.ts";

// Seeded LCG so a failure is reproducible byte-for-byte on rerun.
let seed = 0x5eed1e;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const rand = (n: number, chars: string): string =>
  Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join("");

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // fake-secret
const LOWER36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"; // fake-secret
const HEX = "0123456789abcdef";

// One fake per ADR kind, plus the exact whole-string result and the secret
// substring that must never survive.
interface Fake {
  kind: string;
  make: () => { input: string; secret: string; alone: string };
}

const fakes: Fake[] = [
  {
    kind: "anthropic",
    make: () => {
      const secret = `sk-ant-${rand(40, B64URL)}`;
      return { input: secret, secret, alone: "[REDACTED:anthropic]" };
    },
  },
  {
    kind: "strata",
    make: () => {
      const secret = `strata_${rand(32, LOWER36)}`;
      return { input: secret, secret, alone: "[REDACTED:strata]" };
    },
  },
  {
    kind: "jwt",
    make: () => {
      const secret = `eyJ${rand(12, B64URL)}.${rand(12, B64URL)}.${rand(12, B64URL)}`;
      return { input: secret, secret, alone: "[REDACTED:jwt]" };
    },
  },
  {
    // bearer replaces label + value together (the contract keeps names only
    // for assignment and json-secret)
    kind: "bearer",
    make: () => {
      const secret = rand(30, ALNUM);
      return { input: `Authorization: Bearer ${secret}`, secret, alone: "[REDACTED:bearer]" };
    },
  },
  {
    kind: "pem",
    make: () => {
      const body = rand(60, ALNUM);
      return {
        input: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----`, // fake-secret
        secret: body,
        alone: "[REDACTED:pem]",
      };
    },
  },
  {
    kind: "assignment",
    make: () => {
      const secret = rand(40, ALNUM);
      return {
        input: `BROKER_APP_SECRET=${secret}`,
        secret,
        alone: "BROKER_APP_SECRET=[REDACTED:assignment]",
      };
    },
  },
  {
    kind: "json-secret",
    make: () => {
      const secret = rand(24, ALNUM);
      return {
        input: `{"access_token":"${secret}"}`, // fake-secret
        secret,
        alone: '{"access_token":"[REDACTED:json-secret]"}',
      };
    },
  },
  {
    kind: "hex64",
    make: () => {
      const secret = rand(64, HEX);
      return { input: secret, secret, alone: "[REDACTED:hex64]" };
    },
  },
  {
    kind: "opaque",
    make: () => {
      let secret = "";
      do {
        secret = rand(44, ALNUM);
      } while (!/[A-Z]/.test(secret) || !/[a-z]/.test(secret) || !/\d/.test(secret));
      return { input: secret, secret, alone: "[REDACTED:opaque]" };
    },
  },
];

describe("redact: each of the 9 ADR kinds, alone and inside a sentence", () => {
  for (const { kind, make } of fakes) {
    test(`${kind} alone`, () => {
      const { input, secret, alone } = make();
      const { text, counts } = redact(input);
      expect(text).toBe(alone);
      expect(text).not.toContain(secret);
      expect(counts[kind]).toBe(1);
    });
    test(`${kind} inside a sentence`, () => {
      const { input, secret, alone } = make();
      const { text, counts } = redact(`before ${input} after`);
      expect(text).toBe(`before ${alone} after`);
      expect(text).not.toContain(secret);
      expect(counts[kind]).toBe(1);
    });
  }
});

describe("O6 N-B: GitHub and GitLab token prefixes", () => {
  // One fake per shipped prefix shape (R15 N-B: short tokens of these
  // shapes survive opaque - they need a named rule). All values synthetic.
  const cases: [string, string][] = [
    ["ghp_", `ghp_${rand(36, ALNUM)}`], // fake-secret
    ["gho_", `gho_${rand(36, ALNUM)}`], // fake-secret
    ["ghs_", `ghs_${rand(36, ALNUM)}`], // fake-secret
    ["ghu_", `ghu_${rand(36, ALNUM)}`], // fake-secret
    [`github_pat_${rand(20, ALNUM)}_${rand(44, ALNUM)}`, `github_pat_${rand(20, ALNUM)}_${rand(44, ALNUM)}`], // fake-secret
    ["glpat-", `glpat-${rand(20, LOWER36)}`],
  ];
  for (const [label, token] of cases) {
    test(`masks ${label}* alone and in a sentence`, () => {
      expect(redact(token).text).toBe("[REDACTED:gittoken]");
      expect(redact(token).counts.gittoken).toBe(1);
      const r = redact(`pushed with token ${token} yesterday`);
      expect(r.text).toBe("pushed with token [REDACTED:gittoken] yesterday");
      const body = token.slice(token.startsWith("github_pat_") ? 11 : token.indexOf("_") + 1);
      expect(r.text).not.toContain(body.slice(0, 10));
    });
  }
  test("kept: a short body or a bare prefix is not a token", () => {
    expect(redact("ghp_short").text).toBe("ghp_short"); // fake-secret
    expect(redact("glpat- alone").text).toBe("glpat- alone");
  });
  test("idempotent on the masked form", () => {
    const once = redact(`ghp_${rand(36, ALNUM)}`).text; // fake-secret
    expect(redact(once).text).toBe(once);
  });
});

describe("O7 N2/N1: word boundary, real minimum lengths, the full GitLab family", () => {
  // Second security pass on 7ac023e: the N-B rule had no word boundary and
  // a 6-char body, so ordinary identifiers were masked in everything stored
  // ("highp_precision" -> hi[REDACTED:gittoken]). Real minimums (architect
  // ruling): gh[pousr]_ body >= 36, github_pat_ body >= 50, and the GitLab
  // family gl*- with dash in the alphabet, body >= 20. Values synthetic.
  const masked: Array<[string, string]> = [
    ["ghp classic 36", `ghp_${rand(36, ALNUM)}`], // fake-secret
    ["ghs app 36", `ghs_${rand(36, ALNUM)}`], // fake-secret
    ["ghp body 40", `ghp_${rand(40, ALNUM)}`], // fake-secret
    ["github_pat fine-grained 82", `github_pat_11${rand(20, ALNUM)}_${rand(61, ALNUM)}`], // fake-secret
    ["glpat with dash (alphabet [0-9a-zA-Z_-])", `glpat-${rand(2, LOWER36)}-${rand(19, ALNUM)}`], // fake-secret
    ["glpat 20 then dotted suffix", `token glpat-${rand(20, ALNUM)}.01.0w1x2y3z4 ok`], // fake-secret
    ["gldt deploy", `gldt-${rand(20, ALNUM)}`], // fake-secret
    ["glrt runner", `glrt-${rand(20, ALNUM)}`], // fake-secret
    ["glptt pipeline trigger", `glptt-${rand(40, HEX)}`], // fake-secret
    ["glsoat", `glsoat-${rand(20, ALNUM)}`], // fake-secret
    ["glft", `glft-${rand(20, ALNUM)}`], // fake-secret
    ["glimt", `glimt-${rand(20, ALNUM)}`], // fake-secret
    ["glagent", `glagent-${rand(20, ALNUM)}`], // fake-secret
  ];
  for (const [label, token] of masked) {
    test(`masks ${label}`, () => {
      const alone = token.startsWith("token ") ? token : `token ${token} ok`;
      const r = redact(alone);
      expect(r.counts.gittoken).toBe(1);
      expect(r.text).toContain("[REDACTED:gittoken]");
      expect(r.text).not.toContain(token.replace(/^token /, "").slice(0, 12));
    });
  }
  // The reviewer's exact over-mask cases (probe-redact.ts): these MUST stay
  // visible - masked ordinary code is the N2 regression.
  const kept: Array<[string, string]> = [
    ["GLSL highp_ identifier", "uniform highp_precision float x"],
    ["snake identifiers ghs_handler / gho_counter", "call ghs_handler() then gho_counter++"],
    ["substring thoughp_/laughp_", "laughp_rate and tough_value"],
    ["ghp_ with a short body", "ghp_short"],
    ["bare glpat- prefix", "glpat- alone"],
    ["glpat short body", "glpat-abc123"],
    ["ghs_/gho_ with underscored short bodies", "ghs_handler_map and gho_counter_next = 0"],
  ];
  for (const [label, text] of kept) {
    test(`keeps ${label} unchanged`, () => {
      const r = redact(text);
      expect(r.text).toBe(text);
      expect(r.counts.gittoken).toBeUndefined();
    });
  }
  // O8 F-J (R17): the O7 greedy GitHub body ate a glued "glpat" prefix and
  // stopped at the dash, leaving the GitLab BODY in the clear - a redaction
  // gap a7362d5 did not have. The glued case must leak zero body
  // characters, one label or two.
  test("O8 F-J: a GitHub token glued straight into a GitLab one leaks no body", () => {
    const gh = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`; // fake-secret 36
    const gl = `glpat-${"AbCdEfGhIjKlMnOpQrSt"}`; // fake-secret 20 (split so no literal token sits in the source)
    const r = redact(`k ${gh}${gl} k`);
    expect(r.text).toBe("k [REDACTED:gittoken] k");
    expect(r.text).not.toContain("AbCd");
    expect(r.text).not.toContain(gl.slice(0, 8));
    expect(r.counts.gittoken).toBeGreaterThanOrEqual(1);
  });
  test("O8 F-J: github_pat_ glued into a GitLab token, and the reverse glue", () => {
    const pat = `github_pat_11${"A".repeat(20)}_${"b".repeat(61)}`; // fake-secret
    const gl = `gldt-${"0123456789abcdefABCD"}`; // fake-secret 20 (split so no literal token sits in the source)
    expect(redact(`x ${pat}${gl} y`).text).toBe("x [REDACTED:gittoken] y");
    const ghp = `ghs_${"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"}`; // fake-secret 36
    // reverse glue: the GitLab body alphabet already spans the second
    // prefix - must stay one fully masked label
    expect(redact(`x ${gl}${ghp} y`).text).toBe("x [REDACTED:gittoken] y");
  });
  test("idempotent on the masked form of each family", () => {
    for (const t of [`ghp_${rand(36, ALNUM)}`, `glpat-${rand(20, LOWER36)}`, `github_pat_11${rand(20, ALNUM)}_${rand(61, ALNUM)}`]) {
      const once = redact(t).text;
      expect(redact(once).text).toBe(once);
    }
  });
});

describe("redact: kept shapes", () => {
  const kept: Array<[label: string, value: string]> = [
    ["40-char git SHA", rand(40, HEX)],
    [
      "long path",
      "/home/user/source/some-long-directory-name-1234",
    ],
    [
      "URL",
      "https://example.com/path/Abc123Def456Ghi789Jkl012Mno345",
    ],
    ["UUID", "10b9a2c4-3f21-4a7b-9d5e-8c6b1a2f3e4d"],
    ["ordinary prose", "The quarterly numbers look fine, ship it on Tuesday."],
    ["the word token without a value", "the token expires soon, nothing to see"],
  ];
  for (const [label, value] of kept) {
    test(label, () => {
      const { text, counts } = redact(value);
      expect(text).toBe(value);
      expect(counts).toEqual({});
    });
  }
});

describe("redact: assignment and json-secret keep the name, hide the value", () => {
  test("BROKER_APP_SECRET=<fake64>", () => {
    const secret = rand(64, ALNUM);
    const { text, counts } = redact(`BROKER_APP_SECRET=${secret}`);
    expect(text).toBe("BROKER_APP_SECRET=[REDACTED:assignment]");
    expect(text).not.toContain(secret);
    expect(counts.assignment).toBe(1);
  });

  test("JSON blob with access_token/refresh_token/id_token fakes", () => {
    const v1 = rand(24, ALNUM);
    const v2 = rand(24, ALNUM);
    const v3 = rand(24, ALNUM);
    const blob = `{"access_token":"${v1}","refresh_token":"${v2}","id_token":"${v3}"}`;
    const { text, counts } = redact(blob);
    const parsed = JSON.parse(text) as Record<string, string>; // still valid JSON
    expect(parsed.access_token).toBe("[REDACTED:json-secret]");
    expect(parsed.refresh_token).toBe("[REDACTED:json-secret]");
    expect(parsed.id_token).toBe("[REDACTED:json-secret]");
    expect(text).toContain("access_token");
    expect(text).not.toContain(v1);
    expect(text).not.toContain(v2);
    expect(text).not.toContain(v3);
    expect(counts["json-secret"]).toBe(3);
  });
});

describe("redact: encoded-secret shapes (ADR-0003 commit 70ee11e)", () => {
  test("URL-encoded broker-shaped fake token (%40 inside) -> opaque", () => {
    let tok = "";
    do {
      tok = `${rand(20, ALNUM)}%40${rand(30, ALNUM)}.x`;
    } while (!/[A-Z]/.test(tok) || !/[a-z]/.test(tok) || !/\d/.test(tok));
    const { text, counts } = redact(tok);
    expect(text).toBe("[REDACTED:opaque]"); // '%' keeps it one run
    expect(counts.opaque).toBe(1);
  });

  test("base64 of a 40-byte fake secret -> opaque", () => {
    let b64 = "";
    do {
      const bytes = Uint8Array.from(
        Array.from({ length: 40 }, () => Math.floor(rnd() * 256)),
      );
      b64 = Buffer.from(bytes).toString("base64");
    } while (
      b64.startsWith("/") || // a leading '/' would trip the path exclusion
      !/[A-Z]/.test(b64) ||
      !/[a-z]/.test(b64) ||
      !/\d/.test(b64)
    );
    expect(b64.length).toBe(56); // 40 bytes -> 54 chars + '=' padding, '=' is in the class
    const { text, counts } = redact(b64);
    expect(text).toBe("[REDACTED:opaque]");
    expect(counts.opaque).toBe(1);
  });

  test("Authorization: Basic <24 base64 chars> -> bearer", () => {
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; // fake-secret
    const tok = rand(24, B64);
    const { text, counts } = redact(`Authorization: Basic ${tok}`);
    expect(text).toBe("[REDACTED:bearer]");
    expect(text).not.toContain(tok);
    expect(counts.bearer).toBe(1);
    expect(counts.opaque).toBeUndefined();
  });

  test("bare 'basic <word>' is NOT a bearer match (ADR alternatives are literal)", () => {
    const s = "basic configurationvalue123 here";
    const { text, counts } = redact(s);
    expect(text).toBe(s);
    expect(counts).toEqual({});
  });
});

describe("redact: PEM block hidden completely", () => {
  test("alone and in context", () => {
    const body = rand(80, ALNUM);
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----`; // fake-secret
    expect(redact(block).text).toBe("[REDACTED:pem]");
    const { text, counts } = redact(`here is the key:\n${block}\nplease rotate it`);
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(text).not.toContain(body);
    expect(text).toContain("please rotate it");
    expect(counts.pem).toBe(1);
  });
});

describe("redact: table order consequences", () => {
  test("a JWT inside a bearer header is redacted once, by the jwt rule", () => {
    const jwt = `eyJ${rand(12, B64URL)}.${rand(12, B64URL)}.${rand(12, B64URL)}`;
    const { text, counts } = redact(`Authorization: Bearer ${jwt}`);
    expect(text).toBe("Authorization: Bearer [REDACTED:jwt]");
    expect(text).not.toContain(jwt);
    expect(counts.jwt).toBe(1);
    expect(counts.bearer).toBeUndefined();
  });

  test("assignment runs before hex64: API_KEY=<64hex> counts once as assignment", () => {
    const secret = rand(64, HEX);
    const { text, counts } = redact(`API_KEY=${secret}`);
    expect(text).toBe("API_KEY=[REDACTED:assignment]");
    expect(counts.assignment).toBe(1);
    expect(counts.hex64).toBeUndefined();
  });
});

describe("redact: idempotent and unbreakable", () => {
  test("redact(redact(x).text).text == redact(x).text for every fake", () => {
    for (const { make } of fakes) {
      const { input } = make();
      const once = redact(input).text;
      expect(redact(once).text).toBe(once);
    }
  });

  test("a mixed blob is stable on a second pass", () => {
    const mixed = [
      `sk-ant-${rand(30, B64URL)}`,
      `bearer ${rand(20, ALNUM)}`,
      `{"api_key":"${rand(16, ALNUM)}"}`, // fake-secret
      `passcode: 'hunter2secretvalue'`,
      `${rand(12, ALNUM)}%40${rand(20, ALNUM)}.x`,
      rand(64, HEX),
      rand(44, ALNUM),
    ].join(" | ");
    const once = redact(mixed).text;
    expect(redact(once).text).toBe(once);
  });

  test("empty and plain text never throw and match nothing", () => {
    expect(redact("")).toEqual({ text: "", counts: {} });
    expect(redact("hello there").counts).toEqual({});
  });

  test("2 MB of random text: no throw, under 200 ms", () => {
    const words: string[] = [];
    const target = 2 * 1024 * 1024;
    while (words.length * 9 < target) words.push(rand(8, ALNUM));
    const big = words.join(" ");
    expect(big.length).toBeGreaterThanOrEqual(target - 9);
    const t0 = performance.now();
    const out = redact(big);
    const ms = performance.now() - t0;
    expect(out.text.length).toBe(big.length); // nothing in here matches any shape
    expect(out.counts).toEqual({});
    expect(ms).toBeLessThan(200);
  });
});

// T4-fix: rulings from review T4 (ADR-0003 @ edb8a30). Fakes only.
describe("T4-fix rulings (edb8a30)", () => {
  const lower = (n: number): string => "a1b2c3d4efgh".padEnd(n, "9").slice(0, n); // lower alnum
  const mixed = (n: number): string => "Ab1cD2eF".repeat(Math.ceil(n / 8)).slice(0, n);
  const seg = (n: number): string => "RevFakeSegA1".repeat(Math.ceil(n / 12)).slice(0, n);

  test("single strata bodies of 33/64/200 chars are consumed whole", () => {
    for (const n of [33, 64, 200]) {
      const tail = lower(n);
      const r = redact(`k strata_${tail} end`);
      expect(r.counts.strata).toBe(1);
      expect(r.text).toBe("k [REDACTED:strata] end");
    }
  });

  test("single anthropic bodies of 20/64/200 chars are consumed whole", () => {
    for (const n of [20, 64, 200]) {
      const r = redact(`key=sk-ant-${mixed(n)};`);
      expect(r.counts.anthropic).toBe(1);
      expect(r.text).toBe("key=[REDACTED:anthropic];");
    }
  });

  test("single jwt with 33/64/200-char segments is consumed whole", () => {
    for (const n of [33, 64, 200]) {
      const jwt = `eyJ${seg(n)}.${seg(n)}.${seg(n)}`;
      const r = redact(`t ${jwt} t`);
      expect(r.counts.jwt).toBe(1);
      expect(r.text).toBe("t [REDACTED:jwt] t");
    }
  });

  test("2x and 3x glued strata are two/three matches, no body survives", () => {
    const S = `strata_${lower(32)}`;
    const r2 = redact(S + S);
    expect(r2.counts.strata).toBe(2);
    expect(r2.text).toBe("[REDACTED:strata][REDACTED:strata]");
    const r3 = redact(S + S + S);
    expect(r3.counts.strata).toBe(3);
    expect(r3.text).not.toContain(lower(10));
  });

  test("2x and 3x glued sk-ant and jwt: counts 2/3, no fragment survives", () => {
    const A = `sk-ant-${mixed(24)}`;
    const ra = redact(A + A + A);
    expect(ra.counts.anthropic).toBe(3);
    expect(ra.text).not.toContain("Ab1cD2eF");
    const J = `eyJ${seg(14)}.${seg(16)}.${seg(18)}`;
    const rj = redact(J + J);
    expect(rj.counts.jwt).toBe(2);
    expect(rj.text).not.toContain("RevFakeSegA1");
  });

  test("glued results are idempotent", () => {
    const S = `strata_${lower(32)}`;
    const once = redact(S + S);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(Object.keys(twice.counts)).toEqual([]);
  });

  test("URL: scheme+host kept, token-bearing path redacted", () => {
    const tok = "Zx9QwErT".repeat(6); // 48 mixed-case alnum
    const r = redact(`see https://example.com/hooks/${tok} now`);
    expect(r.counts.opaque).toBe(1);
    expect(r.text).toBe("see https://example.com[REDACTED:opaque] now");
    expect(r.text).not.toContain(tok);
  });

  test("URL: ordinary docs path is kept", () => {
    const kept = "https://example.com/docs/getting-started";
    const r = redact(`read ${kept} first`);
    expect(r.text).toBe(`read ${kept} first`);
    expect(Object.keys(r.counts)).toEqual([]);
  });

  // Ruling e445671: protocol-relative URLs are URLs - skip only "//host",
  // check the path like a schemed URL's.
  test("protocol-relative URL: host kept, token-bearing path redacted", () => {
    const tok = "Zx9QwErT".repeat(6); // 48 mixed-case alnum
    const r = redact(`see //example.com/hooks/${tok} now`);
    expect(r.counts.opaque).toBe(1);
    expect(r.text).toBe("see //example.com[REDACTED:opaque] now");
    expect(r.text).not.toContain(tok);
  });

  test("protocol-relative URL: ordinary docs path is kept", () => {
    const kept = "//example.com/docs/getting-started";
    const r = redact(`read ${kept} first`);
    expect(r.text).toBe(`read ${kept} first`);
    expect(Object.keys(r.counts)).toEqual([]);
  });

  test("json-secret keys match case-insensitively, kept as typed", () => {
    const r = redact('{"Access_Token": "veryfakevalue999", "user": "bob"}'); // fake-secret
    expect(r.counts).toEqual({ "json-secret": 1 });
    const parsed = JSON.parse(r.text) as Record<string, string>;
    expect(parsed.Access_Token).toBe("[REDACTED:json-secret]");
    expect(parsed.user).toBe("bob");
  });
});
