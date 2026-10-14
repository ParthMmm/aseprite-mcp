#!/usr/bin/env node
// Command line entry. No argument: the stdio proxy that MCP clients launch. Other commands manage the daemon.
import { readFileSync } from "node:fs";
import { env, argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadToken } from "../src/files.ts";
import { health, runProxy, shutdown } from "../src/stdio-proxy.ts";

const binPath = import.meta.filename;
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);
const httpPort = Number(env.ASEPRITE_MCP_HTTP_PORT) || 9124;
const wsPort = Number(env.ASEPRITE_MCP_PORT) || 9123;
const log = (...parts) => stderr.write(`[aseprite-mcp] ${parts.join(" ")}\n`);

const USAGE = `aseprite-mcp ${version}: let an AI assistant draw in your running Aseprite.

Usage: aseprite-mcp [command]

Commands:
  (none)        Run as an MCP stdio server; starts the daemon if none is running.
  serve         Run the daemon in the foreground.
  status        Print the daemon's health as JSON. Exits 1 when no daemon answers.
  stop          Ask the running daemon to shut down.
  token         Print the pairing token for the Aseprite extension.
  token --new   Replace the pairing token and print it.
  help          Show this text.

Environment:
  ASEPRITE_MCP_HTTP_PORT  daemon HTTP port (default 9124)
  ASEPRITE_MCP_PORT       WebSocket port the extension connects to (default 9123)
  ASEPRITE_MCP_TOKEN      use this token instead of the token file
`;

async function serve() {
  const program = await import(
    env.ASEPRITE_MCP_PROGRAM
      ? pathToFileURL(env.ASEPRITE_MCP_PROGRAM).href
      : "../src/program.ts"
  );
  const { startDaemon } = await import("../src/daemon.ts");
  const daemon = await startDaemon({
    httpPort,
    log,
    onShutdown: () => exit(0),
    program,
    version,
    wsPort,
  });
  if (!daemon) {
    log(`A daemon already answers on port ${httpPort}; leaving it running.`);
    return exit(0);
  }
  const stop = () => daemon.close().finally(() => exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function status() {
  const h = await health(httpPort);
  if (!h) {
    log(
      `No daemon on port ${httpPort}. Start one with \`aseprite-mcp serve\`.`
    );
    return exit(1);
  }
  stdout.write(`${JSON.stringify(h, null, 2)}\n`);
}

async function stop() {
  if (!(await health(httpPort))) {
    return stdout.write(`No daemon is running on port ${httpPort}.\n`);
  }
  if (!(await shutdown(httpPort))) {
    log(`The daemon on port ${httpPort} did not accept the stop request.`);
    return exit(1);
  }
  stdout.write(`Stopped the aseprite-mcp daemon on port ${httpPort}.\n`);
}

async function token(rest) {
  const renew = rest.includes("--new");
  stdout.write(`${await loadToken({ renew })}\n`);
  if (renew) {
    log(
      "New token saved. Paste it into the Aseprite MCP window, and run `aseprite-mcp stop` so the daemon picks it up."
    );
  }
}

const [command, ...rest] = argv.slice(2);
const commands = { serve, status, stop, token: () => token(rest) };

if (command === undefined) {
  await runProxy({ binPath, log, port: httpPort, version });
} else if (commands[command]) {
  await commands[command]();
} else {
  const asked = ["help", "--help", "-h"].includes(command);
  (asked ? stdout : stderr).write(USAGE);
  exit(asked ? 0 : 2);
}
