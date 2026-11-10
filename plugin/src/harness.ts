// C2 (ADR-0016): the harness seam. One place owns reading the hook's stdin,
// mapping it into the shared input the bins already use, and writing hook
// output. The harness is chosen EXPLICITLY by the hook command
// (`--harness codex`, default claude) and never guessed from input bytes.
// The Claude path stays byte-identical: same input handling, same output
// bytes, same log lines (probe C1 / codex-probe-c1.md is the evidence for
// every Codex rule encoded here).
export type Harness = "claude" | "codex";

export interface HarnessChoice {
  harness: Harness;
  /** The argv carried a `--harness` flag that did not resolve to a known
   * harness: missing or unknown value, or the `--harness=...` form (rejected
   * even for `=codex`, review F3's measured matrix). The bin logs exactly
   * one `harness-unknown` line and runs as claude - never a failed turn. */
  flagUnknown: boolean;
}

/** The FIRST `--harness` token decides: `codex` selects Codex, `claude` the
 * default, anything else is claude WITH the trace flag set. No token at all
 * is claude, silent. The installer (C5) passes the flag; nothing here ever
 * guesses the harness from input bytes. */
export function resolveHarness(argv: readonly string[]): HarnessChoice {
  const i = argv.findIndex((a) => a === "--harness" || a.startsWith("--harness="));
  if (i < 0) return { harness: "claude", flagUnknown: false };
  if (argv[i].startsWith("--harness=")) return { harness: "claude", flagUnknown: true };
  const value = argv[i + 1];
  if (value === "codex") return { harness: "codex", flagUnknown: false };
  if (value === "claude") return { harness: "claude", flagUnknown: false };
  return { harness: "claude", flagUnknown: true };
}

/** Read all of stdin, giving up after timeoutMs. Moved verbatim out of the
 * four hook bins (they must not duplicate it). */
export async function readStdin(timeoutMs: number): Promise<string> {
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

/** The one hook stdout line (probe C1 §1-2): Codex DROPS output whose
 * hookSpecificOutput lacks hookEventName, silently - so it is always here.
 * Byte-identical to what the bins printed before the seam existed. */
export function writeHookJson(
  hookEventName: "SessionStart" | "UserPromptSubmit",
  additionalContext: string,
): void {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`,
  );
}

/** Codex SessionStart may report source "fork" - it behaves as "resume"
 * (ADR-0016 decision 3). Every other value, and every Claude value, passes
 * through unchanged for the bin's own SOURCES check. */
export function sessionStartSource(harness: Harness, source: unknown): unknown {
  return harness === "codex" && source === "fork" ? "resume" : source;
}

/** Codex Stop: the reply is `last_assistant_message` - the rollout
 * transcript is NOT Claude-shaped, so it must never be the reply source
 * (ADR-0016 decision 3, probe C1 §1/§5). Dropping the path here leaves the
 * existing writer fallback (message text) as the only source. Claude: the
 * input passes through untouched - the transcript keeps its priority. */
export function stopHookInput<T extends { transcript_path?: unknown }>(
  harness: Harness,
  input: T,
): T {
  if (harness !== "codex") return input;
  const { transcript_path: _dropped, ...rest } = input;
  return rest as T;
}
