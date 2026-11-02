// Parser for the OpenRig pane envelope (ADR-0003). Ground truth:
// @openrig/cli daemon dist/lib/pane-envelope.js wrapPaneEnvelope:
//   From: <sender>
//   To: <recipient | a, b | broadcast to <rig> (<n> seats) | broadcast to topology>
//   Sent: MM-DD HH:MMZ[ · gen <8hex>][ · delivered +<n>s]   (optional line)
//   ---
//   <body>
//   ---
//   ↩ <reply hint>
// Well-formed envelopes only; anything else is null (a malformed pseudo-header
// must not be trusted as a header - ADR-0003). Never throws.

export type To = string[] | { broadcast: string };

export interface Envelope {
  from: string;
  to: To;
  /** Raw `Sent:` line content, e.g. "10-28 04:12Z · gen 1a2b3c4d · delivered +12s". */
  sent?: string;
  body: string;
  /** Seats count from a `broadcast to <rig> (<n> seats)` To-line, when present. */
  fanout?: number;
}

function parseTo(value: string): To | null {
  if (value.startsWith("broadcast to ")) {
    const rest = value.slice("broadcast to ".length).trim();
    if (rest === "") return null;
    const m = /^(.*) \((\d+) seats\)$/.exec(rest);
    if (m) return { broadcast: m[1] };
    return { broadcast: rest };
  }
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.length > 0 ? parts : null;
}

function broadcastSeats(value: string): number | undefined {
  if (!value.startsWith("broadcast to ")) return undefined;
  const m = / \((\d+) seats\)$/.exec(value);
  return m ? Number(m[1]) : undefined;
}

export function parseEnvelope(text: string): (Envelope & { fanout?: number }) | null {
  try {
    if (typeof text !== "string" || text === "") return null;

    // The closing separator is the LAST "\n---\n↩", so a body containing
    // `---` lines (or a quoted envelope) still parses.
    const closeIdx = text.lastIndexOf("\n---\n↩");
    if (closeIdx === -1) return null;

    const headerEnd = text.indexOf("\n---\n");
    if (headerEnd === -1 || headerEnd >= closeIdx) return null;

    const lines = text.slice(0, headerEnd).split("\n");
    if (lines.length < 2 || lines.length > 3) return null;
    if (!lines[0].startsWith("From: ")) return null;
    if (!lines[1].startsWith("To: ")) return null;

    let sent: string | undefined;
    if (lines.length === 3) {
      if (!lines[2].startsWith("Sent: ")) return null;
      sent = lines[2].slice("Sent: ".length);
    }

    const toLine = lines[1].slice("To: ".length);
    const to = parseTo(toLine);
    if (to === null) return null;

    const body = text.slice(headerEnd + "\n---\n".length, closeIdx);

    // An empty or whitespace-only sender is a malformed pseudo-header, not an
    // envelope: a peer id of "" would be a garbage identity in shared memory
    // (review T3, F-2). The caller then falls through to automation/owner.
    const from = lines[0].slice("From: ".length);
    if (from.trim() === "") return null;

    const env: Envelope & { fanout?: number } = {
      from,
      to,
      body,
    };
    if (sent !== undefined) env.sent = sent;
    const seats = broadcastSeats(toLine);
    if (seats !== undefined) env.fanout = seats;
    return env;
  } catch {
    return null;
  }
}
