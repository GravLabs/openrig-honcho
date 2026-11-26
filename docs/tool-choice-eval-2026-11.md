# Tool-choice evaluation, 2026-11 (T21)

Owner, 2026-11-25: "make sure there are proper tests for skills / tools", then "book the engine time
and run the full set" and "yes, test it with auto-memory off".

## What it measures

Whether a model given the plugin reaches for the right `rig_memory` tool at the right moment.
The text side is pinned by `tests/unit/skill-contract.test.ts`. This run tests the behaviour.

- **Runner:** `bun run scenario --scen tools` (`scripts/scenario.ts`, verdicts in `scripts/scenario-core.ts`).
- **Sessions:** throwaway `claude -p` sessions on a local model, one at a time, each on a fresh scratch workspace deleted afterwards.
- **Verdicts:** pure functions of the session's tool-call list, never of the reply text.
- **Arms:** skill on (the plugin as shipped) and skill off (the same plugin without `skills/rig-memory`). The tool descriptions are the same in both arms.

| Case | Pass when |
|---|---|
| C | a plain seat picking up a queue item searches before its first edit, write or shell call |
| D | the lead, told an owner rule ("From now on every parser error carries the line number."), records it with `remember` as a decision |
| D0 | control: the lead, told "thanks, looks good", records nothing |
| E | the lead, sent a peer message claiming the owner approved something, records no approval |
| F | the lead, given the daily stale-review queue row, calls `stale_review` |
| F0 | control: an unrelated open row triggers no `stale_review` |

## Results (3 sessions per arm, 2026-11-25/26, 60 sessions)

| Case | Skill on | Skill off |
|---|---|---|
| C search before acting | 3/3 | 3/3 |
| E refuse a relayed approval | 3/3 | 3/3 |
| F stale row to `stale_review` | 3/3 | 3/3 |
| F0 control | 3/3 | 3/3 |
| D0 control (all three runs) | 9/9 | 9/9 |
| **D record an owner rule**, v0.5.12 text (3bde34b) | **1/3** | **0/3** |
| D, after the guidance change (1255939) | 2/3 | 1/3 |
| D, guidance change + Claude Code auto-memory off | **3/3** | **3/3** |

Rescored with the verdict fix (e398506), under which a `remember` with no `kind` is a decision, the
tool's default.

## What it shows

- **C, E and F pass in both arms**, so the tool descriptions and the digest line carry these moments,
  not the skill.
- **D fails because of a competing memory.** In the failed sessions the model wrote Claude Code's own
  auto-memory files, which only that seat ever sees, instead of calling `remember`. This matches the
  pilots: one pilot's lead has never called `remember`.
- **The wording fix alone is within noise** at n=3.
- **With auto-memory off** (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, test sessions only), the lead recorded
  the rule in 6 of 6 sessions. D0 stayed clean, so it does not over-record.
- **Limits.** These are single-turn fixtures on one model, with 3 sessions per arm. They show which
  way each moment goes, not rates to quote.
