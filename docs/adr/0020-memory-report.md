# ADR-0020: The memory report

Status: accepted (2026-11-24, design.architect), on the owner's request.

## Context

The owner, 2026-11-24: "why does it seem like we only record approvals in memory? we need
concrete metrics and a way to vizualize the memory". The memory records far more than
approvals - on the busier pilot, 7,206 messages in 14 days, over 100,000 conclusions Honcho
derived from them, and a ledger of 181 entries of which 42 are approvals - but no surface
showed any of it. `status` reports health, the outcome collector prints per-seat counts to
a terminal, and the ledger is visible only through the digest and `search`. The owner
chose a local HTML file, with counts for everything plus ledger text, and one pilot whose data
must stay counts only.

## Decision

1. **One command, one page.** `bin/report.ts` writes a single self-contained HTML page
   per workspace (inline SVG and CSS, no script, no external request), default
   `<state dir>/report/<workspace>.html`, 0600 in a 0700 folder. It is run on purpose or
   by the operator's daily timer after the outcome collector; never from a hook.
2. **Five sections.** What the memory holds (messages recorded, conclusions derived,
   sessions, ledger entries by kind and state, conclusions per seat, pending stale
   proposals); how the seats use it (daily digests, prompt injections, claim pointers,
   search, ask, remember, retire and stale reviews, per seat and per day); whether work
   goes better with memory (rework and claim-to-close time for the claim pointer's
   holdout arms - the fair comparison - and for memory shown or not, labelled a trend;
   housekeeping rows left out); the ledger as a timeline (a dot per entry by kind, in
   force filled, lines to what it replaced, a cross where it was retired) with the
   entries in force; and health (hook runs, p50, p95, failures).
3. **Sources, read-only.** The plugin's own log, the outcome log, the stale file and the
   closed-rows file, locally; on the server, the ledger pair and the session and
   conclusion totals. No model call, nothing written to Honcho.
4. **What text may appear.** Only ledger text, redacted with the same rules as every
   outbound path and HTML-escaped, capped at 200 characters per entry. `--counts-only`
   writes no memory text at all (ids, kinds, seats, times and numbers); the operator runs
   the counts-only pilot with it. Messages and conclusions are never shown, only counted.

## Consequences

- The owner can see the memory and its use without reading logs; the outcome numbers
  are the usage data the v0.6 hold has waited for.
- The page is a local file holding ledger text: it inherits the state folder's privacy
  (0700/0600) and is never published.
- Honcho caps a reported total at 100,001; the page shows the server's number as given.
- The holdout arm is small on every pilot today (a handful of held rows), so the fair
  comparison will take weeks of data before it says anything; the page shows the row
  counts beside each share for that reason.

## Not doing

- A server or live dashboard; any script in the page; publishing the page.
- Showing message or conclusion text, or a browser over them.
- A model summary of the memory.
