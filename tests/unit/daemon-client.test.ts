// T16f: the daemon client (fetchOutbox / fetchQueueItem) and the pure
// outbox matcher. Fakes only - never the real daemon.

import { describe, expect, test } from "bun:test";
import {
  DAEMON_TIMEOUT_MS,
  fetchOutbox,
  fetchQueueItem,
  matchesOutboxEntry,
  type OutboxEntry,
} from "../../plugin/src/daemon.ts";
import { deadDaemonUrl, startFakeDaemon } from "../support/fake-daemon.ts";

const NOW = "2026-10-28T12:00:00.000Z";
const iso = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();

describe("fetchOutbox", () => {
  test("ok: the plain array is kept; entries without a string outboxId drop", async () => {
    const d = await startFakeDaemon({
      outbox: [
        { outboxId: "a", destinationSession: "s" },
        "junk",
        { destinationSession: "no-id" },
        null,
        7,
      ],
    });
    try {
      const r = await fetchOutbox(d.url, "arch@ws");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entries.map((e) => e.outboxId)).toEqual(["a"]);
    } finally {
      d.close();
    }
  });

  test("no-url: undefined and empty short-circuit before any fetch", async () => {
    expect(await fetchOutbox(undefined, "s@r")).toEqual({ ok: false, kind: "no-url" });
    expect(await fetchOutbox("", "s@r")).toEqual({ ok: false, kind: "no-url" });
  });

  test("http: 500 becomes kind http with the status", async () => {
    const d = await startFakeDaemon({ outbox: [], outboxStatus: 500 });
    try {
      expect(await fetchOutbox(d.url, "s@r")).toEqual({ ok: false, kind: "http", status: 500 });
    } finally {
      d.close();
    }
  });

  test("parse: an object instead of the array becomes kind parse", async () => {
    const d = await startFakeDaemon({ outbox: { items: [] } });
    try {
      expect(await fetchOutbox(d.url, "s@r")).toEqual({ ok: false, kind: "parse" });
    } finally {
      d.close();
    }
  });

  test("timeout: a reply slower than the budget aborts at ~1 s", async () => {
    const d = await startFakeDaemon({ delayMs: 1500 });
    try {
      const t0 = Date.now();
      const r = await fetchOutbox(d.url, "s@r");
      const elapsed = Date.now() - t0;
      expect(r).toEqual({ ok: false, kind: "timeout" });
      expect(DAEMON_TIMEOUT_MS).toBe(1000);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      d.close();
    }
  });

  test("network: a closed port becomes kind network", async () => {
    const url = await deadDaemonUrl();
    expect(await fetchOutbox(url, "s@r")).toEqual({ ok: false, kind: "network" });
  });
});

describe("fetchQueueItem", () => {
  test("ok: sourceSession kept, only string tags survive", async () => {
    const d = await startFakeDaemon({
      item: { sourceSession: "arch-x@ws", tags: ["build", "mission:deploy", 42, null] },
    });
    try {
      const r = await fetchQueueItem(d.url, "qitem-1");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.sourceSession).toBe("arch-x@ws");
        expect(r.tags).toEqual(["build", "mission:deploy"]);
      }
    } finally {
      d.close();
    }
  });

  test("ok: the empty document gives tags [] and no sourceSession key", async () => {
    const d = await startFakeDaemon({ item: {} });
    try {
      const r = await fetchQueueItem(d.url, "qitem-1");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.tags).toEqual([]);
        expect("sourceSession" in r).toBe(false);
      }
    } finally {
      d.close();
    }
  });

  test("http: 404 becomes kind http with the status", async () => {
    const d = await startFakeDaemon({ itemStatus: 404 });
    try {
      expect(await fetchQueueItem(d.url, "qitem-1")).toEqual({ ok: false, kind: "http", status: 404 });
    } finally {
      d.close();
    }
  });

  test("parse: a non-object body becomes kind parse", async () => {
    const d = await startFakeDaemon({ item: "nope" });
    try {
      expect(await fetchQueueItem(d.url, "qitem-1")).toEqual({ ok: false, kind: "parse" });
    } finally {
      d.close();
    }
  });

  test("no-url short-circuits", async () => {
    expect(await fetchQueueItem(undefined, "qitem-1")).toEqual({ ok: false, kind: "no-url" });
  });
});

describe("matchesOutboxEntry (pure)", () => {
  const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
    outboxId: "o1",
    destinationSession: "dev-build@rig-x",
    body: "hello there",
    tsDispatched: iso(-60_000),
    ...over,
  });

  test("exact body, fresh stamp: matches", () => {
    expect(matchesOutboxEntry(entry(), "dev-build@rig-x", "hello there", NOW)).toBe(true);
  });

  test("destination mismatch never matches", () => {
    expect(matchesOutboxEntry(entry(), "other@rig-x", "hello there", NOW)).toBe(false);
  });

  test("body mismatch: leading whitespace stays significant", () => {
    expect(matchesOutboxEntry({ ...entry(), body: "  hello there" }, "dev-build@rig-x", "hello there", NOW)).toBe(false);
    expect(matchesOutboxEntry(entry(), "dev-build@rig-x", "hello the", NOW)).toBe(false);
  });

  test("trailing whitespace trims on BOTH sides", () => {
    expect(matchesOutboxEntry({ ...entry(), body: "hello there  \n" }, "dev-build@rig-x", "hello there", NOW)).toBe(true);
    expect(matchesOutboxEntry(entry(), "dev-build@rig-x", "hello there\r\n", NOW)).toBe(true);
  });

  test("stamp window: exactly -10 min inclusive, older and future never", () => {
    expect(matchesOutboxEntry(entry({ tsDispatched: iso(-10 * 60_000) }), "dev-build@rig-x", "hello there", NOW)).toBe(true);
    expect(matchesOutboxEntry(entry({ tsDispatched: iso(-10 * 60_000 - 1) }), "dev-build@rig-x", "hello there", NOW)).toBe(false);
    expect(matchesOutboxEntry(entry({ tsDispatched: iso(+1) }), "dev-build@rig-x", "hello there", NOW)).toBe(false);
  });

  test("both stamp spellings are read; absent or garbage never matches", () => {
    const { tsDispatched, ...snake } = entry();
    void tsDispatched;
    expect(
      matchesOutboxEntry({ ...snake, ts_dispatched: iso(-60_000) }, "dev-build@rig-x", "hello there", NOW),
    ).toBe(true);
    expect(
      matchesOutboxEntry({ outboxId: "o1", destinationSession: "dev-build@rig-x", body: "hello there" }, "dev-build@rig-x", "hello there", NOW),
    ).toBe(false);
    expect(matchesOutboxEntry(entry({ tsDispatched: "yesterday" }), "dev-build@rig-x", "hello there", NOW)).toBe(false);
  });

  test("T22: deliveredAt is the window anchor when present; the stage stamp is not", () => {
    // A wake committed hours ago (stage time) and delivered just now: the
    // only honest match - tsDispatched alone would call every late wake
    // unverified (live probe 2026-11-05: a 207-minute stage-to-delivery gap).
    expect(
      matchesOutboxEntry(
        { ...entry(), tsDispatched: iso(-3 * 3_600_000), deliveredAt: iso(-60_000) },
        "dev-build@rig-x", "hello there", NOW,
      ),
    ).toBe(true);
    // A fresh send whose same bytes are re-typed an hour later (a repeated
    // delivery): the stale deliveredAt fails even though tsDispatched is new.
    expect(
      matchesOutboxEntry(
        { ...entry(), deliveredAt: iso(-60 * 60_000) },
        "dev-build@rig-x", "hello there", NOW,
      ),
    ).toBe(false);
    // A future deliveredAt never matches (no clock-skew grace), and garbage
    // in the anchor fails like a garbage stamp - it never falls back.
    expect(matchesOutboxEntry(entry({ deliveredAt: iso(+1) }), "dev-build@rig-x", "hello there", NOW)).toBe(false);
    expect(matchesOutboxEntry(entry({ deliveredAt: "yesterday" }), "dev-build@rig-x", "hello there", NOW)).toBe(false);
  });
});
