# ADR-0022: v0.5.13 - record which model consumed memory, and whether what was shown was used

Status: accepted (2026-11-26, design.architect), on the owner's request ("yes, do both", after
the self-improving harness research pass; docs/STRATEGY.md, v0.6 R3 and R4).

## Context

The research pass (`~/review-scratch/openrig-honcho/research-rsi-2026-11/REPORT.md`) found two
things our evidence cannot show yet:

- **The model matters.** The same help can raise one model's score and lower another's (+31.1
  against -8.8 points, 2610.33024). A rig mixes models: the lead seats run on Claude, the build
  and review seats on a local model. The outcome log records neither.
- **Shown is not used.** Weak models often fail to act on help they are given (2605.30621). A
  skill offered on every turn was opened in 0.5% of runs (2610.14216). Our own T21 lead saved
  an owner rule to Claude Code's private memory instead of the ledger. The log counts what was
  shown, and for the claim pointer whether a search followed. It cannot say whether a decision,
  lesson or pointer entry was ever acted on.

The v0.6 gate needs both: R3 scores lessons per model, and R4 counts only used lessons as
evidence. The v0.6 hold waits for usage data, so the measurement ships first, on its own.

## Decision

1. **A model id on every hook log line that can know it.**
   - The hooks take the model id from the harness's hook input when it carries one. Otherwise
     the Stop hook takes it from the newest assistant entry of the transcript it already reads.
     A probe settles which fields Claude Code and Codex actually provide, before any code is
     written.
   - The value is checked: at most 100 characters of `[A-Za-z0-9._:/@-]`, otherwise dropped.
     No other text from the input or transcript is kept.
2. **The outcome record gains `models`.** It is the sorted list of distinct model ids on the
   destination seat's hook lines inside the row's window. Absent on records built before
   v0.5.13, and empty when no line carried one.
   - **Window (amended 2026-11-26 at B9):** the same window `memoryWindow` uses for the row's
     memory counts: from claim, or from creation when that is earlier, to close. `models` then
     names the models behind exactly the lines those counts come from.
   - **Probe result:** Codex carries `model` on all three hook inputs, and it is the configured
     id. Claude carries none, so its id comes from the Stop hook's transcript read.
3. **Shown ids, then used ids, per session.**
   - Each injection logs the ids of the entries it showed: decision and approval ids in the
     digest and the pointer, lesson ids, pointer qitem ids, and recall conclusion ids where
     they have one. Ids only, as the log already holds pointers and counts and never content.
   - The Stop hook compares the turn's assistant text and tool-call inputs with the ids shown
     earlier in the same session, and logs the ones that appear as `used`. An id is used when
     it is cited, passed to a `rig_memory` tool (`supersedes`, `retire`, a search on it) or
     named in a queue command.
   - No model judges use. The scan is a plain id match on text the hook already reads.
   - **Amended 2026-11-26 after review R27:**
     - **Two counts.** An id in the assistant's text is **cited**. An id in a tool-call input
       (a `rig_memory` argument or a queue command) is **acted**. Only acted counts as use in v0.6
       evidence, because a cite can be a plain echo of the injected text. Codex hooks see only the
       final message, so Codex has cited counts only.
     - **Matching rules.** An id matches only at token boundaries, with no `[A-Za-z0-9_-]` on
       either side. Conclusion ids shorter than 8 characters, or made only of letters, are never
       scanned.
     - **No self-credit.** The id of the row the seat holds is never recorded as shown.
     - **Codex has no acted count.** Codex's Stop hook sees no tool calls, so its acted count
       is unmeasured rather than zero. The report says so. Its "costs context, no evidence"
       list counts entries never cited and never acted on, so Codex entries do not appear there
       forever. v0.6 evidence uses acted wherever the harness shows tool calls, and cited,
       labelled as such, for Codex. Reading tool calls from Codex's session log is a v0.6
       item.
     - **"Unknown" model family** means the line has no valid model id: either it never carried
       one, or the id failed the check.
4. **The memory report shows shown against used**, by kind of entry and by model family. It
   also lists, for the owner, entries shown at least five times and never used ("costs
   context, no evidence"). Counts and ids only; the report's privacy rules are unchanged.
5. **Nothing a seat sees changes.**
   - No cap changes and no new block.
   - No change to what is recorded in Honcho.
   - The Stop hook keeps its time budget. The id scan is in-process and does no network call.
   The size cap on injected memory in R4 waits for v0.6.

## Consequences

- The usage report the v0.6 hold waits for can say which models consumed memory and whether it
  was acted on, per pilot.
- The test bed records the same fields, so its arms can be compared by model too.
- Pilot installs and the GitHub export need the owner's approval at release, as usual.

## Not doing

- Any scoring, gating, retiring or ranking based on these counts (v0.6).
- A model call to decide whether something was used.
- Per-model routing or seat changes.
