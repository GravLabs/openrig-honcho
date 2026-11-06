# ADR-0013: Measure memory by its effect (v0.3, phase 1)

Status: accepted (2026-11-04, design.architect); the owner approved working on
all objectives in [STRATEGY.md](../STRATEGY.md), with a higher O5 target.

## Context

The v0.2.2 usefulness check (EVALUATION.md, section 4) was done by hand with
one-off scripts:
- recall is on topic, but 0 of 48 blocks had new information that the seat
  then used;
- seats almost never look things up.

STRATEGY.md sets six objectives (O1-O6) and plans changes, beginning with a
continuity digest and a decision ledger. Each change needs a repeatable
measure of whether it helped, before and after it ships. Without one, phases 2
to 4 would be judged on impressions.

## Decisions

1. **A "new information used" metric, as a script.** `scripts/eval-use.ts`
   reads the plugin logs and the seats' Claude Code transcripts, read-only, and
   prints counts only, never content. For each injected memory block
   (session-start, recall, and the later moments) it computes:
   - the block's distinctive terms;
   - which of them are *new*: not in the incoming message and not anywhere
     earlier in that transcript;
   - whether at least two new terms appear in the seat's following turn.

   It reports per rig, per moment and per seat. It is the measure behind O5,
   and the shared definition for every later check. Terms are words of 6 or
   more characters, hex ids of 7 or more and version numbers, minus a
   documented list of generic words. The definition is versioned in the script,
   so results stay comparable.
2. **Randomized recall.** A new setting `HONCHO_RECALL_HOLDOUT` (0 to 0.9,
   default 0) holds back that share of eligible recall blocks. The plugin
   computes the block as usual and logs it with `arm: "held"` and the same
   counts, but does not inject it. The choice is a deterministic hash of the
   Claude session and the prompt, so a rerun of the hook makes the same
   choice. Comparing shown with held turns separates recall's effect from what
   the seat would have done anyway. The pilots need the owner's OK before it is
   switched on there.
3. **A retrieval benchmark.**
   - **Data:** `tests/bench/` holds a synthetic rig history: a small fictional
     project with seats, messages, decisions (some superseded), lessons, peer
     facts, current state, and acknowledgements.
   - **Questions:** each is tagged by job (continuity, decision, lesson, peer,
     provenance, history), with its expected item ids.
   - **Seeding:** the benchmark writes this history into a scratch workspace as
     conclusions and messages directly, deriver off, so it tests retrieval, not
     the deriver, and costs no model calls beyond embeddings.
   - **Scoring:** each strategy (newest-first, semantic, semantic plus novelty
     filter, and later the moment digests) is scored on answerable-at-k,
     precision, novelty, characters and latency.
   - **When it runs:** `bun run bench` runs it and writes `bench-report.json`.
     The gate runs it once the dataset is stable.
4. **Scenario tests (designed here, built after the digest exists).** Scripted
   episodes in a throwaway Claude Code session with the plugin against a
   scratch workspace, each run with memory on and off:
   - resume after compaction;
   - decide once (an earlier approval);
   - learn once (a recorded lesson);
   - an instruction that was never delivered.

   They use the local model, so they run per release, not per gate. Their
   design is its own item, once phase 2 gives them something to test.

## How we'll know

- `eval-use.ts` reproduces the v0.2.2 check (0 of 48 on the pilots) from the
  same logs and transcripts.
- The holdout splits eligible prompts at the configured share (±5% over 200
  synthetic prompts), never injects a held block, and logs both arms.
- The benchmark scores newest-first below semantic on the decision and history
  questions, as the pilot suggests. If it does not, the benchmark is wrong
  before the plugin is.

## Consequences

- Phase 2 (continuity digest, decision ledger) is built against the benchmark
  and judged on `eval-use.ts`, per moment.
- O5 targets (STRATEGY.md): 70% for the continuity digest, 50% for work-claim
  context, 25% for per-message recall, and at least 50% overall.
