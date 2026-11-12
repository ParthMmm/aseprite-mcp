// Tailnet access for `serve`: which Host and Tailscale users the daemon admits, from environment variables or
// `tailscale status`, and the `tailscale serve` proxy that carries those requests to the loopback port.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { stderr } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { messageOf } from "./check.ts";
import { isMissing } from "./files.ts";

/** Callers that reach the daemon through `tailscale serve`. */
export interface Tailnet {
  /** The Host header the proxy forwards, such as `machine.example-tailnet.ts.net:9124`. */
  host: string;
  /** Tailscale logins allowed in, such as `alice@example.com`. */
  users: ReadonlySet<string>;
}

export interface TailnetEnv {
  host?: string;
  users?: string;
}

interface TailscaleStatus {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; UserID?: unknown };
  User?: Record<string, { LoginName?: unknown } | undefined>;
}

const execFileAsync = promisify(execFile);
const TRAILING_DOT = /\.$/u;
const SERVE_TIMEOUT_MS = 30_000;
const NOT_INSTALLED =
  "The tailscale command is not on PATH. Install the Tailscale CLI, or set ASEPRITE_MCP_TAILNET_HOST and ASEPRITE_MCP_TAILNET_USERS and run `tailscale serve` yourself.";

const isStatus = (value: unknown): value is TailscaleStatus =>
  typeof value === "object" && value !== null;

/** `tailscale status --json` -> the Host header `tailscale serve --https=<port>` forwards, and this machine's owner. */
export const tailnetFromStatus = (status: unknown, port: number): Tailnet => {
  const { BackendState, Self, User } = isStatus(status) ? status : {};
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

const parseUsers = (users: string | undefined): string[] =>
  (users ?? "")
    .split(",")
    .map((login) => login.trim())
    .filter(Boolean);

/** True when the environment alone sets the tailnet Host and users, so `tailscale status` has nothing to add. */
export const tailnetEnvComplete = ({ host, users }: TailnetEnv): boolean =>
  Boolean(host?.trim()) && parseUsers(users).length > 0;

/** Environment variables override what `tailscale status` found. Null when nothing enables tailnet access. */
export const resolveTailnet = (
  { host, users }: TailnetEnv,
  detected: Tailnet | null
): Tailnet | null => {
  const logins = parseUsers(users);
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

const stderrOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "stderr" in error
    ? String(error.stderr).trim()
    : "";

/** Reads `tailscale status --json` for this machine's tailnet Host and owner. */
export const detectTailnet = async (port: number): Promise<Tailnet> => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("tailscale", ["status", "--json"]));
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(NOT_INSTALLED, { cause: error });
    }
    throw new Error(
      `\`tailscale status\` failed: ${stderrOf(error) || messageOf(error)}`,
      { cause: error }
    );
  }
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch (error) {
    throw new Error("`tailscale status --json` did not print valid JSON.", {
      cause: error,
    });
  }
  return tailnetFromStatus(status, port);
};

/**
 * Points `tailscale serve` at the daemon. Running it again keeps the same proxy. Its output goes to stderr, where
 * the user sees the link Tailscale prints when the tailnet has not enabled Serve yet; in that case it waits for
 * Serve to be enabled, so it gets a time limit.
 */
export const serveOnTailnet = async (port: number): Promise<void> => {
  const child = spawn(
    "tailscale",
    ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`],
    { stdio: ["ignore", stderr, stderr] }
  );
  const timeout = new AbortController();
  let code: unknown;
  try {
    [code] = await Promise.race([
      once(child, "exit"),
      sleep(SERVE_TIMEOUT_MS, null, { signal: timeout.signal }).then(() => {
        child.kill();
        throw new Error(
          `\`tailscale serve\` did not finish within ${SERVE_TIMEOUT_MS / 1000} s. If it printed a link, open it to enable Serve for your tailnet, then start the daemon again.`
        );
      }),
    ]);
  } catch (error) {
    throw isMissing(error) ? new Error(NOT_INSTALLED, { cause: error }) : error;
  } finally {
    timeout.abort();
  }
  if (code !== 0) {
    throw new Error(`\`tailscale serve\` exited with code ${String(code)}.`);
  }
};
