// Server side of the Aseprite extension link: one authenticated WebSocket client at a time.
// Text frames carry plain JSON; a message with byte blobs travels as one binary frame (see wire.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "node:process";

import { WebSocketServer } from "ws";

import { PROTOCOL, encodeFrame, decodeFrame } from "./wire.ts";

export const MIN_EXTENSION = "0.1.0";
export const NOT_CONNECTED =
  "Aseprite is not connected: open File > Aseprite MCP... and press Connect";

const HELLO_DEADLINE_MS = 5000;
const CLOSE_REPLACED = 4000;
const CLOSE_NO_HELLO = 4001;
const CLOSE_DENIED = 4003;
const LONG_COMMANDS = new Set(["snapshot", "commit"]);
const MAX_PAYLOAD = 256 * 1024 * 1024;

/** @typedef {{ request(cmd: string, args?: object, blobs?: Uint8Array[]): Promise<{ result: any, blobs: Uint8Array[] }>,
 *              status(): { connected: boolean, extension: string | null, port: number, error: string | null } }} Link */

const mac = (token, text) =>
  createHmac("sha256", token).update(text).digest("hex");

function macMatches(expected, given) {
  if (typeof given !== "string") {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Dotted numbers compared part by part, so "0.10.0" > "0.9.0". Text that is not a version sorts lowest.
export function compareVersions(a, b) {
  const parse = (v) =>
    /^\d+(\.\d+)*$/.test(String(v)) ? String(v).split(".").map(Number) : null;
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    return pa ? 1 : pb ? -1 : 0;
  }
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) {
      return Math.sign(d);
    }
  }
  return 0;
}

/**
 * Listens on `host:port` for the extension. A busy port becomes a status error and a retry every
 * `retryMs`; it never throws, because a second daemon must not crash the first one's users.
 * @returns {Link & { listening: Promise<void>, close(): Promise<void> }}
 */
export function createLink({
  token,
  port = 9123,
  host = "127.0.0.1",
  timeoutMs = Number(env.ASEPRITE_MCP_TIMEOUT) || 15_000,
  longTimeoutMs = Math.max(60_000, timeoutMs),
  retryMs = 2000,
  autosaveDir = null,
  log = () => {},
}) {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("The pairing token must have at least 16 characters.");
  }

  let server = null;
  let boundPort = port;
  let retryTimer = null;
  let closed = false;
  let current = null;
  let extension = null;
  let error = null;
  let nextId = 1;
  const pending = new Map();
  let markListening;
  const listening = new Promise((resolve) => (markListening = resolve));

  function bind() {
    if (closed) {
      return;
    }
    const wss = new WebSocketServer({ host, maxPayload: MAX_PAYLOAD, port });
    wss.on("connection", onConnection);
    wss.once("listening", () => {
      server = wss;
      boundPort = wss.address().port;
      error = null;
      log(`Waiting for Aseprite on ws://${host}:${boundPort}`);
      markListening();
    });
    wss.on("error", (err) => {
      if (server === wss) {
        return log("Link server error:", err.message);
      }
      wss.close();
      error =
        err.code === "EADDRINUSE"
          ? `Port ${port} is busy; another aseprite-mcp daemon may own it. Retrying every ${retryMs / 1000} s.`
          : `Cannot listen on port ${port}: ${err.message}. Retrying.`;
      log(error);
      retryTimer = setTimeout(bind, retryMs);
    });
  }

  function onConnection(ws) {
    const challenge = randomBytes(16).toString("hex");
    let paired = false;
    const deadline = setTimeout(
      () => ws.close(CLOSE_NO_HELLO, "no hello"),
      HELLO_DEADLINE_MS
    );
    ws.once("close", () => {
      clearTimeout(deadline);
      for (const [key, entry] of pending) {
        if (entry.ws === ws)
          settle(key, (p) =>
            p.reject(new Error("Connection to Aseprite was lost."))
          );
      }
      if (current !== ws) {
        return;
      }
      current = null;
      extension = null;
      error = null;
    });
    ws.on("error", (err) => log("Extension socket error:", err.message));
    ws.on("message", (data, isBinary) => {
      try {
        if (paired) {
          return onReply(
            isBinary
              ? decodeFrame(data)
              : { msg: JSON.parse(data.toString()), blobs: [] }
          );
        }
        if (isBinary) {
          return deny(ws);
        }
        paired = pair(ws, JSON.parse(data.toString()), challenge, deadline);
      } catch (error) {
        log("Dropped a bad message:", error.message);
        if (!paired) {
          deny(ws);
        }
      }
    });
    ws.send(
      JSON.stringify({ nonce: challenge, type: "challenge", v: PROTOCOL })
    );
  }

  function deny(ws) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "denied" }));
    }
    ws.close(CLOSE_DENIED, "denied");
  }

  function pair(ws, hello, serverNonce, deadline) {
    const { nonce } = hello;
    const shapeOk =
      hello.type === "hello" &&
      hello.v === PROTOCOL &&
      typeof nonce === "string" &&
      nonce.length >= 16 &&
      nonce.length <= 128;
    if (
      !shapeOk ||
      !macMatches(mac(token, `client|${serverNonce}|${nonce}`), hello.mac)
    ) {
      deny(ws);
      return false;
    }
    clearTimeout(deadline);
    const previous = current;
    current = ws;
    extension = typeof hello.extension === "string" ? hello.extension : null;
    error =
      compareVersions(extension, MIN_EXTENSION) < 0
        ? `The Aseprite MCP extension (${extension ?? "unknown"}) is older than ${MIN_EXTENSION}. Install the current extension.`
        : null;
    ws.send(
      JSON.stringify({
        autosave: autosaveDir,
        mac: mac(token, `server|${nonce}|${serverNonce}`),
        type: "welcome",
      })
    );
    previous?.close(CLOSE_REPLACED, "replaced");
    log(
      `Aseprite ${hello.version ?? "?"} connected, extension ${extension ?? "?"}.`
    );
    return true;
  }

  function settle(id, fn) {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    fn(entry);
  }

  function onReply({ msg, blobs }) {
    settle(msg.id, (p) =>
      msg.ok
        ? p.resolve({ blobs, result: msg.result })
        : p.reject(
            new Error(String(msg.error ?? "Aseprite reported an error."))
          )
    );
  }

  function request(cmd, args = {}, blobs = []) {
    const ws = current;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(new Error(NOT_CONNECTED));
    }
    const id = nextId;
    nextId += 1;
    const ms = LONG_COMMANDS.has(cmd) ? longTimeoutMs : timeoutMs;
    return new Promise((onOk, onFail) => {
      const timer = setTimeout(
        () =>
          settle(id, (p) =>
            p.reject(new Error(`Timeout while running '${cmd}' (${ms} ms).`))
          ),
        ms
      );
      pending.set(id, { reject: onFail, resolve: onOk, timer, ws });
      const msg = { args, cmd, id };
      ws.send(
        blobs.length ? encodeFrame(msg, blobs) : JSON.stringify(msg),
        (err) => {
          if (err) {
            settle(id, (p) => p.reject(err));
          }
        }
      );
    });
  }

  async function close() {
    closed = true;
    clearTimeout(retryTimer);
    for (const client of server?.clients ?? []) {
      client.terminate();
    }
    if (server) {
      await new Promise((r) => server.close(() => r()));
    }
  }

  bind();
  return {
    close,
    listening,
    request,
    status: () => ({
      connected: current !== null,
      extension,
      port: boundPort,
      error,
    }),
  };
}
