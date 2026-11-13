# Store test: Graphiti as a second layer (ADR-0018 decision 5)

Run 2026-11-13 by design.architect, on scratch data only. Graphiti 0.31.2 on embedded
FalkorDBLite 0.11.0, data in a scratch folder. Model: the shared local Qwen server
(chat and embeddings), one record at a time, backing off while 3 or more of its slots
were busy. Counts only below; no record content.

## Input

- **Real:** the decision ledger of the busier pilot rig (read-only list calls): 36 decisions and
  approvals plus 6 retirements. 30 are in force; 6 were ended, all by retirement.
  The real ledger has no superseding entries. Also 20 of its 172 outcome records.
  The other pilot rig, which holds brokerage data, was not read.
- **Synthetic** (owner, 2026-11-13): 17 invented decisions in the same shape, with
  six chains of replacement (one of three steps, one that reverts A to B to A),
  two decoys on similar topics that replace nothing, and one retirement. 8 in force,
  9 ended.
- Every record went in whole, as one episode (TreeAgent idea 1).

## Results

| Arm | Model calls | Build | In force now | In force just before it ended | Search p50 |
|---|---|---|---|---|---|
| A. Graphiti extraction, real | median 6 per record (365 total) | median 24 s per record, 42 min model time for 62 records | wrong: 2 of 6 ended decisions had any fact ended, 1 had all; 9 of 30 decisions in force had a fact wrongly ended | 5/6 | 57 ms |
| A. Graphiti extraction, synthetic | median 2 per record | 3 s per record | 14 of 17 decisions produced **no facts at all**; of 9 ended, 1 fully ended; decoys untouched | 2/2 of the few with facts | not measured |
| B1. Graphiti `add_triplet` ("direct"), real | 71 (model dedupe and contradiction checks) | 472 s | wrong: 19 shown in force against 30 | 4/6 | 66 ms |
| B2. Plain saves, our own validity dates, real | 0 (74 embedding calls) | 13 s | right: 30/30 | 6/6 | 126 ms |
| B2. Plain saves, synthetic | 0 (36 embedding calls) | 2 s | right: 8/8 | 9/9 | 53 ms |

Extraction quality on a hand-checked sample of the real ledger: the facts are mostly
faithful and split usefully into atomic statements, with some wrong labels (a package
name turned into a product). Every extracted fact traced to its episode (149 of 149).
About 1 record in 40 failed outright: the model returned invalid JSON.

Other findings:
- Graphiti sends usage telemetry to PostHog by default (`GRAPHITI_TELEMETRY_ENABLED`).
  The network refused it here; any use must switch it off.
- The FalkorDB driver keeps one graph per group id, not per database name.
- FalkorDBLite did not write three of its five database files to disk at exit. The
  graphs worked while the process ran; persistence would need its own test.

## Configured rerun (owner, 2026-11-13: make the analysis thorough)

The first runs used Graphiti's defaults. The rerun set it up the way its documentation
recommends for domain data: our own entity types (Decision, Approval, Retirement,
Scope) and edge types (Supersedes, Retires, AppliesTo) with an edge type map, one
plain-text episode per record that names its id and states "this supersedes X" or
"this retires X" in words, and extraction instructions for ledger entries. All
149 facts of the first real run carried a start date, so the known missing-date bug on
local models (graphiti issue #1909) did not affect these results.

| Configured arm | Model per record | Facts for every decision | Ended decisions closed | Live decisions with a fact ended | Just before its end | Search hit@5 |
|---|---|---|---|---|---|---|
| Synthetic | median 6 calls, 12 s | 17/17 | 9/9 | 0 | 9/9 | 7/12 |
| Real ledger | median 8 calls, 61 s (62 min for 42 records) | 36/36 | 3/6 any fact, 1/6 all | 9/30 | 6/6 | 10/12 |

Reading "in force" from the Supersedes/Retires links instead: on the real ledger the
links never wrongly ended a live decision, but they caught only 2 of the 6 retirements.
This matches an open Graphiti bug (#1841, fix #1940 unmerged): end events do not
reliably close earlier facts.

**The 9 live decisions, checked by hand.** The real ledger entries are mostly status
reports (a release published, main at a commit, a review held or accepted). In about 7
of the 9, the fact Graphiti ended really had gone stale, and the ledger never said so:
an acceptance withdrawn 9 minutes later by another entry that does not supersede it, a
hold that was resolved, "main points to X" after later releases, "waiting for the
owner's word" on releases that shipped. About 2 were wrong: events such as "release X was
published" do not expire. This is the architect's judgement on 9 cases, not a measured
rate.

## Outside evidence (survey, 2026-11-13)

The architect's survey (scratch file research-memory-2026.md) points the same way for
"what is in force":
- systems that let a model decide supersession do poorly on knowledge updates:
  Zep 7% single-hop and 3% multi-hop on MemoryAgentBench conflict resolution, below
  BM25; a frontier model keeping its own memory falls from 92% to 77% on LongMemEval
  knowledge updates (Supersede, 2026); every compared system with a model judging
  writes showed consistency anomalies (TOKI, 2026);
- deterministic supersession in a bi-temporal ledger scores 0.95 to 1.00 against
  0.20 to 0.47 for retrieval (MemStrata, 2026), the closest published design to ours;
- Zep's own ingestion guidance says to write known relationships directly instead of
  extracting them;
- lessons improve most with a ground-truth success signal and itemized updates merged
  by code (ReasoningBank, ACE), which is what the queue outcome log provides.

## Verdict

- **Graphiti is not the store for what is in force.** Explicit retirements and
  supersessions stay deterministic in our own ledger code, which is exact and costs no
  model time. The tests and the literature agree. The rig stays on Honcho, with no
  second store.
- **A real gap the first pass missed: ledger entries go stale without being retired.**
  Most of the ledger is status reports, and a model reading new entries against old ones
  noticed about 7 stale facts that nobody retired, including one missed supersession.
  That is worth having, but as a proposal a seat confirms, never as an automatic
  invalidation: it was also wrong about 2 times in 9.
- **That proposal does not need Graphiti.** STRATEGY phase 2 already plans "the dreamer
  proposes supersessions, the leader confirms". The next measured step is a small
  staleness check over the ledger (new entry against the in-force entries of the same
  mission), scored on these 9 cases plus the retirements, with Graphiti's 7 of 9 and its
  61 s per record as the bar to beat.
- **Ledger hygiene belongs in the second half of v0.5:** keep decisions and approvals
  apart from status reports, so status goes stale by design instead of by accident.
- Neo4j would not change any of this: the weak part is model judgement, not the
  database.

Scripts and raw reports: the architect's scratch folder `storetest/` and the survey
file, not kept in the repo.
