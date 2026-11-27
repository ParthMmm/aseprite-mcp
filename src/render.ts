// Pixels to and from image files: the PNG encoder and decoder, layer compositing, upscaled views, the critique
// sheet, sprite sheets and the GIF encoder.
import { crc32 as zlibCrc32, deflateSync, inflateSync } from "node:zlib";

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
const VIEW_DEFLATE_LEVEL = 3;

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

const checkerColumns = (width: number, cell: number): Uint8Array => {
  const cols = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) {
    cols[x] = Math.trunc(x / cell) & 1;
  }
  return cols;
};

/** Fills a `size x size` block at `(left, top)` in `out` (stride `rowBytes`) with one RGBA colour. */
const fillBlock = (
  out: Uint8Array,
  rowBytes: number,
  left: number,
  top: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number
): void => {
  const start = top * rowBytes + left * 4;
  const widthBytes = size * 4;
  for (let o = start; o < start + widthBytes; o += 4) {
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  for (let dy = 1; dy < size; dy += 1) {
    out.copyWithin(start + dy * rowBytes, start, start + widthBytes);
  }
};

/** Fills a `size x size` block over a checkerboard using two pre-blended RGB colours (dark=0, light=1). */
const fillCheckerBlock = (
  out: Uint8Array,
  rowBytes: number,
  cols: Uint8Array,
  panelX: number,
  panelY: number,
  dstLeft: number,
  dstTop: number,
  size: number,
  cell: number,
  r0: number,
  g0: number,
  b0: number,
  r1: number,
  g1: number,
  b1: number
): void => {
  const widthBytes = size * 4;
  let prevCy = -1;
  let prevRow = 0;
  for (let dy = 0; dy < size; dy += 1) {
    const rowStart = (dstTop + dy) * rowBytes + dstLeft * 4;
    const cy = Math.trunc((panelY + dy) / cell) & 1;
    if (cy === prevCy) {
      out.copyWithin(rowStart, prevRow, prevRow + widthBytes);
      continue;
    }
    for (let dx = 0; dx < size; dx += 1) {
      const o = rowStart + dx * 4;
      if ((cols[panelX + dx] ^ cy) === 1) {
        out[o] = r1;
        out[o + 1] = g1;
        out[o + 2] = b1;
      } else {
        out[o] = r0;
        out[o + 1] = g0;
        out[o + 2] = b0;
      }
      out[o + 3] = 255;
    }
    prevCy = cy;
    prevRow = rowStart;
  }
};

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
  const { width: w, height: h, data } = cv;
  const W = w * scale;
  const H = h * scale;
  guardSize(W, H, scale);
  const out = new Uint8Array(W * H * 4);
  const rowBytes = W * 4;
  const cell = Math.max(2, scale >> 1);
  const cols = checker && !background ? checkerColumns(W, cell) : null;
  for (let sy = 0; sy < h; sy += 1) {
    const y0 = sy * scale;
    for (let sx = 0; sx < w; sx += 1) {
      const s = (sy * w + sx) * 4;
      const r = data[s];
      const g = data[s + 1];
      const b = data[s + 2];
      const a = data[s + 3];
      const x0 = sx * scale;
      if (!checker || a === 255) {
        fillBlock(out, rowBytes, x0, y0, scale, r, g, b, a);
      } else if (background) {
        const inv = 255 - a;
        fillBlock(
          out,
          rowBytes,
          x0,
          y0,
          scale,
          Math.round((r * a + background[0] * inv) / 255),
          Math.round((g * a + background[1] * inv) / 255),
          Math.round((b * a + background[2] * inv) / 255),
          255
        );
      } else if (cols) {
        const inv = 255 - a;
        const r0 = a === 0 ? 204 : Math.round((r * a + 204 * inv) / 255);
        const g0 = a === 0 ? 204 : Math.round((g * a + 204 * inv) / 255);
        const b0 = a === 0 ? 204 : Math.round((b * a + 204 * inv) / 255);
        const r1 = a === 0 ? 255 : Math.round((r * a + 255 * inv) / 255);
        const g1 = a === 0 ? 255 : Math.round((g * a + 255 * inv) / 255);
        const b1 = a === 0 ? 255 : Math.round((b * a + 255 * inv) / 255);
        fillCheckerBlock(
          out,
          rowBytes,
          cols,
          x0,
          y0,
          x0,
          y0,
          scale,
          cell,
          r0,
          g0,
          b0,
          r1,
          g1,
          b1
        );
      }
    }
  }
  return {
    height: H,
    png: encodePng(W, H, out, VIEW_DEFLATE_LEVEL),
    scale,
    width: W,
  };
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

const deutanRgb = (r: number, g: number, b: number): Rgb => {
  const lr = toLinear(r / 255);
  const lg = toLinear(g / 255);
  const lb = toLinear(b / 255);
  const [m0, m1, m2] = DEUTAN;
  return [
    255 *
      fromLinear(
        Math.min(1, Math.max(0, m0[0] * lr + m0[1] * lg + m0[2] * lb))
      ),
    255 *
      fromLinear(
        Math.min(1, Math.max(0, m1[0] * lr + m1[1] * lg + m1[2] * lb))
      ),
    255 *
      fromLinear(
        Math.min(1, Math.max(0, m2[0] * lr + m2[1] * lg + m2[2] * lb))
      ),
  ];
};

const shadePanel = (
  kind: CritiquePanel,
  r: number,
  g: number,
  b: number,
  cache?: Map<number, Rgb>
): Rgb => {
  if (kind === "gray") {
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    return [luma, luma, luma];
  }
  if (kind === "deutan") {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache?.get(key);
    if (hit) {
      return hit;
    }
    const rgb = deutanRgb(r, g, b);
    cache?.set(key, rgb);
    return rgb;
  }
  return [r, g, b];
};

const drawPanel = (
  out: Uint8Array,
  rowBytes: number,
  cv: Canvas,
  kind: CritiquePanel,
  s: number,
  left: number,
  background?: Backdrop
): void => {
  const { width: w, height: h, data } = cv;
  const cell = Math.max(2, s >> 1);
  const deutanCache = kind === "deutan" ? new Map<number, Rgb>() : undefined;
  const ground = background
    ? shadePanel(kind, background[0], background[1], background[2], deutanCache)
    : undefined;
  const cols =
    kind === "silhouette" || ground ? null : checkerColumns(w * s, cell);
  for (let sy = 0; sy < h; sy += 1) {
    const py = sy * s;
    const dstTop = SHEET_GAP + py;
    for (let sx = 0; sx < w; sx += 1) {
      const i = (sy * w + sx) * 4;
      const a = data[i + 3];
      const px = sx * s;
      const dstLeft = left + px;
      if (kind === "silhouette") {
        const v = a >= 128 ? 0 : 255;
        fillBlock(out, rowBytes, dstLeft, dstTop, s, v, v, v, 255);
        continue;
      }
      const [pr, pg, pb] = shadePanel(
        kind,
        data[i],
        data[i + 1],
        data[i + 2],
        deutanCache
      );
      if (a === 255) {
        fillBlock(
          out,
          rowBytes,
          dstLeft,
          dstTop,
          s,
          Math.round(pr),
          Math.round(pg),
          Math.round(pb),
          255
        );
      } else if (ground) {
        const cover = a / 255;
        const inv = 1 - cover;
        fillBlock(
          out,
          rowBytes,
          dstLeft,
          dstTop,
          s,
          Math.round(pr * cover + ground[0] * inv),
          Math.round(pg * cover + ground[1] * inv),
          Math.round(pb * cover + ground[2] * inv),
          255
        );
      } else if (cols) {
        const cover = a / 255;
        const inv = 1 - cover;
        fillCheckerBlock(
          out,
          rowBytes,
          cols,
          px,
          py,
          dstLeft,
          dstTop,
          s,
          cell,
          a === 0 ? 204 : Math.round(pr * cover + 204 * inv),
          a === 0 ? 204 : Math.round(pg * cover + 204 * inv),
          a === 0 ? 204 : Math.round(pb * cover + 204 * inv),
          a === 0 ? 255 : Math.round(pr * cover + 255 * inv),
          a === 0 ? 255 : Math.round(pg * cover + 255 * inv),
          a === 0 ? 255 : Math.round(pb * cover + 255 * inv)
        );
      }
    }
  }
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
  const { width: w, height: h } = cv;
  const scales = panels.map((p) => (p === "1x" ? 1 : scale));
  const W = scales.reduce(
    (sum, s) => sum + w * s,
    SHEET_GAP * (panels.length + 1)
  );
  const H = h * Math.max(...scales) + 2 * SHEET_GAP;
  guardSize(W, H, scale);
  const out = new Uint8Array(W * H * 4);
  const rowBytes = W * 4;
  const [bgR, bgG, bgB, bgA] = SHEET_BACKGROUND;
  for (let o = 0; o < rowBytes; o += 4) {
    out[o] = bgR;
    out[o + 1] = bgG;
    out[o + 2] = bgB;
    out[o + 3] = bgA;
  }
  for (let y = 1; y < H; y += 1) {
    out.copyWithin(y * rowBytes, 0, rowBytes);
  }

  let left = SHEET_GAP;
  for (const [n, kind] of panels.entries()) {
    const s = scales[n];
    drawPanel(out, rowBytes, cv, kind, s, left, background);
    left += w * s + SHEET_GAP;
  }
  return {
    height: H,
    png: encodePng(W, H, out, VIEW_DEFLATE_LEVEL),
    scale,
    width: W,
  };
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
