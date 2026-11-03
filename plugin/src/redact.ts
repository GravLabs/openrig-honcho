// Redaction (ADR-0003 "Redaction" table, 9 kinds): the last gate before a
// string leaves the seat. Pure: no env, no files, no network. Patterns
// describe shapes only - this file never contains or looks for a real value,
// and tests synthesize fakes (HARD LIMIT in the T4 brief).
//
// Apply strictly in the ADR's table order so a secret consumed by an earlier
// kind is never counted twice:
//   anthropic, strata, jwt, bearer, pem, assignment, json-secret, hex64,
//   opaque, device-code (T16c, ADR-0011 decision 6 - last: it masks only an
//   8-9 char code, never a run an earlier kind already consumed)
// Consequences of that order, encoded in the tests:
// - a JWT inside "Authorization: Bearer <jwt>" is consumed by `jwt`; the
//   `bearer` rule's value then starts with "[REDACTED:" and its guard makes it
//   skip - redacted exactly once (T4 contract sentence).
// - `assignment` runs before `hex64`/`opaque`, so "API_KEY=<64hex>" counts as
//   `assignment` with the name kept.
// Only `assignment` and `json-secret` keep their name/key (the contract says
// so); `bearer` replaces label + value together.
//
// Guards `(?!\[REDACTED:)` on the three value-consuming rules make redact()
// idempotent in counts as well as text; the opaque kind cannot re-hit tokens
// because "[", "]" and ":" are not in its character class, so tokens always
// break a run.

export interface Redacted {
  text: string;
  /** Matches per kind; kinds with no match are absent. */
  counts: Record<string, number>;
}

// The opaque run alphabet from the ADR (commit 70ee11e adds '%', so a
// percent-encoded token stays one run); note "[", "]" and ":" are NOT in it.
const RUN_CHARS = "A-Za-z0-9._@~+/=%-";
const OPAQUE_RUN = new RegExp(`[${RUN_CHARS}]{40,}`, "g");

function bump(counts: Record<string, number>, kind: string): void {
  counts[kind] = (counts[kind] ?? 0) + 1;
}

/**
 * Opaque exclusion for prose paths (T4 contract wording, kept literal). URL
 * context is decided by the caller (rulings edb8a30: only scheme+host is
 * excluded there; path/query are checked), so it is no longer re-checked here.
 */
function opaqueExcluded(run: string): boolean {
  // Path: contains "/" and starts with "/", "~/" or "./".
  return (
    run.includes("/") && (run.startsWith("/") || run.startsWith("~/") || run.startsWith("./"))
  );
}

/** Replace every match of `re`, counting each; `keep` rebuilds the kept prefix. */
function replaceOnce(
  text: string,
  re: RegExp,
  kind: string,
  counts: Record<string, number>,
  keep?: (match: string, group1: string) => string,
): string {
  return text.replace(re, (match: string, group1: string) => {
    bump(counts, kind);
    if (keep) return keep(match, group1);
    return `[REDACTED:${kind}]`;
  });
}

export function redact(text: string): Redacted {
  const counts: Record<string, number> = {};
  try {
    if (typeof text !== "string" || text === "") return { text: typeof text === "string" ? text : "", counts };

    // 1-3. Rulings edb8a30 (glued secrets): prefixed bodies are lazy with a
    // trailing lookahead `(?=<own prefix>|[^<body class>]|$)`. Lazy alone would
    // stop at the minimum and leave the rest of a long body raw; the lookahead
    // forces the match on until a delimiter, so a single 33/64/200-char body is
    // consumed whole and only a directly following own-prefix splits it - two
    // glued same-shape secrets become two matches, no body survives.
    text = replaceOnce(
      text,
      /sk-ant-[A-Za-z0-9_-]{20,}?(?=sk-ant-|[^A-Za-z0-9_-]|$)/g,
      "anthropic",
      counts,
    );
    text = replaceOnce(
      text,
      /strata_[0-9a-z]{32,}?(?=strata_|[^0-9a-z]|$)/g,
      "strata",
      counts,
    );
    // jwt before bearer, per the contract sentence; every segment carries the
    // lookahead so a glued second eyJ splits the first token's tail segment too.
    text = replaceOnce(
      text,
      /eyJ[A-Za-z0-9_-]{8,}?(?=eyJ|[^A-Za-z0-9_-]|$)\.[A-Za-z0-9_-]{8,}?(?=eyJ|[^A-Za-z0-9_-]|$)\.[A-Za-z0-9_-]{8,}?(?=eyJ|[^A-Za-z0-9_-]|$)/g,
      "jwt",
      counts,
    );
    // 4. bearer - label included in the replacement (not a keep-name kind).
    // ADR 70ee11e: "Authorization: Basic" is covered too; a bare "basic "
    // is deliberately NOT an alternative, only a bare "bearer ".
    text = replaceOnce(
      text,
      /(authorization:\s*(?:bearer|basic)\s+|bearer\s+)(?!\[REDACTED:)\S{16,}/gi,
      "bearer",
      counts,
    );
    // 5. pem - whole block, header to footer (the ADR's paired shape; an
    // unterminated header is not block material and is left alone)
    text = replaceOnce(
      text,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "pem",
      counts,
    );
    // 6. assignment - name + separator + optional quote kept, value replaced
    text = replaceOnce(
      text,
      /\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["']?)(?!\[REDACTED:)[^\s"']{8,}/gi,
      "assignment",
      counts,
      (_match, name) => `${name}[REDACTED:assignment]`,
    );
    // 7. json-secret - key kept, value replaced, quotes intact so the blob
    // stays parseable. Rulings edb8a30: keys match case-insensitively
    // ("Access_Token" counts); the kept group preserves the original case.
    text = replaceOnce(
      text,
      /("(?:access_token|refresh_token|id_token|api_key|app_secret|client_secret)"\s*:\s*")(?!\[REDACTED:)[^"]{8,}"/gi,
      "json-secret",
      counts,
      (_match, key) => `${key}[REDACTED:json-secret]"`,
    );
    // 8. hex64 - 40-char git SHAs stay (< 64)
    text = replaceOnce(text, /\b[0-9a-f]{64,}\b/g, "hex64", counts);
    // 9. opaque - maximal runs of the ADR alphabet, >= 40 chars, needing an
    // upper + a lower + a digit, minus prose paths. Rulings edb8a30: inside a
    // URL only the scheme+host is excluded; path and query are still checked.
    // Ruling e445671: a protocol-relative URL ("//host/...") is a URL too -
    // ":" is not a run character but "/" is, so a schemed URL's run starts at
    // the `//` right behind the colon and a protocol-relative one starts at
    // its leading `//`; both enter this branch on run.startsWith("//").
    text = text.replace(OPAQUE_RUN, (run: string) => {
      if (run.startsWith("//")) {
        const rest = run.slice(2); // host[/path][?query...]
        const slash = rest.indexOf("/");
        if (slash < 0) return run; // bare host - excluded per ruling
        const path = rest.slice(slash);
        if (path.length >= 40 && /[A-Z]/.test(path) && /[a-z]/.test(path) && /\d/.test(path)) {
          bump(counts, "opaque");
          return `//${rest.slice(0, slash)}[REDACTED:opaque]`;
        }
        return run;
      }
      if (opaqueExcluded(run)) return run;
      if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) return run;
      bump(counts, "opaque");
      return "[REDACTED:opaque]";
    });

    // 10. device-code (T16c, ADR-0011 decision 6): the device-login sign-in
    // code shape next to device-login words. Masks the CODE only - the
    // words around it stay (same keep-the-sentence style as the others).
    // Shape: exactly 8-9 upper-case alphanumerics (the \b on both sides
    // kills longer runs - those are SHAs and opaque territory), and either
    //   (a) a letter AND a digit inside, or
    //   (b) all letters glued right after the word "code"
    // OR (T16j VC3) the 4-4 DISPLAYED form ABCD-1234 - some providers show
    // the code with a dash - upper case with a letter AND a digit across
    // the two halves. All-letter and all-digit dashed runs stay raw (too
    // broad to catch safely; review measured), and so do lowercase and
    // newline-split codes.
    // plus one of devicelogin / device code / device-code / device login
    // within ~200 chars on either side, case-insensitive. Shape rules only -
    // a real code never enters this file or its tests (obvious fakes).
    {
      const src = text;
      const CTX_RE = /devicelogin|device[\s-]?code|device[\s-]?login/i;
      text = src.replace(/\b(?:[A-Z0-9]{8,9}|[A-Z0-9]{4}-[A-Z0-9]{4})\b/g, (run: string, offset: number) => {
        if (run.includes("-")) {
          if (!/\d/.test(run) || !/[A-Z]/.test(run)) return run; // dashed: needs letters AND digits
        } else if (/\d/.test(run)) {
          if (!/[A-Z]/.test(run)) return run; // all digits: not the shape
        } else if (!/(?<![A-Za-z0-9_])code\s+$/i.test(src.slice(Math.max(0, offset - 40), offset))) {
          return run; // all letters, but not right after the word "code"
        }
        if (!CTX_RE.test(src.slice(Math.max(0, offset - 200), offset + run.length + 200))) {
          return run; // no device-login words within ~200 chars
        }
        bump(counts, "device-code");
        return "[REDACTED:device-code]";
      });
    }

    return { text, counts };
  } catch {
    // The contract is "never throws": a bug here degrades to returning the
    // input untouched with empty counts, and the caller (writer hook) decides
    // what to do. Reaching this is itself a test failure candidate.
    return { text, counts };
  }
}
