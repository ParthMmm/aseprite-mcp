// Runs extension/handlers.lua inside real Aseprite (batch mode). Skips where Aseprite is not installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodeFrame, encodeFrame } from "../src/wire.ts";

const here = import.meta.dirname;
const ASEPRITE =
  process.env.ASEPRITE ?? "/Applications/Aseprite.app/Contents/MacOS/aseprite";
const skip = existsSync(ASEPRITE) ? false : `Aseprite not found at ${ASEPRITE}`;

interface LuaResult {
  cases: { name: string; ok: boolean; error?: string }[];
  [key: string]: unknown;
}

function runAseprite(): { dir: string; result: LuaResult } {
  const dir = mkdtempSync(join(tmpdir(), "aseprite-mcp-lua-"));
  const out = join(dir, "result.json");
  writeFileSync(
    join(dir, "node-frame.bin"),
    encodeFrame(
      { args: { list: [1, true], n: -2.5, text: 'é "q"\n' }, cmd: "x", id: 7 },
      [Uint8Array.of(1, 2, 3), new Uint8Array(0)]
    )
  );
  const run = spawnSync(
    ASEPRITE,
    [
      "-b",
      "--script-param",
      `ext=${join(here, "..", "extension")}`,
      "--script-param",
      `dir=${dir}`,
      "--script-param",
      `out=${out}`,
      "--script",
      join(here, "aseprite-handlers.lua"),
    ],
    { encoding: "utf-8", timeout: 60_000 }
  );
  assert.ok(
    existsSync(out),
    `Aseprite wrote no results (status ${run.status}):\n${run.stdout}\n${run.stderr}`
  );
  return { dir, result: JSON.parse(readFileSync(out, "utf-8")) };
}

describe("extension handlers in Aseprite", { skip }, () => {
  const { dir, result } = skip ? { dir: "", result: { cases: [] } as LuaResult } : runAseprite();
  after(() => {
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  for (const c of result.cases) {
    test(c.name, () => assert.ok(c.ok, c.error ?? "case failed"));
  }

  test("SHA-256 matches node:crypto", () => {
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    assert.deepEqual(result.sha, {
      abc: sha("abc"),
      empty: sha(""),
      long: sha("a".repeat(1000)),
    });
  });

  test("HMAC-SHA256 matches node:crypto, so pairing agrees with the daemon", () => {
    assert.equal(
      result.hmac,
      createHmac("sha256", "token-1234567890abcd")
        .update("client|a|b")
        .digest("hex")
    );
    assert.equal(
      result.hmacLongKey,
      createHmac("sha256", "k".repeat(100)).update("server|b|a").digest("hex")
    );
  });

  test("Node decodes the binary frame Lua encoded", () => {
    const { msg, blobs } = decodeFrame(
      readFileSync(join(dir, "lua-frame.bin"))
    );
    assert.deepEqual(msg, {
      id: 9,
      ok: true,
      result: { nested: { a: [1, 2] }, text: "ü\t" },
    });
    assert.deepEqual(
      blobs.map((b) => [...b]),
      [
        [0, 255],
        [120, 121, 122],
      ]
    );
  });
});
