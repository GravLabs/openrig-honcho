// Write spool (ADR-0005 E1 amended 2026-10-28 by architect's T5b-fix spec
// change; ADR-0006 R1/R2): a failed write is appended to
// <stateDir>/<workspace>/spool/<peer>.jsonl (0600, dir 0700) and replayed by
// a later hook, oldest first. Replay is a RENAME TAKEOVER with a single-
// replayer marker, never a rewrite of the live file (architect 12:54Z):
//   take spool/<peer>.replaying (O_EXCL lockdir, stale after 60 s; if another
//   replayer holds it, skip replay, don't wait) -> if a <peer>.replay.jsonl
//   is already there from a crash, drain THAT and leave the live file alone,
//   else rename live -> replay -> send oldest-first with no lock and no
//   marker semantics beyond staleness -> rewrite the REPLAY file with only
//   the unsent entries (delete when empty) -> release the marker.
// spoolAppend is a single O_APPEND write with no lock, so an append landing
// during a replay can never be erased (F-T5b-2 was exactly that loss). The
// seat lock is not used by the append itself; T8c-fix item 1 added a counted
// loss report through updateStats, which does take the seat lock and is a
// silent no-op while that lock is BUSY (architect 20:59Z; withLock's own
// 2 s poll is the only cost). An entry is at most 256 KB
// serialized - a multi-message write is split across entries; an entry that
// still can't fit (one over-large message) is dropped and counted, so the
// 5 MB/seat cap is exact up to the one-line append overshoot between trims.
// maybe_sent entries (timeout/parse/unknown) replay with metadata.replay_of
// = metadata.client_id (R2). A send failing HTTP 400/413/422 is PERMANENT
// (T5b-fix-2): that entry moves to <peer>.dead.jsonl (0600, 1 MB cap, oldest
// dropped and counted) and replay continues; every other failure - connect,
// timeout, any other status - stops replay and keeps the entry and everything
// after it, so a config or outage problem can never burn the backlog.
// Public functions never throw (S1); corrupt file
// or line = missing (S2); a peer id failing ^[A-Za-z0-9_-]{1,100}$ is an
// error result and never touches the filesystem.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ErrorKind, HonchoClient, MessageInput, SessionPeerConfig } from "./honcho.ts";
import { updateStats } from "./stats.ts";

/** E1: 5 MB per seat. */
export const SPOOL_MAX_BYTES = 5_000_000;
/** E1: an entry is at most 256 KB serialized. */
export const SPOOL_ENTRY_MAX_BYTES = 256 * 1024;
/** E1 (T5b-fix-2): dead-letter file cap per seat, 1 MB. */
export const SPOOL_DEAD_MAX_BYTES = 1_000_000;
/**
 * ADR-0005 E1 (T5b-fix-2): the ONLY statuses that dead-letter an entry -
 * the server understood the request and rejected it, so resending can never
 * succeed. 401/403/404 and everything else (408/429/5xx, connect, timeout)
 * are recoverable or ambiguous: stop and keep.
 */
const PERMANENT_STATUSES = new Set([400, 413, 422]);
/** The .replaying marker is stale after 60 s (crashed replayer takeover). */
const REPLAY_MARKER_STALE_MS = 60_000;

const PEER_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface SpoolPaths {
  stateDir: string;
  workspace: string;
  peer: string;
}

/**
 * ADR-0002 "Never rely on implicit session creation": a spooled write carries
 * the params its ensure needs, so replay runs createSession (get-or-create,
 * idempotent) and, when the sender was a later addition, addSessionPeers
 * BEFORE the messages.
 */
export interface SpoolEnsure {
  create: {
    id: string;
    peers: Record<string, SessionPeerConfig>;
    scopes?: string[];
    metadata?: Record<string, unknown>;
  };
  /** Added after createSession; keyed by the same session id. */
  addPeers?: Record<string, SessionPeerConfig>;
}

export interface SpoolEntry {
  session: string;
  /** MessageCreate shapes; each should carry metadata.client_id (R2). */
  messages: MessageInput[];
  maybe_sent: boolean;
  /** ISO timestamp of spooling */
  at: string;
  /** Session-ensure params for replay (T6a); absent = messages only. */
  ensure?: SpoolEnsure;
}

export interface ReplayResult {
  sent: number;
  /** entries still in the spool after this call (replay leftovers + live) */
  remaining: number;
  /** the server failure that stopped the replay, if one did */
  failed: { kind: ErrorKind; error: string; status?: number } | null;
  /** entries moved to the dead-letter file this call (permanent rejects) */
  dead: number;
  /** dead-letter lines dropped by the 1 MB dead cap on this call */
  deadDropped: number;
}

export type SendOutcome =
  | { result: "sent" }
  | {
      result: "spooled";
      maybe_sent: boolean;
      kind: ErrorKind;
      error: string;
      /** present when and only when kind === "http" (T8c: error_class detail) */
      status?: number;
      /** spool lines dropped by the 5 MB cap on this append */
      dropped: number;
    };

const spoolFile = (p: SpoolPaths): string => join(p.stateDir, p.workspace, "spool", `${p.peer}.jsonl`);
const replayFile = (p: SpoolPaths): string =>
  join(p.stateDir, p.workspace, "spool", `${p.peer}.replay.jsonl`);
const replayMarker = (p: SpoolPaths): string =>
  join(p.stateDir, p.workspace, "spool", `${p.peer}.replaying`);
const deadFile = (p: SpoolPaths): string =>
  join(p.stateDir, p.workspace, "spool", `${p.peer}.dead.jsonl`);

/** Item 6: the ONLY gate to the filesystem - a bad peer id never touches it. */
export function spoolPathsError(p: SpoolPaths): string | null {
  return PEER_RE.test(p.peer) ? null : `spool peer is not a valid id: ${p.peer}`;
}

/** Atomic rewrite of one spool file body (tmp + rename, 0600). Never throws. */
function writeLines(file: string, text: string): boolean {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    return false;
  }
}

const linesOf = (entries: SpoolEntry[]): string =>
  entries.length === 0 ? "" : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

/**
 * T5b-fix-2: move a permanently-rejected entry into the dead-letter file
 * (0600), trim to SPOOL_DEAD_MAX_BYTES dropping the oldest, and count drops.
 * Only ever called while holding the replay marker, so the append/trim pair
 * has no concurrent writer. Returns lines dropped by the cap. Never throws.
 */
function appendDead(dead: string, entry: SpoolEntry): number {
  try {
    const json = tryStringify(entry);
    if (json === null) return 0; // unserializable after replay read: lost, but nothing to keep
    mkdirSync(dirname(dead), { recursive: true, mode: 0o700 });
    appendFileSync(dead, `${json}\n`, { mode: 0o600 });
    let size = statSync(dead).size;
    if (size <= SPOOL_DEAD_MAX_BYTES) return 0;
    const lines = readFileSync(dead, "utf8").split("\n").filter((l) => l !== "");
    let dropped = 0;
    while (lines.length > 0 && size > SPOOL_DEAD_MAX_BYTES) {
      size -= Buffer.byteLength(`${lines.shift() as string}\n`, "utf8");
      dropped++;
    }
    writeLines(dead, lines.map((l) => `${l}\n`).join(""));
    return dropped;
  } catch {
    return 0; // S1
  }
}

/** S2: missing/corrupt file or line -> skipped; valid entries in file order. */
function readEntries(file: string): SpoolEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: SpoolEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e = JSON.parse(line) as SpoolEntry;
      if (e && typeof e === "object" && typeof e.session === "string" && Array.isArray(e.messages)) {
        out.push(e);
      }
    } catch {
      /* corrupt line: treated as missing (S2) */
    }
  }
  return out;
}

const countEntries = (file: string): number => readEntries(file).length;

/** Serialize, or null when a value is unserializable (circular etc.). */
function tryStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * F-T5b-4: a circular metadata value must not throw and must not lose the
 * message - drop the offending metadata KEYS (counted), keep the message.
 * An unserializable ensure metadata value is dropped the same way.
 */
function sanitizeEntry(entry: SpoolEntry): { entry: SpoolEntry; droppedKeys: number } {
  let droppedKeys = 0;
  const cleanMsg = (m: MessageInput): MessageInput => {
    if (m.metadata === undefined) return m;
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m.metadata)) {
      if (tryStringify(v) === null) droppedKeys++;
      else meta[k] = v;
    }
    return { ...m, metadata: meta };
  };
  let ensure = entry.ensure;
  if (ensure !== undefined && ensure.create.metadata !== undefined) {
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ensure.create.metadata)) {
      if (tryStringify(v) === null) droppedKeys++;
      else meta[k] = v;
    }
    ensure = { ...ensure, create: { ...ensure.create, metadata: meta } };
  }
  return {
    entry: { ...entry, messages: entry.messages.map(cleanMsg), ...(ensure !== undefined ? { ensure } : {}) },
    droppedKeys,
  };
}

/**
 * E1: split one write into entries of at most SPOOL_ENTRY_MAX_BYTES
 * serialized. A single message over that size can't be split - it is dropped
 * and counted (kept out of the file, so replay can never jam on it).
 */
function splitEntry(entry: SpoolEntry): { parts: SpoolEntry[]; droppedMessages: number } {
  const parts: SpoolEntry[] = [];
  let droppedMessages = 0;
  let cur: MessageInput[] = [];
  const curBytes = (): number => Buffer.byteLength(`${JSON.stringify({ ...entry, messages: cur })}\n`, "utf8");
  const flush = (): void => {
    if (cur.length > 0) {
      parts.push({ ...entry, messages: cur });
      cur = [];
    }
  };
  for (const m of entry.messages) {
    if (Buffer.byteLength(`${JSON.stringify(m)}\n`, "utf8") > SPOOL_ENTRY_MAX_BYTES) {
      droppedMessages++;
      continue;
    }
    cur.push(m);
    if (curBytes() > SPOOL_ENTRY_MAX_BYTES) {
      const last = cur.pop() as MessageInput;
      flush();
      cur.push(last);
    }
  }
  flush();
  // the whole-entry shell (session/at/ensure) could still tip a 256 KB part
  // over; drop the biggest part's last message until each part serializes in
  // budget (bounded: message-level size already checked above)
  const fits: SpoolEntry[] = [];
  for (const p of parts) {
    let msgs = p.messages;
    while (msgs.length > 1 && Buffer.byteLength(`${JSON.stringify({ ...p, messages: msgs })}\n`, "utf8") > SPOOL_ENTRY_MAX_BYTES) {
      msgs = msgs.slice(0, -1);
      droppedMessages++;
    }
    if (msgs.length === 1 && Buffer.byteLength(`${JSON.stringify({ ...p, messages: msgs })}\n`, "utf8") > SPOOL_ENTRY_MAX_BYTES) {
      droppedMessages++; // shell + one big message: drop it, count it
      continue;
    }
    if (msgs.length > 0) fits.push({ ...p, messages: msgs });
  }
  return { parts: fits, droppedMessages };
}

/**
 * Append one write: sanitize, split, then a single O_APPEND pass, no lock
 * (F-T5b-2: an append must survive a concurrent replay, and only appends
 * contend with each other now). Past the cap, oldest lines are trimmed and
 * counted. A bad peer is an error logged, not a filesystem touch.
 *
 * T8c-fix item 1 (decision changed from the T5 void): every loss is COUNTED
 * in the seat stats here, where it happens - cap trim and oversized-message
 * drops go to stats.dropped, unserializable metadata keys to stats.sanitized.
 * Counting inside spoolAppend (not in the writer's fold) covers direct
 * callers too; the writer no longer folds the return value.
 */
export async function spoolAppend(paths: SpoolPaths, entry: SpoolEntry): Promise<number> {
  try {
    // O1: no plain-text lines in <ws>.log - drops are COUNTED, never narrated.
    const pe = spoolPathsError(paths);
    if (pe !== null) return 0;
    const { entry: clean, droppedKeys } = sanitizeEntry(entry);
    const { parts, droppedMessages } = splitEntry(clean);
    // count BEFORE the parts.length === 0 return: an all-dropped write is
    // still a loss that must show up in the counters (T8c-fix)
    if (droppedKeys > 0 || droppedMessages > 0) {
      await updateStats(paths.stateDir, paths.workspace, paths.peer, (s) => {
        s.dropped += droppedMessages;
        s.sanitized += droppedKeys;
      });
    }
    const file = spoolFile(paths);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // the live path stays a 0600 file even when this write is dropped whole
    try {
      statSync(file);
    } catch {
      writeFileSync(file, "", { mode: 0o600 });
    }
    if (parts.length === 0) return 0;
    for (const part of parts) {
      const json = tryStringify(part);
      if (json === null) continue; // fully unserializable after sanitize: counted as lost
      appendFileSync(file, `${json}\n`, { mode: 0o600 });
    }
    // E1 cap trim (no lock: only concurrent same-seat appends can race the
    // read/rename here; the window is the read-to-rename gap, and the cap is
    // the architect's chosen trade against holding a lock over appends)
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return 0;
    }
    if (size <= SPOOL_MAX_BYTES) return 0;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    let dropped = 0;
    while (lines.length > 0 && size > SPOOL_MAX_BYTES) {
      size -= Buffer.byteLength(`${lines.shift() as string}\n`, "utf8");
      dropped++;
    }
    writeLines(file, lines.map((l) => `${l}\n`).join(""));
    // T8c-fix item 1: cap-trim losses count here, not in the writer's fold
    await updateStats(paths.stateDir, paths.workspace, paths.peer, (s) => {
      s.dropped += dropped;
    });
    return dropped;
  } catch {
    return 0; // S1
  }
}

/**
 * Take the single-replayer marker: an O_EXCL LOCKDIR (ADR-0005 E1 amended),
 * stale after 60 s -> steal once.
 */
function takeReplayer(marker: string): boolean {
  const mkdirOnce = (): boolean => {
    try {
      mkdirSync(marker, { mode: 0o700 });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") return false;
      throw e;
    }
  };
  try {
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
    if (mkdirOnce()) return true;
    let stale = false;
    try {
      stale = Date.now() - statSync(marker).mtimeMs > REPLAY_MARKER_STALE_MS;
    } catch {
      stale = true; // vanished between the two calls: retry once
    }
    if (!stale) return false;
    try {
      rmdirSync(marker);
    } catch {
      /* another stealer may already have replaced it; the mkdir below decides */
    }
    return mkdirOnce();
  } catch {
    return false;
  }
}

/**
 * Rename-takeover replay (see header): up to `max` (default 50) entries,
 * oldest first, stop at the first server failure or when deadlineMs has
 * passed (a deadline stop is not a failure). Crash leftovers in
 * <peer>.replay.jsonl are drained BEFORE the live file is taken, and the
 * live file is only taken once the leftovers are fully drained (otherwise
 * live entries would overtake older ones). An entry is removed from the
 * REPLAY file only after the server accepts it (R1); maybe_sent entries send
 * with metadata.replay_of = client_id (R2). The live file is never written:
 * appends during replay always survive. A MESSAGE send (addMessages) failing
 * 400/413/422 dead-letters just that entry and continues (T5b-fix-2); an
 * ensure failure or any other send failure stops and keeps. Ensure failures
 * stop even on those statuses: a wrong base URL or lost token must never
 * drain the backlog into the dead file.
 */
export async function replay(
  paths: SpoolPaths,
  client: HonchoClient,
  opts: { max?: number; deadlineMs?: number } = {},
): Promise<ReplayResult> {
  const max = opts.max === undefined ? 50 : Math.max(0, Math.trunc(opts.max));
  const pe = spoolPathsError(paths);
  if (pe !== null) {
    return { sent: 0, remaining: 0, failed: { kind: "unknown", error: pe }, dead: 0, deadDropped: 0 };
  }

  const live = spoolFile(paths);
  const rFile = replayFile(paths);
  const marker = replayMarker(paths);
  const deadPath = deadFile(paths);
  const remaining = (): number => countEntries(rFile) + countEntries(live);
  // no budget at all: touch nothing (no marker, no rename)
  if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
    return { sent: 0, remaining: remaining(), failed: null, dead: 0, deadDropped: 0 };
  }
  let took = false;
  try {
    took = takeReplayer(marker);
  } catch {
    took = false;
  }
  if (!took) {
    // another replayer is live: skip, don't wait (its run drains the spool)
    return { sent: 0, remaining: remaining(), failed: null, dead: 0, deadDropped: 0 };
  }

  let sent = 0;
  let dead = 0;
  let deadDropped = 0;
  try {
    let failed: ReplayResult["failed"] = null;
    let budget = max;
    // Entries that were already in the live file when this run started are
    // drained this run (oldest-first order across residue and live); an entry
    // APPENDED DURING the run stays live for the next hook - it must never be
    // chased into a slow send mid-run, and it survives untouched.
    const livePending = countEntries(live);
    let tookLive = false;
    for (let round = 0; round < 2 && budget > 0; round++) {
      // crash leftovers first; the live file is taken only when none remain
      if (!existsSync(rFile)) {
        if (tookLive || livePending === 0) break;
        try {
          renameSync(live, rFile);
          tookLive = true;
        } catch {
          break; // live absent or raced away: nothing to take
        }
      }
      const all = readEntries(rFile);
      let accepted = 0;
      for (let i = 0; i < Math.min(all.length, budget); i++) {
        if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) break;
        const e = all[i];
        // ADR-0002: ensure before messages - never rely on implicit creation
        if (e.ensure) {
          const c = await client.createSession(e.ensure.create.id, e.ensure.create);
          if (!c.ok) {
            failed = { kind: c.kind, error: c.error };
            break;
          }
          if (e.ensure.addPeers) {
            const p = await client.addSessionPeers(e.session, e.ensure.addPeers);
            if (!p.ok) {
              failed = { kind: p.kind, error: p.error };
              break;
            }
          }
        }
        const msgs = e.maybe_sent
          ? e.messages.map((m) => {
              const cid = (m.metadata as Record<string, unknown> | undefined)?.client_id;
              return typeof cid === "string"
                ? { ...m, metadata: { ...m.metadata, replay_of: cid } }
                : m;
            })
          : e.messages;
        const r = await client.addMessages(e.session, msgs);
        if (!r.ok) {
          if (r.kind === "http" && r.status !== undefined && PERMANENT_STATUSES.has(r.status)) {
            // poison (T5b-fix-2): the server rejected THIS entry's content;
            // resending can't help. Dead-letter it and keep going.
            deadDropped += appendDead(deadPath, e);
            dead++;
            accepted = i + 1; // consumed: neither sent nor kept
            continue;
          }
          failed = {
            kind: r.kind,
            error: r.error,
            ...(r.status !== undefined ? { status: r.status } : {}),
          };
          break;
        }
        sent++;
        accepted++;
      }
      budget -= accepted;
      // only the UNSENT entries persist, in the replay file (never the live one)
      const unsent = all.slice(accepted);
      if (unsent.length === 0) {
        try {
          unlinkSync(rFile);
        } catch {
          /* already gone */
        }
      } else {
        // rewrite failed -> entries stay in place and may re-send; R2 dedupes
        writeLines(rFile, linesOf(unsent));
        break; // leftovers first: never take live behind unsent entries
      }
    }
    if (!existsSync(rFile)) {
      // fully drained: keep the live path a stable 0600 file. O_EXCL - this
      // can only create an empty file, never truncate a concurrent append.
      try {
        writeFileSync(live, "", { flag: "wx", mode: 0o600 });
      } catch {
        /* exists or refused */
      }
    }
    return { sent, remaining: remaining(), failed, dead, deadDropped };
  } catch (e) {
    return {
      sent,
      remaining: remaining(),
      failed: { kind: "unknown", error: String(e) },
      dead,
      deadDropped,
    };
  } finally {
    try {
      rmdirSync(marker);
    } catch {
      /* S1 */
    }
  }
}

/**
 * Try one write; spool it on failure. maybe_sent per ADR-0006 R2:
 * connect/http -> false; timeout/parse/unknown -> true.
 */
export async function sendOrSpool(
  paths: SpoolPaths,
  client: HonchoClient,
  session: string,
  messages: MessageInput[],
  /** Carried into the spool entry on failure so replay can ensure first. */
  ensure?: SpoolEnsure,
): Promise<SendOutcome> {
  const r = await client.addMessages(session, messages);
  if (r.ok) return { result: "sent" };
  const maybeSent = r.kind === "timeout" || r.kind === "parse" || r.kind === "unknown";
  const pe = spoolPathsError(paths);
  if (pe !== null) {
    return {
      result: "spooled",
      maybe_sent: maybeSent,
      kind: r.kind,
      error: `${r.error} (cannot spool: ${pe})`,
      ...(r.status !== undefined ? { status: r.status } : {}),
      dropped: 0,
    };
  }
  const entry: SpoolEntry = {
    session,
    messages,
    maybe_sent: maybeSent,
    at: new Date().toISOString(),
    ...(ensure !== undefined ? { ensure } : {}),
  };
  const dropped = await spoolAppend(paths, entry);
  return {
    result: "spooled",
    maybe_sent: maybeSent,
    kind: r.kind,
    error: r.error,
    ...(r.status !== undefined ? { status: r.status } : {}),
    dropped,
  };
}
