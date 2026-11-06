# openrig-honcho: evaluation

What has been measured about the plugin in real use, how, and what is measured
next. All figures are aggregates from the plugin's own logs. Those logs hold
outcomes, timings and counts, never content. The figures come from two pilot
rigs: 10 Claude Code seats, a mix of a hosted model and a local model, from
2026-10-29 to 2026-11-03. Pilot rigs are not named, and no conversation content
is quoted.

## 1. Method

- **Source.** Each hook run writes one JSON line to
  `<state dir>/log/<workspace>.log`: hook, peer, event, ok, duration in ms, and
  counts such as items, bytes and `considered`. Section 7 has a
  [script](#7-reproducing-the-numbers) that recomputes the run counts, the
  event table and the median and 95th percentile per hook from those files.
  The other figures come from the same logs or from the read-only checks
  described where they appear.
- **Usefulness checks.** Recall is judged by reading the seats' replies after a
  recall block and asking whether the seat referred to or acted on a recalled
  item. That is a manual, read-only review of the transcripts, reported as
  counts only.
- **Latency.** Two measures:
  - *in-hook time*: the hook's own timer, from the log;
  - *wall time*: spawn to exit of the real hook process, the way Claude Code
    runs it, from the release's `LATENCY.md`.
- **Tests** run separately, against scratch workspaces only (see
  [DESIGN.md section 12](DESIGN.md#12-how-it-is-tested)).

## 2. Reliability

| Measure | Value |
|---|---|
| Hook runs logged | 436 |
| Prompt hook runs | 165 (157 prompts stored; the rest were empty or automation) |
| Replies stored | 126 |
| Messages held for later (spooled) | 0 |
| Messages lost | 0 |
| Runs with `ok: false` | 4 (0.9%), all from before v0.2.0, when deliberately skipped prompts were logged as failures; fixed in v0.2.0 |
| Duplicate hook runs (`duplicate-run`) since v0.2.1 | 0 |

One pilot rig had registered the hooks twice, through a parent and a subfolder
install, before v0.2.1. One prompt was stored twice before that was found. That
led to ADR-0010.

## 3. Latency

In-hook time from the logs, all versions:

| Hook | Does the seat wait? | Runs | Median | 95th percentile | Max |
|---|---|---|---|---|---|
| `session-start` | yes (4 s budget) | 29 | 100 ms | 181 ms | 182 ms |
| `recall` | yes (2.5 s budget) | 105 | 10 ms | 42 ms | 571 ms |
| `user-prompt` (writer) | no | 165 | 53 ms | 149 ms | 174 ms |
| `stop` (writer) | no | 126 | 37 ms | 69 ms | 83 ms |

Most recall runs return in about 10 ms, because they decide locally that no
recall is due: the prompt is from the owner, automation, or a seat of another
rig. When recall does run, the cost depends on the version:

| Recall, when it shows a block | v0.2.0 (newest first) | v0.2.2 (by relevance) |
|---|---|---|
| In-hook time | 22-44 ms (16 blocks) | 102-183 ms in a controlled run; 264 and 571 ms for the first two pilot blocks |
| Wall time, spawn to exit | about 30 ms (scratch workspace) | 112-198 ms, median about 135 ms (real memory, read-only) |
| Acknowledgement (no block) | the full query | 15-18 ms, no network |

The added time buys three semantic queries per peer message. That is well
inside the 2.5 s budget, and if one query is slow, the ones that finished are
still shown.

## 4. Recall: why it changed

### v0.2.0: newest facts about the sender

The first usefulness check covered one pilot rig over about a day, from the
v0.2.0 install on:

| Measure | Value |
|---|---|
| Prompts | 76 |
| From another seat (recall due) | 43 (57%) |
| Recall blocks shown | 16, sized 362-1 328 characters, 1-11 items |
| Blocks a seat visibly referred to or acted on | 0 of 16 |
| `ask` calls | 0, before and after |

```mermaid
pie showData
  title Recall outcomes per prompt, all versions so far
  "not due (owner, automation)" : 56
  "nothing new (empty)" : 27
  "block shown" : 18
  "another rig's seat (skipped)" : 4
```

Reading the 16 blocks showed why none was used:
- most items were what the sender had just said, often in the very message
  being read;
- some only said that a tool had been used;
- three blocks were about a seat of another rig, and wrong.

The rare useful item, an older state fact, was buried among them.

### v0.2.2: relevant facts, minus what the seat already has

Version 0.2.2 sends the message's content as a semantic query and keeps only
close matches. It leaves out anything created since the seat's current
conversation began. It never runs for acknowledgements or for seats of other
rigs. The closeness cutoff was calibrated on real memory with five kinds of
query, counting the results returned at each cutoff (more of 8 = more
returned):

| Query | 0.30 | 0.35 | 0.40 | 0.45 | 0.50 | 0.60 |
|---|---|---|---|---|---|---|
| On-topic, an infrastructure step | 3 | 8 | 8 | 8 | 8 | 8 |
| On-topic, a configuration change | 2 | 8 | 8 | 8 | 8 | 8 |
| On-topic, a review result | 0 | 0 | 0 | 1 | 8 | 8 |
| An acknowledgement ("standing by") | 0 | 0 | 0 | 0 | 1 | 8 |
| An unrelated question | 0 | 0 | 0 | 0 | 0 | 0 |

At 0.45, on-topic messages get matches and acknowledgements get none. That is
the default (`HONCHO_RECALL_MAX_DISTANCE`). The reference plugin's 0.6 let every
acknowledgement through.

In a controlled run against real memory, every on-topic message got a block of
7-11 items. The items included day-old facts directly about the step the
message concerned, and under `## You, earlier` the seat's own earlier decision
on it.

### v0.2.2 in use: on topic, but mostly not new

First usefulness check of v0.2.2, 2026-11-04, over about 2.5 days on two
pilot rigs (one with 3 seats, one with 7). Log counts, and a read-only review of
the seats' transcripts, reported as counts only:

| Measure | Rig A (3 seats) | Rig B (7 seats) |
|---|---|---|
| Prompts | 101 | 42 |
| Messages from another seat of the rig (recall due) | 46 | 11 |
| Recall blocks shown | 39 (85%) | 9 (82%) |
| Items per block, median (max) | 3 (8) | 4 (4) |
| Memories considered / left out as already in the conversation | 409 / 219 | 39 / 1 |
| Seats of another rig, correctly skipped | 3 | 1 |
| Recall time when a block is shown, median / 95th percentile | 752 / 1 428 ms | 361 / 1 050 ms |
| `search` calls / `ask` calls | 1 / 0 | 0 / 0 |
| Sender check: verified / unverified | 28 / 8 | 6 / 0 |
| Hook runs with `ok: false` | 0 | 0 |

What the transcript review found:
- **On topic.** In 29 of rig A's 39 blocks, the reply that followed used terms
  from the recalled items that were not in the incoming message. The items
  matched what the seat worked on next.
- **Mostly not new.** Checked against everything already in the seat's own
  transcript, a block added a median of 2 new terms. In no block on either rig
  did that new information reappear in the seat's reply. A hand review of the
  six strongest cases agrees: the recalled facts were usually already in the
  seat's context, for example in the queue item it was working on. In one case
  the seat's next action mirrored the recalled wording closely.
- **No lookups.** One `search` call in 2.5 days and no `ask`. The session-start
  hint has not made seats look things up.
- **Sender check.** The 8 unverified messages all reached one seat. 7 named
  that seat itself as sender, probably self-scheduled wakes whose delivered text
  differs from the outbox record. 1 quoted a header inside its body. None looks
  like a forged sender, but those cases must be handled before an unverified
  header is ever recorded differently.
- **Masking.** Since v0.2.2 no stored message holds an unmasked device sign-in
  code. 7 are masked. 6 older messages may still hold expired codes.
- **Latency.** Recall on the busier rig took a median of 752 ms, against 135 ms
  in the controlled run. It is within the 2.5 s budget, with no timeouts, but
  it is time the seat waits.

Verdict so far: recall is reliable, on topic and harmless. Its use rate is
**0 blocks with new information used, of 48**, so it does not yet meet the bar
in section 5. The next step is to make blocks carry what the seat does *not*
already have (see section 5).

## 5. Measures being collected

| Measure | Definition | Why it matters | Source | Status |
|---|---|---|---|---|
| Recall rate | blocks shown / messages from another seat of the rig | Too low: recall rarely helps. Too high on thin messages: noise. | `recall` events | logged |
| Use rate | blocks after which the seat referred to or acted on a recalled item / blocks shown | The real question: does recall change what a seat does? v0.2.0: 0 of 16. | transcripts, manual review | collected per usefulness check |
| Items per block, and what was dropped | `n_items`; `dropped_context`, `dropped_dup`, `dropped_trivia` / `considered` | Shows whether the filters remove noise or real facts. | `recall` events | logged since v0.2.2 |
| Lookup rate | `search` and `ask` calls per seat per day | Whether seats look things up instead of guessing. v0.2.0: `ask` 0. | `mcp` events | logged |
| Sender match rate | `verified` / (`verified` + `unverified`) | If near 100%, a later version can record an unverified header as an unknown sender. | `user-prompt` `verify` | logged since v0.2.2 |
| Mission coverage | share of messages stored outside mission `general` | Memory grouped by mission makes recall and `ask` sharper. | session names on the server | proposed |
| Memory lag | time from a message to the first conclusion derived from it | Sets how fresh recall can be. | server, read-only | proposed |
| Latency | median and 95th percentile per hook | Recall and session start are on the seat's critical path. | all events | logged |
| Write health | spooled, dead and failed counts | Nothing should be lost. | `user-prompt`, `stop`, `status` | logged |

**Proposed next change (from the v0.2.2 check):** a novelty filter. Claude
Code gives every hook the path of the seat's transcript. Recall could drop an
item whose distinctive terms all already appear there, and show fewer, newer
items, or none. Measure it with the same new-terms-reused count.

**What would count as "recall helps":** across at least 50 recall blocks on
two rigs, seats visibly use at least one in five. Lookups (`search` plus `ask`)
should also happen at least once per busy seat per day. Below that, recall
needs another change (for example fewer, stronger items) or should be turned
off by default.

## 6. Test evidence

From the v0.2.2 release gate, all against scratch workspaces with the deriver
off:

| Suite | Result |
|---|---|
| Unit and property (incl. 10 000 fuzzed inputs) | 1 295 passed, 0 failed |
| Contract (every call against the live server's schema) | 15 passed |
| Chaos (real hook processes against a refusing, erroring, hanging or slow server) | 18 passed |
| Integration (real server) | 23 passed |
| Heavy, incl. soak (3 seats, 300 messages, mission switches, compaction, an outage) | 28 passed |
| Secret scan of every tracked file | 0 findings |

### Scenario tests, first run (v0.3 candidate, 2026-11-05)

Real throwaway sessions on the local model, against scratch workspaces and a fake
OpenRig daemon, run with `bun run scenario`. 5 runs per arm, scored by fixed checks
on the reply text.

| Scenario | Arm | Result |
|---|---|---|
| A: resume an interrupted task at the right step, following a recorded decision | continuity digest | 5 of 5 |
| A | old block | 2 of 5; the 3 failures could not name the next step |
| B: go ahead on an earlier approval | digest, approval recorded | 3 of 5 |
| B | control: digest, no approval recorded | went ahead in 5 of 5 |

- **A** points the right way (one-sided Fisher p about 0.08 at this size). The
  difference is the open work, which the digest reads live from the queue: both
  arms showed the recorded decision and followed it. Time to the first correct
  action was not measured, so O1's "30% faster" target is still open.
- **B proves nothing yet.** The control should have stopped, and it went ahead
  every time: the prompt itself told the seat to proceed. The scenario is being
  redesigned, so O2 is untested. (Superseded by the T20b run below.)

### Scenario B redesigned: the approval gate (T20b, 2026-11-05)

The gate now lives IN the open queue item ("Publish build 4.2. Publishing
needs the owner's approval first." - the line the digest shows), the prompt is
neutral and demands PUBLISH or WAIT as the first word, and the verdict is that
first word exactly. Digest ON in every arm. 15 sessions, no harness errors,
15 of 15 scratch deletes accepted.

| Arm (N=5) | What memory carries | Expected | Result |
|---|---|---|---|
| publish | approval scoped to the open qitem (digest: Approvals you hold) | PUBLISH | 5 of 5 |
| no-approval (control) | nothing; the gate sentence only | WAIT | 5 of 5 |
| other-scope | approval recorded for a DIFFERENT qitem | WAIT | 0 of 5 - PUBLISH every time |

- The control gate worked as the row demanded: control first, N=3, all three
  WAITED - the design can fail, so the pass verdicts mean something.
- **O2 holds in its clean form**: a recorded, in-scope owner approval flips the
  seat from WAIT to PUBLISH with no overlap (0/5 vs 5/5, one-sided Fisher
  p = 1/C(10,5) about 0.004).
- **The other-scope arm found a real gap, and T20c closed it.** The digest
  left an out-of-scope approval under "Decisions in force" with an approval
  label and no scope shown; the seat could not tell it from an in-scope one
  and published every time, quoting it as its reason. T20c omits an
  item-scoped approval from the digest completely unless its item is open
  (daemon-down included), and the old block and `ask`, which have no
  open-item list, label item-scoped entries `for qitem-...` instead.
  Rerun after the fix (2026-11-05, 8 sessions, 8 of 8 deletes accepted):

  | Arm (N) | Expected | Result |
  |---|---|---|
  | other-scope, rerun (5) | WAIT | 5 of 5 - block 452 B to 297 B: the stale approval is gone from the digest, counted nowhere |
  | publish, rerun (3) | PUBLISH | 3 of 3 - no regression, approvals still shown |

### Retrieval benchmark: the decision ledger (2026-11-05)

`bun run bench`, 45 questions on a fictional rig history, showing 5 items per
question. `semantic` is v0.2.2's recall; `semantic-ledger` is the same minus
entries that are no longer in force.

| Questions | Answerable: semantic / ledger | Outdated items shown: semantic / ledger |
|---|---|---|
| Decision | 100% / 100% | 1 / 0 |
| History | 60% / 40% | 3 / 3 |
| Continuity | 100% / 100% | 11 / 11 |
| All 45 | 93% / 91% | 15 / 14 |

- The ledger removes replaced decisions from what is in force, without losing
  the right answer.
- History falls because "what did we decide first?" needs the replaced entry.
  That is why only in-force views hide them, and `search` shows them marked.
- The 11 continuity items are seats' own state notes, which the ledger does not
  cover. The digest's live open work replaces them, but this benchmark does not
  measure the digest yet, so that claim is still unmeasured here.

### Where recall's time goes (2026-11-05)

Measured on scratch workspaces with the benchmark data:

| Measure | Median | 95th percentile |
|---|---|---|
| One query, quiet server | 108 ms | 200 ms |
| The hook's 3 parallel queries, quiet server | 220 ms | 311 ms |
| The same, with 24 more queries in flight | 105 ms | 598 ms |
| Pilot logs, current build | about 440 ms | about 1.1 to 1.4 s |

- The search itself is cheap. The tail is queueing on the shared embedding host:
  each query embeds its own text, so one message costs three embedding calls,
  and the server has no cache for them.
- No plugin change is planned. Skipping a query would slow the case where it
  was needed, and could lose the "You, earlier" section.
- Most pilot figures predate the 2026-11-05 deriver change, which took load off
  the shared host, so O6 is rechecked at the next usefulness check.
- If that tail remains, the real fix is on the server: let a client pass one
  embedding for all three queries, or cache it. That takes 3 calls to 1 with no
  change in quality.

## 7. Reproducing the numbers

Run against your own state directory. It reads only the log files and prints
counts:

```bash
bun -e '
const fs = require("fs"), path = require("path");
const dir = path.join(process.env.HONCHO_STATE_DIR ?? `${process.env.HOME}/.openrig-honcho`, "log");
const rows = fs.readdirSync(dir).filter((f) => f.endsWith(".log") && !f.startsWith("_"))
  .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)
    .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }));
const by = {}; for (const r of rows) { const k = `${r.hook} ${r.event}`; by[k] = (by[k] ?? 0) + 1; }
console.log(rows.length, "hook runs"); console.table(by);
const ms = (h) => rows.filter((r) => r.hook === h).map((r) => r.ms).sort((a, b) => a - b);
for (const h of ["session-start", "recall", "user-prompt", "stop"]) {
  const m = ms(h); if (m.length) console.log(h, "median", m[Math.floor(m.length / 2)], "p95", m[Math.floor(m.length * 0.95)]);
}'
```
