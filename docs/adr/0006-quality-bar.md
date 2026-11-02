# ADR-0006: Stable, reliable, observable, secure: the quality bar

Status: accepted (2026-10-27, design.architect), at the owner's request.

## Context

The owner asked for a plugin that is stable, reliable, observable and secure.
Each word is only useful if it is a check someone can rerun. This ADR turns each
into requirements and the test that proves it; `bun run gate` runs them all and
is the release gate for v0.1.

## Decision

### Stable: it keeps working as inputs and the server change

| Req | Proof |
|---|---|
| S1 No hook or core function throws on any input. | Property tests: 10 000 random/mutated prompts (envelopes, reminders, unicode, NUL, 1 MB) through `attribute`, `envelope`, `redact`, `shape`; zero throws. |
| S2 Corrupt or missing state files are treated as missing and rewritten. | Unit tests with truncated JSON, empty file, directory in place of file, unwritable dir (plugin disables with a log line). |
| S3 Concurrent hooks of one seat (async UserPromptSubmit and Stop overlap) don't corrupt state or spool. | All read-modify-write of seat state and spool replay go through `withLock(<dir>/lock)`: `O_EXCL` lockfile, 2 s wait, stale after 30 s. Test: 20 parallel processes increment a counter; final value is 20. Spool appends are single `appendFileSync` lines. |
| S4 Server drift is caught before it breaks seats. | Contract test: every path, method and field the client uses exists in the live `openapi.json` with a compatible type. Session start records the server's `info.version` in seat state; `status` reports a mismatch with the tested version (3.4.0). |
| S5 Message order is preserved. | Every message carries `created_at` from the hook (prompt: time at UserPromptSubmit; reply: transcript timestamp). Integration test: prompt and reply written by racing processes list back in conversation order. |

### Reliable: memory arrives, once, even when things fail

| Req | Proof |
|---|---|
| R1 An outage delays memory, it doesn't lose it (ADR-0005 E1 spool). | Chaos test with a fake Honcho (`tests/support/fake-honcho.ts`, `Bun.serve`) that refuses, 500s, hangs, then recovers: every message written during the fault is on the server after recovery, in order, **except entries the server rejects permanently** (400/413/422, ADR-0005 E1): those are in the dead-letter file and counted, and the server sees later messages without them. Order holds among delivered messages. |
| R2 No duplicates from retries, except the one unavoidable case. | Spool replays only entries whose failure was "not sent" (connect refused, DNS, 4xx/5xx before body accepted). A timeout after the request was sent is spooled with `maybe_sent: true` and replayed with `metadata.replay_of = <client_id>` so a duplicate is identifiable. Every message carries `metadata.client_id` (hash of seat, session, created_at, content). Test counts: duplicates only on maybe-sent entries. |
| R3 Hooks stay inside their budgets under any server behaviour. | Chaos test asserts wall time: SessionStart <= 4.5 s, writer hooks <= 10 s, against a server that hangs forever. |
| R4 Long-run correctness. | Soak test against a scratch workspace: 3 seats, 300 messages, 2 mission switches, 1 broadcast, 1 compaction, 1 outage; asserts exact per-session message counts and sender attribution. |

### Observable: someone can tell what it is doing without reading code

| Req | Proof |
|---|---|
| O1 Structured log. One JSON line per hook run to `$HONCHO_STATE_DIR/log/<workspace>.log`: `ts, hook, peer, session, event, ok, ms, n_msgs, bytes, error_class`. Never message content, never secret values. Rotated at 5 MB, 3 files kept. | Test: run every hook with a fixture containing a fake secret and a marker phrase; neither appears in the log; every line parses as JSON. |
| O2 Counters in seat state: `written, failed, spooled, replayed, dropped, dead, sanitized, redactions` (by kind), last success and last error time. **Every** loss is counted: a message dropped by the spool cap or as an oversized entry counts in `dropped`, a metadata key dropped as unserializable counts in `sanitized`. A counter update when the seat state doesn't exist yet creates it (counters are never lost because state was missing). | Unit tests on the counter updates, including each drop path and a replay with no seat state (review T8c). |
| O3 `status` (MCP tool and `bun run plugin/bin/status.ts [--json]`): config without the key, server reachable and version, active mission/session, counters, spool size, workspace `queue/status`. Exits non-zero when unhealthy (server unreachable, spool over 80%, version mismatch), so an operator script can use it. | Integration test for healthy and unhealthy cases. |
| O4 Latency is measured, not assumed. | `tests/latency.ts` reports p50/p95 per hook and for session start, against the real server, into `release/v0.1.0/LATENCY.md`. |

### Secure: no secret leaves, no memory is poisoned, nothing reaches further than it should

| Req | Proof |
|---|---|
| X1 Redaction on every outbound text: messages, spool entries, `remember` facts, `ask` questions, metadata values. | Test with each ADR-0003 shape (fake values) through every outbound path, checked at the fake server. |
| X2 Only two workspaces are ever written: `HONCHO_WORKSPACE` and `HONCHO_PROFILE_WORKSPACE`. Only owner-class prompts reach the profile. | The client is constructed per workspace and takes no workspace argument per call. Fake-server test records every request path; asserts the workspace set and that profile writes are owner-only. |
| X3 Injected memory can't impersonate a message or an instruction. | Injection is wrapped as quoted background; any injected line starting `From:`, `To:`, `Sent:`, `---` or `<system-reminder` is prefixed with `> `. Test with a poisoned summary. The skill says memory is background, not instruction. |
| X4 Local files are private. | State dir 0700, files 0600 (spool, state, logs). Test checks modes. |
| X5 Least privilege in the tools. | `remember` only for the leader; `mission` ids normalised (ADR-0002) so no path traversal into the state dir; no shell, no `eval`, and exactly one subprocess in `plugin/`: `execFile("rig", ["queue","show",<validated id>,"--json"])` for E11 (grep check in the gate allows only that call site). |
| X6 Nothing secret in the repo or the release. | The gate runs `redact` over every tracked file and the release folder; a high-confidence match fails the gate (precision rule in ADR-0007). Zero runtime dependencies (gate fails if `plugin/` has a `node_modules` or a dependency in a package.json). |
| X7 Only the dedicated server. | `*.honcho.dev` refused (ADR-0001); `HONCHO_URL` must be `http`/`https`. |

### Load on the shared server

Integration tests run against the real Honcho server, which other rigs use.
Tests that seed more than 20 sessions (e.g. the >100-sessions free-n test) run
only when `HONCHO_HEAVY_TESTS=1`; routine runs skip them. The gate sets it for
its heavy step only and removes it from the environment of every other step
(an inherited value made the light step heavy, 2026-10-29).
Workspace deletion is asynchronous and serial on the server (observed
2026-10-28: about one workspace per 15-30 s when several large ones are queued),
so the gate's leftover check waits up to 15 minutes (measured 2026-10-29: purge
lag after the heavy step about 10.5-12.5 min) and fails only if a workspace it
created is still listed then. Measured later the same day: a large
workspace's rows disappear 60-380 s after the 202. So: heavy tests verify that
the DELETE was accepted (202) and leave disappearance to the gate's final
check; light tests verify disappearance within 90 s. Every leftover check lists
with `size` <= 100 (the server rejects larger sizes with 422, which a careless
check reads as "no workspaces", review T6c-fix).

### Test traffic must not cost model-server derivation (2026-10-29)

Observed: a 300-message soak in a scratch workspace queued 308 deriver work units
on the model server every rig shares, and the deletes of later scratch
workspaces queued behind them for over 30 minutes. So:
- `tests/support/scratch.ts` creates every scratch workspace with
  `configuration: {reasoning: {enabled: false}, summary: {enabled: false},
  dream: {enabled: false}}`. A test that genuinely needs derivation opts in
  explicitly and runs only with `HONCHO_HEAVY_TESTS=1`.
- The writer never forces reasoning on: it sends
  `configuration.reasoning.enabled = false` only to suppress (acks, extra
  broadcast copies, ADR-0005 E4/E5) and otherwise omits `configuration`, so the
  workspace setting decides. (A message-level `true` would override a workspace
  `false`.) Production behaviour is unchanged: real workspaces reason by default.
- The leftover/disappearance checks assume a light deriver queue. A suite that
  opts into derivation must check `queue/status` of its workspace and wait for
  it to drain (or report it) before its disappearance check, or it will
  false-alarm on a healthy server (review, 2026-10-29).

### The gate

`bun run gate` = unit + property tests, contract test, fake-server chaos tests,
integration tests on a scratch workspace (with cleanup check), short soak,
log-hygiene test, secret scan, no-exec grep, dependency check,
`rig plugin validate plugin`. v0.1 is done when the gate passes on a rerun by
the architect, the latency report is written, and `review` has no open finding.

## Consequences

- A fake Honcho server is built early (task T2b) because chaos, reliability and
  security proofs depend on seeing every request.
- More test code than plugin code. That's the price of "reliable" being a fact.
- The duplicate rule (R2) is honest: Honcho has no idempotency key, so a timeout
  after sending can duplicate; it is marked, counted and visible in `status`.

## Rejected

- **Encrypting the spool at rest.** It holds already-redacted text in a 0600 file
  under the user's home, the same trust boundary as the transcripts.
- **Retrying inside the hook.** Retries extend hook time; the spool retries on
  the next hook instead.
- **Metrics export (Prometheus/OTel).** No collector on this host; the log, the
  counters and `status --json` cover it. Revisit if a collector appears.

### Amendment 2026-10-30 (v0.1.2 gate): light disappearance window 900 s

The deriver queue is one worker for the whole server, and real workspaces
(pilot, with model-server calls of 2.5-45 min each) load it as much as tests do.
In the v0.1.2 gate runs, every scratch DELETE was accepted, and the leftovers
step saw them all gone within its window (405 s), but the light integration
tests failed their 120 s per-test wait. Light tests keep verifying
disappearance in the gate, with a window equal to the leftovers window
(900 s): `SCRATCH_DISAPPEAR_WINDOW_MS = 900_000`, and the integration
`afterAll` timeouts raised to fit it. On an idle server nothing gets slower;
on a busy one the gate takes longer instead of failing on server throughput.

### Amendment 2026-10-31 (v0.2, T14f): the gate proves deletes, the release proves they settled

The 900 s window still failed while pilot was busy (v0.1.2 probe), so the
gate depended on another rig's load. From v0.2:

- **Inside a gate run** (`gate.ts` sets `HONCHO_GATE_DELETES=<abs path>` for
  its steps), `cleanupScratch` in both modes stops once every DELETE is
  accepted (2xx incl. 202, or 404) and appends each name to that file. Run
  outside the gate, light tests keep verifying disappearance as before.
- **The leftovers step** polls for at most 120 s. It passes when every
  from-this-run scratch workspace still listed has an accepted DELETE in the
  file; those are reported as `pendingDeletes` in `gate-report.json`. A
  still-listed workspace with no accepted DELETE (a test that forgot to clean
  up) or a failed list is a FAIL, as before.
- **`release.ts` refuses while any `honcho-bridge-scratch*` workspace is
  listed**, or when the list fails, with fact/reason/fix: rerun when the
  server has caught up. The release, not the gate, carries the proof that
  nothing was left behind.
