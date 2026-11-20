// Wisp relay tuned for a Raspberry Pi's small RAM.
//
// We use wisp-js for the protocol, DNS and the private-IP filter, but replace
// two things that are tuned for big servers:
//
//  * wisp-js lets up to 32 MB pile up per browser WebSocket, plus up to 128
//    chunks (~8 MB) per destination connection, whenever the browser reads more
//    slowly than the Pi can download. One user watching a video on a slow
//    network could pin 150+ MB. Here a full buffer simply pauses reading from
//    the website (normal TCP flow control), so memory stays small and flat.
//  * wisp-js drops data still queued when a website closes its connection,
//    which can cut off the end of a download on slow links. LeanTCPSocket
//    delivers everything before reporting the close.
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { server as wisp, logging, packet } from "@mercuryworkshop/wisp-js/server";

/** Max bytes waiting to be sent to one browser before we stop reading from websites. */
const WS_SEND_BUFFER = 4 * 1024 * 1024;
/** Max chunks (each <= 64 KB) queued per website connection before pausing it. */
const STREAM_QUEUE = 16;
/** WebSocket keepalive, so school/office proxies don't drop the "idle" connection. */
const PING_INTERVAL = 20;

class LeanTCPSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
    this.socket = null;
    this.queue = [];
    this.waiter = null;
    this.ended = false;
    this.paused = false;
  }

  // wisp-js has already resolved the hostname and checked it against the
  // filters (private/loopback IPs, blocklist) before calling this.
  connect(ip) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: ip ?? this.hostname, port: this.port });
      let connected = false;
      socket.setNoDelay(true);
      // Don't let unreachable hosts tie up a socket for minutes.
      socket.setTimeout(15000, () => socket.destroy(new Error("connect timeout")));
      socket.once("connect", () => {
        connected = true;
        socket.setTimeout(0);
        this.socket = socket;
        resolve();
      });
      socket.on("data", (chunk) => {
        this.queue.push(chunk);
        if (this.queue.length >= STREAM_QUEUE && !this.paused) {
          socket.pause();
          this.paused = true;
        }
        this.wake();
      });
      socket.on("error", (err) => {
        if (!connected) reject(err);
        else logging.debug(`tcp stream to ${this.hostname} ended with error - ${err}`);
      });
      socket.on("close", () => {
        this.ended = true;
        this.socket = null;
        if (!connected) reject(new Error("connection closed"));
        this.wake();
      });
    });
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  async recv() {
    for (;;) {
      if (this.queue.length) {
        const chunk = this.queue.shift();
        if (this.paused && this.queue.length === 0 && this.socket) {
          this.socket.resume();
          this.paused = false;
        }
        return chunk;
      }
      if (this.ended) return null; // only after the queue is fully drained
      await new Promise((resolve) => (this.waiter = resolve));
    }
  }

  send(data) {
    return new Promise((resolve) => {
      if (!this.socket) return resolve();
      this.socket.write(data, () => resolve());
    });
  }

  async close() {
    if (!this.socket) return;
    this.socket.end();
    this.socket = null;
  }

  // Flow control is handled in recv(); wisp-js calls these around each send.
  pause() {}
  resume() {}
}

// ---------------------------------------------------------------------------
// Faster website -> browser path.
//
// Profiling showed ~40% of the relay's CPU went into wisp-js building each data
// packet: it copies every chunk twice (into a Uint8Array, then into the
// serialised packet) and allocates several wrapper objects, which the garbage
// collector then has to clean up. We write the 5-byte Wisp header and copy the
// payload exactly once. Only applied to the wisp-js version this was written
// and tested against; any other version keeps the stock code.
// ---------------------------------------------------------------------------
const TESTED_WISP_VERSION = "0.5.3";
const DATA = packet.DataPayload.type;
const CLOSE_VOLUNTARY = packet.close_reasons.Voluntary;

async function fastTcpToWs() {
  const out = this.conn.ws; // wisp-js AsyncWebSocket (handles backpressure)
  for (;;) {
    const chunk = await this.socket.recv();
    if (chunk == null) break;
    const frame = Buffer.allocUnsafe(5 + chunk.length);
    frame[0] = DATA;
    frame.writeUInt32LE(this.stream_id, 1);
    chunk.copy(frame, 5);
    await out.send(frame);
  }
  await this.conn.close_stream(this.stream_id, CLOSE_VOLUNTARY);
}

try {
  const pkg = new URL("../../package.json", import.meta.resolve("@mercuryworkshop/wisp-js/server"));
  const version = JSON.parse(readFileSync(fileURLToPath(pkg), "utf8")).version;
  if (version === TESTED_WISP_VERSION && typeof wisp.ServerStream.prototype.tcp_to_ws === "function") {
    wisp.ServerStream.prototype.tcp_to_ws = fastTcpToWs;
  } else {
    console.warn(`[relay] wisp-js ${version} != ${TESTED_WISP_VERSION}: using its stock (slower) data path`);
  }
} catch (err) {
  console.warn("[relay] could not check wisp-js version, using stock data path:", err.message);
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

/** Handle an HTTP upgrade on /wisp/. */
export function handleWisp(req, socket, head) {
  const version = req.headers["sec-websocket-protocol"] && wisp.options.wisp_version === 2 ? 2 : 1;
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const conn = new wisp.ServerConnection(ws, req.url, {
      TCPSocket: LeanTCPSocket,
      ping_interval: PING_INTERVAL,
      wisp_version: version,
    });
    conn.ws.send_buffer_size = WS_SEND_BUFFER;
    try {
      await conn.setup();
      await conn.run();
    } catch (err) {
      ws.close();
      logging.debug("wisp connection ended: " + (err && err.message));
    }
  });
}
