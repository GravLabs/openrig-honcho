# ADR-0012: Check the sender against OpenRig's own records (v0.2.2)

Status: accepted (2026-11-01, design.architect); asked for by the owner
2026-11-01 ("lots of manual output parsing seems brittle"). Adds to ADR-0003
(attribution from the envelope).

## Context

The plugin learns who sent a prompt by parsing the `From:` / `To:` / `Sent:`
header that `rig send` types into the seat's terminal. Claude Code's hooks see
only the prompt text, so for an ordinary send there is no other input. Two
risks follow:

- **Format drift.** If an OpenRig upgrade changes the envelope, the parser can
  stop matching, and memories get the wrong sender with no error.
- **No proof.** Anyone can type a `From:` header into a pane, and the plugin
  takes it at face value.

What OpenRig 0.7.2 already offers (read 2026-11-01 in the installed
`@openrig/cli`):

- `daemon/dist/lib/pane-envelope.js` exports `wrapPaneEnvelope(sender,
  recipient, body, meta)`, the one function that writes the envelope.
- Every delivery is retained in the daemon's outbox before it is typed
  (`domain/session-transport.js`): `outboxId`, `senderSession` (taken from the
  caller's transport identity, `identity_provenance: transport:v1`, not from
  the text), `destinationSession`, the exact `body` typed (envelope included),
  `ts_dispatched`, `delivery_state`. Queue nudges appear as
  `wake-intent-<qitemId>` entries.
- `GET $OPENRIG_URL/api/queue/outbox/list?senderSession=<s>&limit=<n>` (the
  public route behind `rig queue outbox-list`) returns those entries, newest
  first. It took 2 ms on this host. Seats get `OPENRIG_URL` in their
  environment.
- `rig queue show <id> --json` (also over HTTP) returns a queue item's
  `sourceSession`, `destinationSession`, `tags` and `body`.
- No event table or API records a delivery as "A sent B a message" beyond the
  outbox.

## Decisions

1. **Contract test against OpenRig's own writer.** A unit test imports
   `wrapPaneEnvelope` from the installed `@openrig/cli` (found from
   `npm root -g`, or `OPENRIG_CLI_DIR`), wraps sample senders, recipients
   and bodies (single, multi-recipient, urgent, external), and asserts that
   `plugin/src/envelope.ts` parses each one back to the same sender and body.
   If the package is not installed, the test is skipped with a message that
   says so. The gate requires it to run, so an OpenRig upgrade that changes the
   format fails the gate instead of shipping.
2. **Verify each peer prompt against the outbox.** When attribution has a
   sender from the header and `OPENRIG_URL` is set, the writer (async) asks
   the outbox for that sender's last 20 entries, within 1 s. An entry
   **matches** when its destination is this seat (or one of its addresses)
   and its body equals the prompt (after trimming trailing whitespace). It
   must also have been dispatched within the last 10 minutes.
   - match: the sender is verified; record as today, with
     `metadata.sender_verified: true` and the `outboxId`.
   - daemon answered, no match: record as today, with `sender_verified:
     false`, and log `sender-unverified`.
   - daemon unreachable or no `OPENRIG_URL`: record as today, no flag, log
     `sender-unchecked`.
   v0.2.2 only measures (shadow mode). Changing who a message is recorded as
   waits for the pilot's match rate. If it is near 100%, a later version
   records unverified headers as `unknown-sender`.
3. **Queue nudges from the queue record.** When the prompt is a queue nudge
   (ADR-0003 nudge text) carrying a qitem id, the writer fetches that item.
   The sender becomes its `sourceSession`, and its `mission:<id>` tag (what
   `rig queue create --mission` writes) selects the mission when the seat
   has none set. This replaces parsing the nudge text for the sender, and is
   the first thing that moves pilot memories out of `general` without a
   seat calling `mission(id)`. If the fetch fails, today's parsing applies.
4. **Recall stays local.** The recall hook does not wait on the daemon; it
   uses attribution as today. The added call is in the async writer only.

## Not doing

- Reading `openrig.sqlite` directly: private schema, may change without notice.
- Asking OpenRig upstream for a new delivery event now: the outbox already
  holds what we need. If the outbox route ever changes, decision 1's style of
  contract test covers it too (a fake-daemon unit test pins the shape we use).

## How we'll know

- Unit: the contract test passes on the installed OpenRig. Against a fake
  daemon, verification gives matched, unmatched and unreachable; the
  unreachable case never delays the write past its budget; a queue nudge takes
  its sender and mission from the item.
- Pilot: in the pilot log, the share of peer prompts with
  `sender_verified: true`. Memories land in the mission of the queue item.
