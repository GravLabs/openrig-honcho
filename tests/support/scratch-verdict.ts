// F5 (review R14 O3): the ONE verdict for "a scratch workspace we made is
// still listed when the light disappearance window ends". The server's
// purge is async (10-70 min under load): the gate's leftovers step already
// passes this state as "accepted deletes pending purge" and release.ts
// refuses while any scratch is still listed, so the light polls must reach
// the SAME verdict on the SAME fact - one slow purge is not both a pass
// (gate) and a failure (integration tier). Pure: no IO, no clock, no fetch.

export type ScratchVerdict =
  | { kind: "disappeared"; line: string }
  | { kind: "pending"; names: string[]; line: string };

/**
 * still            - our names still listed when the window ended (empty = gone)
 * windowMs         - the window that was spent (for the honest message)
 * deleteAccepted   - the CALLER's record of an accepted DELETE (2xx/404) per
 *                    name - the same fact recordGateDeletes writes for the
 *                    gate, never a second acceptance mechanism
 * elapsedMs        - time since the poll opened
 * Throws when a still-listed name had NO accepted DELETE: that name is our
 * failure, not the server's lag.
 */
export function scratchDisappearVerdict(
  still: string[],
  windowMs: number,
  deleteAccepted: (name: string) => boolean,
  elapsedMs: number,
): ScratchVerdict {
  if (still.length === 0) {
    return { kind: "disappeared", line: `scratch cleanup: disappeared in ${Math.round(elapsedMs / 1000)} s` };
  }
  const unaccepted = still.filter((n) => !deleteAccepted(n));
  if (unaccepted.length > 0) {
    throw new Error(
      `scratch cleanup: still listed after ${Math.round(windowMs / 1000)} s with NO accepted DELETE: ${unaccepted.join(", ")}`,
    );
  }
  return {
    kind: "pending",
    names: still,
    line:
      `scratch cleanup: ${still.length} accepted deletes pending purge ` +
      `(still listed after ${Math.round(windowMs / 1000)} s): ${still.join(", ")} - ` +
      `the gate leftovers step and release.ts stay the backstop`,
  };
}
