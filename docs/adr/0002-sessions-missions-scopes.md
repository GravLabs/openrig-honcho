# ADR-0002: Sessions, missions, scopes and the state files

Status: accepted (2026-10-27, design.architect)

## Context

BRIEF: one session per seat conversation within a mission, named
`<peer>--<mission>--<n>`; mission = scope `mission-<id>`; no mission = scope
`general`. Server facts (v3.4.0 schema): `POST /sessions` accepts
`peers: {peer_id: {observe_me, observe_others}}` and `scopes: [names]` (scopes are
created if missing); workspace chat and peer chat accept `scope` (name or list).
All seats of a rig run under one OS user on one host, so a file is a valid
shared channel for the active mission.

## Decision

**Mission ids.** OpenRig mission ids, normalised: lowercase, runs of characters
outside `[a-z0-9_-]` become `-`, trimmed, max 60 chars. Empty or unset = `general`.
Scope name: `mission-<id>`, or `general`.

**Rig mission file**: `$HONCHO_STATE_DIR/<workspace>/mission.json`

```json
{"mission": "slice-07", "set_by": "design-architect", "set_at": "2026-10-27T21:00:00Z"}
```

Written only by the `mission(id)` MCP tool, atomically (write temp file in the
same dir, `rename`). Last writer wins; two seats switching at once both succeed
and the later `rename` is the mission. Missing or unparsable = `general`.

**Seat state file**: `$HONCHO_STATE_DIR/<workspace>/seats/<peer>.json`

```json
{
  "mission": "slice-07",
  "n": 3,
  "session": "dev-build--slice-07--3",
  "claude_session_id": "8044c767-...",
  "counters": {"slice-07": 3, "general": 1},
  "last_seen": "2026-10-27T21:05:00Z"
}
```

Written atomically by the seat's own hooks only, under a lock for that seat
alone: `withLock(<stateDir>/<workspace>/seats/<peer>.lockdir)` (ADR-0006 S3).
Seats never share a lock; the rig mission file takes no lock (atomic rename only).

**When a new Honcho session starts** (n = `counters[mission] + 1`):
1. The rig mission differs from the seat state's `mission` (checked by
   UserPromptSubmit and Stop before every write, and by SessionStart).
2. SessionStart with `source` = `startup` or `clear` and a `claude_session_id`
   different from the state's (a new Claude conversation).

Not on `resume` or `compact`: those continue the same conversation and session.
Missing or corrupt state file: one `POST /sessions/list?reverse=true&size=1` with
`{"filters": {"metadata": {"rig_peer": <peer>, "mission": <mission>}}}` returns
this seat's newest session in this mission; since n only grows, its n is the
highest, and the new session is n+1, or 1 if none. (Listing the scope's sessions
misses the highest n once a scope holds more than 100 sessions and merges a new
write into an old conversation: review T6c F-1. The server supports metadata
filters and created_at ordering: `reference/honcho/src/utils/filter.py`,
`src/crud/session.py`.) **Every session creation, normal or epoch-fallback,
stamps `metadata.rig_peer` and `metadata.mission`** (as of T6c-fix; before it, the
writer stamped neither, review T6c re-review plan). No migration: v0.1 has never
been deployed, and every session written before this fix lives in a scratch
workspace that tests deleted. **Defence in depth (T6c-fix, accepted over my
earlier "no fallback scan"):** when the filtered query returns nothing, one
unfiltered `sessions/list?reverse=true&size=100` is scanned for ids starting
`<peer>--<mission>--` before n=1 is minted; it costs one request only on a seat's
first session in a mission and covers untagged sessions from any source. A future change to these tags needs its own
migration note. If that call fails or times out, n is the
current Unix time in seconds (it can't collide with a small counter or an earlier
fallback), and the session metadata gets `n_fallback: true`; the write is never
skipped and never reuses an existing session. The check runs inside the seat lock,
so two hook processes of one seat can't both claim the same n (review T5/T6).

**Session creation**: one `POST /sessions` with `id`, `scopes: [<scope>]`,
`metadata: {rig_peer, mission}` (plus `n_fallback` when it applies) and `peers` = this seat plus
the owner peer, configured per BRIEF:

| Peer | observe_me | observe_others |
|---|---|---|
| `HONCHO_OWNER_PEER` | true | false |
| this seat, leader (`HONCHO_OBSERVE_OTHERS=true`) | true | true |
| this seat, other | true | false |
| another seat seen as a sender | true | false |
| `openrig` | false | false |
| `unknown-sender` | false | false |

**Never rely on implicit session creation.** The server creates a session on the
first message posted to an unknown session id (probed 2026-10-28: `POST
.../sessions/<new>/messages` -> 201), with no scope and default peer config. So
every write path, including spool replay, first ensures the session with
`POST /sessions` (get-or-create, idempotent) carrying its `scopes` and `peers`.
Spool entries store those creation parameters for that reason.

A sender not yet in the session is added (`POST /sessions/<id>/peers`) before its
message is written; the seat state caches the member list to avoid a call per
message.

**Profile workspace**: owner-typed prompts are also written to
`HONCHO_PROFILE_WORKSPACE` in session `<rig-workspace>--<peer>` (one per seat, no
scope), peer `HONCHO_OWNER_PEER` only, observe_me true. Nothing else is ever
written there.

## Consequences

- A session never spans missions: scope recall per mission is exact.
- `mission(id)` takes effect on every seat at its next prompt or reply, not
  instantly; a message in flight at the switch can land in the old session.
- The state dir is host-local: seats of one rig on two hosts would not share a
  mission. Out of scope for v0.1 (all current rigs are single-host).

## Rejected

- **Mission in session metadata only, no scopes.** Recall filtering by metadata
  is not supported by chat; scopes are.
- **Mission from an env variable.** Env is fixed at launch; missions change while
  seats run.
- **Locking the mission file.** Last-writer-wins with atomic rename is enough for
  a value set a few times a day, and a lock adds a stuck-lock failure mode.
