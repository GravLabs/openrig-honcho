// Stop hook (T6b): read the stdin JSON {session_id, transcript_path,
// last_assistant_message, stop_hook_active}, evaluate the env contract, run
// the reply writer. Same silence rules as user-prompt.ts: the kill switch
// exits 0 without logging, other config problems are logged not printed, and
// the hook NEVER writes stdout or stderr (ADR-0001 hook table, S1).
import type { Config } from "../src/env.ts";
import { isKillSwitch, loadConfig } from "../src/env.ts";
import { createClient } from "../src/honcho.ts";
import { bindEventFields, logConfigProblem, logEvent } from "../src/log.ts";
import { takeOnce } from "../src/once.ts";
import { recordReply } from "../src/stop.ts";
// C2 (ADR-0016): shared stdin seam; Codex Stop records last_assistant_message
// and never reads the (non-Claude-shaped) transcript - stopHookInput drops
// the path for codex only.
import { readStdin, resolveHarness, stopHookInput } from "../src/harness.ts";
import { harnessUnknownWithSettings, readSettingsFile } from "../src/settings.ts";

async function main(): Promise<void> {
  const t0 = Date.now();
  const { harness, flagUnknown } = resolveHarness(process.argv.slice(2));
  // C2c (review F4): run-level flags ride this run's ONE event line (bound
  // here, before any log call), never a line of their own. Names only.
  if (flagUnknown) bindEventFields({ harness_unknown: 1 });
  // O1: exactly one structured event per hook run (see user-prompt.ts)
  let cfg: Config | null = null;
  try {
    const raw = await readStdin(2000);
    // C5a (ADR-0016 decision 9): settings file under the environment (see
    // session-start.ts); a broken file = plugin off for this run, exit 0.
    let env: Record<string, string | undefined> = process.env;
    if (harness === "codex") {
      const s = readSettingsFile(process.argv.slice(2));
      if (s.problem !== null) {
        logConfigProblem(process.env, "Stop", s.problem);
        process.exit(0);
      }
      env = { ...s.vars, ...process.env };
    }
    // C5a2 (review O2): an unresolved --harness next to --settings IS the
    // cause; name it instead of blaming the missing URL.
    const harnessProblem = harnessUnknownWithSettings(process.argv.slice(2), flagUnknown);
    if (harnessProblem !== null) {
      logConfigProblem(process.env, "Stop", harnessProblem);
      process.exit(0);
    }
    const loaded = loadConfig(env);
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
    let parsed: {
      transcript_path?: unknown;
      last_assistant_message?: unknown;
      session_id?: unknown;
      stop_hook_active?: unknown;
      // C2b (review F1): Codex's own turn identity; forwarded to the writer
      // ONLY under --harness codex (Claude's E3 hash stays transcript-only).
      turn_id?: unknown;
    } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // garbage stdin: nothing to record, nothing to say
      if (harness === "codex") bindEventFields({ no_turn_id: 1 }); // unparseable: no turn_id could be usable
      logEvent(cfg, { hook: "stop", event: "stdin-invalid", ok: false, ms: Date.now() - t0, error_class: "parse" });
      process.exit(0);
    }
    // C2c (review F4, C5 note): a Codex Stop without a usable turn_id falls
    // back to the text-only E3 token - make that visible on this run's line.
    if (harness === "codex" && !(typeof parsed.turn_id === "string" && parsed.turn_id !== "")) {
      bindEventFields({ no_turn_id: 1 });
    }
    // C2 (ADR-0016): Codex gets no transcript_path - the reply can then only
    // come from last_assistant_message. Claude input is byte-for-byte as before.
    const input = stopHookInput(harness, parsed);
    // F11 (C5f): Codex Stop runs SYNC with a 30 s hook timeout
    // (codexHookGroups), but HONCHO_TIMEOUT_MS bounds each REQUEST, and one
    // Stop makes sequential requests - 20000 measured 40 s, 60000 measured
    // 120 s, so Codex killed the hook mid-write. Under --harness codex the
    // whole Stop now has one 20 s budget: every network call may use only
    // what is left of it (minus a small exit headroom), so an exhausted
    // budget fails exactly like a dead server and recordBody spools. The
    // client re-reads timeoutMs per request, so a getter IS the whole
    // clamp. Claude's shape is byte-identical to before. The one event line
    // counts the requests the budget ACTUALLY CUT SHORT (budget_cut): a
    // reduced timeout is not a cut - review F14, case b4, showed a healthy
    // run at HONCHO_TIMEOUT_MS 20000 (two 4 s answers, wall 8 s) reporting
    // clamps because the budget had merely reduced the timeouts. A cut is
    // only real when the request fails on that reduced timeout, so the
    // count rides the client's onTimeout observation: used < cfg.timeoutMs
    // can only be the budget's doing (nothing else goes below the config).
    const CODEX_STOP_BUDGET_MS = 20_000;
    const CODEX_STOP_EXIT_HEADROOM_MS = 500;
    const deadlineAt = t0 + CODEX_STOP_BUDGET_MS;
    let budgetCut = 0;
    // NOTE: two literals, NOT a spread of one options object - an object
    // spread EVALUATES the getter once and freezes the result, which is
    // exactly the bug that measured 39 s here (both requests got the first
    // clamp). The getter must stay a getter on the object createClient sees.
    const client = createClient(
      harness === "codex"
        ? {
            url: cfg.url,
            workspace: cfg.workspace,
            apiKey: cfg.apiKey,
            get timeoutMs(): number {
              const left = deadlineAt - CODEX_STOP_EXIT_HEADROOM_MS - Date.now();
              return left >= cfg.timeoutMs ? cfg.timeoutMs : Math.max(left, 1);
            },
            onTimeout: (used: number) => {
              if (used < cfg.timeoutMs) budgetCut += 1;
            },
          }
        : { url: cfg.url, workspace: cfg.workspace, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs },
    );
    const out = await recordReply(
      {
        ...(typeof input.transcript_path === "string" ? { transcript_path: input.transcript_path } : {}),
        ...(typeof input.last_assistant_message === "string" ? { last_assistant_message: input.last_assistant_message } : {}),
        ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
        ...(input.stop_hook_active === true ? { stop_hook_active: true } : {}),
        ...(harness === "codex" && typeof input.turn_id === "string" && input.turn_id !== "" ? { turn_id: input.turn_id } : {}),
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
        // F11 + F14: the codex run's one line names its budget and counts
        // the requests that FAILED on a budget-reduced timeout (budget_cut;
        // 0 = nothing the budget touched ever failed - reductions that
        // still answered are health, not cuts).
        ...(harness === "codex" ? { stop_budget_ms: CODEX_STOP_BUDGET_MS, budget_cut: budgetCut } : {}),
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
