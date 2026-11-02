// T17a (architect brief 2026-11-02, qitem-20261102031536-e3dc9e4487dff7fd):
// carry a seat's recorded decisions and peer card to a NEW peer id.
//
// Why: Honcho 3.4 cannot rename, alias or merge a peer (pilot's architect
// moves pods and becomes design-architect@pilot; its Honcho peer was
// dev-architect). The owner approved carrying the small part worth keeping:
// the decisions recorded with rig_memory remember, and the peer card.
// Messages are NOT re-attributed. The operator runs this on the target
// server's host; this repo never writes to pilot.
//
// Usage:
//   bun run scripts/copy-peer-memory.ts --url <v3 base> --workspace <ws> \
//     --from <peer> --to <peer> [--apply]
// Without --apply it is a DRY RUN: it prints what it would do and writes
// nothing. The API key comes from HONCHO_API_KEY (default "local", same
// convention as scripts and tests).
//
// What counts as a recorded decision (brief, architect 03:20Z facts):
// remember writes a self-conclusion AND a decision message (metadata.kind
// "decision", sent by the peer) in the seat's session. The deriver also
// writes look-alike self-conclusions with no message (818 of 856 on
// pilot), so only the MESSAGES decide what is a recorded decision;
// we match each one to its from-peer self-conclusion by exact content
// (informational - a message whose conclusion is missing, e.g. still
// spooled, is still copied).
//
// Copy shape per decision, in the to-peer's session <to>--<mission>--<n>
// (n by the plugin's freeN, so the new seat's own later sessions do not
// collide; every created session is stamped {rig_peer, mission} like the
// plugin's): an explicit conclusion (observer = observed = to - exactly
// what fetchMissionDecisions reads at session start) AND a decision
// message with metadata.kind "decision", metadata.copied_from <from> and
// metadata.original_at (the original message's created_at). redact() runs
// on the way out as a belt (content was redacted on the way in, and
// redaction is idempotent).
//
// The peer card is copied whole: GET from, PUT to, with every WHOLE-WORD
// occurrence of <from> inside an item replaced by <to> (whole word = not
// adjacent to [A-Za-z0-9_-], since peer ids themselves contain hyphens).
// Decisions are copied verbatim.
//
// Idempotent: a decision whose content already exists as a to-peer
// decision message (metadata.copied_from set by a previous run) is skipped;
// a second --apply creates nothing new.
//
// Output: counts only, never contents (missions, decisions found, created,
// skipped, card items). Exit 0 on success; non-zero with a fact/reason/fix
// triple on any refusal or server failure. Refusals: honcho.dev cloud URLs
// (same rule as the plugin's env.loadConfig), from === to, malformed or
// missing arguments.
//
// Paging (architect ruling 2026-11-02 03:42Z): NO item ceiling. Every list
// is read to the end - the from-peer's sessions, the decision messages in
// each session (pilot's old architect has hundreds of messages per
// session), the matching self-conclusions, and the to-peer's carried copies
// for idempotency - by following the page/pages fields of each page answer
// at size 100. The summary reports the number of pages read.

import { createClient } from "../plugin/src/honcho.ts";
import { redact } from "../plugin/src/redact.ts";
import { clientId } from "../plugin/src/shape.ts";
import { freeN } from "../plugin/src/writer.ts";
import { scopeFor } from "../plugin/src/missions.ts";

const PEER_ID_RE = /^[A-Za-z0-9_-]{1,512}$/;
const PAGE_CAP = 100;

export interface CopyArgs {
  url: string;
  workspace: string;
  apiKey: string;
  from: string;
  to: string;
  apply: boolean;
}

export interface Failure {
  fact: string;
  reason: string;
  fix: string;
}

export interface CopyCounts {
  missions: number;
  found: number;
  created: number;
  skipped: number;
  cardItems: number;
  cardCopied: boolean;
  pages: number;
}

export type CopyResult =
  | ({ ok: true; dry: boolean; counts: CopyCounts } & Partial<Failure>)
  | ({ ok: false } & Failure);

/** The plugin's cloud-host rule (env.ts isCloudHost - kept in sync; the
 * plugin only talks to a self-hosted server, and so does this script). */
function isCloudHost(host: string): boolean {
  return host === "honcho.dev" || host === "api.honcho.dev" || host.endsWith(".honcho.dev");
}

function fail(fact: string, reason: string, fix: string): CopyResult {
  return { ok: false, fact, reason, fix };
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): { ok: true; args: CopyArgs } | { ok: false } & Failure {
  let url = "";
  let workspace = "";
  let from = "";
  let to = "";
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    if (a === "--apply") apply = true;
    else if (a === "--url") url = next() ?? "";
    else if (a === "--workspace") workspace = next() ?? "";
    else if (a === "--from") from = next() ?? "";
    else if (a === "--to") to = next() ?? "";
    else
      return {
        ok: false,
        fact: `unrecognised argument "${a}"`,
        reason: "the script takes only --url, --workspace, --from, --to and --apply",
        fix: "bun run scripts/copy-peer-memory.ts --url <v3 base> --workspace <ws> --from <peer> --to <peer> [--apply]",
      };
  }
  const usageFail = (fact: string): { ok: false } & Failure => ({
    ok: false,
    fact,
    reason: "all four options are required and must be well-formed",
    fix: "bun run scripts/copy-peer-memory.ts --url <v3 base> --workspace <ws> --from <peer> --to <peer> [--apply]",
  });
  if (url === "" || workspace === "" || from === "" || to === "") {
    return usageFail("missing a required option (--url, --workspace, --from and --to are all needed)");
  }
  if (!PEER_ID_RE.test(from) || !PEER_ID_RE.test(to)) {
    return usageFail("--from and --to must match ^[A-Za-z0-9_-]{1,512}$");
  }
  if (!PEER_ID_RE.test(workspace)) {
    return usageFail("--workspace must match ^[A-Za-z0-9_-]{1,512}$");
  }
  if (from === to) {
    return usageFail("--from and --to are the same peer");
  }
  let host = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return usageFail("--url must use the http or https scheme");
    }
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return usageFail("--url is not a valid URL");
  }
  if (isCloudHost(host)) {
    return {
      ok: false,
      fact: `--url points at the Honcho cloud host (${host})`,
      reason: "this tool only talks to the self-hosted server, same rule as the plugin",
      fix: "pass the self-hosted v3 base, e.g. --url http://<server>:8002/v3",
    };
  }
  return {
    ok: true,
    args: { url, workspace, apiKey: env.HONCHO_API_KEY ?? "local", from, to, apply },
  };
}

/** Minimal raw call for the two routes the plugin client does not expose
 * (messages/list and PUT card - keeping honcho.ts and its contract test
 * untouched): same auth, and the key is scrubbed from any error text. */
async function apiFetch(
  base: string,
  workspace: string,
  apiKey: string,
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const scrub = (msg: string): string =>
    apiKey !== "" ? msg.split(apiKey).join("[redacted]") : msg;
  try {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 200);
      } catch {
        // body unreadable; the status is the fact that matters
      }
      return {
        ok: false,
        status: resp.status,
        error: scrub(`${method} ${path}: HTTP ${resp.status}${detail ? ` ${detail}` : ""}`),
      };
    }
    const text = await resp.text();
    return { ok: true, data: text === "" ? null : JSON.parse(text) };
  } catch (err) {
    return { ok: false, status: 0, error: scrub(`${method} ${path}: ${String(err)}`) };
  }
}

/** Read a POST list route to its LAST page (architect ruling 03:42Z: no
 * item ceiling). size 100 per request is the server's page size, not a
 * bound: the page/pages fields of the answer drive the walk. The count of
 * pages actually fetched is added to the caller's counter. */
async function pagedList(
  base: string,
  workspace: string,
  apiKey: string,
  path: string,
  filters: Record<string, unknown>,
  pagesRead: { n: number },
): Promise<{ ok: true; items: Record<string, unknown>[] } | { ok: false; status: number; error: string }> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const r = await apiFetch(
      base,
      workspace,
      apiKey,
      `${path}?size=${PAGE_CAP}&page=${page}`,
      "POST",
      { filters },
    );
    if (!r.ok) return r;
    const d = r.data as { items?: Record<string, unknown>[]; pages?: number };
    all.push(...(Array.isArray(d.items) ? d.items : []));
    pagesRead.n += 1;
    const pages = typeof d.pages === "number" && d.pages >= 1 ? d.pages : 1;
    if (page >= pages) return { ok: true, items: all };
    page += 1;
  }
}

interface SrvMessage {
  content: string;
  peer_id: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

/** One decision reconstructed from its message (or its chunk group). */
interface Decision {
  mission: string;
  content: string;
  originalAt: string;
  matchedConclusion: boolean;
}

function missionOf(msg: SrvMessage, sessionId: string, fromPeer: string): string {
  const m = msg.metadata?.mission;
  if (typeof m === "string" && m !== "") return m;
  const m2 = /^(.*)--\d+$/.exec(sessionId);
  const prefix = m2?.[1] ?? sessionId;
  return prefix.startsWith(`${fromPeer}--`) ? prefix.slice(fromPeer.length + 2) : prefix;
}

export async function runCopy(
  args: CopyArgs,
  log: (line: string) => void,
  now: () => string = () => new Date().toISOString(),
): Promise<CopyResult> {
  const base = args.url.replace(/\/+$/, "");
  const w = encodeURIComponent(args.workspace);
  const client = createClient({
    url: args.url,
    workspace: args.workspace,
    apiKey: args.apiKey,
    timeoutMs: 30_000,
  });

  const pagesRead = { n: 0 };

  // 1. the from-peer's sessions, ALL pages (stamped ones; every
  // plugin-created session stamps rig_peer, so this is every session the
  // seat could have recorded in)
  const sr = await pagedList(
    base,
    args.workspace,
    args.apiKey,
    `/workspaces/${w}/sessions/list`,
    { metadata: { rig_peer: args.from } },
    pagesRead,
  );
  if (!sr.ok) {
    return fail(
      `listing sessions of ${args.from} failed: HTTP ${sr.status}`,
      sr.error,
      "check --url / --workspace / HONCHO_API_KEY and that the workspace exists",
    );
  }
  const fromSessions = sr.items
    .map((s) => (typeof s.id === "string" ? s.id : ""))
    .filter((id) => id !== "");

  // 2. decision messages per session, ALL pages (peer_id = from,
  // metadata.kind = decision - hundreds of messages per session on pilot)
  const byMission = new Map<string, Decision[]>();
  let found = 0;
  for (const sid of fromSessions) {
    const ml = await pagedList(
      base,
      args.workspace,
      args.apiKey,
      `/workspaces/${w}/sessions/${encodeURIComponent(sid)}/messages/list`,
      { peer_id: args.from, metadata: { kind: "decision" } },
      pagesRead,
    );
    if (!ml.ok) {
      return fail(
        `listing messages of session ${sid} failed`,
        ml.error,
        "check --url / --workspace / HONCHO_API_KEY; the session must exist",
      );
    }
    // belt: re-apply the filter client-side too - the server filter is the
    // selector, a misbehaving page must not smuggle other kinds in
    const items = (ml.items as unknown as SrvMessage[]).filter(
      (m) =>
        typeof m.content === "string" &&
        m.peer_id === args.from &&
        m.metadata?.kind === "decision",
    );

    // group chunked messages back into whole decisions
    const singles: SrvMessage[] = [];
    const chunks = new Map<string, SrvMessage[]>();
    for (const m of items) {
      const ch = m.metadata?.chunk as { id?: string; i?: number } | undefined;
      if (ch !== undefined && typeof ch.id === "string") {
        const list = chunks.get(ch.id) ?? [];
        list.push(m);
        chunks.set(ch.id, list);
      } else {
        singles.push(m);
      }
    }
    const groups: SrvMessage[][] = [
      ...singles.map((m) => [m]),
      ...[...chunks.values()].map((g) =>
        [...g].sort((a, b) => Number(a.metadata?.chunk?.i ?? 0) - Number(b.metadata?.chunk?.i ?? 0)),
      ),
    ];
    if (items.length > 0) {
      // self-conclusions of this session, ALL pages, exact-content match
      const cr = await pagedList(
        base,
        args.workspace,
        args.apiKey,
        `/workspaces/${w}/conclusions/list`,
        { observer_id: args.from, observed_id: args.from, session_id: sid },
        pagesRead,
      );
      const concl = new Set(
        cr.ok ? cr.items.map((c) => (typeof c.content === "string" ? c.content : "")) : [],
      );
      if (!cr.ok) {
        // matching is informational (the message is the authority); a failed
        // conclusions page must not stop the copy - log and proceed unmatched
        log(`note: conclusion matching unavailable for ${sid} (${cr.error})`);
      }
      for (const g of groups) {
        const first = g[0];
        if (first === undefined) continue;
        const d: Decision = {
          mission: missionOf(first, sid, args.from),
          content: g.map((m) => m.content).join(""),
          originalAt: typeof first.created_at === "string" ? first.created_at : "",
          matchedConclusion: false,
        };
        d.matchedConclusion = concl.has(d.content);
        const list = byMission.get(d.mission) ?? [];
        list.push(d);
        byMission.set(d.mission, list);
        found += 1;
      }
    }
  }

  // 3. idempotency set: contents already carried for the to-peer by this
  // script (its decision messages carry metadata.copied_from) - ALL pages
  const already = new Set<string>();
  const toSr = await pagedList(
    base,
    args.workspace,
    args.apiKey,
    `/workspaces/${w}/sessions/list`,
    { metadata: { rig_peer: args.to } },
    pagesRead,
  );
  if (!toSr.ok) {
    return fail(
      `listing sessions of ${args.to} failed: HTTP ${toSr.status}`,
      toSr.error,
      "check --url / --workspace / HONCHO_API_KEY and that the workspace exists",
    );
  }
  for (const s of toSr.items) {
    if (typeof s.id !== "string") continue;
    const ml = await pagedList(
      base,
      args.workspace,
      args.apiKey,
      `/workspaces/${w}/sessions/${encodeURIComponent(s.id)}/messages/list`,
      { peer_id: args.to, metadata: { kind: "decision", copied_from: args.from } },
      pagesRead,
    );
    if (!ml.ok) {
      return fail(
        `listing messages of session ${s.id} failed`,
        ml.error,
        "check --url / --workspace / HONCHO_API_KEY",
      );
    }
    for (const m of ml.items as unknown as SrvMessage[]) {
      if (typeof m.content === "string") already.add(m.content);
    }
  }

  // 4. copy, mission by mission (sorted for deterministic output)
  const counts: CopyCounts = {
    missions: 0,
    found,
    created: 0,
    skipped: 0,
    cardItems: 0,
    cardCopied: false,
    pages: 0,
  };
  log(args.apply ? "APPLY" : "DRY RUN");
  const missions = [...byMission.keys()].sort();
  counts.missions = missions.length;
  for (const mission of missions) {
    const decisions = byMission.get(mission) ?? [];
    // belt: content was already redacted on the way in, redaction is
    // idempotent; the skip decision runs on the redacted text
    const toCreate: Array<{ d: Decision; content: string }> = [];
    let missionSkipped = 0;
    for (const d of decisions) {
      const content = redact(d.content).text;
      if (already.has(content)) missionSkipped += 1;
      else toCreate.push({ d, content });
    }
    // the session is minted and created ONLY when something goes into it -
    // an all-skipped mission must create nothing at all (idempotency)
    let session = "";
    let missionCreated = 0;
    if (toCreate.length > 0) {
      const minted = await freeN(client, args.to, mission);
      const n =
        minted ??
        ((): number => {
          const sec = Math.floor(Date.parse(now()) / 1000);
          return Number.isFinite(sec) && sec >= 1 ? sec : Math.floor(Date.now() / 1000);
        })();
      session = `${args.to}--${mission}--${n}`;
      if (args.apply) {
        const cs = await client.createSession(session, {
          peers: { [args.to]: { observe_me: true, observe_others: false } },
          scopes: [scopeFor(mission)],
          metadata: { rig_peer: args.to, mission },
        });
        if (!cs.ok) {
          return fail(
            `creating session ${session} failed: HTTP ${cs.status ?? "?"}`,
            cs.error ?? "the server refused the session create",
            "check --url / --workspace / HONCHO_API_KEY; rerun is safe (idempotent)",
          );
        }
      }
      for (const { d, content } of toCreate) {
        if (args.apply) {
          const cc = await client.createConclusion({
            content,
            observer_id: args.to,
            observed_id: args.to,
            session_id: session,
          });
          if (!cc.ok) {
            return fail(
              `creating a conclusion in ${session} failed: HTTP ${cc.status ?? "?"}`,
              cc.error ?? "the server refused the conclusion create",
              "rerun is safe: completed decisions are skipped, not doubled",
            );
          }
          const ts = d.originalAt !== "" ? d.originalAt : now();
          const am = await client.addMessages(session, [
            {
              peer_id: args.to,
              content,
              created_at: ts,
              metadata: {
                client_id: clientId(args.to, session, ts, content),
                kind: "decision",
                mission,
                copied_from: args.from,
                original_at: d.originalAt,
              },
            },
          ]);
          if (!am.ok) {
            return fail(
              `creating a decision message in ${session} failed: HTTP ${am.status ?? "?"}`,
              am.error ?? "the server refused the message create",
              "rerun is safe: completed decisions are skipped, not doubled",
            );
          }
          already.add(content);
        }
        missionCreated += 1;
      }
    }
    counts.created += missionCreated;
    counts.skipped += missionSkipped;
    const matched = decisions.filter((x) => x.matchedConclusion).length;
    log(
      `mission ${mission}: ${decisions.length} decisions (${matched} matched), ` +
        `${args.apply ? "created" : "would create"} ${missionCreated}, skipped ${missionSkipped}` +
        (session !== "" ? `, session ${session}` : ""),
    );
  }

  // 5. the peer card: GET from, whole-word rename, PUT to
  const card = await client.getPeerCard(args.from);
  if (!card.ok && card.status !== 404) {
    return fail(
      `reading the card of ${args.from} failed: HTTP ${card.status ?? "?"}`,
      card.error ?? "the server refused the card GET",
      "check --url / --workspace / HONCHO_API_KEY",
    );
  }
  if (card.ok) {
    const items = Array.isArray((card.data as { peer_card?: unknown }).peer_card)
      ? ((card.data as { peer_card: unknown[] }).peer_card.filter(
          (x): x is string => typeof x === "string",
        ))
      : [];
    counts.cardItems = items.length;
    if (items.length > 0) {
      const esc = args.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`, "g");
      const renamed = items.map((it) => it.replace(re, args.to));
      if (args.apply) {
        const put = await apiFetch(
          base,
          args.workspace,
          args.apiKey,
          `/workspaces/${w}/peers/${encodeURIComponent(args.to)}/card`,
          "PUT",
          { peer_card: renamed },
        );
        if (!put.ok) {
          return fail(
            `writing the card of ${args.to} failed`,
            "error" in put ? put.error : "the server refused the card PUT",
            "rerun is safe: the card PUT overwrites, it never doubles",
          );
        }
      }
      counts.cardCopied = args.apply;
    }
  }

  counts.pages = pagesRead.n;
  log(
    `total: missions ${counts.missions}, decisions found ${counts.found}, ` +
      `${args.apply ? "created" : "would create"} ${counts.created}, ` +
      `skipped ${counts.skipped}, card items ${counts.cardItems}, pages read ${counts.pages}`,
  );
  return { ok: true, dry: !args.apply, counts };
}

/* istanbul ignore next - CLI entry */
if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`fact: ${parsed.fact}`);
    console.error(`reason: ${parsed.reason}`);
    console.error(`fix: ${parsed.fix}`);
    process.exit(1);
  }
  const res = await runCopy(parsed.args, (line) => console.log(line));
  if (!res.ok) {
    console.error(`fact: ${res.fact}`);
    console.error(`reason: ${res.reason}`);
    console.error(`fix: ${res.fix}`);
    process.exit(1);
  }
}
