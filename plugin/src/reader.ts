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

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./env.ts";
import { type HonchoClient } from "./honcho.ts";
import { readSeatState, resolveSession, normalizeMission, readRigMission, seatStatePath, scopeFor } from "./missions.ts";
import { ensureSession, freeN } from "./writer.ts";
import { entryBody, inForceFor, toEntries } from "./ledger.ts";
import { DAEMON_TIMEOUT_MS, fetchOpenWork } from "./daemon.ts";
import { isItemScope, renderContinuity, renderInjection, type InjectionAwayConclusion, type InjectionDecision, type InjectionDigestEntry, type InjectionInput, type InjectionMissionSummary, type InjectionSessionSummary, type InjectionSource } from "./inject.ts";

/** T19b: the digest counts logged (counts only, X1) with moment "continuity". */
export interface ContinuityStats {
  moment: "continuity";
  n_open: number;
  n_decisions: number;
  n_approvals: number;
  n_away: number;
  has_pointer: boolean;
}

export interface ReaderDeps {
  client: HonchoClient;
  /** set only when config.profileWorkspace is set (ADR-0004 part 5). */
  profileClient?: HonchoClient;
  /** ISO clock, injected so tests fix time. */
  now: () => string;
  /** overall fetch budget; default 4000 ms (ADR-0004). */
  budgetMs?: number;
  /**
   * T19b (ADR-0014 d1): called once per DIGEST run with the part counts -
   * the hook logs them (moment "continuity"); the reader stays log-free.
   * Never called on the old-block path, so old log lines stay identical.
   */
  stats?: (s: ContinuityStats) => void;
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

/**
 * The IN-FORCE decisions and approvals for this mission (T19a, ADR-0014 d2 +
 * amendment; E8; SHARED with the ask tool per the ADR-0004 amendment - one
 * query, one computation, no drift). Fetches the leader's own-observed
 * conclusions up to 100 newest ACROSS missions (fixed point 5: a superseding
 * entry may live in another mission), parses the ledger headers, computes the
 * current ledger, then keeps this mission's entries plus rig-scope entries
 * from any mission. Plain conclusions are legacy mission decisions with
 * derived ids (reader never hides them - they are the mission's decisions).
 * Superseded and retired entries are hidden here - and only here (search
 * still shows them, marked). Content is the entry body without the header;
 * id and kind ride along so the renderer can label them. Newest first, max
 * 10. Any failure is an empty list, never a throw.
 */
export async function fetchMissionDecisions(
  client: HonchoClient,
  leaderPeer: string,
  mission: string,
): Promise<InjectionDecision[]> {
  const r = await client.listConclusions({
    filters: { observer_id: leaderPeer, observed_id: leaderPeer },
    reverse: true,
    size: 100,
  });
  if (!r.ok) return [];
  // only the leader's OWN sessions: remember always writes there, and a
  // conclusion in another peer's session is not a ledger entry (architect,
  // T19a acceptance: the in-force view must not widen what ask shows)
  const items = r.data.items.filter(
    (c) =>
      typeof c.session_id === "string" &&
      parseSessionId(c.session_id)?.peer === leaderPeer &&
      typeof c.content === "string" &&
      c.content.trim() !== "",
  );
  return inForceFor(toEntries(items), mission)
    .slice(0, 10)
    .map((e) => ({
      content: entryBody(e),
      at: e.at,
      id: e.id,
      kind: e.kind === "approval" ? ("approval" as const) : ("decision" as const),
      // T19b: scope lets the digest match approvals to open items; the old
      // renderer and the ask tool ignore it.
      scope: e.scope,
    }));
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
  input: { source: InjectionSource; claudeSessionId?: string; cwd?: string },
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

  // Shared part factories (T19b): identical behavior for the old block and
  // the digest; results carry the session label the digest needs (the old
  // renderer ignores the extra field).

  // ADR-0004 part 2: the seat's own peer card.
  const peerCardPart = (): Promise<string[] | undefined> =>
    part(deadline, config.timeoutMs, async () => {
      const r = await deps.client.getPeerCard(config.peer);
      return r.ok && Array.isArray(r.data.peer_card) ? r.data.peer_card : undefined;
    });

  // E6 (compact only): own session's summary, long if present
  const ownPart = (): Promise<InjectionSessionSummary & { session: string } | undefined> =>
    input.source === "compact"
      ? part(deadline, config.timeoutMs, async () => {
          const r = await deps.client.getSessionSummaries(current);
          if (!r.ok) return undefined;
          const s = pickSummary(r.data, "long");
          return s === undefined ? undefined : { summary: s.content, at: s.at, session: current };
        })
      : Promise.resolve(undefined);

  // E7 (startup/clear only): the seat's previous session in this mission.
  // Our stamped sessions newest-first; the one that is not the current.
  const lastPart = (): Promise<InjectionSessionSummary & { session: string } | undefined> =>
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
            : {
                summary: s.content,
                at: s.at === "" && typeof prev.created_at === "string" ? prev.created_at : s.at,
                session: prev.id,
              };
        })
      : Promise.resolve(undefined);

  // E8: the leader's own-observed conclusions in THIS mission, newest 10
  // (fetchMissionDecisions: the same query the ask tool runs).
  const decisionsPart = (): Promise<InjectionDecision[] | undefined> =>
    config.leaderPeer === undefined
      ? Promise.resolve(undefined)
      : part(deadline, config.timeoutMs, async (): Promise<InjectionDecision[] | undefined> =>
          fetchMissionDecisions(deps.client, config.leaderPeer as string, resolved.mission));

  // T19b (ADR-0014 decision 1): the continuity digest replaces the block's
  // body; the old path below stays byte-for-byte for HONCHO_DIGEST=off.
  if (config.digest === true) {
    return await buildContinuity({
      deadline,
      now,
      config,
      deps,
      cwd: input.cwd,
      source: input.source,
      resolved,
      prevLastSeen,
      ensureP,
      peerCardPart,
      ownPart,
      lastPart,
      decisionsPart,
    });
  }

  // b. all memory parts in parallel, each dropped if late (ADR-0004)
  const [peerCard, ownSession, lastSession, decisions, missionSummaries, rigDigest, ownerCard, away] =
    await Promise.all([
      peerCardPart(),
      ownPart(),
      lastPart(),
      decisionsPart(),

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

/**
 * T19b (ADR-0014 decision 1): the digest path of build(). The same one-
 * deadline parallel pattern: the shared summary/decision/card parts plus the
 * daemon open-work GET (1 s budget of its own, inside the same deadline)
 * race together; the since-away query needs the open items' summaries and
 * so runs after them, still abandoned at the deadline; the restore-map
 * pointer is a local filesystem scan. Part counts go to deps.stats (never
 * content). Mission summaries, rig digest, owner card and the old away note
 * do NOT appear here (ADR-0014 d1: dropped from this path).
 */
async function buildContinuity(a: {
  deadline: number;
  now: string;
  config: Config;
  deps: ReaderDeps;
  cwd: string | undefined;
  source: InjectionSource;
  resolved: Awaited<ReturnType<typeof resolveSession>>;
  prevLastSeen: string | undefined;
  ensureP: Promise<unknown>;
  peerCardPart: () => Promise<string[] | undefined>;
  ownPart: () => Promise<InjectionSessionSummary & { session: string } | undefined>;
  lastPart: () => Promise<InjectionSessionSummary & { session: string } | undefined>;
  decisionsPart: () => Promise<InjectionDecision[] | undefined>;
}): Promise<string> {
  const { deadline, now, config, deps, resolved, ensureP } = a;
  const [peerCard, ownSession, lastSession, decisions, openWork] = await Promise.all([
    a.peerCardPart(),
    a.ownPart(),
    a.lastPart(),
    a.decisionsPart(),
    config.daemonUrl === undefined || config.sessionName === undefined
      ? Promise.resolve(undefined)
      : part(deadline, DAEMON_TIMEOUT_MS, () =>
          fetchOpenWork(config.daemonUrl as string, config.sessionName as string),
        ),
    ensureP,
  ]);
  const openItems = openWork !== undefined && openWork.ok ? openWork.items : [];
  const openIds = new Set(openItems.map((o) => o.qitemId));
  // part 4 is a SUBSET of the in-force ledger entries (no second fetch):
  // an approval whose scope names one of the open items moves under its own
  // heading and leaves part 3 - no duplicates.
  const allDec = decisions ?? [];
  const heldByOpen = (d: InjectionDecision): boolean =>
    d.kind === "approval" && d.scope !== undefined && openIds.has(d.scope);
  // T20c rule 1 (O4, fails safe): an approval scoped to a queue item appears
  // ONLY under "Approvals you hold", and only when that item is open for
  // this seat. Any other item-scoped approval - stale, unknown, or the
  // daemon-down case (no known open items at all) - is left out of the
  // digest COMPLETELY: it must never read as permission. Rule 3: rig- and
  // mission-scoped approvals are unchanged and stay labelled.
  const staleScopedApproval = (d: InjectionDecision): boolean =>
    d.kind === "approval" && isItemScope(d.scope) && !openIds.has(d.scope as string);
  const approvals = allDec.filter(heldByOpen);
  const decisionsInForce = allDec.filter((d) => !heldByOpen(d) && !staleScopedApproval(d));
  const leftOff = a.source === "compact" ? ownSession : lastSession;
  const away = await awayConclusions(deadline, config, deps, resolved.mission, openItems, a.prevLastSeen);
  const pointer = findRestoreMap(a.cwd, config.sessionName, Date.parse(now));
  const text = renderContinuity({
    now,
    ...(openItems.length > 0 ? { openWork: openItems } : {}),
    ...(leftOff !== undefined
      ? { leftOff: { summary: leftOff.summary, at: leftOff.at, session: leftOff.session } }
      : {}),
    ...(decisionsInForce.length > 0 ? { decisions: decisionsInForce } : {}),
    ...(approvals.length > 0 ? { approvals } : {}),
    ...(away.length > 0 ? { away } : {}),
    ...(pointer !== undefined ? { pointer } : {}),
    ...(peerCard !== undefined && peerCard.length > 0 ? { peerCard } : {}),
  });
  deps.stats?.({
    moment: "continuity",
    n_open: openItems.length,
    n_decisions: decisionsInForce.length,
    n_approvals: approvals.length,
    n_away: away.length,
    has_pointer: pointer !== undefined,
  });
  return text;
}

/**
 * Digest part 5 (ADR-0014 d1): up to 3 conclusions made AFTER this seat's
 * previous last_seen, semantically close to the open items' summaries
 * (queryConclusions at the configured distance, one query per summary, max
 * 3 summaries, merged and deduped by id, newest first).
 *
 * The row's fallback, stated as it requires: the server's /conclusions/query
 * filters only accept an observer/observed PAIR (unknown or single-sided
 * keys answer 422 - T16b live probe), so "by OTHER seats" cannot be
 * expressed directly. We query the SCOPE instead: observer
 * `scope.<mission>`, observed this peer - scope-level records about this
 * seat, which self-authored peer-observer rows never are. No open items (or
 * no previous last_seen to compare against) means NO query.
 */
async function awayConclusions(
  deadline: number,
  config: Config,
  deps: ReaderDeps,
  mission: string,
  openItems: { summary: string }[],
  prevLastSeen: string | undefined,
): Promise<InjectionAwayConclusion[]> {
  if (openItems.length === 0 || prevLastSeen === undefined) return [];
  const prevMs = Date.parse(prevLastSeen);
  if (!Number.isFinite(prevMs)) return [];
  const scopeObserver = `scope.${scopeFor(mission)}`;
  const got = await part(deadline, config.timeoutMs, async () => {
    const queries = openItems.slice(0, 3).map((o) => o.summary).filter((s) => s !== "");
    const byId = new Map<string, InjectionAwayConclusion>();
    for (const q of queries) {
      const r = await deps.client.queryConclusions({
        query: q,
        top_k: 3,
        distance: config.recallMaxDistance ?? 0.45,
        filters: { observer: scopeObserver, observed: config.peer },
      });
      if (!r.ok) continue; // a dead query just contributes nothing
      for (const c of r.data) {
        if (typeof c.id !== "string" || c.id === "" || byId.has(c.id)) continue;
        if (typeof c.content !== "string" || c.content.trim() === "") continue;
        const at = typeof c.created_at === "string" ? c.created_at : "";
        const t = Date.parse(at);
        if (!(Number.isFinite(t) && t > prevMs)) continue;
        byId.set(c.id, {
          content: c.content,
          at,
          source: typeof c.observer_id === "string" && c.observer_id !== "" ? c.observer_id : scopeObserver,
        });
      }
    }
    return [...byId.values()]
      .sort((x, y) => {
        const tx = Date.parse(x.at);
        const ty = Date.parse(y.at);
        return (Number.isFinite(ty) ? ty : -Infinity) - (Number.isFinite(tx) ? tx : -Infinity);
      })
      .slice(0, 3);
  });
  return got ?? [];
}

/**
 * Digest part 6 (ADR-0014 d1): the newest
 * <cwd>/.openrig/compaction/preparation/<sessionName>/<attempt>/RESTORE-MAP.md
 * whose mtime is inside the last 24 h (and not from the future). PATH ONLY -
 * the map's content never enters the block. Local filesystem, never throws.
 */
function findRestoreMap(
  cwd: string | undefined,
  sessionName: string | undefined,
  nowMs: number,
): string | undefined {
  if (sessionName === undefined || sessionName === "" || !Number.isFinite(nowMs)) return undefined;
  try {
    const dir = join(cwd ?? process.cwd(), ".openrig", "compaction", "preparation", sessionName);
    let best: { path: string; m: number } | undefined;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = join(dir, ent.name, "RESTORE-MAP.md");
      try {
        const st = statSync(p);
        if (best === undefined || st.mtimeMs > best.m) best = { path: p, m: st.mtimeMs };
      } catch {
        // no map in this attempt dir: ignore
      }
    }
    if (best === undefined) return undefined;
    const DAY_MS = 24 * 60 * 60_000;
    if (best.m > nowMs || nowMs - best.m > DAY_MS) return undefined;
    return best.path;
  } catch {
    return undefined; // no preparation dir at all: no pointer
  }
}

/** Entry point: never throws (S1); total failure is the empty string. */
export async function buildInjection(
  input: { source: InjectionSource; claudeSessionId?: string; cwd?: string },
  config: Config,
  deps: ReaderDeps,
): Promise<string> {
  try {
    return await build(input, config, deps);
  } catch {
    return ""; // no memory block beats a broken SessionStart
  }
}
