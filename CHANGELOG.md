# Changelog

## v0.3.1 (2026-11-07)

- **Guidance matches v0.3.** The `rig-memory` skill now explains the continuity
  digest, what counts as a decision or an approval, `retire`, and the new `remember`
  fields. The `ask` tool says it is slow and to use `search` first.

## v0.3.0 (2026-11-06)

Memory reaches a seat when it can change what the seat does, and what it says can
be trusted. Requires Honcho 3.5.0.

- **Continuity digest.** At every startup, resume, clear and compaction a seat sees
  its open work (live from OpenRig), where it left off, decisions in force,
  approvals it holds, what changed while it was away, and its restore map. About
  2 500 characters. `HONCHO_DIGEST=off` keeps the old block. (ADR-0014)
- **Decision ledger.** `remember` gains reason, scope, supersedes and kind (decision
  or approval), and a new `retire` tool ends an entry. Entries live on a reserved
  pair that nothing derived can write to, and only that pair counts as in force.
  Decisions recorded before v0.3 no longer show as in force; `search` and recall
  still find them. `scripts/migrate-ledger.ts` can carry them over. (ADR-0014)
- **Approvals are scoped.** An approval for a queue item shows only to a seat that
  has that item open. If the open-work lookup fails, none is shown.
- **Quieter recall.** Items the seat's transcript already holds are dropped, and a
  block with fewer than 2 items is not shown. `HONCHO_RECALL_NOVELTY=off` keeps
  the old behaviour.
- **Routine messages skip the deriver.** Short status messages are stored but not
  turned into memories. `HONCHO_SKIP_ROUTINE=off` keeps the old behaviour.
- **Sender check.** It uses OpenRig's delivery time, recognizes a seat's own wakes,
  and logs how a body differs, as counts only. It still only logs.
- **Measurement.** `scripts/eval-use.ts`, the recall holdout
  (`HONCHO_RECALL_HOLDOUT`), `bun run bench` and `bun run scenario`. (ADR-0013)

## v0.2.2 (2026-11-02)

- Recall is chosen by relevance. When another seat of the rig writes, recall
  searches the rig's memory with that message's content (distance gate 0.45,
  `HONCHO_RECALL_MAX_DISTANCE`). It shows what the seat and the mission know
  about the sender (`## About <sender>`) and what this seat did on the topic
  before (`## You, earlier`). It leaves out what the seat already has in its
  current context, duplicates and bare tool-use items. There is no recall for
  bare acknowledgements, the owner, or seats of other rigs. If one query is
  slow, the queries that finished are shown. (ADR-0011)
- New `rig_memory` tool `search(query, about?)`: relevant memories and messages
  in about a second. The session-start block ends with a pointer to it.
- Senders are checked against the OpenRig daemon's own delivery record (its
  outbox); this release only measures. A queue nudge takes its sender and
  mission from the queue item, so queue work lands in its mission. A contract
  test checks the envelope parser against OpenRig's own `wrapPaneEnvelope`.
  (ADR-0012)
- Device sign-in codes are redacted, as are AWS access key ids in mission
  names.
- `scripts/copy-peer-memory.ts` carries a seat's recorded decisions and peer
  card to a new peer id, for a seat that is renamed.

## v0.2.1 (2026-10-31)

- A seat never runs the plugin's hooks twice. The installer leaves hooks out
  of a subfolder whose parent already runs them, and each hook ignores a second
  identical run of the same event within 5 seconds. (ADR-0010)

## v0.2.0 (2026-10-31)

- Recall: when another seat's message arrives, the seat sees a few things the
  rig has learned about that sender, once each per session, within 2.5
  seconds. (ADR-0009)
- Memory blocks quote every header-like line, also behind carriage returns,
  Unicode line separators and zero-width characters.
- The project install keeps hooks in place on a re-run and refuses concurrent
  runs.

## v0.1.2 (2026-10-30)

- The project install keeps a record of what it added, so uninstall removes
  only that, and keeps its backups inside the project's `.claude/` folder.

## v0.1.1 (2026-10-29)

- Install into seats that already exist while they keep their conversations
  (`bin/install-project.ts`). A seat's peer defaults to its OpenRig session
  name. (ADR-0008)

## v0.1.0 (2026-10-29)

- First release: right sender from the OpenRig envelope, one Honcho session per
  seat per mission, memory at session start, resume and compaction, the
  `rig_memory` tools, local spooling when Honcho is down, and redaction of
  secrets before anything leaves the seat.
