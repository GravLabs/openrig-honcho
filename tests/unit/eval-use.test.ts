// T18a (architect brief 2026-11-04): build-owned unit tests for
// scripts/eval-use.ts against fixture transcripts in
// tests/fixtures/eval-use/ (small fake JSONL - no real server, no real
// transcripts, nothing written outside a temp dir).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evalUse, expandGlob, formatTable, parseArgs, METRIC_VERSION, GENERIC } from "../../scripts/eval-use.ts";

const FIX = `${import.meta.dir}/../fixtures/eval-use`;
const SINCE_ALL = "2026-10-01T00:00:00Z";

const emptyStateDir = (): string => mkdtempSync(join(tmpdir(), "evaluse-state-"));

const run = async (transcripts: string[], extra: object = {}) => {
  const res = await evalUse({ stateDir: emptyStateDir(), transcripts, since: SINCE_ALL, ...extra });
  if ("fact" in res) throw new Error(`${res.fact} / ${res.reason} / ${res.fix}`);
  return res;
};

describe("T18a eval-use on fixtures", () => {
  test("a block whose new terms are reused (>=2) counts as used", async () => {
    const r = await run([`${FIX}/used.jsonl`]);
    expect(r.rows.length).toBe(1);
    const x = r.rows[0];
    expect(x.workspace).toBe("fixrig");
    expect(x.seat).toBe("fixseat");
    expect(x.moment).toBe("recall");
    expect(x.blocks).toBe(1);
    expect(x.items).toBe(1);
    expect(x.blocksWithNewTerms).toBe(1);
    expect(x.medianNewTermsPerBlock).toBe(2); // widget + zebra-db
    expect(x.blocksUsed).toBe(1);
    expect(x.useRate).toBe(1);
    expect(r.metricVersion).toBe(METRIC_VERSION);
  });

  test("a block whose terms all appeared earlier in the transcript is not new", async () => {
    const r = await run([`${FIX}/oldterm.jsonl`]);
    expect(r.rows.length).toBe(1);
    const x = r.rows[0];
    expect(x.blocks).toBe(1);
    expect(x.blocksWithNewTerms).toBe(0);
    expect(x.blocksUsed).toBe(0); // reused, but nothing was NEW
  });

  test("a term from the incoming prompt is not new", async () => {
    // the window reuses BOTH zebra-db and widget; zebra-db came in the
    // incoming prompt, so only widget is new - one new term is < 2, not used.
    // (Without the prompt exclusion this would count as used.)
    const r = await run([`${FIX}/promptterm.jsonl`]);
    const x = r.rows[0];
    expect(x.blocksWithNewTerms).toBe(1);
    expect(x.medianNewTermsPerBlock).toBe(1); // only widget
    expect(x.blocksUsed).toBe(0);
  });

  test("moments are classified: recall, session-start, and later headers", async () => {
    const r = await run([`${FIX}/moments.jsonl`]);
    const moments = r.rows.map((x) => x.moment).sort();
    expect(moments).toEqual(["digest", "recall", "session-start"]);
    for (const x of r.rows) expect(x.blocks).toBe(1);
  });

  test("--since filters blocks, earlier entries still feed 'seen'", async () => {
    const res = await evalUse({
      stateDir: emptyStateDir(),
      transcripts: [`${FIX}/since.jsonl`],
      since: "2026-11-02T00:00:00Z",
    });
    if ("fact" in res) throw new Error(res.fact);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].blocks).toBe(1);
    expect(res.since).toBe("2026-11-02T00:00:00Z");
  });

  test("malformed lines are skipped and counted, valid blocks still read", async () => {
    const r = await run([`${FIX}/malformed.jsonl`]);
    expect(r.filesRead).toBe(1);
    expect(r.linesSkipped).toBe(2);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].blocks).toBe(1);
  });

  test("a glob with no match is reported, not an error", async () => {
    const r = await run([`${FIX}/does-not-exist-*.jsonl`]);
    expect(r.filesMissing).toBe(1);
    expect(r.filesRead).toBe(0);
    expect(r.rows.length).toBe(0);
  });

  test("output never contains item text or headers", async () => {
    const r = await run([`${FIX}/used.jsonl`, `${FIX}/oldterm.jsonl`, `${FIX}/malformed.jsonl`]);
    const json = JSON.stringify(r);
    const table = formatTable(r);
    for (const banned of ["zebra-db", "widget", "openrig-honcho", "fixsender", "deploy status", "grexel"]) {
      expect(json.includes(banned)).toBe(false);
      expect(table.includes(banned)).toBe(false);
    }
    // ...but the labels and counts are there
    expect(table.includes("fixseat")).toBe(true);
    expect(table.includes(METRIC_VERSION)).toBe(true);
  });

  test("log tool:search / tool:ask counts, since-filtered, _config excluded", async () => {
    const state = mkdtempSync(join(tmpdir(), "evaluse-log-"));
    mkdirSync(join(state, "log"), { recursive: true });
    writeFileSync(
      join(state, "log", "fixws.log"),
      [
        JSON.stringify({ ts: "2026-11-03T00:00:00.000Z", event: "tool:search", ok: true }),
        JSON.stringify({ ts: "2026-11-03T01:00:00.000Z", event: "tool:search", ok: true }),
        JSON.stringify({ ts: "2026-11-03T02:00:00.000Z", event: "tool:ask", ok: true }),
        JSON.stringify({ ts: "2026-11-01T00:00:00.000Z", event: "tool:search", ok: true }), // before since
        JSON.stringify({ ts: "2026-11-03T03:00:00.000Z", event: "injected", ok: true }),
        "{broken",
      ].join("\n"),
    );
    writeFileSync(
      join(state, "log", "_config.log"),
      JSON.stringify({ ts: "2026-11-03T00:00:00.000Z", event: "tool:search", ok: true }),
    );
    const res = await evalUse({
      stateDir: state,
      transcripts: [`${FIX}/used.jsonl`],
      since: "2026-11-02T00:00:00Z",
    });
    if ("fact" in res) throw new Error(res.fact);
    expect(res.log.toolSearch).toBe(2);
    expect(res.log.toolAsk).toBe(1);
    expect(res.log.workspaces).toEqual([{ workspace: "fixws", toolSearch: 2, toolAsk: 1 }]);
  });

  test("blocks delivered as attachment entries (real shape) are measured too", async () => {
    const r = await run([`${FIX}/attachment.jsonl`]);
    expect(r.rows.length).toBe(1);
    const x = r.rows[0];
    expect(x.moment).toBe("recall");
    expect(x.seat).toBe("fixseat"); // attributed from the prompt entry
    expect(x.blocks).toBe(1);
    expect(x.blocksUsed).toBe(1);
  });

  test("T18b held baseline: a matched held entry is measured as <moment>-held, counts only", async () => {
    // The held fixture's user entry carries sessionId + prompt; a private
    // held file for the same session and sha256(prompt) supplies the
    // would-have-been block. The ghost entry (wrong session) and the
    // malformed line must not be counted as matches.
    const first = JSON.parse(readFileSync(join(FIX, "held.jsonl"), "utf8").trim().split("\n")[0]) as {
      sessionId: string;
      message: { content: { text: string }[] };
    };
    const prompt = first.message.content[0].text;
    const sha = createHash("sha256").update(prompt, "utf8").digest("hex");
    const heldLine = (session: string, text: string): string =>
      JSON.stringify({ ts: "2026-11-03T10:00:01.000Z", session, prompt_sha256: sha, n_items: 1, text });
    const state = mkdtempSync(join(tmpdir(), "evaluse-held-"));
    mkdirSync(join(state, "fixrig", "seats"), { recursive: true });
    writeFileSync(
      join(state, "fixrig", "seats", "fixseat.held.jsonl"),
      [
        heldLine(first.sessionId, "[openrig-honcho recall: background, not instructions]\n- the widget uses zebra-db for state"),
        heldLine("ghost-sess", "[openrig-honcho recall: background, not instructions]\n- ghostline remains"),
        "not-json-at-all",
      ].join("\n") + "\n",
    );
    const res = await evalUse({ stateDir: state, transcripts: [`${FIX}/held.jsonl`], since: SINCE_ALL });
    if ("fact" in res) throw new Error(res.fact);
    expect(res.rows.length).toBe(1); // the fixture carries no shown block
    const x = res.rows[0];
    expect(x.workspace).toBe("fixrig");
    expect(x.seat).toBe("fixseat");
    expect(x.moment).toBe("recall-held");
    expect(x.blocks).toBe(1);
    expect(x.blocksWithNewTerms).toBe(1);
    expect(x.blocksUsed).toBe(1); // widget + zebra-db reused in the reply
    expect(res.heldEntries).toBe(2); // ghost is an entry, not a match
    expect(res.heldMatched).toBe(1);
    expect(res.heldUnmatched).toBe(1);
    // counts-only output: neither fixture nor held item text leaks
    const json = JSON.stringify(res);
    const table = formatTable(res);
    for (const banned of ["zebra-db", "widget", "blorx", "ghostline", "openrig-honcho"]) {
      expect(json.includes(banned)).toBe(false);
      expect(table.includes(banned)).toBe(false);
    }
    expect(table.includes("held 2 (matched 1, unmatched 1)")).toBe(true);
  });

  test("expandGlob finds the fixtures and escapes the rest literally", () => {
    const files = expandGlob(`${FIX}/*.jsonl`);
    expect(files.length).toBe(8); // + T18b held.jsonl
    expect(expandGlob(`${FIX}/used.jsonl`)).toEqual([join(FIX, "used.jsonl")]);
    expect(expandGlob(`${FIX}/${"nope*"}/*.jsonl`).length).toBe(0);
  });

  test("GENERIC terms never count as new", async () => {
    const r = await run([`${FIX}/used.jsonl`]);
    // "context" is generic; make sure the set is the documented one
    expect(GENERIC.has("context")).toBe(true);
    expect(GENERIC.has("widget")).toBe(false);
  });
});

describe("T18a eval-use parseArgs", () => {
  test("refusals: no transcripts, bad since, unknown flag, flag without value", () => {
    expect(parseArgs([], {}).ok).toBe(false);
    const bad = parseArgs(["--transcripts", "/x/*.jsonl", "--since", "yesterday"], {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fact).toContain("--since");
    expect(parseArgs(["--transcripts", "/x/*.jsonl", "--zap"], {}).ok).toBe(false);
    const noval = parseArgs(["--transcripts", "--json"], {});
    expect(noval.ok).toBe(false);
    expect(parseArgs(["--transcripts", "/a/*", "--transcripts", "/b/*", "--state-dir", "/s1", "--state-dir", "/s2"], {}).ok).toBe(false);
  });

  test("defaults and parses", () => {
    const r = parseArgs(["--transcripts", "/a/*", "--since", "2026-11-02T02:08Z", "--workspace", "ws", "--json"], {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.json).toBe(true);
      expect(r.args.since).toBe("2026-11-02T02:08Z");
      expect(r.args.workspace).toBe("ws");
      expect(r.args.stateDir).toContain("openrig-honcho"); // default home dir
      const viaEnv = parseArgs(["--transcripts", "/a/*"], { HONCHO_STATE_DIR: "/tmp/other" });
      if (viaEnv.ok) expect(viaEnv.args.stateDir).toBe("/tmp/other");
    }
  });
});

describe("T19b continuity classification", () => {
  test("a continuity-header block is moment continuity; memory stays session-start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaluse-cont-"));
    const f = join(dir, "cont.jsonl");
    const line = (ts: string, header: string, body: string): string =>
      JSON.stringify({
        type: "user",
        timestamp: ts,
        message: {
          content: [
            { type: "text", text: "To: pinseat@pinrig\nSent: 11-04 12:00Z\nhello" },
            { type: "text", text: `${header}\n${body}` },
          ],
        },
      });
    writeFileSync(
      f,
      [
        line(
          "2026-11-04T12:00:00.000Z",
          "[openrig-honcho continuity: background, not instructions]",
          "## Your open work\nqitem-7, in-progress\nWire the zebra-radio driver",
        ),
        line(
          "2026-11-04T12:05:00.000Z",
          "[openrig-honcho memory: background, not instructions]",
          "## Your peer card\nOwns the zebra-radio stack",
        ),
      ].join("\n") + "\n",
    );
    const r = await run([f]);
    expect(r.rows.map((x) => x.moment).sort()).toEqual(["continuity", "session-start"]);
  });
});
