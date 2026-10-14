import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

import {
  encodePng,
  composite,
  renderView,
  critiqueSheet,
  frameStrip,
} from "../src/render.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcOf = (buf: Uint8Array) => {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
};

/** Minimal decoder for the PNGs encodePng writes: checks every chunk CRC and returns RGBA. */
const decodePng = (png: Buffer) => {
  assert.deepEqual([...png.subarray(0, 8)], SIGNATURE);
  const chunks = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.toString("ascii", o + 4, o + 8);
    const body = png.subarray(o + 8, o + 8 + len);
    assert.equal(
      png.readUInt32BE(o + 8 + len),
      crcOf(png.subarray(o + 4, o + 8 + len)),
      `${type} crc`
    );
    chunks.push({ body, type });
    o += 12 + len;
  }
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "IDAT", "IEND"]
  );
  const ihdr = chunks[0].body;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual(
    [...ihdr.subarray(8)],
    [8, 6, 0, 0, 0],
    "8-bit RGBA, no interlace"
  );
  const raw = inflateSync(chunks[1].body);
  assert.equal(raw.length, (width * 4 + 1) * height);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0, "filter 0");
    data.set(
      raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)),
      y * width * 4
    );
  }
  return { data, height, width };
};
const pixel = (
  img: { data: Uint8Array; width: number },
  x: number,
  y: number
) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

test("encodePng round trips through a strict decoder", () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 29) % 256);
  const img = decodePng(encodePng(3, 2, rgba));
  assert.equal(img.width, 3);
  assert.equal(img.height, 2);
  assert.deepEqual(img.data, rgba);
});

test("composite blends visible layers bottom to top at their opacity", () => {
  const bottom = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 10, 20, 30, 255]);
  const top = new Uint8Array([0, 0, 255, 255, 0, 255, 0, 255, 0, 0, 0, 0]);
  const hidden = new Uint8Array(12).fill(255);
  const out = composite(
    [
      { data: bottom },
      { data: top, opacity: 128 },
      { data: hidden, visible: false },
    ],
    3,
    1
  );
  assert.deepEqual([...out.data.subarray(0, 4)], [127, 0, 128, 255]);
  assert.deepEqual([...out.data.subarray(4, 8)], [0, 255, 0, 128]);
  assert.deepEqual([...out.data.subarray(8, 12)], [10, 20, 30, 255]);
});

test("renderView scales each pixel and shows a checkerboard behind transparency", () => {
  const cv = {
    data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]),
    height: 1,
    width: 2,
  };
  const view = renderView(cv, { scale: 4 });
  assert.equal(view.width, 8);
  const img = decodePng(view.png);
  assert.deepEqual([img.width, img.height], [8, 4]);
  for (const [x, y] of [
    [0, 0],
    [3, 3],
  ]) {
    assert.deepEqual(pixel(img, x, y), [255, 0, 0, 255]);
  }
  assert.deepEqual(pixel(img, 4, 0), [204, 204, 204, 255]);
  assert.deepEqual(pixel(img, 6, 0), [255, 255, 255, 255]);
  const plain = decodePng(renderView(cv, { checker: false, scale: 1 }).png);
  assert.deepEqual([...plain.data], [...cv.data]);
});

test("renderView picks a scale near 512 px and refuses huge images", () => {
  assert.equal(
    renderView({ data: new Uint8Array(32 * 16 * 4), height: 16, width: 32 })
      .scale,
    16
  );
  assert.equal(
    renderView({ data: new Uint8Array(100 * 10 * 4), height: 10, width: 100 })
      .scale,
    5
  );
  assert.throws(
    () =>
      renderView(
        { data: new Uint8Array(2048 * 2048 * 4), height: 2048, width: 2048 },
        { scale: 4 }
      ),
    /smaller scale/u
  );
});

test("critiqueSheet lays out colour, gray, silhouette and 1x panels", () => {
  const cv = {
    data: new Uint8Array([
      255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255,
    ]),
    height: 2,
    width: 2,
  };
  const sheet = critiqueSheet(cv, { scale: 3 });
  const img = decodePng(sheet.png);
  assert.deepEqual(
    [img.width, img.height],
    [4 + 6 + 4 + 6 + 4 + 6 + 4 + 2 + 4, 4 + 6 + 4]
  );
  const gap = [96, 96, 104, 255];
  assert.deepEqual(pixel(img, 0, 0), gap);
  assert.deepEqual(pixel(img, 4, 4), [255, 0, 0, 255], "colour panel");
  assert.deepEqual(
    pixel(img, 14, 4),
    [76, 76, 76, 255],
    "gray panel: luma of red"
  );
  assert.deepEqual(
    pixel(img, 24, 4),
    [0, 0, 0, 255],
    "silhouette: solid is black"
  );
  assert.deepEqual(
    pixel(img, 27, 4),
    [255, 255, 255, 255],
    "silhouette: empty is white"
  );
  assert.deepEqual(pixel(img, 34, 4), [255, 0, 0, 255], "1x panel");
  assert.deepEqual(pixel(img, 35, 5), [0, 0, 255, 255], "1x panel");
  assert.throws(
    () => critiqueSheet(cv, { panels: ["sepia"] as never }),
    /Unknown critique panel/u
  );
});

test("frameStrip places frames left to right with a transparent gap", () => {
  const a = {
    data: new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255]),
    height: 2,
    width: 1,
  };
  const b = {
    data: new Uint8Array([3, 3, 3, 255, 4, 4, 4, 255]),
    height: 2,
    width: 1,
  };
  const strip = frameStrip([a, b]);
  assert.deepEqual([strip.width, strip.height], [3, 2]);
  assert.deepEqual(
    [...strip.data],
    [
      1, 1, 1, 255, 0, 0, 0, 0, 3, 3, 3, 255, 2, 2, 2, 255, 0, 0, 0, 0, 4, 4, 4,
      255,
    ]
  );
});
