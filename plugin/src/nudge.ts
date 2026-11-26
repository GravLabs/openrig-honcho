// E11 (ADR-0005): mission hint from queue nudges. Seats forget to call
// mission(id) and everything lands in "general"; a queue handoff nudge's body
// carries the qitem id, and the qitem's `mission:<id>` tag names the mission.
// The nudge text is fixed by ADR-0003:
//   "Queue handoff: <qitemId> - check your queue.[ Summary: <=120 chars]"
// The tags are not in the nudge, so we look them up with the child_process
// File verb: cmd "rig", args ["queue", "show", <id>, "--json"] - the ONLY
// subprocess in plugin/ (ADR-0006 X5): no shell, args as an array, the id
// re-validated by the same grammar the nudge regex captures with, 3 s
// timeout, stdout capped at 1 MB. (The one execFile call site is defaultRun;
// this header avoids the literal so a grep for it counts exactly one.) The hint sets the mission only while it
// is "general" (never overrides a tool-set mission), same atomic write as the
// MCP tool, set_by "queue". Any failure is ignored (E11: a wrong or missing
// hint costs one mission(id) call).
// ADR-0021 decision 3 (X5 amended 2026-11-25): the same runner also serves
// createQueueRow's second allowlisted shape - a queue create for the stale
// review notice (10 s). defaultRun refuses every other argv before execFile;
// the scan pins both quoted verb pairs and any "rig" argv head outside this
// file.

import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { Config } from "./env.ts";
import { missionIdIsSecretShaped, normalizeMission, readRigMission, setRigMission } from "./missions.ts";

/** ADR-0003 nudge text; the capture is the id validation (X5). */
const NUDGE_RE = /^Queue handoff: (qitem-[0-9A-Za-z-]{1,80}) - check your queue\./;

/** Standalone re-validation for ids handed straight to missionFromQitem. */
const QID_RE = /^qitem-[0-9A-Za-z-]{1,80}$/;

/** ADR-0021 d3: a queue create destination is exactly `<seat>@<rig>`. */
const SESSION_RE = /^[A-Za-z0-9_-]{1,100}@[A-Za-z0-9_-]{1,100}$/;

/** ADR-0021 d3: a queue create summary: printable, no newline, <= 160. */
const SUMMARY_RE = /^[\x20-\x7E]{1,160}$/;

/**
 * The fixed origin a create declares: the daily check runs from a systemd
 * timer, outside any seat, and `rig queue create` there refuses without
 * --source (probed by design-architect 2026-11-25). The rig is the rig part
 * of the validated destination, so the source can only ever name the
 * destination's own rig. Caller guarantees SESSION_RE.test(session).
 */
function staleCheckSource(session: string): string {
  return "stale-check@" + session.slice(session.indexOf("@") + 1);
}

/**
 * X5 (ADR-0021 amended): the ONLY two argv shapes the runner may execute,
 * checked before the one subprocess call. The create body path must be an
 * absolute path (createQueueRow additionally proves it is a file inside the
 * state dir, which the runner itself cannot know), and it carries
 * --source stale-check@<rig of destination> right after --destination: the
 * timer that runs the daily check is not a seat, so it must declare itself.
 */
export function rigArgvAllowed(cmd: string, args: string[]): boolean {
  if (cmd !== "rig") return false;
  if (
    args.length === 4 && args[0] === "queue" && args[1] === "show" &&
    QID_RE.test(args[2]) && args[3] === "--json"
  )
    return true;
  return (
    args.length === 13 && args[0] === "queue" && args[1] === "create" &&
    args[2] === "--destination" && SESSION_RE.test(args[3]) &&
    args[4] === "--source" && SESSION_RE.test(args[5]) &&
    args[5] === staleCheckSource(args[3]) &&
    args[6] === "--summary" && SUMMARY_RE.test(args[7]) &&
    args[8] === "--body-file" && isAbsolute(args[9]) &&
    args[10] === "--tags" && args[11] === "openrig-honcho,stale-review" && args[12] === "--json"
  );
}

/** The qitem id of a handoff nudge body; null for anything else. */
export function qitemIdFromNudge(body: string): string | null {
  const m = NUDGE_RE.exec(body);
  return m === null ? null : m[1];
}

export interface QueueHintDeps {
  /** the injectable subprocess runner (unit tests never spawn a real rig) */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;
}

/** The one subprocess (X5): no shell, args array, 1 MB stdout cap; the
 * timeout is the caller's (3 s show, 10 s create). Anything outside the
 * allowlist is refused here, before the spawn. */
function defaultRun(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  if (!rigArgvAllowed(cmd, args))
    return Promise.reject(new Error("rig argv not allowlisted (X5)"));
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err !== null) reject(err); // non-zero exit, timeout, spawn failure
      else resolve({ code: 0, stdout });
    });
  });
}

/**
 * The `mission:<x>` tag of a qitem, normalised (ADR-0002); null for "no hint"
 * whatever the reason (id not the validated grammar, rig missing, non-zero
 * exit, timeout, bad JSON, no mission tag). Never throws.
 */
export async function missionFromQitem(id: string, deps: QueueHintDeps = {}): Promise<string | null> {
  try {
    if (!QID_RE.test(id)) return null;
    const run = deps.run ?? defaultRun;
    const r = await run("rig", ["queue", "show", id, "--json"], 3000);
    if (r.code !== 0) return null;
    const doc = JSON.parse(r.stdout) as { tags?: unknown };
    const tags = Array.isArray(doc.tags) ? doc.tags : [];
    const tag = tags.find(
      (t): t is string => typeof t === "string" && t.startsWith("mission:") && t.slice(8) !== "",
    );
    if (tag === undefined) return null;
    // T16j VF2a (same rule as the writer's fetched-item path): a
    // secret-shaped mission tag is no hint at all. normalizeMission would
    // otherwise embed a derived fragment of the secret in mission.json
    // forever (mcp.ts F-T8-3 for mission(id)). This path's failures are
    // documented silent no-ops (E11); the refusal is a null hint here, and
    // the writer's daemon-nudge path logs the reason class.
    const raw = tag.slice(8);
    if (missionIdIsSecretShaped(raw)) return null;
    return normalizeMission(raw);
  } catch {
    return null;
  }
}

/**
 * E11: on a handoff nudge (peer kind, gated by the caller), if the qitem
 * carries a `mission:<x>` tag and the rig mission is still "general", set it
 * (set_by "queue") BEFORE the write, so the handoff message itself lands in
 * the hinted mission session. Cheap local check first: an already-set mission
 * spends no subprocess. Never throws; every failure is a silent no-op, and
 * the write is never delayed past the subprocess's own 3 s budget.
 */
export async function applyQueueMissionHint(
  content: string,
  config: Config,
  deps: { queueHintRun?: QueueHintDeps["run"] },
): Promise<void> {
  try {
    const id = qitemIdFromNudge(content);
    if (id === null) return;
    if (readRigMission(config.stateDir, config.workspace).mission !== "general") return;
    const mission = await missionFromQitem(
      id,
      deps.queueHintRun !== undefined ? { run: deps.queueHintRun } : {},
    );
    if (mission !== null) {
      await setRigMission(config.stateDir, config.workspace, mission, "queue");
    }
  } catch {
    // E11: hint failure is a no-op, never a writer failure
  }
}

export interface QueueCreateDeps {
  /** the injectable subprocess runner (unit tests never spawn a real rig) */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;
}

/**
 * ADR-0021 decision 3: post one queue row through the allowlisted runner.
 * Everything is validated BEFORE the run: the session is `<seat>@<rig>`,
 * the summary is printable, single-line, <= 160 chars, the body file is
 * a real file INSIDE the state dir (0600, written by the caller, removed by
 * the caller), and the argv declares --source stale-check@<rig of
 * destination> (the daily check runs from a systemd timer, outside any
 * seat). false = refused, non-zero exit, timeout or throw; never a
 * throw and never a real rig call for a refused shape (X5).
 */
export async function createQueueRow(
  stateDir: string,
  session: string,
  summary: string,
  bodyPath: string,
  deps: QueueCreateDeps = {},
): Promise<boolean> {
  try {
    if (!SESSION_RE.test(session)) return false;
    if (!SUMMARY_RE.test(summary)) return false;
    const abs = resolve(bodyPath);
    const sd = resolve(stateDir);
    if (abs !== sd && !abs.startsWith(sd + sep)) return false;
    // F-C (R25, probe D N2): lstat, not stat - a symlink inside the state
    // dir points its content OUTSIDE it, and stat follows. Refuse anything
    // that is not a regular file with mode 0600, the standard settings.ts
    // (--settings) and report.ts (--out) already apply to caller files.
    const body = lstatSync(abs);
    if (!body.isFile() || (body.mode & 0o777) !== 0o600) return false;
    const args = [
      "queue", "create",
      "--destination", session,
      "--source", staleCheckSource(session), // the timer is not a seat (probed)
      "--summary", summary,
      "--body-file", abs,
      "--tags", "openrig-honcho,stale-review",
      "--json",
    ];
    const run = deps.run ?? defaultRun;
    const r = await run("rig", args, 10000);
    return r.code === 0;
  } catch {
    return false;
  }
}
