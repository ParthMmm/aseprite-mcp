// Pure binary Image Codecs: full-canvas RGBA pixel buffers to and from PNG and GIF89a files.
import { crc32 as zlibCrc32, deflateSync, inflateSync } from "node:zlib";

import type { Canvas } from "./raster.ts";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_OUTPUT_PIXELS = 4096 * 4096;

export const guardImage = (
  what: string,
  W: number,
  H: number,
  hint = ""
): void => {
  if (W * H > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `${what} would be ${W}x${H} px, over the limit of ${MAX_OUTPUT_PIXELS} pixels${hint}.`
    );
  }
};

const pngChunk = (type: string, body: Uint8Array): Buffer => {
  const out = Buffer.allocUnsafe(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(
    zlibCrc32(out.subarray(4, 8 + body.length)),
    8 + body.length
  );
  return out;
};

/** 8-bit RGBA PNG; every row uses filter type 0. */
export const encodePng = (
  width: number,
  height: number,
  rgba: Uint8Array,
  level = 6
): Buffer => {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Depth 8, colour type 6 (RGBA), deflate, adaptive filtering, no interlace.
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const PNG_CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

const unfilterSub = (
  raw: Uint8Array,
  line: number,
  px: Uint8Array,
  o: number,
  stride: number,
  bpp: number
): void => {
  for (let i = 0; i < bpp; i += 1) {
    px[o + i] = raw[line + i];
  }
  for (let i = bpp; i < stride; i += 1) {
    px[o + i] = (raw[line + i] + px[o + i - bpp]) & 0xff;
  }
};

const unfilterAvg = (
  raw: Uint8Array,
  line: number,
  px: Uint8Array,
  o: number,
  prev: number,
  stride: number,
  bpp: number,
  y: number
): void => {
  if (y === 0) {
    for (let i = 0; i < bpp; i += 1) {
      px[o + i] = raw[line + i];
    }
    for (let i = bpp; i < stride; i += 1) {
      px[o + i] = (raw[line + i] + (px[o + i - bpp] >> 1)) & 0xff;
    }
    return;
  }
  for (let i = 0; i < bpp; i += 1) {
    px[o + i] = (raw[line + i] + (px[prev + i] >> 1)) & 0xff;
  }
  for (let i = bpp; i < stride; i += 1) {
    px[o + i] =
      (raw[line + i] + ((px[o + i - bpp] + px[prev + i]) >> 1)) & 0xff;
  }
};

const unfilterPaeth = (
  raw: Uint8Array,
  line: number,
  px: Uint8Array,
  o: number,
  prev: number,
  stride: number,
  bpp: number,
  y: number
): void => {
  if (y === 0) {
    unfilterSub(raw, line, px, o, stride, bpp);
    return;
  }
  for (let i = 0; i < bpp; i += 1) {
    px[o + i] = (raw[line + i] + px[prev + i]) & 0xff;
  }
  for (let i = bpp; i < stride; i += 1) {
    px[o + i] =
      (raw[line + i] +
        paeth(px[o + i - bpp], px[prev + i], px[prev + i - bpp])) &
      0xff;
  }
};

const unfilter = (
  raw: Uint8Array,
  height: number,
  stride: number,
  bpp: number
): Uint8Array => {
  if (raw.length < (stride + 1) * height) {
    throw new Error("PNG image data is truncated.");
  }
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const o = y * stride;
    const prev = o - stride;
    switch (filter) {
      case 0: {
        px.set(raw.subarray(line, line + stride), o);
        break;
      }
      case 1: {
        unfilterSub(raw, line, px, o, stride, bpp);
        break;
      }
      case 2: {
        if (y === 0) {
          px.set(raw.subarray(line, line + stride), o);
        } else {
          for (let i = 0; i < stride; i += 1) {
            px[o + i] = (raw[line + i] + px[prev + i]) & 0xff;
          }
        }
        break;
      }
      case 3: {
        unfilterAvg(raw, line, px, o, prev, stride, bpp, y);
        break;
      }
      case 4: {
        unfilterPaeth(raw, line, px, o, prev, stride, bpp, y);
        break;
      }
      default: {
        throw new Error(`PNG row uses unknown filter type ${filter}.`);
      }
    }
  }
  return px;
};

interface PngChunks {
  header: Buffer;
  plte: Buffer;
  trns: Buffer;
  idat: Buffer;
}

const pngChunks = (buf: Buffer): PngChunks => {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a PNG file.");
  }
  const found: Record<string, Buffer> = {};
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    } else {
      found[type] ??= body;
    }
  }
  const header = found.IHDR;
  if (header?.length !== 13 || !idat.length) {
    throw new Error("PNG file has no IHDR or IDAT chunk.");
  }
  return {
    header,
    idat: Buffer.concat(idat),
    plte: found.PLTE ?? Buffer.alloc(0),
    trns: found.tRNS ?? Buffer.alloc(0),
  };
};

const decodePalettePixels = (
  px: Uint8Array,
  width: number,
  height: number,
  stride: number,
  depth: number,
  plte: Buffer,
  trns: Buffer
): Uint8Array => {
  const data = new Uint8Array(width * height * 4);
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const bit = x * depth;
      const v = (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & mask;
      if (v * 3 + 2 >= plte.length) {
        throw new Error(
          `PNG pixel uses palette index ${v}, outside its palette.`
        );
      }
      const o = (y * width + x) * 4;
      data[o] = plte[v * 3];
      data[o + 1] = plte[v * 3 + 1];
      data[o + 2] = plte[v * 3 + 2];
      data[o + 3] = v < trns.length ? trns[v] : 255;
    }
  }
  return data;
};

const decodeGrayPixels = (
  px: Uint8Array,
  width: number,
  height: number,
  stride: number,
  hasAlpha: boolean,
  trns: Buffer
): Uint8Array => {
  const data = new Uint8Array(width * height * 4);
  const channels = hasAlpha ? 2 : 1;
  const key = trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const i = y * stride + x * channels;
      const v = px[i];
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      if (hasAlpha) {
        data[o + 3] = px[i + 1];
      } else {
        data[o + 3] = v === key ? 0 : 255;
      }
    }
  }
  return data;
};

const decodeRgbPixels = (
  px: Uint8Array,
  width: number,
  height: number,
  stride: number,
  trns: Buffer
): Uint8Array => {
  const data = new Uint8Array(width * height * 4);
  const [keyR, keyG, keyB] =
    trns.length >= 6
      ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : [-1, -1, -1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const i = y * stride + x * 3;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = r === keyR && g === keyG && b === keyB ? 0 : 255;
    }
  }
  return data;
};

/**
 * Decodes a PNG to RGBA: colour types 0, 2, 4 and 6 at bit depth 8, and palette PNGs at depth 1, 2, 4 or 8.
 * tRNS transparency is applied. Interlaced and 16-bit PNGs are refused.
 */
export const decodePng = (file: Uint8Array): Canvas => {
  const { header, plte, trns, idat } = pngChunks(
    Buffer.from(file.buffer, file.byteOffset, file.byteLength)
  );
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header.readUInt8(8);
  const type = header.readUInt8(9);
  const interlace = header.readUInt8(12);
  const channels = PNG_CHANNELS.get(type);
  if (channels === undefined) {
    throw new Error(`PNG colour type ${type} is not supported.`);
  }
  if (interlace !== 0) {
    throw new Error(
      "Interlaced PNGs are not supported; save the image without interlacing."
    );
  }
  if (type === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8) {
    throw new Error(
      `PNG bit depth ${depth} is not supported for colour type ${type}; save the image as 8-bit.`
    );
  }
  guardImage("The PNG", width, height);
  const bits = channels * depth;
  const stride = Math.ceil((width * bits) / 8);
  const px = unfilter(
    inflateSync(idat),
    height,
    stride,
    Math.max(1, bits >> 3)
  );
  if (type === 6) {
    return { data: px, height, width };
  }
  if (type === 3) {
    return {
      data: decodePalettePixels(px, width, height, stride, depth, plte, trns),
      height,
      width,
    };
  }
  if (type === 0 || type === 4) {
    return {
      data: decodeGrayPixels(px, width, height, stride, type === 4, trns),
      height,
      width,
    };
  }
  return {
    data: decodeRgbPixels(px, width, height, stride, trns),
    height,
    width,
  };
};

const MAX_LZW_CODE = 4096;
const LZW_HT_SIZE = 8192;
const LZW_HT_MASK = LZW_HT_SIZE - 1;

/** GIF's variable-width LZW, packed least significant bit first. */
const lzw = (indices: Uint8Array, minCodeSize: number): Uint8Array => {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let bytes = new Uint8Array(Math.max(256, indices.length));
  let byteLen = 0;
  let acc = 0;
  let accBits = 0;
  let size = minCodeSize + 1;
  let next = end + 1;
  const keys = new Int32Array(LZW_HT_SIZE).fill(-1);
  const vals = new Uint16Array(LZW_HT_SIZE);
  const pushByte = (b: number): void => {
    if (byteLen === bytes.length) {
      const grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes);
      bytes = grown;
    }
    bytes[byteLen] = b;
    byteLen += 1;
  };
  const write = (code: number): void => {
    acc |= code << accBits;
    accBits += size;
    while (accBits >= 8) {
      pushByte(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  };
  // The width grows as soon as the next code needs it, as giflib does, so the decoder stays in step.
  const output = (code: number): void => {
    write(code);
    if (next >= 1 << size && size < 12) {
      size += 1;
    }
  };
  write(clear);
  let [prefix] = indices;
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    let slot = ((prefix << 5) ^ k) & LZW_HT_MASK;
    let hit = -1;
    while (keys[slot] !== -1) {
      if (keys[slot] === key) {
        hit = vals[slot];
        break;
      }
      slot = (slot + 1) & LZW_HT_MASK;
    }
    if (hit !== -1) {
      prefix = hit;
      continue;
    }
    output(prefix);
    if (next === MAX_LZW_CODE) {
      write(clear);
      keys.fill(-1);
      next = end + 1;
      size = minCodeSize + 1;
    } else {
      keys[slot] = key;
      vals[slot] = next;
      next += 1;
    }
    prefix = k;
  }
  output(prefix);
  write(end);
  if (accBits > 0) {
    pushByte(acc & 0xff);
  }
  return bytes.subarray(0, byteLen);
};

const subBlocks = (data: Uint8Array): Buffer => {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const part = data.subarray(at, at + 255);
    parts.push(Uint8Array.of(part.length), part);
  }
  parts.push(Uint8Array.of(0));
  return Buffer.concat(parts);
};

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

/**
 * A looping GIF89a of same-size frames; `delays` in centiseconds, one per frame. Index 0 is transparent; pixels
 * with alpha below 128 use it and the rest keep their RGB, so at most 255 distinct colours fit.
 */
export const encodeGif = (frames: Canvas[], delays: number[]): Buffer => {
  const [{ width, height }] = frames;
  const index = new Map<number, number>();
  const indexed = frames.map((f) => {
    const out = new Uint8Array(width * height);
    for (let p = 0; p < out.length; p += 1) {
      const i = p * 4;
      if (f.data[i + 3] < 128) {
        continue;
      }
      const rgb = (f.data[i] << 16) | (f.data[i + 1] << 8) | f.data[i + 2];
      let n = index.get(rgb);
      if (n === undefined) {
        n = index.size + 1;
        index.set(rgb, n);
      }
      out[p] = n;
    }
    return out;
  });
  if (index.size > 255) {
    throw new Error(
      `The frames use ${index.size} colours; a GIF holds at most 255 plus transparent. Use fewer colours or export only the sheet.`
    );
  }
  const bits = Math.max(1, Math.ceil(Math.log2(index.size + 1)));
  const table = Buffer.alloc(3 << bits);
  for (const [rgb, n] of index) {
    table.set([rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff], n * 3);
  }
  const minCodeSize = Math.max(2, bits);
  const parts: Uint8Array[] = [
    Buffer.from("GIF89a", "ascii"),
    u16(width),
    u16(height),
    Uint8Array.of(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0),
    table,
    Uint8Array.of(0x21, 0xff, 0x0b),
    Buffer.from("NETSCAPE2.0", "ascii"),
    // Loop forever.
    Uint8Array.of(3, 1, 0, 0, 0),
  ];
  for (const [n, pixels] of indexed.entries()) {
    parts.push(
      // Disposal 2 clears each frame before the next, so transparent pixels never show the previous frame.
      Uint8Array.of(0x21, 0xf9, 4, (2 << 2) | 1),
      u16(delays[n]),
      Uint8Array.of(0, 0, 0x2c),
      u16(0),
      u16(0),
      u16(width),
      u16(height),
      Uint8Array.of(0, minCodeSize),
      subBlocks(lzw(pixels, minCodeSize))
    );
  }
  parts.push(Uint8Array.of(0x3b));
  return Buffer.concat(parts);
};
