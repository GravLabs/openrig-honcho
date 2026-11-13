// Scratch-workspace guard for integration tests (BRIEF hard limit): tests may
// only touch workspaces named honcho-bridge-scratch*, and delete them after.
import { appendFileSync } from "node:fs";
import { createClient, type HonchoClient } from "../../plugin/src/honcho.ts";
import { scratchDisappearVerdict } from "./scratch-verdict.ts";

export const SCRATCH_PREFIX = "honcho-bridge-scratch-";
export const HONCHO_URL_DEFAULT = "http://localhost:8000/v3";

/** Throws before any request if the name is not a scratch workspace. */
export function assertScratchName(name: string): void {
  if (!name.startsWith(SCRATCH_PREFIX)) {
    throw new Error(
      `refusing to touch "${name}": integration tests may only use workspaces named ${SCRATCH_PREFIX}*`,
    );
  }
}

export function scratchName(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${SCRATCH_PREFIX}${ts}-${rand}`;
}

/** A client bound to a scratch workspace; refuses any other name before use. */
export function scratchClient(workspace: string): HonchoClient {
  assertScratchName(workspace);
  return createClient({
    url: process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? HONCHO_URL_DEFAULT,
    workspace,
    apiKey: process.env.HONCHO_API_KEY ?? "local",
    timeoutMs: 10_000,
  });
}

export interface Scratch {
  name: string;
  client: HonchoClient;
  /** Deletes all sessions, then the scratch workspace; throws on failure. */
  cleanup(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function serverBase(): string {
  return (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? HONCHO_URL_DEFAULT).replace(/\/+$/, "");
}

function serverHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.HONCHO_API_KEY ?? "local"}`,
    "Content-Type": "application/json",
  };
}

/**
 * T8d-3 (ADR-0006 a2abdbd "Test traffic must not cost model-server derivation",
 * born from the soak's 308 wedged deriver units): every scratch workspace is
 * created with reasoning/summary/dream DISABLED at the workspace level, so
 * test traffic never loads the model server (shared by every rig). A test that genuinely
 * needs derivation opts in explicitly - NO current test should.
 * (Live WorkspaceConfiguration schema, probed 2026-10-29: reasoning/summary/
 * dream each {enabled: boolean}, all optional, additionalProperties true.)
 */
export function scratchWorkspaceConfiguration(opts?: { deriver?: boolean }):
  | { reasoning: { enabled: false }; summary: { enabled: false }; dream: { enabled: false } }
  | undefined {
  if (opts?.deriver === true) return undefined;
  return { reasoning: { enabled: false }, summary: { enabled: false }, dream: { enabled: false } };
}

/**
 * POST /workspaces is get-or-create (server source: routers/workspaces.py
 * get_or_create_workspace). The plugin client deliberately has no workspace
 * lifecycle (T1-fix item 4, ADR-0006 X2); only tests create or delete.
 */
async function createWorkspace(name: string, configuration?: Record<string, unknown>): Promise<void> {
  const resp = await fetch(`${serverBase()}/workspaces`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ id: name, ...(configuration !== undefined ? { configuration } : {}) }),
  });
  if (!resp.ok) {
    throw new Error(`could not create scratch workspace ${name}: HTTP ${resp.status}`);
  }
}

/**
 * T8e-fix-2 (architect 01:46Z): the post-drain delete path can be SLOW AND
 * BUSY for tens of seconds (the first full gate run lost its heavy step to a
 * throwing afterAll: 8 x 300 ms of 409s exhausted while the delete had in
 * fact landed - the run's leftovers step PASSed). A slow-but-accepted delete
 * must never fail the gate, so a rejected DELETE retries across a ~45 s
 * window on the busy/retryable statuses (409, 429, 5xx). Errors carry the
 * last STATUS only - never response body text, which could carry content.
 */
export const DELETE_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000];

const isRetryableDelete = (s: number): boolean => s === 409 || s === 429 || s >= 500;

/** One DELETE, retried per T8e-fix-2: 2xx (incl. 202) = done; 404 = already
 * gone = done (an earlier 202 may have settled); 409/429/5xx = back off and
 * retry until the window is spent; anything else is a hard no, thrown now. */
async function deleteWithRetry(
  url: string,
  headers: Record<string, string>,
  label: string,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  let last = "";
  for (let attempt = 0; ; attempt++) {
    const del = await fetch(url, { method: "DELETE", headers });
    if (del.ok || del.status === 404) return;
    last = `HTTP ${del.status}`;
    if (!isRetryableDelete(del.status)) {
      throw new Error(`cleanup: ${label} delete failed: ${last}`);
    }
    if (attempt >= DELETE_BACKOFF_MS.length) {
      throw new Error(`cleanup: ${label} delete failed after retries: ${last}`);
    }
    await sleepFn(DELETE_BACKOFF_MS[attempt]);
  }
}

/**
 * Deletes a scratch workspace fully: the server refuses workspace deletion
 * while sessions remain (observed: HTTP 409 "active session(s) remain"), so
 * list and delete every session first, then delete the workspace - accepted
 * with 202, may settle asynchronously; both deletes follow the retry policy
 * above. `sleep` is injectable so unit tests run the window instantly.
 */
export async function deleteScratchWorkspace(
  name: string,
  opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  assertScratchName(name);
  const sleepFn = opts?.sleep ?? sleep;
  const base = (process.env.HONCHO_URL ?? process.env.HONCHO_TEST_URL ?? HONCHO_URL_DEFAULT).replace(/\/+$/, "");
  const key = process.env.HONCHO_API_KEY ?? "local";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const w = encodeURIComponent(name);

  const list = await fetch(`${base}/workspaces/${w}/sessions/list?size=100`, {
    method: "POST",
    headers,
  });
  if (list.ok) {
    const page = (await list.json()) as { items?: { id: string }[] };
    for (const s of page.items ?? []) {
      await deleteWithRetry(
        `${base}/workspaces/${w}/sessions/${encodeURIComponent(s.id)}`,
        headers,
        `session ${s.id}`,
        sleepFn,
      );
    }
  }

  await deleteWithRetry(`${base}/workspaces/${w}`, headers, `workspace ${name}`, sleepFn);
}

/** The light-mode disappearance window (ADR-0006 light rule). History: 180 s
 * (T8e-fix-3, architect 02:16Z) -> 120 s -> 900 s by the ADR-0006 amendment
 * 2026-10-30 (v0.1.2 gate, T13d): the deriver is ONE worker for the whole
 * server and real workspaces (pilot, model-server calls of 2.5-45 min) load it
 * as much as tests do - both v0.1.2 gate runs showed every scratch DELETE
 * accepted with the light tests failing their 120 s wait while the leftovers
 * step saw them all gone (405 s). Now equal to the gate's leftovers window:
 * on a busy server the gate takes longer instead of failing on server
 * throughput; on an idle one nothing gets slower. */
export const SCRATCH_DISAPPEAR_WINDOW_MS = 900_000;
const DISAPPEAR_POLL_MS = 3_000;

export interface CleanupScratchOpts {
  /** default: HONCHO_HEAVY_TESTS === "1" */
  heavy?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** listed workspace ids; must THROW on a failed list (never "empty") */
  listWorkspaces?: () => Promise<string[]>;
}

/** T14f: inside a gate run (HONCHO_GATE_DELETES=<abs path>) append one line
 * `{"name":..,"at":..}` per ACCEPTED workspace DELETE and return true;
 * outside a gate run do nothing and return false. Every scratch cleanup path
 * calls it, not only cleanupScratch (the v0.2.0 gate missed review-t6c's own
 * paged delete). */
export function recordGateDeletes(names: readonly string[]): boolean {
  const gateDeletes = (process.env.HONCHO_GATE_DELETES ?? "").trim();
  if (gateDeletes === "") return false;
  appendFileSync(
    gateDeletes,
    names.map((n) => `${JSON.stringify({ name: n, at: new Date().toISOString() })}\n`).join(""),
    { mode: 0o600 },
  );
  return true;
}

/**
 * T8e-fix-3: scratch cleanup per RUN MODE (ADR-0006: "heavy tests verify the
 * DELETE was accepted and leave disappearance to the gate's final check;
 * light tests verify disappearance"). Deletes every name with the retry
 * policy (a rejected DELETE throws there in BOTH modes - acceptance is always
 * proven); in heavy mode stops there with the names logged; in light mode
 * additionally polls workspaces/list until they are gone (the full
 * SCRATCH_DISAPPEAR_WINDOW_MS window); since F5 (review R14 O3) a window
 * that ends with still-listed names whose DELETE was accepted PASSES as
 * purge-pending - the gate leftovers step's own verdict - and only a name
 * without an accepted DELETE throws.
 * The gate's leftovers step stays the authoritative final proof either way.
 */
export async function cleanupScratch(
  names: string[],
  opts: CleanupScratchOpts = {},
): Promise<"accepted" | "disappeared"> {
  const heavy = opts.heavy ?? process.env.HONCHO_HEAVY_TESTS === "1";
  const accepted = new Set<string>(); // F5: per-name fact the verdict reads
  for (const n of names) {
    await deleteScratchWorkspace(n); // throws unless the DELETE was accepted
    accepted.add(n);
  }
  // T14f (ADR-0006 amendment 2026-10-31): inside a gate run the gate sets
  // HONCHO_GATE_DELETES=<abs path>; in BOTH modes cleanup then stops once
  // every DELETE is accepted and records the names there. The leftovers step
  // passes pending deletes against that file, and release.ts refuses while
  // any scratch is still listed - the release, not the gate, carries the
  // proof the server caught up. Unset: the pre-T14f behaviour below, unchanged.
  if (recordGateDeletes(names)) {
    console.log(
      `SCRATCH CLEANUP (gate deletes): DELETE accepted for ${JSON.stringify(names)}; recorded, disappearance left to the gate report and release.ts`,
    );
    return "accepted";
  }
  if (heavy) {
    console.log(
      `SCRATCH CLEANUP (heavy): DELETE accepted for ${JSON.stringify(names)}; disappearance left to the gate's final check`,
    );
    return "accepted";
  }
  const sleepFn = opts.sleep ?? sleep;
  const nowFn = opts.now ?? Date.now;
  const list =
    opts.listWorkspaces ??
    (async (): Promise<string[]> => {
      const resp = await fetch(`${serverBase()}/workspaces/list?size=100`, {
        method: "POST",
        headers: serverHeaders(),
      });
      if (!resp.ok) {
        throw new Error(`scratch cleanup: workspaces/list HTTP ${resp.status} - cannot prove deletion`);
      }
      const page = (await resp.json()) as { items?: { id: string }[] };
      if (!Array.isArray(page.items)) {
        throw new Error("scratch cleanup: workspaces/list answer had no items array");
      }
      return page.items.map((x) => x.id);
    });
  const started = nowFn();
  const deadline = started + SCRATCH_DISAPPEAR_WINDOW_MS;
  for (;;) {
    const listed = await list();
    const still = names.filter((n) => listed.includes(n));
    if (still.length === 0) {
      console.log(
        `SCRATCH CLEANUP (light): disappeared ${JSON.stringify(names)} in ${Math.round((nowFn() - started) / 1000)} s; other scratch remaining: ${JSON.stringify(listed.filter((i) => i.startsWith(SCRATCH_PREFIX)))}`,
      );
      return "disappeared";
    }
    if (nowFn() >= deadline) {
      // F5 (review R14 O3): ONE verdict on this fact with the gate's
      // leftovers step - names whose DELETE was ACCEPTED are the server's
      // async purge lag and pass as pending, exactly as the leftovers step
      // passes them; release.ts still refuses while any scratch is listed.
      // A name without an accepted DELETE is our failure and throws here.
      console.log(scratchDisappearVerdict(still, SCRATCH_DISAPPEAR_WINDOW_MS, (n) => accepted.has(n), nowFn() - started).line);
      return "accepted";
    }
    await sleepFn(DISAPPEAR_POLL_MS);
  }
}

/**
 * Creates a fresh scratch workspace (or uses `name` if given — it still must
 * start with the scratch prefix; checked before any request). Created with
 * the deriver disabled at the workspace level (T8d-3); `deriver: true` opts
 * back in for a test that genuinely needs derivation - none currently does.
 */
export async function scratchWorkspace(name?: string, opts?: { deriver?: boolean }): Promise<Scratch> {
  const wsName = name ?? scratchName();
  assertScratchName(wsName);
  const client = scratchClient(wsName);
  await createWorkspace(wsName, scratchWorkspaceConfiguration(opts) as Record<string, unknown> | undefined);
  return {
    name: wsName,
    client,
    async cleanup() {
      await deleteScratchWorkspace(wsName);
    },
  };
}
