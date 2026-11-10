// C5c (ADR-0016 decision 7): the exact key and trusted_hash Codex matches
// hooks against, reimplemented from the Codex source at tag rust-v0.167.0
// (openai/codex, codex-rs). The installer records trust for OUR OWN hooks in
// the user layer config; Codex treats trust as exact string equality, so
// every byte of this recipe must match the Rust original. Citations are to
// files under codex-rs/ at that tag.
//
// Key:   {hooks.json abs path}:{event_snake}:{group_index}:{handler_index}
//        hooks/src/lib.rs:125-135 (hook_key), event labels lib.rs:105-122.
// Hash:  sha256 over the compact, key-sorted JSON of the TOML serialization
//        of the normalized identity { event_name, matcher?, hooks:[handler] }
//        (hooks/src/engine/discovery.rs:974-998 NormalizedHookIdentity +
//        hook_hash; config/src/fingerprint.rs:54-66 version_for_toml).
//        Handler fields: protocol/src/hooks.rs:140-172 (MatcherGroup +
//        HookHandlerConfig serde shapes); normalization:
//        discovery.rs:704-727 (env ${VAR} substitution - we use none; the
//        default additionalContextLimit is dropped) and discovery.rs:940-968
//        (timeout: SessionEnd/Interrupt default 1 clamp [1,3]; every other
//        event default 600, floor 1).
// Trust: [hooks.state."<key>"].trusted_hash == that hash, string equality;
//        state is read ONLY from the user and session-flag layers
//        (hooks/src/config_rules.rs:8-35), so it belongs in
//        $CODEX_HOME/config.toml. Untrusted hooks are skipped silently by
//        a codex exec run (discovery.rs:1000-1017 + the Trusted-only push).

import { createHash } from "node:crypto";

/** Event name -> the snake_case label Codex uses in persisted keys and in
 * the identity's event_name field (hooks/src/lib.rs:105-122). */
const EVENT_LABELS: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  PreModelRequest: "pre_model_request",
  PostModelRequest: "post_model_request",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};

/** null for an event Codex does not know (our caller only passes its own). */
export function codexEventLabel(event: string): string | null {
  return EVENT_LABELS[event] ?? null;
}

/** Persisted state key for one handler (hooks/src/lib.rs:125-135). */
export function codexHookKey(
  hooksJsonAbs: string,
  event: string,
  groupIndex: number,
  handlerIndex: number,
): string {
  const label = codexEventLabel(event);
  if (label === null) throw new Error(`unknown hook event: ${event}`);
  return `${hooksJsonAbs}:${label}:${groupIndex}:${handlerIndex}`;
}

/** Timeout normalization at discovery (discovery.rs:940-968): SessionEnd and
 * Interrupt default to 1 and clamp to [1,3]; everything else defaults to 600
 * with a floor of 1 and no cap. */
export function codexNormalizedTimeout(event: string, given: number | undefined): number {
  if (event === "SessionEnd" || event === "Interrupt") {
    const t = given ?? 1;
    return Math.min(Math.max(t, 1), 3);
  }
  return Math.max(given ?? 600, 1);
}

export interface CodexHandlerIdentity {
  command: string;
  timeoutSec: number; // already normalized
  async: boolean;
}

/**
 * version_for_toml (config/src/fingerprint.rs:54-66): TOML value -> JSON
 * with every object's keys sorted, compact serde_json serialization, sha256,
 * reported as sha256:<hex>. JSON.stringify is byte-identical to
 * serde_json::to_vec for our values (integers, booleans, ASCII and UTF-8
 * strings, arrays; both escape only quote, backslash and control characters
 * and both leave other UTF-8 raw; keys arrive pre-sorted).
 */
export function versionForToml(value: unknown): string {
  const json = JSON.stringify(sortKeys(value));
  return `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * trusted_hash for one command handler of a hooks.json file
 * (discovery.rs:981-998): the identity is the event label plus the matcher
 * group carrying EXACTLY this one normalized handler. matcher === null means
 * the group has no matcher, which TOML serialization drops entirely (the key
 * is absent, not null). commandWindows/statusMessage/additionalContextLimit
 * are None for everything we write, so they are absent too.
 */
export function codexTrustedHash(
  event: string,
  matcher: string | null,
  handler: CodexHandlerIdentity,
): string {
  const label = codexEventLabel(event);
  if (label === null) throw new Error(`unknown hook event: ${event}`);
  const identity: Record<string, unknown> = {
    event_name: label,
    hooks: [
      {
        async: handler.async,
        command: handler.command,
        timeout: handler.timeoutSec,
        type: "command",
      },
    ],
  };
  if (matcher !== null) identity.matcher = matcher;
  return versionForToml(identity);
}
