# ADR-0011: Recall what is relevant, not what is newest (v0.2.2)

Status: accepted (2026-11-01, design.architect); approved by the owner
2026-11-01, including semantic queries on the shared embedding host. Amends
ADR-0009 decision 2 and its T14a result.

## Context

The usefulness check on pilot (read-only, 2026-11-01, covering 10-31 15:50Z
to 11-01 15:32Z):

- Recall runs on every prompt (76) and is cheap: p50 24 ms, p95 42 ms, no
  errors. 43 prompts (57%) were another seat's message; 16 of them got a
  block of 362 to 1328 characters.
- No seat referred to or acted on any of the 16 blocks. Most items were what
  the sender had said "just now" or "16 min ago", often in the very message
  being read. Some were tool trivia ("used the ctx_execute tool to check CI").
  Three blocks were about `operator-agent_kernel`, a seat of another rig, and
  were false ("is the leader of operator-agent_kernel's rig"); one repeated a
  line. The rare useful item (older state, "frozen at 4d158ff, 10 h ago") was
  buried among these.
- `ask` was called 0 times, before and after. It takes 30-50 s.

Why: ADR-0009 lists the newest conclusions about the sender. Newest means
what the seat already has in context. The official `claude-honcho` plugin
(`reference/claude-honcho/plugins/honcho/src/hooks/user-prompt.ts`) instead
asks for conclusions semantically close to the prompt, with a distance gate,
leaves stable identity (the peer card) to session start, skips terse replies,
and nudges the agent once toward fast search tools.

A read-only probe on pilot (2026-11-01, `POST /conclusions/query`) showed:
33-90 ms per query; on-topic results ("device-code sign-in" brought back the
device-code and battery-3 facts); and a clean distance split. On-topic queries
return items from distance 0.3-0.45. Acknowledgements ("Acknowledged. Standing
by.") return nothing until 0.5, and an off-topic query returns nothing up to
0.6. `claude-honcho`'s default of 0.6 lets everything through on our embedding
model (Qwen3-Embedding-0.6B).

The probe also found an expired Azure device code stored verbatim in a
conclusion: our redaction has no device-code shape.

## Decisions

1. **Query by content.** Recall sends the sender's message body (envelope
   stripped, redacted, first 1000 characters) to `POST /conclusions/query`,
   `top_k` 4, `distance` 0.45 (`HONCHO_RECALL_MAX_DISTANCE`, 0.05-1), for
   three pairs in parallel inside the 2.5 s budget:
   - this seat about the sender (`## About <sender>`);
   - the mission scope about the sender (merged into the same section);
   - this seat about itself (`## You, earlier`): what the seat did or decided
     on this topic before, which is what it loses at a new session or
     compaction.
   Results keep the server's relevance order. Pairs merge round-robin. The
   1,500-character cap, x3 quoting, ages and whole-item rule stay as in
   ADR-0009. The owner accepted the embedding load on the shared model host: about 3 small
   embedding calls per peer message.
2. **Leave out what the seat already has.** An item created after the seat's
   current context began is dropped. The context begins at a session start
   with source startup, clear or compact; a resume keeps the old context and
   does not move it. Session start records that time in the seat state. With
   no recorded time, drop items younger than 30 minutes.
3. **Only seats of this rig.** A sender from another rig (peer id
   `<local>_<rig>`, ADR-0003) gets no recall, logged `not-rig`. Our rig's
   conclusions about a visitor are thin and were wrong in the pilot.
4. **No noise.**
   - Skip the fetch for a bare acknowledgement ("ack", "noted", "standing
     by", "thanks", alone or combined), logged `terse`. Amended in T16a: no
     length rule, since a short real report or question must never be skipped
     and the distance gate already returns nothing for thin text.
   - Drop items whose normalised text (lower case, spaces collapsed) repeats
     one already in the block or already shown this session; the seen list
     keeps a short hash beside the id.
   - Drop tool-use trivia: items saying a peer used, ran, called or invoked
     a named tool or command, with nothing else.
   Amended in T16g: the owner as sender gets no recall either, and at the
   2.5 s wall the queries that finished are rendered.
5. **A fast `search` tool.** `rig_memory` gains `search(query, about?)`: the
   same conclusions query over the seat's own pairs and the scope, plus
   `POST /workspaces/{w}/search` over messages, top 8, in about a second. The
   `rig-memory` skill and a one-line hint in the session-start block say:
   `search` is fast, use it before guessing about past work; `ask` is slow
   (30-50 s) and reasons over everything.
6. **Redact device codes.** A device-login code (an 8-9 character upper-case
   code near "devicelogin" or "device code") is masked like other secret
   shapes, before anything leaves the seat.
7. **Measure it.** Each recall log line adds `considered`, `dropped_context`,
   `dropped_dup`, `dropped_trivia` and `query_chars` (counts only, never
   content). `search` logs `tool:search` with ms and result count. The next
   usefulness check compares these and `search`/`ask` use with this baseline.

## Not doing

- Dialectic chat (`/peers/.../chat`) from a hook: 6-50 s.
- Recording tool calls as memory (`claude-honcho`'s opt-in post-tool-use):
  tool-use trivia is already the noisiest kind of item.
- Changing the deriver, the peer card or server-side consolidation: that is
  the `honcho-openrig` stack, not ours.

## How we'll know

- Unit: the three queries carry the body and the gate; context, cross-rig,
  terse, duplicate and trivia filters each drop what they should; render as
  before; device codes are masked.
- Integration (scratch only): conclusions created in a scratch workspace come
  back for an on-topic query at 0.45 and not for an acknowledgement.
- Pilot: on pilot, blocks hold items older than the seat's context, no
  `not-rig` sender gets a block, and a later read-only check finds a seat
  using a recalled item or calling `search`.

## Consequences

About 3 embedding calls per peer message on the shared model host, measured
at well under 100 ms each. Fewer blocks than v0.2.0 (terse and acknowledgement
messages get none), and each one should be on topic.
