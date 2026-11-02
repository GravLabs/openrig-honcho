# openrig-honcho: design

Shared memory for an OpenRig rig, as a Claude Code plugin that records who said
what to whom into a self-hosted [Honcho](https://honcho.dev) server and gives it
back at session start, when another seat writes, and on demand. This document explains how it works and why;
each section links the decision record (ADR) that holds the detail. Version 0.2.

## 1. Problem and goals

An OpenRig rig is a team of agents in separate terminals. They talk to each
other with `rig send`, and the owner types into some of them. Plastic Labs'
`claude-honcho` plugin assumes one human talking to one AI, so in a rig it would:

- learn every prompt a seat receives as the human speaking, including messages
  from other seats;
- read its workspace and peer from one shared config file, so seats under one OS
  user can't have their own identity;
- skip memory at session start on resume, while OpenRig restarts by resuming.

Goals for this plugin:

1. **Right sender.** A message from seat A to seat B is recorded once, as A
   speaking, in B's conversation.
2. **Right place.** One memory per rig, one conversation per seat per mission.
3. **Never in the way.** No hook ever blocks a turn; Honcho down means memory
   delayed, not lost and not a stuck seat.
4. **Nothing leaks.** Secrets are redacted before anything leaves the seat; only
   the owner's own words reach the owner's cross-rig profile.
5. **Observable and testable.** Every claim above is a test someone can rerun.

## 2. The model

| OpenRig | Honcho | Notes |
|---|---|---|
| Rig | Workspace (e.g. `pilot`) | Hard memory boundary per rig. |
| Seat | Peer (`dev-build`) | The seat, not the occupant, so memory survives handover and model swaps. |
| Owner (the human) | Peer `owner` | In each rig workspace, and in the cross-rig profile workspace. |
| Message sender | Message `peer_id` | From the OpenRig `From:` header, not from which terminal received it. |
| Seat conversation in a mission | Session `<peer>--<mission>--<n>` | New session when the mission changes or a new conversation starts. |
| Mission | Scope `mission-<id>` (else `general`) | Scopes group sessions, so recall can stay inside one mission. |

```mermaid
flowchart LR
  subgraph Rig["OpenRig rig pilot"]
    A["seat design-architect<br/>(leader)"]
    B["seat dev-build"]
    C["seat dev-review"]
    O(("owner"))
  end
  subgraph W["Honcho workspace pilot"]
    S1["session design-architect--slice-07--1"]
    S2["session dev-build--slice-07--1"]
    S3["session dev-review--slice-07--1"]
    SC[["scope mission-slice-07"]]
  end
  P[("workspace owner-profile")]
  A --> S1
  B --> S2
  C --> S3
  S1 & S2 & S3 -.member of.-> SC
  O -. own typed prompts only .-> P
```

Peer ids are the local part of the OpenRig session name (`dev-build@pilot` ->
`dev-build`), so every sender is derivable from the header with no lookup table.
Decisions: [ADR-0002](adr/0002-sessions-missions-scopes.md),
[ADR-0003](adr/0003-attribution-and-redaction.md).

## 3. Components

```mermaid
flowchart TB
  subgraph Edge["edges: hook and MCP I/O"]
    SS["bin/session-start.ts<br/>(sync, 4 s budget)"]
    UP["bin/user-prompt.ts<br/>(async)"]
    ST["bin/stop.ts<br/>(async)"]
    MCP["bin/mcp.ts<br/>rig_memory tools"]
    STAT["bin/status.ts"]
  end
  subgraph Core["core: pure, unit-tested without a server"]
    ENV[env.ts] --- ATT[attribute.ts + envelope.ts]
    ATT --- RED[redact.ts] --- SH[shape.ts]
    MIS[missions.ts] --- INJ[inject.ts]
  end
  subgraph IO["local state and network"]
    WR[writer.ts / stop.ts / reader.ts]
    SP[spool.ts + lock.ts + stats.ts + log.ts]
    HC[honcho.ts: fetch client]
    NU[nudge.ts: rig queue show]
  end
  SS & UP & ST & MCP & STAT --> Core
  SS & UP & ST & MCP --> WR
  WR --> SP & HC & NU
  HC --> H[("Honcho v3 API")]
```

- **Zero runtime dependencies.** TypeScript run by Bun; Honcho is called with
  `fetch`, the MCP server is a small hand-written stdio JSON-RPC loop. The plugin
  folder works as copied by OpenRig's `plugin_dirs`, with no install step.
- **Configured only by the seat's environment**, which OpenRig sets from the rig
  spec's `env:` on every launch, restore and handover. No config file.
- **One subprocess**, `rig queue show <id> --json`, run with `execFile` and no
  shell, to read a queue item's mission tag.

Decision: [ADR-0001](adr/0001-plugin-and-env-interface.md).

## 4. Recording a message

What happens when `dev-build` sends `dev-review` a message:

```mermaid
sequenceDiagram
  autonumber
  participant B as dev-build
  participant R as dev-review (Claude Code)
  participant UP as user-prompt hook (async)
  participant H as Honcho
  participant SP as local spool
  B->>R: rig send (From/To/Sent envelope)
  R->>UP: UserPromptSubmit {prompt}
  Note over UP: unwrap paste, parse envelope,<br/>sender = dev-build
  UP->>SP: replay held messages first (one replayer at a time)
  UP->>UP: resolve session dev-review--slice-07--1 (seat lock)
  UP->>H: ensure session (scope, peers) if not yet ensured
  UP->>UP: redact, then chunk at 24 000 chars
  UP->>H: POST messages peer_id=dev-build
  alt Honcho down or slow
    UP->>SP: hold the write (redacted) for later
  end
  R-->>R: model answers, the turn never waited
  R->>H: Stop hook records the reply as dev-review
```

Classification of a prompt, in order (ADR-0003):

```mermaid
flowchart TD
  P[prompt] --> X["strip leading system-reminder blocks;<br/>unwrap one whole pasted_content block"]
  X --> H{harness content or<br/>slash command?}
  H -- yes --> SKIP[skip]
  H -- no --> E{well-formed<br/>From/To/---/---/↩ envelope?}
  E -- yes --> S{sender}
  S -- "daemon@kernel, system:*" --> AU[automation]
  S -- "invalid id, unknown" --> UN["peer unknown-sender"]
  S -- "seat@rig" --> PE["peer = seat (other rig: seat_rig)"]
  E -- no --> M{known OpenRig<br/>automation text?}
  M -- yes --> AU
  M -- no --> OW["owner"]
  AU --> F{HONCHO_RECORD_AUTOMATION}
  F -- false --> SKIP
  F -- true --> OR["peer openrig"]
```

Details that matter:

- A real `rig send` reaches the hook wrapped as `<pasted_content id="…">`;
  this was verified with a capture hook in a live session.
- Only owner-classified prompts are also written to the profile workspace.
- Replies are the assistant text of the turn, never tool calls, stamped with the
  transcript timestamp (so a reply can't sort before its prompt), and recorded
  once per turn.
- Acks ("ok", "T3 ready") and the extra copies of a broadcast are stored with
  reasoning suppressed, so the shared deriver doesn't spend batches on them.

- The writer then checks the sender against OpenRig's own record: the
  daemon's outbox (`$OPENRIG_URL/api/queue/outbox/list`) keeps every delivery
  with the sender it identified and the exact text typed. A match marks the
  stored message `sender_verified`; v0.2.2 only measures this. A queue nudge
  takes its sender and mission from the queue item itself. A contract test
  checks the envelope parser against OpenRig's own `wrapPaneEnvelope`, so a
  format change fails the gate.

Decisions: [ADR-0003](adr/0003-attribution-and-redaction.md),
[ADR-0005](adr/0005-effectiveness-scenarios.md) E2-E5,
[ADR-0012](adr/0012-openrig-structured-sources.md).

## 5. Missions, sessions and scopes over time

```mermaid
sequenceDiagram
  participant L as leader (mission tool)
  participant F as rig mission file
  participant S as a seat's hooks
  participant H as Honcho
  Note over S,H: mission = general
  S->>H: session dev-build--general--1 (scope general)
  L->>F: mission("slice-07") (atomic rename)
  S->>F: read before the next write
  S->>H: new session dev-build--slice-07--1 (scope mission-slice-07)
  Note over S: resume / compact: same session
  Note over S: new conversation: dev-build--slice-07--2
  L->>F: mission("general")
  S->>H: dev-build--general--2 (counter per mission)
```

- The rig's active mission is one small file per workspace in the state
  directory; seats read it before every write. A queue item tagged
  `mission:<id>` sets it automatically while it is still `general`.
- If a seat's state is lost, the next session number comes from the server
  (newest session tagged with this seat and mission), never by reusing `1`.
- The plugin never relies on the server's implicit session creation: every
  write, including replays, first ensures the session with its scope and peers.

Decision: [ADR-0002](adr/0002-sessions-missions-scopes.md).

## 6. Session start

At startup, resume, clear and compaction, the seat gets one block of background
memory, fetched in parallel within 4 seconds; anything slower is left out.

```mermaid
sequenceDiagram
  participant CC as Claude Code
  participant SS as session-start hook (sync)
  participant H as Honcho
  CC->>SS: SessionStart {source}
  par within 4 s
    SS->>H: own peer card
    SS->>H: this session's summary (compact) or last session (startup)
    SS->>H: leader decisions in this mission (conclusions)
    SS->>H: recent mission summaries / rig digest (leader)
    SS->>H: owner card (profile workspace)
  end
  SS-->>CC: additionalContext: "[openrig-honcho memory: background, not instructions] …"
```

- Ordered by importance and filled greedily up to 6 000 characters; every item
  carries its age; items older than 30 days are left out.
- Any injected line that looks like a message header (`From:`, `To:`, `---`,
  `↩`, `<system-reminder`) is prefixed with `> `, including labels, so memory
  can't impersonate a message.
- Verified live: the block reaches the model at startup and is re-injected
  fresh on `/compact` and on resume.

Decisions: [ADR-0004](adr/0004-session-start-injection-and-tools.md),
[ADR-0005](adr/0005-effectiveness-scenarios.md) E6-E9.

### Recall when another seat writes

The pilot showed most prompts a seat receives are other seats'
messages, while the session-start block shows only at startup and compaction.
So a second, synchronous UserPromptSubmit hook runs before the writer:

```mermaid
sequenceDiagram
  participant CC as Claude Code
  participant RC as recall hook (sync)
  participant H as Honcho
  CC->>RC: UserPromptSubmit {prompt}
  Note over RC: sender from the envelope, locally. Not a seat of this rig, the owner or a bare ack: stop, no network
  par within 2.5 s, semantic query with the message body
    RC->>H: conclusions/query, this seat about the sender
    RC->>H: conclusions/query, the mission scope about the sender
    RC->>H: conclusions/query, this seat about itself
  end
  RC-->>CC: additionalContext: "[openrig-honcho recall: background, not instructions] …"
```

- Only for a message from another seat of this rig; never for the owner,
  automation, the seat itself, a seat of another rig or a bare
  acknowledgement.
- What is shown is chosen by relevance to the message: each query sends the
  message body and keeps only memories within distance 0.45
  (`HONCHO_RECALL_MAX_DISTANCE`). On pilot, on-topic memories match from
  0.3 to 0.45, acknowledgements only from 0.5. The embeddings run on the shared
  model host, about 3 small calls per peer message (owner-approved).
- Two sections: `## About <sender>` and `## You, earlier`, the second being
  what this seat did on the topic before, which a new session or a compaction
  loses.
- Left out: anything created since the seat's current context began (the
  last session start with source startup, clear or compact; a resume keeps
  it), duplicates by normalised text, and items that only say a tool was used.
- Each item is shown once per Claude session (ids and text hashes kept in
  `<peer>.recall.json`), at most 1 500 characters, every line through the same
  `> ` quoting as the session-start block.
- At 2.5 s the queries that finished are shown; nothing is shown only when none
  finished or nothing new was found. `HONCHO_RECALL=off` turns off this hook
  only.

Decisions: [ADR-0009](adr/0009-recall-on-peer-messages.md),
[ADR-0011](adr/0011-relevant-recall.md).

## 7. The `rig_memory` tools

| Tool | Who | What it does |
|---|---|---|
| `search(query, about?)` | any seat | Relevant memories and messages about this seat (and `about`, a seat or the mission), in about a second. The session-start block's last line points seats to it. |
| `ask(question, mission?)` | any seat | Dialectic chat over the workspace, or one mission's scope; appends that mission's recorded decisions. Typically 30-50 s; times out at 90 s. |
| `remember(fact)` | leader only | Stores the decision as an explicit conclusion (visible at once) and as a decision message in the mission session (reaches the mission scope through the deriver). |
| `mission(id)` | any seat | Sets the rig's active mission; refuses secret-shaped ids. |
| `status()` | any seat | Config (never the key), server version, mission and session, spool sizes, counters, recent log events. |

Scopes only receive conclusions through the deriver, which is why `remember`
writes both forms; this was found and then verified against the live server.
Decision: [ADR-0004](adr/0004-session-start-injection-and-tools.md) (Amendment).

## 8. Failure behaviour

A write is never retried inside the hook; it is held and resent by later hooks.

```mermaid
stateDiagram-v2
  [*] --> Sending
  Sending --> Delivered: 2xx
  Sending --> Held: connect / 5xx / 401-404 / 429 (not sent)
  Sending --> HeldMaybeSent: timeout / unparseable / unknown outcome
  Sending --> Dead: 400 / 413 / 422 (message itself is bad)
  Held --> Sending: next hook replays (oldest first)
  HeldMaybeSent --> Sending: replay with metadata.replay_of
  Dead --> [*]: counted, kept in dead.jsonl (1 MB cap)
  Delivered --> [*]
```

- **Spool.** Live file `spool/<peer>.jsonl` is append-only; one replayer at a
  time renames it aside and drains it, so a message held during a replay is
  never lost. Bounded at 11 MB per seat (5 live + 5 replay + 1 dead).
- **Duplicates.** Honcho has no idempotency key, so a timeout after the request
  was sent can duplicate; such entries are marked `maybe_sent` and counted.
- **Budgets.** Session start <= 4.5 s and writers <= 10 s under any server
  behaviour, including a server that hangs (chaos tests, measured ~3 s).
- **Misconfiguration** (wrong URL, deleted workspace) stops replay and keeps the
  backlog; it never drains it into the dead-letter file.

- **Double installs.** Claude Code applies a parent folder's
  `.claude/settings.local.json` to a seat in a subfolder, so a second install
  there would run every hook twice. The installer leaves hooks out when an
  ancestor already runs ours. Each hook also takes a once-marker,
  `once/<sha256(hook, raw stdin)>`, created exclusively: a second copy of the
  same event within 5 s does nothing and logs `duplicate-run`. An older marker
  is taken over through an exclusive claim file named after its mtime, so the
  marker itself is never absent and only one copy wins. Any error in the guard
  means the hook runs normally.

Decisions: [ADR-0005](adr/0005-effectiveness-scenarios.md) E1,
[ADR-0006](adr/0006-quality-bar.md) R1-R3,
[ADR-0010](adr/0010-no-double-runs.md).

## 9. Security and privacy boundaries

```mermaid
flowchart LR
  T[prompt / reply / fact / question] --> R[redact: 9 secret shapes] --> C[chunk] --> OUT((Honcho))
  T -.never.-> LOG[(log: outcome fields only)]
  OWN[owner-typed prompts] --> PROF[(profile workspace)]
  PEER[peer, automation, replies] -.never.-> PROF
```

- Redaction runs on every outbound text before chunking, from shapes only:
  Anthropic and `strata_` keys, JWTs, bearer and basic auth, PEM keys, `KEY=value`
  assignments, JSON token fields, 64-hex tokens, long opaque tokens (incl.
  URL-encoded and in URL paths). Known accepted gaps: short encoded secrets, and
  two different secret kinds glued together with no separator.
- Exactly two workspaces are ever written: the rig's and the profile.
- Local files are private (state dir 0700, files 0600).
- Plastic Labs' cloud (`*.honcho.dev`) is refused.
- The repo and release are scanned for secret shapes on every gate run.

Decisions: [ADR-0003](adr/0003-attribution-and-redaction.md),
[ADR-0006](adr/0006-quality-bar.md) X1-X7.

## 10. Observability

- **Log**: one JSON line per hook run in `<state>/log/<workspace>.log` with
  outcome, duration, session and an error class (`connect`, `timeout`,
  `http_<status>`, ...); never content. Rotated at 5 MB, 3 kept. The recall
  hook logs one event per prompt: `not-peer`, `empty`, `injected` (with the
  item count and bytes), `timeout` or `error`.
- **Counters** per seat: written, failed, spooled, replayed, dropped, dead,
  sanitized, redactions by kind.
- **`status`** (tool and `bin/status.ts [--json]`): exits 1 when unhealthy
  (server unreachable, spool over 80%, server version other than 3.4.0, plugin
  disabled), so an operator script can use it.

Decision: [ADR-0006](adr/0006-quality-bar.md) O1-O4.

## 11. Configuration

Everything comes from the seat's environment; see the
[README settings table](../README.md#settings) for the full list and the
[quick start](../README.md#quick-start) for a rig spec.
Required: `HONCHO_URL`, `HONCHO_WORKSPACE`; `HONCHO_PEER` defaults to the
OpenRig session name before the `@`. The environment comes either from the rig
spec (a new rig) or from the project's `.claude/settings.local.json`, written by
`bin/install-project.ts` for seats that already exist
([ADR-0008](adr/0008-in-place-install.md)). Kill switch:
`HONCHO_ENABLED=false`; `HONCHO_RECALL=off` turns off only recall. An invalid setting turns the plugin off and logs why.

## 12. How it is tested

`bun run gate` runs every check and writes `gate-report.json`; a version is
released only from a commit the gate passed with a clean tree. The gate proves
every test workspace's delete was accepted; `release.ts` then refuses while the
server still lists any of them, since its one deriver purges them behind real
work.

| Suite | What it proves |
|---|---|
| unit + property | every module, plus 10 000 mutated inputs: no throw, no secret survives, injected memory stays neutralised |
| contract | every call the client makes exists in the live server schema; server version pinned |
| chaos | the real hook processes against a fake server that refuses, errors, hangs or is slow: budgets, nothing lost, order |
| integration | the writer and reader against the real server in throwaway workspaces |
| soak (heavy) | 3 seats, 300 messages, mission switches, a compaction and an outage through a TCP forwarder |
| scan, validate | no secret shapes in the repo; the plugin manifest is valid |

Tests only ever write to workspaces named `honcho-bridge-scratch-*`, created
with derivation off so they cost the shared model server nothing, and delete them.
Decision: [ADR-0006](adr/0006-quality-bar.md), [ADR-0007](adr/0007-docs-and-publishing.md).

## 13. Decisions and limits

| ADR | Decision |
|---|---|
| [0001](adr/0001-plugin-and-env-interface.md) | Plugin layout, env contract, zero dependencies, never block a turn |
| [0002](adr/0002-sessions-missions-scopes.md) | Sessions per seat per mission, scopes, state files, session numbering |
| [0003](adr/0003-attribution-and-redaction.md) | Sender attribution from the OpenRig envelope; redaction shapes |
| [0004](adr/0004-session-start-injection-and-tools.md) | Session-start memory block and the `rig_memory` tools |
| [0005](adr/0005-effectiveness-scenarios.md) | Spool, chunking, dedupe, broadcast and ack handling, mission hints |
| [0006](adr/0006-quality-bar.md) | The quality bar and the release gate |
| [0007](adr/0007-docs-and-publishing.md) | Docs, the release sequence and publishing |
| [0008](adr/0008-in-place-install.md) | Installing into seats that already exist |
| [0009](adr/0009-recall-on-peer-messages.md) | Recall on peer messages |
| [0010](adr/0010-no-double-runs.md) | A seat never runs our hooks twice |
| [0011](adr/0011-relevant-recall.md) | Recall what is relevant, not what is newest; the `search` tool |
| [0012](adr/0012-openrig-structured-sources.md) | Check the sender against OpenRig's own records |

Known limits in v0.2:

- Claude Code seats only (no Codex).
- Mission and rig "summaries" are recent session summaries; Honcho 3.4.0 has no
  scope or workspace summary.
- Memory lags: the deriver works in batches minutes after the fact.
- The state directory is host-local, so seats of one rig must share a host.
- Recall knows only what the deriver has already concluded about the sender,
  so a seat's first messages bring little.
- Still deferred: backfilling existing transcripts, seeding peer cards with
  roles, queue item bodies as memory, a cached mission digest.
