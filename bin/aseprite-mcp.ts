#!/usr/bin/env node
// Command line entry. No argument: the stdio proxy that MCP clients launch. Other commands manage the daemon.
import { readFileSync } from "node:fs";
import { env, argv, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

import { messageOf } from "../src/check.ts";
import { isLoopbackAddress } from "../src/daemon.ts";
import type { Program } from "../src/daemon.ts";
import { createWorkspace } from "../src/files.ts";
import { health, runProxy, shutdown } from "../src/stdio-proxy.ts";
import {
  detectRemoteAddresses,
  detectTailnet,
  resolveTailnet,
  serveOnTailnet,
  tailnetEnvComplete,
} from "../src/tailnet.ts";
import type { Tailnet } from "../src/tailnet.ts";

const binPath = import.meta.filename;
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);
const httpPort = Number(env.ASEPRITE_MCP_HTTP_PORT) || 9124;
const wsPort = Number(env.ASEPRITE_MCP_PORT) || 9123;
const log = (...parts: unknown[]): void => {
  stderr.write(`[aseprite-mcp] ${parts.join(" ")}\n`);
};

const USAGE = `aseprite-mcp ${version}: let an AI assistant draw in your running Aseprite.

Usage: aseprite-mcp [command]

Commands:
  (none)        Run as an MCP stdio server; starts the daemon if none is running.
  serve         Run the daemon in the foreground.
  serve --tailscale
                Also serve it to your tailnet with \`tailscale serve\`, open to
                this machine's owner.
  serve --remote
                Bind HTTP on all interfaces (0.0.0.0) and require
                \`Authorization: Bearer <token>\` for remote callers.
  status        Print the daemon's health as JSON. Exits 1 when no daemon answers.
  stop          Ask the running daemon to shut down.
  token         Print the pairing token for the Aseprite extension.
  token --new   Replace the pairing token and print it.
  token --remote
                Print the remote HTTP bearer token (add --new to replace it).
  help          Show this text.

Environment:
  ASEPRITE_MCP_HTTP_HOST  daemon HTTP bind address (default 127.0.0.1; 0.0.0.0 with --remote)
  ASEPRITE_MCP_HTTP_PORT  daemon HTTP port (default 9124)
  ASEPRITE_MCP_PORT       WebSocket port the extension connects to (default 9123)
  ASEPRITE_MCP_TOKEN      use this pairing token instead of the token file
  ASEPRITE_MCP_REMOTE_TOKEN
                          use this bearer token for remote HTTP callers instead of the remote-token file
  ASEPRITE_MCP_TAILNET_HOST
                          the Host header tailnet requests carry, such as
                          machine.example-tailnet.ts.net:9124
  ASEPRITE_MCP_TAILNET_USERS
                          comma-separated Tailscale logins allowed in
`;

const isWildcard = (host: string): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const logRemoteUrls = async (httpHost: string, port: number): Promise<void> => {
  if (isWildcard(httpHost)) {
    const { tailnet, lan } = await detectRemoteAddresses(port);
    for (const host of tailnet) {
      log(`Remote (Tailscale): http://${host}/mcp`);
    }
    for (const host of lan) {
      log(`Remote (LAN): http://${host}/mcp`);
    }
    if (tailnet.length === 0 && lan.length === 0) {
      log(`Remote: http://<this-machine>:${port}/mcp`);
    }
    log(
      "Plain HTTP: use over Tailscale, WireGuard, or a trusted LAN, not the open internet."
    );
  } else if (isLoopbackAddress(httpHost)) {
    log("Remote bearer auth enabled on loopback (for reverse proxies).");
  } else {
    log(`Remote: http://${httpHost}:${port}/mcp`);
    log(
      "Plain HTTP: use over Tailscale, WireGuard, or a trusted LAN, not the open internet."
    );
  }
  log(
    "Auth: Authorization: Bearer <token> (run `aseprite-mcp token --remote` to print it)"
  );
};

const serve = async (args: string[]): Promise<void> => {
  const tailscale = args.includes("--tailscale");
  const remoteFlag = args.includes("--remote");
  const envHost = env.ASEPRITE_MCP_HTTP_HOST?.trim();
  const httpHost = envHost || (remoteFlag ? "0.0.0.0" : "127.0.0.1");
  const remote =
    remoteFlag ||
    Boolean(env.ASEPRITE_MCP_REMOTE_TOKEN) ||
    !isLoopbackAddress(httpHost);
  const tailnetEnv = {
    host: env.ASEPRITE_MCP_TAILNET_HOST,
    users: env.ASEPRITE_MCP_TAILNET_USERS,
  };
  let tailnet: Tailnet | null;
  try {
    const detect = tailscale && !tailnetEnvComplete(tailnetEnv);
    tailnet = resolveTailnet(
      tailnetEnv,
      detect ? await detectTailnet(httpPort) : null
    );
  } catch (error) {
    log(messageOf(error));
    return exit(1);
  }
  const workspace = createWorkspace();
  let remoteToken: string | null = null;
  if (remote) {
    try {
      remoteToken = await workspace.loadRemoteToken();
    } catch (error) {
      log(messageOf(error));
      return exit(1);
    }
  }
  const program: Program = await import(
    env.ASEPRITE_MCP_PROGRAM
      ? pathToFileURL(env.ASEPRITE_MCP_PROGRAM).href
      : "../src/program.ts"
  );
  const { startDaemon } = await import("../src/daemon.ts");
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      httpHost,
      httpPort,
      log,
      onShutdown: () => exit(0),
      program,
      remoteToken,
      tailnet,
      version,
      workspace,
      wsPort,
    });
  } catch (error) {
    log(messageOf(error));
    return exit(1);
  }
  if (!daemon) {
    log(`A daemon already answers on port ${httpPort}; leaving it running.`);
    if (tailnet || remote) {
      log(
        "That daemon may not have remote or tailnet access. Run `aseprite-mcp stop`, then start it again."
      );
      return exit(1);
    }
    return exit(0);
  }
  if (tailscale) {
    try {
      await serveOnTailnet(httpPort);
    } catch (error) {
      log(messageOf(error));
      await daemon.close();
      return exit(1);
    }
  }
  if (tailnet) {
    log(
      `Tailnet: https://${tailnet.host}/mcp for ${[...tailnet.users].join(", ")}`
    );
  }
  if (remote) {
    await logRemoteUrls(httpHost, daemon.port);
  }
  const stop = async (): Promise<void> => {
    try {
      await daemon.close();
    } finally {
      exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
};

const status = async (): Promise<void> => {
  const h = await health(httpPort);
  if (!h) {
    log(
      `No daemon on port ${httpPort}. Start one with \`aseprite-mcp serve\`.`
    );
    return exit(1);
  }
  stdout.write(`${JSON.stringify(h, null, 2)}\n`);
};

const stopDaemon = async (): Promise<void> => {
  if (!(await health(httpPort))) {
    stdout.write(`No daemon is running on port ${httpPort}.\n`);
    return;
  }
  if (!(await shutdown(httpPort))) {
    log(`The daemon on port ${httpPort} did not accept the stop request.`);
    return exit(1);
  }
  stdout.write(`Stopped the aseprite-mcp daemon on port ${httpPort}.\n`);
};

const token = async (rest: string[]): Promise<void> => {
  const renew = rest.includes("--new");
  const isRemote = rest.includes("--remote");
  const workspace = createWorkspace();
  const value = isRemote
    ? await workspace.loadRemoteToken({ renew })
    : await workspace.loadToken({ renew });
  stdout.write(`${value}\n`);
  if (renew) {
    log(
      isRemote
        ? "New remote token saved. Update remote MCP clients and run `aseprite-mcp stop` so the daemon picks it up."
        : "New token saved. Paste it into the Aseprite MCP window, and run `aseprite-mcp stop` so the daemon picks it up."
    );
  }
};

const [command, ...rest] = argv.slice(2);
const commands: Record<string, (() => Promise<void>) | undefined> = {
  serve: () => serve(rest),
  status,
  stop: stopDaemon,
  token: () => token(rest),
};

if (command === undefined) {
  await runProxy({ binPath, log, port: httpPort, version });
} else if (commands[command]) {
  await commands[command]();
} else {
  const asked = ["help", "--help", "-h"].includes(command);
  (asked ? stdout : stderr).write(USAGE);
  exit(asked ? 0 : 2);
}
