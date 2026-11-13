// V4 (ADR-0019 decision 4): stale proposals. An on-demand command (bin
// stale-check.ts, NEVER a hook) asks a local OpenAI-compatible model whether
// a new ledger entry makes an earlier in-force entry stale. The measured
// method is the architect's store-test evaluation
// (docs/stale-proposals-eval-2026-11.md): a rule-or-state CLASS per entry
// first, then one call per entry over STATE entries only. The two prompts
// below are ported VERBATIM from the evaluated script (stale_eval.py with
// CLASSIFY=1) - they are the measured ones; do not redesign them here.
//
// A yes is a PROPOSAL shown to the lead seat, never an automatic change.
// Everything lives in one local JSON file per workspace (0600, folder 0700,
// the checkpoint.ts writeJsonAtomic idiom); nothing goes to Honcho; the API
// key never enters this module's storage or output.

import { join } from "node:path";
import { writeJsonAtomic } from "./lock.ts";
import { readFileSync, existsSync } from "node:fs";
import { currentLedger, toEntries, type LedgerEntry } from "./ledger.ts";
import type { Conclusion } from "./honcho.ts";
import type { Config } from "./env.ts";

// ---------------------------------------------------------------- the prompts

/** The evaluated PROMPT (stale_eval.py lines 19-40), placeholders filled. */
export function fillPrompt(newEntry: string, oldEntries: string): string {
  return (
    "You maintain a team's decision ledger. Each entry is a decision, an approval or a status report.\n" +
    "A NEW entry has just been recorded. Decide which of the EARLIER entries it makes stale.\n" +
    "\n" +
    "An earlier entry is stale when the new entry shows that what it describes is no longer the current state:\n" +
    '- a later status replaces it (for example "main is at X" after a later release moved main, or "waiting for the owner\'s word" after the release shipped);\n' +
    "- something it reports as pending, held or proposed has now been done, resolved or reversed;\n" +
    "- an acceptance or approval it records has been withdrawn, or a withdrawal has been undone.\n" +
    "\n" +
    "An earlier entry is NOT stale when:\n" +
    "- it is a standing rule, a ruling or a lasting owner instruction that the new entry does not explicitly change;\n" +
    '- it records an event that stays true as history and claims nothing about the present (only if it carries no "current state" such as where main is);\n' +
    "- the new entry is merely about a related topic.\n" +
    "\n" +
    "Be conservative: propose only entries the new entry clearly makes stale.\n" +
    "\n" +
    "NEW entry:\n" +
    `${newEntry}\n` +
    "\n" +
    "EARLIER entries in force:\n" +
    `${oldEntries}\n` +
    "\n" +
    'Answer with JSON only: {"stale": [{"id": "<earlier id>", "why": "<one short sentence>"}]}. Use an empty list when none is stale.'
  );
}

/** The evaluated CLASSIFY prompt (stale_eval.py lines 43-51), placeholder filled. */
export function fillClassify(entry: string): string {
  return (
    "Classify one entry of a team's decision ledger.\n" +
    '- "rule": a standing rule, ruling, policy or lasting owner instruction that keeps applying until someone explicitly changes it (for example "never run X", "don\'t increment the version aggressively", "keep per-connection clients").\n' +
    '- "state": a report of where things stand at a moment: something published, accepted, approved for one release, held, pending, in progress, or where a branch points. It goes out of date when things move on.\n' +
    'If an entry mixes both, answer "state" only when its main content is a report of current state.\n' +
    "\n" +
    "Entry:\n" +
    `${entry}\n` +
    "\n" +
    'Answer with JSON only: {"class": "rule" | "state"}'
  );
}

/** The evaluated entry formatting: "[id | kind | YYYY-MM-DDTHH:MM] fact<=600". */
export function fmtEntry(e: LedgerEntry): string {
  return `[${e.id} | ${e.kind} | ${e.at.slice(0, 16)}] ${(e.fact ?? "").trim().slice(0, 600)}`;
}

// --------------------------------------------------------------------- state

export type StaleClass = "rule" | "state";

export interface StaleProposal {
  oldId: string;
  newId: string;
  why: string;
  /** the OLD entry's at (the digest line shows its age) */
  oldAt: string;
  /** the new entry's at (when the proposal arose) */
  at: string;
  shown: number;
}

export interface StaleState {
  version: 1;
  /** entry id -> class; absent = not yet classified */
  classes: Record<string, StaleClass>;
  /** the at of the last entry the PROMPT pass processed (inclusive) */
  lastCheckedAt: string | null;
  proposals: StaleProposal[];
}

/** <state-dir>/stale/<workspace>.json */
export function staleStatePath(stateDir: string, workspace: string): string {
  return join(stateDir, "stale", `${workspace}.json`);
}

const EMPTY: () => StaleState = () => ({ version: 1, classes: {}, lastCheckedAt: null, proposals: [] });

/** Read; any damage or absence is null (the next run starts clean). */
export function readStaleState(stateDir: string, workspace: string): StaleState | null {
  try {
    const p = staleStatePath(stateDir, workspace);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const v = JSON.parse(raw) as Partial<StaleState>;
    if (
      v === null || typeof v !== "object" || v.version !== 1 ||
      typeof v.classes !== "object" || v.classes === null ||
      !Array.isArray(v.proposals)
    )
      return null;
    const proposals: StaleProposal[] = [];
    for (const p of v.proposals) {
      if (
        p !== null && typeof p === "object" &&
        typeof p.oldId === "string" && typeof p.newId === "string" &&
        typeof p.why === "string" && typeof p.oldAt === "string" &&
        typeof p.at === "string" && typeof p.shown === "number"
      )
        proposals.push({ oldId: p.oldId, newId: p.newId, why: p.why, oldAt: p.oldAt, at: p.at, shown: p.shown });
    }
    const classes: Record<string, StaleClass> = {};
    for (const [k, c] of Object.entries(v.classes)) if (c === "rule" || c === "state") classes[k] = c;
    return {
      version: 1,
      classes,
      lastCheckedAt: typeof v.lastCheckedAt === "string" ? v.lastCheckedAt : null,
      proposals,
    };
  } catch {
    return null;
  }
}

/** 0600 file in a 0700 folder (writeJsonAtomic); false = not written. */
export function writeStaleState(stateDir: string, workspace: string, st: StaleState): boolean {
  return writeJsonAtomic(staleStatePath(stateDir, workspace), st);
}

// ------------------------------------------------------------ the model call

export interface ModelTarget {
  /** OpenAI-compatible base INCLUDING /v1, e.g. http://host:port/v1 */
  url: string;
  model: string;
  /** from the named environment variable only; never printed or stored */
  key: string;
  /** per-call timeout */
  timeoutMs: number;
}

/** One chat completion answering with a JSON object; null on ANY failure
 * (transport, timeout, non-2xx, non-JSON): an unparsable answer counts as
 * no proposal / the "state" class default, exactly as evaluated. */
async function chatJson(t: ModelTarget, prompt: string, cap: number): Promise<unknown> {
  try {
    const r = await fetch(`${t.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` },
      body: JSON.stringify({
        model: t.model,
        temperature: 0,
        max_tokens: cap,
        response_format: { type: "json_object" },
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the run

export interface StaleRunResult {
  error?: string;
  classified: number;
  checked: number;
  added: number;
  modelSeconds: number;
}

const ZEROS: StaleRunResult = { classified: 0, checked: 0, added: 0, modelSeconds: 0 };

/**
 * One measured pass (ADR-0019 d4) over an already-read ledger pair:
 * 1. CLASSIFY every not-yet-classified entry (one call each, "state" on any
 *    failure - conservative, matching the evaluation's default);
 * 2. for every entry NEWER than the last processed one: one PROMPT call over
 *    the in-force STATE entries strictly older than it; only candidate ids
 *    are accepted; an unparsable answer is no proposals;
 * 3. state saved per entry (resumable), one request at a time.
 * `items` is the whole ledger-pair conclusion page set (the caller read it
 * read-only through fetchLedgerPair). Returns counts only.
 */
export async function runStaleCheck(
  config: Config,
  target: ModelTarget,
  items: Conclusion[],
): Promise<StaleRunResult> {
  const all = toEntries(items);
  // chronological, retire entries excluded (the ledger code already handles them exactly)
  const entries = all
    .filter((e) => e.kind !== "retire")
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const inForce = currentLedger(all);
  const state = readStaleState(config.stateDir, config.workspace) ?? EMPTY();
  let classified = 0;
  let checked = 0;
  let added = 0;
  let ms = 0;

  for (const e of entries) {
    if (state.classes[e.id] !== undefined) continue;
    const t0 = Date.now();
    const j = await chatJson(target, fillClassify(fmtEntry(e)), 50);
    ms += Date.now() - t0;
    state.classes[e.id] = j !== null && typeof j === "object" && (j as Record<string, unknown>).class === "rule" ? "rule" : "state";
    classified++;
  }
  writeStaleState(config.stateDir, config.workspace, state);

  const after = state.lastCheckedAt;
  for (const e of entries) {
    if (after !== null && !(e.at > after)) continue;
    const cands = inForce.filter(
      (o) => o.id !== e.id && o.at < e.at && (state.classes[o.id] ?? "state") === "state",
    );
    checked++;
    if (cands.length > 0) {
      const t0 = Date.now();
      const j = await chatJson(target, fillPrompt(fmtEntry(e), cands.map(fmtEntry).join("\n")), 1200);
      ms += Date.now() - t0;
      const stale = j !== null && typeof j === "object" ? (j as Record<string, unknown>).stale : undefined;
      if (Array.isArray(stale)) {
        const candIds = new Set(cands.map((o) => o.id));
        const have = new Set(state.proposals.map((p) => p.oldId));
        for (const p of stale) {
          if (p === null || typeof p !== "object") continue;
          const rec = p as Record<string, unknown>;
          const id = rec.id;
          // only ids that are really in force and older: the candidate set IS that check
          if (typeof id !== "string" || !candIds.has(id) || have.has(id)) continue;
          const old = cands.find((o) => o.id === id);
          if (old === undefined) continue;
          const why = typeof rec.why === "string" ? rec.why.replace(/\s+/g, " ").trim().slice(0, 200) : "";
          state.proposals.push({ oldId: id, newId: e.id, why, oldAt: old.at, at: e.at, shown: 0 });
          have.add(id);
          added++;
        }
      }
    }
    state.lastCheckedAt = e.at; // resumable: a stop mid-run rechecks from here
    writeStaleState(config.stateDir, config.workspace, state);
  }
  return { classified, checked, added, modelSeconds: Math.round(ms / 100) / 10 };
}

// ---------------------------------------------------------- the digest view

/**
 * The lead seat's digest pick (ADR-0019 d4): proposals whose old entry is
 * still in force and shown < 3 times; at most `max`, newest first; the shown
 * count rises for what is displayed. `dirty` says the caller must persist
 * (gone-proposals dropped, counters raised). Pure: no IO.
 */
export function takeStaleForDigest(
  st: StaleState,
  inForceIds: Set<string>,
  max: number,
): { shown: StaleProposal[]; dirty: boolean } {
  const before = st.proposals.length;
  st.proposals = st.proposals.filter((p) => inForceIds.has(p.oldId) && p.shown < 3);
  const dropped = st.proposals.length !== before;
  const ordered = st.proposals.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const shown = ordered.slice(0, max);
  for (const p of shown) p.shown++;
  return { shown, dirty: dropped || shown.length > 0 };
}

/** existsSync only: the digest reads the local file before any network. */
export function staleStateExists(stateDir: string, workspace: string): boolean {
  try {
    return existsSync(staleStatePath(stateDir, workspace));
  } catch {
    return false;
  }
}
