// UserPromptSubmit hook (T6a): read the stdin JSON {prompt, session_id},
// evaluate the env contract, run the writer. The kill switch (HONCHO_ENABLED
// off) exits 0 silently - off means off, nothing logged (review T1 F2); any
// other config problem is logged, not printed. NEVER writes stdout or stderr:
// a hook must not touch the model's context or the user's terminal (S1).
import type { Config } from "../src/env.ts";
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { bindEventFields, errorClassFrom, logConfigProblem, logEvent } from "../src/log.ts";
// F-G (O6, R15 Part 2): the claim-time pointer MOVED to the synchronous
// recall.ts - async stdout cannot reach the turn (ADR-0001's I/O table;
// Codex aborts async hook tasks at shutdown). This hook writes and logs
// only and prints NOTHING.
import { takeOnce } from "../src/once.ts";
import { recordPrompt } from "../src/writer.ts";
// C2 (ADR-0016): shared stdin seam. UserPromptSubmit carries the same fields
// on both harnesses (probe C1 §1); --harness is accepted and needs no mapping
// here. F-G: writeHookJson left with the pointer (nothing printed anymore).
import { readStdin, resolveHarness } from "../src/harness.ts";
import { harnessUnknownWithSettings, readSettingsFile } from "../src/settings.ts";

async function main(): Promise<void> {
  const t0 = Date.now();
  // C2b (review F3): this hook needs no harness mapping, only the flag.
  // C2c (review F4): the flag rides this run's ONE event line, bound here.
  // C5a: harness is also the gate for the settings-file merge below.
  const { harness, flagUnknown } = resolveHarness(process.argv.slice(2));
  if (flagUnknown) bindEventFields({ harness_unknown: 1 });
  // O1: exactly one structured event per hook run, once a config exists
  // (no config = no workspace to log under; the kill switch stays silent).
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    // C5a (ADR-0016 decision 9): settings file under the environment (see
    // session-start.ts); a broken file = plugin off for this run, exit 0.
    let env: Record<string, string | undefined> = process.env;
    if (harness === "codex") {
      const s = readSettingsFile(process.argv.slice(2));
      if (s.problem !== null) {
        logConfigProblem(process.env, "UserPromptSubmit", s.problem);
        process.exit(0);
      }
      env = { ...s.vars, ...process.env };
    }
    // C5a2 (review O2): an unresolved --harness next to --settings IS the
    // cause; name it instead of blaming the missing URL.
    const harnessProblem = harnessUnknownWithSettings(process.argv.slice(2), flagUnknown);
    if (harnessProblem !== null) {
      logConfigProblem(process.env, "UserPromptSubmit", harnessProblem);
      process.exit(0);
    }
    const loaded = loadConfig(env);
    if (!loaded.enabled) {
      if (!isKillSwitch(loaded.reason)) {
        logConfigProblem(process.env, "UserPromptSubmit", loaded.reason);
      }
      process.exit(0);
    }
    cfg = loaded;
    // T15a (ADR-0010 decision 2): the once-guard - two installs run this hook
    // twice per prompt; the duplicate copy writes nothing and leaves silently.
    if (!takeOnce(cfg.stateDir, cfg.workspace, "user-prompt", raw)) {
      logEvent(cfg, { hook: "user-prompt", event: "duplicate-run", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    let input: { prompt?: unknown; session_id?: unknown } = {};
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      // garbage stdin: nothing to record, nothing to say
      logEvent(cfg, { hook: "user-prompt", event: "stdin-invalid", ok: false, ms: Date.now() - t0, error_class: "parse" });
      process.exit(0);
    }
    if (typeof input.prompt !== "string" || input.prompt === "") {
      logEvent(cfg, { hook: "user-prompt", event: "empty", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    const client = createClient({
      url: cfg.url,
      workspace: cfg.workspace,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
    const out = await recordPrompt(
      {
        prompt: input.prompt,
        ...(typeof input.session_id === "string" ? { claudeSessionId: input.session_id } : {}),
      },
      cfg,
      { client, now: () => new Date().toISOString() },
    );
    // F-G: the pointer branch lived here; it moved to the synchronous
    // recall.ts, where its output can actually reach the turn.
    // on the contained-exception path recordPrompt already wrote this run's
    // single event; do not double-log it here.
    // T14b-2 (ADR-0009): a not-recorded attribution skip is correct behaviour,
    // not a failure - it logs its own event name with ok:true, like Stop's
    // "duplicate segment". reason "duplicate" (no prompt-side caller today) is
    // handled the same way, for completeness.
    if (!(out.action === "skipped" && out.reason === "unexpected")) {
      const benign =
        out.action === "skipped" && (out.reason === "not-recorded" || out.reason === "duplicate")
          ? out.reason
          : undefined;
      logEvent(cfg, {
        hook: "user-prompt",
        event: benign ?? out.action,
        ok: benign !== undefined || out.action === "sent",
        ms: Date.now() - t0,
        ...(out.action !== "skipped" ? { session: out.session, n_msgs: out.n_msgs } : {}),
        ...("routine" in out && out.routine === true ? { routine: 1 } : {}), // T21 (E5b)
        ...(out.action !== "skipped" && out.verify !== undefined ? { verify: out.verify } : {}),
        ...(out.action === "spooled" && out.error_class !== undefined
          ? { error_class: out.error_class }
          : {}),
      });
    }
  } catch {
    if (cfg !== null) {
      logEvent(cfg, { hook: "user-prompt", event: "unexpected", ok: false, ms: Date.now() - t0, error_class: "other" });
    }
    // degrade to nothing (ADR-0001)
  }
  process.exit(0);
}

void main();
