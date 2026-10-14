// Server side of the Aseprite extension link: one authenticated WebSocket client at a time.
// Text frames carry plain JSON; a message with byte blobs travels as one binary frame (see wire.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { env } from "node:process";

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

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

export interface LinkReply<T = unknown> {
  result: T;
  blobs: Uint8Array[];
}

export interface LinkStatus {
  connected: boolean;
  extension: string | null;
  port: number;
  error: string | null;
}

export interface Link {
  request: <T = unknown>(
    cmd: string,
    args?: object,
    blobs?: Uint8Array[]
  ) => Promise<LinkReply<T>>;
  status: () => LinkStatus;
}

export interface LinkServer extends Link {
  listening: Promise<boolean>;
  close: () => Promise<void>;
}

export interface LinkOptions {
  token: string;
  port?: number;
  host?: string;
  timeoutMs?: number;
  longTimeoutMs?: number;
  retryMs?: number;
  autosaveDir?: string | null;
  log?: (...args: unknown[]) => void;
}

interface Pending {
  resolve: (reply: LinkReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  ws: WebSocket;
}

const mac = (token: string, text: string): string =>
  createHmac("sha256", token).update(text).digest("hex");

const macMatches = (expected: string, given: unknown): boolean => {
  if (typeof given !== "string") {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

const parseVersion = (v: unknown): number[] | null =>
  /^\d+(?:\.\d+)*$/u.test(String(v)) ? String(v).split(".").map(Number) : null;

// Dotted numbers compared part by part, so "0.10.0" > "0.9.0". Text that is not a version sorts lowest.
export const compareVersions = (a: unknown, b: unknown): number => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!(pa && pb)) {
    if (pa) {
      return 1;
    }
    return pb ? -1 : 0;
  }
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) {
      return Math.sign(d);
    }
  }
  return 0;
};

interface Reply {
  id: number;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
}

const isReply = (msg: unknown): msg is Reply =>
  typeof msg === "object" && msg !== null && typeof (msg as { id?: unknown }).id === "number";

interface Hello {
  type?: unknown;
  v?: unknown;
  nonce?: unknown;
  mac?: unknown;
  extension?: unknown;
  version?: unknown;
}

const deny = (ws: WebSocket): void => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "denied" }));
  }
  ws.close(CLOSE_DENIED, "denied");
};

const messageText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Listens on `host:port` for the extension. A busy port becomes a status error and a retry every
 * `retryMs`; it never throws, because a second daemon must not crash the first one's users.
 */
export const createLink = ({
  token,
  port = 9123,
  host = "127.0.0.1",
  timeoutMs = Number(env.ASEPRITE_MCP_TIMEOUT) || 15_000,
  longTimeoutMs = Math.max(60_000, timeoutMs),
  retryMs = 2000,
  autosaveDir = null,
  log,
}: LinkOptions): LinkServer => {
  if (typeof token !== "string" || token.length < 16) {
    throw new Error("The pairing token must have at least 16 characters.");
  }

  let server: WebSocketServer | null = null;
  let boundPort = port;
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let current: WebSocket | null = null;
  let extension: string | null = null;
  let error: string | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const { promise: listening, resolve: markListening } =
    Promise.withResolvers<boolean>();

  const settle = (id: number, fn: (entry: Pending) => void): void => {
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    fn(entry);
  };

  const onReply = ({ msg, blobs }: { msg: unknown; blobs: Uint8Array[] }): void => {
    if (!isReply(msg)) {
      log?.("Dropped a reply without a numeric id from Aseprite.");
      return;
    }
    settle(msg.id, (p) =>
      msg.ok
        ? p.resolve({ blobs, result: msg.result })
        : p.reject(
            new Error(String(msg.error ?? "Aseprite reported an error."))
          )
    );
  };

  const pair = (
    ws: WebSocket,
    hello: Hello,
    serverNonce: string,
    deadline: NodeJS.Timeout
  ): boolean => {
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
    log?.(
      `Aseprite ${hello.version ?? "?"} connected, extension ${extension ?? "?"}.`
    );
    return true;
  };

  const onConnection = (ws: WebSocket): void => {
    const challenge = randomBytes(16).toString("hex");
    let paired = false;
    const deadline = setTimeout(
      () => ws.close(CLOSE_NO_HELLO, "no hello"),
      HELLO_DEADLINE_MS
    );
    ws.once("close", () => {
      clearTimeout(deadline);
      for (const [key, entry] of pending) {
        if (entry.ws === ws) {
          settle(key, (p) =>
            p.reject(new Error("Connection to Aseprite was lost."))
          );
        }
      }
      if (current !== ws) {
        return;
      }
      current = null;
      extension = null;
      error = null;
    });
    ws.on("error", (socketError: Error) =>
      log?.("Extension socket error:", socketError.message)
    );
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      try {
        if (paired) {
          return onReply(
            isBinary
              ? decodeFrame(data)
              : { blobs: [], msg: JSON.parse(data.toString()) }
          );
        }
        if (isBinary) {
          return deny(ws);
        }
        paired = pair(ws, JSON.parse(data.toString()), challenge, deadline);
      } catch (messageError) {
        log?.("Dropped a bad message:", messageText(messageError));
        if (!paired) {
          deny(ws);
        }
      }
    });
    ws.send(
      JSON.stringify({ nonce: challenge, type: "challenge", v: PROTOCOL })
    );
  };

  const bind = (): void => {
    if (closed) {
      return;
    }
    const wss = new WebSocketServer({ host, maxPayload: MAX_PAYLOAD, port });
    wss.on("connection", onConnection);
    wss.once("listening", () => {
      server = wss;
      const address = wss.address();
      boundPort = typeof address === "object" && address ? address.port : port;
      error = null;
      log?.(`Waiting for Aseprite on ws://${host}:${boundPort}`);
      markListening(true);
    });
    wss.on("error", (listenError: NodeJS.ErrnoException) => {
      if (server === wss) {
        return log?.("Link server error:", listenError.message);
      }
      wss.close();
      error =
        listenError.code === "EADDRINUSE"
          ? `Port ${port} is busy; another aseprite-mcp daemon may own it. Retrying every ${retryMs / 1000} s.`
          : `Cannot listen on port ${port}: ${listenError.message}. Retrying.`;
      log?.(error);
      retryTimer = setTimeout(bind, retryMs);
    });
  };

  const request = <T = unknown>(
    cmd: string,
    args: object = {},
    blobs: Uint8Array[] = []
  ): Promise<LinkReply<T>> => {
    const ws = current;
    if (!ws || ws.readyState !== ws.OPEN) {
      return Promise.reject(new Error(NOT_CONNECTED));
    }
    const id = nextId;
    nextId += 1;
    const ms = LONG_COMMANDS.has(cmd) ? longTimeoutMs : timeoutMs;
    const { promise, resolve, reject } = Promise.withResolvers<LinkReply>();
    const timer = setTimeout(
      () =>
        settle(id, (p) =>
          p.reject(new Error(`Timeout while running '${cmd}' (${ms} ms).`))
        ),
      ms
    );
    pending.set(id, { reject, resolve, timer, ws });
    const msg = { args, cmd, id };
    ws.send(
      blobs.length > 0 ? encodeFrame(msg, blobs) : JSON.stringify(msg),
      (sendError?: Error) => {
        if (sendError) {
          settle(id, (p) => p.reject(sendError));
        }
      }
    );
    return promise as Promise<LinkReply<T>>;
  };

  const close = async (): Promise<void> => {
    closed = true;
    clearTimeout(retryTimer);
    for (const client of server?.clients ?? []) {
      client.terminate();
    }
    if (server) {
      const stopped = once(server, "close");
      server.close();
      await stopped;
    }
  };

  bind();
  return {
    close,
    listening,
    request,
    status: () => ({
      connected: current !== null,
      error,
      extension,
      port: boundPort,
    }),
  };
};
