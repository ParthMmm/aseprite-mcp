// End to end through the command MCP clients launch: `aseprite-mcp` (stdio proxy) starts the daemon
// detached and pipes JSON-RPC to it. The daemon runs the fake runtime (test/fixtures/fake-program.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BIN, isolatedEnv, serve, waitForHealth } from "./fixtures/daemon-env.mjs";

async function proxyClient(env) {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: "pipe" }));
  return client;
}

test("the stdio proxy starts a daemon, lists the one tool and inlines views", async (t) => {
  const ctx = await isolatedEnv();
  t.after(() => ctx.cleanup());
  assert.equal(await fetch(`${ctx.base}/health`).catch(() => null), null, "no daemon before the proxy runs");

  const client = await proxyClient(ctx.env);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["execute"]);

  const res = await client.callTool({ name: "execute", arguments: { code: "view" } });
  const [text, image] = res.content;
  const envelope = JSON.parse(text.text);
  assert.equal(envelope.ok, true);
  assert.deepEqual(image, { type: "image", mimeType: "image/png", data: readFileSync(envelope.images[0]).toString("base64") });

  const { pid } = await waitForHealth(ctx.base);
  await client.close();
  assert.equal((await waitForHealth(ctx.base)).pid, pid, "the daemon outlives the proxy");
});

test("the proxy reuses a running daemon instead of starting another", async (t) => {
  const ctx = await isolatedEnv();
  t.after(() => ctx.cleanup());
  const daemon = serve(ctx.env);
  await waitForHealth(ctx.base);

  const client = await proxyClient(ctx.env);
  const res = await client.callTool({ name: "execute", arguments: { code: "1" } });
  assert.deepEqual(JSON.parse(res.content[0].text).value, { code: "1", connected: false });
  assert.equal((await waitForHealth(ctx.base)).pid, daemon.child.pid);
  await client.close();
});

test("status and stop talk to the daemon", async (t) => {
  const ctx = await isolatedEnv();
  t.after(() => ctx.cleanup());
  const run = (cmd) => spawnSync(process.execPath, [BIN, cmd], { env: ctx.env, encoding: "utf8" });

  assert.equal(run("status").status, 1, "status fails without a daemon");
  const daemon = serve(ctx.env);
  await waitForHealth(ctx.base);
  const status = run("status");
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).pid, daemon.child.pid);
  assert.match(run("stop").stdout, /Stopped/);
  assert.equal((await daemon.exited).code, 0);
});
