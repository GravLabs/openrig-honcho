// The prompt writer (T6a): one UserPromptSubmit in, one Honcho write out.
// Order is fixed by the qitem (ADR-0002/0003/0005/0006): attribute -> replay
// the reply spool first (R1) -> resolve the session -> ENSURE it server-side
// (ADR-0002: never rely on implicit creation; the server auto-creates with no
// scope, so a message that races ahead of createSession lands unscooped) ->
// redact BEFORE chunking (E2) -> shape each chunk (E4/E5 reasoning, R2
// client_id) -> send or spool. Never throws (S1): every failure path ends in
// a log line and an Outcome, never an exception into the hook. Missing/corrupt
// seat state carries the ADR-0002 free-n rule (T6c-fix): one metadata-filtered
// sessions/list call gives this seat's newest n in the mission (with an
// unfiltered prefix scan when the filter is empty, since it only sees stamped
// sessions); if asking fails, n = current Unix seconds and the session
// metadata gets n_fallback: true (collision-free without state). Every session
// creation stamps {rig_peer, mission} so the filter can see it.
// T6b: recordBody is the SHARED pipeline the Stop reply writer (stop.ts)
// reuses; recordPrompt additionally mirrors owner-typed text to the profile
// workspace (ADR-0002 "Profile workspace") with its own client and spool.

import { existsSync } from "node:fs";
import {
  AUTOMATION_PEER,
  attribute,
  type Attribution,
  type AttrCtx,
  classifyEnvelopeSender,
  stripLeadingReminders,
  UNKNOWN_SENDER_PEER,
} from "./attribute.ts";
import { bodyMismatchShape, deliveryInWindow, fetchOutbox, fetchQueueItem, matchesOutboxEntry, trimTrailing } from "./daemon.ts";
import { parseEnvelope } from "./envelope.ts";
import { LEDGER_PEER } from "./ledger.ts";
import type { Config } from "./env.ts";
import { createClient } from "./honcho.ts";
import { withLock, writeJsonAtomic } from "./lock.ts";
import { errorClassFrom, logEvent } from "./log.ts";
import {
  missionIdIsSecretShaped,
  normalizeMission,
  readRigMission,
  readSeatState,
  resolveSession,
  seatLockDir,
  seatStatePath,
  setRigMission,
  type SeatState,
} from "./missions.ts";
import { redact } from "./redact.ts";
import { applyQueueMissionHint, qitemIdFromNudge } from "./nudge.ts";
import { chunk, clientId, isRoutine, reasoningFor } from "./shape.ts";
import { updateStats } from "./stats.ts";
import {
  replay,
  sendOrSpool,
  spoolAppend,
  type SpoolEnsure,
  type SpoolPaths,
} from "./spool.ts";
import type { HonchoClient, MessageInput, SessionPeerConfig } from "./honcho.ts";

export interface WriterDeps {
  client: HonchoClient;
  /** ISO timestamp source, injected so tests fix time. */
  now: () => string;
  /**
   * E11 injection point: the subprocess runner for `rig queue show <id>
   * --json`. Absent, nudge.ts makes the real execFile call - the only
   * subprocess in plugin/, ADR-0006 X5.
   */
  queueHintRun?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;
}

export type WriterOutcome =
  /** reason: "unexpected" = contained exception; "duplicate" = E3 dedupe skip;
   * "not-recorded" = attribution decided not to record (T14b-2: correct
   * behaviour, the log must not call it a failure) */
  | { action: "skipped"; reason?: "unexpected" | "duplicate" | "not-recorded" }
  | {
      action: "sent" | "spooled";
      session: string;
      peer: string;
      n_msgs: number;
      /** present on spooled: the O1 failure class (architect fix 19:50Z #2) */
      error_class?: string;
      /** T21 (E5b): present-when-true: the routine rule suppressed the
       * deriver for this write; the hook bins fold it into the run's single
       * event as routine: 1. */
      routine?: boolean;
      /**
       * T16f (ADR-0012 decision 2): the outbox verification result for a
       * peer-prompt write. Absent = no lookup attempted (no OPENRIG_URL -
       * deliberate, see promptSteps). The hook bin folds it into the run's
       * single event as the `verify` field (O1).
       */
      verify?: "verified" | "unverified" | "unchecked" | "self";
    };

const REPLAY_MAX = 50;
const REPLAY_DEADLINE_MS = 3000;
/** Page size for the free-n unfiltered scan. The real server caps page size
 * at 100 (probed 2026-10-28: size>100 -> 422), so 100 is the maximum. */
const FREE_N_PAGE_SIZE = 100;

/** n of a `<peer>--<mission>--<digits>` id, or null when the id is not ours. */
function parseMintedN(id: string, peer: string, mission: string): number | null {
  const prefix = `${peer}--${mission}--`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * ADR-0002 free-n (T6c-fix): the NEW n for a seat with missing state, or null
 * = could not ask the server (caller takes the epoch fallback). Primary is one
 * filtered call (rig_peer + mission metadata, newest first, size 1): since n
 * only grows, the newest tagged session holds the highest n. A metadata filter
 * can only see sessions that STAMP the tags (probed live 2026-10-28), so every
 * createSession below stamps {rig_peer, mission}. When the filter finds
 * nothing, one unfiltered newest-first page scans our id prefix instead of
 * minting 1 blind: a session created before stamping existed is invisible to
 * the filter, and minting an n that already exists would merge this write into
 * that old conversation (review T6c F-1's bug shape; its seeded sessions are
 * exactly such untagged ones).
 */
/** Exported for the SessionStart reader (T7b): it mints n exactly here. */
export async function freeN(
  client: HonchoClient,
  peer: string,
  mission: string,
): Promise<number | null> {
  const fr = await client.listSessions({
    filters: { metadata: { rig_peer: peer, mission } },
    reverse: true,
    size: 1,
  });
  if (!fr.ok) return null;
  const top = fr.data.items[0];
  const newest = top && typeof top.id === "string" ? parseMintedN(top.id, peer, mission) : null;
  if (newest !== null) return newest + 1;
  const ur = await client.listSessions({ reverse: true, size: FREE_N_PAGE_SIZE });
  if (!ur.ok) return null;
  let max = 0;
  for (const s of ur.data.items) {
    const n = typeof s.id === "string" ? parseMintedN(s.id, peer, mission) : null;
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

/**
 * ADR-0002 "never rely on implicit creation" (T6a; the ONLY ensure the code
 * has - recordBody and the T7b reader share it, they must not drift): create
 * the session server-side (base peers, scope, T6c-fix stamps) and/or add the
 * sender, then persist ensured_session/members under the seat lock. `ensure`
 * is the plan the spool replays; `failed` = a server call in it failed.
 * A reply/prompt sender !== self joins as an extra peer; automation and
 * unknown-sender are never observed (ADR-0002 peer table).
 */
export async function ensureSession(
  client: HonchoClient,
  config: Config,
  resolved: { session: string; mission: string; scope: string },
  pre: SeatState | null,
  sender: string,
  usedFallback: boolean,
): Promise<{
  ensure?: SpoolEnsure;
  failed: boolean;
  /** architect fix 19:50Z #2: the client kind/status of the failed probe */
  failedKind?: string;
  failedStatus?: number;
}> {
  const { stateDir, workspace } = config;
  const seatFile = seatStatePath(stateDir, workspace, config.peer);
  const session = resolved.session;
  // ADR-0002 peer table: openrig (automation) and unknown-sender are never
  // observed; every real sender observes this seat only. T24 (Amendment 2):
  // the reserved ledger peer is never observed either - defense in depth
  // behind attribute.ts's refusal to record anything under that name.
  const derivedSender =
    sender !== AUTOMATION_PEER && sender !== UNKNOWN_SENDER_PEER && sender !== LEDGER_PEER;
  const senderCfg: SessionPeerConfig = { observe_me: derivedSender, observe_others: false };
  const basePeers: Record<string, SessionPeerConfig> = {
    [config.ownerPeer]: { observe_me: true, observe_others: false },
    [config.peer]: { observe_me: true, observe_others: config.observeOthers },
  };
  // a reply's sender IS this seat: its own row (per config.observeOthers) wins
  if (sender !== config.peer) basePeers[sender] = senderCfg;
  const ensuredBefore = pre !== null && pre.ensured_session === session;
  const members = ensuredBefore && Array.isArray(pre.members) ? pre.members : [];
  const needsCreate = !ensuredBefore;
  const needsAddPeers = !needsCreate && sender !== config.peer && !members.includes(sender);
  if (!needsCreate && !needsAddPeers) return { failed: false };
  const ensure: SpoolEnsure = {
    create: {
      id: session,
      peers: basePeers,
      scopes: [resolved.scope],
      // ADR-0002 (T6c-fix): every session we create stamps its tags; the
      // free-n metadata filter is blind without them.
      metadata: {
        rig_peer: config.peer,
        mission: resolved.mission,
        ...(usedFallback ? { n_fallback: true } : {}),
      },
    },
    ...(needsAddPeers ? { addPeers: { [sender]: senderCfg } } : {}),
  };
  let failed = false;
  let failedKind: string | undefined;
  let failedStatus: number | undefined;
  if (needsCreate) {
    const c = await client.createSession(session, ensure.create);
    if (!c.ok) {
      failed = true;
      failedKind = c.kind;
      failedStatus = c.status;
    }
  }
  if (!failed && needsAddPeers) {
    const p = await client.addSessionPeers(session, { [sender]: senderCfg });
    if (!p.ok) {
      failed = true;
      failedKind = p.kind;
      failedStatus = p.status;
    }
  }
  if (!failed) {
    const newMembers = Array.from(new Set([...members, config.ownerPeer, config.peer, sender]));
    await withLock(seatLockDir(stateDir, workspace, config.peer), () => {
      const cur = readSeatState(seatFile);
      if (cur === null) return false; // vanished: nothing to record into
      return writeJsonAtomic(seatFile, {
        ...cur,
        ensured_session: session,
        members: newMembers,
      });
    });
  }
  return {
    ensure,
    failed,
    ...(failedKind !== undefined ? { failedKind } : {}),
    ...(failedStatus !== undefined ? { failedStatus } : {}),
  };
}

/**
 * One recorded write in the seat's rig workspace. Shared by the prompt hook
 * (attribute() output) and the Stop reply writer (stop.ts): replay-first,
 * free-n, ensure, redact-before-chunk, R2 ids, E4/E5 reasoning, send-or-spool.
 */
export interface RecordOpts {
  /** raw body; redaction runs inside (E2) */
  content: string;
  /** peer_id on every message (the sender this write is attributed to) */
  sender: string;
  /** metadata.kind: the attribute kind, or "reply" for Stop writes */
  kindTag: string;
  /** envelope To: value when the input was an envelope (dm/multi/broadcast) */
  to?: string[] | string;
  fanout?: number;
  /** claude conversation id when known; a reply has none (current session) */
  claudeSessionId?: string;
  /** log line prefix; defaults to the prompt hook */
  hookName?: string;
  /**
   * force reasoning ON regardless of the E4/E5 routing rule (T8-fix: the
   * remember decision message must reach the deriver even off-leader paths).
   */
  reasoningOverride?: boolean;
  /**
   * F1 (ADR-0006 S5, architect 22:25Z): the message's created_at. Replies
   * pass the transcript timestamp of the turn's last assistant text block;
   * undefined (prompts, or transcripts without timestamps) falls back to the
   * hook wall clock. client_id hashes this value (R2's definition); stats and
   * spool-time fields always use the wall clock.
   */
  createdAt?: string;
  /**
   * T16f (ADR-0012 decision 2, shadow mode): outbox verification result for
   * this write - true/false lands in message metadata as sender_verified;
   * absent means unchecked/no lookup, and metadata stays exactly as before.
   */
  senderVerified?: boolean;
  /** the matching outbox entry's id (metadata outbox_id), verified only */
  outboxId?: string;
  /**
   * T19a (ADR-0014 amendment): extra metadata for this write, spread after
   * the fixed keys (a key here wins, by design - only callers that know what
   * they are doing pass one). The remember/retire tools pass the ledger
   * fields (decision_id, decision_kind, ...) so the decision message carries
   * what the conclusion header carries. Absent: metadata stays exactly as
   * before for every existing caller.
   */
  extraMetadata?: Record<string, string | number | boolean>;
}

export async function recordBody(
  opts: RecordOpts,
  config: Config,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  const { stateDir, workspace } = config;
  const hook = opts.hookName ?? "user-prompt";
  const statsTs = deps.now(); // stats, last_seen, spool-at: wall clock, always
  const ts = opts.createdAt ?? statsTs; // message created_at (F1)

  // b. reply the spool first (oldest first, bounded): outage recovery
  const paths: SpoolPaths = { stateDir, workspace, peer: config.peer };
  const rep = await replay(paths, deps.client, {
    max: REPLAY_MAX,
    deadlineMs: Date.now() + REPLAY_DEADLINE_MS,
  });
  // O2 counters: replay outcomes fold into the seat stats (never throws).
  // O1 (architect fix 19:50Z #1): no plain-text narration lines - the class
  // lives in the counters and the run's single structured event.
  if (rep.sent > 0 || rep.dead > 0 || rep.deadDropped > 0 || rep.failed !== null) {
    await updateStats(stateDir, workspace, config.peer, (s) => {
      s.written += rep.sent;
      s.replayed += rep.sent;
      s.dead += rep.dead;
      s.dropped += rep.deadDropped;
      if (rep.sent > 0) s.last_ok_at = statsTs;
      if (rep.failed !== null) {
        s.last_error_at = statsTs;
        s.last_error_class = errorClassFrom(rep.failed.kind, rep.failed.status);
      }
    });
  }

  // c. resolve the session; free-n (ADR-0002) when seat state is missing
  const mission = normalizeMission(readRigMission(stateDir, workspace).mission);
  const seatFile = seatStatePath(stateDir, workspace, config.peer);
  const pre = readSeatState(seatFile);
  let initialN: number | undefined;
  let nFallback = false;
  if (pre === null) {
    const minted = await freeN(deps.client, config.peer, mission);
    if (minted !== null) {
      initialN = minted;
    } else {
      const sec = Math.floor(Date.parse(statsTs) / 1000);
      initialN = Number.isFinite(sec) && sec >= 1 ? sec : Math.floor(Date.now() / 1000);
      nFallback = true;
    }
  }
  const resolved = await resolveSession(stateDir, workspace, config.peer, {
    rigMission: mission,
    ...(opts.claudeSessionId !== undefined ? { claudeSessionId: opts.claudeSessionId } : {}),
    now: statsTs,
    ...(initialN !== undefined ? { initialN } : {}),
  });
  const session = resolved.session;
  // n_fallback only when the fallback value was actually taken as n
  const usedFallback = nFallback && initialN !== undefined && resolved.n === initialN;

  // d. ensure the session server-side (never rely on implicit creation)
  const sender = opts.sender;
  const {
    ensure,
    failed: ensureFailed,
    failedKind: ensureFailedKind,
    failedStatus: ensureFailedStatus,
  } = await ensureSession(
    deps.client,
    config,
    resolved,
    pre,
    sender,
    usedFallback,
  );

  // e. redact the WHOLE content, then chunk it (E2); shape each message.
  // O2: the per-kind redaction counts fold into the seat stats below.
  const red = redact(opts.content);
  const content = red.text;
  const chunks = chunk(content);
  const chunkId = clientId(config.peer, session, ts, content);
  let rKind: "dm" | "multi" | "broadcast" = "dm";
  let toIds: string[] = [];
  if (opts.to !== undefined) {
    if (Array.isArray(opts.to)) {
      toIds = opts.to.map((tok) =>
        tok.endsWith(`@${config.workspace}`) ? tok.slice(0, -(config.workspace.length + 1)) : tok,
      );
      if (toIds.length > 1) rKind = "multi";
    } else {
      rKind = "broadcast";
    }
  }
  // T21 (E5b): the routine rule FIRED = switch on and the text is routine
  // status (an ack that is also routine still counts as fired - both rules
  // suppress the same way). Rides the run's single event as routine: 1.
  const routineApplied = config.skipRoutine !== false && isRoutine(content);
  const reasoning =
    opts.reasoningOverride === true
      ? true
      : reasoningFor({
          kind: rKind,
          to: toIds,
          selfPeer: config.peer,
          senderPeer: sender,
          leaderPeer: config.leaderPeer,
          skipRoutine: config.skipRoutine !== false,
          content,
        });
  const messages: MessageInput[] = chunks.map((c, i) => ({
    peer_id: sender,
    content: c,
    created_at: ts,
    metadata: {
      client_id: clientId(config.peer, session, ts, c),
      kind: opts.kindTag,
      mission: resolved.mission,
      ...(chunks.length > 1 ? { chunk: { id: chunkId, i: i + 1, n: chunks.length } } : {}),
      ...(opts.fanout !== undefined ? { fanout: opts.fanout } : {}),
      // T16f (ADR-0012 decision 2): shadow-mode verification flags; absent
      // (unchecked / no lookup) leaves the metadata exactly pre-T16f.
      ...(opts.senderVerified !== undefined ? { sender_verified: opts.senderVerified } : {}),
      ...(opts.outboxId !== undefined ? { outbox_id: opts.outboxId } : {}),
      ...(opts.extraMetadata ?? {}),
    },
    // T8d-3 (ADR-0006 a2abdbd): a message configuration is sent ONLY to
    // suppress (acks, extra broadcast copies). When reasoning would be true,
    // `configuration` is omitted - the workspace default then decides, so a
    // deriver-disabled (scratch) workspace costs the model server nothing, and a real
    // workspace reasons as before.
    ...(reasoning ? {} : { configuration: { reasoning: { enabled: false } } }),
  }));

  // f. send, or spool the WHOLE write with its creation params
  if (ensureFailed) {
    await spoolAppend(paths, {
      session,
      messages,
      maybe_sent: false,
      at: statsTs,
      ...(ensure !== undefined ? { ensure } : {}),
    });
    await updateStats(stateDir, workspace, config.peer, (s) => {
      foldRedactions(s, red.counts);
      s.failed += 1;
      s.spooled += messages.length;
      s.last_error_at = statsTs;
      s.last_error_class = errorClassFrom(ensureFailedKind ?? "unknown", ensureFailedStatus);
    });
    return {
      action: "spooled",
      session,
      peer: sender,
      n_msgs: messages.length,
      error_class: errorClassFrom(ensureFailedKind ?? "unknown", ensureFailedStatus),
      ...(routineApplied ? { routine: true } : {}),
    };
  }
  const out = await sendOrSpool(paths, deps.client, session, messages, ensure);
  // O2 counters + the redaction tally, one locked update per write
  await updateStats(stateDir, workspace, config.peer, (s) => {
    foldRedactions(s, red.counts);
    if (out.result === "sent") {
      s.written += messages.length;
      s.last_ok_at = statsTs;
    } else {
      s.failed += 1;
      s.spooled += messages.length;
      // T8c-fix item 1: spoolAppend counts its own cap/oversized/sanitized
      // drops via updateStats - folding out.dropped here would double-count.
      s.last_error_at = statsTs;
      s.last_error_class = errorClassFrom(out.kind, out.status);
    }
  });
  return {
    action: out.result,
    session,
    peer: sender,
    n_msgs: messages.length,
    ...(out.result === "spooled"
      ? { error_class: errorClassFrom(out.kind, out.status) }
      : {}),
    ...(routineApplied ? { routine: true } : {}),
  };
}

/** Add this write's per-kind redaction counts into the seat stats (O2). */
function foldRedactions(s: { redactions: Record<string, number> }, counts: Record<string, number>): void {
  for (const [k, v] of Object.entries(counts)) {
    s.redactions[k] = (s.redactions[k] ?? 0) + v;
  }
}

/**
 * ADR-0002 "Profile workspace": owner-typed text ALSO lands in
 * <profileWorkspace>, session `<rig workspace>--<self peer>` (one per seat,
 * no scope), peer = ownerPeer, nothing else ever written there. Second
 * client for the second workspace (one client per workspace), its own spool
 * under workspace = profileWorkspace. Never throws into the caller.
 */
async function profileWrite(content: string, config: Config, deps: WriterDeps): Promise<void> {
  const profile = config.profileWorkspace;
  if (profile === null) return;
  try {
    const client = createClient({
      url: config.url,
      workspace: profile,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
    const paths: SpoolPaths = { stateDir: config.stateDir, workspace: profile, peer: config.peer };
    const rep = await replay(paths, client, {
      max: REPLAY_MAX,
      deadlineMs: Date.now() + REPLAY_DEADLINE_MS,
    });
    // O1: no plain-text lines in <profile>.log either (replay failure is
    // silent here; the profile seat has no counters of its own)
    void rep;
    const ts = deps.now();
    const session = `${config.workspace}--${config.peer}`;
    // ADR-0002 (T6c-fix): profile sessions are session creations too; they get
    // the same stamps (mission = the one active at creation; this session
    // spans missions and is never free-n'd, the tags are for inventory).
    const mission = normalizeMission(readRigMission(config.stateDir, config.workspace).mission);
    const ensure: SpoolEnsure = {
      create: {
        id: session,
        peers: { [config.ownerPeer]: { observe_me: true, observe_others: false } },
        metadata: { rig_peer: config.peer, mission },
      },
    };
    const c = await client.createSession(session, ensure.create);
    const red = redact(content).text;
    const chunks = chunk(red);
    // the owner profile mirrors owner-typed text: dm semantics (E5 acks skip)
    const reasoning = reasoningFor({
      kind: "dm",
      to: [],
      selfPeer: config.peer,
      senderPeer: config.ownerPeer,
      skipRoutine: config.skipRoutine !== false, // T21 (E5b)
      content: red,
    });
    const messages: MessageInput[] = chunks.map((ch) => ({
      peer_id: config.ownerPeer,
      content: ch,
      created_at: ts,
      metadata: { client_id: clientId(config.peer, session, ts, ch), kind: "owner" },
      // T8d-3: same wire rule as recordBody - configuration only to suppress;
      // omitted when reasoning is true (workspace default decides).
      ...(reasoning ? {} : { configuration: { reasoning: { enabled: false } } }),
    }));
    if (!c.ok) {
      await spoolAppend(paths, { session, messages, maybe_sent: false, at: ts, ensure });
      return;
    }
    await sendOrSpool(paths, client, session, messages, ensure);
  } catch {
    // O1/X1: class only - String(e) could echo message content into the log
    logEvent(
      { stateDir: config.stateDir, workspace: profile, peer: config.peer },
      { hook: "user-prompt", event: "profile-unexpected", ok: false, ms: 0, error_class: "other" },
    );
  }
}

async function promptSteps(
  input: { prompt: string; claudeSessionId?: string },
  config: Config,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  // a. attribution; skip means nothing is written at all. T14b-2 (ADR-0009):
  // the skip carries reason "not-recorded" so the hook bin logs it as ok:true -
  // the pilot's skipped/ok:false lines were exactly these, and
  // declining to record (empty text, harness content, automation off) is
  // correct behaviour, not a failure.
  const attrCtx: AttrCtx = {
    selfPeer: config.peer,
    ownerPeer: config.ownerPeer,
    // T16b item 6 (ADR-0011 decision 3): cfg.rig is loadConfig's single
    // derivation from OPENRIG_SESSION_NAME - the writer and recall always
    // attribute the same rig. Workspace only as the no-session-name fallback.
    rig: config.rig ?? config.workspace,
    recordAutomation: config.recordAutomation,
    isExistingPath: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
  };
  const attr = attribute(input.prompt ?? "", attrCtx);
  if (attr.kind === "skip") return { action: "skipped", reason: "not-recorded" };

  // T16f (ADR-0012 decision 3): a queue nudge carrying a qitem id takes its
  // sender from the queue item's sourceSession (transport-provenance; the
  // SAME peer derivation as the envelope branch, via classifyEnvelopeSender)
  // and, while the seat has no mission set, the item's mission:<x> tag
  // selects the mission (E11 mechanism: only while "general", set_by
  // "queue"). One 1 s daemon call, inside the hook's budgets (brief item 4).
  // A failed fetch leaves today's behaviour to the E11 fallback below.
  let eff: Attribution = attr;
  let nudgeResolved = false;
  if (eff.kind === "peer" || eff.kind === "automation") {
    // T16j F1+F2 (review VF1/VF1b): the sender override and the item-tag
    // mission selection below are keyed on THIS prompt's own envelope being
    // the OpenRig daemon, not on any body that quotes a nudge line. The
    // daemon senders are the ones attribute already classifies: daemon@kernel
    // and system:* arrive as kind "automation" (attribute.ts
    // isOpenRigSender), and a daemon@<this rig> nudge arrives as the same-rig
    // peer "daemon" (classifyEnvelopeSender <local>@<rig> branch, sameRig
    // absent). A peer that types or quotes a nudge body (VF1) never opens
    // the gate; neither does a foreign-rig daemon's envelope.
    const envelopeFromDaemon =
      eff.kind === "automation" ||
      (eff.kind === "peer" && eff.peer === "daemon" && eff.sameRig === undefined);
    const qid = qitemIdFromNudge(eff.content);
    if (qid !== null && config.daemonUrl !== undefined) {
      const item = await fetchQueueItem(config.daemonUrl, qid);
      if (item.ok) {
        nudgeResolved = true;
        if (envelopeFromDaemon && item.sourceSession !== undefined) {
          const cls = classifyEnvelopeSender(item.sourceSession, attrCtx);
          // F2: never across rigs - a foreign-rig sourceSession must not
          // pull its peer into this rig's memory (ADR-0011 d3: sameRig false
          // means another rig); the message then keeps today's handling.
          if (cls.kind === "peer" && cls.sameRig === undefined) {
            eff = {
              kind: "peer",
              peer: cls.peer,
              content: eff.content,
              ...(eff.to !== undefined ? { to: eff.to } : {}),
              ...(eff.fanout !== undefined ? { fanout: eff.fanout } : {}),
            };
          }
        }
        if (envelopeFromDaemon && readRigMission(config.stateDir, config.workspace).mission === "general") {
          const tag = item.tags.find((t) => t.startsWith("mission:") && t.slice(8) !== "");
          if (tag !== undefined) {
            // T16j VF2a: the tag id goes through the SAME secret-shape
            // refusal as mission(id) (missions.ts missionIdIsSecretShaped,
            // mcp.ts F-T8-3): a refused tag leaves the mission as it was
            // and is logged as event "refused" + error_class "refused"
            // (T8d-1 item 0) - reason class only, the tag value never
            // enters the log.
            const raw = tag.slice(8);
            if (missionIdIsSecretShaped(raw)) {
              logEvent(config, {
                hook: "user-prompt",
                event: "refused",
                ok: false,
                ms: 0,
                error_class: "refused",
              });
            } else {
              const m = normalizeMission(raw);
              if (m !== null) await setRigMission(config.stateDir, config.workspace, m, "queue");
            }
          }
        }
      }
    }
  }

  // E11 (brief item 2): queue handoff nudges arrive as peer messages; the
  // hint runs BEFORE the write, so the handoff message itself lands in the
  // hinted mission session. Silent no-op unless the qitem carries a
  // mission:<x> tag and the rig mission is still "general". T16f: this CLI
  // path is now the FALLBACK - it only runs when the daemon nudge fetch
  // above did not answer ("if the fetch fails, today's parsing applies").
  if (eff.kind === "peer" && !nudgeResolved) {
    await applyQueueMissionHint(eff.content, config, deps);
  }

  // T16f (ADR-0012 decision 2): outbox verification, SHADOW MODE - the
  // recorded sender never changes in this version. Raw against raw: the
  // outbox body is exactly what OpenRig typed into this pane (envelope
  // included), the prompt is what the hook received, so the header sender
  // is re-read from the prompt (stripLeadingReminders, the same step-1
  // normalization attribute() parses under; paste-wrapped prompts simply
  // do not match and land unverified - honest in shadow mode). One 1 s
  // call inside the budget. NO daemonUrl = no lookup AND no verify field:
  // an absent daemon must not restate itself on every peer prompt (flagged
  // to the architect as a wording deviation from "log sender-unchecked").
  let verify: "verified" | "unverified" | "unchecked" | "self" | undefined;
  let outboxId: string | undefined;
  if (eff.kind === "peer" && config.daemonUrl !== undefined) {
    const headerFrom = parseEnvelope(stripLeadingReminders(input.prompt ?? ""))?.from;
    if (headerFrom !== undefined) {
      if (config.sessionName === undefined) {
        verify = "unchecked"; // the destination cannot be proven
      } else {
        const res = await fetchOutbox(config.daemonUrl, headerFrom);
        if (res.ok) {
          const sessionName = config.sessionName;
          const hit = res.entries.find((e) =>
            matchesOutboxEntry(e, sessionName, input.prompt ?? "", deps.now()),
          );
          // T22: an envelope naming THIS seat is its own scheduled wake, not
          // a peer write - classify it "self" instead of blending it into
          // "verified". It still takes a matching daemon record (self to self,
          // exact body, fresh delivery): a claimed-from-myself prompt with no
          // record stays unverified, and a claim naming any OTHER seat runs
          // the ordinary path untouched.
          verify =
            hit === undefined
              ? "unverified"
              : headerFrom === config.sessionName
                ? "self"
                : "verified";
          if (hit !== undefined) outboxId = hit.outboxId;
          // T22b (architect 02:13Z 11-06): right sender (we fetched by it),
          // right destination and window, DIFFERENT body - log the shape of
          // the difference (counts + one character class, never text) to
          // settle the delivery-wrapper hypothesis. verify is unchanged:
          // a near-miss stays unverified, and nothing gains verification.
          if (hit === undefined) {
            const promptTrim = trimTrailing(input.prompt ?? "");
            const near = res.entries.find(
              (e) =>
                e.destinationSession === sessionName &&
                typeof e.body === "string" &&
                trimTrailing(e.body) !== promptTrim &&
                deliveryInWindow(e, deps.now()),
            );
            if (near !== undefined) {
              logEvent(config, {
                hook: "user-prompt",
                event: "outbox-shape",
                ok: true,
                ms: 0,
                ...bodyMismatchShape(trimTrailing(near.body as string), promptTrim),
              });
            }
          }
        } else {
          verify = "unchecked";
        }
      }
    }
  }

  const out = await recordBody(
    {
      content: eff.content,
      sender: eff.peer,
      kindTag: eff.kind,
      ...(eff.to !== undefined ? { to: eff.to } : {}),
      ...(eff.fanout !== undefined ? { fanout: eff.fanout } : {}),
      ...(input.claudeSessionId !== undefined ? { claudeSessionId: input.claudeSessionId } : {}),
      ...(verify === "verified" || verify === "self"
        ? { senderVerified: true, ...(outboxId !== undefined ? { outboxId } : {}) }
        : verify === "unverified"
          ? { senderVerified: false }
          : {}),
    },
    config,
    deps,
  );

  // T6b: owner text additionally mirrors to the profile workspace, and only it
  if (eff.kind === "owner" && config.profileWorkspace !== null) {
    await profileWrite(eff.content, config, deps);
  }
  if (verify === undefined || out.action === "skipped") return out;
  return { ...out, verify };
}

/** Entry point: never throws (S1); any escape becomes a log line + skipped. */
export async function recordPrompt(
  input: { prompt: string; claudeSessionId?: string },
  config: Config,
  deps: WriterDeps,
): Promise<WriterOutcome> {
  try {
    return await promptSteps(input, config, deps);
  } catch {
    // O1/X1: no String(e) (it could echo message content). This IS the run's
    // single event on this path - the hook bin suppresses its own when
    // reason === "unexpected".
    logEvent(config, { hook: "user-prompt", event: "unexpected", ok: false, ms: 0, error_class: "other" });
    return { action: "skipped", reason: "unexpected" };
  }
}
