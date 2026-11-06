// T19c (ADR-0014 decision 4, row item 6): the added in-hook time of the
// novelty read+scan on a 1 MB fixture transcript, median of 20 runs,
// budget < 20 ms. Measures the REAL hook functions (terms.ts
// readTranscriptTail + knownTermsFromTranscript) on a realistic Claude
// JSONL fixture of just over 1 MB; the fixture is built in a temp dir
// and removed here (nothing committed). In-process timing: the hook runs
// the same two calls synchronously while its queries are in flight.
//
// Usage: bun run scripts/bench-novelty.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownTermsFromTranscript, readTranscriptTail } from "../plugin/src/terms.ts";

const RUNS = 20;

const topic = (i: number): string =>
  `note ${i}: the calibration drone reported ${["drift", "margin", "torque", "latency"][i % 4]} ` +
  `against the ${["gateway", "antenna", "sensor", "beacon"][i % 4]} schedule at ${10 + (i % 88)} percent ` +
  `while the relay kept retrying the uplink frame every few seconds.`;

function buildFixture(): { path: string; bytes: number } {
  const dir = mkdtempSync(join(tmpdir(), "novelty-bench-"));
  const path = join(dir, "transcript.jsonl");
  const lines: string[] = [];
  let bytes = 0;
  let i = 0;
  const type = (n: number): "user" | "assistant" => (n % 3 === 0 ? "user" : "assistant");
  while (bytes < 1_025_000) {
    const line = JSON.stringify({
      type: type(i),
      message: { content: [{ type: "text", text: topic(i) }] },
      timestamp: new Date(Date.now() - (2000 - i) * 1000).toISOString(),
    });
    lines.push(line);
    bytes += Buffer.byteLength(line) + 1;
    i++;
  }
  writeFileSync(path, lines.join("\n") + "\n");
  const out = { path, bytes };
  pendingDirs.push(dir);
  return out;
}

const pendingDirs: string[] = [];

const main = (): void => {
  const { path, bytes } = buildFixture();
  try {
    const incoming = "Did the zephyrium retune land? Filing the kettleboard shipment slip now.";
    const samples: number[] = [];
    let knownSize = 0;
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      const tail = readTranscriptTail(path);
      const known = knownTermsFromTranscript(tail ?? "", incoming);
      samples.push(performance.now() - t0);
      knownSize = known.size;
    }
    samples.sort((a, b) => a - b);
    const median = (samples[Math.floor((RUNS - 1) / 2)] + samples[Math.ceil((RUNS - 1) / 2)]) / 2;
    console.log(
      JSON.stringify({
        runs: RUNS,
        fixtureBytes: bytes,
        knownTerms: knownSize,
        medianMs: Number(median.toFixed(2)),
        minMs: Number(samples[0].toFixed(2)),
        maxMs: Number(samples[RUNS - 1].toFixed(2)),
        budgetMs: 20,
        withinBudget: median < 20,
      }),
    );
  } finally {
    for (const d of pendingDirs) rmSync(d, { recursive: true, force: true });
  }
};

main();
