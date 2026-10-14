import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
// Shared by the daemon and e2e tests: free ports, an isolated environment and a daemon on them with the fake runtime.
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Health } from "../../src/stdio-proxy.ts";

export const root = nodePath.join(import.meta.dirname, "..", "..");
export const BIN = nodePath.join(root, "bin", "aseprite-mcp.ts");

export const freePort = async (): Promise<number> => {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address() as AddressInfo;
  s.close();
  await once(s, "close");
  return port;
};

/** Fresh ports and directories; `cleanup()` stops whatever daemon answers on the port and removes the directories. */
export const isolatedEnv = async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "mcp-test-"));
  const httpPort = await freePort();
  const env = {
    ...process.env,
    ASEPRITE_MCP_AUTOSAVE: "off",
    ASEPRITE_MCP_HTTP_PORT: String(httpPort),
    ASEPRITE_MCP_PORT: String(await freePort()),
    ASEPRITE_MCP_PROGRAM: nodePath.join(
      root,
      "test",
      "fixtures",
      "fake-program.ts"
    ),
    ASEPRITE_MCP_TOKEN: "t".repeat(48),
    ASEPRITE_MCP_VIEWS_DIR: nodePath.join(dir, "views"),
    XDG_CONFIG_HOME: nodePath.join(dir, "config"),
  };
  const base = `http://127.0.0.1:${httpPort}`;
  return {
    base,
    async cleanup() {
      await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {
        /* empty */
      });
      rmSync(dir, { force: true, recursive: true });
    },
    dir,
    env,
    httpPort,
  };
};

export const waitForHealth = (base: string, ms = 5000): Promise<Health> => {
  const end = Date.now() + ms;
  const attempt = async (): Promise<Health> => {
    const res = await fetch(`${base}/health`).catch(() => null);
    if (res?.ok) {
      return (await res.json()) as Health;
    }
    if (Date.now() >= end) {
      throw new Error(`no daemon on ${base}`);
    }
    await sleep(50);
    return attempt();
  };
  return attempt();
};

/** Runs `aseprite-mcp serve`; resolves with the child and a promise of its exit code. */
export const serve = (
  env: NodeJS.ProcessEnv
): {
  child: ChildProcess;
  exited: Promise<{ code: number | null; stderr: string }>;
} => {
  const child = spawn(process.execPath, [BIN, "serve"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d));
  const exited = (async () => {
    const [code] = await once(child, "exit");
    return { code: code as number | null, stderr };
  })();
  return { child, exited };
};
