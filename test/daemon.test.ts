import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
// The daemon HTTP/MCP surface tested in-process with an injected Workspace and Link adapter.
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { isLoopbackAddress, startDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";
import { createWorkspace } from "../src/files.ts";
import type { Link } from "../src/link.ts";
import { rawRequest, root, waitForHealth } from "./fixtures/daemon-env.ts";
import * as fakeProgram from "./fixtures/fake-program.ts";

const VERSION = JSON.parse(
  readFileSync(`${root}/package.json`, "utf-8")
).version;

const disconnectedLink = (): Link => ({
  request: () => Promise.reject(new Error("not connected")),
  status: () => ({
    connected: false,
    error: null,
    extension: null,
    port: 0,
  }),
});

let dir: string;
let viewsDir: string;
let daemon: Daemon;
let base: string;
let shutdownCalled = false;

interface Block {
  type: string;
  text: string;
  data?: string;
  mimeType?: string;
}
const blocks = (res: unknown) => (res as { content: Block[] }).content;

before(async () => {
  dir = mkdtempSync(nodePath.join(tmpdir(), "mcp-daemon-"));
  viewsDir = nodePath.join(dir, "views");
  const workspace = createWorkspace({
    allowedDirs: [dir],
    autosaveDir: null,
    libDir: null,
    palettesFile: nodePath.join(dir, "palettes.json"),
    spritesDir: dir,
    tokenEnv: "t".repeat(48),
    tokenFile: nodePath.join(dir, "token"),
    viewsDir,
  });
  const started = await startDaemon({
    httpPort: 0,
    link: disconnectedLink(),
    onShutdown: () => {
      shutdownCalled = true;
    },
    program: fakeProgram,
    version: VERSION,
    workspace,
    wsPort: 0,
  });
  assert.ok(started);
  daemon = started;
  base = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  if (!shutdownCalled) {
    await daemon.close().catch(() => null);
  }
  rmSync(dir, { force: true, recursive: true });
});

const connect = async (query = "") => {
  const client = new Client({ name: "daemon-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp${query}`))
  );
  return client;
};

const rawGet = async (path: string, headers: Record<string, string>) => {
  const { status } = await rawRequest(daemon.port, "GET", path, headers);
  return status;
};

test("/health reports version, pid and the extension status", async () => {
  const h = await waitForHealth(base);
  assert.equal(h.version, VERSION);
  assert.equal(h.pid, process.pid);
  assert.deepEqual(h.extension, {
    connected: false,
    error: null,
    extension: null,
    port: 0,
  });
});

test("tools/list shows exactly one tool, execute, with the program's description", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => ({
      description: t.description,
      name: t.name,
      required: t.inputSchema.required,
    })),
    [
      {
        description: "FAKE execute: test runtime",
        name: "execute",
        required: ["code"],
      },
    ]
  );
  await client.close();
});

test("execute returns the envelope as one JSON text block, image paths without image blocks", async () => {
  const client = await connect();
  const res = await client.callTool({
    arguments: { code: "view" },
    name: "execute",
  });
  assert.equal(blocks(res).length, 1);
  const envelope = JSON.parse(blocks(res)[0]?.text ?? "");
  assert.deepEqual(
    { ...envelope, images: envelope.images.length },
    {
      commit: [],
      images: 1,
      ms: 0,
      ok: true,
      value: { code: "view", connected: false },
    }
  );
  assert.ok(envelope.images[0].startsWith(viewsDir));
  await client.close();
});

test("a failed program is an MCP tool error; a successful one is not", async () => {
  const client = await connect();
  const failed = await client.callTool({
    arguments: { code: "throw" },
    name: "execute",
  });
  assert.equal(failed.isError, true);
  assert.equal(
    JSON.parse(blocks(failed)[0]?.text ?? "").error.message,
    "Error: boom"
  );
  const ok = await client.callTool({
    arguments: { code: "1" },
    name: "execute",
  });
  assert.notEqual(ok.isError, true);
  await client.close();
});

test("?images=inline adds one PNG image block per view", async () => {
  const client = await connect("?images=inline");
  const res = await client.callTool({
    arguments: { code: "view" },
    name: "execute",
  });
  const [text, image] = blocks(res);
  const [path] = JSON.parse(text?.text ?? "").images;
  assert.deepEqual(image, {
    data: readFileSync(path).toString("base64"),
    mimeType: "image/png",
    type: "image",
  });
  assert.equal(blocks(res).length, 2);
  const plain = await client.callTool({
    arguments: { code: "1" },
    name: "execute",
  });
  assert.equal(blocks(plain).length, 1, "no views, no image blocks");
  await client.close();
});

test("a second daemon on the same port returns null and the first keeps serving", async () => {
  const second = await startDaemon({
    httpPort: daemon.port,
    link: disconnectedLink(),
    program: fakeProgram,
    version: VERSION,
    workspace: createWorkspace({ autosaveDir: null, viewsDir }),
    wsPort: 0,
  });
  assert.equal(second, null);
  const { pid } = await waitForHealth(base);
  assert.equal(pid, process.pid);
});

test("foreign Host headers and non-loopback Origins are rejected", async () => {
  const { port } = daemon;
  assert.equal(await rawGet("/health", { host: `127.0.0.1:${port}` }), 200);
  assert.equal(
    await rawGet("/health", {
      host: `localhost:${port}`,
      origin: "http://localhost:3000",
    }),
    200
  );
  assert.equal(await rawGet("/health", { host: `evil.example:${port}` }), 403);
  assert.equal(
    await rawGet("/health", {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
    }),
    403
  );
  assert.equal(await rawGet("/health", { host: `127.0.0.1:${port + 1}` }), 403);
});

test("POST /shutdown stops the daemon cleanly", async () => {
  const res = await fetch(`${base}/shutdown`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal(shutdownCalled, true);
  const down = await fetch(`${base}/health`).catch(() => null);
  assert.equal(down, null);
});

test("isLoopbackAddress distinguishes loopback from network addresses", () => {
  for (const addr of [
    "127.0.0.1",
    "127.0.0.42",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "localhost",
  ]) {
    assert.equal(isLoopbackAddress(addr), true, addr);
  }
  for (const addr of [
    "0.0.0.0",
    "::",
    "100.64.0.1",
    "192.168.1.5",
    "::ffff:10.0.0.1",
    "",
    undefined,
  ]) {
    assert.equal(isLoopbackAddress(addr), false, String(addr));
  }
});

test("startDaemon refuses a non-loopback HTTP host without a remote token, or a short token", async () => {
  const workspace = createWorkspace({ autosaveDir: null, viewsDir });
  await assert.rejects(
    startDaemon({
      httpHost: "0.0.0.0",
      httpPort: 0,
      link: disconnectedLink(),
      program: fakeProgram,
      version: VERSION,
      workspace,
      wsPort: 0,
    }),
    /requires a remote token/u
  );
  await assert.rejects(
    startDaemon({
      httpHost: "0.0.0.0",
      httpPort: 0,
      link: disconnectedLink(),
      program: fakeProgram,
      remoteToken: "short",
      version: VERSION,
      workspace,
      wsPort: 0,
    }),
    /at least 16 characters/u
  );
});

test("remote bearer mode authenticates remote callers, inlines views, blocks cross-site requests and refuses shutdown", async () => {
  const remoteToken = "r".repeat(48);
  const remoteDir = mkdtempSync(nodePath.join(tmpdir(), "mcp-remote-"));
  const remoteViewsDir = nodePath.join(remoteDir, "views");
  const workspace = createWorkspace({
    allowedDirs: [remoteDir],
    autosaveDir: null,
    libDir: null,
    palettesFile: nodePath.join(remoteDir, "palettes.json"),
    spritesDir: remoteDir,
    tokenEnv: "t".repeat(48),
    tokenFile: nodePath.join(remoteDir, "token"),
    viewsDir: remoteViewsDir,
  });
  const remoteDaemon = await startDaemon({
    httpHost: "0.0.0.0",
    httpPort: 0,
    link: disconnectedLink(),
    program: fakeProgram,
    remoteToken,
    version: VERSION,
    workspace,
    wsPort: 0,
  });
  assert.ok(remoteDaemon);
  const { port } = remoteDaemon;
  const remoteHost = `mybox.lan:${port}`;
  try {
    // Loopback callers still work without a bearer token and get paths only.
    const localHealth = await rawRequest(port, "GET", "/health", {
      host: `127.0.0.1:${port}`,
    });
    assert.equal(localHealth.status, 200);

    // Non-loopback Host without or with wrong bearer token gets 401 + WWW-Authenticate.
    const missing = await rawRequest(port, "GET", "/health", {
      host: remoteHost,
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers["www-authenticate"], "Bearer");

    const wrong = await rawRequest(port, "GET", "/health", {
      authorization: `Bearer ${"x".repeat(48)}`,
      host: remoteHost,
    });
    assert.equal(wrong.status, 401);

    // Valid bearer token accesses /health and gets inline PNG blocks on /mcp.
    const okHealth = await rawRequest(port, "GET", "/health", {
      authorization: `Bearer ${remoteToken}`,
      host: remoteHost,
    });
    assert.equal(okHealth.status, 200);

    const mcp = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${remoteToken}`,
        "content-type": "application/json",
        host: remoteHost,
      },
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { code: "view" }, name: "execute" },
      }
    );
    assert.equal(mcp.status, 200, mcp.body);
    const [text, image, ...extra] = JSON.parse(mcp.body).result
      .content as Block[];
    const [imgPath] = JSON.parse(text?.text ?? "").images;
    assert.deepEqual(image, {
      data: readFileSync(imgPath).toString("base64"),
      mimeType: "image/png",
      type: "image",
    });
    assert.deepEqual(extra, []);

    // Cross-site Origin and Sec-Fetch-Site are rejected even with a valid bearer token.
    const foreignOrigin = await rawRequest(port, "GET", "/health", {
      authorization: `Bearer ${remoteToken}`,
      host: remoteHost,
      origin: "https://evil.example",
    });
    assert.equal(foreignOrigin.status, 403);

    const crossSite = await rawRequest(port, "GET", "/health", {
      authorization: `Bearer ${remoteToken}`,
      host: remoteHost,
      "sec-fetch-site": "cross-site",
    });
    assert.equal(crossSite.status, 403);

    // Remote bearer callers cannot stop the daemon.
    const stop = await rawRequest(port, "POST", "/shutdown", {
      authorization: `Bearer ${remoteToken}`,
      host: remoteHost,
    });
    assert.equal(stop.status, 403);
  } finally {
    await remoteDaemon.close();
    rmSync(remoteDir, { force: true, recursive: true });
  }
});
