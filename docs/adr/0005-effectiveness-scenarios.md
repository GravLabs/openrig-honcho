# ADR-0005: Scenarios that make the memory effective

Status: accepted (2026-10-27, design.architect), at the owner's request to expand
v0.1 scope. Supersedes ADR-0001's "no retry spool in v0.1".

## Context

ADR-0001..0004 make memory correct (right sender, right mission, no secrets,
never blocks). They do not yet make it useful in the situations a rig actually
hits: Honcho down for an hour, a seat compacting mid-task, a broadcast to six
seats, a decision made last week, a seat that forgets to set the mission.
Server facts used below (v3.4.0 schema): message `content` max 25 000 chars;
per-message `configuration.reasoning.enabled`; `POST /conclusions/list` takes
`filters`.

## Decision: in v0.1

| # | Scenario | Without this | Decision |
|---|---|---|---|
| E1 | Honcho down or slow | Every message in the outage is lost | **Spool.** A failed write is appended to `$HONCHO_STATE_DIR/<workspace>/spool/<peer>.jsonl` (already redacted, with its session id and `created_at`). Every writer hook first replays up to 50 spooled entries, oldest first, in its own time budget; a replayed entry is removed only after the server accepts it. Spool capped at 5 MB per seat; past that, oldest entries are dropped and the drop is logged. **Replay never holds the seat lock across a network call, and never rewrites the live file** (review T5b F-2, then review's re-review plan items 2-3). Files: live `spool/<peer>.jsonl` (appended by writers, one `O_APPEND` write each, no lock) and `spool/<peer>.replay.jsonl` (owned by one replayer). One replay at a time: a replayer takes `spool/<peer>.replaying` (an `O_EXCL` lockdir, stale after 60 s); if it is held, the hook skips replay this time (no wait). Holding it, the replayer: (1) if no replay file exists, renames live -> replay (an append racing the rename lands in one file or the other, both kept); (2) sends replay entries oldest first; (3) rewrites the replay file with only the unsent entries (no writer ever touches it), or deletes it if empty; (4) releases. A leftover replay file from a crash is simply older than live and is drained first; live is not taken over until it is empty. The seat lock is not involved. **Poison entries:** a send that fails with HTTP 400, 413 or 422 (the message itself is bad) is permanent: that entry moves to `spool/<peer>.dead.jsonl` (capped at 1 MB, oldest dropped, counted, reported by `status`) and replay continues; every other failure (connect, timeout, 401/403/404 and other 4xx, 5xx) stops replay to retry later and keeps the entries: a 404 or 401 usually means a wrong `HONCHO_URL`, a deleted workspace or auth, and must not turn a seat's whole backlog into dropped dead letters; `status` reports the last stop reason. Permanent classification applies only to sending messages; a failure to *ensure* the session (create it or add peers) stops replay and keeps the entry at any status, so a wrong URL or lost auth can never drain the backlog into the dead file. **Bound per seat:** live <= 5 MB, replay <= 5 MB (it was a live file and only shrinks), dead <= 1 MB: 11 MB worst case. An entry is at most 256 KB serialized (a write is split across several entries), so the cap is exact; an entry that still can't fit is dropped and counted. |
| E2 | Message over 25 000 chars | Write rejected, message lost | **Chunk** at 24 000 chars on a paragraph or line boundary, never inside a UTF-16 surrogate pair; chunks share `metadata.chunk = {id, i, n}`. Redaction runs on the whole message **before** chunking, so a secret can't be split across a boundary. |
| E3 | Stop fires more than once for one turn (wakeups, background-task notifications) | Assistant text uploaded twice | **Dedupe per turn.** Seat state keeps the hash of (turn id + reply text), where turn id is the `uuid` of the transcript entry that opened the turn (the last real user prompt or wakeup boundary); the same turn firing Stop twice is skipped, while an identical reply on a *different* turn is recorded (review T6b). Without a readable transcript, the hash is of the text alone. |
| E4 | Broadcast / multi-recipient `rig send` | One message learned N times, N x deriver load on the model server | **Fan-out once.** Every recipient records it (each seat needs the context), but reasoning is enabled only in the session of the recipient whose peer id sorts first in the `To:` list; the rest send `configuration.reasoning.enabled = false`; the reasoning copy omits `configuration` and inherits the workspace setting (ADR-0006, test traffic). For `broadcast to <rig>` (no list), only the leader reasons; when the leader is the sender, every recipient reasons (rare; each seat has no way to know the others). Metadata `fanout: n`. |
| E5 | Terse replies and acks ("ok", "T1 ready", "standing by") | Deriver spends a batch on noise | **No reasoning** for messages under 40 chars whose **whole text** (trimmed, trailing punctuation ignored) is an ack pattern; a sentence that merely contains one ("Auth bug is not done") is not an ack. They are still stored for context. |
| E6 | Seat compacts mid-task | It loses the thread; memory only offers mission-level summaries | On `SessionStart` `source=compact`, inject **this session's own summary** first (`GET /sessions/<current>/summaries`, long if present, else short). |
| E7 | New occupant after handover, or a fresh launch into the same mission | Starts cold on its own seat's work | On `startup`/`clear`, inject **the seat's previous session in this mission** (short summary) labelled "your last session". |
| E8 | Decisions made earlier by the leader | Buried in summaries or lost | **Decisions block.** Inject, for every seat, the leader's 10 most recent explicit conclusions (`remember`) in the active mission, newest first, each with its date. Leader peer id comes from a new optional `HONCHO_LEADER_PEER` (needed by non-leader seats); unset = block omitted. |
| E9 | Old memory presented as current | A seat acts on a week-old state | **Age labels** on every injected item ("2 h ago", "6 d ago"), and items older than 30 days are left out of injection (still reachable through `ask`). |
| E10 | "Is memory working?" | Silent failure looks like a quiet rig | **`status` tool** on `rig_memory` and a `bin/status.ts` script: config (no key), active mission and session, last successful write time, spool size, last error, `queue/status` of the workspace. |
| E11 | Seat forgets to call `mission(id)` | Everything lands in `general` | **Mission from the queue.** Nudges carry only the qitem id and summary, not tags. When a recorded message's body matches `^Queue handoff: (qitem-[0-9A-Za-z-]{1,80}) - check your queue\.`, the async writer runs `rig queue show <id> --json` (execFile, no shell, id validated by that regex, 3 s timeout). If its tags include `mission:<id>` and the rig mission is `general`, the writer sets the mission (same atomic write as the tool, `set_by: "queue"`). It never overrides a mission set by the tool, and any failure is ignored. |

New env names: `HONCHO_LEADER_PEER` (optional). No other contract changes.

## Decision: deferred to v0.2 (written down so they're not lost)

- **Backfill** a rig's existing transcripts into its workspace before the pilot.
  High value for pilot, but it is a bulk write to a real workspace and a
  deriver load spike on the model server; needs its own review and the owner's OK.
- **Seeding peer cards** with each seat's role from `rig whoami`.
- **Queue item bodies** as memory (only the nudge text is seen today).
- **Codex seats.** The plugin is Claude Code only.
- **An async cached mission digest** (ADR-0004), if recent-session summaries
  prove too thin in the pilot.

## Consequences

- E1 changes the failure story: an outage delays memory instead of losing it.
  The spool holds redacted text only, under the user's home, mode 0600.
- E4/E5 cut deriver load on the model server, which is the shared bottleneck.
- E6-E9 add at most three GET calls to session start, inside the same 4 s
  budget and 6000-char cap; order of precedence in the cap: own session (E6),
  decisions (E8), last session (E7), then ADR-0004's list. The cap is filled
  greedily in that order: a section that doesn't fit the space left is truncated
  at a line boundary (ending with "…") if at least 300 chars remain, else
  skipped, and filling continues with the next sections, so one oversized section
  never pushes out smaller ones after it (T7a check).
- E11 is heuristic; a wrong hint is corrected by one `mission(id)` call.

## Rejected

- **Per-turn retrieval** (claude-honcho's dialectic on every prompt): 6-33 s per
  turn; the BRIEF rules it out.
- **Recording tool calls** to capture what a seat did: noise for the deriver and
  a secret-leak surface; the assistant's own text reports what it did.
- **Deduping broadcasts by recording once in a shared session**: recipients would
  lose the message from their own conversation history.
