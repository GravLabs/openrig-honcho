# Changelog

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
