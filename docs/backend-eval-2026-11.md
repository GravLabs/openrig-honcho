# Backend evaluation, 2026-11 (owner: "a deeper evaluation of the backend against other alternatives including graph approaches. i don't want to be locked into the bad choice")

Status: plan, 2026-11-22 (design.architect). Owner chose "survey + bake-off". Results are added below as
they come in; the verdict comes last. Scratch data only; never the `honcho-openrig` stack.

## The question

Is Honcho the right store for everything the plugin keeps, and how expensive would it be to leave it?
The 2026-11 store test (docs/store-test-2026-11.md) answered only a narrow part: a graph layer (Graphiti)
should not decide what is in force. This evaluation covers the whole backend.

## What the plugin asks of a backend today

All server access goes through one interface, `HonchoClient` (plugin/src/honcho.ts, 15 methods in use):

| Job | Methods | Needs a model? |
|---|---|---|
| Store turns (sessions, peers, messages; spool on outage) | createSession, addSessionPeers, addMessages, listSessions, listScopeSessions | no |
| The ledger (decisions, approvals, status, retires on a reserved pair) | createConclusion, listConclusions | no |
| Find past work (`search`, recall, claim pointer) | searchMessages, queryConclusions | embeddings |
| What a seat is like and what happened (digest summaries, peer card) | getSessionSummaries, getPeerCard | yes (Honcho's deriver) |
| `ask` (answer a question from memory) | workspaceChat | yes |
| Health | queueStatus, createPeer | no |

So a replacement must cover plain storage (easy anywhere), vector search, and the three model-backed jobs:
summaries, a per-seat profile, and question answering. Everything that decides authority (in force,
approvals, trust classes, used approvals, stale proposals) is our own code and moves with us.

## Candidates

Surveyed: Honcho (baseline, AGPL), Graphiti/Zep (temporal knowledge graph), Cognee (graph + vector),
Mem0 (vector, optional graph), Letta (memory blocks + archival), LightRAG/HippoRAG-style graph RAG,
plain Postgres + pgvector or SQLite + a vector index with our own summaries, and raw Neo4j/FalkorDB with
our own deterministic writes (owner, 2026-11-11: a graph backend means FalkorDB or Neo4j, no custom build).
The bake-off installs the 3-4 the survey ranks highest, plus Honcho on a scratch workspace as the control.

## Workloads (the same harness for every candidate)

- **W1 retrieval:** the fictional stormchaser benchmark (tests/bench/dataset, 45 job-tagged questions),
  hit@5 and MRR, as scripts/bench.ts scores it today.
- **W2 the ledger as plain records:** the busier pilot's real ledger, read-only export (counts only), plus
  the synthetic replacement chains from the store test: can the backend hold and list entries with the
  filters our ledger code needs, exactly and cheaply? Authority stays in our code.
- **W3 cross-seat memory:** fictional sessions from several seats; questions about who decided or did what.
  Score: correct attribution, never crossing a seat's or rig's boundary.
- **W4 derived knowledge:** summaries and a per-seat profile from the same fictional sessions, graded on a
  fixed rubric (faithful, useful, no invented facts), blind to which backend wrote them.
- **W5 write cost:** model calls and model seconds per stored turn on the shared local engine; embedding calls.
- **W6 read latency:** p50/p95 for the reads the hooks make, against their budgets (recall 1 s wall).
- **W7 operations:** services and footprint, persistence across a restart, backup and export, upgrade
  history, license, telemetry defaults, local-only operation.
- **W8 lock-in:** what leaving costs - methods to reimplement behind `HonchoClient`, data export
  completeness, and what our own code would have to rebuild.

## Rules

- Fictional and synthetic data, plus the busier pilot's ledger read-only. Never the brokerage pilot's data.
  Results are counts and scores, never record content.
- The local engine serves 3 requests at once and is shared: one candidate at a time, back off when it is
  busy, and never during an engine hold or another rig's measurement run. Telemetry off everywhere.
- Every candidate gets its documented configuration for our kind of data, not only defaults
  (the store test's lesson).

## How we'll decide

A candidate replaces Honcho only if it is at least as good on W1, W3 and W4, no worse on W6 within the
hook budgets, cheaper or equal on W5, and acceptable on W7. Independently of the winner, W8 says what
seam to build so a later switch is a contained change.

## Survey (2026-11-22)

Public numbers do not settle our case: vendor claims and independent reruns differ by up to 30 points
(Mem0 LoCoMo: 92.5% vendor, 61-64% independent rerun, arXiv 2606.29778), Honcho's own figures (LongMem S
90.4%, LoCoMo 89.9%) were not independently reproduced in anything found, and no benchmark resembles our
workload (a team of coding seats, a ledger with authority, a local model).

The one broad independent comparison, HEAMS (arXiv 2611.20144; one configuration each, top_k 10), did not
include Honcho:

| System | LoCoMo | LongMemEval | BEAM 100K | 500K | 1M | STALE (updates) | Evo-Memory (reuse experience) |
|---|---|---|---|---|---|---|---|
| No memory | 0.7 | 6.8 | 13.8 | 13.9 | 15.6 | 10.6 | 80.4 |
| Full history in context | 93.8 | 51.0 | 50.8 | 31.4 | 29.9 | 69.8 | 81.8 |
| Mem0 | 81.2 | 71.0 | 50.5 | 47.0 | 44.9 | 48.3 | 80.0 |
| Letta | 74.2 | 54.6 | 51.5 | 43.9 | 45.9 | 36.4 | 81.4 |
| HippoRAG 2 (graph + PageRank) | 89.4 | 71.2 | 61.3 | 58.7 | 59.7 | 56.5 | 80.7 |
| MilaMem (hybrid BM25 + embeddings + rerank, superseded kept and redirected) | 81.6 | 73.2 | 59.8 | 52.6 | 57.3 | 56.2 | 80.9 |

Read for us: a graph retriever leads on long histories; a plain hybrid store that keeps superseded records
and redirects to the current one is level with it; no system learns from experience across tasks
(Evo-Memory within 1.3 points of no memory) - that stays our outcome log and lessons, whatever the store.

| Candidate | License | Shape | Fit for our jobs | Notes |
|---|---|---|---|---|
| Honcho 3.6 (now) | AGPL | sessions, peers with observation, deriver summaries and peer cards, dialectic chat | all jobs, multi-seat peers built in | deriver backlog on the shared engine; self-hosted |
| Mem0 OSS 2.x | Apache 2.0 | LLM-extracted facts, embedding recall, user/agent/run ids | storage, search, facts; no summaries or peer profile | 2026: external graph stores removed (built-in entity linking), extraction ADD-only |
| Graphiti 0.31 (Zep) | Apache 2.0 | temporal knowledge graph on FalkorDB/Neo4j | search; in force tested and rejected (store test) | 6-8 model calls and ~61 s per record on our engine; telemetry on by default |
| Cognee 1.x | Apache 2.0 | graph + vector, improve() stages, Claude Code/Codex plugins | storage, search, distillation, conflict review | heaviest model pipeline; reproduced 51.8% / 83.5% (OmniMemEval) |
| HippoRAG 2 | research code | triples + Personalized PageRank, passages verbatim | search over long histories | best BEAM in HEAMS; costly ingestion; not a product |
| Letta | Apache 2.0 | agent runtime with memory blocks + archival | poor: memory is reached through Letta's own agents | HEAMS: "tightly coupled to its native harness"; STALE 36.4 |
| Plain store (SQLite FTS5 or Postgres + vector, our own summaries) | ours | hybrid search, our ledger as is | storage and search; summaries and profiles we would write | closest to MilaMem; no vendor, more of our code |

Bake-off line-up: Honcho (control, scratch workspace), Mem0, Cognee (graph), HippoRAG 2 (graph
retrieval), and the plain hybrid store. Letta is out (it hosts the agent; ours are Claude Code and Codex).
Graphiti's in-force result stands; it is run on W1 only, to complete the graph picture.

## Bake-off results (2026-11-23)

Same 270 fictional records (120 messages, 150 conclusions; 227 distinct texts) and 45 questions for
every candidate, each in its documented configuration, our chat and embedding models on the shared
engine (at most 2 calls at once), telemetry off. Each candidate's own retrieval, top 10, `as_of`
applied by record time where the candidate returns record times (plain store, Honcho, HippoRAG),
otherwise passed in the query text. One fixed judge prompt on the local model: is every expected
fact in the returned context, and is any outdated fact presented as current. 45 questions means one
question is 2.2 points: differences of a few points between the top four are noise.

### W1 and W3: retrieval quality, and read latency (W6)

| Candidate | All 45 answered | Outdated shown as current | Expected records in top 10 | continuity | decision | history | lesson | W3 (peer + provenance) | Read p50 / p95 |
|---|---|---|---|---|---|---|---|---|---|
| Plain hybrid store (SQLite BM25 + embeddings, rank fusion) | 97.8% | 0 | 95.6% | 100 | 100 | 80 | 100 | 100% | 44 / 47 ms |
| Honcho (the plugin's own reads: conclusions by seat pair, distance 0.45, plus message search) | 93.3% | 0 | 93.3% | 100 | 100 | 60 | 100 | 90.9% | 41 / 45 ms |
| Mem0 2.2 (extraction, entity linking, hybrid search) | 97.8% | 1 | - | 100 | 100 | 80 | 100 | 100% | 122 / 177 ms |
| Cognee 1.6 (graph completion context) | 88.9% | 1 | - | 81.8 | 81.8 | 100 | 85.7 | 100% | 877 / 1,177 ms |
| HippoRAG 2 (triples + Personalized PageRank) | 100% | 0 | 97.8% | 100 | 100 | 100 | 100 | 100% | 588 / 959 ms, plus 1 model call per read |
| Graphiti 0.31 (temporal graph, W1 only) | 66.7% | 3 | - | 27.3 | 81.8 | 20 | 85.7 | 100% | 42 / 45 ms |

### W5 and W7: what it costs to write and to run

| Candidate | Model calls to store 270 records | Model time | Embedding calls | Stored | Disk | Install | Restart keeps data | Telemetry default |
|---|---|---|---|---|---|---|---|---|
| Plain store | 0 | 0 s | 9 | 270 verbatim | 1.3 MB | stdlib | yes | none |
| Honcho | 0 here (deriver off; on in production) | 0 s | server-side | 270 verbatim | server | the existing server, Postgres, Redis, deriver | yes | none |
| Mem0 | 270 | 199 s | 608 | 171 extracted facts (99 records produced nothing) | 6 MB | 144 MB, 6 GB with its nlp + keyword extras | yes | ON (PostHog) |
| Cognee | 229 | 915 s | 1,364 | 227 documents + graph | 140 MB | 1.3 GB | yes | ON |
| HippoRAG 2 | 454 | 380 s | 104 | 270 verbatim + triples | 15 MB | 6.9 GB (pins a vLLM and CUDA stack) | yes | none found |
| Graphiti | 1,455 | 921 s | 1,324 | 270 episodes + facts | 1.7 MB | 223 MB | yes | ON (PostHog) |

### W2: the real ledger as plain records

The busier pilot's ledger, 197 entries, read-only export, content never printed; stored as plain
records with metadata and listed back by metadata, compared by hash.

| Candidate | Listed back | Text identical | Model calls |
|---|---|---|---|
| Plain store | 197/197 | 197 | 0 |
| Honcho | the ledger lives there today (150/150 listed back in W1 too) | exact | 0 |
| Mem0, `infer=False` | 197/197 | 197 | 0 |
| Cognee, add without cognify | 197/197 | 197 | 0 |
| HippoRAG 2 | not tested: passages only, no metadata to list by | - | - |
| Graphiti | store test: extraction rewrites entries; plain saves with our own dates are exact | - | - |

### W4 and W8

W4 (Honcho's own summaries and peer cards against in-house summaries) did not run: the host ran low
on memory during the deriver pass and the run was stopped; its scratch workspace was deleted by hand.
So the decision bar's W4 condition is unmeasured for every candidate.

W8: all server access already goes through one interface (`HonchoClient`, 15 methods in use). Storage,
the ledger and search are commodity: a plain store, Mem0 or Cognee hold them exactly. What only Honcho
gives us today is the model-backed part: session summaries, peer cards and `ask`.

### Verdict

- **Stay on Honcho.** Nothing meets the bar: no candidate was measured on W4, and the only one
  clearly better on W1 (HippoRAG 2) calls the model on every read, takes 0.6-1 s, and is research
  code with a 7 GB GPU stack, so it does not fit a hook's 1 s budget.
- **Graph approaches do not pay off for our workload.** Graphiti scored lowest (27% continuity, 20%
  history, 3 outdated facts shown as current) at the highest write cost; Cognee is mid-pack with reads
  near 0.9 s. HippoRAG's lead is two to three questions over plain hybrid search.
- **We are not locked in.** A plain hybrid store with no model at write time matched or beat Honcho on
  W1, W2 and W3 at 44 ms. If Honcho had to go, storage and search move with little loss; the real
  switching cost is rewriting summaries, peer cards and `ask`.
- **Two cheap lessons for Honcho as it is:** Honcho's misses were the history and provenance
  questions that its seat-pair filter and distance cut-off hide; adding lexical (BM25) fusion to
  `search`, as the plain store does, is worth a small test. And rerun W4 when the host has memory to
  spare, before any change of store is considered.

Scripts and raw results: the architect's scratch folder `backend-eval/`, not kept in the repo.
