import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// The old free-text log() was removed with architect fix 19:50Z #1: every
// line of <stateDir>/log/<workspace>.log must parse as JSON (O1). The
// config-problem log (_config.log) is separate and unchanged below.

// ---------------------------------------------------------------------------
// O1 (ADR-0006): the structured event log. One JSON line per hook run or MCP
// tool call. ONLY these fields - never message content, prompt text,
// summaries, facts, questions, URLs with paths, or server error strings
// (X1: no secrets; error_class names the failure shape, not its text).
// Rotated past 5 MB: .log -> .1 -> .2 -> .3, .3 dropped. 0600 file, 0700 dir.

export type LogHook = "session-start" | "user-prompt" | "recall" | "stop" | "mcp";

export interface LogEvent {
  hook: LogHook;
  event: string;
  ok: boolean;
  ms: number;
  session?: string;
  n_msgs?: number;
  /** T14d-2: recall run - the count of items rendered, never their ids. */
  n_items?: number;
  /**
   * ADR-0011 decision 7 (T16b): the recall filter counts - counts only,
   * never content. present on the recall empty/injected events (query_chars
   * also on timeout/error once a query exists; partial only when > 0).
   */
  considered?: number;
  dropped_context?: number;
  dropped_dup?: number;
  dropped_trivia?: number;
  query_chars?: number;
  partial?: number;
  /**
   * T16f (ADR-0012 decision 2): the outbox verification result for a peer
   * prompt in the user-prompt hook's single run event. Absent when no
   * lookup was attempted (no OPENRIG_URL) or the prompt was not a peer one.
   */
  verify?: "verified" | "unverified" | "unchecked";
  bytes?: number;
  error_class?: string;
}

/** Minimal config view the logger needs (never carries the API key). */
export interface LogTarget {
  stateDir: string;
  workspace: string;
  peer: string;
}

const ROTATE_BYTES = 5_000_000;
const ROTATE_KEEP = 3;

/**
 * Map a failure shape to the O1 error_class vocabulary. Takes the kind (and
 * status for http) only - never the error string, which can echo content.
 */
export function errorClassFrom(kind: string, status?: number): string {
  if (kind === "http" && status !== undefined) return `http_${status}`;
  if (kind === "connect" || kind === "timeout" || kind === "parse") return kind;
  return "other";
}

export function logEvent(config: LogTarget, e: LogEvent): void {
  try {
    const dir = join(config.stateDir, "log");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${config.workspace}.log`);
    try {
      if (statSync(file).size > ROTATE_BYTES) rotateLog(file);
    } catch {
      // absent or unreadable: nothing to rotate
    }
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      hook: e.hook,
      peer: config.peer,
      event: e.event,
      ok: e.ok,
      ms: Math.max(0, Math.round(e.ms)),
    };
    if (e.session !== undefined) line.session = e.session;
    if (e.n_msgs !== undefined) line.n_msgs = e.n_msgs;
    if (e.n_items !== undefined) line.n_items = e.n_items;
    if (e.considered !== undefined) line.considered = e.considered;
    if (e.dropped_context !== undefined) line.dropped_context = e.dropped_context;
    if (e.dropped_dup !== undefined) line.dropped_dup = e.dropped_dup;
    if (e.dropped_trivia !== undefined) line.dropped_trivia = e.dropped_trivia;
    if (e.query_chars !== undefined) line.query_chars = e.query_chars;
    if (e.partial !== undefined) line.partial = e.partial;
    if (e.verify !== undefined) line.verify = e.verify;
    if (e.bytes !== undefined) line.bytes = e.bytes;
    if (e.error_class !== undefined) line.error_class = e.error_class;
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // event logging must never fail a hook or print anything
  }
}

/** .log -> .1 -> .2 -> .3 (dropping the old .3); caller checked the size. */
function rotateLog(file: string): void {
  for (let i = ROTATE_KEEP; i >= 1; i--) {
    const src = i === 1 ? file : `${file}.${i - 1}`;
    const dst = `${file}.${i}`;
    if (!existsSync(src)) continue;
    if (existsSync(dst)) rmSync(dst, { force: true });
    renameSync(src, dst);
  }
}

/**
 * The {ts, hook, event, ok, error_class} of the last n JSON log lines
 * (newest last), unreadable file = []. Projection is exhaustive: no other
 * field can leave through this reader (O3/F-T8-4: raw lines are never
 * re-served).
 */
export function readLogTail(
  config: LogTarget,
  n = 5,
): { ts: string; hook: string; event: string; ok: boolean; error_class?: string }[] {
  const out: { ts: string; hook: string; event: string; ok: boolean; error_class?: string }[] = [];
  try {
    const lines = readFileSync(join(config.stateDir, "log", `${config.workspace}.log`), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    for (const l of lines.slice(-n * 3)) {
      try {
        const o = JSON.parse(l) as Record<string, unknown>;
        if (typeof o.ts !== "string" || typeof o.hook !== "string" || typeof o.event !== "string") continue;
        out.push({
          ts: o.ts,
          hook: o.hook,
          event: o.event,
          ok: o.ok === true,
          ...(typeof o.error_class === "string" ? { error_class: o.error_class } : {}),
        });
      } catch {
        // a non-JSON (legacy) line is skipped, never echoed
      }
    }
    return out.slice(-n);
  } catch {
    return out;
  }
}

/**
 * Log a disabled-by-bad-config line to `<base>/log/_config.log` (ADR-0001,
 * review T1 F2), where `<base>` is HONCHO_STATE_DIR when it is an absolute
 * path, else $HOME/.openrig-honcho, else nothing happens at all.
 *
 * At most one line per distinct reason per hour, judged against the file's
 * last line. Never throws; stdout/stderr stay empty. The reason carries the
 * variable name and rule only - never a value.
 */
export function logConfigProblem(
  env: Record<string, string | undefined>,
  hook: string,
  reason: string,
): void {
  try {
    const stateDir = (env.HONCHO_STATE_DIR ?? "").trim();
    const home = (env.HOME ?? "").trim();
    let base = "";
    if (stateDir.startsWith("/")) base = stateDir;
    else if (home !== "") base = join(home, ".openrig-honcho");
    if (base === "") return;

    const dir = join(base, "log");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "_config.log");

    if (lastLineHasSameRecentReason(file, reason)) return;
    appendFileSync(
      file,
      `${JSON.stringify({ ts: new Date().toISOString(), hook, reason })}\n`,
      "utf8",
    );
  } catch {
    // config logging must never fail a hook or print anything
  }
}

function lastLineHasSameRecentReason(file: string, reason: string): boolean {
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const lines = content.trimEnd().split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  try {
    const obj = JSON.parse(last) as { ts?: string; reason?: string };
    if (obj.reason !== reason || typeof obj.ts !== "string") return false;
    const tsMs = Date.parse(obj.ts);
    return Number.isFinite(tsMs) && Date.now() - tsMs < 3600_000;
  } catch {
    return false;
  }
}
