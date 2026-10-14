import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encodeFrame,
  decodeFrame,
  toRgba,
  fromRgba,
  PROTOCOL,
} from "../src/wire.ts";

test("frame header is AB, version 3, flags 0, u32 LE JSON length, then JSON with blob lengths", () => {
  const frame = encodeFrame({ args: { label: "é" }, cmd: "commit", id: 7 }, [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([9]),
  ]);
  assert.equal(frame.toString("latin1", 0, 2), "AB");
  assert.equal(frame[2], PROTOCOL);
  assert.equal(PROTOCOL, 3);
  assert.equal(frame[3], 0);
  const jsonLen = frame.readUInt32LE(4);
  assert.deepEqual(JSON.parse(frame.toString("utf-8", 8, 8 + jsonLen)), {
    args: { label: "é" },
    blobs: [3, 1],
    cmd: "commit",
    id: 7,
  });
  assert.deepEqual([...frame.subarray(8 + jsonLen)], [1, 2, 3, 9]);
});

test("round trip with zero blobs, empty blobs and a multi-MB blob", () => {
  const msg = { id: 1, ok: true, result: { sprite: { id: 3 } } };
  const none = decodeFrame(encodeFrame(msg, []));
  assert.deepEqual(none, { blobs: [], msg });

  const big = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 7) & 0xff);
  const small = new Uint8Array([5, 6]);
  const { msg: m, blobs } = decodeFrame(
    new Uint8Array(encodeFrame(msg, [small, new Uint8Array(0), big]))
  );
  assert.deepEqual(m, msg);
  assert.equal(blobs.length, 3);
  assert.deepEqual([...blobs[0]], [5, 6]);
  assert.equal(blobs[1].length, 0);
  assert.ok(Buffer.compare(blobs[2], big) === 0);
});

test("decodeFrame rejects bad magic, version, flags and lengths", () => {
  const good = encodeFrame({ id: 1 }, [new Uint8Array([1, 2])]);
  const with_ = (i: number, v: number) => {
    const b = Buffer.from(good);
    b[i] = v;
    return b;
  };
  assert.throws(() => decodeFrame(with_(0, 0x58)), /bad magic/u);
  assert.throws(() => decodeFrame(with_(2, 2)), /protocol 2, expected 3/u);
  assert.throws(() => decodeFrame(with_(3, 1)), /flags 1/u);
  assert.throws(
    () => decodeFrame(good.subarray(0, -1)),
    /blob lengths add up to 2 bytes, frame carries 1/u
  );
  assert.throws(
    () => decodeFrame(Buffer.concat([good, Buffer.from([0])])),
    /blob lengths/u
  );
  assert.throws(() => decodeFrame(good.subarray(0, 5)), /bad magic/u);
});

const PALETTE = ["#00000000", "#ff0000ff", "#00ff00ff", "#0000ffff"];

test("indexed bytes convert to RGBA and back unchanged", () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 1, 0]);
  const rgba = toRgba(bytes, "indexed", PALETTE, 0);
  assert.deepEqual([...rgba.subarray(0, 8)], [0, 0, 0, 0, 255, 0, 0, 255]);
  assert.deepEqual([...rgba.subarray(12, 16)], [0, 0, 255, 255]);
  assert.deepEqual(fromRgba(rgba, "indexed", PALETTE, 0), {
    bytes,
    missing: [],
  });
});

test("indexed honours a non-zero transparent index and treats out-of-range indices as transparent", () => {
  const pal = ["#000000", "#ffffff", "#ff0000"];
  const rgba = toRgba(new Uint8Array([2, 0, 9]), "indexed", pal, 2);
  assert.deepEqual([...rgba], [0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0]);
  assert.deepEqual([...fromRgba(rgba, "indexed", pal, 2).bytes], [2, 0, 2]);
});

test("indexed fromRgba reports missing colours once and writes the nearest entry", () => {
  const rgba = new Uint8Array([
    250, 10, 0, 255, 250, 10, 0, 255, 0, 255, 0, 255, 1, 2, 250, 255,
  ]);
  const { bytes, missing } = fromRgba(rgba, "indexed", PALETTE, 0);
  assert.deepEqual([...bytes], [1, 1, 2, 3]);
  assert.deepEqual(missing, ["#fa0a00ff", "#0102faff"]);
});

test("gray converts value+alpha to RGBA and back", () => {
  const bytes = new Uint8Array([0, 0, 128, 255, 200, 64]);
  const rgba = toRgba(bytes, "gray", [], 0);
  assert.deepEqual(
    [...rgba],
    [0, 0, 0, 0, 128, 128, 128, 255, 200, 200, 200, 64]
  );
  assert.deepEqual([...fromRgba(rgba, "gray", [], 0).bytes], [...bytes]);
  assert.deepEqual(
    [...fromRgba(new Uint8Array([255, 0, 0, 255]), "gray", [], 0).bytes],
    [54, 255]
  );
});

test("rgb passes through as a copy; bad sizes and modes throw", () => {
  const src = new Uint8Array([1, 2, 3, 4]);
  const out = toRgba(src, "rgb", [], 0);
  assert.deepEqual(out, src);
  assert.notEqual(out.buffer, src.buffer);
  assert.throws(
    () => toRgba(new Uint8Array(3), "gray", [], 0),
    /not a whole number of gray pixels/u
  );
  assert.throws(
    () => fromRgba(new Uint8Array(4), "cmyk" as never, [], 0),
    /Unknown colour mode/u
  );
});
