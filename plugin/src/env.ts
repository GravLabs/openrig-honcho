// The env contract (ADR-0001). Pure: reads only the record it is given,
// never process.env, files, stdin or network.

import { LEDGER_PEER } from "./ledger.ts";

export interface Config {
  enabled: true;
  /** Base URL including /v3, e.g. http://localhost:8000/v3 */
  url: string;
  workspace: string;
  peer: string;
  observeOthers: boolean;
  ownerPeer: string;
  /**
   * ADR-0005 E4: the seat whose copy reasons on broadcasts. Unset stays
   * undefined, except HONCHO_OBSERVE_OTHERS=true without it means this peer
   * (the leader knows it is the leader).
   */
  leaderPeer?: string;
  /** null when unset: no profile writes or reads. */
  profileWorkspace: string | null;
  recordAutomation: boolean;
  /** Never log this value. */
  apiKey: string;
  stateDir: string;
  timeoutMs: number;
  /**
   * T16b (ADR-0011 decision 1): the recall distance gate -
   * HONCHO_RECALL_MAX_DISTANCE, default 0.45. loadConfig always sets it;
   * the field is optional only so the hand-built test Config fixtures keep
   * compiling and behaving (use sites fall back to 0.45).
   */
  recallMaxDistance?: number;
  /**
   * T18b (ADR-0013 decision 2): the share of eligible recall blocks that
   * is computed, logged (arm "held") and marked seen but NOT injected -
   * HONCHO_RECALL_HOLDOUT, a number 0 to 0.9, default 0. loadConfig always
   * sets it; the field is optional only so the hand-built test Config
   * fixtures keep compiling and behaving (use sites do `?? 0`).
   */
  recallHoldout?: number;
  /**
   * T16b (ADR-0011 decision 3, item 6): THIS seat's RIG name - the part
   * after the last @ of OPENRIG_SESSION_NAME when it carries a valid id,
   * else the workspace (the pre-T16b behaviour; correct on pilot where
   * rig and workspace share the name). loadConfig derives it once here -
   * the single place - so the writer and recall always attribute with the
   * same rig. Optional for the same fixture reason; use sites do
   * `rig ?? workspace`.
   */
  rig?: string;
  /**
   * T16f (ADR-0012 decision 2): the OpenRig daemon API base from
   * OPENRIG_URL. loadConfig sets it only when it parses as http(s); absent
   * means NO lookups at all (outbox verification and the queue-nudge fetch
   * silently stay off - the writer outcome carries no verify field).
   */
  daemonUrl?: string;
  /**
   * T16f (ADR-0012 decision 2): the raw OPENRIG_SESSION_NAME - the expected
   * outbox destinationSession. Without it verification cannot prove the
   * destination, so it reports unchecked.
   */
  sessionName?: string;
  /**
   * V5 (ADR-0019 decision 5): the topology root the seat's OWN lore folder
   * is read from - HONCHO_TOPOLOGY_ROOT, else $OPENRIG_HOME/topology, else
   * $HOME/.openrig/topology. Unset only when none of the three can resolve
   * (no HOME): lessons then read nothing, silently.
   */
  topologyRoot?: string;
  /**
   * T19b (ADR-0014 decision 1): the session-start block is the continuity
   * digest; HONCHO_DIGEST=off gives the old block. loadConfig always sets
   * it true unless switched off; the field is optional only so the
   * hand-built test Config fixtures keep compiling AND keep the old block
   * (undefined = old, byte for byte - the with/without comparison).
   */
  digest?: boolean;
  /**
   * T19c (ADR-0014 decision 4): the recall novelty filter and its minimum
   * block are on; HONCHO_RECALL_NOVELTY=off gives today's behavior byte for
   * byte (no known filter, no dropped_small, no new log keys). Same trick
   * as digest: loadConfig always sets it true unless switched off; the
   * field is optional so the hand-built test Config fixtures keep today's
   * recall behavior (undefined = off).
   */
  novel?: boolean;
  /**
   * T21 (ADR-0005 E5b): routine status messages (isRoutine) are stored but
   * skip the deriver, exactly as E5 acks do. On by default;
   * HONCHO_SKIP_ROUTINE=off restores today's behaviour byte for byte.
   */
  skipRoutine?: boolean;
}

export interface Disabled {
  enabled: false;
  /** Names the offending variable; never contains an API key value. */
  reason: string;
}

/**
 * The single reason string the kill switch produces. "Off means off": this
 * reason must never be logged anywhere (ADR-0001, review T1 F2).
 */
export const KILL_SWITCH_REASON = "HONCHO_ENABLED is off (kill switch)";

export function isKillSwitch(reason: string): boolean {
  return reason === KILL_SWITCH_REASON;
}

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const FALSY = new Set(["false", "0", "no", "off"]);
const TRUTHY = new Set(["true", "1", "yes", "on"]);

function disabled(reason: string): Disabled {
  return { enabled: false, reason };
}

function readBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt;
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return dflt;
}

/** An optional id: unset/empty gives `dflt`; a set value must match the id regex. */
function checkId(
  name: string,
  raw: string | undefined,
  dflt: string | null,
): { value: string | null } | Disabled {
  const v = (raw ?? "").trim();
  if (v === "") return { value: dflt };
  if (!ID_RE.test(v)) return disabled(`${name} is not a valid id (^[A-Za-z0-9_-]{1,100}$)`);
  return { value: v };
}

function isCloudHost(host: string): boolean {
  return host === "honcho.dev" || host === "api.honcho.dev" || host.endsWith(".honcho.dev");
}

export function loadConfig(
  env: Record<string, string | undefined>,
): Config | Disabled {
  // Kill switch first: it must disable cleanly even with nothing else set.
  if (!readBool(env.HONCHO_ENABLED, true)) {
    return disabled(KILL_SWITCH_REASON);
  }

  const url = (env.HONCHO_URL ?? "").trim();
  if (url === "") return disabled("HONCHO_URL is required");
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return disabled("HONCHO_URL must use the http or https scheme");
    }
    // Strip the DNS root label: "api.honcho.dev." === "api.honcho.dev".
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return disabled("HONCHO_URL is not a valid URL");
  }
  if (isCloudHost(host)) {
    return disabled(
      `HONCHO_URL points at the Honcho cloud host (${host}); this plugin only talks to a self-hosted server`,
    );
  }

  const workspace = (env.HONCHO_WORKSPACE ?? "").trim();
  if (workspace === "") return disabled("HONCHO_WORKSPACE is required");
  if (!ID_RE.test(workspace)) {
    return disabled("HONCHO_WORKSPACE is not a valid id (^[A-Za-z0-9_-]{1,100}$)");
  }

  // ADR-0008 Decision 2: seats may share one working directory, so an
  // in-place install cannot set HONCHO_PEER per seat - the OpenRig session
  // name already carries it. An explicit HONCHO_PEER always wins.
  const peerRaw = (env.HONCHO_PEER ?? "").trim();
  const sessionName = (env.OPENRIG_SESSION_NAME ?? "").trim();
  let peer = peerRaw;
  if (peerRaw === "") {
    if (sessionName !== "") {
      const fromSession = (sessionName.split("@")[0] ?? "").trim();
      if (!ID_RE.test(fromSession)) {
        // names the variable, never its value (the name is not a secret,
        // but the rule is: reasons carry variable names only)
        return disabled(
          "HONCHO_PEER is unset and OPENRIG_SESSION_NAME does not carry a valid id (^[A-Za-z0-9_-]{1,100}$)",
        );
      }
      peer = fromSession;
    } else {
      return disabled("HONCHO_PEER is required (or set OPENRIG_SESSION_NAME)");
    }
  }
  if (!ID_RE.test(peer)) {
    return disabled("HONCHO_PEER is not a valid id (^[A-Za-z0-9_-]{1,100}$)");
  }
  // T24 (ADR-0014 Amendment 2): the ledger peer is reserved. A seat may not
  // BE it (it never sends; a seat named that would collide with every
  // leader's ledger pair), and neither may the owner or leader id - the
  // attribute.ts sender guard lets the owner name through unchanged, so the
  // config is where that door closes.
  if (peer === LEDGER_PEER) {
    return disabled("HONCHO_PEER is reserved: openrig-ledger is the decision-ledger peer, not a seat id");
  }

  const ownerPeer = checkId("HONCHO_OWNER_PEER", env.HONCHO_OWNER_PEER, "owner");
  if ("reason" in ownerPeer) return ownerPeer;
  if (ownerPeer.value === LEDGER_PEER) {
    return disabled("HONCHO_OWNER_PEER is reserved: openrig-ledger is the decision-ledger peer");
  }

  const profileWorkspace = checkId(
    "HONCHO_PROFILE_WORKSPACE",
    env.HONCHO_PROFILE_WORKSPACE,
    null,
  );
  if ("reason" in profileWorkspace) return profileWorkspace;

  const leaderPeer = checkId("HONCHO_LEADER_PEER", env.HONCHO_LEADER_PEER, null);
  if ("reason" in leaderPeer) return leaderPeer;
  if (leaderPeer.value === LEDGER_PEER) {
    return disabled("HONCHO_LEADER_PEER is reserved: openrig-ledger is the decision-ledger peer");
  }

  let apiKey = "local";
  if (env.HONCHO_API_KEY !== undefined) {
    if (env.HONCHO_API_KEY === "") {
      return disabled("HONCHO_API_KEY is set but empty");
    }
    apiKey = env.HONCHO_API_KEY;
  }

  let stateDir = (env.HONCHO_STATE_DIR ?? "").trim();
  if (stateDir === "") {
    const home = (env.HOME ?? "").trim();
    if (home === "") return disabled("HONCHO_STATE_DIR is unset and HOME is unavailable");
    stateDir = `${home}/.openrig-honcho`;
  }

  let timeoutMs = 3000;
  if (env.HONCHO_TIMEOUT_MS !== undefined && env.HONCHO_TIMEOUT_MS.trim() !== "") {
    const raw = env.HONCHO_TIMEOUT_MS.trim();
    // ADR-0001: an integer 1..60000; anything else disables the plugin, and
    // out-of-range values are never silently narrowed (T2c). The client
    // validates the same range for direct callers.
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 60_000) {
      return disabled("HONCHO_TIMEOUT_MS must be an integer between 1 and 60000");
    }
    timeoutMs = Number(raw);
  }

  // T16b (ADR-0011 decision 1): the recall distance gate. A plain decimal
  // 0.05..1; anything else disables the plugin with the reason (T2c rule:
  // never silently narrow).
  let recallMaxDistance = 0.45;
  if (env.HONCHO_RECALL_MAX_DISTANCE !== undefined && env.HONCHO_RECALL_MAX_DISTANCE.trim() !== "") {
    const raw = env.HONCHO_RECALL_MAX_DISTANCE.trim();
    if (!/^\d+(?:\.\d+)?$/.test(raw) || Number(raw) < 0.05 || Number(raw) > 1) {
      return disabled("HONCHO_RECALL_MAX_DISTANCE must be a number between 0.05 and 1");
    }
    recallMaxDistance = Number(raw);
  }

  // T18b (ADR-0013 decision 2): the recall holdout share. A plain decimal
  // 0..0.9; anything else disables the plugin with the reason (same rule
  // as the distance gate - never silently narrow).
  let recallHoldout = 0;
  if (env.HONCHO_RECALL_HOLDOUT !== undefined && env.HONCHO_RECALL_HOLDOUT.trim() !== "") {
    const raw = env.HONCHO_RECALL_HOLDOUT.trim();
    if (!/^\d+(?:\.\d+)?$/.test(raw) || Number(raw) < 0 || Number(raw) > 0.9) {
      return disabled("HONCHO_RECALL_HOLDOUT must be a number between 0 and 0.9");
    }
    recallHoldout = Number(raw);
  }

  // T16b (ADR-0011 decision 3): this seat's rig from its session name, so
  // same-rig attribution does not depend on the workspace carrying the rig
  // name. Last @ (peerIdFromSession's rule); the part must be a valid id,
  // else fall back to the workspace exactly as before.
  let rig: string | undefined;
  if (sessionName.includes("@")) {
    const part = sessionName.slice(sessionName.lastIndexOf("@") + 1).trim();
    if (ID_RE.test(part)) rig = part;
  }

  // V5 (ADR-0019 decision 5): the topology root for the seat's own lore.
  // An explicit HONCHO_TOPOLOGY_ROOT wins; else $OPENRIG_HOME/topology; else
  // $HOME/.openrig/topology. No new failure mode: a value that cannot
  // resolve leaves the field absent (lessons read nothing, silently) - it
  // must never disable the plugin (the OPENRIG_URL rule, T16f).
  const homeRoot = (env.OPENRIG_HOME ?? "").trim().replace(/\/+$/, "");
  const userHome = (env.HOME ?? "").trim().replace(/\/+$/, "");
  let topologyRoot: string | undefined;
  const rawTopo = (env.HONCHO_TOPOLOGY_ROOT ?? "").trim().replace(/\/+$/, "");
  if (rawTopo !== "") topologyRoot = rawTopo;
  else if (homeRoot !== "") topologyRoot = `${homeRoot}/topology`;
  else if (userHome !== "") topologyRoot = `${userHome}/.openrig/topology`;

  // T16f (ADR-0012 decision 2): the daemon API base. Only an http(s) URL
  // that parses is accepted; anything else behaves exactly like unset
  // (verification reports unchecked, never an error). Trailing slashes
  // are trimmed so callers can append routes.
  let daemonUrl: string | undefined;
  const rawDaemon = (env.OPENRIG_URL ?? "").trim().replace(/\/+$/, "");
  if (rawDaemon !== "") {
    try {
      const u = new URL(rawDaemon);
      if (u.protocol === "http:" || u.protocol === "https:") daemonUrl = rawDaemon;
    } catch {
      // garbage = unset, on purpose (a broken OPENRIG_URL must not disable
      // the plugin; it disables only the lookups)
    }
  }

  // ADR-0008 Decision 2: unset OBSERVE_OTHERS is true exactly when this seat
  // is its own leader (LEADER_PEER set and equal to the resolved peer); an
  // explicit value still wins, including "false" on the leader.
  const observeDefault = leaderPeer.value !== null && leaderPeer.value === peer;
  const observeOthers = readBool(env.HONCHO_OBSERVE_OTHERS, observeDefault);
  return {
    enabled: true,
    url,
    workspace,
    peer,
    observeOthers,
    // E4: unset stays undefined; an observer-ship seat is its own leader
    leaderPeer: leaderPeer.value ?? (observeOthers ? peer : undefined),
    ownerPeer: ownerPeer.value as string,
    profileWorkspace: profileWorkspace.value,
    recordAutomation: readBool(env.HONCHO_RECORD_AUTOMATION, false),
    apiKey,
    stateDir,
    timeoutMs,
    recallMaxDistance,
    recallHoldout,
    ...(rig !== undefined ? { rig } : {}),
    ...(daemonUrl !== undefined ? { daemonUrl } : {}),
    ...(sessionName !== "" ? { sessionName } : {}),
    // V5: the lore root chain, resolved in this one place (pure env reads;
    // a Codex settings file carries HONCHO_TOPOLOGY_ROOT like any HONCHO_*).
    ...(topologyRoot !== undefined ? { topologyRoot } : {}),
    // T19b: on by default; HONCHO_DIGEST=off/false/0/no gives the old block.
    digest: readBool(env.HONCHO_DIGEST, true),
    novel: readBool(env.HONCHO_RECALL_NOVELTY, true),
    // T21: on by default; HONCHO_SKIP_ROUTINE=off/false/0/no = today.
    skipRoutine: readBool(env.HONCHO_SKIP_ROUTINE, true),
  };
}
