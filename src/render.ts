// Pixels to and from image files: the PNG encoder and decoder, layer compositing, upscaled views, the critique
// sheet, sprite sheets and the GIF encoder.
import { deflateSync, inflateSync } from "node:zlib";

/** RGBA, row-major */
export interface Canvas {
  width: number;
  height: number;
  data: Uint8Array;
}
export interface Rendered {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
}
export interface Layer {
  data: Uint8Array;
  visible?: boolean;
  opacity?: number;
}
export type CritiquePanel = "color" | "gray" | "silhouette" | "deutan" | "1x";
type Rgb = [number, number, number];
/** A view's background colour, drawn instead of the checkerboard. */
type Backdrop = readonly [r: number, g: number, b: number];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_OUTPUT_PIXELS = 4096 * 4096;

const CRC_LUT = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let bit = 0; bit < 8; bit += 1) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }
  CRC_LUT[n] = c >>> 0;
}

const crc32 = (...parts: Uint8Array[]): number => {
  let crc = 0xff_ff_ff_ff;
  for (const part of parts) {
    for (const byte of part) {
      crc = CRC_LUT[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const pngChunk = (type: string, body: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8), body), 8 + body.length);
  return out;
};

/** 8-bit RGBA PNG; every row uses filter type 0. */
export const encodePng = (
  width: number,
  height: number,
  rgba: Uint8Array
): Buffer => {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // Depth 8, colour type 6 (RGBA), deflate, adaptive filtering, no interlace.
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * Visible layers, bottom to top, source-over at their opacity (0-255).
 * Aseprite's other blend modes are drawn as normal on purpose: a view only has to be close.
 */
export const composite = (
  layers: Layer[],
  width: number,
  height: number
): Canvas => {
  const data = new Uint8Array(width * height * 4);
  for (const { data: src, visible = true, opacity = 255 } of layers) {
    if (!visible || opacity <= 0) {
      continue;
    }
    for (let i = 0; i < data.length; i += 4) {
      const sa = (src[i + 3] * opacity) / 65_025;
      if (sa === 0) {
        continue;
      }
      const da = data[i + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let c = 0; c < 3; c += 1) {
        data[i + c] = Math.round(
          (src[i + c] * sa + data[i + c] * da * (1 - sa)) / outA
        );
      }
      data[i + 3] = Math.round(outA * 255);
    }
  }
  return { data, height, width };
};

const checkerShade = (x: number, y: number, cell: number): number =>
  (Math.trunc(x / cell) + Math.trunc(y / cell)) & 1 ? 255 : 204;

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

const defaultScale = (w: number, h: number, target: number): number =>
  Math.max(1, Math.floor(target / Math.max(w, h)));

const guardSize = (W: number, H: number, scale: number): void =>
  guardImage(`A ${scale}x view`, W, H, "; use a smaller scale or a rect");

/**
 * Upscaled view; transparency shows a grey checkerboard, or `background` when given. Without `scale` the longer
 * side lands near 512 px.
 */
export const renderView = (
  cv: Canvas,
  {
    scale = defaultScale(cv.width, cv.height, 512),
    checker = true,
    background,
  }: { scale?: number; checker?: boolean; background?: Backdrop } = {}
): Rendered => {
  const W = cv.width * scale;
  const H = cv.height * scale;
  guardSize(W, H, scale);
  const out = new Uint8Array(W * H * 4);
  const cell = Math.max(2, scale >> 1);
  for (let y = 0; y < H; y += 1) {
    const sy = Math.trunc(y / scale);
    for (let x = 0; x < W; x += 1) {
      const s = (sy * cv.width + Math.trunc(x / scale)) * 4;
      const o = (y * W + x) * 4;
      const a = cv.data[s + 3];
      if (!checker || a === 255) {
        out.set(cv.data.subarray(s, s + 4), o);
        continue;
      }
      const shade = checkerShade(x, y, cell);
      const bg = background ?? [shade, shade, shade];
      for (let c = 0; c < 3; c += 1) {
        out[o + c] = Math.round((cv.data[s + c] * a + bg[c] * (255 - a)) / 255);
      }
      out[o + 3] = 255;
    }
  }
  return { height: H, png: encodePng(W, H, out), scale, width: W };
};

export const CRITIQUE_PANELS: readonly CritiquePanel[] = [
  "color",
  "gray",
  "silhouette",
  "deutan",
  "1x",
];
const SHEET_GAP = 4;
const SHEET_BACKGROUND: readonly number[] = [96, 96, 104, 255];
// Machado et al. 2009, deuteranopia at full severity, applied to linear light.
const DEUTAN: readonly Rgb[] = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];
const toLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fromLinear = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

const shadePanel = (
  kind: CritiquePanel,
  r: number,
  g: number,
  b: number
): number[] => {
  if (kind === "gray") {
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return [luma, luma, luma];
  }
  if (kind === "deutan") {
    const lin = [r, g, b].map((v) => toLinear(v / 255));
    return DEUTAN.map(
      (row) =>
        255 *
        fromLinear(
          Math.min(
            1,
            Math.max(0, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])
          )
        )
    );
  }
  return [r, g, b];
};

/**
 * Panels side by side for judging a sprite: colour, values (gray), silhouette, true size (1x), optionally deutan.
 * Without `scale`, a panel's longer side lands near 200 px: big enough to judge, small enough to read cheaply.
 */
export const critiqueSheet = (
  cv: Canvas,
  {
    panels = ["color", "gray", "silhouette", "1x"],
    scale = defaultScale(cv.width, cv.height, 200),
    background,
  }: { panels?: CritiquePanel[]; scale?: number; background?: Backdrop } = {}
): Rendered => {
  for (const p of panels) {
    if (!CRITIQUE_PANELS.includes(p)) {
      throw new Error(
        `Unknown critique panel '${p}'. Choose from ${CRITIQUE_PANELS.join(", ")}.`
      );
    }
  }
  const { width: w, height: h, data } = cv;
  const scales = panels.map((p) => (p === "1x" ? 1 : scale));
  const W = scales.reduce(
    (sum, s) => sum + w * s,
    SHEET_GAP * (panels.length + 1)
  );
  const H = h * Math.max(...scales) + 2 * SHEET_GAP;
  guardSize(W, H, scale);
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i += 4) {
    out.set(SHEET_BACKGROUND, i);
  }

  let left = SHEET_GAP;
  for (const [n, kind] of panels.entries()) {
    const s = scales[n];
    const cell = Math.max(2, s >> 1);
    const ground = background && shadePanel(kind, ...background);
    for (let y = 0; y < h * s; y += 1) {
      for (let x = 0; x < w * s; x += 1) {
        const i = (Math.trunc(y / s) * w + Math.trunc(x / s)) * 4;
        const a = data[i + 3];
        let rgb: number[];
        let cover = a / 255;
        const shade = checkerShade(x, y, cell);
        let bg = ground ?? [shade, shade, shade];
        if (kind === "silhouette") {
          rgb = [0, 0, 0];
          cover = a >= 128 ? 1 : 0;
          bg = [255, 255, 255];
        } else {
          rgb = shadePanel(kind, data[i], data[i + 1], data[i + 2]);
        }
        const o = ((SHEET_GAP + y) * W + left + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          out[o + c] = Math.round(rgb[c] * cover + bg[c] * (1 - cover));
        }
        out[o + 3] = 255;
      }
    }
    left += w * s + SHEET_GAP;
  }
  return { height: H, png: encodePng(W, H, out), scale, width: W };
};

/** Frames left to right, `gap` transparent columns apart, tops aligned. */
export const frameStrip = (frames: Canvas[], gap = 1): Canvas => {
  const width = frames.reduce(
    (sum, f) => sum + f.width,
    gap * (frames.length - 1)
  );
  const height = Math.max(...frames.map((f) => f.height));
  const data = new Uint8Array(width * height * 4);
  let left = 0;
  for (const f of frames) {
    for (let y = 0; y < f.height; y += 1) {
      data.set(
        f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4),
        (y * width + left) * 4
      );
    }
    left += f.width + gap;
  }
  return { data, height, width };
};

/** Nearest-neighbour upscale by a whole factor. */
export const upscale = (cv: Canvas, scale: number): Canvas => {
  if (scale === 1) {
    return cv;
  }
  const W = cv.width * scale;
  const H = cv.height * scale;
  guardImage(`A frame at ${scale}x`, W, H);
  const data = new Uint8Array(W * H * 4);
  const rowBytes = W * 4;
  for (let sy = 0; sy < cv.height; sy += 1) {
    const top = sy * scale * rowBytes;
    for (let x = 0; x < W; x += 1) {
      const s = (sy * cv.width + Math.trunc(x / scale)) * 4;
      const o = top + x * 4;
      data[o] = cv.data[s];
      data[o + 1] = cv.data[s + 1];
      data[o + 2] = cv.data[s + 2];
      data[o + 3] = cv.data[s + 3];
    }
    for (let r = 1; r < scale; r += 1) {
      data.copyWithin(top + r * rowBytes, top, top + rowBytes);
    }
  }
  return { data, height: H, width: W };
};

/** Same-size frames in a grid, `columns` per row, left to right then top to bottom. */
export const gridSheet = (
  frames: Canvas[],
  columns: number
): { sheet: Canvas; cells: [x: number, y: number][] } => {
  const [{ width: fw, height: fh }] = frames;
  const cols = Math.min(columns, frames.length);
  const width = cols * fw;
  const height = Math.ceil(frames.length / cols) * fh;
  guardImage("The sheet", width, height);
  const data = new Uint8Array(width * height * 4);
  const cells = frames.map((f, n): [number, number] => {
    const left = (n % cols) * fw;
    const top = Math.trunc(n / cols) * fh;
    for (let y = 0; y < fh; y += 1) {
      data.set(
        f.data.subarray(y * fw * 4, (y + 1) * fw * 4),
        ((top + y) * width + left) * 4
      );
    }
    return [left, top];
  });
  return { cells, sheet: { data, height, width } };
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

const predict = (filter: number, a: number, b: number, c: number): number => {
  switch (filter) {
    case 0: {
      return 0;
    }
    case 1: {
      return a;
    }
    case 2: {
      return b;
    }
    case 3: {
      return (a + b) >> 1;
    }
    case 4: {
      return paeth(a, b, c);
    }
    default: {
      throw new Error(`PNG row uses unknown filter type ${filter}.`);
    }
  }
};

/** Reverses the per-row filters; returns the packed pixel bytes, `stride` per row. */
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
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? px[o + i - bpp] : 0;
      const b = y > 0 ? px[o - stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[o - stride + i - bpp] : 0;
      px[o + i] = (raw[line + i] + predict(filter, a, b, c)) & 0xff;
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
  const data = new Uint8Array(width * height * 4);
  const key = trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const [keyR, keyG, keyB] =
    trns.length >= 6
      ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : [-1, -1, -1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const i = y * stride + x * channels;
      if (type === 3) {
        const bit = x * depth;
        const v =
          (px[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) &
          ((1 << depth) - 1);
        if (v * 3 + 2 >= plte.length) {
          throw new Error(
            `PNG pixel uses palette index ${v}, outside its palette.`
          );
        }
        data[o] = plte[v * 3];
        data[o + 1] = plte[v * 3 + 1];
        data[o + 2] = plte[v * 3 + 2];
        data[o + 3] = v < trns.length ? trns[v] : 255;
      } else if (type === 0 || type === 4) {
        data.fill(px[i], o, o + 3);
        data[o + 3] = type === 4 ? px[i + 1] : 255 * Number(px[i] !== key);
      } else {
        data[o] = px[i];
        data[o + 1] = px[i + 1];
        data[o + 2] = px[i + 2];
        const keyed =
          px[i] === keyR && px[i + 1] === keyG && px[i + 2] === keyB;
        data[o + 3] = type === 6 ? px[i + 3] : 255 * Number(!keyed);
      }
    }
  }
  return { data, height, width };
};

const MAX_LZW_CODE = 4096;

/** GIF's variable-width LZW, packed least significant bit first. */
const lzw = (indices: Uint8Array, minCodeSize: number): Uint8Array => {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const bytes: number[] = [];
  let acc = 0;
  let accBits = 0;
  let size = minCodeSize + 1;
  let next = end + 1;
  let dict = new Map<number, number>();
  const write = (code: number): void => {
    acc |= code << accBits;
    accBits += size;
    while (accBits >= 8) {
      bytes.push(acc & 0xff);
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
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    output(prefix);
    if (next === MAX_LZW_CODE) {
      write(clear);
      dict = new Map();
      next = end + 1;
      size = minCodeSize + 1;
    } else {
      dict.set(key, next);
      next += 1;
    }
    prefix = k;
  }
  output(prefix);
  write(end);
  if (accBits > 0) {
    bytes.push(acc & 0xff);
  }
  return Uint8Array.from(bytes);
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
