// Stop hook (T6b): read the stdin JSON {session_id, transcript_path,
// last_assistant_message, stop_hook_active}, evaluate the env contract, run
// the reply writer. Same silence rules as user-prompt.ts: the kill switch
// exits 0 without logging, other config problems are logged not printed, and
// the hook NEVER writes stdout or stderr (ADR-0001 hook table, S1).
import type { Config } from "../src/env.ts";
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { logConfigProblem, logEvent } from "../src/log.ts";
import { takeOnce } from "../src/once.ts";
import { recordReply } from "../src/stop.ts";

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
        logConfigProblem(process.env, "Stop", loaded.reason);
      }
      process.exit(0);
    }
    cfg = loaded;
    // T15a (ADR-0010 decision 2): the once-guard - a duplicate copy of this
    // Stop event (two installs, byte-identical stdin) leaves silently; E3's
    // last_reply_hash stays what it was, the turn-hash of the recorded turn.
    if (!takeOnce(cfg.stateDir, cfg.workspace, "stop", raw)) {
      logEvent(cfg, { hook: "stop", event: "duplicate-run", ok: true, ms: Date.now() - t0 });
      process.exit(0);
    }
    let input: {
      transcript_path?: unknown;
      last_assistant_message?: unknown;
      session_id?: unknown;
      stop_hook_active?: unknown;
    } = {};
    try {
      input = JSON.parse(raw) as typeof input;
    } catch {
      // garbage stdin: nothing to record, nothing to say
      logEvent(cfg, { hook: "stop", event: "stdin-invalid", ok: false, ms: Date.now() - t0, error_class: "parse" });
      process.exit(0);
    }
    const client = createClient({
      url: cfg.url,
      workspace: cfg.workspace,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
    });
    const out = await recordReply(
      {
        ...(typeof input.transcript_path === "string" ? { transcript_path: input.transcript_path } : {}),
        ...(typeof input.last_assistant_message === "string" ? { last_assistant_message: input.last_assistant_message } : {}),
        ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
        ...(input.stop_hook_active === true ? { stop_hook_active: true } : {}),
      },
      cfg,
      { client, now: () => new Date().toISOString() },
    );
    // on the contained-exception and E3-dedupe paths recordReply already
    // wrote this run's single event; do not double-log it here
    if (!(out.action === "skipped" && (out.reason === "unexpected" || out.reason === "duplicate"))) {
      logEvent(cfg, {
        hook: "stop",
        event: out.action,
        ok: out.action === "sent",
        ms: Date.now() - t0,
        ...(out.action !== "skipped" ? { session: out.session, n_msgs: out.n_msgs } : {}),
        ...("routine" in out && out.routine === true ? { routine: 1 } : {}), // T21 (E5b)
        ...(out.action === "spooled" && out.error_class !== undefined
          ? { error_class: out.error_class }
          : {}),
      });
    }
  } catch {
    if (cfg !== null) {
      logEvent(cfg, { hook: "stop", event: "unexpected", ok: false, ms: Date.now() - t0, error_class: "other" });
    }
    // degrade to nothing (ADR-0001)
  }
  process.exit(0);
}

void main();
