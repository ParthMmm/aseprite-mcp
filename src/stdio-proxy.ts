// What MCP clients that launch a command (Claude Code, Cursor, ...) run: make sure the daemon is up,
// then pipe stdio JSON-RPC to its /mcp?images=inline endpoint.
import { spawn } from "node:child_process";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { compareVersions } from "./link.ts";

const START_WAIT_MS = 5000;
const POLL_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = (port) => `http://127.0.0.1:${port}`;

/** The daemon's /health, or null when nothing answers on `port`. */
export async function health(port) {
  try {
    const res = await fetch(`${base(port)}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function shutdown(port) {
  try {
    return (
      await fetch(`${base(port)}/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      })
    ).ok;
  } catch {
    return false;
  }
}

async function waitFor(check) {
  for (
    const end = Date.now() + START_WAIT_MS;
    Date.now() < end;
    await sleep(POLL_MS)
  ) {
    if (await check()) return true;
  }
  return false;
}

/** Converges on one running daemon at least as new as `version`; spawns `node <binPath> serve` detached when needed. */
export async function ensureDaemon({ port, version, binPath, log = () => {} }) {
  const running = await health(port);
  if (running && compareVersions(version, running.version) <= 0) {
    return running;
  }
  if (running) {
    log(
      `Replacing the aseprite-mcp ${running.version} daemon with ${version}.`
    );
    await shutdown(port);
    await waitFor(async () => !(await health(port)));
  }
  spawn(process.execPath, [binPath, "serve"], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  }).unref();
  let started = null;
  await waitFor(async () => (started = await health(port)));
  if (!started) {
    throw new Error(
      `The aseprite-mcp daemon did not answer on ${base(port)} within ${START_WAIT_MS / 1000} s. Run \`aseprite-mcp serve\` to see why.`
    );
  }
  return started;
}

export async function runProxy({ port, version, binPath, log = () => {} }) {
  await ensureDaemon({ binPath, log, port, version });
  const local = new StdioServerTransport();
  const upstream = new StreamableHTTPClientTransport(
    new URL(`${base(port)}/mcp?images=inline`)
  );
  local.onmessage = (msg) =>
    upstream.send(msg).catch((error) => {
      log("Daemon request failed:", error.message);
      if (msg.method && msg.id !== undefined) {
        local.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: `aseprite-mcp daemon unreachable: ${error.message}`,
          },
        });
      }
      ensureDaemon({ binPath, log, port, version }).catch((error) =>
        log(error.message)
      );
    });
  upstream.onmessage = (msg) => local.send(msg);
  upstream.onerror = (err) => log("Daemon transport error:", err.message);
  await upstream.start();
  await local.start();
  process.stdin.on("end", () => process.exit(0));
}
