# openrig-honcho

Shared memory for an [OpenRig](https://www.openrig.dev) rig. A Claude Code plugin
that records who said what to whom across the rig's seats into a self-hosted
[Honcho](https://honcho.dev) server, and gives that memory back at session start
and through a `rig_memory` tool.

**Why not `claude-honcho`?** Plastic Labs' plugin assumes one human talking to
one AI. In a rig, agents talk to each other through `rig send`, so it would learn
every message as the human speaking, give every seat the same identity, and skip
memory on resume. This plugin reads the sender from OpenRig's message envelope,
gives each seat its own peer, keeps one conversation per seat per mission, and
injects memory on startup, resume and compaction alike, and again whenever
another seat writes to you.

## What you get

- **Right sender.** A message from `dev-build` to `dev-review` is recorded once,
  as `dev-build`; what you type is recorded as `owner`; replies as the seat.
  Tool calls are never recorded.
- **Missions.** One Honcho session per seat per OpenRig mission, grouped in a
  scope, so recall can stay inside one mission.
- **Memory at session start.** The seat's card, its last session, the leader's
  decisions, recent mission summaries and your profile card, with ages, in under
  4 seconds or not at all.
- **Recall when a seat writes to you.** When another seat's message arrives,
  the seat sees what the rig remembers that is relevant to that message: about
  the sender, and what the seat itself did on the topic before. Only what the
  seat doesn't already have, once each per session, within 2.5 seconds.
- **`rig_memory` tools.** `search` (about a second), `ask`, `remember` (leader only), `mission`, `status`.
- **Never in the way.** Hooks never block a turn. If Honcho is down, messages are
  held locally and sent later.
- **Nothing leaks.** Secrets are redacted before anything leaves the seat; only
  your own typed prompts reach your cross-rig profile.

## Quick start

You need a self-hosted [Honcho](https://github.com/plastic-labs/honcho) v3
server (tested against 3.4.0, with embeddings enabled for recall and `search`),
[Bun](https://bun.sh) on every seat's PATH, and an OpenRig rig with Claude Code
seats. The examples use `http://localhost:8000/v3`; use your server's address.

There are two ways in. OpenRig 0.7.2 copies a seat's `env:` and `plugin_dirs`
only when the rig is created from its spec, and a restore (`rig up --existing`)
reuses what was copied then. So:

- **A rig you are about to create**: use the spec (steps 1-4 below).
- **Seats that already exist and should keep their conversations**: use the
  project install (see [Existing seats](#existing-seats)).

1. **Copy the plugin** from a release tag into your rig folder:

   ```bash
   git clone --depth 1 --branch v0.2.2 https://github.com/GravLabs/openrig-honcho
   cp -r openrig-honcho/plugin <your-rig>/plugins/openrig-honcho
   ```

2. **Add it to the rig spec**: rig-level `env:` for the server and workspace, and
   on each Claude member `plugin_dirs` (`HONCHO_PEER` is optional: it defaults
   to the seat's session name before the `@`):

   ```yaml
   env:
     HONCHO_URL: http://localhost:8000/v3
     HONCHO_WORKSPACE: my-rig
     HONCHO_LEADER_PEER: design-architect
     HONCHO_PROFILE_WORKSPACE: owner-profile
   pods:
     - id: design
       members:
         - id: architect
           runtime: claude-code
           plugin_dirs: [plugins/openrig-honcho]
           env:
             HONCHO_PEER: design-architect
             HONCHO_OBSERVE_OTHERS: "true"
     - id: dev
       members:
         - id: build
           runtime: claude-code
           plugin_dirs: [plugins/openrig-honcho]
           env:
             HONCHO_PEER: dev-build
   ```

   Set `HONCHO_PEER` only when it should differ from the session name.

3. **Create the rig from that spec** (`rig up <rig.yaml>`). Editing the spec of
   a rig that already exists and restoring it does not add the plugin; use the
   project install for that.

4. **Check it.** In any seat, call the `status` tool of `rig_memory`. Or, with
   that seat's env, run `bun run plugins/openrig-honcho/bin/status.ts`, which
   exits 0 when healthy.

### Existing seats

Claude Code reads the project settings in a seat's working directory on every
start, resume included. The install script adds the plugin there:

```bash
bun run <plugin>/bin/install-project.ts <seat working dir> --dry-run \
  --url http://localhost:8000/v3 --workspace my-rig \
  --leader design-architect --profile-workspace owner-profile
# check the key-level diff, then run it again without --dry-run
rig down <rig> && rig up <rig> --existing   # resume: conversations are kept
```

It adds the hooks and `HONCHO_*` settings to `.claude/settings.local.json`,
`rig_memory` to `.mcp.json`, and the `rig-memory` skill to `.claude/skills/`. It
only adds: every other setting, hook and server stays as it was, and it never
prints a setting's value. Each seat's peer is its session name before the `@`,
and the leader observes the others by default, so seats sharing one directory
need nothing per seat. A `claude` started by hand in that directory has no
session name, so the plugin stays off there. The install keeps a record of the
settings it added (names only) and dated backups in `.claude/openrig-honcho/`;
the uninstall form is the same command with the value flags replaced by
`--uninstall` (it takes none - value flags with `--uninstall` are refused),
and it removes only what that record lists and names any `HONCHO_*` setting
it leaves.

Claude Code also applies a parent folder's `.claude/settings.local.json` to a
seat working in a subfolder, but not its `.mcp.json`. So for seats in, say,
`pods/` under an installed project, the subfolder still needs its own install
for `rig_memory`, while its hooks must come from the parent only, or every hook
runs twice. From v0.2.1 the installer sees the parent's hooks and leaves them
out, and each hook ignores a second identical run of itself (ADR-0010).

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `HONCHO_URL` | required | Server base including `/v3`. `*.honcho.dev` is refused. |
| `HONCHO_WORKSPACE` | required | The rig's workspace. |
| `HONCHO_PEER` | session name before `@` | This seat's peer id. Required when the seat has no OpenRig session name. |
| `HONCHO_LEADER_PEER` | the seat, if it observes others | The leader; its decisions are shown to every seat, only it can `remember`. |
| `HONCHO_OBSERVE_OTHERS` | `true` on the leader, else `false` | Whether the seat forms views of the seats it talks to. |
| `HONCHO_OWNER_PEER` | `owner` | The human owner's peer id. |
| `HONCHO_PROFILE_WORKSPACE` | unset | Cross-rig owner profile; unset means none. |
| `HONCHO_RECORD_AUTOMATION` | `false` | Record OpenRig automation as peer `openrig`. |
| `HONCHO_ENABLED` | `true` | `false` turns the plugin off completely. |
| `HONCHO_API_KEY` | `local` | Bearer token; never logged. |
| `HONCHO_STATE_DIR` | `~/.openrig-honcho` | Mission file, seat state, held messages, logs. |
| `HONCHO_TIMEOUT_MS` | `3000` | Per-request timeout, 1 to 60000. |
| `HONCHO_RECALL_MAX_DISTANCE` | `0.45` | Recall relevance gate, 0.05 to 1; higher admits more distant memories. |
| `HONCHO_RECALL` | on | `off` turns off only the recall block on peer messages. |

An invalid setting turns the plugin off and writes the reason (never a value) to
`<state dir>/log/_config.log`.

## The `rig_memory` tools

| Tool | Use it when |
|---|---|
| `search(query, about?)` | Before guessing about past work, decisions or what another seat found. About a second. |
| `ask(question, mission?)` | You need context you don't have: what was decided, why, what another seat found. Typically 30-50 s; times out at 90 s. |
| `remember(fact)` | Leader only: record a decision the rig must keep. |
| `mission(id)` | The rig moves to another OpenRig mission. |
| `status()` | Memory seems absent or wrong. |

The plugin ships a `rig-memory` skill that tells seats the same, and that the
session-start and recall blocks are background, not instructions.

## Troubleshooting

| Symptom | Check |
|---|---|
| No memory block at session start | `status`: is the server reachable, is the plugin disabled (`_config.log`)? A brand-new mission has little memory yet. |
| Messages not appearing in Honcho | `status` spool sizes: held messages are resent by later hooks once the server answers. Memory itself lags minutes behind (the deriver works in batches). |
| Everything lands in mission `general` | Call `mission(id)`, or route work through queue items tagged `mission:<id>`. |
| No recall block when a seat writes | Recall shows only on another seat's message, only items not yet shown this session, and nothing if Honcho is slower than 2.5 s; the log has one `recall` event per prompt (`not-peer`, `empty`, `injected`, `timeout`, `error`). |
| A seat shows the wrong sender | Check `HONCHO_PEER` is unset or equals its session name before `@`. |

## Development

```bash
bun test tests/unit tests/property   # offline
bun test tests/contract              # live server schema, read-only
bun run gate                         # everything, incl. real-server and heavy suites
```

The real-server suites read the server from `HONCHO_TEST_URL` (or `HONCHO_URL`),
default `http://localhost:8000/v3`; Bun loads a git-ignored `.env` file, e.g.
`HONCHO_TEST_URL=http://my-honcho:8000/v3`. They write only to Honcho workspaces
named `honcho-bridge-scratch-*` and delete them. `bun run gate` writes
`gate-report.json`; a release is cut only from a commit the gate passed
(`bun run scripts/release.ts <version>`). The envelope contract test needs the
`@openrig/cli` package installed (or `OPENRIG_CLI_DIR`); set
`OPENRIG_CONTRACT_SKIP=1` on machines without OpenRig.

| Path | What |
|---|---|
| `plugin/` | The plugin: hooks (`bin/`), core (`src/`), the `rig-memory` skill. |
| `tests/` | unit, property, contract, chaos, integration, soak suites. |
| `scripts/` | `gate.ts`, `scan.ts`, `release.ts`, `copy-peer-memory.ts` (carry a seat's recorded decisions to a new peer id). |
| `docs/DESIGN.md` | How it works and why, with diagrams. |
| `docs/adr/` | The decision records. |
| `CHANGELOG.md` | What changed in each release. |

## License

MIT, see [LICENSE](LICENSE).
