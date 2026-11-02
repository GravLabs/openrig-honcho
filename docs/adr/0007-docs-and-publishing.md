# ADR-0007: Design doc, README, release sequence and publishing

Status: accepted (2026-10-28, design.architect), at the owner's request.

## Context

The owner asked that, after v0.1, the project gets a clean design document with
diagrams and a clear main README, modelled on similar repos, and authorised
publishing to the team's internal Git server. That replaces the brief's
"local git only" for this one host.

## Decision

**When.** After the v0.1 gate passes (`bun run gate`) and before the release is
handed to the operator. Task T10 in the plan.

**Design doc**: `docs/DESIGN.md`, one document, with diagrams in Mermaid (the Git
host renders it; diffable text, no image files to drift):
1. Problem and goals (why not claude-honcho, in a paragraph).
2. The model: OpenRig -> Honcho mapping (table + diagram).
3. Data flow: a `rig send` from seat A to seat B through the hooks to Honcho
   (sequence diagram), and session start (sequence diagram).
4. Missions, sessions and scopes over time (diagram).
5. Attribution and redaction pipeline (flowchart: unwrap -> classify ->
   redact -> chunk -> spool/send).
6. Failure behaviour: outage, timeout, duplicate rule (state diagram of a write).
7. Security and privacy boundaries (who can write where; profile workspace).
8. Observability: log line, counters, `status`.
9. Configuration reference (env table) and the rig-spec snippet.
10. Decision index linking ADR-0001..N; known limits and v0.2 list.
Facts in it are taken from the ADRs and the code, not restated from memory; each
section links its ADR.

**README**: short and task-first, in the style of `reference/claude-honcho` and
`reference/pi-honcho`: what it is (two sentences), how it differs from
claude-honcho, quick start for a rig (spec snippet + env), the `rig_memory`
tools, `status`, troubleshooting, development (`bun test`, `bun run gate`), link
to DESIGN.md and the ADRs. No personal names (owner role only).

**Publishing.**
- The repo lives on the team's internal Git server, readable on the LAN, so the
  secret scan before each push is the only barrier: nothing is pushed without
  it passing.
- Before every push: the gate's secret scan passes, `reference/` and local
  settings files are confirmed ignored, and no untracked file is added by the
  push step.
- The vendored `.claude/skills/honcho-integrate` keeps its upstream license
  file; if it has none, it is removed from the published tree and referenced
  instead.

**Release sequence.** (1) Release tooling and LATENCY.md are committed. (2) One
full `bun run gate` passes on that commit (`gate-report.json`: every step PASS,
`cleanTree` true, commit = HEAD). (3) `scripts/release.ts <version>` refuses
unless that holds, then writes `release/v<version>/` (plugin copy, SHA256SUMS)
and records the gated commit in `release/v<version>/GATED_COMMIT`. (4) That
change is committed and tagged `v<version>`. The tagged commit may differ from
the gated one only under `release/`; the architect checks
`git diff --stat <gated> <tagged>` touches nothing else before tagging.

**Secret scan precision (amends ADR-0006 X6).** The gate fails on the
high-confidence kinds (`anthropic`, `strata`, `jwt`, `pem`, `hex64`, `opaque`,
`json-secret`). `assignment` and `bearer` matches whose value is code (contains
`(`, `[`, `.`, `$`, `{`, or is a quoted env-var name) are listed for review, not
failed; any other `assignment`/`bearer` match fails. Zones: under `.claude/skills/` (vendored upstream docs) every match is listed,
not failed. Under `tests/`, a high-confidence match passes only on a line that
carries the marker `fake-secret` (e.g. a trailing `// fake-secret` comment on a
synthesized test value); any unmarked match there fails, so a real secret pasted
into a test by accident is caught. Everywhere else the rule above applies.
Reason: the tracked
honcho-integrate examples and our own env code (`api_key=os.environ[...]`,
``Bearer ${opts.apiKey}``) match the shape without containing a secret.

## Consequences

- One push target, internal only. Anything beyond it (GitHub, npm) still
  needs the owner.
- The design doc is a deliverable with its own review: `review` checks every
  claim in it against the code or an ADR.

## Rejected

- **Diagrams as PNG/SVG files.** They drift from the code and can't be diffed.
- **A wiki instead of DESIGN.md.** Lives outside the repo and the release copy.

Ruling 2026-10-30 (v0.1.2, T13a): `release.ts` refuses if `plugin/` holds any
untracked or ignored file (`git status --porcelain --ignored plugin`), and the
copy's file set must equal `git ls-files plugin` with identical bytes. The gate
tested tracked files; nothing else may ship.
Also: `release.ts` refuses if `plugin/` holds any symlink, tracked
(`git ls-files -s`, mode 120000) or not; the plugin has none and the copy check
and SHA256SUMS only cover regular files.

## Amendment 2026-11-02: public release on GitHub

The owner approved publishing the project publicly on GitHub under the MIT
license. The published repository starts from one fresh commit of the scrubbed
tree (no internal hostnames, addresses, paths or personal names), tagged with
the current release. The internal server keeps the full development history.
The published tree leaves out the team's own working files (seat settings, the
original brief and plans, vendored release copies); releases are git tags.
