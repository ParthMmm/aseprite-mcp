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
} from "./color.mjs";

/** @typedef {{ width: number, height: number, data: Uint8Array }} Canvas */
/** @typedef {[number, number, number, number]} Rect  [x, y, w, h] */
/** @typedef {[number, number, number, number]} Rgba */
/** @typedef {"h" | "v" | "hv"} Flip */

const CLEAR = /** @type {Rgba} */ ([0, 0, 0, 0]);
export const SKIP_CHARS = new Set([".", " "]);
// Keys that `read` hands out. Quote and backslash are absent so rows stay cheap to escape in JSON.
const MAP_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+-/:;<=>?@^_~!|()[]{},'`",
];

/** @returns {Canvas} */
export const blank = (width, height) => ({
  data: new Uint8Array(width * height * 4),
  height,
  width,
});

/** @returns {Rgba} */
function rgba(c) {
  const v = parseHex(c);
  return v[3] === 0 ? CLEAR : v;
}

/** @returns {0 | 1} */
function put(cv, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) {
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
}

/** 32-bit key of the pixel at byte offset i; every transparent pixel is 0. */
function keyAt(d, i) {
  return d[i + 3] === 0
    ? 0
    : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
}
const keyOf = ([r, g, b, a]) =>
  a === 0 ? 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

function checkRect(r) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger)) {
    throw new Error(
      `rect must be [x, y, width, height] in whole pixels, got ${JSON.stringify(r)}.`
    );
  }
  return /** @type {Rect} */ (r);
}

/** Clip a rect to the canvas. @returns {[number, number, number, number]} [x0, y0, x1, y1), possibly empty */
export function clip(cv, r) {
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
}

export function flipRows(rows, flip) {
  const horizontal = flip === "h" || flip === "hv";
  const vertical = flip === "v" || flip === "hv";
  const width = Math.max(0, ...rows.map((r) => [...r].length));
  const mirrored = horizontal
    ? rows.map((r) => [...r.padEnd(width, ".")].reverse().join(""))
    : rows;
  return vertical ? mirrored.toReversed() : mirrored;
}

/**
 * Pixel map: one character per pixel. "." and " " leave the pixel; a key mapped to "#00000000" erases.
 * Validates every character before writing, so a bad map changes nothing.
 * @param {Canvas} cv @param {Record<string, string>} palette @param {string[]} rows
 * @param {{ x?: number, y?: number, flip?: Flip }} [o]
 */
export function map(cv, palette, rows, { x = 0, y = 0, flip } = {}) {
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
  chars.forEach((row, j) =>
    row.forEach((ch, i) => {
      if (!SKIP_CHARS.has(ch)) {
        n += put(cv, x + i, y + j, colors.get(ch));
      }
    })
  );
  return n;
}

/** @param {[number, number, string][]} points */
export function px(cv, points) {
  const cache = new Map();
  const col = (c) => cache.get(c) ?? cache.set(c, rgba(c)).get(c);
  for (const p of points) {
    col(p[2]);
  }
  let n = 0;
  for (const [x, y, c] of points) {
    n += put(cv, x, y, col(c));
  }
  return n;
}

/** Bresenham, both ends inclusive. */
export function line(cv, x0, y0, x1, y1, color) {
  const c = rgba(color);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let n = 0;
  for (;;) {
    n += put(cv, x0, y0, c);
    if (x0 === x1 && y0 === y1) {
      return n;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** @param {Rect} r */
export function rect(cv, r, color, { fill = false } = {}) {
  const c = rgba(color);
  const [x0, y0, x1, y1] = clip(cv, r);
  const [rx, ry, rw, rh] = r;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (
        fill ||
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
}

/** Zingl's ellipse-in-rectangle, the algorithm Aseprite's ellipse tool uses. @returns {Map<number, [number, number]>} row -> [minX, maxX] */
function ellipseSpans([x, y, w, h], plot) {
  let x0 = x;
  let x1 = x + w - 1;
  let y0 = y;
  let y1 = y + h - 1;
  let a = Math.abs(x1 - x0);
  let b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  y0 += Math.floor((b + 1) / 2);
  y1 = y0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  do {
    plot(x1, y0);
    plot(x0, y0);
    plot(x0, y1);
    plot(x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      err += dy += a;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      err += dx += b1;
    }
  } while (x0 <= x1);
  while (y0 - y1 <= b) {
    // flat ellipses (a = 1) stop early: finish the tips
    plot(x0 - 1, y0);
    plot(x1 + 1, y0++);
    plot(x0 - 1, y1);
    plot(x1 + 1, y1--);
  }
}

/** Ellipse inscribed in rect [x, y, w, h]. */
export function ellipse(cv, r, color, { fill = false } = {}) {
  checkRect(r);
  const c = rgba(color);
  if (r[2] <= 0 || r[3] <= 0) {
    return 0;
  }
  /** @type {Map<number, [number, number]>} */
  const spans = new Map();
  const points = [];
  ellipseSpans(r, (x, y) => {
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
  if (fill) {
    for (const [y, [a, b]] of spans)
      for (let x = a; x <= b; x++) n += put(cv, x, y, c);
  } else {
    for (const [x, y] of points) n += put(cv, x, y, c);
  }
  return n;
}

/** Contiguous (4-neighbour) flood fill of the exact colour at (x, y). */
export function fill(cv, x, y, color) {
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
  while (stack.length) {
    const p = stack.pop();
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
}

/**
 * 1 px outline around everything opaque (alpha >= 128 counts as solid).
 * selective: outside the shape, each pixel derived from the fill it borders (darker and cooler on the shadow side,
 * lighter facing the top-left light); `color` is unused. outside / inside: `color` outside or on the edge.
 */
export function outline(
  cv,
  color,
  { mode = "selective", rect: r, strength = 0.6 } = {}
) {
  if (!["selective", "outside", "inside"].includes(mode)) {
    throw new Error(
      `outline mode must be selective, outside or inside, got ${JSON.stringify(mode)}.`
    );
  }
  const { width: w, height: h, data: d } = cv;
  const alphaAt = (x, y) =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3];
  const isSolid = (x, y) => alphaAt(x, y) >= 128;
  const SIDES = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const AROUND = [...SIDES, [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const touchesEmpty = (x, y) =>
    SIDES.some(([dx, dy]) => !isSolid(x + dx, y + dy));
  const touchesSolid = (x, y) =>
    SIDES.some(([dx, dy]) => isSolid(x + dx, y + dy));
  const wanted =
    mode === "inside"
      ? (x, y) => isSolid(x, y) && touchesEmpty(x, y)
      : (x, y) => alphaAt(x, y) === 0 && touchesSolid(x, y);
  const flat = mode === "selective" ? null : rgba(color);
  const [x0, y0, x1, y1] = clip(cv, r);

  // Derived from the fill the pixel borders: its commonest solid neighbour, shaded by which side the shape lies on.
  function shaded(x, y) {
    const votes = new Map();
    let pullX = 0;
    let pullY = 0;
    for (const [dx, dy] of AROUND) {
      if (!isSolid(x + dx, y + dy)) {
        continue;
      }
      const i = ((y + dy) * w + x + dx) * 4;
      const rgb = [d[i], d[i + 1], d[i + 2]];
      const entry = votes.get(rgb.join(",")) ?? { n: 0, rgb };
      entry.n++;
      votes.set(rgb.join(","), entry);
      pullX += dx;
      pullY += dy;
    }
    if (!votes.size) {
      return null;
    }
    const { rgb } = [...votes.values()].reduce((best, v) =>
      v.n > best.n ? v : best
    );
    const [L, C, hue] = rgbToOklch(...rgb);
    const towardLight = pullX + pullY > 0; // shape lies right or below, so this edge faces the top-left light
    const factor = 1 - strength * (towardLight ? 0.35 : 0.85);
    return [
      ...oklchToRgb(
        L * factor,
        C * 1.1,
        towardLight ? hue : hueToward(hue, SHADOW_HUE, 20)
      ),
      255,
    ];
  }

  const planned = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
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
  return planned.reduce((n, [x, y, c]) => n + put(cv, x, y, c), 0);
}

/** Copy pixels of `rect` in `src` (any cel, this one included) to (x, y) in `dst`, optionally flipped. Overwrites. */
export function copy(dst, src, { rect: r, x, y, flip } = {}) {
  const [sx0, sy0, sx1, sy1] = clip(src, r);
  const w = sx1 - sx0;
  const h = sy1 - sy0;
  const ox = x ?? sx0;
  const oy = y ?? sy0;
  const tmp = crop(src, [sx0, sy0, w, h]).data;
  const fh = flip === "h" || flip === "hv";
  const fv = flip === "v" || flip === "hv";
  let n = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
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
}

/** Move the pixels inside rect by (dx, dy); vacated pixels become transparent, moved pixels land anywhere on the canvas. */
export function shift(cv, dx, dy, { rect: r } = {}) {
  const [x0, y0, x1, y1] = clip(cv, r);
  const moved = crop(cv, [x0, y0, x1 - x0, y1 - y0]);
  const next = { ...cv, data: cv.data.slice() };
  clearRaw(next, [x0, y0, x1, y1]);
  copyRaw(next, moved, x0 + dx, y0 + dy);
  let n = 0;
  for (let i = 0; i < cv.data.length; i += 4) {
    if (keyAt(cv.data, i) !== keyAt(next.data, i)) n++;
  }
  cv.data.set(next.data);
  return n;
}

function clearRaw(cv, [x0, y0, x1, y1]) {
  for (let y = y0; y < y1; y++) {
    cv.data.fill(0, (y * cv.width + x0) * 4, (y * cv.width + x1) * 4);
  }
}
function copyRaw(dst, src, ox, oy) {
  for (let j = 0; j < src.height; j++) {
    for (let i = 0; i < src.width; i++) {
      const k = (j * src.width + i) * 4,
        s = src.data;
      put(dst, ox + i, oy + j, [s[k], s[k + 1], s[k + 2], s[k + 3]]);
    }
  }
}

/** Replace exact colours: { "#from": "#to" }. */
export function recolor(cv, mapping, { rect: r } = {}) {
  const table = new Map(
    Object.entries(mapping).map(([from, to]) => [keyOf(rgba(from)), rgba(to)])
  );
  const [x0, y0, x1, y1] = clip(cv, r);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const to = table.get(keyAt(cv.data, (y * cv.width + x) * 4));
      if (to) n += put(cv, x, y, to);
    }
  }
  return n;
}

/** Make rect (default: the whole canvas) transparent. */
export function clear(cv, r) {
  const [x0, y0, x1, y1] = clip(cv, r);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) n += put(cv, x, y, CLEAR);
  }
  return n;
}

/** The pixels of rect as a new Canvas; parts outside the canvas are transparent. @returns {Canvas} */
export function crop(cv, r) {
  const [rx, ry, rw, rh] = checkRect(r);
  const out = blank(Math.max(0, rw), Math.max(0, rh));
  const [x0, y0, x1, y1] = clip(cv, r);
  for (let y = y0; y < y1; y++) {
    out.data.set(
      cv.data.subarray((y * cv.width + x0) * 4, (y * cv.width + x1) * 4),
      ((y - ry) * out.width + (x0 - rx)) * 4
    );
  }
  return out;
}

/**
 * Reads pixels back in the `map` format. Keys from `palette` stay for the colours they name; other colours get
 * fresh one-character keys. "." is transparent and trailing dots are cut. The result lists only keys it used.
 * @returns {{ palette: Record<string, string>, rows: string[] }}
 */
export function read(cv, { rect: r, palette: preferred } = {}) {
  const keyOf = new Map(); // "rrggbbaa" -> key
  for (const [key, color] of Object.entries(preferred ?? {})) {
    const hex = normHex(color);
    const usable =
      !SKIP_CHARS.has(key) && [...key].length === 1 && !hex.endsWith("00");
    if (usable && !keyOf.has(hex)) {
      keyOf.set(hex, key);
    }
  }
  const reserved = new Set(keyOf.values());
  const spare = MAP_KEYS.filter((k) => !reserved.has(k)).values();
  const [x0, y0, x1, y1] = clip(cv, r);
  const palette = {};
  const rows = [];
  for (let y = y0; y < y1; y++) {
    const cells = [];
    for (let x = x0; x < x1; x++) {
      const i = (y * cv.width + x) * 4;
      if (cv.data[i + 3] === 0) {
        cells.push(".");
        continue;
      }
      const color = formatHex(cv.data.subarray(i, i + 4));
      const hex = normHex(color);
      let key = keyOf.get(hex);
      if (key === undefined) {
        const next = spare.next();
        if (next.done) {
          throw new Error(
            `Region has more than ${MAP_KEYS.length} colours; read a smaller rect or use view().`
          );
        }
        key = next.value;
        keyOf.set(hex, key);
      }
      palette[key] ??= color;
      cells.push(key);
    }
    let end = cells.length;
    while (end > 0 && cells[end - 1] === ".") {
      end--;
    } // no regex: /\.+$/ goes quadratic on long rows
    rows.push(cells.slice(0, end).join(""));
  }
  return { palette, rows };
}
