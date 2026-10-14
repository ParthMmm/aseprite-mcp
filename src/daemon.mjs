// The one aseprite-mcp process per machine. Binding the HTTP port is the lock: a second daemon finds it
// taken and stops. Routes: POST /mcp (stateless MCP, one tool), GET /health, POST /shutdown.
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createLink } from "./link.mjs";
import { AUTOSAVE_DIR, FILE_DIRS, PALETTE_FILE, SPRITES_DIR, VIEWS_DIR, createBackups, loadToken, pruneViews } from "./files.mjs";

const HOST = "127.0.0.1";
const MAX_BODY = 16 * 1024 * 1024;
const INSTRUCTIONS = "Draw in the user's running Aseprite: send a JavaScript program to execute; help() inside it explains the API.";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// DNS rebinding and cross-site requests: only loopback hosts and origins may talk to the daemon.
function trustedRequest(req, port) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

const sendJson = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error("Request body too large.");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Envelope -> MCP content: one JSON text block, then one image block per view when `inline`. */
async function toContent(envelope, inline) {
  const content = [{ type: "text", text: JSON.stringify(envelope) }];
  if (!inline) return content;
  for (const path of envelope.images ?? []) {
    const data = await readFile(path).catch(() => null);
    if (data) content.push({ type: "image", mimeType: "image/png", data: data.toString("base64") });
  }
  return content;
}

function mcpServer({ version, description, execute }, inline) {
  const server = new Server({ name: "aseprite", version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "execute",
        description,
        inputSchema: {
          type: "object",
          properties: { code: { type: "string", description: "JavaScript program body; its return value becomes `value`." } },
          required: ["code"],
          additionalProperties: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== "execute") throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
    const code = params.arguments?.code;
    if (typeof code !== "string") throw new McpError(ErrorCode.InvalidParams, "execute needs { code: string }.");
    const envelope = await execute(code);
    return { content: await toContent(envelope, inline), isError: !envelope.ok };
  });
  return server;
}

/**
 * Starts the daemon, or returns null when another process holds `httpPort`.
 * @param {{ program: { createRuntime: Function, DESCRIPTION: string }, version: string, httpPort: number, wsPort: number,
 *           onShutdown?: () => void, log?: (...a: any[]) => void }} o
 */
export async function startDaemon({ program, version, httpPort, wsPort, onShutdown = () => {}, log = () => {} }) {
  const http = createServer((req, res) => handle(req, res).catch((err) => {
    log("Request failed:", err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }));

  const bound = await new Promise((resolve, reject) => {
    http.once("error", (err) => (err.code === "EADDRINUSE" ? resolve(false) : reject(err)));
    http.listen(httpPort, HOST, () => resolve(true));
  });
  if (!bound) return null;
  const port = http.address().port;

  // Requests that arrive while the link starts wait for it.
  const ready = (async () => {
    const link = createLink({ token: await loadToken(), port: wsPort, autosaveDir: AUTOSAVE_DIR, log });
    const backups = createBackups({ link, log });
    setTimeout(() => backups.cleanup(), 2000).unref();
    await mkdir(VIEWS_DIR, { recursive: true });
    const runtime = program.createRuntime({ link, viewsDir: VIEWS_DIR, palettesFile: PALETTE_FILE, spritesDir: SPRITES_DIR, allowedDirs: FILE_DIRS, limits: {} });
    const execute = async (code) => {
      const envelope = await runtime.execute(code);
      backups.schedule(envelope.commit ?? []);
      if (envelope.images?.length) pruneViews().catch(() => {});
      return envelope;
    };
    return { link, backups, execute };
  })();

  async function close() {
    const { link, backups } = await ready;
    await backups.flush().catch(() => {});
    await link.close();
    http.closeAllConnections();
    await new Promise((r) => http.close(() => r()));
  }

  async function handle(req, res) {
    if (!trustedRequest(req, port)) return sendJson(res, 403, { error: "Only loopback hosts and origins may use aseprite-mcp." });
    const { link, backups, execute } = await ready;
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { name: "aseprite-mcp", version, pid: process.pid, extension: link.status(), autosave: backups.info() });
    }
    if (url.pathname === "/shutdown" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      log("Shutting down on request.");
      return close().then(onShutdown);
    }
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "Not found." });
    if (req.method !== "POST") return res.writeHead(405, { allow: "POST" }).end();

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => transport.close());
    await mcpServer({ version, description: program.DESCRIPTION, execute }, url.searchParams.get("images") === "inline").connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await ready;
  log(`aseprite-mcp ${version} on http://${HOST}:${port}/mcp`);
  return { port, close };
}
