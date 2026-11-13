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
