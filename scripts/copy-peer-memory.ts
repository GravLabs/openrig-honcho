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
// What counts as a recorded decision (T27, architect 2026-11-06 04:33Z -
// the gate caught the regression): SINCE T24 (ADR-0014 Amendment 2) a
// decision is a valid-header ENTRY ON THE RESERVED PAIR - observer the
// leader, observed openrig-ledger. The old self pair (observer = observed
// = from) holds recall material and deriver look-alikes only; looking
// there found nothing a renamed leader would ever read back, which is
// exactly the bug (a renamed leader started with an empty ledger).
//
// Copy shape per entry: the SAME conclusion content, VERBATIM, on the new
// leader's pair (observer = to, observed = openrig-ledger), written into a
// session <to>--<mission>--<n> for the mission the entry was WRITTEN in
// (n by the plugin's freeN, so the new seat's own later sessions do not
// collide; every created session is stamped {rig_peer, mission} like the
// plugin's). Verbatim is the whole point: the entry id, the supersedes
// link and the retire link live INSIDE the content, so the copied ledger
// computes the SAME in-force set (currentLedger works off those links, and
// inForceFor off the session's mission). Only header entries are carried -
// a plain conclusion is never a decision. An entry whose session carries
// no mission is counted, reported, and left in place: the script never
// invents a mission. redact() runs on the way out as a belt (content was
// redacted on the way in, and redaction is idempotent). Decision messages
// carry no authority after T24, so nothing is written to messages.
//
// The peer card is copied whole: GET from, PUT to, with every WHOLE-WORD
// occurrence of <from> inside an item replaced by <to> (whole word = not
// adjacent to [A-Za-z0-9_-], since peer ids themselves contain hyphens).
// Decisions are copied verbatim.
//
// Idempotent: an entry whose content already exists on the to-peer's pair
// (a previous run copied it verbatim) is skipped; a second --apply creates
// nothing new.
//
// Output: counts only, never contents (missions, decisions found, created,
// skipped, card items). Exit 0 on success; non-zero with a fact/reason/fix
// triple on any refusal or server failure. Refusals: honcho.dev cloud URLs
// (same rule as the plugin's env.loadConfig), from === to, malformed or
// missing arguments.
//
// Paging (architect ruling 2026-11-02 03:42Z, shapes updated by T27): NO
// item ceiling. Both ledger-pair reads (from-peer, and to-peer for
// idempotency) are read to the end by following the page/pages fields of
// each page answer at size 100. The summary reports the number of pages
// read.

import { createClient } from "../plugin/src/honcho.ts";
import { redact } from "../plugin/src/redact.ts";
import { LEDGER_PEER, parseEntry } from "../plugin/src/ledger.ts";
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

  // 1. (T27) the from-peer's LEDGER PAIR, ALL pages: observer = from,
  // observed = openrig-ledger. Since T24 this is where a leader's entries
  // live; the old self-pair + decision-message lookup found nothing the
  // renamed leader would read back - the gate regression this fixes.
  const fromPair = await pagedList(
    base,
    args.workspace,
    args.apiKey,
    `/workspaces/${w}/conclusions/list`,
    { observer_id: args.from, observed_id: LEDGER_PEER },
    pagesRead,
  );
  if (!fromPair.ok) {
    return fail(
      `listing the ledger pair of ${args.from} failed: HTTP ${fromPair.status}`,
      fromPair.error,
      "check --url / --workspace / HONCHO_API_KEY and that the workspace exists",
    );
  }

  // 2. idempotency set: contents already on the to-peer's pair (verbatim
  // copies are identical content) - ALL pages. A second --apply doubles
  // nothing.
  const toPair = await pagedList(
    base,
    args.workspace,
    args.apiKey,
    `/workspaces/${w}/conclusions/list`,
    { observer_id: args.to, observed_id: LEDGER_PEER },
    pagesRead,
  );
  if (!toPair.ok) {
    return fail(
      `listing the ledger pair of ${args.to} failed: HTTP ${toPair.status}`,
      toPair.error,
      "check --url / --workspace / HONCHO_API_KEY and that the workspace exists",
    );
  }
  const already = new Set<string>();
  for (const c of toPair.items) if (typeof c.content === "string") already.add(c.content);

  // 3. classify: ENTRIES ONLY (a plain conclusion is never a decision -
  // parseEntry is the same rule the plugin uses), grouped by the mission
  // the entry was WRITTEN in: its session <from>--<mission>--<n>, parsed
  // like ledger.ts parses it. An entry on an untagged or foreign session
  // has no mission to carry: counted, reported, left in place.
  const fromSessRe = new RegExp(`^${args.from}--(.*)--\\d+$`);
  const byMission = new Map<string, string[]>();
  let found = 0;
  let unattributed = 0;
  for (const c of fromPair.items) {
    if (typeof c.content !== "string") continue;
    if (parseEntry(c.content).kind === "plain") continue;
    found += 1;
    const sid = typeof c.session_id === "string" ? c.session_id : "";
    const ms = fromSessRe.exec(sid);
    const mission = ms?.[1];
    if (mission === undefined || mission === "") {
      unattributed += 1;
      continue;
    }
    const list = byMission.get(mission) ?? [];
    list.push(c.content);
    byMission.set(mission, list);
  }
  if (unattributed > 0) {
    log(`note: ${unattributed} entries sit on sessions without a ${args.from}--<mission>--<n> name and stay in place`);
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
  let ledgerPeerReady = false;
  for (const mission of missions) {
    const entries = byMission.get(mission) ?? [];
    // belt: content was already redacted on the way in; redact() is
    // idempotent; the skip decision runs on the redacted text
    const toCreate: string[] = [];
    let missionSkipped = 0;
    for (const content of entries) {
      const red = redact(content).text;
      if (already.has(red)) missionSkipped += 1;
      else toCreate.push(red);
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
        // the reserved pair peer must exist before a write to it lands
        // (live 3.5.0: an uncreated observed peer is rejected) - get or
        // create it ONCE per run
        if (!ledgerPeerReady) {
          const cp = await client.createPeer(LEDGER_PEER);
          if (!cp.ok) {
            return fail(
              `creating the reserved ledger peer ${LEDGER_PEER} failed: HTTP ${cp.status ?? "?"}`,
              cp.error ?? "the server refused the peer create",
              "check --url / --workspace / HONCHO_API_KEY; rerun is safe (get-or-create)",
            );
          }
          ledgerPeerReady = true;
        }
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
      for (const content of toCreate) {
        if (args.apply) {
          const cc = await client.createConclusion({
            content,
            observer_id: args.to,
            observed_id: LEDGER_PEER,
            session_id: session,
          });
          if (!cc.ok) {
            return fail(
              `creating a pair entry in ${session} failed: HTTP ${cc.status ?? "?"}`,
              cc.error ?? "the server refused the conclusion create",
              "rerun is safe: completed entries are skipped, not doubled",
            );
          }
          already.add(content);
        }
        missionCreated += 1;
      }
    }
    counts.created += missionCreated;
    counts.skipped += missionSkipped;
    log(
      `mission ${mission}: ${entries.length} entries, ` +
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
    `total: missions ${counts.missions}, entries found ${counts.found}, ` +
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
