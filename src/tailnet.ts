// Tailnet access and remote address discovery for `serve`: Tailscale CLI lookup (including the macOS app bundle),
// `tailscale status` / `tailscale serve`, and OS interface inspection for Linux and macOS.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { platform as currentPlatform, stderr } from "node:process";
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

export interface RemoteAddresses {
  /** Tailscale MagicDNS name (when available) and Tailscale IPv4 addresses, each with `:port`. */
  tailnet: string[];
  /** Non-virtual LAN or VPN IPv4 addresses, each with `:port`. */
  lan: string[];
}

interface TailscaleStatus {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; UserID?: unknown };
  User?: Record<string, { LoginName?: unknown } | undefined>;
}

export const MAC_TAILSCALE_APP =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const execFileAsync = promisify(execFile);
const TRAILING_DOT = /\.$/u;
const SERVE_TIMEOUT_MS = 30_000;
const NOT_INSTALLED =
  "The tailscale command is not on PATH. Install the Tailscale CLI, or set ASEPRITE_MCP_TAILNET_HOST and ASEPRITE_MCP_TAILNET_USERS and run `tailscale serve` yourself.";

// Container, VM, loopback and Apple-internal interfaces skipped for LAN address printing.
// Tailscale IPs (100.64.0.0/10) are matched before this filter so macOS `utun*` and Linux `tailscale0` both work.
const VIRTUAL_PREFIXES = [
  "anpi",
  "ap",
  "awdl",
  "br-",
  "bridge",
  "cni",
  "docker",
  "flannel",
  "kube",
  "llw",
  "lo",
  "podman",
  "tailscale",
  "utun",
  "vboxnet",
  "veth",
  "virbr",
  "vmnet",
];

const isStatus = (value: unknown): value is TailscaleStatus =>
  typeof value === "object" && value !== null;

const parseIpv4 = (ip: string): [number, number, number, number] | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((p) => (/^\d{1,3}$/u.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) {
    return null;
  }
  return nums as [number, number, number, number];
};

/** True when `ip` is in Tailscale's CGNAT range (100.64.0.0/10). */
export const isTailnetIp = (ip: string): boolean => {
  const octets = parseIpv4(ip);
  return (
    octets !== null && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
  );
};

const isLoopbackOrLinkLocal = (ip: string): boolean => {
  const octets = parseIpv4(ip);
  if (!octets) {
    return true;
  }
  return octets[0] === 127 || (octets[0] === 169 && octets[1] === 254);
};

const isVirtualInterface = (name: string): boolean => {
  const lower = name.toLowerCase();
  return VIRTUAL_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/** Candidate commands to try when invoking the Tailscale CLI (`tailscale`, plus the macOS app bundle fallback). */
export const tailscaleCandidates = (
  platform: NodeJS.Platform = currentPlatform,
  hasMacApp: () => boolean = () => existsSync(MAC_TAILSCALE_APP)
): string[] =>
  platform === "darwin" && hasMacApp()
    ? ["tailscale", MAC_TAILSCALE_APP]
    : ["tailscale"];

/** Splits OS network interfaces into Tailscale IPv4 addresses and non-virtual LAN IPv4 addresses. */
export const collectAddresses = (
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): { tailnet: string[]; lan: string[] } => {
  const tailnet = new Set<string>();
  const lan = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      const { address } = entry;
      if (isLoopbackOrLinkLocal(address)) {
        continue;
      }
      if (isTailnetIp(address)) {
        tailnet.add(address);
      } else if (!isVirtualInterface(name)) {
        lan.add(address);
      }
    }
  }
  return { lan: [...lan], tailnet: [...tailnet] };
};

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

const tryTailscale = async <T>(
  candidates: readonly string[],
  run: (cmd: string) => Promise<T>
): Promise<T> => {
  const [first, ...rest] = candidates;
  if (!first) {
    throw new Error(NOT_INSTALLED);
  }
  try {
    return await run(first);
  } catch (error) {
    if (isMissing(error) && rest.length > 0) {
      return tryTailscale(rest, run);
    }
    throw error;
  }
};

const execTailscale = (args: string[]): Promise<string> =>
  tryTailscale(tailscaleCandidates(), async (cmd) => {
    const { stdout } = await execFileAsync(cmd, args);
    return stdout;
  });

/** Reads `tailscale status --json` for this machine's tailnet Host and owner. */
export const detectTailnet = async (port: number): Promise<Tailnet> => {
  let stdout: string;
  try {
    stdout = await execTailscale(["status", "--json"]);
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

/** Best-effort MagicDNS name from `tailscale status --json`, or null when unavailable. */
export const detectMagicDns = async (): Promise<string | null> => {
  try {
    const stdout = await execTailscale(["status", "--json"]);
    const status: unknown = JSON.parse(stdout);
    const dnsName = isStatus(status) ? status.Self?.DNSName : undefined;
    if (typeof dnsName !== "string") {
      return null;
    }
    const clean = dnsName.replace(TRAILING_DOT, "").trim();
    return clean || null;
  } catch {
    return null;
  }
};

/** Reachable `host:port` addresses for printing when `--remote` binds a wildcard address. */
export const detectRemoteAddresses = async (
  port: number
): Promise<RemoteAddresses> => {
  const { tailnet: tailnetIps, lan: lanIps } =
    collectAddresses(networkInterfaces());
  const magicDns = tailnetIps.length > 0 ? await detectMagicDns() : null;
  const tailnet = [
    ...(magicDns ? [`${magicDns}:${port}`] : []),
    ...tailnetIps.map((ip) => `${ip}:${port}`),
  ];
  const lan = lanIps.map((ip) => `${ip}:${port}`);
  return { lan, tailnet };
};

const spawnTailscaleServe = async (
  cmd: string,
  port: number
): Promise<unknown> => {
  const child = spawn(
    cmd,
    ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`],
    { stdio: ["ignore", stderr, stderr] }
  );
  const timeout = new AbortController();
  try {
    const [code] = await Promise.race([
      once(child, "exit"),
      sleep(SERVE_TIMEOUT_MS, null, { signal: timeout.signal }).then(() => {
        child.kill();
        throw new Error(
          `\`tailscale serve\` did not finish within ${SERVE_TIMEOUT_MS / 1000} s. If it printed a link, open it to enable Serve for your tailnet, then start the daemon again.`
        );
      }),
    ]);
    return code;
  } finally {
    timeout.abort();
  }
};

/**
 * Points `tailscale serve` at the daemon. Running it again keeps the same proxy. Its output goes to stderr, where
 * the user sees the link Tailscale prints when the tailnet has not enabled Serve yet; in that case it waits for
 * Serve to be enabled, so it gets a time limit.
 */
export const serveOnTailnet = async (port: number): Promise<void> => {
  let code: unknown;
  try {
    code = await tryTailscale(tailscaleCandidates(), (cmd) =>
      spawnTailscaleServe(cmd, port)
    );
  } catch (error) {
    throw isMissing(error) ? new Error(NOT_INSTALLED, { cause: error }) : error;
  }
  if (code !== 0) {
    throw new Error(`\`tailscale serve\` exited with code ${String(code)}.`);
  }
};
