// V2 (ADR-0019 decision 2): trust classes - the ONE mapping from the code
// path an item came from to the class the seat sees beside it. The class is
// set where the item is fetched, NEVER parsed from item text: a derived
// conclusion quoting "[authoritative]" stays derived. Every shown surface
// (the continuity digest, recall blocks, the claim pointer's titles, the MCP
// search/ask/status outputs) labels through this module so wording can never
// drift between files. Tags ride OUTSIDE content truncation (headings, dash
// lines, the status prefix line, title suffixes), so the O6 block budgets
// only pay the fixed short tag.
//
// Classes (ADR-0019 d2):
//   authoritative - OpenRig state (queue rows, outcome records, status) and
//                   the owner's approvals in the ledger;
//   recorded      - what a seat wrote: ledger decisions and status entries
//                   via remember, peer messages shown verbatim, the V1
//                   checkpoint, restore maps;
//   derived       - what a model produced: Honcho conclusions, session
//                   summaries, ask answers.

export type TrustClass = "authoritative" | "recorded" | "derived";

export type TrustSource =
  | "state"
  | "queue"
  | "outcome"
  | "approval"
  | "decision"
  | "status"
  | "message"
  | "checkpoint"
  | "restoreMap"
  | "conclusion"
  | "summary"
  | "ask"
  | "staleProposal";

const CLASSES: Record<TrustSource, TrustClass> = {
  state: "authoritative",
  queue: "authoritative",
  outcome: "authoritative",
  approval: "authoritative",
  decision: "recorded",
  status: "recorded",
  message: "recorded",
  checkpoint: "recorded",
  restoreMap: "recorded",
  conclusion: "derived",
  summary: "derived",
  ask: "derived",
  // V4: a model's stale proposal, shown until the lead seat decides - never
  // more than a proposal (ADR-0019 d4).
  staleProposal: "derived",
};

/** The class of a shown item, by its source code path. */
export function trustClass(src: TrustSource): TrustClass {
  return CLASSES[src];
}

/** The label suffix for a class: trailing, outside content truncation. */
export const classTag = (c: TrustClass): string => ` [${c}]`;

/** The label suffix for a source (trustClass + classTag). */
export const trustTag = (src: TrustSource): string => classTag(CLASSES[src]);
