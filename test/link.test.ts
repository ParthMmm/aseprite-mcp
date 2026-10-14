import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
// src/link.ts against a real ws client that plays the Aseprite extension.
import { test } from "node:test";

import WebSocket from "ws";

import { createLink, NOT_CONNECTED } from "../src/link.ts";
import { PROTOCOL, encodeFrame, decodeFrame } from "../src/wire.ts";

const TOKEN = "a".repeat(48);
function hmac(token, text) {
  return createHmac("sha256", token).update(text).digest("hex");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connects and pairs like plugin.lua. `onRequest(msg, blobs)` returns `{ result, blobs? }` or `{ error }` or undefined (no reply).
async function fakeExtension(
  port,
  {
    token = TOKEN,
    extension = "0.1.0",
    onRequest = () => ({ result: {} }),
  } = {}
) {
  const url = `ws://127.0.0.1:${port}`;
  const ws = new WebSocket(url);
  const clientNonce = randomBytes(16).toString("hex");
  let serverNonce;
  const outcome = new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const { msg, blobs } = decodeFrame(data);
        return reply(msg, blobs);
      }
      const msg = JSON.parse(data.toString());
      const kind = msg.type;
      if (kind === "challenge") {
        serverNonce = msg.nonce;
        ws.send(
          JSON.stringify({
            extension,
            mac: hmac(token, `client|${serverNonce}|${clientNonce}`),
            nonce: clientNonce,
            type: "hello",
            v: PROTOCOL,
            version: "1.3.18",
          })
        );
      } else if (kind === "welcome") {
        assert.equal(
          msg.mac,
          hmac(TOKEN, `server|${clientNonce}|${serverNonce}`),
          "server proves it knows the token"
        );
        resolve("welcome");
      } else if (kind === "denied") {
        resolve("denied");
      } else {
        reply(msg, []);
      }
    });
  });
  function reply(msg, blobs) {
    const out = onRequest(msg, blobs);
    if (!out) {
      return;
    }
    const body = out.error
      ? { error: out.error, id: msg.id, ok: false }
      : { id: msg.id, ok: true, result: out.result };
    ws.send(
      out.blobs?.length ? encodeFrame(body, out.blobs) : JSON.stringify(body)
    );
  }
  return { outcome: await outcome, ws };
}

async function withLink(opts, fn) {
  const link = createLink({ port: 0, token: TOKEN, ...opts });
  await link.listening;
  try {
    await fn(link);
  } finally {
    await link.close();
  }
}

test("pairs with the HMAC handshake and answers TEXT requests", () =>
  withLink({}, async (link) => {
    const seen = [];
    const { ws, outcome } = await fakeExtension(link.status().port, {
      onRequest: (msg, blobs) => (
        seen.push({ binary: blobs.length > 0, msg }),
        { result: { echo: msg.args.n } }
      ),
    });
    assert.equal(outcome, "welcome");
    assert.deepEqual(link.status(), {
      connected: true,
      error: null,
      extension: "0.1.0",
      port: link.status().port,
    });
    assert.deepEqual(await link.request("info", { n: 7 }), {
      blobs: [],
      result: { echo: 7 },
    });
    assert.deepEqual(seen, [
      { binary: false, msg: { args: { n: 7 }, cmd: "info", id: 1 } },
    ]);
    ws.close();
  }));

test("sends blobs as one BINARY frame and resolves with the reply's blobs", () =>
  withLink({}, async (link) => {
    const { ws } = await fakeExtension(link.status().port, {
      onRequest: (msg, blobs) => ({
        blobs: [Uint8Array.of(9, 8), Uint8Array.of()],
        result: { got: blobs.map((b) => [...b]) },
      }),
    });
    const { result, blobs } = await link.request("commit", { sprite: 1 }, [
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(4),
    ]);
    assert.deepEqual(result, { got: [[1, 2, 3], [4]] });
    assert.deepEqual(
      blobs.map((b) => [...b]),
      [[9, 8], []]
    );
    ws.close();
  }));

test("a bad token is denied and the link stays disconnected", () =>
  withLink({}, async (link) => {
    const { ws, outcome } = await fakeExtension(link.status().port, {
      token: "b".repeat(48),
    });
    assert.equal(outcome, "denied");
    assert.equal(link.status().connected, false);
    ws.close();
  }));

test("{ok:false} rejects with the extension's message", () =>
  withLink({}, async (link) => {
    const { ws } = await fakeExtension(link.status().port, {
      onRequest: () => ({ error: "No open sprite 'x'." }),
    });
    await assert.rejects(link.request("open", { path: "x" }), {
      message: "No open sprite 'x'.",
    });
    ws.close();
  }));

test("a request without a reply times out; snapshot and commit get the long timeout", () =>
  withLink({ longTimeoutMs: 300, timeoutMs: 50 }, async (link) => {
    const { ws } = await fakeExtension(link.status().port, {
      onRequest: () => {},
    });
    const t0 = Date.now();
    await assert.rejects(link.request("info"), {
      message: "Timeout while running 'info' (50 ms).",
    });
    await assert.rejects(link.request("snapshot"), {
      message: "Timeout while running 'snapshot' (300 ms).",
    });
    assert.ok(Date.now() - t0 >= 300);
    ws.close();
  }));

test("requests fail fast when Aseprite is not connected, and pending ones fail on disconnect", () =>
  withLink({}, async (link) => {
    await assert.rejects(link.request("info"), { message: NOT_CONNECTED });
    const { ws } = await fakeExtension(link.status().port, {
      onRequest: () => {},
    });
    const pending = link.request("info");
    ws.close();
    await assert.rejects(pending, {
      message: "Connection to Aseprite was lost.",
    });
    assert.equal(link.status().connected, false);
  }));

test("an old extension connects but the status warns", () =>
  withLink({}, async (link) => {
    const { ws } = await fakeExtension(link.status().port, {
      extension: "0.0.9",
    });
    assert.match(link.status().error, /0\.0\.9\) is older than 0\.1\.0/);
    ws.close();
  }));

test("a busy port is a retrying status, then the link binds once the port frees", async () => {
  const blocker = createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const { port } = blocker.address();
  const link = createLink({ port, retryMs: 100, token: TOKEN });
  try {
    await sleep(150);
    assert.match(link.status().error, new RegExp(`Port ${port} is busy`));
    await new Promise((r) => blocker.close(r));
    await link.listening;
    assert.equal(link.status().error, null);
    const { outcome, ws } = await fakeExtension(port);
    assert.equal(outcome, "welcome");
    ws.close();
  } finally {
    await link.close();
  }
});
