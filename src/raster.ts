// Every per-pixel loop. A Canvas is one full-canvas RGBA cel; ops overwrite (no blending) and return the
// number of pixels whose visible value changed. All alpha-0 pixels count as the same colour.
import {
  normHex,
  parseHex,
  formatHex,
  rgbToOklch,
  oklchToRgb,
  hueToward,
  SHADOW_HUE,
} from "./color.ts";

/** One full-canvas RGBA cel, row-major. */
export interface Canvas {
  width: number;
  height: number;
  data: Uint8Array;
  /** Opaque pixels that drawing calls tried to put outside the canvas. */
  clipped?: number;
}
export type Rect = [x: number, y: number, w: number, h: number];
/** A rect clipped to the canvas: [x0, y0, x1, y1), possibly empty. */
export type Bounds = [x0: number, y0: number, x1: number, y1: number];
export type Rgba = readonly [r: number, g: number, b: number, a: number];
type Rgb = [r: number, g: number, b: number];
export type Flip = "h" | "v" | "hv";
/** One-character keys to colour strings. */
export type Palette = Record<string, string>;
export type OutlineMode = "selective" | "outside" | "inside";

export interface MapOptions {
  x?: number;
  y?: number;
  flip?: Flip;
}
export interface FillOptions {
  fill?: boolean;
}
export interface RectOptions {
  rect?: Rect;
}
export interface OutlineOptions extends RectOptions {
  mode?: OutlineMode;
  strength?: number;
}
export interface CopyOptions extends RectOptions {
  x?: number;
  y?: number;
  flip?: Flip;
}
export interface ReadOptions extends RectOptions {
  palette?: Palette;
}
/** The `map` format: a palette and one string per row. */
export interface PixelRows {
  palette: Palette;
  rows: string[];
}
export type Point = [x: number, y: number, color: string];

const CLEAR: Rgba = [0, 0, 0, 0];
const OUTLINE_MODES = new Set<string>(["selective", "outside", "inside"]);
export const SKIP_CHARS = new Set([".", " "]);
// Keys that `read` hands out. Quote and backslash are absent so rows stay cheap to escape in JSON.
const MAP_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+-/:;<=>?@^_~!|()[]{},'`",
];

export const blank = (width: number, height: number): Canvas => ({
  data: new Uint8Array(width * height * 4),
  height,
  width,
});

// The colour may be anything a program passed; parseHex validates it.
const rgba = (c: unknown): Rgba => {
  const [r, g, b, a] = parseHex(c);
  return a === 0 ? CLEAR : [r, g, b, a];
};

const put = (cv: Canvas, x: number, y: number, [r, g, b, a]: Rgba): 0 | 1 => {
  if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) {
    if (a !== 0) {
      cv.clipped = (cv.clipped ?? 0) + 1;
    }
    return 0;
  }
  const d = cv.data;
  const i = (y * cv.width + x) * 4;
  if (
    a === 0
      ? d[i + 3] === 0
      : d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] === a
  ) {
    return 0;
  }
  d[i] = r;
  d[i + 1] = g;
  d[i + 2] = b;
  d[i + 3] = a;
  return 1;
};

/** 32-bit key of the pixel at byte offset i; every transparent pixel is 0. */
const keyAt = (d: Uint8Array, i: number): number =>
  d[i + 3] === 0
    ? 0
    : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
const keyOf = ([r, g, b, a]: Rgba): number =>
  a === 0 ? 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

const checkRect = (r: unknown): Rect => {
  if (
    !Array.isArray(r) ||
    r.length !== 4 ||
    !r.every((v) => Number.isInteger(v))
  ) {
    throw new Error(
      `rect must be [x, y, width, height] in whole pixels, got ${JSON.stringify(r)}.`
    );
  }
  const [x, y, w, h]: number[] = r;
  return [x, y, w, h];
};

/** Clip a rect to the canvas; no rect means the whole canvas. */
export const clip = (cv: Canvas, r?: unknown): Bounds => {
  if (r === undefined || r === null) {
    return [0, 0, cv.width, cv.height];
  }
  const [x, y, w, h] = checkRect(r);
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  return [
    x0,
    y0,
    Math.max(x0, Math.min(cv.width, x + w)),
    Math.max(y0, Math.min(cv.height, y + h)),
  ];
};

export const flipRows = (rows: string[], flip?: Flip): string[] => {
  const horizontal = flip === "h" || flip === "hv";
  const vertical = flip === "v" || flip === "hv";
  const width = Math.max(0, ...rows.map((r) => [...r].length));
  const mirrored = horizontal
    ? rows.map((r) => [...r.padEnd(width, ".")].toReversed().join(""))
    : rows;
  return vertical ? mirrored.toReversed() : mirrored;
};

/**
 * Pixel map: one character per pixel. "." and " " leave the pixel; a key mapped to "#00000000" erases.
 * Validates every character before writing, so a bad map changes nothing.
 */
export const map = (
  cv: Canvas,
  palette: Palette | undefined,
  rows: string[],
  { x = 0, y = 0, flip }: MapOptions = {}
): number => {
  const colors = new Map(
    Object.entries(palette ?? {}).map(([k, c]) => [k, rgba(c)])
  );
  const chars = flipRows(rows, flip).map((r) => [...r]);
  const missing = new Set(
    chars.flat().filter((ch) => !SKIP_CHARS.has(ch) && !colors.has(ch))
  );
  if (missing.size) {
    throw new Error(
      `Characters not in palette: ${[...missing].map((c) => JSON.stringify(c)).join(", ")}. ` +
        `Palette keys: ${[...colors.keys()].join("") || "(none)"}; use '.' or space for "leave unchanged".`
    );
  }
  let n = 0;
  for (const [j, row] of chars.entries()) {
    for (const [i, ch] of row.entries()) {
      const c = colors.get(ch);
      if (c && !SKIP_CHARS.has(ch)) {
        n += put(cv, x + i, y + j, c);
      }
    }
  }
  return n;
};

export const px = (cv: Canvas, points: Point[]): number => {
  const cache = new Map<string, Rgba>();
  const col = (c: string): Rgba => {
    let v = cache.get(c);
    if (!v) {
      v = rgba(c);
      cache.set(c, v);
    }
    return v;
  };
  for (const p of points) {
    col(p[2]);
  }
  let n = 0;
  for (const [x, y, c] of points) {
    n += put(cv, x, y, col(c));
  }
  return n;
};

/** Bresenham, both ends inclusive. */
export const line = (
  cv: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string
): number => {
  const c = rgba(color);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let n = 0;
  let x = x0;
  let y = y0;
  for (;;) {
    n += put(cv, x, y, c);
    if (x === x1 && y === y1) {
      return n;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
};

export const rect = (
  cv: Canvas,
  r: Rect,
  color: string,
  { fill: filled = false }: FillOptions = {}
): number => {
  const c = rgba(color);
  const [x0, y0, x1, y1] = clip(cv, r);
  const [rx, ry, rw, rh] = r;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (
        filled ||
        x === rx ||
        y === ry ||
        x === rx + rw - 1 ||
        y === ry + rh - 1
      ) {
        n += put(cv, x, y, c);
      }
    }
  }
  return n;
};

/** Zingl's ellipse-in-rectangle, the algorithm Aseprite's ellipse tool uses. Calls `plot` for every edge pixel. */
const ellipseEdge = (
  [x, y, w, h]: Rect,
  plot: (px: number, py: number) => void
): void => {
  let x0 = x;
  let x1 = x + w - 1;
  let y0 = y;
  let y1 = y + h - 1;
  const a = Math.abs(x1 - x0);
  const b = Math.abs(y1 - y0);
  const b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  y0 += Math.floor((b + 1) / 2);
  y1 = y0 - b1;
  const stepX = 8 * a * a;
  const stepY = 8 * b * b;
  do {
    plot(x1, y0);
    plot(x0, y0);
    plot(x0, y1);
    plot(x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0 += 1;
      y1 -= 1;
      dy += stepX;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0 += 1;
      x1 -= 1;
      dx += stepY;
      err += dx;
    }
  } while (x0 <= x1);
  // Flat ellipses (a = 1) stop early: finish the tips.
  while (y0 - y1 <= b) {
    plot(x0 - 1, y0);
    plot(x1 + 1, y0);
    y0 += 1;
    plot(x0 - 1, y1);
    plot(x1 + 1, y1);
    y1 -= 1;
  }
};

/** Ellipse inscribed in rect [x, y, w, h]. */
export const ellipse = (
  cv: Canvas,
  r: Rect,
  color: string,
  { fill: filled = false }: FillOptions = {}
): number => {
  const box = checkRect(r);
  const c = rgba(color);
  if (box[2] <= 0 || box[3] <= 0) {
    return 0;
  }
  const spans = new Map<number, [min: number, max: number]>();
  const points: [x: number, y: number][] = [];
  ellipseEdge(box, (x, y) => {
    points.push([x, y]);
    const s = spans.get(y);
    if (s) {
      s[0] = Math.min(s[0], x);
      s[1] = Math.max(s[1], x);
    } else {
      spans.set(y, [x, x]);
    }
  });
  let n = 0;
  if (filled) {
    for (const [y, [a, b]] of spans) {
      for (let x = a; x <= b; x += 1) {
        n += put(cv, x, y, c);
      }
    }
  } else {
    for (const [x, y] of points) {
      n += put(cv, x, y, c);
    }
  }
  return n;
};

/** Contiguous (4-neighbour) flood fill of the exact colour at (x, y). */
export const fill = (
  cv: Canvas,
  x: number,
  y: number,
  color: string
): number => {
  const { width: w, height: h, data: d } = cv;
  if (x < 0 || y < 0 || x >= w || y >= h) {
    return 0;
  }
  const c = rgba(color);
  const target = keyAt(d, (y * w + x) * 4);
  if (target === keyOf(c)) {
    return 0;
  }
  const seen = new Uint8Array(w * h);
  const stack = [y * w + x];
  seen[y * w + x] = 1;
  let n = 0;
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    const px0 = p % w;
    const py0 = (p - px0) / w;
    n += put(cv, px0, py0, c);
    for (const [nx, ny] of [
      [px0 + 1, py0],
      [px0 - 1, py0],
      [px0, py0 + 1],
      [px0, py0 - 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
        continue;
      }
      const q = ny * w + nx;
      if (!seen[q] && keyAt(d, q * 4) === target) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  return n;
};

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const AROUND = [...SIDES, [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;

interface Vote {
  n: number;
  rgb: Rgb;
}

/**
 * 1 px outline around everything opaque (alpha >= 128 counts as solid).
 * selective: outside the shape, each pixel derived from the fill it borders (darker and cooler on the shadow side,
 * lighter facing the top-left light); `color` is unused. outside / inside: `color` outside or on the edge.
 */
export const outline = (
  cv: Canvas,
  color: string | undefined,
  { mode = "selective", rect: r, strength = 0.6 }: OutlineOptions = {}
): number => {
  if (!OUTLINE_MODES.has(mode)) {
    throw new Error(
      `outline mode must be selective, outside or inside, got ${JSON.stringify(mode)}.`
    );
  }
  const { width: w, height: h, data: d } = cv;
  const alphaAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3];
  const isSolid = (x: number, y: number) => alphaAt(x, y) >= 128;
  const touchesEmpty = (x: number, y: number) =>
    SIDES.some(([dx, dy]) => !isSolid(x + dx, y + dy));
  const touchesSolid = (x: number, y: number) =>
    SIDES.some(([dx, dy]) => isSolid(x + dx, y + dy));
  const wanted =
    mode === "inside"
      ? (x: number, y: number) => isSolid(x, y) && touchesEmpty(x, y)
      : (x: number, y: number) => alphaAt(x, y) === 0 && touchesSolid(x, y);
  const flat = mode === "selective" ? null : rgba(color);
  const [x0, y0, x1, y1] = clip(cv, r);

  // Derived from the fill the pixel borders: its commonest solid neighbour, shaded by which side the shape lies on.
  const shaded = (x: number, y: number): Rgba | null => {
    const votes = new Map<string, Vote>();
    let pullX = 0;
    let pullY = 0;
    for (const [dx, dy] of AROUND) {
      if (!isSolid(x + dx, y + dy)) {
        continue;
      }
      const i = ((y + dy) * w + x + dx) * 4;
      const rgb: Rgb = [d[i], d[i + 1], d[i + 2]];
      const entry = votes.get(rgb.join(",")) ?? { n: 0, rgb };
      entry.n += 1;
      votes.set(rgb.join(","), entry);
      pullX += dx;
      pullY += dy;
    }
    let best: Vote | undefined;
    for (const v of votes.values()) {
      if (!best || v.n > best.n) {
        best = v;
      }
    }
    if (!best) {
      return null;
    }
    const [L, C, hue] = rgbToOklch(...best.rgb);
    // The shape lies right or below, so this edge faces the top-left light.
    const towardLight = pullX + pullY > 0;
    const factor = 1 - strength * (towardLight ? 0.35 : 0.85);
    const [sr, sg, sb] = oklchToRgb(
      L * factor,
      C * 1.1,
      towardLight ? hue : hueToward(hue, SHADOW_HUE, 20)
    );
    return [sr, sg, sb, 255];
  };

  const planned: [x: number, y: number, c: Rgba][] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (!wanted(x, y)) {
        continue;
      }
      const c = flat ?? shaded(x, y);
      if (c) {
        planned.push([x, y, c]);
      }
    }
  }
  // Applied after planning so one pixel's colour never feeds the next one's.
  let n = 0;
  for (const [x, y, c] of planned) {
    n += put(cv, x, y, c);
  }
  if (mode !== "inside") {
    // Solid pixels on the canvas edge want an outline pixel just outside it.
    const inRect = (x: number, y: number): boolean =>
      !r || (x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]);
    const edge: [solidX: number, solidY: number, x: number, y: number][] = [];
    for (let x = 0; x < w; x += 1) {
      edge.push([x, 0, x, -1], [x, h - 1, x, h]);
    }
    for (let y = 0; y < h; y += 1) {
      edge.push([0, y, -1, y], [w - 1, y, w, y]);
    }
    const lost = edge.filter(
      ([sx, sy, x, y]) => isSolid(sx, sy) && inRect(x, y)
    ).length;
    if (lost) {
      cv.clipped = (cv.clipped ?? 0) + lost;
    }
  }
  return n;
};

/** The pixels of rect as a new Canvas; parts outside the canvas are transparent. */
export const crop = (cv: Canvas, r: Rect): Canvas => {
  const [rx, ry, rw, rh] = checkRect(r);
  const out = blank(Math.max(0, rw), Math.max(0, rh));
  const [x0, y0, x1, y1] = clip(cv, r);
  for (let y = y0; y < y1; y += 1) {
    out.data.set(
      cv.data.subarray((y * cv.width + x0) * 4, (y * cv.width + x1) * 4),
      ((y - ry) * out.width + (x0 - rx)) * 4
    );
  }
  return out;
};

/** Copy pixels of `rect` in `src` (any cel, this one included) to (x, y) in `dst`, optionally flipped. Overwrites. */
export const copy = (
  dst: Canvas,
  src: Canvas,
  { rect: r, x, y, flip }: CopyOptions = {}
): number => {
  const [sx0, sy0, sx1, sy1] = clip(src, r);
  const w = sx1 - sx0;
  const h = sy1 - sy0;
  const ox = x ?? sx0;
  const oy = y ?? sy0;
  const tmp = crop(src, [sx0, sy0, w, h]).data;
  const fh = flip === "h" || flip === "hv";
  const fv = flip === "v" || flip === "hv";
  let n = 0;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const k = ((fv ? h - 1 - j : j) * w + (fh ? w - 1 - i : i)) * 4;
      n += put(dst, ox + i, oy + j, [
        tmp[k],
        tmp[k + 1],
        tmp[k + 2],
        tmp[k + 3],
      ]);
    }
  }
  return n;
};

const clearRaw = (cv: Canvas, [x0, y0, x1, y1]: Bounds): void => {
  for (let y = y0; y < y1; y += 1) {
    cv.data.fill(0, (y * cv.width + x0) * 4, (y * cv.width + x1) * 4);
  }
};
const copyRaw = (dst: Canvas, src: Canvas, ox: number, oy: number): void => {
  const s = src.data;
  for (let j = 0; j < src.height; j += 1) {
    for (let i = 0; i < src.width; i += 1) {
      const k = (j * src.width + i) * 4;
      put(dst, ox + i, oy + j, [s[k], s[k + 1], s[k + 2], s[k + 3]]);
    }
  }
};

/** Move the pixels inside rect by (dx, dy); vacated pixels become transparent, moved pixels land anywhere on the canvas. */
export const shift = (
  cv: Canvas,
  dx: number,
  dy: number,
  { rect: r }: RectOptions = {}
): number => {
  const [x0, y0, x1, y1] = clip(cv, r);
  const moved = crop(cv, [x0, y0, x1 - x0, y1 - y0]);
  const next = { ...cv, data: new Uint8Array(cv.data) };
  clearRaw(next, [x0, y0, x1, y1]);
  copyRaw(next, moved, x0 + dx, y0 + dy);
  cv.clipped = next.clipped;
  let n = 0;
  for (let i = 0; i < cv.data.length; i += 4) {
    if (keyAt(cv.data, i) !== keyAt(next.data, i)) {
      n += 1;
    }
  }
  cv.data.set(next.data);
  return n;
};

/** Replace exact colours: { "#from": "#to" }. */
export const recolor = (
  cv: Canvas,
  mapping: Record<string, string>,
  { rect: r }: RectOptions = {}
): number => {
  const table = new Map(
    Object.entries(mapping).map(([from, to]) => [keyOf(rgba(from)), rgba(to)])
  );
  const [x0, y0, x1, y1] = clip(cv, r);
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const to = table.get(keyAt(cv.data, (y * cv.width + x) * 4));
      if (to) {
        n += put(cv, x, y, to);
      }
    }
  }
  return n;
};

/** Make rect (default: the whole canvas) transparent. */
export const clear = (cv: Canvas, r?: Rect): number => {
  const [x0, y0, x1, y1] = clip(cv, r);
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      n += put(cv, x, y, CLEAR);
    }
  }
  return n;
};

/**
 * Reads pixels back in the `map` format. Keys from `palette` stay for the colours they name; other colours get
 * fresh one-character keys. "." is transparent and trailing dots are cut. The result lists only keys it used.
 */
export const read = (
  cv: Canvas,
  { rect: r, palette: preferred }: ReadOptions = {}
): PixelRows => {
  const keyByHex = new Map<string, string>();
  for (const [key, color] of Object.entries(preferred ?? {})) {
    const hex = normHex(color);
    const usable =
      !SKIP_CHARS.has(key) && [...key].length === 1 && !hex.endsWith("00");
    if (usable && !keyByHex.has(hex)) {
      keyByHex.set(hex, key);
    }
  }
  const reserved = new Set(keyByHex.values());
  const spare = MAP_KEYS.filter((k) => !reserved.has(k)).values();
  const [x0, y0, x1, y1] = clip(cv, r);
  const d = cv.data;
  const palette: Palette = {};
  const rows: string[] = [];
  for (let y = y0; y < y1; y += 1) {
    const cells: string[] = [];
    for (let x = x0; x < x1; x += 1) {
      const i = (y * cv.width + x) * 4;
      if (d[i + 3] === 0) {
        cells.push(".");
        continue;
      }
      const color = formatHex([d[i], d[i + 1], d[i + 2], d[i + 3]]);
      const hex = normHex(color);
      let key = keyByHex.get(hex);
      if (key === undefined) {
        const next = spare.next();
        if (next.done) {
          throw new Error(
            `Region has more than ${MAP_KEYS.length} colours; read a smaller rect or use view().`
          );
        }
        key = next.value;
        keyByHex.set(hex, key);
      }
      palette[key] ??= color;
      cells.push(key);
    }
    // No regex: /\.+$/ goes quadratic on long rows.
    let end = cells.length;
    while (end > 0 && cells[end - 1] === ".") {
      end -= 1;
    }
    rows.push(cells.slice(0, end).join(""));
  }
  return { palette, rows };
};

const tally = (counts: Map<number, number>, key: number): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1);
};

/** The colour with the highest count; the first one seen wins a tie. */
const mostCommon = (counts: Map<number, number>): number => {
  let best = 0;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
};

/**
 * Shrink by a whole factor: each factor x factor block becomes its most common visible colour, or transparent when
 * the block has none. Partial blocks at the right and bottom edges count too.
 */
export const downscale = (cv: Canvas, factor: number): Canvas => {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(
      `downscale(factor): factor must be a whole number >= 1, got ${factor}.`
    );
  }
  const out = blank(
    Math.ceil(cv.width / factor),
    Math.ceil(cv.height / factor)
  );
  const counts = new Map<number, number>();
  for (let by = 0; by < out.height; by += 1) {
    for (let bx = 0; bx < out.width; bx += 1) {
      counts.clear();
      const y1 = Math.min(cv.height, (by + 1) * factor);
      const x1 = Math.min(cv.width, (bx + 1) * factor);
      for (let y = by * factor; y < y1; y += 1) {
        for (let x = bx * factor; x < x1; x += 1) {
          const key = keyAt(cv.data, (y * cv.width + x) * 4);
          if (key !== 0) {
            tally(counts, key);
          }
        }
      }
      const key = mostCommon(counts);
      const o = (by * out.width + bx) * 4;
      out.data[o] = key >>> 24;
      out.data[o + 1] = (key >>> 16) & 0xff;
      out.data[o + 2] = (key >>> 8) & 0xff;
      out.data[o + 3] = key & 0xff;
    }
  }
  return out;
};

/** Distinct visible colours, most frequent first, at most `max`. */
export const colors = (cv: Canvas, max = 32): string[] => {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `colors(max): max must be a whole number >= 1, got ${max}.`
    );
  }
  const counts = new Map<number, number>();
  for (let i = 0; i < cv.data.length; i += 4) {
    const key = keyAt(cv.data, i);
    if (key !== 0) {
      tally(counts, key);
    }
  }
  return [...counts]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) =>
      formatHex([
        key >>> 24,
        (key >>> 16) & 0xff,
        (key >>> 8) & 0xff,
        key & 0xff,
      ])
    );
};
