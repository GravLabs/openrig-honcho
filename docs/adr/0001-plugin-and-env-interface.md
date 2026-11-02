# ADR-0001: The plugin, its env interface and its failure behaviour

Status: accepted (2026-10-27, design.architect)

## Context

OpenRig attaches a Claude Code plugin to a seat through the rig spec member's
`plugin_dirs:`; the folder is copied into the seat's storage and loaded through
`CLAUDE_CODE_PLUGIN_DIRS`. The seat's `env:` is set on every launch, restore and
handover; a managed Claude launch (`env -i`) forwards only declared names. So
everything the plugin needs must be a declared env name, and the plugin folder
must work as copied: no `npm install` step at the destination.

`claude-honcho` (read in `reference/`) uses `@honcho-ai/sdk`,
`@modelcontextprotocol/sdk` and a shared `~/.honcho/config.json`; that file is
what makes per-seat workspaces impossible (BRIEF).

## Decision

**Runtime and language.** TypeScript run directly by Bun (`bun run`, Bun 1.4.2 is
on every seat's PATH). **Zero runtime dependencies**: Honcho is called with
`fetch` against the v3 REST API (schema: `http://localhost:8000/openapi.json`,
server v3.4.0); the MCP server is a small hand-written stdio JSON-RPC loop
(`initialize`, `tools/list`, `tools/call`). Tests use `bun test`.

**Layout** (dependency direction: edges call the core, never the reverse):

```
plugin/
  .claude-plugin/plugin.json      name "openrig-honcho", mcpServers, skills
  hooks/hooks.json                SessionStart, UserPromptSubmit, Stop
  bin/session-start.ts            edge: hook stdin -> core -> stdout JSON
  bin/user-prompt.ts              edge (async hook)
  bin/stop.ts                     edge (async hook)
  bin/mcp.ts                      edge: MCP stdio server "rig_memory"
  src/env.ts                      the env contract below -> Config | null
  src/honcho.ts                   edge: fetch client, every call time-boxed
  src/envelope.ts                 core: parse rig From/To/Sent header (ADR-0003)
  src/attribute.ts                core: prompt -> {peer, content, kind} (ADR-0003)
  src/redact.ts                   core: redaction (ADR-0003)
  src/missions.ts                 core: state files, session naming (ADR-0002)
  src/inject.ts                   core: render session-start context (ADR-0004)
  src/log.ts                      local append-only log, never stdout
  skills/rig-memory/SKILL.md
```

Core modules take plain values and return plain values; they never read env,
stdin, files or network themselves, so they are unit-tested without a server.

**Env contract** (the only configuration; the plugin keeps no config file):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `HONCHO_ENABLED` | no | `true` | `false` (case-insensitive, also `0`/`no`/`off`): every hook exits 0 with no output and no network call; the MCP server lists no tools. |
| `HONCHO_URL` | yes | — | Base including `/v3`, e.g. `http://localhost:8000/v3`. A host matching `*.honcho.dev` or `api.honcho.dev` is refused (plugin disables itself and logs why). |
| `HONCHO_WORKSPACE` | yes | — | The rig's workspace. |
| `HONCHO_PEER` | yes | — | This seat's peer id (ADR-0003 naming). |
| `HONCHO_OBSERVE_OTHERS` | no | `false` | `true` marks the rig leader: observes others, gets the rig digest, may `remember`. |
| `HONCHO_OWNER_PEER` | no | `owner` | The owner's peer id (the human who owns the rig). |
| `HONCHO_LEADER_PEER` | no | unset | The rig leader's peer id, so other seats can read its decisions (ADR-0005 E8). |
| `HONCHO_PROFILE_WORKSPACE` | no | unset | Cross-rig owner profile workspace. Unset: no profile writes or reads. |
| `HONCHO_RECORD_AUTOMATION` | no | `false` | `true`: record OpenRig automation as peer `openrig`. |
| `HONCHO_API_KEY` | no | `local` | Sent as bearer; auth is off on this server, any non-empty value works. Never logged. |
| `HONCHO_STATE_DIR` | no | `$HOME/.openrig-honcho` | Where mission and seat state live (ADR-0002). |
| `HONCHO_TIMEOUT_MS` | no | `3000` | Per-request timeout for writer calls. An integer 1..60000; anything else disables (no clamping). |

Missing a required variable, or an invalid value (a non-positive-integer
`HONCHO_TIMEOUT_MS`, no `HONCHO_STATE_DIR` and no `HOME`) = disabled, one log
line naming the variable, exit 0. No silent fallback to a default.

`HONCHO_URL` must parse as a URL with scheme `http` or `https`. The cloud-host
check lowercases the host and strips one trailing dot before comparing (an FQDN
`api.honcho.dev.` is the same host).

Where the disabled line goes (review T1 F2):
- **Kill switch** (`HONCHO_ENABLED` off): nothing is logged and no file is
  touched. Off means off.
- **Invalid or missing config**: one line to
  `<base>/log/_config.log`, where `<base>` is `HONCHO_STATE_DIR` if it is a valid
  absolute path, else `$HOME/.openrig-honcho`, else nowhere. The line has `ts`,
  `hook`, `reason` (variable name and rule, never a value). At most one line per
  distinct reason per hour (checked against the last line), so a misconfigured
  seat doesn't grow the file every turn. `status` reports the same reason.
Ids must match `^[A-Za-z0-9_-]{1,100}$` (to be confirmed against the server in task
T1); an invalid id also disables.

**Hooks and their I/O.**

| Event | Mode | Reads | Writes | Budget |
|---|---|---|---|---|
| `SessionStart` (all sources: startup, resume, clear, compact) | sync | stdin `{session_id, transcript_path, cwd, source}` | stdout `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` or nothing | 4 s total wall time, hook `timeout: 8` |
| `UserPromptSubmit` | `async: true` | stdin `{prompt, session_id, ...}` | nothing on stdout | hook `timeout: 30` |
| `Stop` | `async: true` | stdin `{session_id, transcript_path, last_assistant_message, stop_hook_active}` | nothing on stdout | hook `timeout: 30` |

No `PreToolUse`/`PostToolUse` hooks: tool calls are not recorded. No per-turn reads.

**Failure behaviour: degrade to nothing, never block a turn.** Every Honcho call
has a timeout. Every hook catches everything, logs one line to
`$HONCHO_STATE_DIR/log/<workspace>.log`, and exits 0. Nothing but the
SessionStart JSON ever goes to stdout; nothing goes to stderr in normal
operation. A failed write is dropped and logged (no retry spool in v0.1).

## Consequences

- The plugin folder is copied as is and runs; `rig bundle` carries it unchanged.
- We own a small HTTP client and MCP loop instead of tracking two SDKs. If the
  server API moves, `src/honcho.ts` is the one place to change.
- Writes lost while Honcho is down are lost. Acceptable for v0.1 because memory
  is derived and lagging anyway (deriver batches take minutes); revisit if the
  pilot shows meaningful loss.

## Rejected

- **Use `@honcho-ai/sdk` + `@modelcontextprotocol/sdk`.** Needs `node_modules` in
  the copied folder or an install step at every seat, and the SDK's lazy
  get-or-create hops add latency we would have to work around (claude-honcho
  already does, with `noEnsure` stubs).
- **A config file per seat.** OpenRig already delivers env on every launch,
  restore and handover; a second source of truth is how claude-honcho lost
  per-seat configuration.
