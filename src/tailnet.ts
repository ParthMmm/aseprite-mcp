// Tailnet access for `serve`: which Host and Tailscale users the daemon admits, from environment variables or
// `tailscale status`, and the `tailscale serve` proxy that carries those requests to the loopback port.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

import type { Tailnet } from "./daemon.ts";

const run = promisify(execFile);
const TRAILING_DOT = /\.$/u;
const NOT_INSTALLED =
  "The tailscale command is not on PATH. Install the Tailscale CLI, or set ASEPRITE_MCP_TAILNET_HOST and ASEPRITE_MCP_TAILNET_USERS and run `tailscale serve` yourself.";

export interface TailnetEnv {
  host?: string;
  users?: string;
}

interface Status {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; UserID?: unknown };
  User?: Record<string, { LoginName?: unknown } | undefined>;
}

/** `tailscale status --json` -> the Host header `tailscale serve --https=<port>` forwards, and this machine's owner. */
export const tailnetFromStatus = (status: unknown, port: number): Tailnet => {
  const { BackendState, Self, User } = (status ?? {}) as Status;
  if (BackendState !== undefined && BackendState !== "Running") {
    throw new Error(
      `Tailscale is not connected (state: ${String(BackendState)}). Run \`tailscale up\`.`
    );
  }
  const dnsName = Self?.DNSName;
  if (typeof dnsName !== "string" || dnsName === "") {
    throw new Error(
      "`tailscale status` shows no DNS name for this machine. Turn on MagicDNS, or set ASEPRITE_MCP_TAILNET_HOST."
    );
  }
  const login = User?.[String(Self?.UserID)]?.LoginName;
  if (typeof login !== "string" || login === "") {
    throw new Error(
      "`tailscale status` shows no owner for this machine. Set ASEPRITE_MCP_TAILNET_USERS."
    );
  }
  return {
    host: `${dnsName.replace(TRAILING_DOT, "")}:${port}`,
    users: new Set([login]),
  };
};

/** Environment variables override what `tailscale status` found. Null when nothing enables tailnet access. */
export const resolveTailnet = (
  { host, users }: TailnetEnv,
  detected: Tailnet | null
): Tailnet | null => {
  const logins = (users ?? "")
    .split(",")
    .map((login) => login.trim())
    .filter(Boolean);
  const resolvedHost = host?.trim() || detected?.host;
  const resolvedUsers = logins.length > 0 ? new Set(logins) : detected?.users;
  if (resolvedHost && resolvedUsers) {
    return { host: resolvedHost, users: resolvedUsers };
  }
  if (resolvedHost || resolvedUsers) {
    throw new Error(
      "Tailnet access needs both ASEPRITE_MCP_TAILNET_HOST and ASEPRITE_MCP_TAILNET_USERS, or `serve --tailscale`."
    );
  }
  return null;
};

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

/** Reads `tailscale status --json` for this machine's tailnet Host and owner. */
export const detectTailnet = async (port: number): Promise<Tailnet> => {
  let stdout: string;
  try {
    ({ stdout } = await run("tailscale", ["status", "--json"]));
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(NOT_INSTALLED, { cause: error });
    }
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(
      `\`tailscale status\` failed: ${stderr || (error as Error).message}`,
      { cause: error }
    );
  }
  return tailnetFromStatus(JSON.parse(stdout), port);
};

/**
 * Points `tailscale serve` at the daemon. Running it again keeps the same proxy. Its output goes to stderr, where
 * the user sees the link Tailscale prints when the tailnet has not enabled Serve yet.
 */
export const serveOnTailnet = async (port: number): Promise<void> => {
  const child = spawn(
    "tailscale",
    ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`],
    { stdio: ["ignore", process.stderr, process.stderr] }
  );
  let code: unknown;
  try {
    [code] = await once(child, "exit");
  } catch (error) {
    throw isMissing(error) ? new Error(NOT_INSTALLED, { cause: error }) : error;
  }
  if (code !== 0) {
    throw new Error(`\`tailscale serve\` exited with code ${String(code)}.`);
  }
};
