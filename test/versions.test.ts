import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MIN_EXTENSION } from "../src/link.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf-8"));
const parts = (v: string) => v.split(".").map(Number);
const atLeast = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {return x[i] > y[i];}
  }
  return true;
};

const extension = json("extension/package.json").version;

test("package.json and package-lock.json agree on the version", () => {
  const lock = json("package-lock.json");
  const pkg = json("package.json").version;
  assert.equal(lock.version, pkg);
  assert.equal(lock.packages[""].version, pkg);
});

test("the extension manifest and handlers.lua agree on the version", () => {
  const lua = readFileSync(join(root, "extension/handlers.lua"), "utf-8").match(
    /VERSION = "([^"]+)"/
  )?.[1];
  assert.equal(lua, extension);
});

test("the daemon accepts the extension it ships with", () => {
  assert.ok(
    atLeast(extension, MIN_EXTENSION),
    `extension ${extension} is older than MIN_EXTENSION ${MIN_EXTENSION}`
  );
});
