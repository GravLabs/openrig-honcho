// Review T2 (dev.review). Local Bun.serve only — never the real Honcho server
// (per qitem-20261028040458-a7eec844fc028c26). Attacks: ADR-0006 R2 error
// kinds + never-throws battery, X-secrets (key echo incl. across the snippet
// limit), X2/path safety (dot-segment traversal out of the bound workspace),
// assertScratchName reject list, and absurd timeoutMs.
import { describe, expect, test } from "bun:test";
import { createClient } from "../../plugin/src/honcho.ts";
import { assertScratchName, SCRATCH_PREFIX } from "../support/scratch.ts";

type Seen = { method: string; pathname: string; url: string };

function mkServer(handler: (req: Request, seen: Seen[]) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      seen.push({ method: req.method, pathname: u.pathname, url: req.url });
      return handler(req, seen);
    },
  });
  return {
    seen,
    clientUrl: `http://127.0.0.1:${server.port}/v3`,
    port: server.port,
    stop: () => server.stop(true),
  };
}

const W = "honcho-bridge-scratch-revt2";
const client = (url: string, timeoutMs = 2000) =>
  createClient({ url, workspace: W, apiKey: "local", timeoutMs });

// Resolves to the Result; a thrown/rejected client call fails the test via the
// catch below — the "never throws" contract means it must NOT reject.
async function call(p: Promise<unknown>): Promise<{ rejected: boolean; res?: any; err?: unknown }> {
  try {
    return { rejected: false, res: await p };
  } catch (err) {
    return { rejected: true, err };
  }
}

describe("T2 attack 1+2: R2 error kinds, never throws (fake servers)", () => {
  test("connect refused -> kind connect", async () => {
    const c = client("http://127.0.0.1:1/v3");
    const { rejected, res } = await call(c.getPeerCard("p"));
    expect(rejected).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("connect");
  });

  test("hanging server -> kind timeout, fires within timeoutMs + 200ms", async () => {
    const s = mkServer(async () => {
      await new Promise((r) => setTimeout(r, 10_000));
      return new Response("late");
    });
    try {
      const c = client(s.clientUrl, 300);
      const t0 = performance.now();
      const { rejected, res } = await call(c.getPeerCard("p"));
      const ms = performance.now() - t0;
      expect(rejected).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.kind).toBe("timeout");
      expect(ms).toBeLessThanOrEqual(500);
    } finally {
      s.stop();
    }
  });

  test("500 -> kind http", async () => {
    const s = mkServer(() => new Response("server exploded", { status: 500 }));
    try {
      const { rejected, res } = await call(client(s.clientUrl).getPeerCard("p"));
      expect(rejected).toBe(false);
      expect([res.ok, res.kind]).toEqual([false, "http"]);
    } finally {
      s.stop();
    }
  });

  // NOTE "empty body": on Bun 1.4.2, Response.json() of an empty 200 resolves
  // to null instead of throwing, so the client returns {ok:true,data:null} —
  // this test FAILS on 0b70980 by design. A 2xx that is not the JSON we
  // expected must be {ok:false,kind:"parse"} (module header contract); as-is,
  // callers get a null cast as T and only survive because hooks catch.
  for (const [name, resp] of [
    ["html body", () => new Response("<html><body>oops</body></html>", { status: 200 })],
    ["empty body", () => new Response("", { status: 200 })],
    ["huge invalid json", () => new Response("<!doctype html>".repeat(200_000), { status: 200 })],
  ] as Array<[string, () => Response]>) {
    test(`200 with ${name} -> kind parse, no throw`, async () => {
      const s = mkServer(resp);
      try {
        const { rejected, res } = await call(client(s.clientUrl).getPeerCard("p"));
        expect(rejected).toBe(false);
        expect(res.ok).toBe(false);
        expect(res.kind).toBe("parse");
      } finally {
        s.stop();
      }
    });
  }

  // 202/204 no-body handling lives in request() and is shared by every
  // method, so it is exercised through a kept GET after T1-fix item 4
  // removed workspace create/delete from the plugin client.
  for (const [name, resp] of [
    ["204", () => new Response(null, { status: 204 })],
    ["202 empty", () => new Response("", { status: 202 })],
  ] as Array<[string, () => Response]>) {
    test(`${name} -> ok true, no throw`, async () => {
      const s = mkServer(resp);
      try {
        const { rejected, res } = await call(client(s.clientUrl).getPeerCard("p"));
        expect(rejected).toBe(false);
        expect(res.ok).toBe(true);
      } finally {
        s.stop();
      }
    });
  }
});

describe("T2 attack 3: the API key never appears in error", () => {
  const KEY = "hck-reviewfakekey-ABCDEFGHIJKLMNOP0123456789"; // fake-secret

  function echoServer(echoPrefix: string) {
    return mkServer((req) => {
      const auth = req.headers.get("authorization") ?? "";
      return new Response(`${echoPrefix}auth failed for ${auth}`, { status: 500 });
    });
  }

  const keyClient = (url: string) =>
    createClient({ url, workspace: W, apiKey: KEY, timeoutMs: 2000 });

  test("direct echo of Authorization is scrubbed", async () => {
    const s = echoServer("");
    try {
      const res = await keyClient(s.clientUrl).getPeerCard("p");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).not.toContain(KEY);
        expect(res.error).toContain("[redacted]");
      }
    } finally {
      s.stop();
    }
  });

  test("echo pushed past the 200-char snippet limit leaks no key fragment", async () => {
    // "auth failed for Bearer " is 23 chars; pad so the key starts at offset
    // 180 of the body — 20 key chars then sit inside the 200-char snippet.
    const pad = "E".repeat(157);
    const s = echoServer(pad);
    try {
      const res = await keyClient(s.clientUrl).getPeerCard("p");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).not.toContain(KEY);
        // A fragment (whatever survived truncation) is still key material:
        expect(res.error).not.toContain(KEY.slice(0, 20));
      }
    } finally {
      s.stop();
    }
  });
});

describe("T2 attack 4+6: ids cannot reach another path or workspace", () => {
  // PASSING on 0b70980, verified at the wire: encodeURIComponent turns "/" into
  // %2F, so no lone ".." path segment can ever form from ids containing slashes;
  // a bare ".." id pops one segment (to the workspace root) but cannot escape
  // the bound workspace. Guards against regressions in the encoding.
  const ownPrefix = `/v3/workspaces/${W}/`;

  async function probePaths(id: string): Promise<Seen[]> {
    const s = mkServer(() => new Response("{}", { status: 200 }));
    try {
      const c = client(s.clientUrl);
      await c.getPeerCard(id);
      await c.getSessionSummaries(id);
      await c.addSessionPeers(id, { p: { observe_me: true } });
      return s.seen;
    } finally {
      s.stop();
    }
  }

  for (const id of ["../../evil", "../evil/x", "..%2f..%2fevil", ".."]) {
    test(`id ${JSON.stringify(id)} stays inside the bound workspace`, async () => {
      const seen = await probePaths(id);
      expect(seen.length).toBe(3);
      for (const req of seen) {
        expect(req.pathname.startsWith(ownPrefix)).toBe(true);
      }
    });
  }

  test("a normal id with / ? # %2F stays one encoded segment", async () => {
    const seen = await probePaths("a/b?c#d%2F");
    for (const req of seen) {
      expect(req.pathname.startsWith(ownPrefix)).toBe(true);
      expect(req.pathname).toContain(encodeURIComponent("a/b?c#d%2F"));
    }
  });
});

describe("T2 attack 1 extra: absurd timeoutMs never rejects", () => {
  test("timeoutMs 1e20 (reachable via HONCHO_TIMEOUT_MS) -> resolves a Result", async () => {
    const s = mkServer(() => new Response("{}", { status: 200 }));
    try {
      const { rejected, res } = await call(createClient({ url: s.clientUrl, workspace: W, apiKey: "local", timeoutMs: 1e20 }).getPeerCard("p"));
      expect(rejected).toBe(false);
      expect(typeof res.ok).toBe("boolean");
    } finally {
      s.stop();
    }
  });
});

describe("T1-fix item 4: no workspace create/delete in the plugin client", () => {
  test("plugin/src/honcho.ts names neither ensureWorkspace nor deleteWorkspace", async () => {
    const src = await Bun.file(
      new URL("../../plugin/src/honcho.ts", import.meta.url),
    ).text();
    expect(src).not.toContain("ensureWorkspace");
    expect(src).not.toContain("deleteWorkspace");
    expect(src).not.toContain("DELETE");
  });
});

describe("T2 attack 5: assertScratchName reject list", () => {
  for (const bad of [
    "openrig",
    "other-rig",
    "pilot",
    "my-profile",
    "honcho-bridge-scratch",
    "xhoncho-bridge-scratch-1",
    "HONCHO-BRIDGE-SCRATCH-1",
    "",
  ]) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() => assertScratchName(bad)).toThrow();
    });
  }
  test("accepts a proper scratch name", () => {
    expect(() => assertScratchName(`${SCRATCH_PREFIX}revt2-abc`)).not.toThrow();
  });
});
