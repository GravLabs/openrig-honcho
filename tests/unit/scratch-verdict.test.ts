// F5 (review R14 O3): ONE verdict for "a scratch workspace is still listed
// after the light poll window". An accepted DELETE pending purge PASSES,
// exactly as the gate's leftovers step passes it ("accepted deletes pending
// purge"); a still-listed name WITHOUT an accepted DELETE still throws, and
// release.ts stays the release backstop. Pure helper - no server here.

import { describe, expect, test } from "bun:test";
import { scratchDisappearVerdict } from "../support/scratch-verdict.ts";

const WINDOW = 900_000;

describe("scratchDisappearVerdict (F5: the gate's rule, one fact)", () => {
  test("all gone: pass, with the elapsed purge time in seconds on the line", () => {
    const v = scratchDisappearVerdict([], WINDOW, () => false, 42_000);
    expect(v.kind).toBe("disappeared");
    expect(v.line).toContain("42 s");
  });

  test("window over, every still-listed DELETE accepted: PASS, pending line names them", () => {
    const v = scratchDisappearVerdict(["ws-a", "ws-b"], WINDOW, () => true, WINDOW);
    expect(v.kind).toBe("pending");
    if (v.kind !== "pending") throw new Error("unreachable: narrows the union"); // names exist only on pending
    expect(v.names).toEqual(["ws-a", "ws-b"]);
    expect(v.line).toContain("accepted deletes pending purge");
    expect(v.line).toContain("ws-a");
    expect(v.line).toContain("ws-b");
    expect(v.line).toContain("900 s");
  });

  test("window over with a still-listed name that had NO accepted DELETE: throws naming it alone", () => {
    let msg = "";
    try {
      scratchDisappearVerdict(["ws-a", "ws-b"], WINDOW, (n) => n === "ws-a", WINDOW);
      expect.unreachable("must throw");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("ws-b"); // the unaccepted one is the failure
    expect(msg).not.toContain("ws-a"); // ws-a is only purge-pending
    expect(msg).toContain("900 s");
  });

  test("window over, nothing accepted: throws naming every still-listed name", () => {
    expect(() => scratchDisappearVerdict(["x", "y"], WINDOW, () => false, WINDOW)).toThrow(/x, y/);
  });
});
