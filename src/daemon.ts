// The one aseprite-mcp process per machine. Binding the HTTP port is the lock: a second daemon finds it
// taken and stops. Routes: POST /mcp (stateless MCP, one tool), GET /health, POST /shutdown.
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import {
  AUTOSAVE_DIR,
  FILE_DIRS,
  PALETTE_FILE,
  SPRITES_DIR,
  VIEWS_DIR,
  createBackups,
  loadToken,
  pruneViews,
} from "./files.ts";
import type { BackupSprite } from "./files.ts";
import { createLink } from "./link.ts";
import type { Link } from "./link.ts";

const HOST = "127.0.0.1";
const MAX_BODY = 16 * 1024 * 1024;
const INSTRUCTIONS =
  "Draw in the user's running Aseprite: send a JavaScript program to execute; help() inside it explains the API.";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface Envelope {
  ok: boolean;
  images?: string[];
  commit?: BackupSprite[];
  [key: string]: unknown;
}

export interface RuntimeOptions {
  allowedDirs: string[];
  limits: object;
  link: Link;
  palettesFile: string;
  spritesDir: string;
  viewsDir: string;
}

export interface Runtime {
  execute: (code: string) => Promise<Envelope>;
}

export interface Program {
  createRuntime: (options: RuntimeOptions) => Runtime;
  DESCRIPTION: string;
}

export interface DaemonOptions {
  program: Program;
  version: string;
  httpPort: number;
  wsPort: number;
  onShutdown?: () => void;
  log?: (...args: unknown[]) => void;
}

export interface Daemon {
  close: () => Promise<void>;
  port: number;
}

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ServerSetup {
  version: string;
  description: string;
  execute: (code: string) => Promise<Envelope>;
}

const ignore = (): null => null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// DNS rebinding and cross-site requests: only loopback hosts and origins may talk to the daemon.
const trustedRequest = (req: IncomingMessage, port: number): boolean => {
  const { host } = req.headers;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return false;
  }
  const { origin } = req.headers;
  if (origin === undefined) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK.has(url.hostname)
    );
  } catch {
    return false;
  }
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > MAX_BODY) {
      throw new Error("Request body too large.");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf-8");
};

/** Envelope -> MCP content: one JSON text block, then one image block per view when `inline`. */
const toContent = async (
  envelope: Envelope,
  inline: boolean
): Promise<Content[]> => {
  const content: Content[] = [{ text: JSON.stringify(envelope), type: "text" }];
  if (!inline) {
    return content;
  }
  const images = await Promise.all(
    (envelope.images ?? []).map((path) => readFile(path).catch(ignore))
  );
  for (const data of images) {
    if (data) {
      content.push({
        data: data.toString("base64"),
        mimeType: "image/png",
        type: "image",
      });
    }
  }
  return content;
};

const mcpServer = (
  { version, description, execute }: ServerSetup,
  inline: boolean
): Server => {
  const server = new Server(
    { name: "aseprite", version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        description,
        inputSchema: {
          additionalProperties: false,
          properties: {
            code: {
              description:
                "JavaScript program body; its return value becomes `value`.",
              type: "string",
            },
          },
          required: ["code"],
          type: "object",
        },
        name: "execute",
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== "execute") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${params.name}`
      );
    }
    const code = params.arguments?.code;
    if (typeof code !== "string") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "execute needs { code: string }."
      );
    }
    const envelope = await execute(code);
    return {
      content: await toContent(envelope, inline),
      isError: !envelope.ok,
    };
  });
  return server;
};

/** Starts the daemon, or returns null when another process holds `httpPort`. */
export const startDaemon = async ({
  program,
  version,
  httpPort,
  wsPort,
  onShutdown,
  log,
}: DaemonOptions): Promise<Daemon | null> => {
  const http = createServer();
  http.listen(httpPort, HOST);
  try {
    await once(http, "listening");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return null;
    }
    throw error;
  }
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : httpPort;

  // Requests that arrive while the link starts wait for it.
  const ready = (async () => {
    const link = createLink({
      autosaveDir: AUTOSAVE_DIR,
      log,
      port: wsPort,
      token: (await loadToken()) ?? "",
    });
    const backups = createBackups({ link, log });
    setTimeout(() => backups.cleanup(), 2000).unref();
    await mkdir(VIEWS_DIR, { recursive: true });
    const runtime = program.createRuntime({
      allowedDirs: FILE_DIRS,
      limits: {},
      link,
      palettesFile: PALETTE_FILE,
      spritesDir: SPRITES_DIR,
      viewsDir: VIEWS_DIR,
    });
    const execute = async (code: string): Promise<Envelope> => {
      const envelope = await runtime.execute(code);
      backups.schedule(envelope.commit ?? []);
      if (envelope.images?.length) {
        Promise.allSettled([pruneViews()]);
      }
      return envelope;
    };
    return { backups, execute, link };
  })();

  const close = async (): Promise<void> => {
    const { link, backups } = await ready;
    await backups.flush().catch(ignore);
    await link.close();
    http.closeAllConnections();
    const stopped = once(http, "close");
    http.close();
    await stopped;
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    if (!trustedRequest(req, port)) {
      sendJson(res, 403, {
        error: "Only loopback hosts and origins may use aseprite-mcp.",
      });
      return;
    }
    const { link, backups, execute } = await ready;
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        autosave: backups.info(),
        extension: link.status(),
        name: "aseprite-mcp",
        pid: process.pid,
        version,
      });
      return;
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      log?.("Shutting down on request.");
      await close();
      onShutdown?.();
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, {
        error: {
          code: -32_700,
          message: `Parse error: ${errorMessage(error)}`,
        },
        id: null,
        jsonrpc: "2.0",
      });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    res.on("close", () => transport.close());
    await mcpServer(
      { description: program.DESCRIPTION, execute, version },
      url.searchParams.get("images") === "inline"
    ).connect(transport);
    await transport.handleRequest(req, res, body);
  };

  http.on("request", async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handle(req, res);
    } catch (error) {
      log?.("Request failed:", errorMessage(error));
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: errorMessage(error) });
      }
    }
  });

  await ready;
  log?.(`aseprite-mcp ${version} on http://${HOST}:${port}/mcp`);
  return { close, port };
};
