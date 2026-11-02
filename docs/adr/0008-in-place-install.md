# ADR-0008: Installing into seats that already exist

Status: accepted (2026-10-29, design.architect), from the pilot handoff
(operator-agent@kernel, qitem-20261029182802-42d71e7c64b7c30f).

## Context

v0.1.0's README said a restore (`rig down`, `rig up --existing`) or
`rig seat launch` gives a seat new `env:` and `plugin_dirs`. On OpenRig 0.7.2
that is false. A seat's env is read from its node row and its plugin dirs from
its seat storage, and both are written only when the rig is created from the
spec. A restore or resume reads them back unchanged. No CLI verb changes them,
and editing the OpenRig database or seat storage is not a supported route. The
only spec routes start fresh conversations, and the owner wants the pilot
seats to keep theirs.

Claude Code itself reads project configuration from the seat's working
directory on every start, resume included:

- `.claude/settings.local.json`: `hooks`, `env`, `enabledMcpjsonServers`;
- `.mcp.json`: `mcpServers`;
- `.claude/skills/<name>/SKILL.md`.

OpenRig 0.7.2 merges its own fragments into the first two and removes only its
own hook entries (exact command shape), leaving other entries in place
(`claude-code-adapter.js`, `mergeJsonFragment`, `reconcileClaudeActivityHooks`).
In pilot, `.claude/` and `.mcp.json` are excluded from git. The plugin code
never uses `CLAUDE_PLUGIN_ROOT`; only `hooks.json` and `mcp-servers.json` do.

All seats of a rig may share one working directory (pilot: all three run in
`/home/user/work/pilot`), so project files cannot hold per-seat values.

## Decision

1. **A project install.** `bin/install-project.ts <project dir>` (in the plugin,
   run with Bun) writes, idempotently:
   - in `.claude/settings.local.json`: the three hooks of `hooks.json` with the
     plugin's absolute path in place of `${CLAUDE_PLUGIN_ROOT}`; the rig-level
     `HONCHO_*` settings under `env`; `rig_memory` added to
     `enabledMcpjsonServers`, so Claude Code does not ask to approve it;
   - in `.mcp.json`: `mcpServers.rig_memory` with the absolute path;
   - `.claude/skills/rig-memory/SKILL.md`, copied.
   It keeps every other key and entry, writes a dated `.bak-openrig-honcho-*`
   copy of each file it changes, and refuses (exit 1, nothing written) when a
   target is not a JSON object. `--uninstall` removes exactly its own entries:
   hooks and the MCP server whose command names that plugin path, the
   `HONCHO_*` keys it wrote, its `enabledMcpjsonServers` entry and the skill
   folder. `--dry-run` prints the changes and writes nothing.
   The rig-level settings are flags: `--url`, `--workspace`, `--leader`,
   `--profile-workspace`, `--owner-peer`; none takes a key value.

   A target settings file can hold secrets and owner rules (pilot: an env
   block with a model-routing auth token, `permissions.deny`, other hooks).
   So the install merges only: it adds its own entries, never replaces,
   reorders or deletes anything else, and never writes an env key outside
   `HONCHO_*`. It never prints, logs or copies an env value, and its output and
   errors (dry-run included) name keys and hook events only. If `rig_memory`
   is in `disabledMcpjsonServers` it refuses: that is the owner's choice.
   Backups are mode 0600; writes are atomic (temp file and rename) and keep
   `settings.local.json` at 0600.
2. **Per-seat values need no per-seat file.**
   - `HONCHO_PEER` unset: use `OPENRIG_SESSION_NAME` up to the first `@`, if it
     matches the id rule. Neither set: disabled, as today. A plain `claude`
     started by a person in the same directory has no session name, so the
     plugin stays off there.
   - `HONCHO_OBSERVE_OTHERS` unset: true exactly when `HONCHO_LEADER_PEER` is
     set and equals the peer. An explicit value still wins.
   Both are additive: every setting valid under v0.1.0 means the same thing.
3. **Picking it up.** The seats are relaunched by resume (`rig down <rig>`, then
   `rig up <rig> --existing`), which keeps their conversations; Claude Code
   reads the project files at that start. A seat that is never relaunched keeps
   running without memory, and nothing breaks.
4. **Proof before handoff.** A scratch OpenRig rig with one Claude seat in a
   scratch directory, created without the plugin, gets the project install,
   is resumed, and must show: the same conversation id, `rig_memory` `status`
   healthy, and messages in a `honcho-bridge-scratch-*` workspace. Rig, folder
   and workspace are removed afterwards.
5. `plugin_dirs` plus `env:` stays the route for a rig created from its spec.
   The README offers both and corrects step 3. This ships as v0.1.1 through
   the full gate and release sequence of ADR-0007.

## Consequences

- Project files are shared by every Claude session in that directory, OpenRig
  or not. The session-name rule keeps non-seat sessions off; `--uninstall`
  reverses the install.
- If a future OpenRig rewrites these files wholesale, the install is lost on
  the next launch and the seats run without memory; `status` shows it. The
  install can be re-run.

## Amendment 2026-10-30 (v0.1.2): install record and backup folder

Found in the pilot: uninstall removed the five `HONCHO_*` keys and the
`rig_memory` entry of `enabledMcpjsonServers` by name, even ones the owner had
before the install, and the `.mcp.json` backup landed untracked in the repo
root.

1. **One folder of ours:** `<dir>/.claude/openrig-honcho/` holds the install
   record `install.json` (mode 0600), `backups/` (each backup
   `<file name>.<UTC stamp>`, mode 0600), and a `.gitignore` containing `*`,
   so nothing in it is ever offered to git. Nothing is written to the project
   root any more.
2. **The record holds names only, never values:**
   `{"version": 1, "plugin": "<PLUGIN_DIR>", "envAdded": [names],
   "enabledAdded": true|false}`. `envAdded` lists the flag-name keys this
   install created (absent before); `enabledAdded` says whether it appended
   `rig_memory` to `enabledMcpjsonServers`. It is written in the same staged
   apply as the other files and kept across re-runs (a re-run adds names, never
   drops them).
3. **A key that was already there is not ours.** If a flag-name key exists, is
   not in the record and has a different value, install refuses and writes
   nothing (it never overwrites a value it did not set). Same value: left
   alone, not recorded. A key in the record may be changed by a re-run.
4. **Uninstall removes only what the record lists**, plus the hook groups, the
   server and the skill folder that name this plugin path (as before). It then
   removes `install.json`; `backups/` and `.gitignore` stay. Output says which
   recorded names it removed and which `HONCHO_*` names it left.
5. **No record, but hooks or server name this plugin path** (an install by
   v0.1.1): our names present count as added, as v0.1.1 did, and the output
   says so. Install over it writes a record on that basis.
6. A record that is unreadable, not the shape above, names another plugin path,
   or is a symlink: refuse, nothing written, on install and uninstall.

Rulings 2026-10-30 (review questions before T13b landed):
- Rule 5 comes before rule 3. With no record and an install proven from this
  plugin path, our names present are ours, so a re-install may change their
  values and records them. Rule 3 applies when a record exists, or when
  nothing names this plugin path (a first install).
- `envAdded` may contain only the five flag names, without duplicates; any
  other name makes the record the wrong shape (rule 6).
- Staged apply renames `install.json` before `settings.local.json`, so a crash
  in between leaves a record of names not yet written (harmless: absent keys
  are skipped on uninstall) rather than settings without a record (which
  would fall back to rule 5 and could remove an owner's key).
- A valid record naming this plugin path is itself proof of an install, so
  uninstall proceeds even if the hooks and server entry were removed by hand.
- A re-run without a flag (e.g. no `--leader`) leaves that key and its record
  entry as they are. Names are removed only by uninstall.
