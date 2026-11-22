# ADR-0019: The second half of v0.5, on Honcho

Status: accepted (2026-11-13, design.architect), under ADR-0018 decision 3 and the
owner's "proceed with 0.6 whenever ready" (2026-11-12).

## Context

- v0.5.0 shipped the outcome log and the claim-time pointer (ADR-0017). The rest of
  v0.5 was never built: local checkpoints, trust classes, lessons in seat lore, and
  lessons shown before risky actions (STRATEGY, "After v0.3").
- The store test (docs/store-test-2026-11.md) settled the store: Honcho, with the
  ledger as the source of truth for what is in force. It also found that most ledger
  entries are status reports ("main is at X", "waiting for the owner's word") that go
  stale without anyone retiring them, and that a model reading a new entry against old
  ones caught about 7 of 9 such cases, with about 2 wrong.
- OpenRig's lore convention (daemon/docs/reference/lore-routing.md) sets hard limits
  for lessons: one file per lesson at `seats/<seat>/lore/<slug>.md`; the owning seat
  is the only author; no automatic mining of transcripts or memory into lore; no
  central curation or review ceremony; no copy, export or serving of lore outside the
  rig. ADR-0015 already ruled that lesson text never goes to Honcho.
- The 2026 literature (survey in the store test) favours itemized lessons with a
  ground-truth success signal (ReasoningBank, ACE), and deterministic supersession over
  model-decided supersession (MemStrata, TOKI, Supersede).

## Decisions

1. **Checkpoints (V1).** The Stop hook saves one line per seat in local state: the
   first non-empty line of the seat's final reply, redacted, stripped of control and
   invisible characters, capped at 200 characters, with its time. No model, no network.
   The digest shows it first after a compaction or resume: "Where you left off (<age>):
   <line>". So "where was I" works even when Honcho is behind. A newer checkpoint
   replaces the older one; nothing is sent to Honcho.
2. **Trust classes (V2).** Every item the plugin shows (digest, recall, pointer,
   search results) carries one of three labels, set by where it came from, never by
   its text:
   - `authoritative`: OpenRig state (queue rows, outcome records) and the owner's
     approvals in the ledger;
   - `recorded`: ledger decisions written by a seat through `remember`;
   - `derived`: Honcho's own conclusions about a peer.
   Text cannot raise its class by being repeated or quoted: a derived conclusion that
   quotes an approval stays derived.
3. **Status entries (V3).** `remember` gains a third ledger kind, `status`, beside
   decision and approval. For status entries the newest one per scope and mission is
   the only one in force, with no model and no retire needed; older ones show as
   history. The skill tells seats to record release and branch state as status, and
   choices and rules as decisions. Existing entries keep their kind.
4. **Stale proposals (V4), measured before they ship.** When a seat records a decision,
   an offline job (never inside a hook) asks the local model whether the new entry makes
   any in-force entry of the same mission stale. A yes becomes a proposal for the
   leader, never an automatic change: one digest line with the exact `retire` call.
   First an evaluation script runs on the 9 hand-checked cases and the 6 retirements
   from the store test. It ships only if it catches at least 7 of the 9 with at most
   2 false proposals, and costs less than Graphiti's 61 s of model time per entry.
   **Result (2026-11-13, docs/stale-proposals-eval-2026-11.md):** with the full labels
   (14 stale, 8 durable) and Graphiti's 8/14 with 1/8 false as the bar, one call per
   entry over-flags standing rules (6/8); a rule-or-state class per entry first, then
   one call over state entries only, catches 11/14 with 2/8 flagged (1 a plain mistake on
   a re-reading of the reasons) at 3.7 s per entry. It goes ahead as proposals only.
   **How it runs:** the plugin has never called a model; it talks only to Honcho. So
   the check is an on-demand command like the outcome collector (`bin/stale-check.ts`),
   never inside a hook, against an OpenAI-compatible endpoint given by flags, with the
   key read from an environment variable named on the command line and never stored.
   Proposals and the stored rule-or-state classes live in a local 0600 file; the lead
   seat's digest shows pending proposals with the reason and the exact `retire` call, at
   most three times each. The measure is the share of proposals the lead seat retires.
5. **Lessons before risky actions (V5).** The plugin reads the seat's own lore files
   from disk, with no network and no copy, and shows the ones whose Moment matches the
   action about to run, as a short pointer to the file. Matching uses the Moment text
   and the file name, not a new frontmatter field, so the convention is untouched.
   "Risky" is a fixed list to start: push, publish or release commands, deletes of
   files or remote resources, force flags, and writes outside the project. First a spike
   proves the delivery channel on a real seat: the text must reach the model before the
   tool runs, on Claude Code and on Codex. Unit fakes have missed exactly this twice
   (ADR-0017, F-G and F-K).
6. **Suggesting a lesson (V6).** The plugin never writes lore. When the outcome log
   shows rework on a seat's item (a follow-on fix row, or a review that ended in a fix),
   the seat's next digest carries one line suggesting it write a lesson, with the item
   id and the lore path. The seat decides and writes it itself.

Order: V1 and V2 first (small, no model), then V3, then the V4 evaluation, then the V5
spike, then V5 and V6.

**Amended 2026-11-13.** No seat on any rig has a lore file yet, so V5 would have nothing
to show: V6 comes first, because it is what makes seats write lessons. And neither
harness documents a way to show the model text before a tool runs without blocking it:
Claude Code's PreToolUse `additionalContext` arrives with the tool result, and only a
`deny` puts its reason in front of the model before the command runs. How V5 delivers
(at the moment the work names the action, or by blocking the first attempt once) is an
owner decision, taken once V6 has produced lessons to show.

**Decided (owner, 2026-11-13: "your recommendation").** V5 shows a seat's matching
lessons when it picks up work whose text names the risky action (publish, release, push,
delete, force), beside the claim pointer, read from the seat's own lore files on disk.
It never blocks a command. A pre-tool hook may add the same pointer as reinforcement,
knowing it reaches the model with the tool result. Each is a short build row with a failing test first.

**Amended 2026-11-14 (v0.5.5, owner: "yes, ship v0.5.5 with both fixes").** A deep reading
of ten 2026 papers (revocation, origin-bound authority, gates) found two gaps in what
shipped:

- **The claim pointer drops ledger state.** Its search snapshot reads the ledger pair and
  knows which entries are retired or superseded, but the pointer relabels every hit
  `derived` and shows a retired decision as a plain title. The pointer now shows each
  title with its real class and the same "(retired)" / "(superseded by …)" marker `search`
  uses, and never uses a retire entry as a title. An agent shown a revoked record acted on
  it in 43% of trials in 2609.08258; a read-time mark is the cheap part of the fix (v0.6
  extends it to every surface).
- **Decision 2 held only for reading.** `remember` took `kind: approval` from the lead
  seat's model with no check that the owner said it, so a peer message or a Honcho
  conclusion saying "the owner approved X" could become an authoritative approval. Now
  the prompt hook records where the current turn came from (owner, peer, automation) in
  local state, and `remember` accepts an approval only when the current turn is the
  owner's and recent; retiring or superseding an approval needs the same. The entry is
  stamped as owner-checked. Approvals without the stamp (all earlier ones) stay visible
  but show as "owner not checked" with class `recorded`, not `authoritative`.
  Residuals, stated rather than fixed: a prompt with no rig envelope still counts as the
  owner's (a peer typing raw keys into the lead pane passes), and every seat shares one
  workspace key, so a process that writes to the server directly, bypassing `remember`,
  can still forge an entry, stamp included. The stamp closes the model-laundering path,
  not the shared-key path; per-seat keys would need a server change and the owner's OK.

  Rulings from the attack review (R19, 2026-11-15): only an approval carrying the owner
  stamp needs an owner turn to retire or replace; an unstamped one is a recorded entry its
  own seat may end like a decision, or every pre-v0.5.5 approval would be stuck until the
  owner typed in the lead pane. The 30-minute limit stays: a long owner-started turn that
  outlives it is refused and the seat asks the owner again. A record dated more than a
  minute ahead never counts, and an owner record must name the owner peer. Stated
  residual: the prompt hook's two exits before its configuration loads (a broken settings
  file, an unknown harness) write no record, so the previous turn's stands; that needs a
  settings file broken after the seat's MCP server started (a broken file at start
  disables the server too), and the 30-minute limit still bounds it.
- **Delivery (v0.5.6, owner 2026-11-17: "do all 3").** The first 48 hours of data showed
  the learning features not reaching seats. Stale proposals and lesson suggestions are now
  counted only once the digest text kept their line, and come before the long sections;
  lesson suggestions are offered on compaction and resume, not only on a fresh start; the
  pointer and the digest name the real search call, `mcp__rig_memory__search`, the same
  name on both harnesses. The outcome log counts a row's pointer even when it arrived
  before the claim (tool calls still count from the claim), and reports the share of
  pointer rows with a search after the pointer that led to the claim.
- **A running MCP server keeps its old code** (found 2026-11-14: every Claude seat's server
  on both pilots predated v0.5.1). Installs that change server code ask for a
  keep-conversation restart of each seat, and `status` now reports "running vX code but
  vY is installed".
- **Approvals that end with their row (v0.5.8, owner 2026-11-22: "yes, build it as
  v0.5.8").** A one-time approval ("publish 0.13.0") stayed in force after the work was
  done, and only the owner could end it: on the busier pilot 28 approvals were in force, none
  tied to a row. `remember` with `kind: approval` now takes an optional `ends_with` (a
  qitem id), written on the owner's turn into the stamped header (` · ends qitem-…`).
  Once that row's work is finished, the approval is *used*: it leaves the digest, `ask`,
  the stale pick and the stale check, and `search` and the pointer mark it
  `(used: qitem-… closed)`. Finished means closed (daemon state `done`) for any reason
  but a hand-off; a hand-off is followed to the row it names, up to five rows, because
  OpenRig work moves by hand-off (review R21 F-Q4). Nothing is written to the ledger and
  no model decides: it is a read-time rule, like status replacement. Answers are kept
  with their time in a local 0600 file (`closed/<ws>.json`) and asked again once old -
  open rows after 10 minutes, finished ones after 6 hours, so a reopened row brings its
  approval back (R21 F-Q1). Each read asks at most five rows, oldest answer first, so
  open rows cannot starve the rest (F-Q2), inside one 600 ms wall (F-Q3); the recall
  hook's pointer and the offline stale check read the file only. Any failure keeps the
  last answer, and no answer means the approval stays in force, the view before v0.5.8.
  The stale check skips used approvals entirely (no class, no comparison). Stated
  residuals (R21 recheck): a lookup slower than the 600 ms wall is discarded, so on a
  daemon that answers single rows that slowly an approval simply stays in force; and a
  close remembered wrongly hides its approval from the digest, `ask` and the stale pick
  for up to 6 hours, until the next recheck (the pointer and the stale check, which read
  the file only, correct after some other read asks again). An answer dated more than a
  minute ahead is asked again at once. Not changed: retiring or replacing an owner approval still needs
  the owner's turn, and approvals without `ends_with` stand until retired. No time
  limit: it would end approvals that are meant to stand. Residual, stated: any seat
  that can close the named row ends the approval early - that only removes a
  permission, never grants one. Older plugin versions read an `ends` header as plain
  text and drop the entry, so a rig upgrades all its seats together.

## Not doing

- Writing, editing or mining lore from the plugin, or copying lore text to Honcho.
- Rig-wide lessons: lore is position knowledge; a rig-wide lesson needs an authored
  home of its own (ADR-0015), which is v0.6 work with the promotion gate.
- Any model call inside a hook for these features.
- Automatic retirement or supersession from a model's judgement.

## How we'll know

- V1: after a compaction the digest's first line is the seat's last checkpoint; a run
  with Honcho unreachable still shows it.
- V2: every shown item carries a label; a test plants a derived conclusion that quotes
  an approval and checks it stays derived.
- V3: on a copy of the real ledger, status entries leave the in-force list once a newer
  status for the same scope exists.
- V4: the evaluation numbers against the bar above.
- V5: a real seat, about to run a matching command, shows the lesson pointer before the
  tool runs, on both harnesses.
- V6: in the outcome log, the share of reworked items that get a lesson within a day.
