// T8d-1 item 2 (ADR-0006 S4): the server contract test against the REAL
// Honcho server. READ-ONLY by construction: the only network call is GET
// /openapi.json — no workspace is touched at all, so no scratch workspace is
// needed (hard limits: no writes outside honcho-bridge-scratch*, no real
// workspaceChat).
//
// What it pins: the exact HTTP surface plugin/src/honcho.ts uses — every
// path+method must exist in the live OpenAPI; every request body field we
// send must exist in the request schema with a compatible type; every query
// param we set must be declared; every response field we read must exist.
// info.version must be on a tested line (3.5.x or 3.6.x, O9) — the same exact
// major.minor rule as the status report (versionAccepted below, imported, not
// copied), and a server upgrade onto any other line FAILS this gate by design,
// so the drift is caught before users hit it.
//
// When the server is unreachable the tests SKIP with a clear message; the
// gate treats a skip as a failure, so a dead server still stops the release.

import { describe, expect, test } from "bun:test";

import { versionAccepted } from "../../plugin/src/status.ts";

const SPEC_URL = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? "http://localhost:8000/v3").replace(/\/v3\/?$/, "") + "/openapi.json";

type Kind = "string" | "boolean" | "integer" | "number" | "object" | "array[string]" | "array[object]";

interface CallSpec {
  /** The HonchoClient method it comes from (drift message helper). */
  client: string;
  method: "GET" | "POST";
  /** Concrete path with ':var' placeholders for the variable segments. */
  path: string;
  /** Body fields we send: name -> sample kind; '?' suffix = we send it only sometimes. */
  body: Record<string, `${Kind}?` | Kind>;
  /** Query params we set. */
  query: string[];
  /** Response fields we read (dots descend objects; 'items.x' descends the array). */
  response: string[];
}

// The complete HTTP surface of plugin/src/honcho.ts (verified against the
// source 2026-10-28). If honcho.ts gains a call, this list must gain it too —
// the "surface is complete" test below greps for new request() paths.
const CALLS: CallSpec[] = [
  { client: "createSession", method: "POST", path: "/workspaces/:w/sessions",
    body: { id: "string", peers: "object", scopes: "array[string]?", metadata: "object?" }, query: [], response: ["id"] },
  { client: "addSessionPeers", method: "POST", path: "/workspaces/:w/sessions/:s/peers",
    body: { "<whole body is a map>": "object" }, query: [], response: ["id"] },
  { client: "addMessages", method: "POST", path: "/workspaces/:w/sessions/:s/messages",
    body: { messages: "array[object]" }, query: [], response: [] },
  { client: "listScopeSessions", method: "POST", path: "/workspaces/:w/scopes/:sc/sessions/list",
    body: {}, query: ["size", "reverse"], response: ["items", "total", "page", "size", "pages", "items.id"] },
  { client: "listSessions", method: "POST", path: "/workspaces/:w/sessions/list",
    body: { filters: "object?" }, query: ["size", "reverse", "page"], response: ["items", "total", "page", "size", "pages", "items.id"] },
  { client: "listConclusions", method: "POST", path: "/workspaces/:w/conclusions/list",
    body: { filters: "object?" }, query: ["size", "reverse", "page"],
    response: ["items", "total", "page", "size", "pages", "items.id", "items.content", "items.created_at"] },
  // T24 (Amendment 2): get-or-create a peer (the ledger peer must exist
  // before its first entry - live probe, T24 row); offset-paged messages
  // list (migrate-ledger reads the leader's decision messages).
  { client: "createPeer", method: "POST", path: "/workspaces/:w/peers",
    body: { id: "string" }, query: [], response: ["id"] },
  { client: "listMessages", method: "POST", path: "/workspaces/:w/sessions/:s/messages/list",
    body: { filters: "object?" }, query: ["size", "reverse", "page"],
    response: ["items", "total", "page", "size", "pages", "items.id"] },
  // the answer is a plain ARRAY (no page wrapper, probe 2026-11-01);
  // fieldExists cannot descend an array root, so response stays [] like
  // createConclusion - recall.ts reads id/content/created_at off elements.
  { client: "queryConclusions", method: "POST", path: "/workspaces/:w/conclusions/query",
    body: { query: "string", top_k: "integer", distance: "number", filters: "object" },
    query: [], response: [] },
  { client: "getSessionSummaries", method: "GET", path: "/workspaces/:w/sessions/:s/summaries",
    body: {}, query: [],
    response: ["id", "short_summary.content", "short_summary.created_at", "long_summary.content", "long_summary.created_at"] },
  { client: "getPeerCard", method: "GET", path: "/workspaces/:w/peers/:p/card",
    body: {}, query: [], response: ["peer_card"] },
  { client: "createConclusion", method: "POST", path: "/workspaces/:w/conclusions",
    body: { conclusions: "array[object]" }, query: [], response: [] },
  { client: "queueStatus", method: "GET", path: "/workspaces/:w/queue/status",
    body: {}, query: [],
    response: ["total_work_units", "completed_work_units", "in_progress_work_units", "pending_work_units"] },
  { client: "workspaceChat", method: "POST", path: "/workspaces/:w/chat",
    body: { query: "string", stream: "boolean", scope: "string?", reasoning_level: "string?" },
    query: [], response: ["content"] },
  // the answer is a plain ARRAY of messages (hybrid search, T16d);
  // fieldExists cannot descend an array root, so response stays [].
  { client: "searchMessages", method: "POST", path: "/workspaces/:w/search",
    body: { query: "string", limit: "integer" }, query: [], response: [] },
];

let spec: Record<string, any> | null = null;
let unreachable = "";
try {
  const r = await fetch(SPEC_URL, { signal: AbortSignal.timeout(8000) });
  if (r.ok) spec = (await r.json()) as Record<string, any>;
  else unreachable = `HTTP ${r.status}`;
} catch (e) {
  unreachable = e instanceof Error ? e.name : String(e);
}
if (spec === null) {
  // clear skip message (the gate counts a skip as a failure)
  console.log(`SKIP contract/schema: Honcho server unreachable at ${SPEC_URL} (${unreachable})`);
}
const t = spec === null ? test.skip : test;

// --- OpenAPI helpers -------------------------------------------------------

const schemaOf = (s: Record<string, any>): Record<string, any> => {
  let cur = s ?? {};
  for (let d = 0; d < 16; d++) {
    if (typeof cur.$ref === "string") {
      const name = cur.$ref.split("/").pop() as string;
      cur = spec?.components?.schemas?.[name] ?? {};
      continue;
    }
    if (Array.isArray(cur.allOf) && cur.allOf.length > 0) {
      const merged: Record<string, any> = { ...cur, properties: {}, allOf: undefined };
      for (const part of cur.allOf) {
        const p = schemaOf(part);
        Object.assign(merged.properties, p.properties ?? {});
        if (p.type !== undefined && merged.type === undefined) merged.type = p.type;
        if (p.items !== undefined && merged.items === undefined) merged.items = p.items;
      }
      return merged;
    }
    const branch = cur.anyOf ?? cur.oneOf;
    if (Array.isArray(branch) && branch.length > 0) {
      const merged: Record<string, any> = { properties: {} };
      for (const part of branch) {
        const p = schemaOf(part);
        Object.assign(merged.properties, p.properties ?? {});
        if (merged.type === undefined && p.type !== undefined && p.type !== "null") merged.type = p.type;
        if (merged.items === undefined && p.items !== undefined) merged.items = p.items;
      }
      if (merged.type === undefined && cur.type !== undefined) merged.type = cur.type;
      return merged;
    }
    return cur;
  }
  return cur;
};

/** Union of JSON types a schema accepts (recurses through anyOf/oneOf). */
const typesOf = (s: Record<string, any>, depth = 0): string[] => {
  if (depth > 12) return [];
  const d = schemaOf(s);
  if (Array.isArray(d.type)) return d.type;
  if (typeof d.type === "string") return [d.type];
  const branch = d.anyOf ?? d.oneOf;
  if (Array.isArray(branch)) {
    const out = new Set<string>();
    for (const b of branch) for (const tt of typesOf(b, depth + 1)) out.add(tt);
    return [...out];
  }
  if (d.properties || d.additionalProperties) return ["object"];
  if (d.items) return ["array"];
  return []; // unconstrained {} - accepts anything
};

const findPath = (concrete: string): string | undefined => {
  // the live spec mounts everything under /v3 (the client's base URL carries it)
  const want = ["v3", ...concrete.split("/").filter((s) => s !== "")];
  // /sessions/list also fits a /sessions/{id} template - pick the candidate
  // with the most LITERAL segment matches, so static path segments win
  let best: string | undefined;
  let bestScore = -1;
  for (const tpl of Object.keys(spec?.paths ?? {})) {
    const have = tpl.split("/").filter((s) => s !== "");
    if (have.length !== want.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      if (have[i] === want[i]) score += 1;
      else if (!(have[i].startsWith("{") && have[i].endsWith("}"))) {
        ok = false;
        break;
      }
    }
    if (ok && score > bestScore) {
      best = tpl;
      bestScore = score;
    }
  }
  return best;
};

const opOf = (concrete: string): Record<string, any> | null => {
  const tpl = findPath(concrete);
  if (tpl === undefined) return null;
  return spec?.paths?.[tpl]?.[call.method.toLowerCase()] ?? null;
};

// `call` is scoped per-test via withCall(); helpers above read it from there.
let call: CallSpec = CALLS[0];
const withCall = <T>(c: CallSpec, fn: () => T): T => {
  call = c;
  try {
    return fn();
  } finally {
    call = CALLS[0];
  }
};

const bodySchemaOf = (op: Record<string, any>): Record<string, any> | null => {
  const content = op?.requestBody?.content;
  const json = content?.["application/json"];
  return json?.schema ? schemaOf(json.schema) : null;
};

const response2xxSchema = (op: Record<string, any>): Record<string, any> | null => {
  const codes = Object.keys(op?.responses ?? {}).filter((c) => c.startsWith("2"));
  for (const c of codes) {
    const sch = op.responses[c]?.content?.["application/json"]?.schema;
    if (sch) return schemaOf(sch);
  }
  return null;
};

/** Descend 'a.b' / 'items.x' through properties (arrays descend their items). */
const fieldExists = (root: Record<string, any>, dotted: string): boolean => {
  let cur = root;
  for (const part of dotted.split(".")) {
    cur = schemaOf(cur);
    const props = cur.properties ?? {};
    if (!(part in props)) {
      // a map-typed container (additionalProperties) accepts any key
      const ap = cur.additionalProperties;
      if (ap && typeof ap === "object") {
        cur = ap;
        continue;
      }
      return false;
    }
    cur = props[part];
    const asArray = schemaOf(cur);
    if (asArray.type === "array" && asArray.items) cur = asArray.items;
  }
  return true;
};

const compatible = (kind: Kind, fieldSchema: Record<string, any>): boolean => {
  const types = typesOf(fieldSchema);
  if (types.length === 0) return true; // {} accepts anything
  switch (kind) {
    case "string":
      return types.includes("string");
    case "boolean":
      return types.includes("boolean");
    case "integer":
      return types.includes("integer") || types.includes("number");
    case "number":
      return types.includes("number") || types.includes("integer");
    case "object":
      return types.includes("object") || types.includes("array");
    case "array[string]":
    case "array[object]": {
      if (!types.includes("array")) return false;
      const items = schemaOf(fieldSchema).items;
      if (!items) return true;
      const it = typesOf(items);
      if (it.length === 0) return true;
      return kind === "array[string]" ? it.includes("string") : it.includes("object");
    }
  }
};

// --- tests ------------------------------------------------------------------

describe("contract: real server OpenAPI (read-only) vs plugin/src/honcho.ts", () => {
  t("the surface list matches honcho.ts (no client call is unlisted)", () => {
    const src = require("node:fs").readFileSync(
      new URL("../../plugin/src/honcho.ts", import.meta.url),
      "utf8",
    ) as string;
    // [^)]*? so nested generics like request<Page<Session>>( still match
    const calls = [...src.matchAll(/request<[^)]*?>\(\s*"(GET|POST|PUT)",\s*`([^`]+)`/g)];
    // template path -> segment list: query suffixes cut, ${...} (incl. the
    // sessionPath() helper) become one :x segment per placeholder
    const norm = (p: string): string =>
      p
        .replace(/\$\{[^}]*$/, "") // capture may end inside a ${qs ...} expr
        .split("?")[0]
        .replace(/\$\{sessionPath\([^)]*\)\}/g, "/workspaces/${x}/sessions/${x}")
        .replace(/\$\{[^}]*\}/g, "\u0000")
        .split("/")
        .filter((s) => s !== "")
        .map((s) => (s === "\u0000" ? ":x" : s))
        .join("/");
    for (const m of calls) {
      const p = norm(m[2]);
      const inList = CALLS.some((c) => norm(c.path.replace(/:(w|s|sc|p)(?=\/|$)/g, "${x}")) === p);
      expect(inList).toBe(true); // new honcho.ts call not in CALLS
    }
    expect(calls.length).toBe(CALLS.length);
  });

  t("info.version is on a tested line - 3.5.x or 3.6.x (drift off the lines fails the gate by design)", () => {
    expect(versionAccepted(spec?.info?.version)).toBe(true);
  });

  for (const c of CALLS) {
    t(`${c.client}: ${c.method} ${c.path}`, () =>
      withCall(c, () => {
        const op = opOf(c.path);
        expect(op, `path+method ${c.method} ${c.path} not in the OpenAPI`).not.toBeNull();

        // query params we set are declared (operation- or path-level; $refs
        // resolve through components/parameters)
        const paramNames = (arr: unknown[]): string[] =>
          arr.map((raw) => {
            const p = raw as Record<string, any>;
            if (typeof p.$ref === "string") {
              const n = p.$ref.split("/").pop() as string;
              return String(spec?.components?.parameters?.[n]?.name ?? n);
            }
            return String(p.name);
          });
        const declared = new Set<string>([
          ...paramNames(op.parameters ?? []),
          ...paramNames(spec?.paths?.[findPath(c.path) as string]?.parameters ?? []),
        ]);
        for (const q of c.query) expect(declared.has(q), `query param ${q} not declared`).toBe(true);

        // body fields exist with compatible types
        const bodyFields = Object.entries(c.body).filter(([k]) => k !== "<whole body is a map>");
        if (bodyFields.length > 0) {
          const bs = bodySchemaOf(op);
          expect(bs, `no request body schema for ${c.path}`).not.toBeNull();
          for (const [name, rawKind] of bodyFields) {
            const optional = rawKind.endsWith("?");
            const k = (optional ? rawKind.slice(0, -1) : rawKind) as Kind;
            const props = bs?.properties ?? {};
            expect(name in props, `body field ${name} not in request schema`).toBe(true);
            expect(compatible(k, props[name]), `body field ${name} incompatible with ${k}`).toBe(true);
          }
        }

        // response fields we read exist
        const rs = response2xxSchema(op);
        if (c.response.length > 0) {
          expect(rs, `no 2xx JSON schema for ${c.path}`).not.toBeNull();
          for (const f of c.response) {
            expect(fieldExists(rs as Record<string, any>, f), `response field ${f} missing`).toBe(true);
          }
        }
      }),
    );
  }
});
