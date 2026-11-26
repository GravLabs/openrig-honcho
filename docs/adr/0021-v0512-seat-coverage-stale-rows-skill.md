# ADR-0021: v0.5.12 - every seat covered, stale review as a queue row, a skill that says when

Status: accepted (2026-11-25, design.architect), on the owner's request.

## Context

The owner asked: "are there any improvement we can make to the skill / tools available to the
plugin?" Fourteen days of hook and tool logs across the three pilots (2026-11-11 to 11-25) gave
these findings:

- **One seat is not covered at all.** The build seat of pilot C works in `pods/` under the rig root. Its settings
  there have no openrig-honcho hooks, so it has never logged a hook run: nothing it says is
  recorded and it is never shown memory, though it has the `rig_memory` tools.
  - **Why.** The installer skips hooks in a folder whose ancestor already runs them (ADR-0010
    decision 1, no double runs). That assumes Claude Code applies an ancestor's settings to a
    subfolder.
  - **Probe (2026-11-25).** A root folder with a `UserPromptSubmit` hook and a `pods/` subfolder;
    `claude -p` run from `pods/`. The root hook fired only when the root was a git repository.
    pilot C's root is not one; pilots A and B are, which is why their `pods/` seats work.
  - **`status` cannot see it.** It checks the server and the config, not the hooks.
- **Stale proposals sit unreviewed.** `stale_review` has never been called on any pilot, while
  pilot A has 20 pending stale proposals. The digest line that names the tool is not acted on.
  Work in these rigs moves through queue rows.
- **Leads rarely record decisions, and seats rarely look things up.**
  - `remember`: pilot C's lead has made 0 calls (its ledger is empty), pilot B's 19 in 14
    days, pilot A's 168.
  - `search`: 88 calls against 4,620 prompts on pilot A, 6 against 482 on pilot B, 1 against
    161 on pilot C.
  - The skill is 1,361 words, and its description lists every tool rather than saying when to
    reach for one.
- **`mission` and `ask` are rarely used.** Every session on all three pilots ran in the "general"
  mission, and `ask` was called 3 times. The owner kept both and asked for their purpose to be
  explained.

The owner chose items 1, 2 and 3+4 of the proposal. This is the "do now" set; the rest stays
under the v0.6 hold.

## Decision

1. **The installer's ancestor rule follows Claude Code's real one.**
   - An ancestor's hooks count as covering a folder only when the folder and the ancestor are in
     the same git working tree.
   - A working tree is the nearest folder at or above the install folder that holds a `.git`
     entry (directory or file). The ancestor must sit at or below it.
   - It is found by walking up the filesystem, with no subprocess.
   - Outside any working tree, no ancestor covers the folder, so the installer writes the hooks
     into it.
   - The existing no-double-run behaviour inside one repository is unchanged.
2. **`status` reports whether the hooks run for this seat.**
   - **Claude seats:** whether our hooks are found in the settings that apply to the current
     folder: its own `.claude/settings.local.json` and `settings.json`, the user's
     `~/.claude/settings.json`, and an ancestor's under rule 1.
   - **Codex seats:** whether they are in the `hooks.json` beside the seat's `--settings` file.
   - Missing hooks make the seat unhealthy, with the line "hooks: missing - this seat records
     nothing and is shown no memory; run the install in <folder>".
   - A relative `--settings` path is resolved against the current folder. Today it reports the
     seat as disabled.
3. **The daily stale check can post a queue row to the lead.**
   - `stale-check.ts --notify <session>` posts one row to that session when stale proposals are
     pending that no earlier row named. The session is validated as `<seat>@<rig>`.
   - The row holds counts, entry ids and ages only, no memory text. It asks the lead to run
     `stale_review` and keep or retire each entry. It is tagged
     `openrig-honcho,stale-review` and has a `--summary`.
   - The ids already named are kept in the stale file, capped like `kept`, so the next day does
     not post the same row again.
   - A failure to post never fails the stale check: the counts still print and the exit code is
     unchanged.
4. **ADR-0006 X5 amended for a second `rig` verb.**
   - The one `execFile` call site stays in `plugin/src/nudge.ts`. It becomes a small runner with a
     fixed allowlist of two argv shapes:
     - `["queue","show",<validated id>,"--json"]`;
     - `["queue","create","--destination",<validated session>,"--source","stale-check@<rig of the destination>","--summary",<text>,"--body-file",<path>,"--tags","openrig-honcho,stale-review","--json"]`.
     The stale check runs from the operator's timer, outside any seat, where `rig queue
     create` refuses without `--source` (probed 2026-11-25).
   - The body file is written 0600 in the state folder and removed after the call. No shell. 3 s
     timeout for `show`, 10 s for `create`.
   - The scan pins both shapes and refuses any other `rig` verb in `plugin/`.
5. **The skill says when, and leads get guidance on recording.** `skills/rig-memory/SKILL.md` is
   rewritten to about 1,000 words (from 1,361; the contract test caps it at 1,100), opening with when to reach for memory:
   - **search before:** claiming a queue row, deciding something that may have been discussed,
     and answering "what did we decide / why"; also right after a compaction or restart.
   - **one good query example.**
   - **for the lead seat, when to `remember`:** an owner decision, a convention the team must
     follow, an approval on the owner's word, and a release or branch status. Each comes with a
     short example, and with what does not belong (progress notes, one-off chat).
   - **`ask` explained:** for "why" questions that need reasoning across sessions, slow, used
     after `search`.
   - **`mission` explained:** separate memory per OpenRig mission, set by `mission:<id>` tags;
     most rigs stay in "general", which is fine.

   The tool descriptions in `mcp.ts` carry the same "use it when" first line, since models read
   them before the skill.

6. **The installer turns Claude Code's own auto-memory off in every folder it installs in**
   (owner 2026-11-26, "Every rig seat", after the T21 run; numbers in
   `docs/tool-choice-eval-2026-11.md`).
   - **Why:** told an owner rule, the lead wrote Claude Code's private auto-memory files instead
     of calling `remember`. The lead recorded it in 1 of 3 sessions with the skill and 0 of 3
     without. With auto-memory off it recorded it 6 of 6, and the chit-chat control stayed clean.
   - **What:** the installer writes `"autoMemoryEnabled": false` into the folder's
     `.claude/settings.local.json`. It records that it did, so uninstall removes only that key,
     with the usual backup. It does this in every install folder, including hook-skipped
     subfolders.
   - **What a seat loses:** it stops loading its private memory notes. Their files stay on disk.
   - **Status:** `status` reports whether auto-memory is off.
   - **Codex:** follows only if a probe shows Codex has an equivalent memory feature that is on
     by default.

## Consequences

- Pilot C's build seat gets memory after a reinstall of its `pods/` folder. That fixes the approved
  v0.5.11 install, so no new owner approval is needed for that folder.
- Stale proposals reach the lead as normal work, and the operator's timer gains `--notify` per
  pilot.
- The skill change is measurable: search and remember rates per prompt on the pilots, and the
  test bed's pass rate.
- The owner approves pilot installs and the GitHub export at release, as usual.

## Not doing

- Removing `mission` or `ask` (the owner kept them).
- New ledger kinds for a trading pilot (positions, theses, risk limits): v0.6 list.
- Any change to what is recorded or to the hooks' timing budgets.
