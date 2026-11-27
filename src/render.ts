// Deep Sprite Rendering & Export module: layer compositing, upscaled views, critique sheets,
// sprite-sheet layouts, and export artifact assembly. Binary PNG/GIF encoding lives in codecs.ts.
import { wholeNumber } from "./check.ts";
import { encodeGif, encodePng, guardImage } from "./codecs.ts";
import { fromLinear, parseHex, toLinear } from "./color.ts";
import type { Canvas } from "./raster.ts";

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
export interface ExportTag {
  name: string;
  from: number;
  to: number;
  direction: string;
}
export interface ExportInput {
  frames: readonly Canvas[];
  durations: readonly number[];
  tags: readonly ExportTag[];
  sheetImageName?: string;
  scale?: number;
  tag?: unknown;
  sheet?: boolean;
  gif?: boolean;
  columns?: number;
}
export interface BuiltExport {
  frames: number;
  width: number;
  height: number;
  sheetPng?: Buffer;
  sheetJson?: string;
  gif?: Buffer;
}

type Rgb = [number, number, number];
/** A view's background colour, drawn instead of the checkerboard. */
type Backdrop = readonly [r: number, g: number, b: number];

const VIEW_DEFLATE_LEVEL = 3;

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

interface BlockTarget {
  out: Uint8Array;
  rowBytes: number;
  cols: Uint8Array | null;
  ground: readonly number[] | undefined;
  checker: boolean;
  size: number;
  cell: number;
}

/** Shared source-pixel upscaling for renderView and critiqueSheet panels. */
const drawScaledPixel = (
  target: BlockTarget,
  panelX: number,
  panelY: number,
  dstLeft: number,
  dstTop: number,
  r: number,
  g: number,
  b: number,
  a: number
): void => {
  const { out, rowBytes, cols, ground, checker, size, cell } = target;
  if (!checker || a === 255) {
    fillBlock(
      out,
      rowBytes,
      dstLeft,
      dstTop,
      size,
      Math.round(r),
      Math.round(g),
      Math.round(b),
      a
    );
    return;
  }
  const cover = a / 255;
  const inv = 1 - cover;
  if (ground) {
    fillBlock(
      out,
      rowBytes,
      dstLeft,
      dstTop,
      size,
      Math.round(r * cover + ground[0] * inv),
      Math.round(g * cover + ground[1] * inv),
      Math.round(b * cover + ground[2] * inv),
      255
    );
    return;
  }
  if (!cols) {
    return;
  }
  fillCheckerBlock(
    out,
    rowBytes,
    cols,
    panelX,
    panelY,
    dstLeft,
    dstTop,
    size,
    cell,
    a === 0 ? 204 : Math.round(r * cover + 204 * inv),
    a === 0 ? 204 : Math.round(g * cover + 204 * inv),
    a === 0 ? 204 : Math.round(b * cover + 204 * inv),
    a === 0 ? 255 : Math.round(r * cover + 255 * inv),
    a === 0 ? 255 : Math.round(g * cover + 255 * inv),
    a === 0 ? 255 : Math.round(b * cover + 255 * inv)
  );
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
  const cell = Math.max(2, scale >> 1);
  const target: BlockTarget = {
    cell,
    checker,
    cols: checker && !background ? checkerColumns(W, cell) : null,
    ground: background,
    out,
    rowBytes: W * 4,
    size: scale,
  };
  for (let sy = 0; sy < h; sy += 1) {
    const y0 = sy * scale;
    for (let sx = 0; sx < w; sx += 1) {
      const s = (sy * w + sx) * 4;
      const x0 = sx * scale;
      drawScaledPixel(
        target,
        x0,
        y0,
        x0,
        y0,
        data[s],
        data[s + 1],
        data[s + 2],
        data[s + 3]
      );
    }
  }
  return {
    height: H,
    png: encodePng(W, H, out, VIEW_DEFLATE_LEVEL),
    scale,
    width: W,
  };
};

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
  const target: BlockTarget = {
    cell,
    checker: true,
    cols: kind === "silhouette" || ground ? null : checkerColumns(w * s, cell),
    ground,
    out,
    rowBytes,
    size: s,
  };
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
      drawScaledPixel(target, px, py, dstLeft, dstTop, pr, pg, pb, a);
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

const frameStrip = (frames: readonly Canvas[], gap = 1): Canvas => {
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

const upscale = (cv: Canvas, scale: number): Canvas => {
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

const gridSheet = (
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

/** Renders one or more flattened frames as a single PNG view or critique sheet. */
export const renderSpriteView = (
  frames: readonly Canvas[],
  o: {
    scale?: number;
    critique?: boolean;
    background?: string;
  } = {}
): Rendered => {
  const cv = frames.length === 1 ? frames[0] : frameStrip(frames);
  const rgb = o.background === undefined ? undefined : parseHex(o.background);
  const background = rgb && ([rgb[0], rgb[1], rgb[2]] as const);
  return o.critique
    ? critiqueSheet(cv, { background, scale: o.scale })
    : renderView(cv, { background, scale: o.scale });
};

const wholeOption = (name: string, value: unknown, fallback: number): number =>
  value === undefined ? fallback : wholeNumber(`export: ${name}`, value);

const exportRange = (
  frameCount: number,
  tags: readonly ExportTag[],
  tag: unknown
): { from: number; to: number } => {
  if (tag === undefined) {
    return { from: 0, to: frameCount - 1 };
  }
  const found = tags.find((t) => t.name === tag);
  if (!found) {
    const names = tags.map((t) => t.name);
    throw new Error(
      `export: no tag '${String(tag)}'. Tags: ${names.join(", ") || "none"}.`
    );
  }
  return found;
};

/** Builds pure sprite-sheet (PNG + JSON) and/or looping GIF89a buffers from flattened frames. */
export const buildSpriteExport = ({
  frames: allFrames,
  durations,
  tags,
  sheetImageName = "sheet.png",
  scale: rawScale,
  tag,
  sheet = true,
  gif = false,
  columns: rawColumns,
}: ExportInput): BuiltExport => {
  if (!sheet && !gif) {
    throw new Error("export: sheet and gif are both false; nothing to write.");
  }
  const scale = wholeOption("scale", rawScale, 1);
  const { from, to } = exportRange(allFrames.length, tags, tag);
  const indices = Array.from({ length: to - from + 1 }, (_, n) => from + n);
  const [{ width: baseW, height: baseH }] = allFrames;
  // Every scaled frame is held at once, so the limit applies to all of them together.
  guardImage(
    `${indices.length} frames at ${scale}x`,
    baseW * scale,
    baseH * scale * indices.length
  );
  const scaled = indices.map((f) => upscale(allFrames[f], scale));
  const [{ width, height }] = scaled;
  const out: BuiltExport = { frames: scaled.length, height, width };
  if (sheet) {
    const columns = wholeOption("columns", rawColumns, scaled.length);
    const { sheet: cv, cells } = gridSheet(scaled, columns);
    const data = {
      frames: cells.map(([x, y], n) => ({
        duration: durations[indices[n]],
        h: height,
        w: width,
        x,
        y,
      })),
      image: sheetImageName,
      scale,
      size: { h: cv.height, w: cv.width },
      tags: tags
        .filter((t) => t.from >= from && t.to <= to)
        .map((t) => ({
          direction: t.direction,
          from: t.from - from,
          name: t.name,
          to: t.to - from,
        })),
    };
    out.sheetPng = encodePng(cv.width, cv.height, cv.data);
    out.sheetJson = `${JSON.stringify(data, null, 2)}\n`;
  }
  if (gif) {
    const delays = indices.map((f) =>
      Math.max(2, Math.round(durations[f] / 10))
    );
    out.gif = encodeGif(scaled, delays);
  }
  return out;
};
