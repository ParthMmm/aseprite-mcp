import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import nodePath from "node:path";
// Tailnet and remote access: in-process daemon tests for `tailscale serve` request admission and inline images,
// plus CLI validation tests and pure config functions behind `serve --tailscale` and `serve --remote`.
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { startDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";
import { createWorkspace } from "../src/files.ts";
import type { Link } from "../src/link.ts";
import {
  MAC_TAILSCALE_APP,
  collectAddresses,
  isTailnetIp,
  resolveTailnet,
  tailnetEnvComplete,
  tailnetFromStatus,
  tailscaleCandidates,
} from "../src/tailnet.ts";
import {
  BIN,
  isolatedEnv,
  rawRequest,
  serve,
  waitForHealth,
} from "./fixtures/daemon-env.ts";
import * as fakeProgram from "./fixtures/fake-program.ts";

const TAILNET_HOST = "machine.example-tailnet.ts.net:9124";
const ALICE = "alice@example.com";

const disconnectedLink = (): Link => ({
  request: () => Promise.reject(new Error("not connected")),
  status: () => ({
    connected: false,
    error: null,
    extension: null,
    port: 0,
  }),
});

let dir: string;
let daemon: Daemon;
let base: string;

before(async () => {
  dir = mkdtempSync(nodePath.join(tmpdir(), "mcp-tailnet-"));
  const workspace = createWorkspace({
    allowedDirs: [dir],
    autosaveDir: null,
    libDir: null,
    palettesFile: nodePath.join(dir, "palettes.json"),
    spritesDir: dir,
    tokenEnv: "t".repeat(48),
    tokenFile: nodePath.join(dir, "token"),
    viewsDir: nodePath.join(dir, "views"),
  });
  const started = await startDaemon({
    httpPort: 0,
    link: disconnectedLink(),
    program: fakeProgram,
    tailnet: {
      host: TAILNET_HOST,
      users: new Set([ALICE, "bob@example.com"]),
    },
    version: "0.0.0",
    workspace,
    wsPort: 0,
  });
  assert.ok(started);
  daemon = started;
  base = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  await daemon.close().catch(() => null);
  rmSync(dir, { force: true, recursive: true });
});

// What `tailscale serve` adds when it forwards a request from a tailnet user.
const viaTailscale = (login?: string): Record<string, string> => ({
  host: TAILNET_HOST,
  "x-forwarded-for": "100.64.0.2",
  "x-forwarded-host": TAILNET_HOST,
  "x-forwarded-proto": "https",
  ...(login === undefined ? {} : { "tailscale-user-login": login }),
});

const raw = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) => rawRequest(daemon.port, method, path, headers, body);

interface Block {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

const executeView = async (headers: Record<string, string>) => {
  const res = await raw(
    "POST",
    "/mcp",
    {
      ...headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { code: "view" }, name: "execute" },
    }
  );
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body).result.content as Block[];
};

test("an allowed tailnet user can execute and gets image blocks without ?images=inline", async () => {
  const [text, image, ...extra] = await executeView(viaTailscale(ALICE));
  const [path] = JSON.parse(text?.text ?? "").images;
  assert.deepEqual(image, {
    data: readFileSync(path).toString("base64"),
    mimeType: "image/png",
    type: "image",
  });
  assert.deepEqual(extra, []);
});

test("loopback callers still get paths only unless they ask for inline images", async () => {
  const content = await executeView({ host: `127.0.0.1:${daemon.port}` });
  assert.deepEqual(
    content.map((b) => b.type),
    ["text"]
  );
});

const health = async (headers: Record<string, string>) => {
  const { status } = await raw("GET", "/health", headers);
  return status;
};

test("tailnet requests from other users, without a login, or for another host are rejected", async () => {
  assert.equal(await health(viaTailscale(ALICE)), 200);
  assert.equal(await health(viaTailscale("mallory@example.com")), 403);
  assert.equal(await health(viaTailscale()), 403);
  assert.equal(
    await health({
      ...viaTailscale(ALICE),
      host: "other.example-tailnet.ts.net:9124",
    }),
    403
  );
  assert.equal(
    await health({ ...viaTailscale(ALICE), origin: "https://evil.example" }),
    403
  );
  assert.equal(
    await health({ ...viaTailscale(ALICE), origin: `https://${TAILNET_HOST}` }),
    200
  );
});

test("a tailnet MCP call from a foreign Origin is rejected", async () => {
  const res = await raw(
    "POST",
    "/mcp",
    {
      ...viaTailscale(ALICE),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      origin: "https://evil.example",
    },
    { id: 1, jsonrpc: "2.0", method: "tools/list" }
  );
  assert.equal(res.status, 403);
});

test("serve with tailnet access fails when an older daemon already holds the port", async () => {
  const solo = await isolatedEnv();
  const { exited } = serve({
    ...solo.env,
    ASEPRITE_MCP_HTTP_PORT: String(daemon.port),
    ASEPRITE_MCP_TAILNET_HOST: TAILNET_HOST,
    ASEPRITE_MCP_TAILNET_USERS: ALICE,
  });
  const { code, stderr } = await exited;
  await solo.cleanup();
  assert.equal(code, 1);
  assert.match(stderr, /aseprite-mcp stop/u);
  await waitForHealth(base);
});

test("a proxied request cannot pass as loopback by sending a loopback Host", async () => {
  const status = await health({
    ...viaTailscale("mallory@example.com"),
    host: `127.0.0.1:${daemon.port}`,
  });
  assert.equal(status, 403);
});

test("tailnet callers cannot stop the daemon", async () => {
  const res = await raw("POST", "/shutdown", viaTailscale(ALICE));
  assert.equal(res.status, 403);
  await waitForHealth(base);
});

test("serve refuses to start with only one of the tailnet variables", async () => {
  const solo = await isolatedEnv();
  const { exited } = serve({
    ...solo.env,
    ASEPRITE_MCP_TAILNET_HOST: TAILNET_HOST,
  });
  const { code, stderr } = await exited;
  await solo.cleanup();
  assert.equal(code, 1);
  assert.match(stderr, /ASEPRITE_MCP_TAILNET_USERS/u);
});

const STATUS = {
  BackendState: "Running",
  Self: { DNSName: "machine.example-tailnet.ts.net.", UserID: 42 },
  User: {
    "42": { LoginName: ALICE },
    "7": { LoginName: "bob@example.com" },
  },
};

test("tailnetFromStatus takes this machine's DNS name without the trailing dot, and its owner", () => {
  assert.deepEqual(tailnetFromStatus(STATUS, 9124), {
    host: TAILNET_HOST,
    users: new Set([ALICE]),
  });
});

test("tailnetFromStatus explains a missing machine, owner or connection", () => {
  assert.throws(
    () => tailnetFromStatus({ ...STATUS, Self: undefined }, 9124),
    /no DNS name/u
  );
  assert.throws(
    () =>
      tailnetFromStatus(
        { ...STATUS, Self: { ...STATUS.Self, UserID: 99 } },
        9124
      ),
    /no owner/u
  );
  assert.throws(
    () => tailnetFromStatus({ ...STATUS, BackendState: "NeedsLogin" }, 9124),
    /tailscale up/u
  );
});

test("resolveTailnet lets the environment override detection", () => {
  const detected = tailnetFromStatus(STATUS, 9124);
  assert.equal(resolveTailnet({}, null), null);
  assert.deepEqual(resolveTailnet({}, detected), detected);
  assert.deepEqual(
    resolveTailnet({ users: " bob@example.com ,carol@example.com," }, detected),
    {
      host: TAILNET_HOST,
      users: new Set(["bob@example.com", "carol@example.com"]),
    }
  );
  assert.deepEqual(
    resolveTailnet(
      { host: "box.example-tailnet.ts.net:9200", users: ALICE },
      null
    ),
    { host: "box.example-tailnet.ts.net:9200", users: new Set([ALICE]) }
  );
  assert.throws(() => resolveTailnet({ users: ALICE }, null), /both/u);
});

test("tailnetEnvComplete is true only when the environment sets both the Host and a user", () => {
  assert.equal(tailnetEnvComplete({ host: TAILNET_HOST, users: ALICE }), true);
  assert.equal(tailnetEnvComplete({ host: TAILNET_HOST, users: " , " }), false);
  assert.equal(tailnetEnvComplete({ users: ALICE }), false);
});

const iface = (
  address: string,
  family: "IPv4" | "IPv6" = "IPv4",
  internal = false
): NetworkInterfaceInfo =>
  ({
    address,
    cidr: `${address}/24`,
    family,
    internal,
    mac: "00:00:00:00:00:00",
    netmask: "255.255.255.0",
  }) as NetworkInterfaceInfo;

test("isTailnetIp matches 100.64.0.0/10 only", () => {
  assert.equal(isTailnetIp("100.64.0.1"), true);
  assert.equal(isTailnetIp("100.127.255.254"), true);
  assert.equal(isTailnetIp("100.63.255.255"), false);
  assert.equal(isTailnetIp("100.128.0.1"), false);
  assert.equal(isTailnetIp("192.168.1.10"), false);
  assert.equal(isTailnetIp("127.0.0.1"), false);
  assert.equal(isTailnetIp("::1"), false);
});

test("collectAddresses detects Tailscale and LAN IPs on both Linux and macOS interfaces", () => {
  const linux = collectAddresses({
    "br-1a2b3c": [iface("172.18.0.1")],
    docker0: [iface("172.17.0.1")],
    enp5s0: [iface("192.168.1.42"), iface("fe80::1", "IPv6")],
    lo: [iface("127.0.0.1", "IPv4", true)],
    tailscale0: [iface("100.88.1.2")],
    veth99: [iface("172.19.0.2")],
    wg0: [iface("10.10.0.2")],
  });
  assert.deepEqual(linux, {
    lan: ["192.168.1.42", "10.10.0.2"],
    tailnet: ["100.88.1.2"],
  });

  // On macOS Tailscale runs on a utun interface; non-tailnet utun and Apple internal interfaces are skipped.
  const macos = collectAddresses({
    anpi0: [iface("169.254.10.1")],
    awdl0: [iface("10.0.99.1")],
    bridge0: [iface("192.168.64.1")],
    en0: [iface("192.168.1.20"), iface("169.254.1.2")],
    llw0: [iface("10.0.99.2")],
    lo0: [iface("127.0.0.1", "IPv4", true)],
    utun0: [iface("10.9.0.1")],
    utun4: [iface("100.99.4.5")],
  });
  assert.deepEqual(macos, {
    lan: ["192.168.1.20"],
    tailnet: ["100.99.4.5"],
  });
});

test("tailscaleCandidates adds the macOS app bundle fallback only on darwin when present", () => {
  assert.deepEqual(
    tailscaleCandidates("darwin", () => true),
    ["tailscale", MAC_TAILSCALE_APP]
  );
  assert.deepEqual(
    tailscaleCandidates("darwin", () => false),
    ["tailscale"]
  );
  assert.deepEqual(
    tailscaleCandidates("linux", () => true),
    ["tailscale"]
  );
});

const execFileAsync = promisify(execFile);

test("CLI `token --remote` and `serve --remote` wire bearer auth end to end", async () => {
  const remoteCtx = await isolatedEnv();
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [BIN, "token", "--remote"],
      { env: remoteCtx.env }
    );
    const remoteToken = stdout.trim();
    assert.equal(remoteToken.length, 48);
    assert.notEqual(remoteToken, remoteCtx.env.ASEPRITE_MCP_TOKEN);

    serve(remoteCtx.env, ["--remote"]);
    await waitForHealth(remoteCtx.base);

    const denied = await rawRequest(remoteCtx.httpPort, "GET", "/health", {
      host: `box.lan:${remoteCtx.httpPort}`,
    });
    assert.equal(denied.status, 401);

    const allowed = await rawRequest(remoteCtx.httpPort, "GET", "/health", {
      authorization: `Bearer ${remoteToken}`,
      host: `box.lan:${remoteCtx.httpPort}`,
    });
    assert.equal(allowed.status, 200);
  } finally {
    await remoteCtx.cleanup();
  }
});
