// v0.5.11 (ADR-0020, owner 2026-11-24: "we need concrete metrics and a way to
// visualize the memory"; local HTML file; counts plus ledger text, the
// counts-only pilot left without text). The memory report: one self-contained HTML
// page per workspace that shows what the rig's memory holds, how the seats use
// it, whether work with memory goes better, and the ledger as a timeline.
//
// Pure: the bin (plugin/bin/report.ts) reads the plugin's own log, the outcome
// log, the stale file and the ledger, and passes them in; this module only
// counts and renders. No model, no network, no script in the page. Every
// string from memory is redacted and HTML-escaped; with countsOnly no memory
// text is written at all - ids, kinds, seats, times and numbers only.

import { redact } from "./redact.ts";
import { sanitizeVisible } from "./pointer.ts";
import { currentLedger, usedApproval, type LedgerEntry } from "./ledger.ts";
import { hasRealFollowOn, isMachineryRow, type OutcomeRecord } from "./outcomes.ts";
import { parseShownList, SHOWN_KINDS, type ShownKind } from "./shown.ts";
import { scannableEntry } from "./stop.ts";
import { modelFromInput } from "./log.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** What the bin hands in. Null parts were not reachable and are shown as such. */
export interface ReportInput {
  rig: string;
  workspace: string;
  now: string;
  /** days of usage shown (the log window) */
  days: number;
  countsOnly: boolean;
  logLines: unknown[];
  outcomes: OutcomeRecord[];
  ledger: LedgerEntry[] | null;
  closed?: ReadonlySet<string>;
  stored: {
    sessions: number | null;
    conclusions: number | null;
    /** conclusions each seat recorded (observer), from the server's totals */
    byObserver: Record<string, number | null>;
  } | null;
  stale: { pending: number; kept: number } | null;
}

// ------------------------------------------------------------------ usage

/** The usage kinds counted per day and per seat, in display order. */
export const USAGE_KINDS = [
  "recorded",
  "digest",
  "recall",
  "pointer",
  "search",
  "ask",
  "remember",
  "retire",
  "stale_review",
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_LABEL: Record<UsageKind, string> = {
  recorded: "messages recorded",
  digest: "digests",
  recall: "added to prompts",
  pointer: "claim pointers",
  search: "searches",
  ask: "asks",
  remember: "remember",
  retire: "retire",
  stale_review: "stale reviews",
};

export interface Usage {
  days: string[];
  /** day -> kind -> count */
  byDay: Record<string, Record<UsageKind, number>>;
  /** seat -> kind -> count (whole window) */
  bySeat: Record<string, Record<UsageKind, number>>;
  totals: Record<UsageKind, number>;
  /** hook -> {n, p50, p95, failures} over the window */
  hooks: Record<string, { n: number; p50: number | null; p95: number | null; failures: number }>;
}

const zero = (): Record<UsageKind, number> =>
  Object.fromEntries(USAGE_KINDS.map((k) => [k, 0])) as Record<UsageKind, number>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** One log line -> every usage it counts (kind and amount); empty for none.
 * Same arm rules as the outcome collector (outcomes.ts memoryWindow): a held
 * recall wrote nothing to the prompt, so it is not "added to prompts" (R24
 * F-B); the claim pointer counts on the recall line and, for logs from
 * before O6, on the user-prompt line - one line can carry both a recorded
 * message and a pointer (R24 F-C). */
export function usageOf(o: Record<string, unknown>): { kind: UsageKind; n: number }[] {
  const hook = o.hook;
  const ev = typeof o.event === "string" ? o.event : "";
  const out: { kind: UsageKind; n: number }[] = [];
  if ((hook === "user-prompt" || hook === "stop") && ev === "sent") out.push({ kind: "recorded", n: Math.max(1, num(o.n_msgs)) });
  if (hook === "user-prompt" && o.pointer === "shown") out.push({ kind: "pointer", n: 1 });
  if (hook === "session-start" && typeof o.moment === "string" && o.ok !== false) out.push({ kind: "digest", n: 1 });
  if (hook === "recall" && ev === "injected" && o.arm !== "held") out.push({ kind: "recall", n: 1 });
  if (hook === "recall" && ev === "pointer" && o.pointer === "shown") out.push({ kind: "pointer", n: 1 });
  if (hook === "mcp" && ev.startsWith("tool:")) {
    const t = ev.slice(5);
    if (t === "search" || t === "ask" || t === "remember" || t === "retire" || t === "stale_review") out.push({ kind: t, n: 1 });
  }
  return out;
}

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

/** Usage over the last `days` days ending at `now` (UTC days). */
export function usage(logLines: unknown[], now: string, days: number): Usage {
  const end = Date.parse(now);
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  const first = dayKeys[0] as string;
  const byDay: Record<string, Record<UsageKind, number>> = Object.fromEntries(dayKeys.map((d) => [d, zero()]));
  const bySeat: Record<string, Record<UsageKind, number>> = {};
  const totals = zero();
  const ms: Record<string, number[]> = {};
  const failures: Record<string, number> = {};
  for (const raw of logLines) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const ts = typeof o.ts === "string" ? o.ts : "";
    const day = ts.slice(0, 10);
    if (day < first || Date.parse(ts) > end || !(day in byDay)) continue;
    const hook = typeof o.hook === "string" ? o.hook : "";
    if (hook !== "") {
      (ms[hook] ??= []).push(num(o.ms));
      if (o.ok === false) failures[hook] = (failures[hook] ?? 0) + 1;
    }
    const seat = typeof o.peer === "string" && o.peer !== "" ? o.peer : "(unknown)";
    for (const u of usageOf(o)) {
      (byDay[day] as Record<UsageKind, number>)[u.kind] += u.n;
      totals[u.kind] += u.n;
      (bySeat[seat] ??= zero())[u.kind] += u.n;
    }
  }
  const hooks: Usage["hooks"] = {};
  for (const [h, list] of Object.entries(ms)) {
    const s = list.slice().sort((a, b) => a - b);
    hooks[h] = { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), failures: failures[h] ?? 0 };
  }
  return { days: dayKeys, byDay, bySeat, totals, hooks };
}

// ------------------------------------------------------ shown against used
// B11 (ADR-0022 d4), amended by B12 (review R27): shown ids against cited
// and acted ids, per entry kind and model family, plus the entries that
// cost context with no evidence. Counts and ids from the log lines
// themselves, same window as the usage table. Codex caveat carried on the
// page (b98ef14): the Stop hook sees no Codex tool-call input, so Codex
// acted counts are NOT MEASURED (not zero) - Codex lines show cited only,
// and the costs list needs cited OR acted to clear an entry.

export const MODEL_FAMILIES = ["claude", "local", "other", "unknown"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const FAMILY_LABEL: Record<ModelFamily, string> = {
  claude: "claude",
  local: "local model",
  other: "other",
  unknown: "unknown",
};

/** Model id -> family (ADR-0022 d4, amended at b98ef14). Claude ids are
 * claude-*; ids of hosted vendor models (gpt-, o1/o3/o4-style, gemini,
 * grok) are other; any other valid id is a local model, as a rig's own
 * engine serves it. unknown means NO VALID MODEL ID: the line never
 * carried one (pre-v0.5.13 logs, Claude session-start and recall lines),
 * or the value failed the modelFromInput check. */
export function modelFamily(id: unknown): ModelFamily {
  if (typeof id !== "string" || id === "") return "unknown";
  // F-V4 (review R27): validate with the same gate every writer uses
  // (modelFromInput, log.ts). A hand-edited value is "unknown" - unknown
  // means "no valid model id", so a hostile string never becomes a family
  // label. Nothing prints here: only the four fixed labels ever leave.
  if (modelFromInput(id) === undefined) return "unknown";
  const s = id.toLowerCase();
  if (s.startsWith("claude")) return "claude";
  if (/^(gpt|chatgpt|o[0-9]|gemini|grok)/.test(s)) return "other";
  return "local";
}

/** How far a model-less shown line looks for its seat's next
 * model-carrying line (architect 2026-11-26: normally the Stop of that
 * turn). Beyond this it stays unknown; the log gains no new field. */
const MODEL_LOOKAHEAD_MS = 60 * 60_000;

/** Entries shown at least this many times and never used are listed. */
export const COSTS_MIN = 5;

export interface ShownUsedCell {
  shown: number;
  cited: number;
  acted: number;
  /** cited + acted, kept for compatibility (ADR-0022 d3 amendment); the
   * table never prints it on its own. */
  used: number;
}

export interface ShownUsed {
  /** family -> kind -> counts over the window */
  cells: Record<ModelFamily, Record<ShownKind, ShownUsedCell>>;
  /** entry (kind:id) -> counts over the window */
  entries: Map<string, { kind: ShownKind; shown: number; cited: number; acted: number }>;
  /** false when no line in the window carried a valid shown/used/cited/acted list */
  live: boolean;
}

/** Shown vs used over the same `days` window as the usage table. Kinds come
 * from the entry prefix (entries are grammar-validated by parseShownList). */
export function shownUsed(logLines: unknown[], now: string, days: number): ShownUsed {
  const end = Date.parse(now);
  const first = new Date(end - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const cells = Object.fromEntries(
    MODEL_FAMILIES.map((f) => [f, Object.fromEntries(SHOWN_KINDS.map((k) => [k, { shown: 0, cited: 0, acted: 0, used: 0 }]))]),
  ) as Record<ModelFamily, Record<ShownKind, ShownUsedCell>>;
  const entries = new Map<string, { kind: ShownKind; shown: number; cited: number; acted: number }>();
  let live = false;
  // Per-seat model timeline (architect 2026-11-26): a shown line with no
  // model id borrows the model of the SAME seat's next model-carrying line
  // within MODEL_LOOKAHEAD_MS (normally the Stop of that turn - Claude
  // session-start and recall lines carry no model). Used lines keep their
  // own model: only Stop logs used, and Stop carries the model. A line with
  // no peer, no later model line, or one beyond the hour stays unknown.
  const timeline = new Map<string, { ts: number; model: string }[]>();
  for (const raw of logLines) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.model !== "string" || o.model === "") continue;
    if (typeof o.peer !== "string" || o.peer === "") continue;
    const t = Date.parse(typeof o.ts === "string" ? o.ts : "");
    if (Number.isNaN(t)) continue;
    let list = timeline.get(o.peer);
    if (list === undefined) {
      list = [];
      timeline.set(o.peer, list);
    }
    list.push({ ts: t, model: o.model });
  }
  for (const list of timeline.values()) list.sort((a, b) => a.ts - b.ts);
  const borrow = (peer: unknown, t: number): ModelFamily => {
    if (typeof peer !== "string" || peer === "") return "unknown";
    const list = timeline.get(peer);
    if (list === undefined || list.length === 0) return "unknown";
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as { ts: number }).ts < t) lo = mid + 1;
      else hi = mid;
    }
    const hit = list[lo];
    return hit !== undefined && hit.ts - t <= MODEL_LOOKAHEAD_MS ? modelFamily(hit.model) : "unknown";
  };
  const bump = (list: string[] | undefined, field: "shown" | "cited" | "acted" | "used", fam: ModelFamily): void => {
    if (list === undefined) return;
    for (const e of list) {
      const kind = e.slice(0, e.indexOf(":")) as ShownKind;
      const cell = cells[fam][kind];
      if (cell !== undefined) cell[field] += 1;
      const ent = entries.get(e) ?? { kind, shown: 0, cited: 0, acted: 0 };
      if (field !== "used") ent[field] += 1; // entries carry the split; used is the compat union
      entries.set(e, ent);
    }
  };
  for (const raw of logLines) {
    if (raw === null || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const ts = typeof o.ts === "string" ? o.ts : "";
    const day = ts.slice(0, 10);
    if (day === "" || day < first || Date.parse(ts) > end) continue;
    const shownList = parseShownList(o.shown);
    const usedRaw = parseShownList(o.used);
    const citedRaw = parseShownList(o.cited);
    const actedRaw = parseShownList(o.acted);
    if (shownList === undefined && usedRaw === undefined && citedRaw === undefined && actedRaw === undefined) continue;
    live = true;
    // B12 (R27 amendment): lines from before the split carry only `used` -
    // those were substring matches, the weakest evidence, so they fold into
    // cited and never into acted (v0.6 evidence reads acted). New lines use
    // their own lists; used = usedRaw ?? cited + acted union.
    const cited = citedRaw ?? usedRaw ?? [];
    const acted = actedRaw ?? [];
    const used = usedRaw ?? [...new Set([...cited, ...acted])].sort();
    const ownFam = modelFamily(o.model);
    bump(shownList, "shown", ownFam === "unknown" ? borrow(o.peer, Date.parse(ts)) : ownFam);
    bump(cited, "cited", ownFam);
    bump(acted, "acted", ownFam);
    bump(used, "used", ownFam);
  }
  return { cells, entries, live };
}

/** Entries shown at least COSTS_MIN times and NEVER CITED AND NEVER ACTED,
 * worst first (b98ef14: Codex seats have no measured acted counts, so a
 * never-acted rule would list every Codex entry forever - any evidence,
 * cited or acted, takes an entry off the list).
 * N-F24 (B13): skip entries the scanner refuses to scan (short or all-letter
 * conclusion ids) - their use is never looked for, so calling them "never
 * cited or acted" would be dishonest. No new label; the Shown column is
 * unaffected, they simply never appear here. */
export function costsContext(su: ShownUsed): { entry: string; kind: ShownKind; shown: number }[] {
  return [...su.entries.entries()]
    .filter(([entry, v]) => scannableEntry(entry) && v.shown >= COSTS_MIN && v.cited === 0 && v.acted === 0)
    .map(([entry, v]) => ({ entry, kind: v.kind, shown: v.shown }))
    .sort((a, b) => b.shown - a.shown || a.entry.localeCompare(b.entry));
}

// --------------------------------------------------------------- outcomes

export interface OutcomeGroup {
  label: string;
  rows: number;
  reworkShare: number | null;
  medianHours: number | null;
}

const medianOf = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

function group(label: string, rs: OutcomeRecord[], byId: Map<string, OutcomeRecord>): OutcomeGroup {
  const spans = rs
    .map((r) => (r.claimed !== null && r.closed !== null ? (Date.parse(r.closed) - Date.parse(r.claimed)) / 3_600_000 : Number.NaN))
    .filter((v) => Number.isFinite(v) && v >= 0);
  return {
    label,
    rows: rs.length,
    reworkShare: rs.length === 0 ? null : rs.filter((r) => hasRealFollowOn(r, byId) || r.reopenCount > 0).length / rs.length,
    medianHours: medianOf(spans),
  };
}

/**
 * Whether work goes better with memory. Two comparisons over claimed rows:
 * the claim pointer's holdout (shown vs held - the arm is assigned by a hash,
 * so this is the fair one), and any memory shown vs none (observational:
 * busier rows see more memory, so read it as a trend, not a cause). Rework =
 * a real follow-on row or a reopen.
 */
export function outcomeGroups(records: OutcomeRecord[]): {
  holdout: OutcomeGroup[];
  exposure: OutcomeGroup[];
  /** every row in the outcome log (the collector records done rows only) */
  closedRows: number;
  /** closed rows left out as OpenRig housekeeping */
  housekeeping: number;
  /** closed rows never claimed (no work to compare) */
  unclaimed: number;
  /** rows in the comparisons: closed, claimed, not housekeeping */
  compared: number;
  /** compared rows that carry their commits */
  withCommits: number;
} {
  const byId = new Map(records.map((r) => [r.qitemId, r]));
  // Every row in the outcome log is a done row: the collector lists state
  // done only, and closed === null just means the daemon left out the close
  // time (the median skips those). OpenRig housekeeping rows (recovery, wake
  // escalations) close at once and are not work: the same machinery test the
  // outcome summary uses. Every number the page prints about these rows
  // uses the same filter, and the sentence adds up (R24 F-D, F-J).
  const closedRs = records;
  const claimed = closedRs.filter((r) => r.claimed !== null && !isMachineryRow(r));
  const shownAny = (r: OutcomeRecord): boolean => r.memory.digestShown + r.memory.recallShown + r.memory.pointerShown > 0;
  return {
    holdout: [
      group("claim pointer shown", claimed.filter((r) => r.memory.pointerShown > 0), byId),
      group("claim pointer held back", claimed.filter((r) => r.memory.pointerHeld > 0 && r.memory.pointerShown === 0), byId),
    ],
    exposure: [
      group("memory shown during the work", claimed.filter(shownAny), byId),
      group("no memory shown", claimed.filter((r) => !shownAny(r)), byId),
    ],
    closedRows: closedRs.length,
    housekeeping: closedRs.filter((r) => isMachineryRow(r)).length,
    unclaimed: closedRs.filter((r) => r.claimed === null && !isMachineryRow(r)).length,
    compared: claimed.length,
    withCommits: claimed.filter((r) => r.commits !== undefined && r.commits.files !== null).length,
  };
}

// ----------------------------------------------------------------- ledger

export interface LedgerNode {
  id: string;
  kind: "decision" | "approval" | "status";
  at: string;
  scope: string;
  state: "in force" | "superseded" | "retired" | "used" | "out of force";
  supersedes?: string;
  retiredAt?: string;
  text?: string;
}

export const TEXT_MAX = 200;
export const SCOPE_MAX = 80;

/** Memory text for the page: redacted (the same rules as every outbound
 * path), invisible and control characters removed, whitespace collapsed,
 * capped. HTML escaping happens at render. */
export function clean(s: string, max: number): string {
  return sanitizeVisible(redact(s).text.replace(/\s+/g, " ")).slice(0, max);
}

/** A server time re-written by us: an ISO string when it parses, else blank -
 * the time is printed (Since column, tooltips), so no server bytes ride it
 * (R24 F-G). */
function isoOrBlank(s: string): string {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

/** The ledger as nodes with their state, oldest first. Text only when allowed. */
export function ledgerNodes(entries: LedgerEntry[], closed: ReadonlySet<string> | undefined, countsOnly: boolean): LedgerNode[] {
  const inForce = new Set(currentLedger(entries, closed).map((e) => e.id));
  const retiredAt = new Map<string, string>();
  const supersededBy = new Set<string>();
  for (const e of entries) {
    if (e.kind === "retire" && e.target !== undefined) retiredAt.set(e.target, e.at);
    if (e.kind !== "retire" && e.supersedes !== undefined) supersededBy.add(e.supersedes);
  }
  const nodes: LedgerNode[] = [];
  for (const e of entries) {
    if (e.kind === "retire") continue;
    const at = isoOrBlank(e.at);
    const state: LedgerNode["state"] = inForce.has(e.id)
      ? "in force"
      : retiredAt.has(e.id)
        ? "retired"
        : usedApproval(e, closed)
          ? "used"
          : supersededBy.has(e.id) || e.kind === "status"
            ? "superseded"
            : "out of force";
    nodes.push({
      id: e.id,
      kind: e.kind,
      at,
      // the scope is server text too: redacted, visible characters only and
      // capped like the fact (R24 F-A, N-A); never shown counts-only
      scope: countsOnly ? "" : clean(e.scope, SCOPE_MAX),
      state,
      ...(e.supersedes !== undefined ? { supersedes: e.supersedes } : {}),
      ...(retiredAt.has(e.id) ? { retiredAt: isoOrBlank(retiredAt.get(e.id) as string) } : {}),
      ...(countsOnly ? {} : { text: clean(e.fact, TEXT_MAX) }),
    });
  }
  return nodes.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ----------------------------------------------------------------- render

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtPct = (v: number | null): string => (v === null ? "-" : `${Math.round(v * 100)}%`);
const fmtNum = (v: number | null | undefined): string => (v === null || v === undefined ? "-" : v.toLocaleString("en-US"));
const fmtH = (v: number | null): string => (v === null ? "-" : v < 1 ? `${Math.round(v * 60)} min` : `${v.toFixed(1)} h`);

const KIND_COLOR: Record<UsageKind, string> = {
  recorded: "var(--c1)",
  digest: "var(--c2)",
  recall: "var(--c3)",
  pointer: "var(--c4)",
  search: "var(--c5)",
  ask: "var(--c6)",
  remember: "var(--c7)",
  retire: "var(--c8)",
  stale_review: "var(--c6)",
};

/** Daily small multiples: one bar row per usage kind (own scale each, so a
 * rare kind is not flattened by the message count). */
function usageChart(u: Usage): string {
  const W = 640;
  const rowH = 34;
  const left = 190;
  const barW = (W - left - 10) / Math.max(1, u.days.length);
  const rows = USAGE_KINDS.map((k, i) => {
    const max = Math.max(1, ...u.days.map((d) => (u.byDay[d] as Record<UsageKind, number>)[k]));
    const y0 = i * rowH;
    const bars = u.days
      .map((d, j) => {
        const v = (u.byDay[d] as Record<UsageKind, number>)[k];
        const h = Math.round((v / max) * (rowH - 12));
        return `<rect x="${(left + j * barW + 1).toFixed(1)}" y="${y0 + rowH - 4 - h}" width="${Math.max(1, barW - 2).toFixed(1)}" height="${h}" fill="${KIND_COLOR[k]}"><title>${esc(d)}: ${v} ${esc(USAGE_LABEL[k])}</title></rect>`;
      })
      .join("");
    return `<text x="0" y="${y0 + rowH - 8}" class="lbl">${esc(USAGE_LABEL[k])}</text><text x="${left - 8}" y="${y0 + rowH - 8}" class="lbl" text-anchor="end">${fmtNum(u.totals[k])}</text>${bars}`;
  }).join("");
  const H = USAGE_KINDS.length * rowH + 18;
  const ticks = [0, Math.floor((u.days.length - 1) / 2), u.days.length - 1]
    .map((j) => `<text x="${(left + j * barW + barW / 2).toFixed(1)}" y="${H - 2}" class="lbl" text-anchor="middle">${esc((u.days[j] as string).slice(5))}</text>`)
    .join("");
  return `<figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily memory use by kind over the last ${u.days.length} days">${rows}${ticks}</svg><figcaption>Daily use per kind, each row on its own scale; the number is the total for the window.</figcaption></figure>`;
}

/** The ledger as a timeline: one lane per kind, a dot per entry (filled = in
 * force), a line from each entry to the one it supersedes, a cross where it
 * was retired. */
const KINDS: ReadonlySet<string> = new Set(["decision", "approval", "status"]);

function ledgerChart(nodes: LedgerNode[]): string {
  if (nodes.length === 0) return `<p class="muted">The ledger is empty.</p>`;
  // entries without a readable time cannot be placed (R24 F-E): left out of
  // the chart and counted under it, never a failed page
  const all = nodes;
  nodes = all.filter((n) => Number.isFinite(Date.parse(n.at)));
  const undated = all.length - nodes.length;
  const undatedNote = undated > 0 ? ` ${undated} ${undated === 1 ? "entry has" : "entries have"} no readable time and ${undated === 1 ? "is" : "are"} not drawn.` : "";
  if (nodes.length === 0) return `<p class="muted">No ledger entry has a readable time, so the timeline is not drawn.${undatedNote}</p>`;
  const retiredOk = (n: LedgerNode): boolean => n.retiredAt !== undefined && Number.isFinite(Date.parse(n.retiredAt));
  const W = 640;
  const left = 80;
  const lanes = ["decision", "approval", "status"] as const;
  const laneY = (k: LedgerNode["kind"]): number => 22 + lanes.indexOf(k) * 34;
  // the domain spans the retirements too, so a late × stays on the chart (R24 F-F)
  const times = [...nodes.map((n) => Date.parse(n.at)), ...nodes.filter(retiredOk).map((n) => Date.parse(n.retiredAt as string))];
  const t0 = Math.min(...times);
  const t1 = Math.max(t0 + DAY_MS, ...times);
  const x = (at: string): number => left + ((Date.parse(at) - t0) / (t1 - t0)) * (W - left - 14);
  const pos = new Map(nodes.map((n) => [n.id, { x: x(n.at), y: laneY(n.kind) }]));
  const links = nodes
    .filter((n) => n.supersedes !== undefined && pos.has(n.supersedes))
    .map((n) => {
      const a = pos.get(n.id) as { x: number; y: number };
      const b = pos.get(n.supersedes as string) as { x: number; y: number };
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y}" x2="${b.x.toFixed(1)}" y2="${b.y}" class="link"/>`;
    })
    .join("");
  const dots = nodes
    .map((n) => {
      const p = pos.get(n.id) as { x: number; y: number };
      const cls = `${n.state === "in force" ? "dot on" : "dot off"} ${KINDS.has(n.kind) ? n.kind : ""}`;
      const cross = retiredOk(n) ? `<text x="${x(n.retiredAt).toFixed(1)}" y="${p.y + 4}" class="x" text-anchor="middle">×</text>` : "";
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y}" r="4" class="${cls}"><title>${esc(n.id)} ${esc(n.kind)}, ${esc(n.state)}, ${esc(n.at.slice(0, 16))}</title></circle>${cross}`;
    })
    .join("");
  const laneLabels = lanes.map((k) => `<text x="0" y="${laneY(k) + 4}" class="lbl">${k === "status" ? "statuses" : `${k}s`}</text><line x1="${left}" y1="${laneY(k)}" x2="${W - 10}" y2="${laneY(k)}" class="lane"/>`).join("");
  const H = 22 + lanes.length * 34;
  const axis = `<text x="${left}" y="${H - 2}" class="lbl">${esc(new Date(t0).toISOString().slice(0, 10))}</text><text x="${W - 10}" y="${H - 2}" class="lbl" text-anchor="end">${esc(new Date(t1).toISOString().slice(0, 10))}</text>`;
  return `<figure><svg viewBox="0 0 ${W} ${H + 4}" role="img" aria-label="Ledger timeline: ${nodes.length} entries by kind, in force filled, supersede links drawn">${laneLabels}${links}${dots}${axis}</svg><figcaption>Each dot is a ledger entry (filled: in force; hollow: superseded, retired or used). A line joins an entry to the one it replaced; × marks when an entry was retired.${undatedNote}</figcaption></figure>`;
}

function table(head: string[], rows: string[][]): string {
  return `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

const STYLE = `:root{--bg:#fbfbf9;--fg:#1d1d1b;--muted:#6b6b66;--line:#d9d9d2;--card:#ffffff;--c1:#4c78a8;--c2:#72b7b2;--c3:#54a24b;--c4:#eeca3b;--c5:#f58518;--c6:#b279a2;--c7:#e45756;--c8:#9d755d}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ecece8;--muted:#a3a39c;--line:#3a3a36;--card:#1f1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}
.muted,.lbl,figcaption{color:var(--muted)}.lbl{font-size:11px;fill:var(--muted)}figcaption{font-size:13px;margin-top:4px}
figure{margin:8px 0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}svg{width:100%;height:auto;display:block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile b{display:block;font-size:22px}.tile span{font-size:13px;color:var(--muted)}
.tw{overflow-x:auto;margin:10px 0 14px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.lane{stroke:var(--line)}.link{stroke:var(--muted);stroke-width:1;opacity:.6}.dot{stroke-width:1.5}.dot.on{fill:currentColor}.dot.off{fill:var(--bg)}
.dot.decision{stroke:var(--c1);color:var(--c1)}.dot.approval{stroke:var(--c7);color:var(--c7)}.dot.status{stroke:var(--c3);color:var(--c3)}.x{fill:var(--muted);font-size:12px}`;

/** The whole page. */
export function renderReport(input: ReportInput): string {
  const u = usage(input.logLines, input.now, input.days);
  const og = outcomeGroups(input.outcomes);
  const nodes = input.ledger === null ? null : ledgerNodes(input.ledger, input.closed, input.countsOnly);
  const kindCount = (k: LedgerNode["kind"], s?: LedgerNode["state"]): number =>
    (nodes ?? []).filter((n) => n.kind === k && (s === undefined || n.state === s)).length;
  const tile = (v: string, label: string): string => `<div class="tile"><b>${v}</b><span>${esc(label)}</span></div>`;
  const st = input.stored;
  const su = shownUsed(input.logLines, input.now, input.days);
  const parts: string[] = [];
  parts.push(
    `<h1>Memory report: ${esc(input.rig)}</h1><p class="muted">Workspace ${esc(input.workspace)} · ${esc(input.now.slice(0, 16).replace("T", " "))}Z · usage over the last ${input.days} days${input.countsOnly ? " · counts only, no memory text" : ""}</p>`,
  );
  parts.push(`<h2>What the memory holds</h2><div class="tiles">${[
    tile(fmtNum(u.totals.recorded), `messages recorded (${input.days} d)`),
    tile(st === null ? "-" : fmtNum(st.conclusions), "conclusions derived (all time)"),
    tile(st === null ? "-" : fmtNum(st.sessions), "sessions"),
    tile(nodes === null ? "-" : fmtNum(nodes.length), "ledger entries"),
    tile(nodes === null ? "-" : fmtNum(nodes.filter((n) => n.state === "in force").length), "ledger entries in force"),
    tile(input.stale === null ? "-" : fmtNum(input.stale.pending), "stale proposals pending"),
  ].join("")}</div>`);
  if (nodes !== null) {
    parts.push(
      table(
        ["Ledger kind", "Entries", "In force", "Superseded", "Retired", "Used", "Other"],
        (["decision", "approval", "status"] as const).map((k) => [
          `${k === "status" ? "statuses" : `${k}s`}`,
          fmtNum(kindCount(k)),
          fmtNum(kindCount(k, "in force")),
          fmtNum(kindCount(k, "superseded")),
          fmtNum(kindCount(k, "retired")),
          fmtNum(kindCount(k, "used")),
          fmtNum(kindCount(k, "out of force")),
        ]),
      ),
    );
  }
  if (st !== null && Object.keys(st.byObserver).length > 0) {
    parts.push(
      table(
        ["Seat", "Conclusions it holds (all time)", `Messages recorded (${input.days} d)`],
        Object.keys({ ...st.byObserver, ...u.bySeat })
          .sort()
          .map((s) => [esc(sanitizeVisible(s)), fmtNum(st.byObserver[s]), fmtNum(u.bySeat[s]?.recorded ?? 0)]),
      ),
    );
  }
  parts.push(`<h2>How the seats use it</h2>${usageChart(u)}`);
  parts.push(
    table(
      ["Seat", ...USAGE_KINDS.map((k) => USAGE_LABEL[k])],
      Object.keys(u.bySeat)
        .sort()
        .map((s) => [esc(sanitizeVisible(s)), ...USAGE_KINDS.map((k) => fmtNum((u.bySeat[s] as Record<UsageKind, number>)[k]))]),
    ),
  );
  parts.push(`<h2>Shown against used</h2>`);
  if (!su.live) {
    parts.push(`<p class="muted">No shown ids in this log window yet - the shown/used measurement lands with v0.5.13.</p>`);
  } else {
    const suRows: string[][] = [];
    for (const f of MODEL_FAMILIES) {
      for (const k of SHOWN_KINDS) {
        const c = su.cells[f][k] as ShownUsedCell;
        if (c.shown === 0 && c.cited === 0 && c.acted === 0) continue;
        suRows.push([FAMILY_LABEL[f], `${k}s`, fmtNum(c.shown), fmtNum(c.cited), fmtNum(c.acted)]);
      }
    }
    parts.push(table(["Model family", "Entry kind", "Shown", "Cited", "Acted"], suRows));
    parts.push(
      `<p class="muted">Shown: the entry's line reached the prompt. Cited: the id appeared in the seat's own text or final message - an echo counts here. Acted: the id appeared in a tool_use input - a rig_memory call or a queue command. v0.6 evidence counts acted only; Codex acted counts are not measured (Codex transcripts carry no tool-call input), so Codex entries show cited only. Claude shown counts take the model of the seat's next Stop line within the hour; with none in time they stay unknown.</p>`,
    );
    const costs = costsContext(su);
    parts.push(
      `<h3>Costs context, no evidence</h3><p class="muted">Entries shown at least ${COSTS_MIN} times in this window and never cited or acted - ids and counts only.</p>`,
    );
    parts.push(
      costs.length === 0
        ? `<p class="muted">None in this window.</p>`
        : table(
            ["Entry", "Kind", "Times shown"],
            costs.map((c) => [esc(c.entry), esc(c.kind), fmtNum(c.shown)]),
          ),
    );
  }
  parts.push(`<h2>Does work go better with memory?</h2><p class="muted">From the outcome log: ${fmtNum(og.closedRows)} closed ${og.closedRows === 1 ? "row" : "rows"}, ${fmtNum(og.compared)} compared below${og.housekeeping > 0 ? `; left out: ${fmtNum(og.housekeeping)} OpenRig housekeeping` : ""}${og.unclaimed > 0 ? `${og.housekeeping > 0 ? "," : "; left out:"} ${fmtNum(og.unclaimed)} never claimed` : ""}${og.withCommits > 0 ? `; ${fmtNum(og.withCommits)} of the compared ${og.withCommits === 1 ? "carries its" : "carry their"} commits` : ""}. Rework is a follow-on row or a reopen. The claim pointer's holdout is assigned by a hash, so it is the fair comparison; the second table is a trend only - busier work sees more memory.</p>`);
  const ogRows = (gs: OutcomeGroup[]): string[][] => gs.map((g) => [esc(g.label), fmtNum(g.rows), fmtPct(g.reworkShare), fmtH(g.medianHours)]);
  parts.push(table(["Holdout", "Rows", "Rework", "Median claim to close"], ogRows(og.holdout)));
  parts.push(table(["Exposure", "Rows", "Rework", "Median claim to close"], ogRows(og.exposure)));
  parts.push(`<h2>The ledger over time</h2>${nodes === null ? `<p class="muted">The ledger could not be read.</p>` : ledgerChart(nodes)}`);
  if (nodes !== null && nodes.length > 0) {
    const shown = nodes.filter((n) => n.state === "in force").slice().reverse();
    parts.push(
      table(
        input.countsOnly ? ["In force", "Kind", "Since"] : ["In force", "Kind", "Scope", "Since", "Text"],
        shown.map((n) => [esc(n.id), esc(n.kind), ...(input.countsOnly ? [] : [esc(n.scope)]), esc(n.at.slice(0, 10)), ...(input.countsOnly ? [] : [esc(n.text ?? "")])]),
      ),
    );
  }
  parts.push(`<h2>Health</h2>`);
  parts.push(
    table(
      ["Hook", "Runs", "p50", "p95", "Failures"],
      Object.entries(u.hooks)
        .sort()
        .map(([h, v]) => [esc(sanitizeVisible(h)), fmtNum(v.n), v.p50 === null ? "-" : `${v.p50} ms`, v.p95 === null ? "-" : `${v.p95} ms`, fmtNum(v.failures)]),
    ),
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Memory report</title><style>${STYLE}</style></head><body><main>${parts.join("\n")}</main></body></html>\n`;
}
