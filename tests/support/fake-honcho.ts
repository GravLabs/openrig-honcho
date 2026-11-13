// Fake Honcho v3 server for tests (ADR-0006 R1-R3, X1/X2): a server we can
// make fail on purpose and whose every request we can inspect. Test support
// only - nothing under plugin/ may import this. It speaks the paths and
// shapes plugin/src/honcho.ts calls (checked against the live
// openapi.json 2026-10-28: the client's Page interface is the contract the
// fake serves; the real page schema's extra keys are emitted too, marked
// below). No real server is ever loaded with failure traffic.
//
// Modes: ok | 500 | hang | slow(delayMs) | refuse. Every request that REACHES
// the server is appended to `requests`, including in failure modes; a refused
// connect never reaches it and so cannot be recorded.

export type FakeMode = "ok" | "refuse" | "500" | "hang" | "slow";

export interface FakeRequest {
  method: string;
  /** path + query, e.g. /v3/workspaces/ws/sessions */
  path: string;
  /** parsed JSON body; undefined when the request had none */
  body: unknown;
  /** Date.now() at arrival */
  at: number;
}

export interface FakeState {
  /** workspace ids seen in any path */
  workspaces: Set<string>;
  /** `<workspace>/<session>` -> stored session */
  sessions: Map<string, Record<string, unknown>>;
  /** `<workspace>/<session>` -> stored messages in arrival order */
  messages: Map<string, Array<Record<string, unknown>>>;
  /** `<workspace>/<scope>` -> session ids in creation order */
  scopes: Map<string, string[]>;
  /** workspace -> peer ids seen (session members and message senders) */
  peers: Map<string, Set<string>>;
  /** workspace -> stored conclusions in creation order */
  conclusions: Map<string, unknown[]>;
  /** `<workspace>/<session>` -> stored summaries (T7b, reader tests) */
  summaries: Map<string, FakeSummary>;
  /** `<workspace>/<peer>` -> stored peer card lines (T7b) */
  peerCards: Map<string, string[]>;
  /** workspace -> seeded queue/status payload (T8, E10) */
  queue: Map<string, Record<string, unknown>>;
}

export interface FakeSummary {
  short?: string | null;
  long?: string | null;
  created_at?: string;
}

export interface FakeConclusionSeed {
  content: string;
  observer_id: string;
  observed_id: string;
  session_id?: string;
  created_at?: string;
}

export interface FakeHoncho {
  /** http://127.0.0.1:<port>/v3 */
  url: string;
  requests: FakeRequest[];
  mode(m: FakeMode, opts?: { delayMs?: number }): void;
  /**
   * Requests whose PATH contains this substring answer with `status`
   * (default 500; null clears) whatever the mode is. For single-endpoint
   * failures, e.g. the ADR-0002 free-n fallback when sessions/list fails, or
   * the ADR-0005 E1 poison statuses 400/413/422 vs stop statuses 401/403/404/429.
   * With bodyContains the rule applies only to requests whose JSON body
   * serializes to text containing that substring (poison ONE message among many).
   */
  failPattern(
    pattern: string | null,
    opts?: { status?: number; bodyContains?: string },
  ): void;
  /**
   * T8e-fix-2: scripted status SEQUENCE for one endpoint - each matching
   * request pops the next status ([409,409,202] = "409 twice then accepted");
   * when the list is exhausted the request routes normally. With method set
   * only that method matches (a retry test must not burn its sequence on the
   * sessions/list that precedes the DELETE). One-shot semantics, stackable.
   */
  scriptPattern(pattern: string, statuses: number[], opts?: { method?: string }): void;
  /**
   * T16d: a request whose PATH contains `pattern` first waits `delayMs`,
   * then routes normally - so one endpoint can be slow while the others
   * answer, which is how the search tool's 3 s wall gets tested. Every
   * matching request delays; stop() releases pending delays.
   */
  slowPattern(pattern: string, delayMs: number): void;
  state: FakeState;
  /** Seed/read the summaries the GET summaries route answers (T7b). */
  setSummary(workspace: string, sessionId: string, s: FakeSummary): void;
  /** Seed the peer card the GET card route answers; unset peers 404 (T7b). */
  setPeerCard(workspace: string, peer: string, lines: string[]): void;
  /** Control a stored session's created_at (away-note ordering, T7b). */
  setSessionCreatedAt(workspace: string, sessionId: string, iso: string): void;
  /** Seed a conclusion directly (the create route needs live-style peers). */
  addConclusion(workspace: string, c: FakeConclusionSeed): void;
  stop(): Promise<void>;
}

export async function startFakeHoncho(opts?: { version?: string }): Promise<FakeHoncho> {
  const requests: FakeRequest[] = [];
  const state: FakeState = {
    workspaces: new Set(),
    sessions: new Map(),
    messages: new Map(),
    scopes: new Map(),
    peers: new Map(),
    conclusions: new Map(),
    summaries: new Map(),
    peerCards: new Map(),
    queue: new Map(),
  };

  let current: FakeMode = "ok";
  let delayMs = 0;
  let failPat: string | null = null;
  let failStatus = 500;
  let failBody: string | undefined;
  const scripted: Array<{ pattern: string; statuses: number[]; method?: string }> = [];
  const slowPats: Array<{ pattern: string; delayMs: number }> = [];
  const hung = new Set<(code: number) => void>();
  const slow = new Map<ReturnType<typeof setTimeout>, (code: number) => void>();

  const notFound = (): Response => Response.json({ detail: "Not Found" }, { status: 404 });

  /**
   * Real-server id grammar (T7-fix, review F-T7-1 context): resource ids
   * (workspace, session, peer, scope) match ^[A-Za-z0-9_-]{1,512}$; anything
   * else is 422. The fake enforcing this stops tests depending on ids the
   * server would refuse. Note '-----general--9' IS legal (hyphens are in the
   * class) - the X3 label fix in inject.ts covers that vector.
   */
  const ID_RE = /^[A-Za-z0-9_-]{1,512}$/;
  const badId = (what: string, v: string): Response =>
    Response.json(
      { detail: [{ loc: ["path"], msg: `${what} id must match ^[A-Za-z0-9_-]{1,512}$`, type: "value_error" }] },
      { status: 422 },
    );
  /** first key of `o` (when an object) violating the grammar; undefined if clean. */
  const badKey = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    return Object.keys(o as Record<string, unknown>).find((k) => !ID_RE.test(k));
  };

  function markPeers(workspace: string, peers: unknown): void {
    if (!peers || typeof peers !== "object" || Array.isArray(peers)) return;
    const set = state.peers.get(workspace) ?? new Set<string>();
    for (const p of Object.keys(peers as Record<string, unknown>)) set.add(p);
    state.peers.set(workspace, set);
  }

  /** Page answer with the client's Page fields first; live schema keys kept as a superset. */
  function page(items: Record<string, unknown>[], size?: number): Response {
    return Response.json({
      items,
      total: items.length,
      page: 1,
      size: size ?? items.length,
      pages: 1,
      current_page: 1,
      next_page: null,
      previous_page: null,
      current_page_backwards: false,
    });
  }

  function okRoute(segs: string[], method: string, body: unknown, params: URLSearchParams): Response {
    if (segs[0] !== "workspaces") return notFound();
    // T16i offline repro: POST /workspaces get-or-create, mirroring the real
    // routers/workspaces.py semantics tests/support/scratch.ts createWorkspace
    // relies on. Everything else on the bare path stays a 404.
    if (segs.length === 1) {
      if (method !== "POST") return notFound();
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.id !== "string" || !ID_RE.test(b.id)) return badId("workspace", String(b.id));
      state.workspaces.add(b.id);
      return Response.json({ id: b.id, name: b.id }, { status: 201 });
    }
    const w = segs[1];
    if (!ID_RE.test(w)) return badId("workspace", w);
    state.workspaces.add(w);

    // POST /workspaces/:w/sessions
    if (segs.length === 3 && segs[2] === "sessions" && method === "POST") {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b.id !== "string" || b.id === "") {
        return Response.json({ detail: "id required" }, { status: 400 });
      }
      if (!ID_RE.test(b.id)) return badId("session", b.id);
      const peerKey = badKey(b.peers);
      if (peerKey !== undefined) return badId("peer", peerKey);
      if (Array.isArray(b.scopes)) {
        for (const sc of b.scopes) {
          if (typeof sc !== "string" || !ID_RE.test(sc)) return badId("scope", String(sc));
        }
      }
      const key = `${w}/${b.id}`;
      const existing = state.sessions.get(key);
      const session = existing ?? {
        id: b.id,
        workspace_id: w,
        is_active: true,
        metadata: b.metadata ?? {},
        // real sessions carry created_at; setSessionCreatedAt overrides it
        created_at: new Date().toISOString(),
      };
      if (!existing) state.sessions.set(key, session);
      markPeers(w, b.peers); // get-or-create merges peers on an existing session
      if (Array.isArray(b.scopes)) {
        for (const sc of b.scopes) {
          const list = state.scopes.get(`${w}/${String(sc)}`) ?? [];
          if (!list.includes(b.id)) list.push(b.id);
          state.scopes.set(`${w}/${String(sc)}`, list);
        }
      }
      return Response.json(session);
    }

    // POST /workspaces/:w/sessions/:s/messages/list (T16i offline repro; the
    // real-server read soak serverMessages() uses - POST like sessions/list).
    // Page shape per page(). T17a: body {filters} honoured like the real
    // get_messages (reference routers/messages.py:312 + utils/filter.py
    // apply_filter): peer_id exact match; a metadata filter is per-key
    // containment on the stored metadata; any OTHER top-level filter key
    // answers an empty page (fail closed - the fake cannot invent semantics).
    // Unknown session answers the empty page (unchanged from T16i: soak
    // readbacks must not start depending on the notFound shape here).
    if (
      segs.length === 6 && segs[2] === "sessions" && segs[4] === "messages" &&
      segs[5] === "list" && method === "POST"
    ) {
      if (!ID_RE.test(segs[3])) return badId("session", segs[3]);
      let items = (state.messages.get(`${w}/${segs[3]}`) ?? []).slice();
      const filters = (body as { filters?: Record<string, unknown> } | undefined)?.filters;
      for (const [k, v] of Object.entries(filters ?? {})) {
        if (k === "peer_id" && typeof v === "string") {
          items = items.filter((m) => m.peer_id === v);
        } else if (k === "metadata" && v !== null && typeof v === "object" && !Array.isArray(v)) {
          const want = v as Record<string, unknown>;
          items = items.filter((m) => {
            const md = (m as { metadata?: Record<string, unknown> }).metadata;
            return md !== undefined && Object.entries(want).every(([mk, mv]) => md[mk] === mv);
          });
        } else {
          items = [];
        }
      }
      if (params.get("reverse") === "true") items = items.reverse();
      // T17a: offset pagination like the real paginate_offset_or_cursor -
      // the T17a script follows page/pages to the LAST page, so the fake
      // must answer total/pages honestly and slice per page (page defaults
      // to 1, size to everything - unchanged answers for size-less callers).
      const total = items.length;
      const sizeRaw = params.get("size");
      const sizeNum = sizeRaw !== null ? Number(sizeRaw) : NaN;
      const size = Number.isFinite(sizeNum) ? Math.max(0, sizeNum) : total;
      const pageRaw = params.get("page");
      const pageNumRaw = pageRaw !== null ? Number(pageRaw) : NaN;
      const pageNum = Number.isFinite(pageNumRaw) ? Math.max(1, pageNumRaw) : 1;
      const pages = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
      const slice = size > 0 ? items.slice((pageNum - 1) * size, pageNum * size) : [];
      return Response.json({
        items: slice,
        total,
        page: pageNum,
        size,
        pages,
        current_page: pageNum,
        next_page: pageNum < pages ? pageNum + 1 : null,
        previous_page: pageNum > 1 ? pageNum - 1 : null,
        current_page_backwards: false,
      });
    }

    if (segs[2] === "sessions" && segs.length === 5) {
      const key = `${w}/${segs[3]}`;
      if (!ID_RE.test(segs[3])) return badId("session", segs[3]);
      // POST /workspaces/:w/sessions/:sid/peers
      if (segs[4] === "peers" && method === "POST") {
        const peerKey = badKey(body);
        if (peerKey !== undefined) return badId("peer", peerKey);
        const s = state.sessions.get(key);
        if (!s) return notFound();
        markPeers(w, body);
        return Response.json(s);
      }
      // POST /workspaces/:w/sessions/:sid/messages
      // Like the real server (probed 2026-10-28): a message to an UNKNOWN
      // session AUTO-CREATES it (201, no scope, auto_created: true). ADR-0002
      // forbids write paths from relying on this.
      if (segs[4] === "messages" && method === "POST") {
        let autoCreated = false;
        if (!state.sessions.has(key)) {
          state.sessions.set(key, {
            id: segs[3],
            workspace_id: w,
            is_active: true,
            metadata: {},
            auto_created: true,
          });
          autoCreated = true;
        }
        const msgs = (body as { messages?: unknown } | undefined)?.messages;
        if (!Array.isArray(msgs)) return Response.json({ detail: "messages required" }, { status: 400 });
        // grammar validated BEFORE any storage (the real server refuses the
        // whole body; a partial write would not be parity)
        for (const m of msgs) {
          const pid = (m as Record<string, unknown> | null)?.peer_id;
          if (typeof pid === "string" && !ID_RE.test(pid)) return badId("peer", pid);
        }
        const stored = state.messages.get(key) ?? [];
        for (const m of msgs) {
          const rec = { ...(m as Record<string, unknown>), session_id: segs[3], seq: stored.length + 1 };
          if (typeof rec.peer_id === "string") markPeers(w, { [rec.peer_id]: {} });
          stored.push(rec);
        }
        state.messages.set(key, stored);
        return Response.json(stored, autoCreated ? { status: 201 } : undefined);
      }
      // GET /workspaces/:w/sessions/:sid/summaries - answers setSummary seeds
      // (unseeded session: 200 with both null, like the real empty session)
      if (segs[4] === "summaries" && method === "GET") {
        if (!state.sessions.has(key)) return notFound();
        const s = state.summaries.get(key) ?? {};
        const stamp = s.created_at ?? new Date().toISOString();
        return Response.json({
          id: segs[3],
          short_summary: typeof s.short === "string" ? { content: s.short, created_at: stamp } : null,
          long_summary: typeof s.long === "string" ? { content: s.long, created_at: stamp } : null,
        });
      }
    }

    // POST /workspaces/:w/sessions/list[?size=&reverse=] body {filters:{metadata:{...}}}
    // Like the real server (probed 2026-10-28 + reference routers/sessions.py):
    // no-match filters answer an EMPTY page (never 404); a metadata filter is
    // an exact per-key match and a session whose metadata lacks the key never
    // matches; size <= 100; default order is creation order, reverse=true
    // newest-created first. Only metadata filters are modelled: any other
    // filter key answers empty (fail closed - the fake cannot invent semantics
    // the writer must not rely on).
    if (segs.length === 4 && segs[2] === "sessions" && segs[3] === "list" && method === "POST") {
      const sizeParam = params.get("size");
      if (sizeParam !== null && Number.isFinite(Number(sizeParam)) && Number(sizeParam) > 100) {
        return Response.json({ detail: [{ msg: "Input should be less than or equal to 100" }] }, { status: 422 });
      }
      const b = (body ?? {}) as { filters?: Record<string, unknown> };
      const only = b.filters === undefined || b.filters === null || Object.keys(b.filters).length === 0;
      const meta = only ? undefined : b.filters.metadata;
      if (!only && (meta === undefined || typeof meta !== "object" || meta === null || Array.isArray(meta))) {
        return page([]); // non-metadata filters: not modelled -> nothing matches
      }
      const want = (meta ?? {}) as Record<string, unknown>;
      let items: Record<string, unknown>[] = [];
      for (const [key, s] of state.sessions) {
        if (!key.startsWith(`${w}/`)) continue;
        if (meta !== undefined) {
          const sm = (s.metadata ?? {}) as Record<string, unknown>;
          let hit = true;
          for (const [k, v] of Object.entries(want)) {
            if (sm[k] !== v) { hit = false; break; }
          }
          if (!hit) continue;
        }
        items.push(s);
      }
      if (params.get("reverse") === "true") items = items.slice().reverse();
      if (sizeParam !== null && Number.isFinite(Number(sizeParam))) items = items.slice(0, Math.max(0, Number(sizeParam)));
      return page(items);
    }

    // POST /workspaces/:w/scopes/:scope/sessions/list[?size=&reverse=]
    // Like the real server (probed 2026-10-28): an unknown scope is 404, and
    // size must be <= 100.
    if (segs.length === 6 && segs[2] === "scopes" && segs[4] === "sessions" && segs[5] === "list" && method === "POST") {
      const sizeParam = params.get("size");
      if (sizeParam !== null && Number.isFinite(Number(sizeParam)) && Number(sizeParam) > 100) {
        return Response.json({ detail: [{ msg: "Input should be less than or equal to 100" }] }, { status: 422 });
      }
      if (!ID_RE.test(segs[3])) return badId("scope", segs[3]);
      if (!state.scopes.has(`${w}/${segs[3]}`)) {
        return Response.json({ detail: `Scope ${segs[3]} not found in workspace ${w}` }, { status: 404 });
      }
      const ids = state.scopes.get(`${w}/${segs[3]}`) ?? [];
      // stored fields (created_at, metadata) flow through when the session
      // was created through this fake; seeds can adjust created_at
      let items = ids.map(
        (id) =>
          (state.sessions.get(`${w}/${id}`) as Record<string, unknown> | undefined) ?? {
            id,
            workspace_id: w,
            is_active: true,
            created_at: new Date(0).toISOString(),
          },
      );
      if (params.get("reverse") === "true") items = items.slice().reverse();
      const size = params.get("size") ? Number(params.get("size")) : items.length;
      items = items.slice(0, Number.isFinite(size) && size >= 0 ? size : items.length);
      // client Page fields first; live schema's keys kept as a superset
      return Response.json({
        items,
        total: items.length,
        page: 1,
        size,
        pages: 1,
        current_page: 1,
        next_page: null,
        previous_page: null,
        current_page_backwards: false,
      });
    }

    // POST /workspaces/:w/peers - get-or-create (T24; live 3.5.0 schema is
    // PeerCreate{id} - probed 2026-11-05 23:3xZ on scratch: {id} answers 201
    // new / 200 existing, and a conclusion needs BOTH pair peers created
    // first). Answer the peer; the peer becomes known so a later conclusion
    // on its pair passes the existence check.
    if (segs.length === 3 && segs[2] === "peers" && method === "POST") {
      const b = (body ?? {}) as { id?: unknown };
      if (typeof b.id !== "string" || b.id === "") {
        return Response.json({ detail: "id required" }, { status: 422 });
      }
      if (!ID_RE.test(b.id)) return badId("peer", b.id);
      const set = state.peers.get(w) ?? new Set<string>();
      const existed = set.has(b.id);
      set.add(b.id);
      state.peers.set(w, set);
      return Response.json({ id: b.id, workspace_id: w }, { status: existed ? 200 : 201 });
    }

    // GET /workspaces/:w/peers/:peer/card - a setPeerCard seed answers for any
    // peer; otherwise a known peer gets [] and an unknown one 404 (live).
    if (segs.length === 5 && segs[2] === "peers" && segs[4] === "card" && method === "GET") {
      if (!ID_RE.test(segs[3])) return badId("peer", segs[3]);
      const seeded = state.peerCards.get(`${w}/${segs[3]}`);
      if (seeded !== undefined) return Response.json({ peer_card: seeded });
      if (!state.peers.get(w)?.has(segs[3])) return notFound();
      return Response.json({ peer_card: [] });
    }

    // PUT /workspaces/:w/peers/:peer/card - the real set_peer_card route
    // (reference routers/peers.py:622): body {peer_card: string[]}, answer
    // {peer_card}; stores the card a later GET answers (T17a copy script).
    if (segs.length === 5 && segs[2] === "peers" && segs[4] === "card" && method === "PUT") {
      if (!ID_RE.test(segs[3])) return badId("peer", segs[3]);
      const b = (body ?? {}) as { peer_card?: unknown };
      if (!Array.isArray(b.peer_card) || b.peer_card.some((x) => typeof x !== "string")) {
        return Response.json({ detail: "peer_card must be an array of strings" }, { status: 422 });
      }
      state.peerCards.set(`${w}/${segs[3]}`, b.peer_card as string[]);
      // the real route resolves-or-creates the peer row; a PUT card must make
      // the peer known so the next GET answers the stored card, not 404
      const set = state.peers.get(w) ?? new Set<string>();
      set.add(segs[3]);
      state.peers.set(w, set);
      return Response.json({ peer_card: b.peer_card });
    }

    // POST /workspaces/:w/conclusions/list[?size=&reverse=] body {filters:{...}}
    // Like the real server (probed 2026-10-28): exact-match filters on
    // observer_id / observed_id / session_id; an unknown filter key answers
    // 422 "Column '<k>' does not exist on Document"; no match answers an
    // empty page; size <= 100; default order is creation order.
    if (segs.length === 4 && segs[2] === "conclusions" && segs[3] === "list" && method === "POST") {
      const sizeParam = params.get("size");
      if (sizeParam !== null && Number.isFinite(Number(sizeParam)) && Number(sizeParam) > 100) {
        return Response.json({ detail: [{ msg: "Input should be less than or equal to 100" }] }, { status: 422 });
      }
      const b = (body ?? {}) as { filters?: Record<string, unknown> };
      const known = ["observer_id", "observed_id", "session_id"];
      for (const k of Object.keys(b.filters ?? {})) {
        if (!known.includes(k)) {
          return Response.json({ detail: `Column '${k}' does not exist on Document` }, { status: 422 });
        }
      }
      let items = (state.conclusions.get(w) ?? []).slice() as Array<Record<string, unknown>>;
      for (const [k, v] of Object.entries(b.filters ?? {})) {
        items = items.filter((c) => c[k] === v);
      }
      if (params.get("reverse") === "true") items = items.reverse();
      // T24: offset paging like the real paginate_offset_or_cursor and like
      // messages/list above - the ledger-pair reader pages 1..5 x 100 and
      // trusts total. A size-less caller keeps the old answer (everything,
      // page 1 of 1); page defaults to 1, so old size+no-page callers are
      // unchanged too.
      const total = items.length;
      const sizeNum = sizeParam !== null && Number.isFinite(Number(sizeParam))
        ? Math.max(0, Number(sizeParam)) : total;
      const pageRaw = params.get("page");
      const pageNumRaw = pageRaw !== null ? Number(pageRaw) : NaN;
      const pageNum = Number.isFinite(pageNumRaw) ? Math.max(1, pageNumRaw) : 1;
      const pages = sizeNum > 0 ? Math.max(1, Math.ceil(total / sizeNum)) : 1;
      const slice = sizeNum > 0 ? items.slice((pageNum - 1) * sizeNum, pageNum * sizeNum) : [];
      return Response.json({
        items: slice,
        total,
        page: pageNum,
        size: sizeNum,
        pages,
        current_page: pageNum,
        next_page: pageNum < pages ? pageNum + 1 : null,
        previous_page: pageNum > 1 ? pageNum - 1 : null,
        current_page_backwards: false,
      });
    }

    // POST /workspaces/:w/conclusions/query (T16b, ADR-0011 decision 1) -
    // like the real route (probed on pilot 2026-11-01): body
    // {query, top_k, distance, filters:{observer, observed}}, answer is a
    // plain ARRAY of conclusions. The fake has no embeddings: `distance` is
    // ignored and "relevance order" is creation order; filters are exact
    // matches on observer_id/observed_id (the key names are observer/
    // observed HERE, unlike the list route's *_id). An unknown filter key
    // answers 422, mirroring the list route's live behaviour.
    if (segs.length === 4 && segs[2] === "conclusions" && segs[3] === "query" && method === "POST") {
      const b = (body ?? {}) as { top_k?: unknown; filters?: Record<string, unknown> };
      const known = ["observer", "observed", "session_id"];
      for (const k of Object.keys(b.filters ?? {})) {
        if (!known.includes(k)) {
          return Response.json({ detail: `Column '${k}' does not exist on Document` }, { status: 422 });
        }
      }
      const f = b.filters ?? {};
      let items = (state.conclusions.get(w) ?? []).slice() as Array<Record<string, unknown>>;
      if (typeof f.observer === "string") items = items.filter((c) => c.observer_id === f.observer);
      if (typeof f.observed === "string") items = items.filter((c) => c.observed_id === f.observed);
      if (typeof f.session_id === "string") items = items.filter((c) => c.session_id === f.session_id);
      const topK = typeof b.top_k === "number" && Number.isFinite(b.top_k) ? Math.max(0, b.top_k) : 10;
      return Response.json(items.slice(0, topK));
    }

    // POST /workspaces/:w/conclusions - like the real route (probed
    // 2026-10-28): BATCH body {conclusions:[...]}, 201 with an array.
    if (segs.length === 3 && segs[2] === "conclusions" && method === "POST") {
      const b = (body ?? {}) as { conclusions?: unknown };
      if (!Array.isArray(b.conclusions)) {
        return Response.json({ detail: "conclusions array required" }, { status: 400 });
      }
      for (const item of b.conclusions) {
        const c = (item ?? {}) as Record<string, unknown>;
        for (const k of ["observer_id", "observed_id", "session_id"] as const) {
          if (typeof c[k] === "string" && !ID_RE.test(c[k] as string)) return badId(k, c[k] as string);
        }
        // live precondition (T24 row probe): creating needs EXISTING peers -
        // an uncreated observer/observed answers 404, session membership
        // does not matter. addConclusion() seeds past this route on purpose.
        for (const k of ["observer_id", "observed_id"] as const) {
          const p = c[k];
          if (typeof p === "string" && !state.peers.get(w)?.has(p)) return notFound();
        }
      }
      const list = state.conclusions.get(w) ?? [];
      const recs = b.conclusions.map((item) => {
        const rec = {
          id: `concl-${list.length + 1}`,
          workspace_id: w,
          level: "explicit",
          source_ids: [],
          times_derived: 1,
          created_at: new Date().toISOString(),
          ...(item as object),
        };
        list.push(rec);
        return rec;
      });
      state.conclusions.set(w, list);
      return Response.json(recs, { status: 201 });
    }

    // GET /workspaces/:w/queue/status (E10) - quiet queue unless seeded
    if (segs.length === 4 && segs[2] === "queue" && segs[3] === "status" && method === "GET") {
      return Response.json(
        state.queue.get(w) ?? {
          total_work_units: 0,
          completed_work_units: 0,
          in_progress_work_units: 0,
          pending_work_units: 0,
          sessions: {},
        },
      );
    }

    // POST /workspaces/:w/search (T16d) - body {query, filters?, limit}
    // (schemas WorkspaceMessageSearchOptions); the answer is a plain ARRAY
    // of messages (schemas Message: id/peer_id/session_id aliases), and the
    // real route pins filters["workspace_id"] itself
    // (routers/workspaces.py search_workspace). The fake has no embeddings:
    // relevance is arrival order, and the query is a case-insensitive
    // substring match on content (fail closed: match nothing, not
    // everything). limit defaults to 10 like the schema. filters and scope
    // are not modelled - the plugin client sends neither.
    if (segs.length === 3 && segs[2] === "search" && method === "POST") {
      const b = (body ?? {}) as { query?: unknown; limit?: unknown };
      if (typeof b.query !== "string" || b.query === "") {
        return Response.json({ detail: "query required" }, { status: 400 });
      }
      const q = b.query.toLowerCase();
      const hits: Record<string, unknown>[] = [];
      for (const [key, msgs] of state.messages) {
        if (!key.startsWith(`${w}/`)) continue;
        for (const m of msgs) {
          if (typeof m.content === "string" && m.content.toLowerCase().includes(q)) hits.push(m);
        }
      }
      const limit = typeof b.limit === "number" && Number.isFinite(b.limit) ? Math.max(0, b.limit) : 10;
      return Response.json(
        hits.slice(0, limit).map((m, i) => ({
          id: typeof m.id === "string" ? m.id : `msg-${i + 1}`,
          content: m.content,
          peer_id: typeof m.peer_id === "string" ? m.peer_id : "unknown",
          session_id: m.session_id,
          created_at: typeof m.created_at === "string" ? m.created_at : new Date().toISOString(),
          metadata: m.metadata ?? {},
        })),
      );
    }

    // POST /workspaces/:w/chat. Like the real server (ADR-0004 amendment
    // finding): a body.scope naming a scope that does not exist 404s.
    if (segs.length === 3 && segs[2] === "chat" && method === "POST") {
      const scope = (body as { scope?: unknown } | undefined)?.scope;
      if (typeof scope === "string" && !ID_RE.test(scope)) return badId("scope", scope);
      if (typeof scope === "string" && !state.scopes.has(`${w}/${scope}`)) {
        return Response.json({ detail: `Scope '${scope}' not found` }, { status: 404 });
      }
      return Response.json({ content: "fake-honcho fixed answer" });
    }

    return notFound();
  }

  async function handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = undefined; // GET, or a POST without a JSON body
    }
    requests.push({ method: req.method, path: `${u.pathname}${u.search}`, body, at: Date.now() });

    if (failPat !== null && u.pathname.includes(failPat)) {
      const bodyText = failBody === undefined ? "" : JSON.stringify(body) ?? "";
      if (failBody === undefined || bodyText.includes(failBody)) {
        return Response.json({ detail: "fake: forced pattern failure" }, { status: failStatus });
      }
    }

    for (const s of scripted) {
      if (s.statuses.length > 0 && u.pathname.includes(s.pattern) && (s.method === undefined || req.method === s.method)) {
        const st = s.statuses.shift() as number;
        return Response.json({ detail: "fake: scripted status" }, { status: st });
      }
    }

    for (const s of slowPats) {
      if (u.pathname.includes(s.pattern)) {
        // registered in `slow` like mode("slow"): stop()/refuse release it
        await new Promise<void>((res) => {
          const t = setTimeout(() => {
            slow.delete(t);
            res();
          }, s.delayMs);
          slow.set(t, () => res());
        });
      }
    }

    switch (current) {
      case "500":
        return Response.json({ detail: "fake" }, { status: 500 });
      case "hang":
        // no response until stop() (or refuse) releases us; clients time out
        await new Promise<void>((res) => hung.add(() => res()));
        return Response.json({ detail: "fake: abandoned" }, { status: 503 });
      case "slow": {
        await new Promise<void>((res) => {
          const t = setTimeout(() => {
            slow.delete(t);
            res();
          }, delayMs);
          slow.set(t, () => res());
        });
        break; // then answer correctly
      }
      default:
        break;
    }

    // the status tool reads the version from the ORIGIN's openapi.json, like
    // the real server serves it outside /v3 (probed 2026-10-28). O9: callers
    // may pick the answered version (default keeps fake-3.5.0).
    if (u.pathname === "/openapi.json") {
      return Response.json({ openapi: "3.1.0", info: { title: "fake-honcho", version: opts?.version ?? "fake-3.5.0" } });
    }
    if (!u.pathname.startsWith("/v3/")) return notFound();
    let segs: string[];
    try {
      segs = u.pathname.slice(4).split("/").map(decodeURIComponent);
    } catch {
      return notFound(); // undecodable path segment
    }
    return okRoute(segs, req.method, body, u.searchParams);
  }

  const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });

  const releaseWaiters = (): void => {
    for (const r of hung) r();
    hung.clear();
    for (const [t, r] of slow) {
      clearTimeout(t);
      r();
    }
    slow.clear();
  };

  let srv: ReturnType<typeof serve> | null = serve(0);
  const port = srv.port;
  const url = `http://127.0.0.1:${port}/v3`;

  function failPattern(
    pattern: string | null,
    opts?: { status?: number; bodyContains?: string },
  ): void {
    failPat = pattern;
    failStatus = opts?.status ?? 500;
    failBody = opts?.bodyContains;
  }

  function scriptPattern(pattern: string, statuses: number[], opts?: { method?: string }): void {
    scripted.push({ pattern, statuses: [...statuses], method: opts?.method });
  }

  function slowPattern(pattern: string, delayMs: number): void {
    slowPats.push({ pattern, delayMs });
  }

  function mode(m: FakeMode, opts?: { delayMs?: number }): void {
    current = m;
    delayMs = opts?.delayMs ?? 0;
    if (m === "refuse") {
      if (srv) {
        const s = srv;
        srv = null;
        s.stop();
        releaseWaiters();
      }
    } else if (!srv) {
      srv = serve(port); // same port, per the interface
    }
  }

  async function stop(): Promise<void> {
    if (srv) {
      const s = srv;
      srv = null;
      s.stop();
    }
    releaseWaiters(); // no hung or slow waiter survives stop()
  }

  function setSummary(workspace: string, sessionId: string, s: FakeSummary): void {
    const key = `${workspace}/${sessionId}`;
    if (!state.sessions.has(key)) {
      state.sessions.set(key, {
        id: sessionId,
        workspace_id: workspace,
        is_active: true,
        metadata: {},
        created_at: new Date().toISOString(),
      });
    }
    state.summaries.set(key, s);
  }

  function setPeerCard(workspace: string, peer: string, lines: string[]): void {
    state.peerCards.set(`${workspace}/${peer}`, lines);
  }

  function setSessionCreatedAt(workspace: string, sessionId: string, iso: string): void {
    const key = `${workspace}/${sessionId}`;
    const s = state.sessions.get(key);
    if (s !== undefined) s.created_at = iso;
  }

  function addConclusion(workspace: string, c: FakeConclusionSeed): void {
    const list = state.conclusions.get(workspace) ?? [];
    list.push({
      id: `concl-${list.length + 1}`,
      workspace_id: workspace,
      level: "explicit",
      source_ids: [],
      times_derived: 1,
      created_at: new Date().toISOString(),
      ...c,
    });
    state.conclusions.set(workspace, list);
  }

  return { url, requests, mode, failPattern, scriptPattern, slowPattern, state, setSummary, setPeerCard, setSessionCreatedAt, addConclusion, stop };
}
