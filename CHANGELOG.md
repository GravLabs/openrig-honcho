# Changelog

## v0.5.0 (2026-11-11)

Measure whether memory helps, and get seats to look things up themselves (ADR-0017).

- **Outcome log.** `bin/outcomes.ts --rig <name>` writes one record per closed
  queue row, taken from OpenRig's own queue: claim and close times, how the row
  closed, follow-on rows, and the destination seat's memory use while it worked
  (digest, recall shown or held, `search`, `ask`, `remember`, `retire`). It holds
  ids, times and counts only, never message text. It stays in a local file,
  readable only by its owner, that can be rebuilt from scratch, and nothing is
  sent to Honcho. `status` reports when it last ran.
- **A pointer when a seat picks up work.** On a queue hand-off, the seat sees up to
  three lines: how many related items memory holds, the titles of the top two, and
  the exact `search(...)` call to see more. If nothing is related, nothing is shown.
  It is held back for the same share of prompts as recall, so its effect can be
  measured.
- **The digest and the skill point to search.** After context loss, the digest ends
  with the search call for the seat's open item. The skill now starts with "search
  first when you start a queue item", and is shorter.
- **Codex seats can be measured too.** `--recall-holdout` now works for the Codex
  install.
- **Security.** Search text built from queue rows is redacted first, and
  invisible, bidirectional and control characters are stripped from everything
  the pointer shows. A pointer shows only for a verified hand-off addressed to
  this seat. The collector accepts only well-formed seat names and never prints
  control characters. Digest titles from queue rows get the same treatment.
  GitHub and GitLab tokens are now masked by their prefixes, however short.

## v0.4.1 (2026-11-10)

Security fixes for the Codex install, from an independent security review of v0.4.0.
The Claude path is unchanged. Rerun the Codex install on each Codex seat folder to pick
them up.

- **Trust only what we wrote.** The installer used to record trust for any hook in a
  group that merely mentioned the plugin folder, so a planted command could be
  trusted. Now it trusts, merges and removes only hooks that exactly match what it
  writes, and never touches anything else.
- **Parallel installs no longer lose trust.** Two installs sharing one `CODEX_HOME`
  could drop one seat's trust block, leaving that seat's hooks silently untrusted. A
  lock now guards the user config, which is re-read before it is replaced. The run
  aborts if someone else changed it in the meantime.
- **Control characters refused.** A path containing a control character or DEL
  could break the user's Codex config. Such paths are refused like the other unsafe
  characters.
- **Backups of the user config stay in `CODEX_HOME`,** in a folder only the owner can
  read, and are never written through a symlink.
- **No leftover temp files** after a refusal partway through an install.
- **Nested seats.** A seat below a folder that already runs our hooks skips its own
  hooks only when that folder holds all of them, from a plugin copy that still
  exists. If it holds only some of them, the install is refused with nothing
  written, and the message says what to fix. Uninstall always works.

## v0.4.0 (2026-11-09)

Codex seats get the same memory as Claude Code seats (ADR-0016).

- **Codex hooks.** The same four moments as Claude: the continuity digest at
  startup, resume, clear and compaction, recording each prompt and reply, and recall
  when another seat writes. The hooks are told which harness they serve
  (`--harness codex`); nothing is guessed. The Claude path is unchanged, byte for
  byte.
- **`rig_memory` on Codex.** The server runs from the seat's Codex config with its
  tools approved for our server only, so it works under `approval_policy = "never"`.
- **Codex install.** `install-project.ts --harness codex` writes the seat's project
  hooks, a marked `rig_memory` block in `.codex/config.toml`, the skill in
  `.agents/skills/`, and a settings file readable only by its owner. It records
  hook trust for our own hooks in the user's Codex config, one marked block per seat,
  so several seats share one `CODEX_HOME`. Uninstall removes exactly what it added
  and keeps backups.
- **What the installer checks, and refuses.** It checks that the seat folder is a
  trusted Codex project and says so if not; it never grants project trust itself.
  It refuses a seat in a linked git worktree, because Codex reads that seat's hooks
  from the main checkout. A seat nested inside another seat's install skips its own
  hooks when Codex would already load the outer ones.
- **Safe paths only.** Codex runs hook lines through a shell, so the Codex install
  refuses a seat, settings or plugin path containing a quote, `$`, a backtick, a
  backslash or a newline.
- **Codex Stop runs synchronously** with one 20 second budget, because `codex exec`
  ends background hooks at shutdown. What is left after the budget is kept locally
  and sent later.
- **Also for Claude:** a backup taken in the same second as an earlier one no longer
  overwrites it.

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
