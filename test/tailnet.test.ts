import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
// Tailnet access: a daemon started with ASEPRITE_MCP_TAILNET_* admits requests that `tailscale serve` forwards
// for allowed users, and the pure config functions behind `serve --tailscale`.
import { test, before, after } from "node:test";

import { resolveTailnet, tailnetFromStatus } from "../src/tailnet.ts";
import { isolatedEnv, serve, waitForHealth } from "./fixtures/daemon-env.ts";

const TAILNET_HOST = "machine.example-tailnet.ts.net:9124";
const ALICE = "alice@example.com";
let ctx: Awaited<ReturnType<typeof isolatedEnv>>;

before(async () => {
  ctx = await isolatedEnv();
  serve({
    ...ctx.env,
    ASEPRITE_MCP_TAILNET_HOST: TAILNET_HOST,
    ASEPRITE_MCP_TAILNET_USERS: `${ALICE}, bob@example.com`,
  });
  await waitForHealth(ctx.base);
});
after(() => ctx.cleanup());

// What `tailscale serve` adds when it forwards a request from a tailnet user.
const viaTailscale = (login?: string): Record<string, string> => ({
  host: TAILNET_HOST,
  "x-forwarded-for": "100.64.0.2",
  "x-forwarded-host": TAILNET_HOST,
  "x-forwarded-proto": "https",
  ...(login === undefined ? {} : { "tailscale-user-login": login }),
});

// Raw request so the test controls the Host header (fetch does not allow overriding it).
const raw = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
) => {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number | undefined;
    body: string;
  }>();
  const req = request(
    { headers, host: "127.0.0.1", method, path, port: ctx.httpPort },
    (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d));
      res.on("end", () => resolve({ body: text, status: res.statusCode }));
    }
  );
  req.on("error", reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
};

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
  const content = await executeView({ host: `127.0.0.1:${ctx.httpPort}` });
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

test("a proxied request cannot pass as loopback by sending a loopback Host", async () => {
  const status = await health({
    ...viaTailscale("mallory@example.com"),
    host: `127.0.0.1:${ctx.httpPort}`,
  });
  assert.equal(status, 403);
});

test("tailnet callers cannot stop the daemon", async () => {
  const res = await raw("POST", "/shutdown", viaTailscale(ALICE));
  assert.equal(res.status, 403);
  await waitForHealth(ctx.base);
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
