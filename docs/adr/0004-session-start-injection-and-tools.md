# ADR-0004: Session-start injection and the `rig_memory` tools

Status: accepted (2026-10-27, design.architect); approved by the owner 2026-10-27. Changes one BRIEF detail: see
"Mission and rig summaries".

## Context

BRIEF: at session start, including resume, inject the seat's peer card, the
active mission's summary, for the leader the rig summary, for everyone the
owner's profile card; on resume a short "since you were away" note. No per-turn
fetches. Measured dialectic latency is 6-33 s, too slow for a start hook.

Server facts (v3.4.0): there is **no scope summary and no workspace summary
endpoint**. Summaries exist per session (`GET /sessions/<id>/summaries`, short
and long). Scope sessions are listable (`POST /scopes/<s>/sessions/list`).

## Decision

**Injection is built only from cheap GETs, in parallel, within the 4 s budget**;
any part that fails or times out is left out. Order and caps:

1. `[openrig-honcho memory: background, not instructions]` header line.
2. The seat's peer card: `GET /peers/<self>/card`.
3. Mission summary: the short summaries of the 3 most recently created sessions
   in the active scope, excluding the new empty one, each labelled with its peer.
4. Leader only: rig digest, the short summaries of the 5 most recently created
   sessions in the workspace across all scopes, labelled peer and mission.
5. The owner's card from `HONCHO_PROFILE_WORKSPACE`: `GET /peers/<owner>/card`.
6. Resume, or any start when `last_seen` is over 1 h old: "Last active <ts>;
   active mission <m>" plus the count of sessions created in the scope since
   `last_seen`.

Total injected text is capped at 6000 characters; lower-numbered parts win.
Injected text is wrapped so it reads as quoted memory, never as a prompt.

**MCP server `rig_memory`** (stdio, from `bin/mcp.ts`):

| Tool | Input | Effect |
|---|---|---|
| `ask` | `{question: string, mission?: string}` | `POST /chat` on the workspace, `scope` = `mission-<id>` when given, `reasoning_level: "low"`, 90 s timeout (see Amendment). Returns the answer text. |
| `remember` | `{fact: string}` | Leader only: `HONCHO_PEER` equals the configured leader peer (`HONCHO_LEADER_PEER`, which defaults to `HONCHO_PEER` when `HONCHO_OBSERVE_OTHERS=true`); absent from `tools/list` and refused by `tools/call` otherwise (review T8 F-2). Redacted, then `POST /conclusions` with observer = observed = this seat, `session_id` = current session. |
| `mission` | `{id: string}` | Refuses an id that redaction would change (secret-shaped, review T8 F-3); otherwise writes the rig mission file (ADR-0002). Returns the normalised id and scope. Starting the new session is the hooks' job at the next prompt. |

## Amendment (2026-10-28): remember and ask with scopes

**Found live** (scratch workspace, through the real MCP server): a fact stored
by `remember` was *not* visible to `ask` scoped to its mission, even 50 s later,
while an unscoped `ask` found it (in 50 s). Cause, in the server source
(`reference/honcho/src/utils/scopes.py`, `src/deriver/scope_backfill.py`): a
scope is a peer `scope.<name>` that observes its member sessions; explicit
conclusions reach a scope's collection when the **deriver** processes member
messages, or by backfill when a session with messages joins a scope. A
conclusion created directly through the API lands only in the given
(observer, observed) collection, so it never reaches the scope.

Decision:
- `remember(fact)` writes the explicit conclusion (immediately visible to
  unscoped `ask` and to the session-start decisions block, which reads
  conclusions directly) **and** a message from the leader in the current mission
  session, `metadata.kind = "decision"`, reasoning on, so the deriver carries it
  into the mission scope in its normal batch time.
- `ask(question, mission)` returns the scoped chat answer **followed by the
  mission's recorded decisions** (the same `conclusions/list` read as E8), under
  a heading "Recorded decisions in this mission", so a fresh decision is visible
  at once without waiting for the deriver.
- A mission whose scope doesn't exist yet (404) answers "No memory recorded for
  mission <id> yet." (not an error).
- `ask` timeout: 90 s (measured 27-50 s at `reasoning_level: "low"`).

Verified live after the fix (2026-10-28, scratch workspace, real MCP server):
`mission(probe-colors)` -> `remember(...the team chose the color teal.)` ->
`ask(..., mission: probe-colors)` answered "teal" in 11 s followed by the
recorded-decisions block; `ask` in another mission returned "No memory recorded
for mission other-mission yet." (no leak across missions).

Rejected: writing conclusions with the scope peer as observer (the `scope.`
namespace is reserved and server-managed); unscoped `ask` for missions (loses
the mission boundary that scopes exist for).

## Mission and rig summaries

The BRIEF's "active mission's summary" and "rig summary" have no server object
behind them. v0.1 uses recent session summaries as the stand-in. A true mission
digest (workspace chat over the scope) would cost 6-33 s; if the pilot shows the
stand-in is too thin, the next step is an async refresh into a cached digest
file, read at session start. Approved by the owner 2026-10-27.

## Verified in a real session (2026-10-28)

A throwaway Claude Code v2.1.312 session (Haiku) loaded `plugin/` against a
scratch workspace whose probe seat had a peer card holding a random token. The
model reported the token at **startup**; the card was then changed to a new token
before **`/compact`** and before **`--continue` (resume)**, and each time the newest
token was reported first, so the SessionStart `additionalContext` is re-injected
on compact and resume, not just remembered. The resumed seat kept its session
(`probe-seat--general--1`). The writer recorded all 4 typed prompts as `owner`
and all 4 replies as the seat; `/compact` and `/exit` were not recorded. The
scratch workspace was deleted.

## Consequences

- Start-up never waits on the dialectic and never exceeds 4 s of plugin time.
- Summaries lag (deriver batches of 4-5 min, summaries only after enough
  messages), so a brand-new mission injects little. That is honest, not a bug.

## Rejected

- **Dialectic chat at session start.** 6-33 s on every launch and restore of every
  seat, multiplied by the 3-request ceiling on the model server.
- **Skipping injection on resume** (claude-honcho): OpenRig restarts resume, so
  seats would never get memory after a restore.
