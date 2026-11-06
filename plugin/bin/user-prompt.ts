// UserPromptSubmit hook (T6a): read the stdin JSON {prompt, session_id},
// evaluate the env contract, run the writer. The kill switch (HONCHO_ENABLED
// off) exits 0 silently - off means off, nothing logged (review T1 F2); any
// other config problem is logged, not printed. NEVER writes stdout or stderr:
// a hook must not touch the model's context or the user's terminal (S1).
import type { Config } from "../src/env.ts";
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { logConfigProblem, logEvent } from "../src/log.ts";
import { takeOnce } from "../src/once.ts";
import { recordPrompt } from "../src/writer.ts";

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
  // O1: exactly one structured event per hook run, once a config exists
  // (no config = no workspace to log under; the kill switch stays silent).
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    const loaded = loadConfig(process.env);
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
