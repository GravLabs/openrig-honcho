# ADR-0016: Codex seats get the same memory

Status: accepted (2026-11-08, design.architect; owner: hook trust by the installer,
no third harness). Briefly marked withdrawn at 21:48Z; at 21:58Z the owner corrected
that they meant to drop Copilot, not Codex, so this design stands as accepted at
58b0685.

Original status: accepted (2026-11-08, design.architect; owner: hook trust by the
installer, no third harness), on the owner's request through
the advisor: "frontload Codex support into openrig-honcho, before the rest of the
planned work". It becomes v0.4. The v0.4 items already planned (outcome log,
lessons, checkpoints, trust classes) move to v0.5, and the rest follows one release
later. To be confirmed by the probe in decision 6 before anything is built.

## Context

- The plugin is a Claude Code plugin: hooks in `.claude/settings.local.json`, the
  `rig_memory` server in `.mcp.json`. A Codex seat reads neither.
- Codex 0.167.0 has hooks with almost the same shape. Its generated schemas
  (`codex-rs/hooks/schema/generated/` at tag `rust-v0.167.0`) give:
  - `SessionStart` with `source` startup, resume, clear, compact or fork, and
    `transcript_path`;
  - `UserPromptSubmit` with `prompt`, `turn_id` and `transcript_path`;
  - `Stop` with `last_assistant_message`;
  - `PreCompact` and `PostCompact`;
  - both `SessionStart` and `UserPromptSubmit` accept
    `hookSpecificOutput.additionalContext`, the same as Claude Code.
- Codex loads hooks per config layer, from `hooks.json` or `config.toml`, and runs
  a hook only when a `trusted_hash` for it is recorded under `[hooks.state]` in the
  user's `~/.codex/config.toml`. OpenRig's activity relay is installed there the
  same way.
- Codex reads MCP servers from `mcp_servers` in a config layer, and has plugins that
  can carry hooks and MCP servers together.
- Codex keeps its own local memory (`memories_1.sqlite`). It is separate from ours.

## Decisions

1. **One core, two thin harness adapters.** Everything that decides what to show or
   record stays shared: config, peer identity, sender rules, redaction, recall, the
   digest, the ledger, spool and logs. A small adapter per harness reads the hook
   input and writes the hook output. The Claude path does not change.
2. **Same identity and sender rules.** A Codex seat's peer is its OpenRig session
   name before the `@`, and a prompt's sender comes from rig's `From:` header, as
   today. The probe must show that a Codex seat sees the same OpenRig environment.
3. **Moments map one to one.**

   | Moment | Claude Code | Codex |
   |---|---|---|
   | Digest at startup, resume, clear, compaction | `SessionStart` | `SessionStart`, `fork` treated as `resume` |
   | Record a prompt, show recall | `UserPromptSubmit` | `UserPromptSubmit` |
   | Record the reply | `Stop`, reply read from the transcript | `Stop`, from `last_assistant_message` |
   | Tools | `.mcp.json` | `mcp_servers` |

4. **The install stays clean.** `install-project.ts --harness codex` writes the
   seat folder's project layer (hooks and the `rig_memory` server), copies the
   skill, and keeps the same install record and dated backups. Uninstall removes
   exactly what it added. It refuses to install a second copy of our hooks in any
   layer the seat loads, so nothing runs twice. Recording hook trust is decision 7.
5. **Honest limits.**
   - The novelty filter reads the seat's transcript. If the Codex transcript cannot
     be read reliably, recall falls back to dropping only items already shown in
     this session, and says so in the log.
   - Pilot rigs keep Claude seats until the owner approves a rollout.
6. **Probe first, on scratch only.** Before any build, a probe with a throwaway
   `CODEX_HOME` and a scratch workspace records each hook's real input, shows that
   `additionalContext` reaches the model, reads one transcript, runs `rig_memory`
   through `mcp_servers`, and checks which layers and trust records a hook needs.
   It writes nothing to `~/.codex`.
7. **Hook trust (owner, 2026-11-08: option 1).** Codex runs a hook only after its
   hash is trusted in the user's `~/.codex/config.toml`. The installer records trust
   for our own hooks only, keeps a backup of that file, and removes exactly those
   entries on uninstall. It never touches other entries, such as OpenRig's activity
   hooks. Rejected: approving the hooks by hand in Codex once per seat folder.
8. **A seam that makes a third harness cheap.** The owner may add a third harness,
   likely GitHub Copilot CLI. Each harness supplies exactly four things, and nothing
   else knows which harness is running:
   - **read:** turn its hook input into one shared event (moment, session, prompt or
     reply, transcript path, working folder);
   - **write:** turn the shared result (context to add, or nothing) into its hook
     output;
   - **install:** write and remove its hooks, its MCP entry, the skill and any trust
     record, with the shared install record and backups;
   - **transcript:** read the recent messages for the novelty filter, or report that
     it cannot.

   A harness that lacks a moment (for example, no way to add context to a prompt)
   says so, and the core skips that moment for it rather than faking it.

**Owner, 2026-11-08:** no third harness for now ("no copilot"). The seat stays,
because it costs little and keeps the core free of harness details.

## Probe results (C1, 2026-11-08)

Report: the C1 probe notes (kept outside the
repo), fixtures in `tests/fixtures/codex/`. What changes the design:

- **Output must name its event.** `hookSpecificOutput` without `hookEventName`
  fails silently. The Codex writer always sets it.
- **Context reaches the model.** A marker sent as `additionalContext` was repeated
  by the model.
- **Untrusted hooks.** Skipped silently in `codex exec`; an interactive seat stops
  at a trust prompt, which would block an unattended seat. So the installer must
  record trust before the seat starts (decision 7). Hook tables must use the
  PascalCase event names; snake_case tables are ignored.
- **Tools need an approval setting.** Under `approval_policy = "never"`, which
  unattended seats use, Codex refuses an MCP call unless the tool is approved. Our
  server entry sets `default_tools_approval_mode = "approve"` for `rig_memory`
  only. A per-tool approve on one tool left another tool refused in the same
  session, so this loosens nothing else.
- **Transcript.** `$CODEX_HOME/sessions/<date>/rollout-*.jsonl` holds the prompts and
  replies, so the novelty filter can read it.
- **Skills.** A project's skills live in `.agents/skills/`, not `.codex/skills/`.
- **A real Codex seat's environment (R0, 2026-11-08).** It has `OPENRIG_SESSION_NAME`,
  `OPENRIG_URL` and the other OpenRig variables, so identity and the daemon lookups
  work as for Claude. It has no `HONCHO_*` variables: Claude seats get them from
  `.claude/settings.local.json`, which Codex never reads. So the Codex install must
  hand our settings to the hooks and to the `rig_memory` server itself (C5).
  `apply_patch` edits land on disk.
- **Still open:** what PreCompact and PostCompact send (a short run never
  compacts), whether the trust hash we compute matches Codex's, and whether a
  project layer loads only in a trusted project.

## Decision 9: how a Codex seat gets its settings (2026-11-09)

A Codex seat has no `HONCHO_*` variables (R0). So the Codex install writes the
seat's settings to one file in a folder it owns,
`<seat folder>/.codex/openrig-honcho/settings.json`, mode 600, and every Codex hook
and the `rig_memory` server get its absolute path as `--settings <path>`, next to
`--harness codex`. The bins read that file and merge it under the process
environment: a variable set in the environment wins. The Claude path never passes
`--settings` and does not change.

Rejected: putting the values on each hook's command line (they would show in
process lists and in Codex's hook config), and finding the file from the working
folder (the server gets no hook input, and a guessed path can pick up the wrong
seat's settings).

## Decision 10: project trust stays with seat setup (2026-11-09)

C5c found that Codex loads a project's own config, including our hooks and the
`rig_memory` block, only when the project is trusted in the user config
(`[projects."<path>"] trust_level = "trusted"`, codex `config/src/loader/mod.rs`
around line 1128). Trusting a project enables all of its local config, hooks and
exec policies, which is wider than the owner's decision 7 (trust for our own hooks
only). So our installer does not grant project trust. It checks for it, and
install, dry run and `status` say plainly when it is missing. Project trust belongs
to seat setup, which the operator owns; the live Codex review seat already has it.
If the owner wants the installer to grant it, that is a new decision.

## Review of C2 (R1, b549019)

- Claude byte-identity proven by running both commits on 32 cases and diffing.
- F1: Codex replies need `turn_id` as the turn id, or a repeated reply on a later
  turn is dropped as a duplicate. Fixed in C2b.
- The Codex reply's time is the hook's clock, not a transcript time. Accepted.
- F2: the novelty filter reads no terms from a Codex rollout, so it filters nothing
  there. It fails safe. C4 fixes it.
- F3: a misspelled `--harness` falls back to Claude silently. C2b logs it.

## Live check (L1, 2026-11-09, Codex review seat, scratch workspace)

- Round 1 (relaunch 12:30Z): every hook fired on real Codex turns: the digest
  (`moment` continuity), prompts recorded with the sender check verified, recall,
  and Stop (12:56Z). The `rig_memory` server refused to start: Codex starts stdio MCP
  servers with only a fixed list of variables (HOME, PATH, USER and a few more) plus
  the entry's `env_vars` (codex `rmcp-client/src/utils.rs:16-25`, `:163`). Fixed in
  C5j by forwarding `OPENRIG_SESSION_NAME` and `OPENRIG_URL`; `status.ts` also learned
  `--settings`.
- Round 2 (relaunch 15:23Z, b57fbaf): the `status` tool answered on the seat
  (healthy, peer `dev-review`, server 3.5.0, 10 messages written, 0 failed), and
  the status CLI works with `--settings`.

## Build order

1. C2: the seam in the core, no behaviour change for Claude.
2. C3: the Codex read and write adapters, on the fixtures.
3. C4: the Codex transcript reader for the novelty filter.
4. C5: `install-project.ts --harness codex`, with trust, approval, skill, uninstall
   and the refusal against double hooks, proven against a throwaway `CODEX_HOME`.
5. Live check on the Codex review seat, then review attack, gate and v0.4.0.

## Tests

- Unit: the adapter on fixture inputs captured by the probe, for every moment.
- Installer: install, reinstall, uninstall, refusal cases, and no double hooks.
- Live: the Codex review seat, once the operator has moved it, as the test bed. It
  writes only to a scratch workspace until the owner says otherwise.
- Benchmark and scenarios: the same suite with a Codex seat, against the Claude
  results.

## Not doing

- Changing the rig layout; the operator owns it.
- Installing on the pilot rigs; that needs the owner's approval.
- Using or changing Codex's own local memory.
