// T18c (ADR-0013 decision 3): the retrieval benchmark runner. Seeds the
// FICTIONAL stormchaser history (tests/bench/dataset/) into a fresh scratch
// workspace (deriver off, BRIEF hard limit), runs the retrieval strategies
// over the 45 job-tagged questions, scores them, prints the table and
// writes bench-report.json (git-ignored), then deletes the scratch workspace.
//
// Strategies (ADR-0013: "each strategy is scored... later strategies plug in
// through one interface"): newest (v0.2.0's newest-first list), semantic
// (v0.2.2's pair-filtered query at 0.45), semantic-novel (semantic minus
// the ids the seat already has) and - T19a2, ADR-0014 decision 2 -
// semantic-ledger (semantic minus every item NOT in force as of q.as_of,
// the ledger computed with the real plugin/src/ledger.ts over the dataset's
// supersedes links). k = 5 items shown per question.
//
// COST RULE (brief): one run is ~270 creates + ~90 queries against the
// shared model host. Run it ONLY when the architect has been told (bun run
// bench). It is NOT part of the gate.
//
// Scoring and dataset validation are exported pure functions; the math is
// pinned by tests/unit/bench-score.test.ts with a fake strategy, no server.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupScratch, scratchWorkspace } from "../tests/support/scratch.ts";
import type { HonchoClient } from "../plugin/src/honcho.ts";
import { currentLedger, derivedId, toEntries } from "../plugin/src/ledger.ts";

// ---------------------------------------------------------------- types

export type Concl = {
  id: string;
  observer: string;
  observed: string;
  session: string;
  mission: string;
  created_at: string;
  content: string;
  /** T19a2: this entry replaces the named (older, lead) dataset entry */
  supersedes?: string;
};
export type Question = {
  id: string;
  job: string;
  text: string;
  as_of: string;
  pairs: [string, string][];
  expect: string[];
  must_not: string[];
  known: string[];
};
export type Shown = { id: string; content: string };
export type StrategyResult = { shown: Shown[]; ms: number };
/** The one interface later strategies (ADR-0014's digest) plug into. */
export type Strategy = {
  name: string;
  run(q: Question): Promise<StrategyResult>;
};

export const K = 5;

export function loadDataset(dir = join(import.meta.dir, "..", "tests", "bench", "dataset")): {
  conclusions: Concl[];
  questions: Question[];
} {
  const conclusions = JSON.parse(readFileSync(join(dir, "conclusions.json"), "utf8")) as Concl[];
  const questions = JSON.parse(readFileSync(join(dir, "questions.json"), "utf8")) as Question[];
  return { conclusions, questions };
}

// ---------------------------------------------------------------- scoring

export type QuestionScore = {
  answerable: boolean;
  precision: number; // expected OR not-forbidden, over shown (shown=0 -> 0)
  wrongShown: number; // must_not ids actually shown
  novelty: number; // shown not in known, over shown (known empty -> 1 when shown>0)
  chars: number;
  ms: number;
  shown: number;
};

export function scoreQuestion(q: Question, shown: Shown[], ms: number): QuestionScore {
  const ids = shown.map((s) => s.id);
  const exp = new Set(q.expect);
  const must = new Set(q.must_not);
  const known = new Set(q.known);
  const ok = ids.filter((i) => exp.has(i) || !must.has(i)).length;
  return {
    answerable: ids.some((i) => exp.has(i)),
    precision: ids.length === 0 ? 0 : ok / ids.length,
    wrongShown: ids.filter((i) => must.has(i)).length,
    novelty: ids.length === 0 ? 0 : ids.filter((i) => !known.has(i)).length / ids.length,
    chars: shown.reduce((a, s) => a + s.content.length, 0),
    ms,
    shown: ids.length,
  };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export type Cell = {
  strategy: string;
  job: string;
  questions: number;
  answerAtK: number;
  precision: number;
  wrongShown: number;
  novelty: number;
  charsPerQ: number;
  p50ms: number;
  p95ms: number;
};

export function aggregate(rows: { s: QuestionScore; strategy: string; job: string }[]): Cell[] {
  const by = new Map<string, { s: QuestionScore[]; strategy: string; job: string }>();
  for (const r of rows) {
    const key = `${r.strategy} ${r.job}`;
    const g = by.get(key) ?? { s: [], strategy: r.strategy, job: r.job };
    g.s.push(r.s);
    by.set(key, g);
  }
  return [...by.values()].map((g) => {
    const ms = g.s.map((s) => s.ms);
    return {
      strategy: g.strategy,
      job: g.job,
      questions: g.s.length,
      answerAtK: mean(g.s.map((s) => (s.answerable ? 1 : 0))),
      precision: mean(g.s.map((s) => s.precision)),
      wrongShown: g.s.reduce((a, s) => a + s.wrongShown, 0),
      novelty: mean(g.s.map((s) => s.novelty)),
      charsPerQ: mean(g.s.map((s) => s.chars)),
      p50ms: pct(ms, 0.5),
      p95ms: pct(ms, 0.95),
    };
  });
}

export function formatReport(cells: Cell[]): string {
  const w = { strategy: 15, job: 11 };
  const lines = [
    `  ${"strategy".padEnd(w.strategy)}${"job".padEnd(w.job)} n   answer@k  precision  wrong  novelty   chars  p50ms  p95ms`,
  ];
  for (const c of cells) {
    lines.push(
      `  ${c.strategy.padEnd(w.strategy)}${c.job.padEnd(w.job)}${String(c.questions).padStart(2)}` +
        `   ${(c.answerAtK * 100).toFixed(0).padStart(5)}%   ${(c.precision * 100).toFixed(0).padStart(6)}%` +
        `   ${String(c.wrongShown).padStart(4)}   ${(c.novelty * 100).toFixed(0).padStart(5)}%` +
        `   ${c.charsPerQ.toFixed(0).padStart(5)}  ${c.p50ms.toFixed(0).padStart(5)}  ${c.p95ms.toFixed(0).padStart(5)}`,
    );
  }
  return lines.join("\n");
}

// ------------------------------------------------------- dataset validation

/** A "lead entry" for the ledger links: a conclusion the lead authored. */
const isLead = (c: Concl): boolean => c.observer === "lead";

/** T19a2: the dataset ids IN FORCE as of asOf - the ledger rule is NOT
 * reimplemented here: entries are built by ledger.toEntries (plain dataset
 * content -> mission decisions with derived ids), the dataset's supersedes
 * links are grafted onto those ledger ids, and ledger.currentLedger does
 * the supersession closure. Entries newer than asOf do not exist yet. */
export function inForceIds(conclusions: Concl[], asOf: string): Set<string> {
  const past = conclusions.filter((c) => c.created_at <= asOf);
  const entries = toEntries(
    past.map((c) => ({ id: c.id, content: c.content, session_id: c.session, created_at: c.created_at })),
  );
  const byLedgerId = new Map(entries.map((e) => [e.id, e]));
  for (const c of past) {
    if (c.supersedes === undefined) continue;
    const e = byLedgerId.get(derivedId(c.id));
    if (e !== undefined) e.supersedes = derivedId(c.supersedes); // validation guarantees the target
  }
  const dsByLedgerId = new Map(past.map((c) => [derivedId(c.id), c.id]));
  return new Set(currentLedger(entries).map((e) => dsByLedgerId.get(e.id) as string));
}

/** The invariants the dataset must hold before any server call; pure. */
export function validateDataset(conclusions: Concl[], questions: Question[]): string[] {
  const problems: string[] = [];
  const byId = new Map(conclusions.map((c) => [c.id, c]));
  const contents = new Set<string>();
  for (const c of conclusions) {
    if (contents.has(c.content)) problems.push(`duplicate content ${c.id}`);
    contents.add(c.content);
    // T19a2 ledger links
    if (c.supersedes !== undefined) {
      const t = byId.get(c.supersedes);
      if (t === undefined) problems.push(`${c.id} supersedes unknown ${c.supersedes}`);
      else {
        if (!isLead(c) || !isLead(t)) problems.push(`${c.id} supersedes ${t.id}: links must be lead entries`);
        if (t.created_at >= c.created_at) problems.push(`${c.id} supersedes ${t.id} but is not newer`);
      }
    }
  }
  for (const q of questions) {
    if (q.expect.length === 0) problems.push(`${q.id} no expected id`);
    for (const e of [...q.expect, ...q.must_not, ...q.known]) {
      if (!byId.has(e)) problems.push(`${q.id} unknown id ${e}`);
    }
    for (const e of q.expect) {
      const c = byId.get(e);
      if (!c) continue;
      if (!q.pairs.some(([o, ob]) => c.observer === o && c.observed === ob)) {
        problems.push(`${q.id}: ${e} not covered by pairs`);
      }
      if (c.created_at > q.as_of) problems.push(`${q.id}: ${e} newer than as_of`);
    }
  }
  return problems;
}

// ------------------------------------------------------------ real run only

/** dataset id -> shown-content lookup for the score. Strategies score on
 * DATASET ids so supersession and known-lists stay exact. */
async function buildIdMap(client: HonchoClient, conclusions: Concl[]): Promise<Map<string, string>> {
  // content -> dataset id (exact-content map, per brief)
  const contentToDataset = new Map(conclusions.map((c) => [c.content, c.id]));
  const pairs = new Map<string, [string, string]>();
  for (const c of conclusions) pairs.set(`${c.observer}|${c.observed}`, [c.observer, c.observed]);
  const map = new Map<string, string>(); // server id -> dataset id
  for (const [observer, observed] of pairs.values()) {
    const r = await client.listConclusions({
      filters: { observer_id: observer, observed_id: observed },
      size: 100,
      reverse: true,
    });
    if (!r.ok) throw new Error(`list for map failed: ${r.error}`);
    for (const it of r.data.items) {
      const ds = contentToDataset.get(it.content);
      if (ds !== undefined) map.set(it.id, ds);
    }
  }
  return map;
}

function makeStrategies(
  client: HonchoClient,
  serverToDataset: Map<string, string>,
  byDatasetId: Map<string, Concl>,
): Strategy[] {
  const datasetOf = (items: { id: string; content: string }[]): Shown[] => {
    const out: Shown[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const ds = serverToDataset.get(it.id);
      if (ds === undefined || seen.has(ds)) continue; // foreign or dup: not scoreable
      seen.add(ds);
      out.push({ id: ds, content: it.content });
    }
    return out;
  };
  const notFuture = (items: Shown[], asOf: string): Shown[] =>
    items.filter((s) => (byDatasetId.get(s.id)?.created_at ?? "9999") <= asOf);

  const all = Array.from(byDatasetId.values());
  const ledgerCache = new Map<string, Set<string>>(); // as_of -> in-force ids
  const inForceAt = (asOf: string): Set<string> => {
    let s = ledgerCache.get(asOf);
    if (s === undefined) {
      s = inForceIds(all, asOf);
      ledgerCache.set(asOf, s);
    }
    return s;
  };

  const semanticCache = new Map<string, Promise<Shown[]>>();
  const semanticMerged = (q: Question): Promise<Shown[]> => {
    const key = q.id;
    let p = semanticCache.get(key);
    if (p === undefined) {
      p = (async () => {
        const merged: { id: string; content: string }[] = [];
        for (const [observer, observed] of q.pairs) {
          const r = await client.queryConclusions({
            query: q.text,
            top_k: 10,
            distance: 0.45,
            filters: { observer, observed },
          });
          if (!r.ok) throw new Error(`query failed for ${q.id}: ${r.error}`);
          merged.push(...r.data);
        }
        return datasetOf(merged);
      })();
      semanticCache.set(key, p);
    }
    return p;
  };

  return [
    {
      name: "newest",
      async run(q) {
        const t = performance.now();
        const r = await client.listConclusions({ size: 50, reverse: true });
        const ms = performance.now() - t;
        if (!r.ok) throw new Error(`list failed for ${q.id}: ${r.error}`);
        return { shown: notFuture(datasetOf(r.data.items), q.as_of).slice(0, K), ms };
      },
    },
    {
      name: "semantic",
      async run(q) {
        const t = performance.now();
        const merged = await semanticMerged(q);
        const ms = performance.now() - t;
        return { shown: notFuture(merged, q.as_of).slice(0, K), ms };
      },
    },
    {
      name: "semantic-novel",
      async run(q) {
        const t = performance.now();
        const merged = await semanticMerged(q);
        const ms = performance.now() - t;
        const known = new Set(q.known);
        return { shown: notFuture(merged.filter((s) => !known.has(s.id)), q.as_of).slice(0, K), ms };
      },
    },
    {
      // T19a2 (ADR-0014 decision 2): semantic minus everything NOT in force
      // as of q.as_of. Applied to ALL questions, not filtered by job: the
      // report must show both effects - decision wrong-shown should fall,
      // history answer@k may fall, which is why search keeps superseded.
      name: "semantic-ledger",
      async run(q) {
        const t = performance.now();
        const merged = await semanticMerged(q);
        const ms = performance.now() - t;
        const inForce = inForceAt(q.as_of);
        return {
          shown: notFuture(merged.filter((s) => inForce.has(s.id)), q.as_of).slice(0, K),
          ms,
        };
      },
    },
  ];
}

async function seed(
  client: HonchoClient,
  conclusions: Concl[],
  messagesPath: string,
): Promise<{ creates: number }> {
  const msgs = JSON.parse(readFileSync(messagesPath, "utf8")) as {
    id: string;
    sender: string;
    session: string;
    mission: string;
    created_at: string;
    text: string;
  }[];
  const peers: Record<string, object> = { lead: {}, builder: {}, checker: {}, owner: {} };
  const sessions = new Set<string>([
    ...msgs.map((m) => m.session),
    ...conclusions.map((c) => c.session),
  ]);
  for (const s of sessions) {
    const r = await client.createSession(s, { peers });
    if (!r.ok) throw new Error(`createSession ${s}: ${r.error}`);
  }
  const bySession = new Map<string, typeof msgs>();
  for (const m of msgs) bySession.set(m.session, [...(bySession.get(m.session) ?? []), m]);
  for (const [s, list] of bySession) {
    const r = await client.addMessages(
      s,
      list.map((m) => ({
        peer_id: m.sender,
        content: m.text,
        created_at: m.created_at,
        metadata: { mission: m.mission, bench: "t18c" },
        configuration: { reasoning: { enabled: false } },
      })),
    );
    if (!r.ok) throw new Error(`addMessages ${s}: ${r.error}`);
  }
  let creates = 0;
  for (let i = 0; i < conclusions.length; i += 10) {
    const batch = conclusions.slice(i, i + 10);
    const rs = await Promise.all(
      batch.map((c) =>
        client.createConclusion({
          content: c.content,
          observer_id: c.observer,
          observed_id: c.observed,
          session_id: c.session,
        }),
      ),
    );
    for (const r of rs) {
      if (!r.ok) throw new Error(`createConclusion: ${r.error}`);
      creates++;
    }
  }
  return { creates };
}

async function main(): Promise<void> {
  const { conclusions, questions } = loadDataset();
  const problems = validateDataset(conclusions, questions);
  if (problems.length > 0) {
    console.error("dataset invalid:\n  " + problems.slice(0, 10).join("\n  "));
    process.exit(1);
  }
  const rig = await scratchWorkspace();
  console.log(`seeding scratch workspace ${rig.name} ...`);
  const t0 = Date.now();
  try {
    const { creates } = await seed(rig.client, conclusions, join(import.meta.dir, "..", "tests", "bench", "dataset", "messages.json"));
    console.log(`seeded ${creates} conclusions, ~120 messages in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    const serverToDataset = await buildIdMap(rig.client, conclusions);
    if (serverToDataset.size < conclusions.length) {
      throw new Error(
        `id map incomplete: ${serverToDataset.size}/${conclusions.length} - a conclusion did not come back from the list`,
      );
    }
    const byDatasetId = new Map(conclusions.map((c) => [c.id, c]));

    // embeddings settle server-side; wait until a probe query answers (the
    // recall-query.test.ts pattern, with a longer window for 150 items).
    const probe = questions[0];
    const deadline = Date.now() + 120_000;
    for (;;) {
      const r = await rig.client.queryConclusions({
        query: probe.text,
        top_k: 5,
        distance: 0.45,
        filters: { observer: probe.pairs[0][0], observed: probe.pairs[0][1] },
      });
      if (r.ok && r.data.length > 0) break;
      if (Date.now() > deadline) throw new Error("embeddings did not settle within 120 s");
      await Bun.sleep(2000);
    }

    const strategies = makeStrategies(rig.client, serverToDataset, byDatasetId);
    const rows: { s: QuestionScore; strategy: string; job: string }[] = [];
    for (const st of strategies) {
      for (const q of questions) {
        const { shown, ms } = await st.run(q);
        rows.push({ s: scoreQuestion(q, shown, ms), strategy: st.name, job: q.job });
      }
      console.log(`strategy ${st.name}: done (${questions.length} questions)`);
    }
    const cells = aggregate(rows);
    // overall rows per strategy
    for (const st of strategies) {
      const own = rows.filter((r) => r.strategy === st.name).map((r) => ({ s: r.s, strategy: st.name, job: "OVERALL" }));
      cells.push(...aggregate(own));
    }
    console.log(formatReport(cells));
    const outPath = join(import.meta.dir, "..", "bench-report.json");
    writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), k: K, workspace: rig.name, cells }, null, 1) + "\n");
    console.log(`wrote ${outPath}`);

    // sanity check (ADR-0013): semantic must beat newest on decision+history
    const g = (strat: string, job: string): number =>
      cells.find((c) => c.strategy === strat && c.job === job)?.answerAtK ?? 0;
    for (const job of ["decision", "history"]) {
      if (!(g("semantic", job) > g("newest", job))) {
        console.error(`SANITY: semantic does NOT beat newest on ${job} (${g("semantic", job)} vs ${g("newest", job)}) - suspect the benchmark first (ADR-0013).`);
      }
    }
  } finally {
    console.log("cleaning up scratch workspace...");
    const how = await cleanupScratch([rig.name]);
    console.log(`scratch ${rig.name}: ${how}`);
  }
}

if (import.meta.main) {
  // cleanupScratch may poll for minutes; no bun test timeout applies here.
  void main().catch((e) => {
    console.error(`bench failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
