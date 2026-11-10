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
import { bindEventFields, logConfigProblem, logEvent } from "../src/log.ts";
import { readSeatState, seatStatePath, setContextStart } from "../src/missions.ts";
import { takeOnce } from "../src/once.ts";
import { buildInjection, type ContinuityStats } from "../src/reader.ts";
import type { InjectionSource } from "../src/inject.ts";
// C2 (ADR-0016): stdin, harness and output shape come from the shared seam.
import { readStdin, resolveHarness, sessionStartSource, writeHookJson } from "../src/harness.ts";
import { harnessUnknownWithSettings, readSettingsFile } from "../src/settings.ts";

const SOURCES: readonly string[] = ["startup", "resume", "clear", "compact"];

async function main(): Promise<void> {
  const t0 = Date.now();
  const { harness, flagUnknown } = resolveHarness(process.argv.slice(2));
  // C2c (review F4): the unresolved flag rides this run's ONE event line
  // (bound here, before any log call), never a line of its own. Names only.
  if (flagUnknown) bindEventFields({ harness_unknown: 1 });
  // O1: exactly one structured event per hook run (see user-prompt.ts)
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    // C5a (ADR-0016 decision 9): a Codex run may name a settings file; its
    // values merge UNDER the environment. A broken file turns the plugin off
    // for this run, named (never valued) in _config.log, exit 0.
    let env: Record<string, string | undefined> = process.env;
    if (harness === "codex") {
      const s = readSettingsFile(process.argv.slice(2));
      if (s.problem !== null) {
        logConfigProblem(process.env, "SessionStart", s.problem);
        process.exit(0);
      }
      env = { ...s.vars, ...process.env };
    }
    // C5a2 (review O2): an unresolved --harness next to --settings IS the
    // cause; name it instead of blaming the missing URL.
    const harnessProblem = harnessUnknownWithSettings(process.argv.slice(2), flagUnknown);
    if (harnessProblem !== null) {
      logConfigProblem(process.env, "SessionStart", harnessProblem);
      process.exit(0);
    }
    const loaded = loadConfig(env);
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
    let input: { session_id?: unknown; source?: unknown; cwd?: unknown } = {};
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      // garbage stdin: nothing to inject
      logEvent(cfg, { hook: "session-start", event: "stdin-invalid", ok: false, ms: Date.now() - t0, error_class: "parse" });
      process.exit(0);
    }
    // C2 (ADR-0016): Codex "fork" is treated as "resume" before the check;
    // every Claude source passes through unchanged.
    const source = sessionStartSource(harness, input.source);
    if (typeof source !== "string" || !SOURCES.includes(source)) {
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
    // T19b: when the digest path ran, the reader hands back the part counts
    // (counts only) for the single session-start log line.
    let continuity: ContinuityStats | undefined;
    const text = await buildInjection(
      {
        source: source as InjectionSource,
        ...(typeof input.session_id === "string" ? { claudeSessionId: input.session_id } : {}),
        // the digest's restore-map pointer is resolved under this cwd
        ...(typeof input.cwd === "string" && input.cwd !== "" ? { cwd: input.cwd } : {}),
      },
      cfg,
      {
        client,
        ...(profileClient !== undefined ? { profileClient } : {}),
        now: () => new Date().toISOString(),
        stats: (s) => {
          continuity = s;
        },
      },
    );
    if (source !== "resume") {
      await setContextStart(cfg.stateDir, cfg.workspace, cfg.peer, contextStart);
    }
    if (text !== "") {
      writeHookJson("SessionStart", text);
    }
    // fix 19:50Z #3: the HONCHO session name (as the writer logs it), not the
    // Claude session id - buildInjection's resolveSession just set it.
    const honchoSession = readSeatState(seatStatePath(cfg.stateDir, cfg.workspace, cfg.peer))?.session;
    logEvent(cfg, {
      hook: "session-start",
      event: source, // validated against SOURCES above
      ok: true,
      ms: Date.now() - t0,
      ...(honchoSession !== undefined ? { session: honchoSession } : {}),
      // T19b: digest counts ride the same single event; absent on the old path
      ...(continuity !== undefined
        ? {
            moment: continuity.moment,
            n_open: continuity.n_open,
            n_decisions: continuity.n_decisions,
            n_approvals: continuity.n_approvals,
            n_away: continuity.n_away,
            has_pointer: continuity.has_pointer,
          }
        : {}),
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
