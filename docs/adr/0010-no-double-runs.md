# ADR-0010: A seat never runs our hooks twice

Status: accepted (2026-10-31, design.architect), from operator-agent@kernel's pilot report 17:57Z

## Context

Claude Code applies a parent folder's `.claude/settings.local.json` to a session
whose working directory is a subfolder. Pilot moved its Qwen seats into
`pilot/pods/`, and a second `install-project.ts` run there added our hooks a
second time. The two copies have different paths (`pilot/.claude/plugins/...`
and `pilot/pods/.claude/plugins/...`), so Claude Code ran both. At 17:52:22Z
dev-build injected the session-start block twice, ran recall twice and stored one
prompt twice in Honcho. The operator removed the hooks from the pods install.
`.mcp.json` is not inherited, so the pods install's MCP server, env and skill
are still needed there.

Nothing stops this recurring: a later install in a subfolder, or in the parent
after a subfolder, doubles everything again.

## Decisions

1. **Installer guard.** Before adding hooks, `install-project.ts` looks in every
   ancestor of the target directory, up to the filesystem root, for
   `.claude/settings.local.json` and `.claude/settings.json`. If either holds a
   hook command that runs one of our bins (`bin/session-start.ts`,
   `bin/recall.ts`, `bin/user-prompt.ts`, `bin/stop.ts` under a folder named
   `openrig-honcho`), it installs everything except the hooks and says so:
   `hooks: skipped, <ancestor path> already runs them for this folder`. The
   record notes `hooksSkipped: <ancestor path>`, and uninstall then removes no
   hooks. A re-run that finds our hooks both here and in an ancestor removes
   them here (the same in-place logic as T14b), never in the ancestor.
   Reading an ancestor file is read-only; an unreadable or invalid one is
   ignored for this check.
2. **Runtime guard (the real safety net).** Each hook bin, right after reading
   stdin, takes a once-marker: `<state>/<workspace>/once/<sha256(hook name +
   raw stdin)>`, created exclusively. Two copies of one hook for one event get
   byte-identical stdin, so the second finds the marker. If it exists and is
   under 5 seconds old, the bin exits 0 with no output and logs
   `{event: "duplicate-run", ok: true}`. An older marker is taken over, so a
   genuinely repeated prompt seconds later still runs: the copy that creates
   `<marker>.gen-<its mtime>` exclusively wins and refreshes the marker; the
   marker itself is never removed, so no third copy can slip in (amended in
   T15c after review's race findings). Markers older than an
   hour are pruned opportunistically (at most once a minute). Any error in the
   guard means run normally: the guard can drop a duplicate, never a real event.
3. **README note.** Install once per project tree: in the folder whose
   `.claude/` Claude Code reads for every seat, and in a subfolder only for
   `.mcp.json` and the skill. The installer handles that case itself (decision 1).

## Not doing

- Deleting the two duplicate messages in pilot: our hard limit forbids writes
  there, and two copies of one prompt are harmless.
- Changing OpenRig's own activity relay, which may double-run the same way in a
  rig laid out with `pods/`. That is OpenRig's to fix; we report it.

## How we'll know

- Unit: an ancestor with our hooks makes the installer skip hooks and record it;
  uninstall leaves the ancestor untouched; two concurrent spawns of each bin
  with the same stdin produce one effect (one stdout block, one write to a fake
  server), repeated at least 7 times; a marker older than 5 s does not suppress.
- The gate, then v0.2.1. On pilot afterwards: no `duplicate-run` events while
  only one install has hooks, and none of the double effects.

## Consequences

Each hook run adds one small file write. Inside the 5 s window an identical
event is dropped: for a prompt that means the same text in the same session twice
within 5 seconds, which a person or seat does not do on purpose.
