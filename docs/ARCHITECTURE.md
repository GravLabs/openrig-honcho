# openrig-honcho architecture

The design at a glance. For how each part works in detail, see
[DESIGN.md](DESIGN.md). For the goal and the objectives, see
[STRATEGY.md](STRATEGY.md).

A Claude Code plugin gives a team of agents shared memory on a self-hosted Honcho
server. The goal is a memory layer that lets the team improve itself: outcomes
come from outside the agent, lessons are proposed, and a gate decides what reaches
the team.

Snapshot: 2026-11-05, with version 0.3 in development.

## How the pieces connect

The plugin lives inside each seat as hooks and tools. Reads the seat waits for have
strict time budgets. Writes run in the background and spool to disk if the server
is down.

```mermaid
flowchart LR
  subgraph Seat["Seat (Claude Code)"]
    SS["session-start hook"]
    RC["recall hook"]
    WR["writer hooks"]
    TL["rig_memory tools"]
    SP[("local spool and logs")]
  end
  subgraph Honcho["Honcho server"]
    API["API"]
    PG[("Postgres with pgvector")]
    DR["deriver and dreamer<br/>(one worker)"]
  end
  subgraph Models["Shared model host"]
    EM["embeddings"]
    LLM["local LLM<br/>(thinking off for the deriver)"]
  end
  OR["OpenRig daemon<br/>work queue, outbox"]
  SS -- "reads, 4 s budget" --> API
  RC -- "3 queries, 2.5 s budget" --> API
  WR -- "messages, async" --> API
  WR -. "server down" .-> SP
  TL -- "search, ask, remember" --> API
  SS -- "live open work, read only" --> OR
  WR -- "sender check, read only" --> OR
  API --> PG
  DR -- "reads messages, stores facts" --> PG
  DR -- "extract facts" --> LLM
  API -- "embed queries" --> EM
```

Current state comes live from OpenRig, never from memory. The deriver runs in the
background, so a new fact appears some time after its message.

## When memory reaches a seat

Seats rarely look things up: one search in 2.5 days across 10 seats. So memory is
pushed at the moments it can change what a seat does.

| Moment | What the seat sees | Status |
|---|---|---|
| Startup, resume, compaction | Continuity digest, about 2 500 characters | v0.3 |
| Another seat writes | Recall, only what its transcript lacks; nothing if under 2 items | v0.3 |
| On demand | `search` and `ask` | Released |
| Before a risky action | Lessons matched to that action | v0.4 |

## How the digest is built

Each part comes from the source that owns it, in parallel, and a late or failed
part is left out. An approval for a queue item shows only if that item is in the
seat's own open work.

```mermaid
flowchart LR
  Q["OpenRig queue, live"] --> W["Your open work"]
  S["Session summary"] --> L["Where you left off"]
  P["Ledger pair"] -- "decisions, general approvals" --> D["Decisions in force"]
  P --> C{"Approval for one item:<br/>is it open here?"}
  C -- "yes" --> A["Approvals you hold"]
  C -- "no, or lookup failed" --> X["Left out completely"]
  Y["Scope query, newer than last seen"] --> Z["Since you were away"]
  M["Restore map path, local"] --> R["Pointer to the restore map"]
```

In a scenario test with an approval for a different item, seats published 5 of 5
times. With this check, they waited 5 of 5 times.

## Why a decision can be trusted

A fact in memory may be a paraphrase, a quote or a mistake. So authority comes from
where an entry is stored, never from what its text says. Only the leader's tools
write to the reserved pair, and it is the only place in-force views read.

```mermaid
flowchart LR
  LD["Leader:<br/>remember, retire"] -- "ledger entry" --> RP["Reserved pair:<br/>leader about openrig-ledger"]
  RP -- "only source" --> IF["In-force views:<br/>digest, ask"]
  LD -- "decision message" --> MS["Messages"]
  AS["Any seat:<br/>messages, quoted text"] --> MS
  MS --> DV["Deriver"]
  DV --> DF["Derived facts:<br/>recall, search"]
  DV -. "no write path" .-x RP
  DF -. "never in force" .-x IF
```

This closes a hole the v0.3 review proved: quoted text could fabricate an approval.
The move to the reserved pair is being built now.

## The learning loop

The store is not the hard part. A rig already has what most memory systems lack:
evidence from outside the agent. The loop is built on that evidence, because a
model grading its own work can spread a false lesson to the whole team.

```mermaid
flowchart LR
  T["Team acts"] --> O["Outcome log:<br/>closures, findings, tests"]
  O --> P["Propose a lesson<br/>(local model, with evidence)"]
  P --> R["Review:<br/>seat or owner"]
  R --> G{"Promotion gate:<br/>beats a baseline, no harm?"}
  G -- "pass" --> V["Live lesson:<br/>seat lore, small updates"]
  G -- "fail" --> A[("Archive")]
  V --> S["Shown before a risky action"]
  S --> T
  V -. "harm seen: roll back" .-> A
  subgraph Fixed["Outside the loop, never changed by it"]
    F["hard limits, authority rules,<br/>the tests that judge it, the gate"]
  end
```

The ideas come from ACE (itemized playbooks), ReasoningBank (learning from
failures), the Darwin Gödel Machine (evaluate before keeping) and Caura (outcome
rules), redesigned for this project and not copied. See
[MEMORY-LANDSCAPE.md](MEMORY-LANDSCAPE.md).

## Roadmap

Each release is judged on measured objectives before the next. The store decision
is made on evidence, by running other stores through the same tests.

```mermaid
flowchart LR
  V3["v0.3: resume and trust<br/>ledger, digest, quieter recall,<br/>routine messages skipped, scenario tests"]
  V4["v0.4: capture and deliver<br/>outcome log, lessons in seat lore,<br/>lessons before risky actions, trust classes"]
  V5["v0.5: learn safely<br/>proposed lessons, promotion gate,<br/>attack tests, store decision"]
  V6["v0.6: self-tuning<br/>under the same gate"]
  ST["Store test run:<br/>Caura, Hindsight, Graphiti, MemOS"]
  V3 --> V4 --> V5
  V5 -- "only if O7 and O8 held" --> V6
  V4 -.-> ST
  ST -. "evidence" .-> V5
```

Honcho stays until that test run says otherwise. The loop sits above the store, so
that work survives a change of store.

## What the tests have shown so far

Real sessions on the local model, 5 runs per arm, scored by fixed checks. The
samples are small, so these show direction, not proof.

| Test | Result |
|---|---|
| Resume an interrupted task, with the digest | 5 of 5 |
| Resume an interrupted task, with the old block | 2 of 5 |
| Act on an approval held for this item | 5 of 5 |
| Wait when no approval exists (control) | 5 of 5 |
| Wait when the approval is for another item, after the fix | 5 of 5 |

On the 45-question benchmark, the ledger took outdated items shown on decision
questions from 1 to 0, with no right answer lost. Full results are in
[EVALUATION.md](EVALUATION.md).
