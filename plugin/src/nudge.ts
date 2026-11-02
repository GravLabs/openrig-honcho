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

import { execFile } from "node:child_process";
import type { Config } from "./env.ts";
import { missionIdIsSecretShaped, normalizeMission, readRigMission, setRigMission } from "./missions.ts";

/** ADR-0003 nudge text; the capture is the id validation (X5). */
const NUDGE_RE = /^Queue handoff: (qitem-[0-9A-Za-z-]{1,80}) - check your queue\./;

/** Standalone re-validation for ids handed straight to missionFromQitem. */
const QID_RE = /^qitem-[0-9A-Za-z-]{1,80}$/;

/** The qitem id of a handoff nudge body; null for anything else. */
export function qitemIdFromNudge(body: string): string | null {
  const m = NUDGE_RE.exec(body);
  return m === null ? null : m[1];
}

export interface QueueHintDeps {
  /** the injectable subprocess runner (unit tests never spawn a real rig) */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;
}

/** The one subprocess (X5): no shell, args array, 3 s, 1 MB stdout cap. */
function defaultRun(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
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
