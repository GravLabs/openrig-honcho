// T24 (ADR-0014 Amendment 2): the one-off migration of pre-ledger decisions
// onto the reserved ledger pair. Amendment 2 stopped plain leader conclusions
// from counting as decisions in force; a PILOT workspace that wants its old
// decisions back in force runs this script. DRY RUN by default (counts only -
// no content ever prints); --write records ledger entries.
//
// HARD LIMIT: tests run this ONLY against honcho-bridge-scratch* workspaces,
// and the CLI refuses any other workspace name unless the human running it
// passes --allow-real-workspace (the pilot write needs the owner's OK).
//
// Usage:
//   bun scripts/migrate-ledger.ts --workspace <w> --leader <peer> [--url U]
//       [--key K] [--write] [--allow-real-workspace]

import { createClient, type HonchoClient } from "../plugin/src/honcho.ts";
import { formatEntry, LEDGER_PEER, newDecisionId, parseEntry } from "../plugin/src/ledger.ts";
import { fetchLedgerPair } from "../plugin/src/reader.ts";

export interface MigrateCounts {
  leader_sessions: number;
  decision_messages: number;
  header_entries: number; // content already carries a valid ledger header
  plain_messages: number; // wrapped into [decision d-... · scope mission]
  already_migrated: number; // pair already carries this content
  written: number;
  failed: number;
}

const PAGE = 100;
const MAX_PAGES = 100; // migration reads are offline one-offs: no 5-page cap

/** The leader's own sessions (metadata.rig_peer stamp), paged newest first. */
async function leaderSessions(client: HonchoClient, leader: string): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await client.listSessions({
      filters: { metadata: { rig_peer: leader } },
      reverse: true,
      size: PAGE,
      page,
    });
    if (!r.ok) throw new Error(`listSessions: ${r.kind}`);
    for (const s of r.data.items) {
      if (typeof s.id === "string") out.push(s.id);
    }
    if (r.data.items.length < PAGE) return out;
  }
  return out;
}

/**
 * Migrate the leader's decision messages to the ledger pair. Pure IO over
 * the injected client; returns counts, never content. Throws only on a
 * failed READ (a failed WRITE is counted, never thrown - the run keeps
 * going and the report is honest).
 */
export async function migrateLedger(
  client: HonchoClient,
  leader: string,
  write: boolean,
): Promise<MigrateCounts> {
  const c: MigrateCounts = {
    leader_sessions: 0,
    decision_messages: 0,
    header_entries: 0,
    plain_messages: 0,
    already_migrated: 0,
    written: 0,
    failed: 0,
  };
  const sessions = await leaderSessions(client, leader);
  c.leader_sessions = sessions.length;
  const pair = await fetchLedgerPair(client, leader);
  const seen = new Set(pair.items.map((x) => x.content));
  if (write) {
    const cp = await client.createPeer(LEDGER_PEER); // get-or-create
    if (!cp.ok) throw new Error(`createPeer: ${cp.kind}`);
  }
  for (const sid of sessions) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await client.listMessages(sid, {
        filters: { metadata: { kind: "decision" } },
        size: PAGE,
        page,
      });
      if (!r.ok) throw new Error(`listMessages ${sid}: ${r.kind}`);
      for (const m of r.data.items) {
        if (typeof m.content !== "string" || m.content.trim() === "") continue;
        c.decision_messages += 1;
        const p = parseEntry(m.content);
        let out = m.content;
        if (p.kind === "plain") {
          c.plain_messages += 1;
          out = formatEntry({
            kind: "decision",
            id: newDecisionId(m.peer_id, typeof m.created_at === "string" ? m.created_at : "", m.content),
            scope: "mission",
            fact: m.content,
          });
        } else {
          c.header_entries += 1;
        }
        if (seen.has(out)) {
          c.already_migrated += 1;
          continue;
        }
        if (!write) continue;
        const cr = await client.createConclusion({
          content: out,
          observer_id: leader,
          observed_id: LEDGER_PEER,
          session_id: m.session_id,
        });
        if (cr.ok) {
          c.written += 1;
          seen.add(out);
        } else {
          c.failed += 1;
        }
      }
      if (r.data.items.length < PAGE) break;
    }
  }
  return c;
}

const SCATCH_RE = /^honcho-bridge-scratch/;

/* c8 ignore start */ if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bool = (name: string): boolean => argv.includes(`--${name}`);
  const workspace = flag("workspace") ?? "";
  const leader = flag("leader") ?? "";
  const url = flag("url") ?? process.env.HONCHO_URL ?? "";
  const key = flag("key") ?? process.env.HONCHO_API_KEY ?? "local";
  if (workspace === "" || leader === "" || url === "") {
    console.error("fact: --workspace, --leader and --url (or HONCHO_URL) are required.");
    console.error('reason: the script never guesses a workspace - a wrong one writes ledger entries into someone else\'s memory.');
    console.error("fix: bun scripts/migrate-ledger.ts --workspace <w> --leader <p> --url <u> [--write]");
    process.exit(2);
  }
  if (!SCATCH_RE.test(workspace) && !bool("allow-real-workspace")) {
    console.error(`fact: workspace "${workspace}" is not a honcho-bridge-scratch* workspace.`);
    console.error("reason: writing ledger entries into a real workspace is a pilot action and needs the owner's OK (the ADR-0014 Amendment 2 migration is a pilot write).");
    console.error("fix: run it against a scratch workspace, or pass --allow-real-workspace after the owner approves.");
    process.exit(2);
  }
  const client = createClient({ url, workspace, apiKey: key, timeoutMs: 30_000 });
  try {
    const counts = await migrateLedger(client, leader, bool("write"));
    console.log(JSON.stringify(counts));
    if (counts.failed > 0) process.exit(1);
  } catch (e) {
    console.error(`migration failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
} /* c8 ignore stop */
