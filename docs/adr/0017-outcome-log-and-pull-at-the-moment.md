# ADR-0017: Outcome log first, then seats pull memory at the moment of need (v0.5)

Status: accepted (2026-11-10, design.architect), on the owner's request: "move the
outcome log up to v0.5 first. also, push the seats to search memory themselves as
you prescribed, think about the best way."

## Context

Five days of pilot logs (2026-11-06 to 11-10, counts only):

- The plugin is reliable: 3 failed runs out of about 2 270 on the busier pilot rig, none on
  the other. It records prompts and replies from every seat. The recall filter
  drops 59% of candidate items as already known or duplicate. The digest carried
  open items and decisions at 64 of 83 restarts.
- **Seats almost never pull.** In five days the only memory tool calls on the busier pilot
  came from its architect: 31 `remember`, 5 `retire`, 2 `search`. Build and review
  made none. No seat has ever called `ask`. The skill already says "search first,
  it answers in about a second", so guidance text alone does not change this,
  which is what STRATEGY section 4 predicted for seats on small local models.
- **Nobody can say whether memory helps.** The holdout keeps recall back from about
  a quarter of eligible prompts, but nothing measures what happens to the work
  afterwards. O5 and O7 have no numbers.

OpenRig already holds the outside evidence: queue rows with their claim and close
times, closure reasons, hand-offs, and the follow-on rows that rework creates. The
plugin already reads queue rows read-only through the daemon (`daemon.ts`,
ADR-0012) and recognises a queue hand-off prompt (ADR-0012 decision 3).

## Decisions

### Part A: the outcome log (built first)

1. **Source: the OpenRig queue, read-only.** Each rig's closed queue rows, through
   the daemon API the plugin already uses. Outcomes come from outside the agent and
   are never judged by a model (STRATEGY, recursion limits).
2. **Pointers and counts, never content.** Each closed row gives one record:
   qitem id, source and destination seats, tags, the created, claimed and closed
   times, the closure reason and target, hand-offs, reopen count, the ids of rows
   that follow from it, and **memory use during the item**: whether a digest was
   shown, recall shown or held (the holdout arm), and the destination seat's
   `search`, `ask`, `remember` and `retire` calls between claim and close. It holds
   no body text, no summary text and no prompts. Market-desk stays counts only.
3. **Local and rebuildable.** An append-only JSONL file per workspace in the state
   folder (`outcomes/<workspace>.jsonl`), keyed on the qitem id and its closing
   transition, so a rerun never duplicates and the whole file can be rebuilt from
   the queue plus our own logs. Nothing goes to Honcho.
4. **Off the critical path.** A collector command (`bin/outcomes.ts`) runs on
   demand, or from a rig's own schedule. No hook waits on it. The `status` tool
   reports its last run and counts.
5. **What it measures first.** Per seat and per tag: time from claim to close;
   rework (follow-on rows that fix or redo the item, and review rows that end in a
   fix row); the share of rows closed denied, failed or canceled; and memory use per
   item. Split by holdout arm, this gives the first honest answer to "does shown
   memory help": rework and time with recall shown against held.
6. **Tie tool calls to items.** MCP log lines gain the seat's session and its
   current queue item, so a `search` can be counted against the item in progress.
   The Codex install gets the holdout setting it lacks today, so Codex seats can be
   measured too.

### Part B: seats pull memory at the moment of need

7. **The moment is claiming work.** When a queue hand-off reaches a seat, the
   UserPromptSubmit hook already sees it and can read the row. It runs one fast
   search for that row (local budget, about 200 ms). It shows **a short pointer,
   not the results**: how many related items memory holds, the one-line titles of
   the top two with their ids, and the exact call to see more, for example
   `search("install trust exact match")`. The seat decides whether to pull. If
   nothing related is found, nothing is shown.
8. **Why a pointer rather than the results.** Showing everything is what recall
   already does on peer messages, and most of it is filtered as known. A concrete,
   item-specific pointer gives the seat a reason to pull that general advice does
   not, and keeps the block well under the O6 budget. It also leaves room to see
   whether seats act on a pointer, which is the behaviour the owner asked for.
9. **After context loss, the same pointer.** The continuity digest ends with one
   line for the seat's open item: the search call for it.
10. **The skill leads with the habit.** Its first instruction becomes: "When you
    start a queue item, search for it first", with one example call. That is short
    and cheap, and on its own not expected to be enough (see Context).
11. **The holdout covers the pointer.** Held prompts get no pointer, so the
    outcome log can compare pull rate, rework and time for shown and held.

## Not doing

- Forcing a search, or blocking work until one happens.
- Injecting full search results at claim time; that is push, and recall already
  does it.
- Judging outcomes with a model, or writing outcomes to Honcho.
- Lessons, the promotion gate and action-moment lessons; they follow in v0.5 once
  the outcome log gives a baseline.

## How we'll know

- The outcome log rebuilds byte-identically from the same queue and logs.
- Pull rate: the share of claimed items where the destination seat called `search`
  before closing. Today it is about 0 for build and review. Target with the pointer
  shown: at least 50%, and clearly higher than in the held arm.
- Rework and time per item, shown against held. Neither may get worse; the first
  real number for O5 and O7 comes from here.
- Latency: the claim-time pointer stays inside the recall budget, p95 under 1 s.

## Build order

1. C1: the outcome collector, from the queue and our logs, plus session and item on
   MCP lines. Unit tests on fixture queue rows; one rebuild-identity check.
2. C2: the claim-time pointer, with the holdout, on fixtures and then on scratch.
3. C3: the digest line, the skill change, and the Codex holdout setting.
4. Review, gate, release, and the pilot install with the owner's approval.
