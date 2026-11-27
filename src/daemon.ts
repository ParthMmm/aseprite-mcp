// The one aseprite-mcp process per machine. Binding the HTTP port is the lock: a second daemon finds it
// taken and stops. Routes: POST /mcp (stateless MCP, one tool), GET /health, POST /shutdown.
import { timingSafeEqual } from "node:crypto";
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

import { createWorkspace } from "./files.ts";
import type { BackupSprite, Workspace } from "./files.ts";
import { createLink } from "./link.ts";
import type { Link } from "./link.ts";
import type { RuntimeOptions } from "./program.ts";
import type { Tailnet } from "./tailnet.ts";

export type { RuntimeOptions } from "./program.ts";

const HOST = "127.0.0.1";
const MAX_BODY = 16 * 1024 * 1024;
const MIN_REMOTE_TOKEN = 16;
const INSTRUCTIONS =
  "Draw in the user's running Aseprite: send a JavaScript program to execute; help() inside it explains the API.";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/u;
const BEARER = /^bearer\s+(?<token>\S+)$/iu;

export interface Envelope {
  ok: boolean;
  images?: string[];
  commit?: BackupSprite[];
  [key: string]: unknown;
}

export interface Runtime {
  execute: (
    code: string,
    options?: { signal?: AbortSignal }
  ) => Promise<Envelope>;
}

export interface Program {
  createRuntime: (options: RuntimeOptions) => Runtime;
  DESCRIPTION: string;
}

type Access = "loopback" | "tailnet" | "remote";

type RequestAuth = { access: Access } | { status: 401 | 403; error: string };

export interface DaemonOptions {
  program: Program;
  workspace?: Workspace;
  link?: Link;
  tailnet?: Tailnet | null;
  httpHost?: string;
  remoteToken?: string | null;
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
  execute: (
    code: string,
    options?: { signal?: AbortSignal }
  ) => Promise<Envelope>;
}

const ignore = (): null => null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** True when `address` is a loopback host or IP (IPv4 127.0.0.0/8, ::1, IPv4-mapped loopback, or localhost). */
export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (!address) {
    return false;
  }
  const clean = address
    .trim()
    .toLowerCase()
    .replaceAll(/^\[|\]$/gu, "")
    .replace(/^::ffff:/u, "");
  return clean === "localhost" || clean === "::1" || LOOPBACK_IPV4.test(clean);
};

const loopbackOrigin = (origin: string | undefined): boolean => {
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

const fetchSiteAllowed = (value: string | string[] | undefined): boolean =>
  value === undefined ||
  (typeof value === "string" &&
    (value === "" || value === "same-origin" || value === "none"));

const remoteOriginAllowed = (
  origin: string | undefined,
  host: string | undefined
): boolean =>
  origin === undefined ||
  (typeof host === "string" &&
    host.length > 0 &&
    (origin === `http://${host}` || origin === `https://${host}`));

const bearerToken = (header: string | undefined): string | null => {
  if (!header) {
    return null;
  }
  const match = BEARER.exec(header.trim());
  return match?.groups?.token ?? null;
};

const secretsEqual = (expected: string, given: string | null): boolean => {
  if (!given) {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

// DNS rebinding, cross-site requests and remote authentication:
// 1. Direct loopback peers with a loopback Host and Origin (never proxied).
// 2. Allowed Tailscale users forwarded by local `tailscale serve`.
// 3. Callers presenting the remote Bearer token (when remote access is enabled).
const classifyRequest = (
  req: IncomingMessage,
  port: number,
  tailnet: Tailnet | null,
  remoteToken: string | null
): RequestAuth => {
  const { host, origin } = req.headers;
  const peerIsLoopback = isLoopbackAddress(req.socket.remoteAddress);
  // `tailscale serve` passes the caller's Host header through unchanged, so a proxied request can claim a
  // loopback Host. The proxy always adds X-Forwarded-For.
  const proxied = req.headers["x-forwarded-for"] !== undefined;
  const loopbackHost =
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`;
  if (peerIsLoopback && !proxied && loopbackHost) {
    return loopbackOrigin(origin) &&
      fetchSiteAllowed(req.headers["sec-fetch-site"])
      ? { access: "loopback" }
      : {
          error: "Cross-origin browser requests are not allowed.",
          status: 403,
        };
  }
  if (tailnet && peerIsLoopback && host === tailnet.host) {
    const login = req.headers["tailscale-user-login"];
    const allowedUser = typeof login === "string" && tailnet.users.has(login);
    const tailnetOrigin =
      origin === undefined || origin === `https://${tailnet.host}`;
    if (
      allowedUser &&
      tailnetOrigin &&
      fetchSiteAllowed(req.headers["sec-fetch-site"])
    ) {
      return { access: "tailnet" };
    }
  }
  if (remoteToken) {
    if (
      !(
        fetchSiteAllowed(req.headers["sec-fetch-site"]) &&
        remoteOriginAllowed(origin, host)
      )
    ) {
      return {
        error: "Cross-origin browser requests are not allowed.",
        status: 403,
      };
    }
    if (secretsEqual(remoteToken, bearerToken(req.headers.authorization))) {
      return { access: "remote" };
    }
    return {
      error: "Missing or invalid bearer token.",
      status: 401,
    };
  }
  return {
    error:
      "Only loopback callers and allowed Tailscale users may use aseprite-mcp.",
    status: 403,
  };
};

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>
): void => {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
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
  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params }, { signal }) => {
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
      const envelope = await execute(code, { signal });
      return {
        content: await toContent(envelope, inline),
        isError: !envelope.ok,
      };
    }
  );
  return server;
};

/** Starts the daemon, or returns null when another process holds `httpPort`. */
export const startDaemon = async ({
  program,
  workspace = createWorkspace(),
  link: injectedLink,
  version,
  httpHost = HOST,
  httpPort,
  wsPort,
  onShutdown,
  log,
  tailnet = null,
  remoteToken = null,
}: DaemonOptions): Promise<Daemon | null> => {
  if (remoteToken !== null && remoteToken.length < MIN_REMOTE_TOKEN) {
    throw new Error(
      `The remote token must have at least ${MIN_REMOTE_TOKEN} characters.`
    );
  }
  if (!(isLoopbackAddress(httpHost) || remoteToken)) {
    throw new Error(
      "Listening on a non-loopback HTTP host requires a remote token."
    );
  }
  const http = createServer();
  http.listen(httpPort, httpHost);
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
    let ownedLink: ReturnType<typeof createLink> | null = null;
    let link: Link;
    if (injectedLink) {
      link = injectedLink;
    } else {
      ownedLink = createLink({
        autosaveDir: workspace.autosaveDir,
        log,
        port: wsPort,
        token: (await workspace.loadToken()) ?? "",
      });
      link = ownedLink;
    }
    const backups = workspace.createBackups({ link, log });
    setTimeout(() => backups.cleanup(), 2000).unref();
    await mkdir(workspace.viewsDir, { recursive: true });
    const runtime = program.createRuntime({
      limits: {},
      link,
      workspace,
    });
    const execute = async (
      code: string,
      options?: { signal?: AbortSignal }
    ): Promise<Envelope> => {
      const envelope = await runtime.execute(code, options);
      backups.schedule(envelope.commit ?? []);
      if (envelope.images?.length) {
        Promise.allSettled([workspace.pruneViews()]);
      }
      return envelope;
    };
    return { backups, execute, link, ownedLink };
  })();

  const close = async (): Promise<void> => {
    const { ownedLink, backups } = await ready;
    await backups.flush().catch(ignore);
    if (ownedLink) {
      await ownedLink.close();
    }
    http.closeAllConnections();
    const stopped = once(http, "close");
    http.close();
    await stopped;
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const auth = classifyRequest(req, port, tailnet, remoteToken);
    if (!("access" in auth)) {
      sendJson(
        res,
        auth.status,
        { error: auth.error },
        auth.status === 401 ? { "www-authenticate": "Bearer" } : undefined
      );
      return;
    }
    const { access } = auth;
    const { link, backups, execute } = await ready;
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host || `${HOST}:${port}`}`
    );
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
      if (access !== "loopback") {
        sendJson(res, 403, {
          error: "Only loopback callers may stop the daemon.",
        });
        return;
      }
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
      // Remote callers run on other machines and cannot open local view paths.
      access !== "loopback" || url.searchParams.get("images") === "inline"
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
  log?.(`aseprite-mcp ${version} on http://${httpHost}:${port}/mcp`);
  return { close, port };
};
