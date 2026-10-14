import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
// The daemon as a process (`aseprite-mcp serve`) with the fake runtime, driven over HTTP.
import { test, before, after } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  isolatedEnv,
  serve,
  waitForHealth,
  root,
} from "./fixtures/daemon-env.ts";

const VERSION = JSON.parse(
  readFileSync(`${root}/package.json`, "utf-8")
).version;
let ctx;
let daemon;

before(async () => {
  ctx = await isolatedEnv();
  daemon = serve(ctx.env);
  await waitForHealth(ctx.base);
});
after(() => ctx.cleanup());

async function connect(query = "") {
  const client = new Client({ name: "daemon-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ctx.base}/mcp${query}`))
  );
  return client;
}

// Raw request so the test controls the Host header (fetch does not allow overriding it).
function rawGet(path, headers) {
  return new Promise((done, fail) => {
    const req = request(
      { headers, host: "127.0.0.1", path, port: ctx.httpPort },
      (res) => {
        res.resume();
        res.on("end", () => done(res.statusCode));
      }
    );
    req.on("error", fail);
    req.end();
  });
}

test("/health reports version, pid and the extension status", async () => {
  const h = await waitForHealth(ctx.base);
  assert.equal(h.version, VERSION);
  assert.equal(h.pid, daemon.child.pid);
  assert.deepEqual(h.extension, {
    connected: false,
    error: null,
    extension: null,
    port: Number(ctx.env.ASEPRITE_MCP_PORT),
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
  assert.equal(res.content.length, 1);
  const envelope = JSON.parse(res.content[0].text);
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
  assert.ok(envelope.images[0].startsWith(ctx.env.ASEPRITE_MCP_VIEWS_DIR));
  await client.close();
});

test("a failed program is an MCP tool error; a successful one is not", async () => {
  const client = await connect();
  const failed = await client.callTool({
    arguments: { code: "throw" },
    name: "execute",
  });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.content[0].text).error.message, "Error: boom");
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
  const [text, image] = res.content;
  const path = JSON.parse(text.text).images[0];
  assert.deepEqual(image, {
    data: readFileSync(path).toString("base64"),
    mimeType: "image/png",
    type: "image",
  });
  assert.equal(res.content.length, 2);
  const plain = await client.callTool({
    arguments: { code: "1" },
    name: "execute",
  });
  assert.equal(plain.content.length, 1, "no views, no image blocks");
  await client.close();
});

test("a second daemon on the same port exits 0 and the first keeps serving", async () => {
  const second = serve(ctx.env);
  const { code } = await second.exited;
  assert.equal(code, 0);
  assert.equal((await waitForHealth(ctx.base)).pid, daemon.child.pid);
});

test("foreign Host headers and non-loopback Origins are rejected", async () => {
  const port = ctx.httpPort;
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

test("POST /shutdown stops the daemon with exit code 0", async () => {
  const res = await fetch(`${ctx.base}/shutdown`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await daemon.exited).code, 0);
  assert.equal(await fetch(`${ctx.base}/health`).catch(() => null), null);
});
