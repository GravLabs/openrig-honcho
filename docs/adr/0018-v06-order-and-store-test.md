# ADR-0018: v0.6 order, and the store test first

Status: accepted (2026-11-13, design.architect), on the owner's go-ahead: "proceed
with 0.6 whenever ready" (2026-11-12), with the model-server load for the Graphiti
test approved ("extra load is ok").

## Context

- v0.5.0 shipped the first half of v0.5: the outcome log and the claim-time pointer
  (ADR-0017). The second half was never built: lessons in seat lore, lessons shown
  before risky actions, trust classes and local checkpoints (STRATEGY section 7,
  "After v0.3").
- v0.6 (proposed lessons, a promotion gate with rollback, standing attack tests)
  builds on that second half: there is nothing to promote until lessons exist.
- Where lessons, decisions and outcomes live is the open store decision. The plan
  settles it with one test: Graphiti as a second layer beside Honcho, on FalkorDBLite,
  with Neo4j Community as the fallback and no custom store (owner, 2026-11-11).
- The server is Honcho 3.6.1 since 2026-11-12, and v0.5.1 accepts 3.5.x and 3.6.x.
- Eight small fixes from the v0.5 reviews are open (the v0.6 list in the plan notes).

## Decisions

1. **The store test comes first.** Building lessons on Honcho and then moving them
   would mean doing the work twice. The test answers "where do decisions, outcomes and
   lessons live" before any lesson code is written.
2. **The fixes run beside it.** They need no model load and no store decision, so build
   takes them as small rows while the architect runs the store test:
   - F-L: the wake path waits up to 1 s on a hanging daemon. Ruled 2026-11-13: keep
     the 1 s ceiling (POINTER_BUDGET_MS). A healthy daemon answers in about 24 ms, a
     hang costs the seat at most 1 s on a hand-off prompt only, and a shorter budget
     would drop the pointer on a slow but live daemon, which skews the shown arm of
     the holdout. No code change.
   - F-M: `scripts/scan.ts` has no GitHub or GitLab token rule.
   - N-D: `fetchQueueItem` has no read cap; cap it like the row read (256 KB), or
     remove it if it still has no caller (done in F2: it had none, so it was removed).
   - A sweep for stale temporary files.
   - The seat backups folder at mode 700.
   - The lock message wording.
   - The Claude-side `namesPlugin` substring checks: match the plugin path exactly.
   - The gate's double verdict on still-listed scratch workspaces (R14 O3).
3. **Then the second half of v0.5, on whichever store wins:** local checkpoints, lessons
   in seat lore (itemized updates), lessons shown before risky actions, trust classes.
4. **Then v0.6 proper:** proposed lessons, the promotion gate with rollback, standing
   attack tests.
5. **The store test, on scratch data only** (STRATEGY v0.6), run by the architect:
   - Input: the decision ledger and the outcome records exported as JSON episodes,
     one whole record per episode, never split (TreeAgent idea 1). Records from the
     brokerage pilot rig are not used; that rig stays counts only.
   - Graph: FalkorDBLite inside the test process, data in a scratch folder, deleted
     afterwards. No container, no change to the Honcho stack, nothing on the model host
     except model calls through the existing endpoint.
   - Measure: extraction quality on the local model against a hand-checked sample;
     model calls and slot time per episode; query latency; "in force now" and "in
     force at time T", superseded decisions included, with each fact traced to its
     episode; whether structured episodes can be written as direct edges with no
     model extraction.
   - Load: one episode at a time, and stop if the model server queue backs up, so the
     shared server keeps its other users.
   - Fallback: if supersession or full-text search misbehaves on FalkorDBLite, rerun the
     same episodes on Neo4j Community 5.26 in a throwaway container before judging;
     that container needs its own OK from the owner.
   - Decision rule: Graphiti wins if "in force now" and "at time T" are right on every
     checked decision, direct edges or extraction quality are good enough to trust,
     and a query answers in under 1 s. Otherwise the rig stays on Honcho alone.

## Result (2026-11-13)

Graphiti is not the store for what is in force; the rig stays on Honcho with no
second store. Explicit supersessions and retirements stay deterministic in
`plugin/src/ledger.ts`. Configured as its documentation recommends, Graphiti was exact on
synthetic chains but missed most real retirements, at about 61 s of shared model time
per record. It did notice stale status facts the ledger never retired (about 7 of 9 on
a hand check, 2 wrong), so a confirmed staleness proposal is a measured next step, and
it does not need Graphiti. Numbers and survey: docs/store-test-2026-11.md. Next is
decision 3 on Honcho, with ledger hygiene (decisions apart from status reports).

## Not doing

- Replacing Honcho. It keeps conversations and each seat's view of its peers.
- A custom store of our own.
- Benchmarking Caura; its ideas are borrowed (STRATEGY v0.6).
- Any lesson or tuning that reaches seats before the promotion gate exists.

## How we'll know

- A results file for the store test, with the numbers above and a stated verdict.
- The fixes each land with a failing test first and the full gate passing.
