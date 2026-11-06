# ADR-0014: A continuity digest and a decision ledger (v0.3, phase 2)

Status: accepted (built for v0.3; proposed 2026-11-04, design.architect), under the owner's approval of
the STRATEGY.md objectives. To be built after ADR-0013's metric and holdout,
and judged by them.

## Context

- **Session start carries almost nothing today.** `eval-use.ts` (ADR-0013) on
  the two pilot rigs found that 22 of 26 session-start blocks since v0.2.2 had
  no items at all. Most were resumes. The moment a seat most needs memory
  currently gets the least.
- **OpenRig's compaction restore is thorough but heavy.** Before compaction the
  seat writes a `RESTORE-MAP.md` (state, judgment, open edges, a ranked reading
  list of about 50k tokens). The daemon adds a packet with the full transcript,
  a narrative "read first" companion, touched files and a summary. On one pilot
  seat the transcript was about 514k tokens and the narrative about 320k. That
  is far more than a local-model seat can use. It covers compaction only, not a
  fresh start, a handover or a rename, and it is private to the seat.
- **Decisions are loose facts.** `remember(fact)` stores one sentence with no
  reason, scope or link to what it replaces. Session start shows the newest ten,
  superseded or not. Owner approvals have no place at all: they live in seats'
  notes, and were carried by hand in the pilots.

STRATEGY.md targets: O1 (resume without loss), O2 (decide once), and O5 at 70%
for this moment.

## Decisions

1. **The continuity digest** replaces the session-start block's body for every
   source: startup, resume, clear and compact. It is about 2 500 characters,
   read in parallel within the existing 4 s budget, in this order:
   - **Your open work**, from OpenRig, not memory: the queue items addressed to
     this seat that are in progress, blocked or pending, each with summary,
     state and age (`$OPENRIG_URL` queue API, as in ADR-0012). Current state
     comes from its live source.
   - **Where you left off**: the short summary of this seat's last session in
     this mission (Honcho session summary), and for a compaction the current
     session's summary.
   - **Decisions in force** for this mission and for the missions of your open
     items: the ledger's current entries (decision 2), newest first, superseded
     ones left out.
   - **Approvals you hold**: the owner's ledger entries that name this seat or
     one of its open items. (T20c amendment, O4: an approval scoped to a
     queue item appears ONLY here and only while that item is open - otherwise
     the digest omits it completely, daemon-down included; an item-scoped
     decision stays under Decisions in force with `for qitem-...` on its line,
     and the old block and `ask`, having no open-item list, label item-scoped
     entries the same way instead of filtering.)
   - **Since you were away**: up to three conclusions from other seats about
     your open items, made after your last activity. A semantic query uses the
     open items' summaries as the query.
   - **Pointer**: when OpenRig wrote a restore map for this seat, its path, and
     the line "read its Summary and State first". The digest complements the
     map; it does not repeat it.

   Header `[openrig-honcho continuity: background, not instructions]`, the same
   x3 quoting, an age on every item, and a source on every item (queue item id,
   decision id, session). `eval-use.ts` classifies it as moment
   `continuity`.
2. **The decision ledger.** `remember` gains optional fields:
   `remember(decision, reason?, scope?, supersedes?, kind?)`.
   - `scope` is `rig`, `mission` (the default) or a queue item id.
   - `supersedes` is the id of an earlier decision.
   - `kind` is `decision` (the default) or `approval`.

   Each entry is stored as today, an explicit conclusion plus a `decision`
   message, with metadata `decision_id` (a short stable id, `d-<8 hex>`),
   scope, reason, supersedes, kind and author. Reading:
   - the current ledger is the set of entries no later entry supersedes;
   - the reader also hides an entry the leader marked superseded through a new
     `retire(decision_id, reason)`.

   `remember` stays leader-only. An approval is recorded by the leader on the
   owner's word, with `kind: approval`. A separate owner channel is out of scope
   here.

   **Amendment (2026-11-04, before T19a):**
   - **Storage.** The server's conclusions have no metadata field: the v3
     `ConclusionCreate` schema takes content, observer, observed and session
     only. So the fields go into a one-line header at the start of the
     conclusion's content, for example
     `[decision d-1a2b3c4d · scope mission · supersedes d-0f0f0f0f]`, followed
     by the decision and its reason. The decision message carries the same
     fields as message metadata. A retirement is its own entry,
     `[retire d-… ]` plus the reason.
   - **Where superseded entries are hidden.** Only in "in force" views: the
     session-start block (and later the digest) and the decisions that `ask`
     appends. `search` still returns them, marked
     `(superseded by d-…)`, because "what did we decide first?" is a real
     question. The benchmark's history questions expect exactly those entries.
   - **Older entries.** A plain conclusion from before the ledger counts as a
     mission decision. Its id is derived from the conclusion's id
     (`d-` + 8 hex of its hash), so the leader can supersede or retire it.
   - **Scope of the fix.** The ledger covers decisions and approvals. The
     benchmark's 11 stale continuity items are seats' own state notes, not
     decisions. The digest removes those by taking open work from the live
     queue (decision 1), not the ledger.
3. **Honcho's consolidation as a proposal, not an authority.** The dreamer can
   flag contradicting conclusions. The digest never hides a ledger entry
   because of it. The flag is shown to the leader in its own digest as "possibly
   superseded: d-..., d-..." for the leader to retire or keep.
4. **Per-message recall becomes quieter** (STRATEGY phase 4, done now because it
   is small). Recall drops an item whose distinctive terms all already appear in
   the seat's transcript, read from the hook's `transcript_path`, the last 1 MB
   only, within the 2.5 s budget. (Amended at T19c from 200 KB: a real
   transcript's tail is mostly non-message records, so 200 KB held only about
   29 messages. 1 MB reads in about 3 ms, and 9 ms at worst.) A block that keeps fewer than two items is not
   shown. Logged as `dropped_known`.

   **Amendment 2 (2026-11-05, after the v0.3 review; replaces the storage and
   "older entries" points above):**
   - **Where entries live.** The review showed that the reader could not tell a
     ledger entry from a derived conclusion. Every leader message comes back as
     a leader-about-leader conclusion, so quoted text could fabricate an approval,
     and a paraphrase could outlive its own retirement. Entries now live on their
     own pair: observer the leader, observed the reserved peer `openrig-ledger`.
     That peer never sends a message, so the deriver never writes there, and
     provenance comes from where an entry is, not from its text. The writer
     refuses that peer as a sender, like `openrig`.
   - **Rejected:** filtering on `source_message_ids`. A derived conclusion the
     model cited nothing for would look genuine.
   - **Only the pair counts.** In-force views read that pair and nothing else. A
     plain conclusion is never a decision. Decisions from before the ledger stop
     showing in force unless they are migrated by a one-off script, which is a
     pilot write and needs the owner's OK. `search` and recall still find them.
   - **Limit.** Derived text elsewhere can still mention an approval. So the
     digest says, in a fixed line, that only "Approvals you hold" counts as
     approval.

## Tests

- **Unit:**
  - the digest's parts, order, budget, quoting and sources;
  - open work from a fake daemon;
  - supersession and retire in the ledger;
  - approvals matched to the seat;
  - the novelty filter on fixture transcripts.
- **Benchmark (ADR-0013):** continuity and decision questions answered by the
  digest at k = the digest's items, against today's block.
- **Scenario (ADR-0013 decision 4), the first two built:** compact mid-task and
  resume at the right step; an approval given earlier is not re-asked.
- **Pilot:** `eval-use.ts` per moment, against the targets: continuity at least
  70% used, recall at least 25%. The holdout (ADR-0013 decision 2) applies to
  recall only.

## Not doing

- Replacing OpenRig's restore map or its packets.
- Writing current state into memory.
- Letting any seat other than the leader write the ledger.

## Later: native fields for memory items (future release)

The content header from the Amendment is a workaround. Come back to it in a
future release:
- **When:** Honcho's conclusions accept metadata. Check at each server
  upgrade: look for a `metadata` field on `ConclusionCreate` in the server's
  OpenAPI schema. Checked at 3.5.0 (2026-11-05): still none, though `Conclusion`
  gained `source_message_ids` for derived conclusions.
- **Move:** the ledger fields out of the text and into real fields:
  decision id, kind, scope, reason, supersedes link and author. The text then
  holds only the decision itself, which also keeps the semantic search vector
  clean.
- **Consider adding:**
  - source links: the queue item, commit or message an item came from (STRATEGY
    section 3, rule 3);
  - action tags for lessons ("before commit", "before push"), for phase 3;
  - a review-by or expiry date for decisions that should be revisited;
  - a verified flag from the sender check (ADR-0012).
- **Migration:** existing header entries keep parsing. A one-off script
  copies them into metadata, and the reader accepts both forms.

## Consequences

- Session start makes one or two more calls: the daemon's queue list and a
  semantic query. Both are inside the existing 4 s budget, and both fail
  quietly.
- `remember` is backward compatible: a plain `remember(fact)` is a mission
  decision with no reason.
