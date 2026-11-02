// Small fetch client for the Honcho v3 REST API (ADR-0001). Every call is
// time-boxed, never throws, and returns {ok:true,data} | {ok:false,error,kind}.
// `kind` distinguishes failure modes (ADR-0006 R2):
//   connect - request never reached the server (refused, DNS, unreachable)
//   timeout - request may have been sent when the deadline fired
//   http    - server answered with a non-2xx status
//   parse   - 2xx body was not the JSON we expected
//   unknown - anything else; treat as maybe-sent
// The API key never appears in `error`.

export interface HonchoClientOptions {
  /** Base URL including /v3, e.g. http://localhost:8000/v3 */
  url: string;
  workspace: string;
  apiKey: string;
  timeoutMs: number;
}

export type ErrorKind = "connect" | "timeout" | "http" | "parse" | "unknown";

/**
 * Failure results carry `status` when and only when kind === "http"
 * (ADR-0005 E1 poison classification, T5b-fix-2). Other kinds have none.
 */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; kind: ErrorKind; status?: number };

export interface SessionPeerConfig {
  observe_me?: boolean;
  observe_others?: boolean;
}

export interface MessageInput {
  peer_id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  /** ADR-0005 E4/E5: per-message deriver control (T6a writer). */
  configuration?: { reasoning?: { enabled?: boolean } };
}

export interface Session {
  id: string;
  uid?: string;
  is_active?: boolean;
  workspace_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface Conclusion {
  id: string;
  content: string;
  observer_id: string;
  observed_id: string;
  session_id?: string | null;
  level?: string;
  created_at?: string;
}

/**
 * One message-search hit (T16d, ADR-0011 decision 5): POST /workspaces/<w>/
 * search answers list[schemas.Message], whose schema aliases public_id /
 * peer_name / session_name to id / peer_id / session_id (reference
 * schemas/api.py Message). Extra server keys (metadata, token_count) are
 * ignored here.
 */
export interface SearchMessage {
  id: string;
  content: string;
  peer_id: string;
  session_id: string;
  created_at?: string;
}

export interface SessionSummaries {
  id: string;
  short_summary: { content: string; created_at?: string } | null;
  long_summary: { content: string; created_at?: string } | null;
}

export interface PeerCard {
  peer_card: string[] | null;
}

export interface ChatResult {
  content: string | null;
}

export interface ConclusionInput {
  content: string;
  observer_id: string;
  observed_id: string;
  session_id?: string;
}

export interface QueueStatus {
  total_work_units: number;
  completed_work_units: number;
  in_progress_work_units: number;
  pending_work_units: number;
  sessions?: Record<string, unknown>;
}

export interface WorkspaceChatInput {
  query: string;
  scope?: string | string[];
  reasoning_level?: string;
}

// Least privilege (T1-fix item 4, ADR-0006 X2): the plugin client has no
// workspace lifecycle. The plugin never creates or deletes workspaces;
// tests own scratch workspace create/delete (tests/support/scratch.ts).
export interface HonchoClient {
  createSession(
    id: string,
    opts: {
      peers: Record<string, SessionPeerConfig>;
      scopes?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<Result<Session>>;
  addSessionPeers(
    sessionId: string,
    peers: Record<string, SessionPeerConfig>,
  ): Promise<Result<Session>>;
  addMessages(
    sessionId: string,
    messages: MessageInput[],
  ): Promise<Result<unknown>>;
  listScopeSessions(
    scope: string,
    opts?: { size?: number; reverse?: boolean },
  ): Promise<Result<Page<Session>>>;
  /**
   * POST /workspaces/<w>/sessions/list with the SessionGet body
   * `{ filters: { metadata: {...} } }` (ADR-0002 free-n). Live v3.4.0, probed
   * 2026-10-28: a metadata filter is an EXACT match on the session's metadata
   * keys and a session whose metadata lacks the key is excluded, so every
   * session we create must stamp its tags. reverse=true orders newest-created
   * first; a filter with no matches answers with an empty page (never 404).
   * size is capped at 100 by the server (422 above).
   */
  listSessions(opts?: {
    filters?: { metadata?: Record<string, string | number | boolean> };
    size?: number;
    reverse?: boolean;
  }): Promise<Result<Page<Session>>>;
  /**
   * POST /workspaces/<w>/conclusions/list with the ConclusionGet body
   * `{ filters: {...} }` (ADR-0005 E8 decisions block). Live v3.4.0, probed
   * 2026-10-28: filters observer_id / observed_id / session_id are exact
   * matches; a filter key the server does not know answers 422 ("Column 'x'
   * does not exist on Document"); no match answers an empty page (never 404);
   * reverse=true orders newest-created first; size is capped at 100.
   */
  listConclusions(opts?: {
    filters?: { observer_id?: string; observed_id?: string; session_id?: string };
    size?: number;
    reverse?: boolean;
  }): Promise<Result<Page<Conclusion>>>;
  /**
   * POST /workspaces/<w>/conclusions/query with body
   * `{ query, top_k, distance, filters: { observer, observed } }`
   * (T16b, ADR-0011 decision 1; the pilot probe of 2026-11-01 ran this
   * exact shape live). The answer is an ARRAY of conclusions (not a page),
   * already in server relevance order; items at or beyond `distance` from
   * the query embedding are excluded server-side. Same error kinds and
   * timeouts as every other call here.
   */
  queryConclusions(opts: {
    query: string;
    top_k: number;
    distance: number;
    filters: { observer: string; observed: string };
  }): Promise<Result<Conclusion[]>>;
  /**
   * POST /workspaces/<w>/search with body `{ query, limit }` (T16d,
   * ADR-0011 decision 5). The answer is a PLAIN ARRAY of messages in the
   * server's hybrid (ILIKE + vector) relevance order; the route pins the
   * workspace filter itself (reference routers/workspaces.py
   * search_workspace), so no extra filter is needed to stay inside our
   * workspace. limit defaults to 10 and allows 1..100 (schemas
   * MessageSearchOptions).
   */
  searchMessages(opts: { query: string; limit: number }): Promise<Result<SearchMessage[]>>;
  getSessionSummaries(sessionId: string): Promise<Result<SessionSummaries>>;
  getPeerCard(peerId: string): Promise<Result<PeerCard>>;
  /**
   * POST /workspaces/<w>/conclusions with the BATCH body
   * `{ conclusions: [input] }` - live v3.4.0, probed 2026-10-28: the route
   * answers 201 with an array; a single un-wrapped object is not the schema.
   * Creating needs EXISTING peers and an existing session (404 otherwise),
   * so ensure the session first (writer.ts ensureSession).
   */
  createConclusion(input: ConclusionInput): Promise<Result<unknown>>;
  /** GET /workspaces/<w>/queue/status (E10 status tool). */
  queueStatus(): Promise<Result<QueueStatus>>;
  workspaceChat(
    input: WorkspaceChatInput,
    opts?: { timeoutMs?: number },
  ): Promise<Result<ChatResult>>;
}

const snippetLimit = 200;

function snippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > snippetLimit ? `${t.slice(0, snippetLimit)}…` : t;
}

export function createClient(opts: HonchoClientOptions): HonchoClient {
  const base = opts.url.replace(/\/+$/, "");
  const w = encodeURIComponent(opts.workspace);

  // Belt and braces: the key is only ever in a header, but if a server echoed
  // it back we still must not put it in an error string.
  const scrub = (msg: string): string =>
    opts.apiKey !== "" ? msg.split(opts.apiKey).join("[redacted]") : msg;

  // ADR-0001 timeout range, enforced here too for direct callers of the
  // client (T2c): out-of-range returns a Result with kind "unknown" instead
  // of throwing or silently narrowing - AbortSignal.timeout itself would
  // reject absurd values with a RangeError.
  // The CEILING is 90 s, not the env contract's 60 s: the ask tool's chat
  // needs 90 s per ADR-0004 amendment (reasoning_level low measures 27-50 s,
  // and 60 s truncated real answers). loadConfig still validates
  // HONCHO_TIMEOUT_MS at 1..60000; only per-call opts can reach 90000.
  const TIMEOUT_MIN = 1;
  const TIMEOUT_MAX = 90_000;
  const validTimeout = (ms: number): boolean =>
    Number.isInteger(ms) && ms >= TIMEOUT_MIN && ms <= TIMEOUT_MAX;

  async function request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Result<T>> {
    if (!validTimeout(timeoutMs)) {
      return {
        ok: false,
        error: `timeoutMs must be an integer ${TIMEOUT_MIN}..${TIMEOUT_MAX}, got ${timeoutMs}`,
        kind: "unknown",
      };
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
    };
    let init: RequestInit = { method, headers, signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init = { ...init, body: JSON.stringify(body) };
    }
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, init);
    } catch (err) {
      const aborted =
        signal.aborted ||
        (err instanceof DOMException &&
          (err.name === "TimeoutError" || err.name === "AbortError"));
      const kind: ErrorKind = aborted
        ? "timeout"
        : err instanceof TypeError
          ? "connect"
          : "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrub(`${method} ${path}: ${msg}`), kind };
    }
    if (!resp.ok) {
      let detail = "";
      try {
        // Scrub BEFORE truncating: a server that echoes the key can land it
        // across the snippet boundary, and a truncated key is still key
        // material (review T2 attack 3).
        detail = snippet(scrub(await resp.text()));
      } catch {
        // body unreadable; status is still the fact that matters
      }
      return {
        ok: false,
        error: scrub(`${method} ${path}: HTTP ${resp.status}${detail ? ` ${detail}` : ""}`),
        kind: "http",
        status: resp.status,
      };
    }
    if (resp.status === 204) return { ok: true, data: null as T };
    // Parse manually: resp.json() on some runtimes resolves undefined for an
    // empty body instead of throwing, which would hide a truncated reply
    // (review T2). 202 (delete accepted) legitimately has no body.
    let text: string;
    try {
      text = await resp.text();
    } catch (err) {
      if (resp.status === 202) return { ok: true, data: null as T };
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrub(`${method} ${path}: unreadable body (${msg})`), kind: "parse" };
    }
    if (text === "") {
      if (resp.status === 202) return { ok: true, data: null as T };
      return { ok: false, error: scrub(`${method} ${path}: empty body`), kind: "parse" };
    }
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrub(`${method} ${path}: invalid JSON (${msg})`), kind: "parse" };
    }
  }

  const sessionPath = (sessionId: string): string =>
    `/workspaces/${w}/sessions/${encodeURIComponent(sessionId)}`;

  return {
    createSession(id, o) {
      const body: Record<string, unknown> = { id, peers: o.peers };
      if (o.scopes !== undefined) body.scopes = o.scopes;
      if (o.metadata !== undefined) body.metadata = o.metadata;
      return request<Session>("POST", `/workspaces/${w}/sessions`, body, opts.timeoutMs);
    },
    addSessionPeers(sessionId, peers) {
      return request<Session>("POST", `${sessionPath(sessionId)}/peers`, peers, opts.timeoutMs);
    },
    addMessages(sessionId, messages) {
      // Honcho caps a batch at 100 messages; callers chunk (see writer hooks).
      return request<unknown>(
        "POST",
        `${sessionPath(sessionId)}/messages`,
        { messages },
        opts.timeoutMs,
      );
    },
    listScopeSessions(scope, o = {}) {
      const params = new URLSearchParams();
      if (o.size !== undefined) params.set("size", String(o.size));
      if (o.reverse !== undefined) params.set("reverse", String(o.reverse));
      const qs = params.toString();
      return request<Page<Session>>(
        "POST",
        `/workspaces/${w}/scopes/${encodeURIComponent(scope)}/sessions/list${qs ? `?${qs}` : ""}`,
        undefined,
        opts.timeoutMs,
      );
    },
    listSessions(o = {}) {
      const params = new URLSearchParams();
      if (o.size !== undefined) params.set("size", String(o.size));
      if (o.reverse !== undefined) params.set("reverse", String(o.reverse));
      const qs = params.toString();
      // No filters -> no body: the server treats an absent/empty SessionGet as
      // "no filters" (reference routers/sessions.py get_sessions).
      const body = o.filters === undefined ? undefined : { filters: o.filters };
      return request<Page<Session>>(
        "POST",
        `/workspaces/${w}/sessions/list${qs ? `?${qs}` : ""}`,
        body,
        opts.timeoutMs,
      );
    },
    listConclusions(o = {}) {
      const params = new URLSearchParams();
      if (o.size !== undefined) params.set("size", String(o.size));
      if (o.reverse !== undefined) params.set("reverse", String(o.reverse));
      const qs = params.toString();
      // No filters -> no body, same as the sessions list (T7b probe).
      const body = o.filters === undefined ? undefined : { filters: o.filters };
      return request<Page<Conclusion>>(
        "POST",
        `/workspaces/${w}/conclusions/list${qs ? `?${qs}` : ""}`,
        body,
        opts.timeoutMs,
      );
    },
    queryConclusions(o) {
      // array body, array answer - no page wrapper on this route (probe
      // 2026-11-01); filters key names are observer/observed HERE, unlike
      // the list route's observer_id/observed_id.
      return request<Conclusion[]>(
        "POST",
        `/workspaces/${w}/conclusions/query`,
        { query: o.query, top_k: o.top_k, distance: o.distance, filters: o.filters },
        opts.timeoutMs,
      );
    },
    searchMessages(o) {
      return request<SearchMessage[]>(
        "POST",
        `/workspaces/${w}/search`,
        { query: o.query, limit: o.limit },
        opts.timeoutMs,
      );
    },
    getSessionSummaries(sessionId) {
      return request<SessionSummaries>("GET", `${sessionPath(sessionId)}/summaries`, undefined, opts.timeoutMs);
    },
    getPeerCard(peerId) {
      return request<PeerCard>("GET", `/workspaces/${w}/peers/${encodeURIComponent(peerId)}/card`, undefined, opts.timeoutMs);
    },
    createConclusion(input) {
      // batch form (T8 live probe): the create route takes {conclusions:[...]}
      return request<unknown>("POST", `/workspaces/${w}/conclusions`, { conclusions: [input] }, opts.timeoutMs);
    },
    queueStatus() {
      return request<QueueStatus>("GET", `/workspaces/${w}/queue/status`, undefined, opts.timeoutMs);
    },
    workspaceChat(input, chatOpts) {
      const body: Record<string, unknown> = { query: input.query, stream: false };
      if (input.scope !== undefined) body.scope = input.scope;
      if (input.reasoning_level !== undefined) body.reasoning_level = input.reasoning_level;
      return request<ChatResult>(
        "POST",
        `/workspaces/${w}/chat`,
        body,
        chatOpts?.timeoutMs ?? opts.timeoutMs,
      );
    },
  };
}
