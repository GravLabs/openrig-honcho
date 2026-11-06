// T18a (architect brief 2026-11-04, qitem-20261104144119-0b7c8d116c03e61e):
// the "new information used" metric (ADR-0013 decision 1, objective O5).
//
// One rerunnable measure of whether injected memory changes what a seat
// does. Reads the seats' Claude Code transcripts and the plugin logs,
// READ-ONLY, and prints COUNTS ONLY - never block or item content, never
// file paths. Ported from the architect's Python prototype that produced
// the v0.2.2 numbers (docs/EVALUATION.md section 4), with two definition
// tightenings the brief requires and the METRIC_VERSION below records:
//   - a term in the incoming prompt (the entry carrying the block) is not
//     "new"; the prototype only excluded earlier entries;
//   - the following-turn window stops at the NEXT prompt containing a
//     "From:" header, whether or not an assistant turn came first (the
//     prototype kept going when no reply had been collected yet).
//
// Definition (shared for every later check; bump METRIC_VERSION on change):
//   block   = the first string in a transcript entry containing
//             "[openrig-honcho " whose timestamp >= --since;
//   moment  = "recall" for header "[openrig-honcho recall",
//             "session-start" for "[openrig-honcho memory", and the next
//             word of the header for any later moment ("digest", ...);
//   items   = body lines starting with "- " after the header;
//   terms   = /[A-Za-z][A-Za-z0-9._/-]{5,}/ (words of 6+ chars),
//             /[0-9a-f]{7,}/ (hex ids), version numbers, lowercased, minus
//             GENERIC below;
//   new     = block terms - terms anywhere earlier in that transcript
//             - terms in the incoming prompt - GENERIC;
//   used    = at least 2 new terms appear in the assistant turns that
//             follow, up to the next "From:" prompt, within the next 40
//             entries (tool_use inputs count as text, first 400 chars,
//             as in the prototype);
//   rate    = used blocks / blocks.
// The injected block's own body never enters "seen", so it cannot make a
// later block's terms look old.
//
// Seat and rig attribution: Claude Code transcripts do not carry the seat
// name, but every OpenRig message typed into a seat contains a
// "To: <seat>@<rig>" header. The modal To:-seat in a file is that file's
// seat, and the modal @rig is its workspace label (unless --workspace).
// Files without any incoming message are attributed to "unknown".
//
// GENERIC (documented, from the prototype): words too common in memory
// prose to prove anything was learned.
//
// Usage:
//   bun run scripts/eval-use.ts --transcripts '<glob>' [--transcripts
//     '<glob>' ...] [--since <ISO>] [--state-dir <dir>] [--workspace
//     <ws>] [--json]
// --state-dir defaults to HONCHO_STATE_DIR or ~/.openrig-honcho; its log/
// <workspace>.log files supply the tool:search and tool:ask counts (also
// since-filtered; _config.log is never read). Robust to malformed lines,
// missing files and partial transcripts: bad lines are skipped and
// counted. Exit 0 on success, 1 with a fact/reason/fix triple on refusal.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// T19c (ADR-0014 decision 4): the term definition moved to
// plugin/src/terms.ts so the recall novelty filter and this metric agree on
// what a term IS. Re-exported under the same names; the metric itself
// (METRIC_VERSION below) and its results are unchanged by the move.
import { GENERIC, TOKEN_RE } from "../plugin/src/terms.ts";
export { GENERIC, tokensOf } from "../plugin/src/terms.ts";

// v1.1 (T18b): added the held-arm baseline - rows whose moment ends in
// "-held" are measured from the private held file with the identical
// v1 rules; the shown-arm rules and numbers are unchanged, so v1 results
// stay comparable.
export const METRIC_VERSION = "eval-use-v1.1";

// GENERIC and TOKEN_RE are imported from plugin/src/terms.ts (T19c): the
// terms too generic to count as new information (from the v0.2.2 prototype;
// keep in sync with docs/EVALUATION.md section 4 if the architect changes
// the list) and the shared token grammar.
const HEADER = "[openrig-honcho ";
const MAX_WINDOW_ENTRIES = 40;
const TO_RE = /To:\s*([A-Za-z0-9_-]+)@([A-Za-z0-9_-]+)/g;

export type EvalArgs = {
  stateDir: string;
  transcripts: string[];
  since: string;
  workspace?: string;
};

export type EvalRow = {
  workspace: string;
  seat: string;
  moment: string;
  blocks: number;
  items: number;
  blocksWithNewTerms: number;
  medianNewTermsPerBlock: number | null;
  blocksUsed: number;
  useRate: number;
};

export type EvalResult = {
  metricVersion: string;
  since: string;
  filesRead: number;
  filesMissing: number;
  linesSkipped: number;
  /** Held-arm file entries seen / matched to a transcript turn / left
   * unmatched (an unmatched held block has no measurable baseline). */
  heldEntries: number;
  heldMatched: number;
  heldUnmatched: number;
  rows: EvalRow[];
  log: { workspaces: { workspace: string; toolSearch: number; toolAsk: number }[]; toolSearch: number; toolAsk: number };
};

export type EvalError = { fact: string; reason: string; fix: string };

// ---------- term machinery ----------

function* walkStrings(o: unknown): Generator<string> {
  if (typeof o === "string") yield o;
  else if (Array.isArray(o)) for (const v of o) yield* walkStrings(v);
  else if (o && typeof o === "object") for (const v of Object.values(o)) yield* walkStrings(v);
}

// tokensOf lives in plugin/src/terms.ts since T19c (re-exported above).
function addTokens(into: Set<string>, s: string): void {
  for (const m of s.matchAll(TOKEN_RE)) into.add(m[0].toLowerCase());
}

function stripBlockBody(s: string): string {
  const i = s.indexOf(HEADER);
  return i < 0 ? s : s.slice(0, i);
}

function classifyMoment(s: string): string {
  const rest = s.slice(s.indexOf(HEADER) + HEADER.length);
  const word = /^[A-Za-z][A-Za-z-]*/.exec(rest)?.[0] ?? "";
  if (word === "recall") return "recall";
  if (word === "memory") return "session-start";
  return word === "" ? "other" : word;
}

function itemsOf(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter((l) => l !== "");
}

// ---------- transcript loading ----------

type Entry = { type?: string; timestamp?: string; sessionId?: string; message?: unknown };

function loadEntries(file: string): { entries: Entry[]; skipped: number } {
  const entries: Entry[] = [];
  let skipped = 0;
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { entries, skipped };
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as Entry;
      if (e && typeof e === "object") entries.push(e);
      else skipped++;
    } catch {
      skipped++; // malformed or partial line - skip, count
    }
  }
  return { entries, skipped };
}

function assistantText(e: Entry): string {
  const c = (e.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const b of c) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
      parts.push(String((b as { text?: unknown }).text ?? ""));
    } else if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
      parts.push(JSON.stringify((b as { input?: unknown }).input ?? "").slice(0, 400));
    }
  }
  return parts.join(" ");
}

function hasFrom(e: Entry): boolean {
  for (const s of walkStrings(e.message ?? {})) if (s.includes("From:")) return true;
  return false;
}

// modal "To: <seat>@<rig>" over user entries = this file's seat and rig
function attribute(entries: Entry[]): { seat: string; workspace: string } {
  const seats = new Map<string, number>();
  const rigs = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== "user") continue;
    for (const s of walkStrings(e.message ?? {})) {
      for (const m of s.matchAll(TO_RE)) {
        seats.set(m[1], (seats.get(m[1]) ?? 0) + 1);
        rigs.set(m[2], (rigs.get(m[2]) ?? 0) + 1);
      }
    }
  }
  const top = (m: Map<string, number>): string | undefined =>
    m.size === 0 ? undefined : [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return { seat: top(seats) ?? "unknown", workspace: top(rigs) ?? "unknown" };
}

// ---------- glob expansion (no dependency; '*' per path segment) ----------

export function expandGlob(pattern: string): string[] {
  let p = pattern;
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  const parts = p.split("/").filter((s) => s !== "");
  const root = p.startsWith("/") ? "/" : process.cwd();
  let dirs = [root];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const last = i === parts.length - 1;
    const re = seg.includes("*") ? new RegExp("^" + seg.split("*").map(escapeRe).join("[^/]*") + "$") : null;
    const next: string[] = [];
    for (const d of dirs) {
      if (re === null) {
        const c = join(d, seg);
        if (last) {
          try {
            if (statSync(c).isFile()) next.push(c);
          } catch {
            /* missing file - counted as no match */
          }
        } else if (existsSync(c)) {
          try {
            if (statSync(c).isDirectory()) next.push(c);
          } catch {
            /* unreadable dir - skip */
          }
        }
        continue;
      }
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        continue; // missing directory - no matches, not an error
      }
      for (const n of names) {
        if (!re.test(n)) continue;
        const c = join(d, n);
        try {
          const st = statSync(c);
          if (last ? st.isFile() : st.isDirectory()) next.push(c);
        } catch {
          /* raced entry - skip */
        }
      }
    }
    dirs = next;
  }
  return dirs.sort();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- held-arm file (T18b, option c ruling) ----------
// <stateDir>/<workspace>/seats/<peer>.held.jsonl - written by the recall
// hook for held blocks (rendered text + session + sha256 of the raw
// prompt + counts). Matched to its transcript turn by session id and the
// hash of the user-entry text string; the baseline uses the same
// new-terms rule. Nothing from the text is ever printed.

type HeldLite = { session: string; prompt_sha256: string; text: string };

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function loadHeld(stateDir: string, workspaceFilter?: string): { map: Map<string, HeldLite[]>; total: number } {
  const map = new Map<string, HeldLite[]>();
  let total = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => n !== "log" && !n.startsWith("."));
  } catch {
    return { map, total };
  }
  for (const wsName of dirs) {
    if (workspaceFilter && wsName !== workspaceFilter) continue;
    let names: string[] = [];
    try {
      names = readdirSync(join(stateDir, wsName, "seats")).filter((n) => n.endsWith(".held.jsonl"));
    } catch {
      continue; // no seats dir: this workspace held nothing
    }
    for (const n of names) {
      let raw = "";
      try {
        raw = readFileSync(join(stateDir, wsName, "seats", n), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const e = JSON.parse(line) as HeldLite;
          if (typeof e.session !== "string" || typeof e.prompt_sha256 !== "string" || typeof e.text !== "string") continue;
          total++;
          const key = `${e.session} ${e.prompt_sha256}`;
          map.set(key, [...(map.get(key) ?? []), e]);
        } catch {
          // malformed held line: skip
        }
      }
    }
  }
  return { map, total };
}

// ---------- the metric ----------

type Acc = { blocks: number; items: number; blocksWithNew: number; used: number; news: number[] };

export async function evalUse(args: EvalArgs): Promise<EvalResult | EvalError> {
  const files: string[] = [];
  let filesMissing = 0;
  for (const g of args.transcripts) {
    const hit = expandGlob(g);
    if (hit.length === 0) filesMissing++;
    files.push(...hit);
  }

  const rows = new Map<string, Acc & { workspace: string; seat: string; moment: string }>();
  let filesRead = 0;
  let linesSkipped = 0;
  const held = loadHeld(args.stateDir, args.workspace);
  let heldMatched = 0;

  for (const file of files) {
    const { entries, skipped } = loadEntries(file);
    filesRead++;
    linesSkipped += skipped;
    const { seat, workspace } = attribute(entries);
    const ws = args.workspace ?? workspace;
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // Block: the first string ANYWHERE in the entry containing the
      // header - real transcripts deliver injections as "attachment"
      // entries (no message), prototype walked the whole entry for this.
      // Prompt and "seen" tokens stay message-based (the attachment entry
      // has no prompt; the turn's prompt is already in seen).
      let blockStr: string | undefined;
      for (const s of walkStrings(e)) {
        if (blockStr === undefined && s.includes(HEADER)) blockStr = s;
      }
      const promptTok = new Set<string>();
      for (const s of walkStrings(e.message ?? {})) addTokens(promptTok, stripBlockBody(s));

      const ts = typeof e.timestamp === "string" ? e.timestamp : "";
      // One measurement body for shown blocks and held baselines: items,
      // fresh terms (this entry's prompt and all earlier text excluded),
      // reuse in the following window, accumulated per (ws, seat, moment).
      const measure = (str: string, momentName: string): void => {
        const items = itemsOf(str.slice(str.indexOf(HEADER)));
        const itok = new Set<string>();
        for (const it of items) addTokens(itok, it);
        const fresh = new Set<string>();
        for (const t of itok) {
          if (!seen.has(t) && !promptTok.has(t) && !GENERIC.has(t)) fresh.add(t);
        }
        // following assistant turns up to the next From: prompt
        const winTok = new Set<string>();
        for (let j = i + 1; j < Math.min(entries.length, i + MAX_WINDOW_ENTRIES); j++) {
          const e2 = entries[j];
          if (e2.type === "user" && hasFrom(e2)) break;
          if (e2.type === "assistant") addTokens(winTok, assistantText(e2));
        }
        let shared = 0;
        for (const t of fresh) if (winTok.has(t)) shared++;

        const key = `${ws}\u0000${seat}\u0000${momentName}`;
        const acc = rows.get(key) ?? {
          workspace: ws,
          seat,
          moment: momentName,
          blocks: 0,
          items: 0,
          blocksWithNew: 0,
          used: 0,
          news: [],
        };
        acc.blocks++;
        acc.items += items.length;
        if (fresh.size > 0) acc.blocksWithNew++;
        if (shared >= 2) acc.used++;
        acc.news.push(fresh.size);
        rows.set(key, acc);
      };
      if (blockStr !== undefined && ts !== "" && ts >= args.since) {
        measure(blockStr, classifyMoment(blockStr));
      }
      // T18b held baseline: a user entry whose prompt hash matches a held
      // file entry for the same session gets its would-be block measured
      // with the identical rule; the moment carries a "-held" suffix.
      if (
        e.type === "user" &&
        typeof e.sessionId === "string" &&
        held.map.size > 0 &&
        ts !== "" &&
        ts >= args.since
      ) {
        for (const s of [...walkStrings(e.message ?? {})]) {
          const hkey = `${e.sessionId} ${sha256Hex(s)}`;
          const list = held.map.get(hkey);
          if (list === undefined || list.length === 0) continue;
          const he = list.shift() as HeldLite;
          heldMatched++;
          if (list.length === 0) held.map.delete(hkey);
          if (he.text.includes(HEADER)) measure(he.text, `${classifyMoment(he.text)}-held`);
          break; // one held block per turn
        }
      }
      // the block's own body never enters seen (stripped above)
      for (const s of walkStrings(e.message ?? {})) addTokens(seen, stripBlockBody(s));
    }
  }

  // log counts: tool:search and tool:ask per workspace, since-filtered
  const logRows: EvalResult["log"]["workspaces"] = [];
  let toolSearch = 0;
  let toolAsk = 0;
  const logDir = join(args.stateDir, "log");
  if (existsSync(logDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(logDir).filter((n) => n.endsWith(".log") && !n.startsWith("_")).sort();
    } catch {
      names = [];
    }
    for (const n of names) {
      const wsName = n.slice(0, -".log".length);
      if (args.workspace && wsName !== args.workspace) continue;
      let search = 0;
      let ask = 0;
      let raw = "";
      try {
        raw = readFileSync(join(logDir, n), "utf8");
      } catch {
        /* missing - zero counts */
      }
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        let e: { ts?: string; event?: string };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof e.ts === "string" && e.ts < args.since) continue;
        if (e.event === "tool:search") search++;
        else if (e.event === "tool:ask") ask++;
      }
      logRows.push({ workspace: wsName, toolSearch: search, toolAsk: ask });
      toolSearch += search;
      toolAsk += ask;
    }
  }

  const rowList: EvalRow[] = [...rows.values()]
    .sort(
      (a, b) =>
        a.workspace.localeCompare(b.workspace) ||
        a.seat.localeCompare(b.seat) ||
        a.moment.localeCompare(b.moment),
    )
    .map((r) => {
      const sorted = [...r.news].sort((a, b) => a - b);
      return {
        workspace: r.workspace,
        seat: r.seat,
        moment: r.moment,
        blocks: r.blocks,
        items: r.items,
        blocksWithNewTerms: r.blocksWithNew,
        medianNewTermsPerBlock: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        blocksUsed: r.used,
        useRate: r.blocks > 0 ? r.used / r.blocks : 0,
      };
    });

  return {
    metricVersion: METRIC_VERSION,
    since: args.since,
    filesRead,
    filesMissing,
    linesSkipped,
    heldEntries: held.total,
    heldMatched,
    heldUnmatched: held.total - heldMatched,
    rows: rowList,
    log: { workspaces: logRows, toolSearch, toolAsk },
  };
}

// ---------- CLI ----------

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): { ok: true; args: EvalArgs; json: boolean } | { ok: false } & EvalError {
  const stateDirIn: string[] = [];
  const transcripts: string[] = [];
  let since = "1970-01-01T00:00:00Z";
  let workspace: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string | undefined => {
      const v = argv[++i];
      return v === undefined || v.startsWith("--") ? undefined : v;
    };
    if (a === "--state-dir") stateDirIn.push(val() ?? "");
    else if (a === "--transcripts") {
      const v = val();
      if (v === undefined) return fail("--transcripts needs a glob", "the flag was given with no value", "pass --transcripts '<path glob>'");
      transcripts.push(v);
    } else if (a === "--since") since = val() ?? "";
    else if (a === "--workspace") workspace = val();
    else if (a === "--json") json = true;
    else
      return fail(`unknown argument ${a}`, "the script takes a fixed flag set", "see the usage in the file header");
  }
  const uniqStates = [...new Set(stateDirIn)];
  if (uniqStates.length > 1)
    return fail("--state-dir given twice", "one state directory per run", "pass it once or not at all");
  if (transcripts.length === 0)
    return fail("no --transcripts", "the transcripts are the measure's input", "pass at least one --transcripts '<glob>'");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(since))
    return fail("--since is not an ISO time", `got "${since}"`, "use e.g. --since 2026-11-02T02:08Z");
  const stateDir = uniqStates[0] ? uniqStates[0] : (env.HONCHO_STATE_DIR ?? join(homedir(), ".openrig-honcho"));
  const args: EvalArgs = { stateDir, transcripts, since, ...(workspace ? { workspace } : {}) };
  return { ok: true, args, json };
}

function fail(fact: string, reason: string, fix: string): { ok: false } & EvalError {
  return { ok: false, fact, reason, fix };
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function formatTable(r: EvalResult): string {
  const lines: string[] = [
    `metric ${r.metricVersion}  since ${r.since}  files read ${r.filesRead} (globs with no match: ${r.filesMissing})  lines skipped ${r.linesSkipped}` +
      (r.heldEntries > 0 ? `  held ${r.heldEntries} (matched ${r.heldMatched}, unmatched ${r.heldUnmatched})` : ""),
    pad("workspace", 16) + pad("seat", 18) + pad("moment", 14) + pad("blocks", 8) + pad("items", 7) + pad("new-blk", 8) + pad("med-new", 8) + pad("used", 6) + "rate",
  ];
  const fmtRow = (x: EvalRow): string =>
    pad(x.workspace, 16) + pad(x.seat, 18) + pad(x.moment, 14) + pad(String(x.blocks), 8) + pad(String(x.items), 7) +
    pad(String(x.blocksWithNewTerms), 8) + pad(x.medianNewTermsPerBlock === null ? "-" : String(x.medianNewTermsPerBlock), 8) +
    pad(String(x.blocksUsed), 6) + x.useRate.toFixed(3);
  for (const x of r.rows) lines.push(fmtRow(x));
  // totals per moment
  const byMoment = new Map<string, EvalRow[]>();
  for (const x of r.rows) byMoment.set(x.moment, [...(byMoment.get(x.moment) ?? []), x]);
  for (const [moment, xs] of [...byMoment.entries()].sort()) {
    const sum = (f: (x: EvalRow) => number): number => xs.reduce((a, x) => a + f(x), 0);
    const blocks = sum((x) => x.blocks);
    lines.push(
      fmtRow({
        workspace: "*", seat: "*", moment,
        blocks, items: sum((x) => x.items), blocksWithNewTerms: sum((x) => x.blocksWithNewTerms),
        medianNewTermsPerBlock: null, blocksUsed: sum((x) => x.blocksUsed),
        useRate: blocks > 0 ? sum((x) => x.blocksUsed) / blocks : 0,
      }),
    );
  }
  lines.push(`log tool:search ${r.log.toolSearch}  tool:ask ${r.log.toolAsk}  (since ${r.since}${r.log.workspaces.length > 1 ? `, per workspace: ${r.log.workspaces.map((w) => `${w.workspace} ${w.toolSearch}/${w.toolAsk}`).join(", ")}` : ""})`);
  return lines.join("\n");
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    process.stderr.write(`fact: ${parsed.fact}\nreason: ${parsed.reason}\nfix: ${parsed.fix}\n`);
    process.exit(1);
  }
  const res = await evalUse(parsed.args);
  if ("fact" in res) {
    process.stderr.write(`fact: ${res.fact}\nreason: ${res.reason}\nfix: ${res.fix}\n`);
    process.exit(1);
  }
  process.stdout.write((parsed.json ? JSON.stringify(res, null, 1) : formatTable(res)) + "\n");
}
