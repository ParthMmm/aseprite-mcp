import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { decodePng, encodeGif, encodePng } from "../src/codecs.ts";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type: string, body: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

const makePng = (
  w: number,
  h: number,
  depth: number,
  colorType: number,
  rawRows: Uint8Array,
  extra: { plte?: Uint8Array; trns?: Uint8Array; interlace?: number } = {}
): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([depth, colorType, 0, 0, extra.interlace ?? 0], 8);
  const parts = [PNG_SIG, chunk("IHDR", ihdr)];
  if (extra.plte) {
    parts.push(chunk("PLTE", extra.plte));
  }
  if (extra.trns) {
    parts.push(chunk("tRNS", extra.trns));
  }
  parts.push(
    chunk("IDAT", deflateSync(rawRows)),
    chunk("IEND", Buffer.alloc(0))
  );
  return Buffer.concat(parts);
};

test("encodePng and decodePng round-trip RGBA buffers", () => {
  const rgba = new Uint8Array(4 * 3 * 4).map((_, i) => (i * 37) % 256);
  const img = decodePng(encodePng(4, 3, rgba));
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  assert.deepEqual(img.data, rgba);
});

test("decodePng reverses Sub, Up, Average and Paeth row filters", () => {
  // 2x2 RGBA image encoded with filters 1 (Sub), 2 (Up), 3 (Average), 4 (Paeth) in pairs.
  const expected = Uint8Array.of(
    10,
    20,
    30,
    255,
    25,
    45,
    65,
    255,
    40,
    50,
    60,
    255,
    70,
    90,
    110,
    255
  );
  // Row 0 with Sub (filter 1): first pixel raw, second pixel diff from first.
  // Row 1 with Up (filter 2): diff from row 0.
  const subUp = Uint8Array.of(
    1,
    10,
    20,
    30,
    255,
    15,
    25,
    35,
    0,
    2,
    30,
    30,
    30,
    0,
    45,
    45,
    45,
    0
  );
  assert.deepEqual(decodePng(makePng(2, 2, 8, 6, subUp)).data, expected);

  // Row 0 with Average (filter 3), Row 1 with Paeth (filter 4).
  // Row 0 avg: [10,20,30,255], second pixel predicts floor(prev/2) = [5,10,15,127] -> diff [20,35,50,128]
  // Row 1 paeth: first pixel predicts up=[10,20,30,255] -> diff [30,30,30,0];
  // second pixel predicts paeth(a=[40,50,60,255], b=[25,45,65,255], c=[10,20,30,255]) = [55,75,95,255] -> nearest is a=[40,50,60,255] for R? p=55: |55-40|=15, |55-25|=30, |55-10|=45 -> 40; G: p=75: |75-50|=25, |75-45|=30 -> 50; B: p=95: |95-60|=35, |95-65|=30 -> 65; A: 255.
  const avgPaeth = Uint8Array.of(
    3,
    10,
    20,
    30,
    255,
    20,
    35,
    50,
    128,
    4,
    30,
    30,
    30,
    0,
    30,
    40,
    45,
    0
  );
  assert.deepEqual(decodePng(makePng(2, 2, 8, 6, avgPaeth)).data, expected);
});

test("decodePng handles RGB, Gray, Gray+Alpha, palette depths and tRNS", () => {
  // RGB + tRNS key (1, 2, 3) -> transparent
  const rgbRaw = Uint8Array.of(0, 1, 2, 3, 10, 20, 30);
  const trnsRgb = Buffer.alloc(6);
  trnsRgb.writeUInt16BE(1, 0);
  trnsRgb.writeUInt16BE(2, 2);
  trnsRgb.writeUInt16BE(3, 4);
  assert.deepEqual(
    [...decodePng(makePng(2, 1, 8, 2, rgbRaw, { trns: trnsRgb })).data],
    [1, 2, 3, 0, 10, 20, 30, 255]
  );

  // Grayscale + tRNS key 5 -> transparent; Gray+Alpha
  const trnsGray = Buffer.alloc(2);
  trnsGray.writeUInt16BE(5, 0);
  assert.deepEqual(
    [
      ...decodePng(
        makePng(2, 1, 8, 0, Uint8Array.of(0, 5, 99), { trns: trnsGray })
      ).data,
    ],
    [5, 5, 5, 0, 99, 99, 99, 255]
  );
  assert.deepEqual(
    [...decodePng(makePng(1, 1, 8, 4, Uint8Array.of(0, 77, 128))).data],
    [77, 77, 77, 128]
  );

  // 2-bit palette PNG with 4 entries + partial tRNS
  const plte = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9);
  const trnsPal = Uint8Array.of(0, 128);
  // indices: 0, 1, 2, 3 packed into 1 byte = 0b00_01_10_11 = 0x1b
  assert.deepEqual(
    [
      ...decodePng(
        makePng(4, 1, 2, 3, Uint8Array.of(0, 0x1b), { plte, trns: trnsPal })
      ).data,
    ],
    [255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 255]
  );
});

test("decodePng rejects non-PNG, interlaced, 16-bit and truncated inputs", () => {
  assert.throws(() => decodePng(Buffer.from("nope")), /Not a PNG file/u);
  assert.throws(
    () =>
      decodePng(
        makePng(1, 1, 8, 6, Uint8Array.of(0, 0, 0, 0, 0), { interlace: 1 })
      ),
    /Interlaced PNGs are not supported/u
  );
  assert.throws(
    () =>
      decodePng(makePng(1, 1, 16, 6, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0))),
    /bit depth 16 is not supported/u
  );
  assert.throws(
    () => decodePng(makePng(2, 2, 8, 6, Uint8Array.of(0, 1, 2))),
    /truncated/u
  );
});

test("encodeGif writes a valid looping GIF89a, handles LZW table clear, and rejects >255 colours", () => {
  const f1 = {
    data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]),
    height: 1,
    width: 2,
  };
  const f2 = {
    data: new Uint8Array([0, 0, 0, 50, 0, 255, 0, 255]),
    height: 1,
    width: 2,
  };
  const gif = encodeGif([f1, f2], [8, 12]);
  assert.equal(gif.toString("ascii", 0, 6), "GIF89a");
  assert.ok(gif.includes(Buffer.from("NETSCAPE2.0", "ascii")));
  assert.equal(gif.at(-1), 0x3b);

  // Trigger LZW 4096-code reset on a varied 64x64 frame without exceeding 255 colours.
  const big = { data: new Uint8Array(64 * 64 * 4), height: 64, width: 64 };
  for (let i = 0; i < 64 * 64; i += 1) {
    const v = ((i * 73) ^ (i >> 3)) % 200;
    big.data[i * 4] = v;
    big.data[i * 4 + 1] = (v * 3) % 256;
    big.data[i * 4 + 2] = 100;
    big.data[i * 4 + 3] = 255;
  }
  const bigGif = encodeGif([big], [5]);
  assert.equal(bigGif.toString("ascii", 0, 6), "GIF89a");
  assert.equal(bigGif.at(-1), 0x3b);

  // >255 distinct opaque colours fails cleanly.
  const many = { data: new Uint8Array(256 * 4), height: 1, width: 256 };
  for (let i = 0; i < 256; i += 1) {
    many.data[i * 4] = i;
    many.data[i * 4 + 3] = 255;
  }
  assert.throws(
    () => encodeGif([many], [10]),
    /256 colours; a GIF holds at most 255/u
  );
});
