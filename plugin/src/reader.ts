// The SessionStart reader (T7b, ADR-0004 + ADR-0005 E6-E9): fetch the seat's
// memory cheaply and render it. Everything runs inside ONE overall deadline
// (budgetMs, default 4000, ADR-0004 "Decision"); every part races that clock
// and is simply dropped when it is late or fails — a missing section beats a
// slow or broken session start. Never throws (S1): total failure returns "".
//
// Session lifecycle is NOT reimplemented here: the reader resolves the session
// with missions.resolveSession and creates it server-side with writer.ts
// freeN + ensureSession, exactly as the recorders do, so first-write and
// first-read can never disagree about n, peers, scope or stamps. The seat
// state's PREVIOUS last_seen is read before resolveSession updates it — the
// away note (ADR-0004 part 6) is about that earlier moment.

import type { Config } from "./env.ts";
import { type HonchoClient } from "./honcho.ts";
import { readSeatState, resolveSession, normalizeMission, readRigMission, seatStatePath } from "./missions.ts";
import { ensureSession, freeN } from "./writer.ts";
import { renderInjection, type InjectionDecision, type InjectionDigestEntry, type InjectionInput, type InjectionMissionSummary, type InjectionSource } from "./inject.ts";

export interface ReaderDeps {
  client: HonchoClient;
  /** set only when config.profileWorkspace is set (ADR-0004 part 5). */
  profileClient?: HonchoClient;
  /** ISO clock, injected so tests fix time. */
  now: () => string;
  /** overall fetch budget; default 4000 ms (ADR-0004). */
  budgetMs?: number;
}

const DEFAULT_BUDGET_MS = 4000;
const HOUR = 60 * 60_000;
/** one page for the away newSessions count (server page cap) */
const SCOPE_PAGE = 100;

/** `<peer>--<mission>--<n>`; null for ids we did not mint (untagged strays). */
function parseSessionId(id: string): { peer: string; mission: string } | null {
  const m = /^(.*)--(.*)--(\d+)$/.exec(id);
  if (m === null) return null;
  return { peer: m[1], mission: m[2] };
}

/** true when id is `<peer>--<mission>--<digits>` exactly. */
function isMissionSession(id: string, peer: string, mission: string): boolean {
  const p = parseSessionId(id);
  return p !== null && p.peer === peer && p.mission === mission;
}

/**
 * The leader's own-observed conclusions in THIS mission, newest first, max 10
 * (E8; SHARED with the ask tool per the ADR-0004 amendment - one query, one
 * client-side session filter, no drift). session_id re-check client-side: the
 * leader's conclusions from another mission share the observer filter. Any
 * failure is an empty list, never a throw.
 */
export async function fetchMissionDecisions(
  client: HonchoClient,
  leaderPeer: string,
  mission: string,
): Promise<InjectionDecision[]> {
  const r = await client.listConclusions({
    filters: { observer_id: leaderPeer, observed_id: leaderPeer },
    reverse: true,
    size: 30,
  });
  if (!r.ok) return [];
  const out: InjectionDecision[] = [];
  for (const c of r.data.items) {
    if (typeof c.session_id !== "string") continue;
    if (!isMissionSession(c.session_id, leaderPeer, mission)) continue;
    if (typeof c.content !== "string" || c.content.trim() === "") continue;
    out.push({ content: c.content, at: typeof c.created_at === "string" ? c.created_at : "" });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Run one memory part within `min(timeoutMs, time left at the deadline)`.
 * Late, failed or impossible (no time left): undefined -> the part is missing.
 * A hung server call is abandoned here, not awaited past the deadline.
 */
async function part<T>(
  deadline: number,
  timeoutMs: number,
  f: () => Promise<T>,
): Promise<T | undefined> {
  const left = Math.min(timeoutMs, deadline - Date.now());
  if (left <= 0) return undefined;
  try {
    return await Promise.race([
      f(),
      new Promise<undefined>((res) => setTimeout(res, left)),
    ]);
  } catch {
    return undefined; // S1: a failing part is a missing part
  }
}

/** short if present, else long; null summary fields included. */
function pickSummary(
  s: { short_summary: { content: string; created_at?: string } | null; long_summary: { content: string; created_at?: string } | null },
  prefer: "long" | "short",
): { content: string; at: string } | undefined {
  const first = prefer === "long" ? (s.long_summary ?? s.short_summary) : (s.short_summary ?? s.long_summary);
  if (first === null || typeof first.content !== "string" || first.content.trim() === "") return undefined;
  return { content: first.content, at: typeof first.created_at === "string" ? first.created_at : "" };
}

async function build(
  input: { source: InjectionSource; claudeSessionId?: string },
  config: Config,
  deps: ReaderDeps,
): Promise<string> {
  const deadline = Date.now() + Math.max(1, deps.budgetMs ?? DEFAULT_BUDGET_MS);
  const now = deps.now();
  const mission = normalizeMission(readRigMission(config.stateDir, config.workspace).mission);

  // a. the session: exactly the writer's lifecycle. The PREVIOUS last_seen is
  // what the away note reports; resolveSession overwrites it.
  const pre = readSeatState(seatStatePath(config.stateDir, config.workspace, config.peer));
  const prevLastSeen = typeof pre?.last_seen === "string" ? pre.last_seen : undefined;
  let initialN: number | undefined;
  let nFallback = false;
  if (pre === null) {
    const minted = await part(deadline, config.timeoutMs, () =>
      freeN(deps.client, config.peer, mission),
    );
    if (minted !== null && minted !== undefined) {
      initialN = minted;
    } else {
      const sec = Math.floor(Date.parse(now) / 1000);
      initialN = Number.isFinite(sec) && sec >= 1 ? sec : Math.floor(Date.now() / 1000);
      nFallback = true;
    }
  }
  const resolved = await resolveSession(config.stateDir, config.workspace, config.peer, {
    rigMission: mission,
    source: input.source,
    ...(input.claudeSessionId !== undefined ? { claudeSessionId: input.claudeSessionId } : {}),
    now,
    ...(initialN !== undefined ? { initialN } : {}),
  });
  const usedFallback = nFallback && initialN !== undefined && resolved.n === initialN;
  // Ensure it server-side. Started BEFORE the fetches so it overlaps them,
  // awaited WITH them (capped by the same deadline) so the session really
  // exists when the hook exits. Its failure costs nothing readable: every
  // memory part is a GET that does not require the session to exist.
  const ensureP = part(deadline, config.timeoutMs, () =>
    ensureSession(deps.client, config, resolved, pre, config.peer, usedFallback),
  );

  const isLeader = config.leaderPeer !== undefined && config.leaderPeer === config.peer;
  const current = resolved.session;

  // b. all memory parts in parallel, each dropped if late (ADR-0004)
  const [peerCard, ownSession, lastSession, decisions, missionSummaries, rigDigest, ownerCard, away] =
    await Promise.all([
      part(deadline, config.timeoutMs, async () => {
        const r = await deps.client.getPeerCard(config.peer);
        return r.ok && Array.isArray(r.data.peer_card) ? r.data.peer_card : undefined;
      }),

      // E6 (compact only): own session's summary, long if present
      input.source === "compact"
        ? part(deadline, config.timeoutMs, async () => {
            const r = await deps.client.getSessionSummaries(current);
            if (!r.ok) return undefined;
            const s = pickSummary(r.data, "long");
            return s === undefined ? undefined : { summary: s.content, at: s.at };
          })
        : Promise.resolve(undefined),

      // E7 (startup/clear only): the seat's previous session in this mission.
      // Our stamped sessions newest-first; the one that is not the current.
      input.source === "startup" || input.source === "clear"
        ? part(deadline, config.timeoutMs, async () => {
            const r = await deps.client.listSessions({
              filters: { metadata: { rig_peer: config.peer, mission: resolved.mission } },
              reverse: true,
              size: 2,
            });
            if (!r.ok) return undefined;
            const prev = r.data.items.find((s) => s.id !== current);
            if (prev === undefined) return undefined;
            const sr = await deps.client.getSessionSummaries(prev.id);
            if (!sr.ok) return undefined;
            const s = pickSummary(sr.data, "short");
            return s === undefined
              ? undefined
              : { summary: s.content, at: s.at === "" && typeof prev.created_at === "string" ? prev.created_at : s.at };
          })
        : Promise.resolve(undefined),

      // E8: the leader's own-observed conclusions in THIS mission, newest 10
      // (fetchMissionDecisions: the same query the ask tool runs).
      config.leaderPeer === undefined
        ? Promise.resolve(undefined)
        : part(deadline, config.timeoutMs, async (): Promise<InjectionDecision[] | undefined> =>
            fetchMissionDecisions(deps.client, config.leaderPeer as string, resolved.mission)),

      // ADR-0004 part 3: newest scope sessions (excluding the current one),
      // short summaries of up to 3, labelled by the peer parsed from the id.
      part(deadline, config.timeoutMs, async (): Promise<InjectionMissionSummary[] | undefined> => {
        const r = await deps.client.listScopeSessions(resolved.scope, { reverse: true, size: 4 });
        if (!r.ok) return undefined;
        const others = r.data.items.filter((s) => s.id !== current).slice(0, 3);
        const got = await Promise.all(
          others.map(async (s): Promise<InjectionMissionSummary | undefined> => {
            const sr = await deps.client.getSessionSummaries(s.id);
            if (!sr.ok) return undefined;
            const sum = pickSummary(sr.data, "short");
            if (sum === undefined) return undefined;
            const at = sum.at === "" && typeof s.created_at === "string" ? s.created_at : sum.at;
            return { peer: parseSessionId(s.id)?.peer ?? s.id, summary: sum.content, at };
          }),
        );
        return got.filter((x): x is InjectionMissionSummary => x !== undefined);
      }),

      // ADR-0004 part 4 (leader only): newest sessions workspace-wide,
      // short summaries of up to 5, labelled peer and mission.
      isLeader
        ? part(deadline, config.timeoutMs, async (): Promise<InjectionDigestEntry[] | undefined> => {
            const r = await deps.client.listSessions({ reverse: true, size: 6 });
            if (!r.ok) return undefined;
            const others = r.data.items.filter((s) => s.id !== current).slice(0, 5);
            const got = await Promise.all(
              others.map(async (s): Promise<InjectionDigestEntry | undefined> => {
                const who = parseSessionId(s.id);
                if (who === null) return undefined; // not ours to label
                const sr = await deps.client.getSessionSummaries(s.id);
                if (!sr.ok) return undefined;
                const sum = pickSummary(sr.data, "short");
                if (sum === undefined) return undefined;
                const at = sum.at === "" && typeof s.created_at === "string" ? s.created_at : sum.at;
                return { peer: who.peer, mission: who.mission, summary: sum.content, at };
              }),
            );
            return got.filter((x): x is InjectionDigestEntry => x !== undefined);
          })
        : Promise.resolve(undefined),

      // ADR-0004 part 5: the owner's card from the profile workspace
      deps.profileClient === undefined
        ? Promise.resolve(undefined)
        : part(deadline, config.timeoutMs, async () => {
            const r = await deps.profileClient!.getPeerCard(config.ownerPeer);
            return r.ok && Array.isArray(r.data.peer_card) ? r.data.peer_card : undefined;
          }),

      // ADR-0004 part 6: resume, or any start > 1 h after the previous last_seen
      prevLastSeen === undefined
        ? Promise.resolve(undefined)
        : part(deadline, config.timeoutMs, async () => {
            const prevMs = Date.parse(prevLastSeen);
            const idle = Number.isFinite(Date.parse(now)) && Number.isFinite(prevMs) && Date.parse(now) - prevMs > HOUR;
            if (input.source !== "resume" && !idle) return undefined;
            const r = await deps.client.listScopeSessions(resolved.scope, { reverse: true, size: SCOPE_PAGE });
            if (!r.ok) return undefined;
            let newSessions = 0;
            for (const s of r.data.items) {
              const t = typeof s.created_at === "string" ? Date.parse(s.created_at) : NaN;
              if (Number.isFinite(t) && Number.isFinite(prevMs) && t > prevMs) newSessions++;
            }
            return { lastSeen: prevLastSeen, newSessions };
          }),
      ensureP,
    ]);

  // c. render; renderInjection itself never throws and returns "" for nothing
  const inj: InjectionInput = {
    now,
    source: input.source,
    selfPeer: config.peer,
    isLeader,
    mission: resolved.mission,
    ...(peerCard !== undefined && peerCard.length > 0 ? { peerCard } : {}),
    ...(ownSession !== undefined ? { ownSession } : {}),
    ...(lastSession !== undefined ? { lastSession } : {}),
    ...(decisions !== undefined && decisions.length > 0 ? { decisions } : {}),
    ...(missionSummaries !== undefined && missionSummaries.length > 0 ? { missionSummaries } : {}),
    ...(rigDigest !== undefined && rigDigest.length > 0 ? { rigDigest } : {}),
    ...(ownerCard !== undefined && ownerCard.length > 0 ? { ownerCard } : {}),
    ...(away !== undefined ? { away } : {}),
  };
  return renderInjection(inj);
}

/** Entry point: never throws (S1); total failure is the empty string. */
export async function buildInjection(
  input: { source: InjectionSource; claudeSessionId?: string },
  config: Config,
  deps: ReaderDeps,
): Promise<string> {
  try {
    return await build(input, config, deps);
  } catch {
    return ""; // no memory block beats a broken SessionStart
  }
}
