// SessionStart hook (T7b, ADR-0001 hook table, ADR-0004): read the stdin JSON
// {session_id, transcript_path, cwd, source}, evaluate the env contract, run
// the reader, and print AT MOST one line on stdout:
//   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}
// Nothing else on stdout, nothing on stderr, exit 0 always. Kill switch and
// bad config print nothing (off means off, review T1 F2); a config problem
// that is not the kill switch is logged, not printed. A source outside the
// four Claude Code sends (startup/resume/clear/compact) is not guessed at:
// nothing is injected. buildInjection already holds the whole fetch phase to
// its 4 s budget; process.exit here also ends any abandoned slow request.
import type { Config } from "../src/env.ts";
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { logConfigProblem, logEvent } from "../src/log.ts";
import { readSeatState, seatStatePath, setContextStart } from "../src/missions.ts";
import { takeOnce } from "../src/once.ts";
import { buildInjection } from "../src/reader.ts";
import type { InjectionSource } from "../src/inject.ts";

const SOURCES: readonly string[] = ["startup", "resume", "clear", "compact"];

async function readStdin(timeoutMs: number): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.stdin.resume();
  });
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // O1: exactly one structured event per hook run (see user-prompt.ts)
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    const loaded = loadConfig(process.env);
    if (!loaded.enabled) {
      if (!isKillSwitch(loaded.reason)) {
        logConfigProblem(process.env, "SessionStart", loaded.reason);
      }
      process.exit(0);
    }
    cfg = loaded;
    // T15a (ADR-0010 decision 2): parent + subfolder installs run both hook
    // copies with byte-identical stdin; the copy that finds a fresh
    // once-marker leaves silently (exit 0, no stdout) with one log line.
    if (!takeOnce(cfg.stateDir, cfg.workspace, "session-start", raw)) {
      logEvent(cfg, { hook: "session-start", event: "duplicate-run", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    let input: { session_id?: unknown; source?: unknown } = {};
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      // garbage stdin: nothing to inject
      logEvent(cfg, { hook: "session-start", event: "stdin-invalid", ok: false, ms: Date.now() - t0, error_class: "parse" });
      process.exit(0);
    }
    if (typeof input.source !== "string" || !SOURCES.includes(input.source)) {
      // unknown start: no semantics, no block - a deliberate no-op, not a failure
      logEvent(cfg, { hook: "session-start", event: "unknown-source", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    const client = createClient({
      url: cfg.url,
      workspace: cfg.workspace,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
    const profileClient =
      cfg.profileWorkspace === null
        ? undefined
        : createClient({
            url: cfg.url,
            workspace: cfg.profileWorkspace,
            apiKey: cfg.apiKey,
            timeoutMs: cfg.timeoutMs,
          });
    // T16b (ADR-0011 decision 2): the seat's CURRENT context begins now on
    // startup/clear/compact; resume keeps the old context and its old mark.
    // The instant is taken BEFORE the (up to 4 s) fetch; the write runs
    // AFTER buildInjection because resolveSession, inside it, creates the
    // seat state on first start. A skipped write (missing state, lock busy)
    // leaves recall on its 30-minute fallback.
    const contextStart = new Date().toISOString();
    const text = await buildInjection(
      {
        source: input.source as InjectionSource,
        ...(typeof input.session_id === "string" ? { claudeSessionId: input.session_id } : {}),
      },
      cfg,
      {
        client,
        ...(profileClient !== undefined ? { profileClient } : {}),
        now: () => new Date().toISOString(),
      },
    );
    if (input.source !== "resume") {
      await setContextStart(cfg.stateDir, cfg.workspace, cfg.peer, contextStart);
    }
    if (text !== "") {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
        })}\n`,
      );
    }
    // fix 19:50Z #3: the HONCHO session name (as the writer logs it), not the
    // Claude session id - buildInjection's resolveSession just set it.
    const honchoSession = readSeatState(seatStatePath(cfg.stateDir, cfg.workspace, cfg.peer))?.session;
    logEvent(cfg, {
      hook: "session-start",
      event: input.source, // validated against SOURCES above
      ok: true,
      ms: Date.now() - t0,
      ...(honchoSession !== undefined ? { session: honchoSession } : {}),
      bytes: text.length,
    });
  } catch {
    if (cfg !== null) {
      logEvent(cfg, { hook: "session-start", event: "unexpected", ok: false, ms: Date.now() - t0, error_class: "other" });
    }
    // degrade to nothing (ADR-0001)
  }
  process.exit(0);
}

void main();
