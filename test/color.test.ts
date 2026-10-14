import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  normHex,
  parseHex,
  formatHex,
  rgbToOklch,
  oklchToRgb,
  ramp,
  loadPalette,
  savePalette,
  loadPalettes,
} from "../src/color.ts";

test("hex parse and format accept every short and long form", () => {
  assert.equal(normHex("#ABC"), "aabbccff");
  assert.equal(normHex("abcd"), "aabbccdd");
  assert.equal(normHex("#112233"), "112233ff");
  assert.deepEqual(parseHex("#11223380"), [0x11, 0x22, 0x33, 0x80]);
  assert.equal(formatHex([17, 34, 51, 255]), "#112233");
  assert.equal(formatHex([17, 34, 51, 0]), "#11223300");
  assert.throws(() => parseHex("red"), /Not a colour/);
  assert.throws(() => parseHex("#12345"), /Not a colour/);
});

test("OKLCH round trip returns the same sRGB colour", () => {
  for (const c of ["#b13e53", "#38b764", "#29366f", "#f4f4f4", "#000000"]) {
    const [r, g, b] = parseHex(c);
    assert.deepEqual(oklchToRgb(...rgbToOklch(r, g, b)), [r, g, b], c);
  }
});

test("ramp keeps the base in the middle and runs dark to light", () => {
  const p = ramp("#b13e53", "abcde");
  assert.deepEqual(Object.keys(p), ["a", "b", "c", "d", "e"]);
  assert.equal(p.c, "#b13e53");
  const L = Object.values(p).map(
    (c) => rgbToOklch(...(parseHex(c).slice(0, 3) as [number, number, number]))[0]
  );
  for (let i = 1; i < L.length; i++) {
    assert.ok(L[i] > L[i - 1], `L rises at ${i}: ${L}`);
  }
});

test("hueShift 0 keeps the hue; a larger shift moves the shadow further", () => {
  const hue = (c: string) =>
    rgbToOklch(...(parseHex(c).slice(0, 3) as [number, number, number]))[2];
  const base = hue("#38b764");
  const flat = ramp("#38b764", "abc", { hueShift: 0 });
  assert.ok(Math.abs(hue(flat.a) - base) < 1);
  const shifted = ramp("#38b764", "abc", { hueShift: 40 });
  assert.ok(Math.abs(hue(shifted.a) - base) > 10);
});

test("ramp rejects skip characters and duplicate keys", () => {
  assert.throws(() => ramp("#b13e53", "a.b"), /cannot be palette keys/);
  assert.throws(() => ramp("#b13e53", "aa"), /distinct/);
});

test("named palettes save, load and survive other names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "palettes-"));
  try {
    const file = join(dir, "nested", "palettes.json");
    assert.deepEqual(await loadPalettes(file), {});
    await savePalette(file, "skin", { a: "#ffcd75", b: "#b13e53" });
    await savePalette(file, "sea", { s: "#29366f" });
    assert.deepEqual(await loadPalette(file, "skin"), {
      a: "#ffcd75",
      b: "#b13e53",
    });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf-8"))), [
      "skin",
      "sea",
    ]);
    await assert.rejects(
      loadPalette(file, "nope"),
      /No saved palette 'nope'. Saved: skin, sea/
    );
    await assert.rejects(
      savePalette(file, "bad", { x: "blue" }),
      /Not a colour/
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
