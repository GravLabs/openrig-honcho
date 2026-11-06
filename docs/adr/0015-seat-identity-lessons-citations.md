# ADR-0015: Seat identity, lessons and citations

Status: proposed (2026-11-05, design.architect). Evaluation requested by the
owner. Nothing here is built yet. Section 1 is decided; sections 2 and 3 are
proposals for after v0.3.

## 1. Seat identity: keep the session name as the peer id

**Question.** Should the peer id move to OpenRig's `nodeId`, so a seat keeps its
memory when its name changes?

**Evidence**, from the local OpenRig database, read-only:

| Event | Session name | `nodeId` |
|---|---|---|
| Handover or rebuild (9 on record) | same | same |
| A rig recreated under the same name (4 seats) | same | **new** |
| A seat moved to another pod and renamed (1) | new | **new** |
| One node with two session names | 0 cases | |

`nodeId` never outlived a change that the session name did not, and it changed
where the name held. Peers keyed on it would have lost memory in the rig
recreation and gained nothing in the move. OpenRig's `previous_occupant` does not
help either: after the move it held the new name, so OpenRig keeps no link from
the old name to the new one. The node id would also make memory unreadable,
because the deriver writes the peer id as the subject of every fact.

**Decision (owner, 2026-11-05).** Keep the session name. No aliases, and no
`nodeId` in the plugin. A rename stays a rare manual event, handled by
`scripts/copy-peer-memory.ts`.

## 2. Lessons: seat lore is the source of truth, read locally

OpenRig's lore convention fits: one Markdown file per lesson at
`seats/<seat>/lore/<slug>.md`, with stage, method and date, and Moment, Reflex,
Instead and Because sections. Its stages match "promoted through review". Today
no seat has any lore, and lessons live in private notes.

The convention sets limits that change the earlier plan:
- **Not Honcho as the index.** Lore must not leave the rig by copy, export or
  serving. Copying lesson text to the memory server is a copy. This corrects
  STRATEGY.
- **The owning seat is the only author,** and OpenRig rules out automatic mining
  of transcripts or memory into lore. So memory cannot write lessons; a seat or
  review writes them.
- **No rig-wide lore.** It is position knowledge, read through an explicit grant.
  Rig-wide lessons need an authored home of their own.

**Proposal for phase 3.** The risky-action hook reads the seat's own lore files
from disk, with no network and no copy, and shows those whose Moment matches the
action. A small `action:` field in the frontmatter would make the match exact;
check first that the convention allows it.

## 3. Citations: use them to show sources, not as proof

Since the 3.5.0 upgrade, on real pilot data (counts only):

| Measure | Result |
|---|---|
| Derived conclusions with a citation | 2 862 of 2 862 |
| Citations per conclusion | 1.19 on average, 4 at most |
| Cited message written by the conclusion's subject | 1 570 of 1 570 checked |
| At least half the conclusion's terms in the cited message | 72% |
| 25 to 50% | 19% |
| Under 25% | 9% (paraphrase or a weak citation; not reviewed by hand) |

Coverage and attribution are excellent. That also speaks to the thinking-off
risk: no fact was cited to another seat's message. Note this measures citations,
so it would miss a fact wrongly attributed along with its citation.

**Proposal.** After v0.3: add `source_message_ids` to the plugin's `Conclusion`
type; show each item's source session and time in `search` and "since you were
away"; add the coverage and overlap counts to `eval-use.ts` as a standing quality
check. A citation says where a fact came from, not that it is true or in force,
so it is not a trust signal: that remains the ledger's reserved pair.
