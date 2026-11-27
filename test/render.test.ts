import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePng } from "../src/codecs.ts";
import {
  buildSpriteExport,
  composite,
  critiqueSheet,
  renderSpriteView,
  renderView,
} from "../src/render.ts";

const pixel = (
  img: { data: Uint8Array; width: number },
  x: number,
  y: number
) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

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

test("renderView scales each pixel and shows a checkerboard or solid background", () => {
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

  const bg = decodePng(renderView(cv, { background: [8, 7, 7], scale: 2 }).png);
  assert.deepEqual(pixel(bg, 2, 0), [8, 7, 7, 255]);

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

test("critiqueSheet lays out colour, gray, silhouette, deutan and 1x panels", () => {
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

  const withDeutan = decodePng(
    critiqueSheet(cv, {
      background: [16, 16, 16],
      panels: ["deutan"],
      scale: 2,
    }).png
  );
  assert.deepEqual(pixel(withDeutan, 6, 4), [16, 16, 16, 255]);
  assert.notDeepEqual(pixel(withDeutan, 4, 4), [255, 0, 0, 255]);

  assert.throws(
    () => critiqueSheet(cv, { panels: ["sepia"] as never }),
    /Unknown critique panel/u
  );
});

test("renderSpriteView joins multiple frames side by side with a 1px gap", () => {
  const a = {
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    height: 2,
    width: 1,
  };
  const b = {
    data: new Uint8Array([0, 0, 255, 255, 255, 255, 0, 255]),
    height: 2,
    width: 1,
  };
  const strip = renderSpriteView([a, b], {
    background: "#080707",
    scale: 1,
  });
  assert.deepEqual([strip.width, strip.height], [3, 2]);
  const img = decodePng(strip.png);
  assert.deepEqual(pixel(img, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(img, 1, 0), [8, 7, 7, 255]);
  assert.deepEqual(pixel(img, 2, 1), [255, 255, 0, 255]);
});

test("buildSpriteExport builds scaled grid sheet JSON/PNG, GIF, and slices by tag", () => {
  const frames = [0, 1, 2, 3].map((i) => ({
    data: new Uint8Array([i * 60, 10, 20, 255, 0, 0, 0, 0]),
    height: 1,
    width: 2,
  }));
  const built = buildSpriteExport({
    columns: 2,
    durations: [80, 100, 120, 140],
    frames,
    gif: true,
    scale: 2,
    sheet: true,
    sheetImageName: "hero.png",
    tag: "run",
    tags: [
      { direction: "forward", from: 0, name: "idle", to: 0 },
      { direction: "pingpong", from: 1, name: "run", to: 3 },
    ],
  });
  assert.deepEqual(
    { frames: built.frames, height: built.height, width: built.width },
    { frames: 3, height: 2, width: 4 }
  );
  assert.ok(built.sheetPng && built.sheetJson && built.gif);
  const sheetImg = decodePng(built.sheetPng);
  assert.deepEqual([sheetImg.width, sheetImg.height], [8, 4]);
  const meta = JSON.parse(built.sheetJson);
  assert.equal(meta.image, "hero.png");
  assert.equal(meta.scale, 2);
  assert.deepEqual(meta.size, { h: 4, w: 8 });
  assert.deepEqual(meta.tags, [
    { direction: "pingpong", from: 0, name: "run", to: 2 },
  ]);
  assert.deepEqual(
    meta.frames.map((f: { duration: number; x: number; y: number }) => [
      f.x,
      f.y,
      f.duration,
    ]),
    [
      [0, 0, 100],
      [4, 0, 120],
      [0, 2, 140],
    ]
  );
  assert.equal(built.gif.toString("ascii", 0, 6), "GIF89a");

  assert.throws(
    () =>
      buildSpriteExport({
        durations: [100],
        frames: [frames[0]],
        gif: false,
        sheet: false,
        tags: [],
      }),
    /sheet and gif are both false/u
  );
  assert.throws(
    () =>
      buildSpriteExport({
        durations: [100],
        frames: [frames[0]],
        tag: "missing",
        tags: [],
      }),
    /no tag 'missing'/u
  );
});
