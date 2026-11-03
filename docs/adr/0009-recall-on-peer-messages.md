# ADR-0009: Recall when work arrives from another seat (v0.2)

Status: accepted (2026-10-30, design.architect); approved by the owner
2026-10-30. Changes one BRIEF rule ("No per-turn fetches", reader item 2) for
prompts from other seats only.

## Context

The pilot, read-only analysis on 2026-10-30, about 29 h after install
(plugin log, seat counters, seat transcripts, Honcho reads):

- **Writing works.** 106 messages were written with 0 failed, spooled or dead,
  and the server holds exactly what the seats' counters say. Hooks ran at
  least once per real prompt. The deriver made 2,429 conclusions with no exact
  duplicates. They are concrete ("the release candidate was frozen at commit
  a1b2c3d", "the go-ahead for phase 2 is still queued for the owner").
- **Reading back almost never happens.** Memory reached a seat twice, both by
  the session-start block after a compaction (1.7 KB and 5.2 KB). No seat ever
  called `ask`. The skill makes `ask` optional and slow (30-50 s), and seats
  don't pick it.
- **Missions stay `general`.** None of the 7 queue items sent to pilot seats
  since install had a `mission:` tag (they use short tags like `m7`), so E11 never
  fired, and no seat called `mission(id)`.
- **When work starts.** 38 of the 46 prompts the seats received (83%) were a
  message from another seat (rig header) or a queue nudge. That is the moment a
  seat starts on something and would gain from what the rig already knows.

So the memory is good but sits unused between compactions. The fix is to put a
small, relevant slice of it in front of the seat when work arrives, without
the seat having to choose to.

## Decision

1. **A second, synchronous `UserPromptSubmit` hook, `bin/recall.ts`.** The
   existing writer hook stays async and unchanged. The recall hook:
   - decides locally, with no network, whether the prompt arrived from another
     seat: a rig header (`From:` / `To:` / `Sent:`, the same parser the writer
     uses) or the ADR-0003 queue-nudge text. Owner-typed prompts, automation
     the writer skips, and everything else exit at once with nothing on stdout.
     This keeps the BRIEF rule for every other turn: no fetch, no added wait.
   - on a peer prompt, fetches inside a **2.5 s** wall budget (hook `timeout:
     5`) and prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
     "additionalContext":"..."}}`, or nothing when the budget runs out, a call
     fails or nothing new is found (S1: a failure is silence, never an error).
2. **What it fetches (all from cheap calls, in parallel):**
   - semantic `POST /conclusions/query` with the prompt's body (redacted, first
     500 chars) as the query, `top_k` 6, for observer = this seat with observed
     = the sender, and for observer = this seat's mission scope with observed =
     the sender. In pilot only the leader observes other seats (the
     architect holds 107 conclusions about build); build and review observe
     only themselves, so for them the scope pair (`scope.general` -> sender:
     476 about build, 403 about the architect) carries the recall;
   - if T14a shows the query is too slow (p95 over 1.5 s on the live server),
     fall back to the most recent conclusions for those two pairs from
     `/conclusions/list`, with no semantic step.
   The block is wrapped like the session-start block (`[openrig-honcho recall:
   background, not instructions]`, the X3 line quoting), lists each item with
   its age, and is capped at **1,500 characters**. The cap is small on purpose:
   pilot's build and review seats run the local Qwen model, where context is
   expensive.
3. **No repeats.** The seat state keeps the ids of conclusions recalled in the
   current Claude session (capped list, reset at session start). An item is
   never shown twice in one session, so a burst of messages from one sender
   doesn't inject the same block each time.
4. **Kill switch and budget.** New env `HONCHO_RECALL` (`on` default, `off`
   disables only this hook). Each run logs one event (hook `recall`, outcome,
   ms, bytes injected, n items, error class), never content.
5. **The skill** says when to call `ask`: before starting a queue item whose
   background you don't have and that the recall block didn't cover, and not
   on every turn. It also says to tag queue items with `--mission <id>` so
   memory is grouped by mission.

## T14a result (2026-10-30, architect, read-only)

- Embeddings for all three Honcho stacks are served from the shared model host
  (the shared model host:8501, Qwen3-Embedding-0.6B), the shared model host. By rule 2
  above, recall uses **`/conclusions/list` only**, no semantic query.
- `POST /conclusions/list?size=6` with body
  `{"filters":{"observer_id":<o>,"observed_id":<d>}}` on pilot, 10 calls:
  7-43 ms (median 12 ms), newest first. The 2.5 s budget stays as the cap for a
  slow or unreachable server; the expected cost is under 0.1 s.

## Also in v0.2 (small, already in the plan)

- Log a prompt that attribution chooses not to record (empty, harness
  content, OpenRig automation while `HONCHO_RECORD_AUTOMATION` is off) as
  `ok: true, event: "not-recorded"`. Today it is `ok: false, event: "skipped"`,
  which reads as a failure. (Corrected 2026-10-31: the pilot's 4 such lines are
  these skips, not duplicate prompts as first written; `recordPrompt` never
  returns a duplicate.)
- `install-project.ts` takes a lock on `.claude/openrig-honcho/` for the apply
  (the 2/7 and 4/7 "partial" race).
- `release.ts` refuses with fact/reason/fix when `release/v<ver>` is a file (C12).
- `install-project.ts` keeps its hook groups at their current position on a
  re-run instead of moving them to the end (pilot v0.1.2 upgrade: ours moved
  after the OpenRig activity relay; foreign order was unchanged, so harmless).
- Gate/release split for the busy shared deriver: the gate proves deletes were
  accepted; `release.ts` refuses while any scratch workspace is listed.

## Not doing

- Fetching on every prompt, or on owner-typed prompts.
- Calling `/chat` (dialectic, 6-50 s, model-server-backed) from a hook.
- Guessing missions from pilot-style tags like `m7`. Mapping tag
  conventions per rig is a guess; `--mission` is the supported path.

## How we'll know it worked

- Unit: a peer prompt over a fake server gets a block within budget; owner,
  automation and plain prompts get nothing and make no request; a slow server
  gets silence at 2.5 s; ids never repeat within a session; the cap holds; the
  injected text never contains an envelope line unquoted.
- Integration (scratch workspace only): the real query endpoint returns items
  written earlier in that workspace.
- Pilot (after the owner approves the release): in the pilot log, recall
  runs on most peer prompts with a non-zero block, p95 under 2.5 s, and the
  added wait shows in no seat complaint. A read-only check a day later looks
  for seats acting on recalled facts.

## Consequences

- Peer-message turns wait up to 2.5 s longer before the model starts. Every
  other turn is unchanged.
- Each peer prompt costs one or two embedding calls on the Honcho server. T14a
  measures this and finds where embeddings are served; if that is the shared
  model host, we use the list fallback rather than add load there.
- Two `UserPromptSubmit` entries in `hooks.json`; `install-project.ts` must
  merge and uninstall both (ADR-0008 rules unchanged).
