import assert from "node:assert/strict";
import { test } from "node:test";

import * as R from "../src/raster.ts";

const P = { b: "#0000ff", g: "#00ff00", k: "#000000", r: "#ff0000" };

/** rows -> canvas (width = longest row) */
function canvas(rows, palette = P) {
  const cv = R.blank(Math.max(...rows.map((r) => r.length)), rows.length);
  R.map(cv, palette, rows);
  return cv;
}
/** canvas -> full-width rows with the test palette's keys */
const show = (cv, palette = P) =>
  R.read(cv, { palette }).rows.map((r) => r.padEnd(cv.width, "."));

test("map writes keys, skips '.' and ' ', erases with #00000000, honours the offset", () => {
  const cv = canvas(["rrrrr", "rrrrr", "rrrrr"]);
  const n = R.map(cv, { e: "#00000000", g: "#00ff00" }, ["g. e", "gg"], {
    x: 1,
    y: 1,
  });
  assert.equal(n, 4);
  assert.deepEqual(show(cv), ["rrrrr", "rgrr.", "rggrr"]);
});

test("map flips h, v and hv", () => {
  const rows = ["rg", "b."];
  const at = (flip) => {
    const cv = R.blank(2, 2);
    R.map(cv, P, rows, { flip });
    return show(cv);
  };
  assert.deepEqual(at("h"), ["gr", ".b"]);
  assert.deepEqual(at("v"), ["b.", "rg"]);
  assert.deepEqual(at("hv"), [".b", "gr"]);
});

test("map with an unknown character throws and changes nothing", () => {
  const cv = R.blank(3, 1);
  assert.throws(
    () => R.map(cv, P, ["rzq"]),
    /Characters not in palette: "z", "q"/
  );
  assert.deepEqual(show(cv), ["..."]);
});

test("map clips to the canvas and counts only changed pixels", () => {
  const cv = canvas(["r."]);
  assert.equal(R.map(cv, P, ["rrr"], { x: 0 }), 1);
  assert.equal(R.map(cv, P, ["rr"], { x: -1, y: 0 }), 0);
});

test("px and line", () => {
  const cv = R.blank(5, 4);
  assert.equal(
    R.px(cv, [
      [0, 0, "#f00"],
      [9, 9, "#f00"],
    ]),
    1
  );
  assert.equal(R.line(cv, 0, 3, 4, 1, "#00f"), 5);
  assert.deepEqual(show(cv), ["r....", "...bb", ".bb..", "b...."]);
});

test("rect outline, fill and clipping", () => {
  const cv = R.blank(5, 4);
  assert.equal(R.rect(cv, [0, 0, 4, 3], "#000"), 10);
  assert.equal(R.rect(cv, [3, 2, 9, 9], "#f00", { fill: true }), 4);
  assert.deepEqual(show(cv), ["kkkk.", "k..k.", "kkkrr", "...rr"]);
  assert.throws(() => R.rect(cv, [0, 0, 2], "#000"), /rect must be/);
});

test("ellipse outline and fill have the pixel-art shape", () => {
  const ring = R.blank(5, 5);
  assert.equal(R.ellipse(ring, [0, 0, 5, 5], "#000"), 12);
  assert.deepEqual(show(ring), [".kkk.", "k...k", "k...k", "k...k", ".kkk."]);
  const disc = R.blank(6, 6);
  assert.equal(R.ellipse(disc, [0, 0, 6, 6], "#000", { fill: true }), 24);
  assert.deepEqual(show(disc), [
    "..kk..",
    ".kkkk.",
    "kkkkkk",
    "kkkkkk",
    ".kkkk.",
    "..kk..",
  ]);
  const dot = R.blank(3, 3);
  R.ellipse(dot, [0, 0, 3, 3], "#000");
  assert.deepEqual(show(dot), [".k.", "k.k", ".k."]);
});

test("fill stays inside its exact-colour region and does not leak diagonally", () => {
  const cv = canvas(["...k.", "..k..", "kk...", "....."]);
  assert.equal(R.fill(cv, 0, 0, "#f00"), 5);
  assert.deepEqual(show(cv), ["rrrk.", "rrk..", "kk...", "....."]);
  assert.equal(R.fill(cv, 0, 0, "#f00"), 0);
  assert.equal(R.fill(cv, 9, 0, "#f00"), 0);
});

test("fill on a coloured region replaces only that colour", () => {
  const cv = canvas(["rrg", "grr", "rrr"]);
  assert.equal(R.fill(cv, 2, 2, "#00f"), 7);
  assert.deepEqual(show(cv), ["bbg", "gbb", "bbb"]);
});

test("outline outside and inside use the given colour", () => {
  const shape = () => canvas(["....", ".rr.", ".rr.", "...."]);
  const out = shape();
  assert.equal(R.outline(out, "#000", { mode: "outside" }), 8);
  assert.deepEqual(show(out), [".kk.", "krrk", "krrk", ".kk."]);
  const ins = canvas(["rrr", "rrr", "rrr"]);
  assert.equal(R.outline(ins, "#000", { mode: "inside" }), 8);
  assert.deepEqual(show(ins), ["kkk", "krk", "kkk"]);
});

test("selective outline darkens the bordering colour, darker on the shadow side", () => {
  const cv = canvas(["...", ".r.", "..."]);
  assert.equal(R.outline(cv, null, { rect: [0, 0, 3, 3] }), 4);
  const { palette, rows } = R.read(cv, { palette: { r: "#ff0000" } });
  const at = (x, y) => palette[rows[y][x]];
  const lum = (c) =>
    Number.parseInt(c.slice(1, 3), 16) +
    Number.parseInt(c.slice(3, 5), 16) +
    Number.parseInt(c.slice(5, 7), 16);
  assert.equal(rows[0][0], ".");
  assert.ok(lum(at(1, 0)) > lum(at(1, 2)), "top edge faces the light");
  assert.ok(lum(at(0, 1)) > lum(at(2, 1)), "left edge faces the light");
  assert.ok(lum(at(1, 2)) < lum("#ff0000"));
});

test("outline respects rect", () => {
  const cv = canvas(["....", ".rr.", ".rr.", "...."]);
  assert.equal(
    R.outline(cv, "#000", { mode: "outside", rect: [0, 0, 4, 1] }),
    2
  );
  assert.deepEqual(show(cv), [".kk.", ".rr.", ".rr.", "...."]);
});

test("shift moves a rect and leaves transparency behind", () => {
  const cv = canvas(["rg..", "b...", "...."]);
  assert.equal(R.shift(cv, 2, 1, { rect: [0, 0, 2, 2] }), 6);
  assert.deepEqual(show(cv), ["....", "..rg", "..b."]);
  const whole = canvas(["rg"]);
  assert.equal(R.shift(whole, 1, 0), 2);
  assert.deepEqual(show(whole), [".r"]);
});

test("copy from another canvas with flip, and within the same canvas", () => {
  const src = canvas(["rg", "b."]);
  const dst = R.blank(4, 2);
  assert.equal(R.copy(dst, src, { flip: "h", x: 2 }), 3);
  assert.deepEqual(show(dst), ["..gr", "...b"]);
  const self = canvas(["rg..", "bk.."]);
  assert.equal(R.copy(self, self, { flip: "v", rect: [0, 0, 2, 2], x: 2 }), 4);
  assert.deepEqual(show(self), ["rgbk", "bkrg"]);
});

test("copy overwrites with the source's transparent pixels", () => {
  const dst = canvas(["kk"]);
  assert.equal(R.copy(dst, canvas(["r."])), 2);
  assert.deepEqual(show(dst), ["r."]);
});

test("recolor and clear honour rect", () => {
  const cv = canvas(["rrg", "rrg"]);
  assert.equal(
    R.recolor(cv, { "#ff0000": "#0000ff" }, { rect: [1, 0, 2, 2] }),
    2
  );
  assert.deepEqual(show(cv), ["rbg", "rbg"]);
  assert.equal(R.clear(cv, [0, 1, 9, 9]), 3);
  assert.equal(R.clear(cv), 3);
  assert.deepEqual(show(cv), ["...", "..."]);
});

test("crop pads with transparency outside the canvas", () => {
  const out = R.crop(canvas(["rg", "bk"]), [1, 1, 2, 2]);
  assert.equal(out.width, 2);
  assert.deepEqual(show(out), ["k.", ".."]);
});

test("read keeps the given palette's keys and gives new colours fresh keys", () => {
  const cv = canvas(["rg.", "..x"], {
    g: "#00ff00",
    r: "#ff0000",
    x: "#12345680",
  });
  const res = R.read(cv, { palette: { G: "#00ff00" } });
  assert.deepEqual(res.rows, ["aG", "..b"]);
  assert.deepEqual(res.palette, { G: "#00ff00", a: "#ff0000", b: "#12345680" });
  assert.deepEqual(R.read(cv, { rect: [1, 0, 1, 1] }).rows, ["a"]);
});

test("read -> map round trip is the identity, semi-transparent pixels included", () => {
  const cv = R.blank(7, 5);
  for (let i = 0; i < cv.data.length; i += 4) {
    const p = i / 4;
    if (p % 3 === 0) {
      continue;
    }
    cv.data.set(
      [(p * 37) % 256, (p * 91) % 256, (p * 13) % 256, p % 5 === 0 ? 128 : 255],
      i
    );
  }
  const { palette, rows } = R.read(cv);
  const back = R.blank(7, 5);
  R.map(back, palette, rows);
  assert.deepEqual(back.data, cv.data);
});
