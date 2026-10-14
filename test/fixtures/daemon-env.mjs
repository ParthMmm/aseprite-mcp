import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
// Shared by the daemon and e2e tests: free ports, an isolated environment and a daemon on them with the fake runtime.
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(import.meta.dirname, "..", "..");
export const BIN = join(root, "bin", "aseprite-mcp.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** Fresh ports and directories; `cleanup()` stops whatever daemon answers on the port and removes the directories. */
export async function isolatedEnv() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-test-"));
  const httpPort = await freePort();
  const env = {
    ...process.env,
    ASEPRITE_MCP_AUTOSAVE: "off",
    ASEPRITE_MCP_HTTP_PORT: String(httpPort),
    ASEPRITE_MCP_PORT: String(await freePort()),
    ASEPRITE_MCP_PROGRAM: join(root, "test", "fixtures", "fake-program.mjs"),
    ASEPRITE_MCP_TOKEN: "t".repeat(48),
    ASEPRITE_MCP_VIEWS_DIR: join(dir, "views"),
    XDG_CONFIG_HOME: join(dir, "config"),
  };
  const base = `http://127.0.0.1:${httpPort}`;
  return {
    base,
    async cleanup() {
      await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
      rmSync(dir, { force: true, recursive: true });
    },
    dir,
    env,
    httpPort,
  };
}

export async function waitForHealth(base, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const res = await fetch(`${base}/health`).catch(() => null);
    if (res?.ok) {
      return res.json();
    }
  }
  throw new Error(`no daemon on ${base}`);
}

/** Runs `aseprite-mcp serve`; resolves with the child and a promise of its exit code. */
export function serve(env) {
  const child = spawn(process.execPath, [BIN, "serve"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) =>
    child.on("exit", (code) => r({ code, stderr }))
  );
  return { child, exited };
}
