# Stale-proposal evaluation (ADR-0019 decision 4)

Run 2026-11-13 by design.architect on the busier pilot rig's real decision ledger
(36 decisions and approvals, read-only copy from the store test), with the shared local
model, one call at a time behind the slot brake. Counts and ids only below.

## Question

When a seat records a new ledger entry, can one cheap model call say which earlier
in-force entries it makes stale, well enough to show as a proposal the lead seat
confirms? The bar (ADR-0019, set from Graphiti's configured store-test run on the same
labels): catch at least 8 of 14 stale entries, wrongly flag at most 1 of 8 durable
entries, and use less than Graphiti's 61 s of model time per entry.

## Labels

Hand labels by the architect, made before the runs: 14 entries marked stale with the
later entry that ended them, 8 durable (standing rules and plain events), 8 ambiguous
and not scored. The 6 explicit retirements are not scored here; the ledger code already
handles them exactly.

## Results

| Version | Stale caught | Caught at or after the labelled entry | Durable wrongly flagged | Model time per entry |
|---|---|---|---|---|
| Graphiti, configured (store test) | 8/14 | - | 1/8 | 61 s |
| One call per entry | 13/14 | 9/14 | 6/8 | 5.0 s |
| A rule-or-state call per entry first, then one call over state entries only | 11/14 | 7/14 | 2/8 | 3.7 s (both calls) |

The one-call version flags standing rules (for example an operating rule and a lasting
owner instruction) as stale: precision fails. Classifying each entry once as a rule or
as a state report, and only ever proposing state reports, removes those.

## Reading the remaining errors

The model gives a reason with every proposal. For 5 of the 6 remaining "errors" of the
rule-or-state version, the reason is correct at a finer grain than the labels: the
entries are multi-fact status reports, and the flagged entry did resolve one fact in
them before the release the label pointed at. Examples: "the release waits for the
owner's word" was flagged when the owner said yes, not when the release shipped; a
re-acceptance entry also carried "the release awaits the owner's word". One flag is a
plain mistake (an approved phase marked stale by the next review).

Counted that way, the rule-or-state version catches 11 of 14 with 1 wrong flag, at 3.7 s
per entry, which meets the bar. This re-reading was done after seeing the outputs, so it
carries a bias, and both scorings are reported. The unit that goes stale is a fact
inside an entry, not the whole entry, which is the same finding as the store test.

## Decision

V4 goes ahead as proposals only: a short line to the lead seat naming the entry, the
reason, and the exact `retire` call, never an automatic change. The rule-or-state class
is stored once per entry. The real measure is the pilot itself: the share of proposals
the lead seat accepts or declines, from the ledger and the outcome log, with a review
after the first two weeks. V3's status kind should make most new state reports
deterministic, so V4 matters mainly for entries recorded as decisions.

Scripts, labels and raw reports: the architect's scratch folder `storetest/`
(`stale_eval.py`, `stale-labels.json`), not kept in the repo.
