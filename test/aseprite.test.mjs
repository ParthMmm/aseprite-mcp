// Runs extension/handlers.lua inside real Aseprite (batch mode). Skips where Aseprite is not installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeFrame, encodeFrame } from "../src/wire.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ASEPRITE = process.env.ASEPRITE ?? "/Applications/Aseprite.app/Contents/MacOS/aseprite";
const skip = existsSync(ASEPRITE) ? false : `Aseprite not found at ${ASEPRITE}`;

function runAseprite() {
  const dir = mkdtempSync(join(tmpdir(), "aseprite-mcp-lua-"));
  const out = join(dir, "result.json");
  writeFileSync(
    join(dir, "node-frame.bin"),
    encodeFrame({ id: 7, cmd: "x", args: { text: 'é "q"\n', n: -2.5, list: [1, true] } }, [Uint8Array.of(1, 2, 3), new Uint8Array(0)]),
  );
  const run = spawnSync(
    ASEPRITE,
    ["-b", "--script-param", `ext=${join(here, "..", "extension")}`, "--script-param", `dir=${dir}`,
      "--script-param", `out=${out}`, "--script", join(here, "aseprite-handlers.lua")],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.ok(existsSync(out), `Aseprite wrote no results (status ${run.status}):\n${run.stdout}\n${run.stderr}`);
  return { dir, result: JSON.parse(readFileSync(out, "utf8")) };
}

describe("extension handlers in Aseprite", { skip }, () => {
  const { dir, result } = skip ? { result: { cases: [] } } : runAseprite();
  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  for (const c of result.cases) {
    test(c.name, () => assert.ok(c.ok, c.error));
  }

  test("SHA-256 matches node:crypto", () => {
    const sha = (s) => createHash("sha256").update(s).digest("hex");
    assert.deepEqual(result.sha, { empty: sha(""), abc: sha("abc"), long: sha("a".repeat(1000)) });
  });

  test("HMAC-SHA256 matches node:crypto, so pairing agrees with the daemon", () => {
    assert.equal(result.hmac, createHmac("sha256", "token-1234567890abcd").update("client|a|b").digest("hex"));
    assert.equal(result.hmacLongKey, createHmac("sha256", "k".repeat(100)).update("server|b|a").digest("hex"));
  });

  test("Node decodes the binary frame Lua encoded", () => {
    const { msg, blobs } = decodeFrame(readFileSync(join(dir, "lua-frame.bin")));
    assert.deepEqual(msg, { id: 9, ok: true, result: { text: "ü\t", nested: { a: [1, 2] } } });
    assert.deepEqual(blobs.map((b) => [...b]), [[0, 255], [120, 121, 122]]);
  });
});
