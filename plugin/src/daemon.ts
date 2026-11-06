// T16f (ADR-0012 decisions 2-3): the minimal OpenRig daemon client for the
// ASYNC WRITER PATH only - the recall hook never calls it (decision 4). The
// URL arrives from the caller (Config.daemonUrl); no URL means no lookup.
// Never throws: every failure becomes a kind, and callers may log only the
// class. One 1 s budget per call (decision 2's "within 1 s").
//
// Real shapes (read-only probes against the installed 0.7.2, 2026-11-01):
// - GET {url}/api/queue/outbox/list?senderSession=<s>&limit=<n> answers a
//   PLAIN ARRAY, newest first. Keys used: outboxId, senderSession,
//   destinationSession, body (the FULL envelope typed into the pane),
//   tsDispatched (camelCase ISO Z - the ADR text writes ts_dispatched; both
//   spellings are accepted by matchesOutboxEntry). Queue nudges ride as
//   outboxId "wake-intent-<qitemId>" with senderSession daemon@kernel.
// - GET {url}/api/queue/<qitemId> answers the same document
//   `rig queue show` prints (sourceSession, tags, ...).

/** ADR-0012 decision 2: the one lookup budget. */
export const DAEMON_TIMEOUT_MS = 1000;

export interface DaemonFailure {
  ok: false;
  /** no-url: never issued a request; timeout: aborted at the budget;
   * network: fetch rejected; http: non-2xx; parse: body not the shape. */
  kind: "no-url" | "timeout" | "network" | "http" | "parse";
  status?: number;
}

export interface OutboxEntry {
  outboxId: string;
  senderSession?: string;
  destinationSession?: string;
  /** the full typed body, envelope included */
  body?: string;
  tsDispatched?: string;
  /** the ADR's snake_case spelling, tolerated (live 0.7.2 is camelCase) */
  ts_dispatched?: string;
  /** T22 (live 0.7.2 probe): the daemon's own delivery stamp. A wake-intent
   * row's tsDispatched is its STAGE time (committed with the queue row) and
   * can precede delivery by hours; deliveredAt is when the bytes actually
   * landed in the pane. */
  deliveredAt?: string;
}

async function getJson(url: string): Promise<{ ok: true; json: unknown } | DaemonFailure> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DAEMON_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, kind: "http", status: res.status };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, kind: "parse" };
    }
  } catch {
    return { ok: false, kind: ctrl.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** The sender's newest `limit` outbox entries; a PLAIN ARRAY on the wire. */
export async function fetchOutbox(
  daemonUrl: string | undefined,
  senderSession: string,
  limit = 20,
): Promise<{ ok: true; entries: OutboxEntry[] } | DaemonFailure> {
  if (daemonUrl === undefined || daemonUrl === "") return { ok: false, kind: "no-url" };
  const r = await getJson(
    `${daemonUrl}/api/queue/outbox/list?senderSession=${encodeURIComponent(senderSession)}&limit=${limit}`,
  );
  if (!r.ok) return r;
  if (!Array.isArray(r.json)) return { ok: false, kind: "parse" };
  const entries = r.json.filter(
    (e): e is OutboxEntry =>
      typeof e === "object" && e !== null && typeof (e as OutboxEntry).outboxId === "string",
  );
  return { ok: true, entries };
}

/** One queue item's sourceSession + string tags (decision 3). */
export async function fetchQueueItem(
  daemonUrl: string | undefined,
  qitemId: string,
): Promise<{ ok: true; sourceSession?: string; tags: string[] } | DaemonFailure> {
  if (daemonUrl === undefined || daemonUrl === "") return { ok: false, kind: "no-url" };
  const r = await getJson(`${daemonUrl}/api/queue/${encodeURIComponent(qitemId)}`);
  if (!r.ok) return r;
  if (typeof r.json !== "object" || r.json === null) return { ok: false, kind: "parse" };
  const doc = r.json as { sourceSession?: unknown; tags?: unknown };
  const tags = Array.isArray(doc.tags) ? doc.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    ok: true,
    ...(typeof doc.sourceSession === "string" && doc.sourceSession !== ""
      ? { sourceSession: doc.sourceSession }
      : {}),
    tags,
  };
}

// T19b (ADR-0014 decision 1): the digest's open-work part. One unfiltered
// destination fetch, filtered here - the wire answer for
// GET {url}/api/queue/list?destination=<s> is a PLAIN ARRAY of queue docs
// (live probe 2026-11-04 21:40Z): keys used qitemId, state, tsUpdated /
// tsCreated (camelCase ISO Z), body (the FULL brief), destinationSession.
// A single `state=` param does filter server-side (probe: state=pending
// answered []), but the three kept states would mean three 1 s calls, so
// ONE call and client-side keep. Never throws, same kinds, same budget.
const OPEN_STATES: Record<string, number> = { "in-progress": 0, blocked: 1, pending: 2 };

export interface OpenWorkItem {
  qitemId: string;
  /** first non-empty body line, capped - the body is the full brief */
  summary: string;
  state: string;
  /** tsUpdated, else tsCreated, else "" (age label then renders bare) */
  at: string;
}

function summarizeQueueBody(body: unknown): string {
  if (typeof body !== "string") return "";
  for (const ln of body.split("\n")) {
    const t = ln.trim();
    if (t !== "") return t.length <= 120 ? t : `${t.slice(0, 119)}…`;
  }
  return "";
}

/**
 * The queue items OPEN for one seat: destination is this session, state is
 * in-progress, blocked or pending. In-progress first, then blocked, then
 * pending; within a state newest (at) first; max 5. A missing/garbage entry
 * is dropped, never fatal.
 */
export async function fetchOpenWork(
  daemonUrl: string | undefined,
  sessionName: string,
  limit = 5,
): Promise<{ ok: true; items: OpenWorkItem[] } | DaemonFailure> {
  if (daemonUrl === undefined || daemonUrl === "") return { ok: false, kind: "no-url" };
  const r = await getJson(`${daemonUrl}/api/queue/list?destination=${encodeURIComponent(sessionName)}`);
  if (!r.ok) return r;
  if (!Array.isArray(r.json)) return { ok: false, kind: "parse" };
  const items: OpenWorkItem[] = [];
  for (const e of r.json) {
    if (typeof e !== "object" || e === null) continue;
    const d = e as {
      qitemId?: unknown;
      state?: unknown;
      destinationSession?: unknown;
      summary?: unknown;
      body?: unknown;
      tsUpdated?: unknown;
      tsCreated?: unknown;
    };
    if (typeof d.qitemId !== "string" || d.qitemId === "") continue;
    if (typeof d.state !== "string" || !(d.state in OPEN_STATES)) continue;
    if (d.destinationSession !== sessionName) continue;
    const at =
      typeof d.tsUpdated === "string"
        ? d.tsUpdated
        : typeof d.tsCreated === "string"
          ? d.tsCreated
          : "";
    // T25 (architect 22:17Z): queue rows carry their own summary, written
    // for exactly this line - prefer it when it is a usable non-empty string,
    // else the first non-empty body line as before. Same 120-char cap and
    // quoting either way (summarizeQueueBody is the single rule).
    const usable = typeof d.summary === "string" && d.summary.trim() !== "";
    items.push({
      qitemId: d.qitemId,
      summary: summarizeQueueBody(usable ? d.summary : d.body),
      state: d.state,
      at,
    });
  }
  items.sort((a, b) => {
    const o = OPEN_STATES[a.state] - OPEN_STATES[b.state];
    if (o !== 0) return o;
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
  });
  return { ok: true, items: items.slice(0, limit) };
}

/** Trailing whitespace (spaces, tabs, CR/LF): the outbox stores the typed
 * body, hook stdin may carry a trailing newline. Leading side stays exact. */
export function trimTrailing(s: string): string {
  return s.replace(/\s+$/, "");
}

/** The delivery stamp is valid and within the last 10 minutes (the same
 * basis and window matchesOutboxEntry uses) - split out for T22b so a
 * near-miss record can be proven in-window WITHOUT its body matching. */
export function deliveryInWindow(entry: OutboxEntry, nowIso: string): boolean {
  const ts = entry.deliveredAt ?? entry.tsDispatched ?? entry.ts_dispatched;
  if (typeof ts !== "string") return false;
  const at = Date.parse(ts);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return false;
  return at <= now && now - at <= 10 * 60_000;
}

/**
 * T22b (architect 02:13Z 11-06): when the sender, destination and window
 * all match but the body differs, the LOG records the shape of the
 * difference and nothing else - stored length, delivered length, first
 * differing offset, and the CLASS of the character there. Never a
 * character, never text. offset = first differing code-unit index, or the
 * shorter length when one is a prefix of the other, or -1 when equal. The
 * class is of the DELIVERED char at the offset (what this hook received),
 * or the stored char when the delivered text ended there.
 */
export interface BodyShape {
  stored_len: number;
  delivered_len: number;
  offset: number;
  char_class: string;
}

export function bodyMismatchShape(stored: string, delivered: string): BodyShape {
  const n = Math.min(stored.length, delivered.length);
  let offset = -1;
  for (let i = 0; i < n; i++) {
    if (stored[i] !== delivered[i]) {
      offset = i;
      break;
    }
  }
  if (offset === -1 && stored.length !== delivered.length) offset = n;
  const ch =
    offset >= 0 ? (offset < delivered.length ? delivered[offset] : stored[offset]) : "";
  const charClass =
    ch === ""
      ? "none"
      : ch === "\n" || ch === "\r"
        ? "newline"
        : ch.trim() === ""
          ? "space"
          : /\p{L}/u.test(ch)
            ? "letter"
            : /\p{N}/u.test(ch)
              ? "digit"
              : "other";
  return { stored_len: stored.length, delivered_len: delivered.length, offset, char_class: charClass };
}

/**
 * ADR-0012 decision 2's match, pure: destinationSession is this seat's
 * session name; the body equals the raw prompt after trimming trailing
 * whitespace on BOTH; the delivery stamp is valid and within the last 10
 * minutes. T22: the stamp's basis is deliveredAt when the daemon provides
 * it, else tsDispatched (or the snake_case spelling) as before - a
 * wake-intent row's tsDispatched is its stage time, not its delivery (2026
 * -11-05 probe: 207-minute gap), so anchoring on it made every late wake
 * land unverified. A future stamp never matches (no clock-skew grace: shadow
 * mode prefers an honest unverified).
 */
export function matchesOutboxEntry(
  entry: OutboxEntry,
  sessionName: string,
  prompt: string,
  nowIso: string,
): boolean {
  if (entry.destinationSession !== sessionName) return false;
  if (typeof entry.body !== "string" || trimTrailing(entry.body) !== trimTrailing(prompt)) return false;
  return deliveryInWindow(entry, nowIso);
}
