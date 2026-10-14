// What MCP clients that launch a command (Claude Code, Cursor, ...) run: make sure the daemon is up,
// then pipe stdio JSON-RPC to its /mcp?images=inline endpoint.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { compareVersions } from "./link.ts";

const START_WAIT_MS = 5000;
const POLL_MS = 100;
const base = (port: number): string => `http://127.0.0.1:${port}`;

export interface Health {
  name: string;
  pid: number;
  version: string;
  autosave: unknown;
  extension: unknown;
}

export interface ProxyOptions {
  port: number;
  version: string;
  binPath: string;
  log?: (...args: unknown[]) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The daemon's /health, or null when nothing answers on `port`. */
export const health = async (port: number): Promise<Health | null> => {
  try {
    const res = await fetch(`${base(port)}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
};

export const shutdown = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`${base(port)}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// The first truthy answer from `check`, or null once the wait runs out.
const waitFor = async <T>(
  check: () => Promise<T>,
  end = Date.now() + START_WAIT_MS
): Promise<T | null> => {
  if (Date.now() >= end) {
    return null;
  }
  const result = await check();
  if (result) {
    return result;
  }
  await sleep(POLL_MS);
  return waitFor(check, end);
};

/** Converges on one running daemon at least as new as `version`; spawns `node <binPath> serve` detached when needed. */
export const ensureDaemon = async ({
  port,
  version,
  binPath,
  log,
}: ProxyOptions): Promise<Health> => {
  const running = await health(port);
  if (running && compareVersions(version, running.version) <= 0) {
    return running;
  }
  if (running) {
    log?.(
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
  const started = await waitFor(() => health(port));
  if (!started) {
    throw new Error(
      `The aseprite-mcp daemon did not answer on ${base(port)} within ${START_WAIT_MS / 1000} s. Run \`aseprite-mcp serve\` to see why.`
    );
  }
  return started;
};

export const runProxy = async ({
  port,
  version,
  binPath,
  log,
}: ProxyOptions): Promise<void> => {
  await ensureDaemon({ binPath, log, port, version });
  const local = new StdioServerTransport();
  const upstream = new StreamableHTTPClientTransport(
    new URL(`${base(port)}/mcp?images=inline`)
  );
  // The SDK transports take callback properties, not DOM events.
  Object.assign(local, {
    onmessage: async (msg: JSONRPCMessage) => {
      try {
        await upstream.send(msg);
      } catch (error) {
        const reason = errorMessage(error);
        log?.("Daemon request failed:", reason);
        if ("method" in msg && "id" in msg && msg.id !== undefined) {
          await local.send({
            error: {
              code: -32_000,
              message: `aseprite-mcp daemon unreachable: ${reason}`,
            },
            id: msg.id,
            jsonrpc: "2.0",
          });
        }
        try {
          await ensureDaemon({ binPath, log, port, version });
        } catch (restartError) {
          log?.(errorMessage(restartError));
        }
      }
    },
  });
  Object.assign(upstream, {
    onerror: (error: Error) => log?.("Daemon transport error:", error.message),
    onmessage: (msg: JSONRPCMessage) => local.send(msg),
  });
  await upstream.start();
  await local.start();
  process.stdin.on("end", () => process.exit(0));
};
