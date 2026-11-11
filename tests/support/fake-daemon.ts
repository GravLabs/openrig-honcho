// T16f: the minimal fake OpenRig daemon for src/daemon.ts client tests.
// Serves ONLY the routes the client calls (shapes from the read-only 0.7.2
// probes: outbox list = PLAIN ARRAY, queue item = the show document; O1 adds
// the list state split and <id>/transitions).
// Not a Honcho fake - that stays tests/support/fake-honcho.ts.

export interface FakeDaemonOpts {
  /** body for GET /api/queue/outbox/list (default: the empty array) */
  outbox?: unknown;
  outboxStatus?: number;
  /** body for GET /api/queue/list (default: the empty array) - T25 */
  queueList?: unknown;
  /** O1: body for GET /api/queue/list?state=done (falls back to queueList) */
  queueListDone?: unknown;
  /** O1: body for GET /api/queue/list with no state (falls back to queueList) */
  queueListAll?: unknown;
  /** O1: body for GET /api/queue/<id>/transitions; a function is called
   * with the id (default: the empty array) */
  transitions?: unknown | ((qitemId: string) => unknown);
  /** body for GET /api/queue/<id> (default: the empty object) */
  item?: unknown;
  itemStatus?: number;
  /** artificial latency applied to every response (timeout tests) */
  delayMs?: number;
}

export interface FakeDaemon {
  /** base URL with no trailing slash, e.g. http://127.0.0.1:41234 */
  url: string;
  close(): void;
}

export async function startFakeDaemon(opts: FakeDaemonOpts = {}): Promise<FakeDaemon> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (opts.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (path === "/api/queue/outbox/list") {
        return Response.json(opts.outbox ?? [], { status: opts.outboxStatus ?? 200 });
      }
      if (path === "/api/queue/list") {
        const q = new URL(req.url).searchParams;
        if (!q.has("destination") && q.get("state") === "done") {
          return Response.json(opts.queueListDone ?? opts.queueList ?? []);
        }
        if (!q.has("destination") && !q.has("state")) {
          return Response.json(opts.queueListAll ?? opts.queueList ?? []);
        }
        return Response.json(opts.queueList ?? []);
      }
      const trMatch = /^\/api\/queue\/([^/]+)\/transitions$/.exec(path);
      if (trMatch !== null) {
        const t = opts.transitions ?? [];
        return Response.json(typeof t === "function" ? t(decodeURIComponent(trMatch[1])) : t);
      }
      if (path.startsWith("/api/queue/") && path.length > "/api/queue/".length) {
        return Response.json(opts.item ?? {}, { status: opts.itemStatus ?? 200 });
      }
      return Response.json({ detail: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}

/** The URL of a daemon that was up and is now gone (connection-refused tests). */
export async function deadDaemonUrl(): Promise<string> {
  const d = await startFakeDaemon();
  const url = d.url;
  d.close();
  return url;
}
