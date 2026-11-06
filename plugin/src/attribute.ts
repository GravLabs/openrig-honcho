// Sender attribution (ADR-0003): decide WHO said a prompt. Pure - no env,
// files, stdin or network. Patterns below are re-typed from
// reference/claude-honcho/plugins/honcho/src/prompt-filters.ts (read, not
// imported) and from the daemon envelope surface (ADR-0003).

import { parseEnvelope, type To } from "./envelope.ts";
import { LEDGER_PEER } from "./ledger.ts";

export interface AttrCtx {
  /** This seat's peer id, e.g. "dev-build". */
  selfPeer: string;
  /** HONCHO_OWNER_PEER, e.g. "owner". */
  ownerPeer: string;
  /** This rig's name, e.g. "openrig-honcho". */
  rig: string;
  /** HONCHO_RECORD_AUTOMATION. */
  recordAutomation: boolean;
  /**
   * Optional injected check (hooks pass node:fs existsSync): does the absolute
   * path exist? claude-honcho's isSlashCommand distinguishes "/tmp is missing"
   * (path) from "/compact" (command) with existsSync("/" + name). Core stays
   * filesystem-free, so the hook injects it; absent, a slash-like prompt with
   * args is not treated as a command (conservative: worst case a command is
   * recorded, a typed path never is).
   */
  isExistingPath?: (absPath: string) => boolean;
}

export type Attribution =
  | { kind: "skip" }
  | {
      kind: "peer" | "owner" | "automation";
      peer: string;
      content: string;
      to?: To;
      fanout?: number;
      /**
       * ADR-0011 decision 3 (T16a): does the envelope From: session belong
       * to THIS rig? attribute() sets it only on the branches where the rig
       * is known: true is carried implicitly by absence (a same-rig envelope
       * sender keeps the pre-T16a shape), false means a cross-rig or external
       * sender. Never guessed from the peer id (local names may contain an
       * underscore).
       */
      sameRig?: boolean;
      /**
       * T16g F1 (architect ruling 18:55Z): the envelope From: resolved to
       * THIS rig's owner peer (From: <ownerPeer>@<this rig>). kind and peer
       * are unchanged for the writer; recallSender stands down on this the
       * same way it stands down for a prompt the owner typed. The owner
       * peer arrives via ctx (never a hard-coded name).
       */
      senderIsOwner?: boolean;
    };

export const AUTOMATION_PEER = "openrig";
export const UNKNOWN_SENDER_PEER = "unknown-sender";

/**
 * Confirmed un-enveloped automation prompt marker: the daemon's first prompt
 * on fresh/restore launch (daemon dist/domain/startup-orchestrator.js:937,
 * "OpenRig-generated identity context (not a project task):" ...
 * "End of generated identity context."). send_text startup files (role
 * guidance) ride inside this same prompt, so the prefix covers them.
 * Onboarding packs are guidance_merge FILES, never prompts
 * (rigspec-instantiator.js:2641-2656); queue nudges and wake text always
 * arrive enveloped (queue-nudge-text.js -> wrapPaneEnvelope); refocus is
 * skill-driven, no daemon prompt text found. So this is the only extra
 * marker T3 can honestly claim.
 */
const AUTOMATION_PREFIXES = ["OpenRig-generated identity context (not a project task):"];

// claude-honcho HARNESS_INJECTED_PATTERNS, re-typed.
const HARNESS_INJECTED_PATTERNS: RegExp[] = [
  /^<task-notification(?=[\s/>])/,
  /^<cross-session-message(?=[\s/>])/,
  /^<agent-message(?=[\s/>])/,
  /^<channel(?=[\s/>])/,
  /^<local-command-caveat(?=[\s/>])/,
  /^<local-command-stdout>/,
  /^<command-name>/,
  /^<command-message>/,
  /^<system-reminder(?=[\s/>])/,
  /^<bash-(stdout|stderr|input)>/,
  /^<<[\w-]+>>$/,
];

// Harness reminders prepended to a typed prompt (claude-honcho LEADING_REMINDERS).
const LEADING_REMINDERS =
  /^(?:\s*<system-reminder(?=[\s>])[^>]*>[\s\S]*?<\/system-reminder>)+\s*/;

// One whole-prompt paste block, matching ids, nothing outside it (ADR-0003
// "Unwrapping"). Text around it or a second block means no unwrap.
const PASTED_BLOCK = /^<pasted_content id="([^"]+)">([\s\S]*)<\/pasted_content id="\1">$/;

// Slash commands, mirroring claude-honcho's isSlashCommand: colon names are
// always commands; other names are commands unless "/" + name exists as a
// path (the ctx.isExistingPath injection; without it, only arg-less "/name"
// counts, so typed paths stay owner text).
const SLASH_COMMAND = /^\/([\w][\w:-]*)(?:\s|$)/;
const SLASH_COMMAND_ENVELOPE = /^<command-(name|message)>/;

function isSlashCommand(text: string, ctx: AttrCtx): boolean {
  if (SLASH_COMMAND_ENVELOPE.test(text)) return true;
  const m = SLASH_COMMAND.exec(text);
  if (!m) return false;
  const name = m[1];
  if (name.includes(":")) return true;
  if (ctx.isExistingPath) return !ctx.isExistingPath(`/${name}`);
  return text.trim() === `/${name}`;
}

function isHarnessContent(text: string, ctx: AttrCtx): boolean {
  return (
    isSlashCommand(text, ctx) || HARNESS_INJECTED_PATTERNS.some((p) => p.test(text))
  );
}

function isOpenRigSender(sender: string): boolean {
  return sender === "daemon@kernel" || sender.startsWith("system:");
}

// ADR-0003 "Derived ids are validated" (commit f4f4b4c): a peer id derived
// from a header must match ADR-0001's ^[A-Za-z0-9_-]{1,100}$; one that
// doesn't records as unknown-sender - it came through the envelope path, so
// it is not the owner and must never reach the profile workspace. The pattern
// mirrors env.ts ID_RE (that one validates config values; kept local so this
// module stays filesystem/env-free).
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function validateDerived(peer: string, ctx: AttrCtx): string {
  // ownerPeer arrives from validated config (ADR-0001 checked its shape at
  // load), so a name that equals it stays as-is.
  if (peer === ctx.ownerPeer) return peer;
  // T24 (ADR-0014 Amendment 2): the reserved ledger peer never takes a
  // message. A From: claiming it records as unknown-sender instead - it must
  // never land under that peer, or a leader observing the peer would seed
  // the ledger pair with derived conclusions (the writer's openrig handling
  // only stands down observation; here the NAME itself is the hazard).
  if (peer === LEDGER_PEER) return UNKNOWN_SENDER_PEER;
  return PEER_ID_RE.test(peer) ? peer : UNKNOWN_SENDER_PEER;
}

/**
 * ADR-0003 "Peer ids": session name -> peer id. Same rig -> local part;
 * other rig -> `<local>_<rig>`. Handles the general `<local>@<rig>` shape;
 * special senders (daemon@kernel, system:*, <unknown sender>, @external) are
 * resolved by attribute(), which knows the owner peer.
 */
export function peerIdFromSession(session: string, rig: string): string {
  const at = session.lastIndexOf("@");
  if (at <= 0) return session;
  const local = session.slice(0, at);
  const rigPart = session.slice(at + 1);
  if (rigPart === rig) return local;
  return `${local}_${rigPart}`;
}

/** Step 1 of attribute(), exported for the writer's outbox check (T16f):
 * strip leading harness reminders and whitespace - the same normalization
 * attribute() parses under. (Paste-unwrap is NOT applied here: the outbox
 * body is the raw typed prompt, so the writer compares raw against raw.) */
export function stripLeadingReminders(prompt: string): string {
  return prompt.replace(LEADING_REMINDERS, "").trim();
}

/**
 * The envelope From: classification (rulings edb8a30 sender forms), extracted
 * for reuse in T16f decision 3: a queue item's sourceSession is a sender
 * session of the same stamped forms, so the nudge override and the envelope
 * branch must derive the peer the SAME way - one implementation, no drift.
 */
export type HeaderSender =
  | { kind: "automation" }
  | { kind: "peer"; peer: string; sameRig?: boolean };

export function classifyEnvelopeSender(envFrom: string, ctx: AttrCtx): HeaderSender {
  if (isOpenRigSender(envFrom)) return { kind: "automation" };
  if (envFrom === "<unknown sender>") {
    return { kind: "peer", peer: UNKNOWN_SENDER_PEER };
  }
  if (envFrom.endsWith("@external")) {
    const name = envFrom.slice(0, -"@external".length);
    // The empty name is checked before joining: "ext-" would pass the id
    // regex on its own, but the ADR names `From: @external` explicitly as
    // unknown-sender.
    let peer: string;
    if (name === "") peer = UNKNOWN_SENDER_PEER;
    else if (name === ctx.ownerPeer) peer = ctx.ownerPeer;
    else peer = validateDerived(`ext-${name}`, ctx);
    // @external is not a seat of this rig (ADR-0011 decision 3); an
    // unresolvable name stays plain unknown-sender (rig UNKNOWN, not
    // known-foreign).
    return { kind: "peer", peer, ...(peer === UNKNOWN_SENDER_PEER ? {} : { sameRig: false }) };
  }
  // Rulings edb8a30 (sender forms): the daemon stamps senders in known
  // forms only - <local>@<rig>, daemon@kernel, system:<x>, <unknown sender>
  // (the latter three handled above). Anything else, e.g. a bare
  // "From: owner", was not daemon-stamped; it records as unknown-sender
  // rather than borrowing a real peer's id.
  if (!/^[^@\s]+@[^@\s]+$/.test(envFrom)) {
    return { kind: "peer", peer: UNKNOWN_SENDER_PEER };
  }
  // Rig membership from the From: session itself (ADR-0011 decision 3):
  // same-rig senders keep the pre-T16a shape (absent = same-rig); a
  // different rig part marks sameRig false so recall can stand down.
  const rigPart = envFrom.slice(envFrom.lastIndexOf("@") + 1);
  const peer = validateDerived(peerIdFromSession(envFrom, ctx.rig), ctx);
  return {
    kind: "peer",
    peer,
    ...(rigPart === ctx.rig || peer === UNKNOWN_SENDER_PEER ? {} : { sameRig: false }),
  };
}

/** Full classification pipeline (ADR-0003 "Classification"), in order. */
export function attribute(prompt: string, ctx: AttrCtx): Attribution {
  // 1. Strip leading harness reminders, then whitespace.
  let text = stripLeadingReminders(prompt);

  // 2. Unwrap a single whole-prompt paste block. The greedy backreference can
  // swallow two blocks that share an id, so the captured inner text must be
  // free of any further paste markup - an opening `<pasted_content id="` or a
  // `</pasted_content` closing inside means this is not exactly one block, and
  // ADR-0003 says two blocks are not unwrapped (review T3, F-1).
  const pasted = PASTED_BLOCK.exec(text);
  if (
    pasted &&
    !pasted[2].includes('<pasted_content id="') &&
    !pasted[2].includes("</pasted_content")
  ) {
    text = pasted[2].trim();
  }

  if (text === "") return { kind: "skip" };

  // 3. Harness content -> skip.
  if (isHarnessContent(text, ctx)) return { kind: "skip" };

  const automation = (content: string): Attribution =>
    ctx.recordAutomation
      ? { kind: "automation", peer: AUTOMATION_PEER, content }
      : { kind: "skip" };

  // 4. Well-formed envelope: the daemon-stamped sender decides.
  const env = parseEnvelope(text);
  if (env) {
    const base = { content: env.body, to: env.to, ...(env.fanout !== undefined ? { fanout: env.fanout } : {}) };
    const cls = classifyEnvelopeSender(env.from, ctx);
    if (cls.kind === "automation") return automation(env.body);
    return {
      kind: "peer",
      peer: cls.peer,
      ...(cls.sameRig !== undefined ? { sameRig: cls.sameRig } : {}),
      // T16g F1: a same-rig From: carrying the owner peer is the owner
      // speaking through a seat-shaped envelope - recall must not query
      // memory about them. A cross-rig owner keeps the not-rig skip.
      ...(cls.peer === ctx.ownerPeer && cls.sameRig === undefined ? { senderIsOwner: true } : {}),
      ...base,
    };
  }

  // 5. Known OpenRig automation without an envelope.
  if (AUTOMATION_PREFIXES.some((p) => text.startsWith(p))) return automation(text);

  // 6. Anything else: the owner typed it.
  return { kind: "owner", peer: ctx.ownerPeer, content: text };
}
