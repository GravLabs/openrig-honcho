# ADR-0003: Sender attribution, automation and redaction

Status: accepted (2026-10-27, design.architect); approved by the owner 2026-10-27

## Context

A seat's prompt can be: a peer's `rig send` / queue nudge, typed by the owner,
OpenRig automation, or Claude Code harness content. The OpenRig envelope is
rendered by `wrapPaneEnvelope` (`@openrig/cli/daemon/dist/lib/pane-envelope.js`):

```
From: <sender>
To: <recipient | a, b | broadcast to <rig> (<n> seats) | broadcast to topology>
Sent: MM-DD HH:MMZ[ · gen <8hex>][ · delivered +<n>s]     (optional line)
---
<body>
---
↩ <reply hint>
```

`<sender>` is a session name `<pod>-<member>@<rig>`, `<name>@external`,
`daemon@kernel` or `system:<x>` (OpenRig itself), or `<unknown sender>`. The
sender is stamped by the daemon from the transport identity, not chosen by the
caller (`--from` is ignored).

## Decision

**Peer ids.** A seat's peer id is the local part of its session name:
`dev-build@openrig-honcho` -> `dev-build`, `design-architect@openrig-honcho` ->
`design-architect`. (The BRIEF's example `architect` becomes `design-architect`,
so every seat's id is derivable from the header with no lookup table.) A sender
from another rig: `<local>_<rig>`. `<name>@external`: `HONCHO_OWNER_PEER` if
`<name>` equals it, else `ext-<name>`.

**Unwrapping.** Claude Code delivers a multi-line message typed into the pane as a
paste, so a real `rig send` arrives as `\n\n<pasted_content id="<x>">\nFrom: ...\n</pasted_content id="<x>">`
(observed in this rig's own transcript, 2026-10-28; **verified at the hook** the same day: a throwaway Claude Code v2.1.312 session with a capture hook received `prompt` = `\n\n<pasted_content id="1037">\nFrom: ...` after a tmux bracketed paste, the way `rig send` delivers, and `attribute()` on that captured prompt returned peer `dev-build` with the bare body). Before classification: strip
leading `<system-reminder>` blocks and surrounding whitespace; then, if the whole
remaining prompt is exactly one `<pasted_content id="X">` ... `</pasted_content id="X">`
block (matching ids, nothing outside it), use its inner text. Text outside the
block, or two blocks, means it is not unwrapped.

**Derived ids are validated.** A peer id derived from a header must match
`^[A-Za-z0-9_-]{1,100}$` (ADR-0001). A well-formed envelope whose derived id
doesn't (e.g. `From: @`, `From: @external` -> `ext-`, a sender with spaces) is
recorded as `unknown-sender`: it came through the envelope path, so it is not the
owner and must never reach the profile workspace (review T3 re-review).

**Classification**, in order, on the unwrapped text:

1. Harness content (claude-honcho's `HARNESS_INJECTED_PATTERNS` list, re-typed,
   plus slash commands): **skip**.
2. Starts with a well-formed envelope (line 1 `From: `, line 2 `To: `, optional
   `Sent: `, then `---`; closing `\n---\n↩` found): body = text between the
   separators.
   - sender `daemon@kernel` or `system:*` -> **automation**.
   - `<unknown sender>` -> peer `unknown-sender`.
   - otherwise -> the sender's peer.
3. Known OpenRig automation without an envelope -> **automation**. Confirmed
   marker: text starting `OpenRig-generated identity context (not a project task):`
   (ends `End of generated identity context.`). Onboarding packs and wake/refocus
   text: markers captured from the daemon source in T3.
   Queue nudges are enveloped (sender = the seat that created or handed off the
   row) with body `Queue handoff: <qitemId> - check your queue.[ Summary: <=120 chars]`;
   they are recorded as that sender's message.
4. Anything else -> **owner** (`HONCHO_OWNER_PEER`).

Automation: recorded as peer `openrig` when `HONCHO_RECORD_AUTOMATION=true`,
otherwise skipped. Only class 4 is written to the profile workspace.

A malformed envelope (e.g. `From:` with no `---`) is **not** trusted as a header:
it falls to 3/4. An envelope appearing anywhere but the start is body text. Only
the outer envelope counts; a quoted envelope inside a body is content.

**Replies**: the Stop hook records the last turn's assistant text (same segment
logic as claude-honcho's Stop: text blocks since the last real prompt) as the
seat's peer. Tool calls and tool results are never recorded.

**Each message recorded once**: as the receiving seat's input with sender A.
The sending seat's own `rig send` command is a tool call, so it is not recorded.

**Redaction** runs on every message body before any upload, in `src/redact.ts`,
replacing a match with `[REDACTED:<kind>]`. Patterns describe shapes, never values:

| Kind | Shape |
|---|---|
| `anthropic` | `sk-ant-[A-Za-z0-9_-]{20,}` |
| `strata` | `strata_[0-9a-z]{32,}` |
| `jwt` | `eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` |
| `bearer` | `(?i)(authorization:\s*(bearer|basic)\s+|bearer\s+)\S{16,}` |
| `pem` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` … `-----END …-----` |
| `assignment` | `(?i)\b[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"']{8,}` (value replaced, name kept) |
| `json-secret` | `"(access_token|refresh_token|id_token|api_key|app_secret|client_secret)"\s*:\s*"[^"]{8,}"` (value replaced) |
| `hex64` | `\b[0-9a-f]{64,}\b` (OpenRig tokens; 40-char git SHAs are kept) |
| `opaque` | a run of `[A-Za-z0-9._@~+/=%-]` of length >= 40 that contains an upper-case letter, a lower-case letter and a digit, and is not a path or URL (Schwab API key/secret and access/refresh tokens have this shape) |

Tests use synthesized fake values of each shape, never real ones.

**Rulings from review T4** (2026-10-28):
- Prefixed kinds (`anthropic`, `strata`, `jwt`) match their body lazily and stop
  before the next occurrence of their own prefix, so two secrets glued together
  are two matches and neither body survives.
- `opaque` skips only the scheme and host of a URL; each path segment and query
  value is still checked, so `https://host/<token>` is redacted.
- `json-secret` keys match case-insensitively.
- A protocol-relative URL (`//host/...`) is a URL: only `//host` is skipped and
  its path is checked like any other URL.
- **Accepted gap:** two secrets of *different* kinds glued with no separator
  (e.g. `sk-ant-<tail>API_KEY=<value>`): the first kind's body can absorb the
  second's name and leave a short value visible; long values are still caught
  by `opaque`. Contrived input; cross-kind lookahead or fixed-point iteration is
  rejected for v0.1 as complexity without a realistic case (review T4-fix F-2).
- A sender must have one of the daemon's forms: `<local>@<rig>`, `daemon@kernel`,
  `system:<x>`, `<unknown sender>`. Anything else (e.g. a bare `From: owner`) in a
  well-formed envelope is `unknown-sender`.

**Encoded secrets (review T4 planning).** No decoding pass. Coverage comes from
shapes: `sk-ant-`, `strata_`, hex and JWT characters are unchanged by URL
encoding; `%` is in the `opaque` class so a percent-encoded token (e.g. `@` as
`%40`) stays one run; base64 of a secret of 30+ bytes is a 40+ char mixed-case
run and falls to `opaque`. `Authorization: Basic` is covered by `bearer`.
Shorter encoded secrets can be missed; decode-then-scan is rejected for v0.1
(cost and false positives on every base64 blob) and revisited if the pilot
finds a miss.

## Consequences

- A seat's memory of who said what follows the daemon-stamped sender. The owner
  could type a fake envelope by hand into a seat; we accept that (the owner is
  trusted, and a pasted envelope is rare and visible).
- `opaque` will also redact some long base64 blobs and hashes. Over-redaction
  costs a little memory; under-redaction leaks a secret into a shared store.
- Changing peer naming later orphans existing representations, so this naming is
  fixed before the pilot.

## Rejected

- **Attribute by which terminal received the prompt** (claude-honcho's model):
  the bug this project exists to fix.
- **A peer-id map in env.** Derivable from the header; a map is one more thing to
  drift.
- **Redacting with known secret values.** Requires reading secrets into the
  plugin; forbidden.
