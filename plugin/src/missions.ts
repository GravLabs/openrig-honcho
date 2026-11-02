// Missions, state files and session naming (ADR-0002). Pure: explicit paths
// and values only - no env, no network. Public functions never throw (S1);
// corrupt or missing state is treated as missing (S2). Locking per the
// architect ruling (2026-10-28 11:03Z, ADR-0002): mission.json is
// last-writer-wins via atomic rename with no lock; seat state is
// read-modify-written under a per-seat lock <stateDir>/<workspace>/
// seats/<peer>.lockdir (S3), so seats never contend with each other. Dirs
// 0700, files 0600 (X4, via lock.ts writeJsonAtomic).

import { join } from "node:path";
import { readJson, withLock, writeJsonAtomic } from "./lock.ts";
import { redact } from "./redact.ts";

export const GENERAL = "general";
const MISSION_MAX = 60;

export interface RigMission {
  mission: string;
  set_by: string | null;
  set_at: string | null;
}

/** The on-disk shape of <stateDir>/<workspace>/seats/<peer>.json (ADR-0002). */
export interface SeatState {
  mission: string;
  n: number;
  session: string;
  claude_session_id?: string;
  counters: Record<string, number>;
  last_seen: string;
  /** T6a (writer): the session whose existence+base peers the server confirmed. */
  ensured_session?: string;
  /** T6a (writer): peer ids known to be members of ensured_session. */
  members?: string[];
  /** T6b (Stop, E3): sha256 hex of the last recorded assistant segment. */
  last_reply_hash?: string;
  /** T8c (O2): seat counters, updated under the seat lock by stats.ts. */
  stats?: import("./stats.ts").SeatStats;
  /**
   * T16b (ADR-0011 decision 2): ISO time this seat's CURRENT context began
   * (SessionStart with source startup/clear/compact; resume leaves it).
   * recall drops items created at or after it. Absent = unknown: recall
   * falls back to the 30-minute rule. resolveSession carries it through
   * untouched (F2 rule: it owns its fields only).
   */
  context_start?: string;
}

/**
 * T16b (ADR-0011 decision 2): stamp context_start on the seat state under
 * the per-seat lock. A missing/corrupt state is LEFT MISSING - resolveSession
 * owns that file's identity fields (session/n/counters), and seeding a stub
 * here would collide with its first write; recall's 30-minute fallback
 * covers the gap. false = not written (absent state or lock busy/error).
 */
export async function setContextStart(
  stateDir: string,
  workspace: string,
  peer: string,
  isoNow: string,
): Promise<boolean> {
  const path = seatStatePath(stateDir, workspace, peer);
  const res = await withLock(seatLockDir(stateDir, workspace, peer), () => {
    const state = readSeatState(path);
    if (state === null) return false;
    return writeJsonAtomic(path, { ...state, context_start: isoNow });
  });
  return res.ok && res.value === true;
}

export interface ResolveInput {
  /** Current rig mission as read by readRigMission (normalised defensively). */
  rigMission: string;
  /**
   * SessionStart source (ADR-0002 "When a new Honcho session starts").
   * Writer hooks call resolveSession with no source.
   */
  source?: "startup" | "resume" | "clear" | "compact";
  claudeSessionId?: string;
  /** ISO timestamp for last_seen; defaults to now. */
  now?: string;
  /**
   * T6a (writer): n to start from when the seat state is MISSING/CORRUPT
   * (the ADR-0002 server free-n result). Ignored when valid state exists -
   * counters still decide there. Default (absent) = 1, exactly the T5 rule.
   */
  initialN?: number;
}

export interface ResolvedSession {
  session: string;
  mission: string;
  scope: string;
  isNew: boolean;
  n: number;
}

/**
 * ADR-0002 "Mission ids": lowercase; runs outside [a-z0-9_-] -> "-"; trimmed
 * of "-"; max 60 chars (a trailing "-" left by the cut is trimmed too, so
 * output never ends in "-"). Empty or unset = "general".
 */
export function normalizeMission(id: string | undefined): string {
  if (id === undefined) return GENERAL;
  let s = id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  s = s.replace(/^-+/, "").replace(/-+$/, "");
  if (s.length > MISSION_MAX) {
    s = s.slice(0, MISSION_MAX).replace(/-+$/, "");
  }
  return s === "" ? GENERAL : s;
}

/**
 * T16j (brief item 2): the ONE secret-shape check for mission ids, shared
 * by mission(id) (mcp.ts F-T8-3) and both queue-tag paths (writer.ts,
 * nudge.ts). Two faces, both refusing BEFORE anything is stored:
 * - redact-visible: a string redact() would change (opaque >= 40 runs,
 *   prefixed secrets, assignments - the ADR-0003 table);
 * - provider-token shapes below redact's thresholds: a known token prefix
 *   glued to a body (GitHub gh[pousr]-/gh[pousr]_/github_pat_, sk-,
 *   xox[baprs]-, AIza). normalizeMission would otherwise embed a
 *   masked-but-derived fragment of the secret in mission.json forever.
 * A refused id is never stored and never echoed - callers log the reason
 * class only.
 * T16m F-R1: mission ids are slugs (words joined by - or _), and "-" is a
 * redact run character, so an ordinary 40+ slug reads as ONE opaque run.
 * For mission ids only, an opaque-run objection alone is waived when every
 * counted run splits on - or _ into at least 3 parts of 1-20 chars each.
 * A single unbroken 40+ mixed run, every other redact shape, and the
 * provider-token prefixes (T16m adds the AWS access key id AKIA+16) stay
 * refused.
 */
const SECRET_TOKEN_PREFIX_RE = /^(?:gh[pousr][-_]|github_pat_|sk-[a-z0-9]|xox[baprs]-|aiza[0-9a-z_-])/i;
const AWS_ACCESS_KEY_RE = /^AKIA[0-9A-Z]{16}/;

/** Maximal redact-run runs (same alphabet as redact.ts OPAQUE_RUN). */
const RUN40_RE = /[A-Za-z0-9._@~+/=%-]{40,}/g;

/** True when every opaque-counted run in the id is slug-shaped (F-R1). */
function opaqueRunsAreSlugs(id: string): boolean {
  for (const run of id.match(RUN40_RE) ?? []) {
    if (run.startsWith("//")) return false; // URL shape: never a slug
    if (run.startsWith("/") || run.startsWith("~/") || run.startsWith("./")) {
      continue; // the path exclusion in redact.ts: opaque never counted this
    }
    if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/\d/.test(run)) {
      continue; // no upper+lower+digit: the opaque rule skips this run
    }
    const parts = run.split(/[-_]/);
    if (parts.length < 3) return false; // unbroken or 2-part: opaque territory
    for (const part of parts) {
      if (part.length < 1 || part.length > 20) return false;
    }
  }
  return true;
}

export function missionIdIsSecretShaped(id: string): boolean {
  if (SECRET_TOKEN_PREFIX_RE.test(id) || AWS_ACCESS_KEY_RE.test(id)) return true;
  const red = redact(id);
  if (red.text === id) return false;
  if (Object.keys(red.counts).some((kind) => kind !== "opaque")) return true;
  return !opaqueRunsAreSlugs(id); // opaque-only objection: waived for slugs
}

export function scopeFor(mission: string): string {
  return mission === GENERAL ? GENERAL : `mission-${mission}`;
}

export function sessionName(peer: string, mission: string, n: number): string {
  return `${peer}--${mission}--${n}`;
}

function workspaceDir(stateDir: string, workspace: string): string {
  return join(stateDir, workspace);
}

function missionPath(stateDir: string, workspace: string): string {
  return join(workspaceDir(stateDir, workspace), "mission.json");
}

/** Path of the seat state file (T6a: the writer reads it to plan an ensure). */
export function seatStatePath(stateDir: string, workspace: string, peer: string): string {
  return join(workspaceDir(stateDir, workspace), "seats", `${peer}.json`);
}

/** The per-seat lock dir (single source: resolveSession, spool and T6a share it). */
export function seatLockDir(stateDir: string, workspace: string, peer: string): string {
  return join(workspaceDir(stateDir, workspace), "seats", `${peer}.lockdir`);
}

/**
 * Missing, unparsable, or a non-string mission -> {mission: "general"} with
 * null provenance. A string mission is normalised on read, so a hand-edited
 * file can never smuggle an unnormalised id into a session name.
 */
export function readRigMission(stateDir: string, workspace: string): RigMission {
  const raw = readJson<Partial<RigMission>>(missionPath(stateDir, workspace));
  if (raw === null || typeof raw.mission !== "string") {
    return { mission: GENERAL, set_by: null, set_at: null };
  }
  return {
    mission: normalizeMission(raw.mission),
    set_by: typeof raw.set_by === "string" ? raw.set_by : null,
    set_at: typeof raw.set_at === "string" ? raw.set_at : null,
  };
}

/**
 * Write the rig mission (ADR-0002: last writer wins, atomic rename, NO lock —
 * architect ruling 2026-10-28). ok is false only if the write failed;
 * mission/scope are returned either way.
 */
export async function setRigMission(
  stateDir: string,
  workspace: string,
  id: string,
  setBy: string,
  now?: string,
): Promise<{ ok: boolean; mission: string; scope: string }> {
  const mission = normalizeMission(id);
  const scope = scopeFor(mission);
  const ok = writeJsonAtomic(missionPath(stateDir, workspace), {
    mission,
    set_by: setBy,
    set_at: now ?? new Date().toISOString(),
  });
  return { ok, mission, scope };
}

/** S2: missing, non-JSON, or off-shape state (bad n / counters / mission) is missing. */
export function readSeatState(path: string): SeatState | null {
  const raw = readJson<SeatState>(path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.mission !== "string") return null;
  if (!Number.isInteger(raw.n) || raw.n < 1) return null;
  if (typeof raw.counters !== "object" || raw.counters === null || Array.isArray(raw.counters)) {
    return null;
  }
  return raw;
}

/**
 * ADR-0002 "When a new Honcho session starts", local files only.
 * New when: the rig mission differs from the seat's mission; or source is
 * startup/clear with a claude_session_id different from the seat's. Never on
 * resume/compact. Missing/corrupt state = new with n = counters[mission] + 1
 * of an empty counter map (= 1; the server free-n check is T4's list call).
 * n continues per mission from counters, so switching back keeps the old count.
 * Lock busy/error degrades to a computed, unpersisted session (S1) rather
 * than throwing into a hook. Lock is per seat (<workspace>/seats/<peer>.
 * lockdir, architect ruling 2026-10-28) so seats never contend.
 */
export async function resolveSession(
  stateDir: string,
  workspace: string,
  peer: string,
  input: ResolveInput,
): Promise<ResolvedSession> {
  const mission = normalizeMission(input.rigMission);
  const scope = scopeFor(mission);
  const now = input.now ?? new Date().toISOString();
  const path = seatStatePath(stateDir, workspace, peer);

  const res = await withLock(seatLockDir(stateDir, workspace, peer), () => {
    const state = readSeatState(path);
    const newConversation =
      input.claudeSessionId !== undefined && input.claudeSessionId !== state?.claude_session_id;
    const isNew =
      state === null ||
      state.mission !== mission ||
      ((input.source === "startup" || input.source === "clear") && newConversation);
    let n: number;
    let counters: Record<string, number>;
    if (state === null || isNew) {
      const prev = state?.counters?.[mission];
      const validInitial =
        input.initialN !== undefined && Number.isInteger(input.initialN) && input.initialN >= 1;
      n = state === null && validInitial ? (input.initialN as number) : (typeof prev === "number" && Number.isInteger(prev) && prev >= 0 ? prev : 0) + 1;
      counters = { ...state?.counters, [mission]: n };
    } else {
      n = state.n;
      counters = state.counters;
    }
    const session = sessionName(peer, mission, n);
    const claudeSessionId =
      input.claudeSessionId !== undefined ? input.claudeSessionId : state?.claude_session_id;
    // F2 (architect 22:25Z): resolveSession owns mission/n/session/counters/
    // last_seen/claude_session_id ONLY - every other seat-state field
    // (ensured_session, members - E3 hash, O2 stats) rides through untouched,
    // so a seat ensures its session once, not per prompt. The ensure cache is
    // self-invalidating (ensureSession matches ensured_session === session),
    // so carrying it across a new session costs one re-ensure, never a wrong skip.
    const next: SeatState = {
      ...(state ?? {}),
      mission,
      n,
      session,
      ...(claudeSessionId !== undefined ? { claude_session_id: claudeSessionId } : {}),
      counters,
      last_seen: now,
    };
    writeJsonAtomic(path, next);
    return { session, mission, scope, isNew, n };
  });

  if (res.ok) return res.value;
  const busyN =
    input.initialN !== undefined && Number.isInteger(input.initialN) && input.initialN >= 1
      ? input.initialN
      : 1;
  return { session: sessionName(peer, mission, busyN), mission, scope, isNew: true, n: busyN };
}
