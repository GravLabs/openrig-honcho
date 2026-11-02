// T8d-2 item 2: a tiny TCP forwarder so the SOAK test can create a real
// outage on the REAL Honcho server without touching the server itself:
// hooks talk to 127.0.0.1:<port>, the forwarder pipes every byte to the
// target. "Outage" = this process stopped (connections get ECONNREFUSED -
// a genuine connect-failure, not a simulated status code); "recovery" =
// started again on the SAME port. Never imported by the plugin.
//
// Usage: bun tests/support/forwarder.ts [--port N] --target <host:port> [--log PATH]
// Prints "LISTENING <port>" once bound (port 0 -> the OS-picked port, which
// the caller then pins for restarts). --log tees every client->target byte
// to PATH (the soak asserts on the POST bodies that actually left). Exits on
// stdin "exit" or on signal.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = arg("target");
if (target === undefined || !target.includes(":")) {
  console.error("usage: forwarder.ts [--port N] --target <host:port>");
  process.exit(2);
}
const [tHost] = [target.slice(0, target.lastIndexOf(":"))];
const tPort = Number(target.slice(target.lastIndexOf(":") + 1));
if (!Number.isInteger(tPort) || tPort < 1 || tPort > 65535) {
  console.error("bad target port");
  process.exit(2);
}

interface Sink {
  write(d: Uint8Array | string): void;
  end(): void;
}
interface CliState {
  up: Sink | undefined;
  queue: Buffer[];
}
interface UpState {
  client: Sink;
}

import { appendFileSync } from "node:fs";

const logPath = arg("log");
const tee = (d: Uint8Array): void => {
  if (logPath !== undefined) {
    try {
      appendFileSync(logPath, d);
    } catch {
      /* capture is best-effort; forwarding is the job */
    }
  }
};

const listener = Bun.listen<UpState>({
  hostname: "127.0.0.1",
  port: arg("port") !== undefined ? Number(arg("port")) : 0,
  socket: {
    open(client) {
      const state: CliState = { up: undefined, queue: [] };
      (client as unknown as { soak: CliState }).soak = state;
      void Bun.connect<UpState>({
        hostname: tHost,
        port: tPort,
        socket: {
          open(up) {
            up.data = { client };
            state.up = up;
            for (const q of state.queue) up.write(q);
            state.queue.length = 0;
          },
          data(_up, d) {
            client.write(d);
          },
          close() {
            client.end();
          },
          error() {
            client.end();
          },
        },
      }).catch(() => {
        client.end(); // target down: the hook sees a closed connection = network error
      });
    },
    data(client, d) {
      tee(d); // request bytes toward the target
      const st = (client as unknown as { soak?: CliState }).soak;
      if (st === undefined) return;
      if (st.up !== undefined) st.up.write(d);
      else st.queue.push(Buffer.from(d)); // arrived before upstream opened
    },
    close(client) {
      (client as unknown as { soak?: CliState }).soak?.up?.end();
    },
    error(client) {
      (client as unknown as { soak?: CliState }).soak?.up?.end();
    },
  },
});

console.log(`LISTENING ${listener.port}`);

process.stdin.on("data", (c) => {
  if (String(c).includes("exit")) process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
