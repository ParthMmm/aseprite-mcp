// The binary frame between the daemon and plugin.lua, and the colour-mode boundary: blobs on the wire are
// Image.bytes in the sprite's mode; everything past this module sees full-canvas RGBA.
import { normHex, parseHex } from "./color.mjs";

/** @typedef {"rgb" | "indexed" | "gray"} ColorMode */

export const PROTOCOL = 3;
const MAGIC = "AB";
const HEADER = 8;

/**
 * One BINARY frame: "AB", version, flags 0, u32 LE JSON length, JSON (msg plus "blobs": lengths), blobs.
 * @param {object} msg @param {Uint8Array[]} blobs @returns {Buffer}
 */
export function encodeFrame(msg, blobs) {
  const json = Buffer.from(JSON.stringify({ ...msg, blobs: blobs.map((b) => b.length) }), "utf8");
  const out = Buffer.allocUnsafe(HEADER + json.length + blobs.reduce((n, b) => n + b.length, 0));
  out.write(MAGIC, 0, "latin1");
  out[2] = PROTOCOL;
  out[3] = 0;
  out.writeUInt32LE(json.length, 4);
  json.copy(out, HEADER);
  let o = HEADER + json.length;
  for (const b of blobs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/**
 * Inverse of encodeFrame. Blobs are views into `buf` (no copy); `msg` comes back without its "blobs" field.
 * @param {Uint8Array} buf @returns {{ msg: any, blobs: Uint8Array[] }}
 */
export function decodeFrame(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < HEADER || b.toString("latin1", 0, 2) !== MAGIC) throw new Error("Not a binary frame: bad magic.");
  if (b[2] !== PROTOCOL) throw new Error(`Binary frame protocol ${b[2]}, expected ${PROTOCOL}.`);
  if (b[3] !== 0) throw new Error(`Binary frame flags ${b[3]} are not supported.`);
  const jsonLen = b.readUInt32LE(4);
  if (HEADER + jsonLen > b.length) throw new Error("Binary frame JSON runs past the end of the frame.");
  const { blobs: lengths, ...msg } = JSON.parse(b.toString("utf8", HEADER, HEADER + jsonLen));
  if (!Array.isArray(lengths) || !lengths.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("Binary frame JSON needs \"blobs\": an array of byte lengths.");
  }
  let o = HEADER + jsonLen;
  const blobs = lengths.map((n) => {
    const blob = b.subarray(o, o + n);
    o += n;
    return blob;
  });
  if (o !== b.length) throw new Error(`Binary frame blob lengths add up to ${o - HEADER - jsonLen} bytes, frame carries ${b.length - HEADER - jsonLen}.`);
  return { msg, blobs };
}

const BYTES_PER_PIXEL = { rgb: 4, gray: 2, indexed: 1 };

function bytesPerPixel(colorMode) {
  const bpp = BYTES_PER_PIXEL[colorMode];
  if (!bpp) throw new Error(`Unknown colour mode '${colorMode}'.`);
  return bpp;
}

function pixelCount(bytes, colorMode) {
  const bpp = bytesPerPixel(colorMode);
  if (bytes.length % bpp) throw new Error(`${bytes.length} bytes is not a whole number of ${colorMode} pixels.`);
  return bytes.length / bpp;
}

/** Aseprite's rgba_luma. */
const luma = (r, g, b) => Math.floor((r * 2126 + g * 7152 + b * 722) / 10000);

/**
 * Image.bytes in the sprite's mode -> RGBA. Indexed: the transparent index (and any index past the palette)
 * is transparent. Gray: (value, alpha) per pixel.
 * @param {Uint8Array} bytes @param {ColorMode} colorMode @param {string[]} palette @param {number} transparentIndex
 * @returns {Uint8Array}
 */
export function toRgba(bytes, colorMode, palette, transparentIndex) {
  const n = pixelCount(bytes, colorMode);
  if (colorMode === "rgb") return new Uint8Array(bytes);
  const out = new Uint8Array(n * 4);
  if (colorMode === "gray") {
    for (let p = 0; p < n; p++) {
      const v = bytes[p * 2], a = bytes[p * 2 + 1];
      if (a) out.set([v, v, v, a], p * 4);
    }
    return out;
  }
  const lut = palette.map(parseHex);
  for (let p = 0; p < n; p++) {
    const idx = bytes[p];
    if (idx !== transparentIndex && idx < lut.length && lut[idx][3]) out.set(lut[idx], p * 4);
  }
  return out;
}

/**
 * RGBA -> Image.bytes in the sprite's mode. Indexed: exact palette match, else the nearest entry; every colour
 * without an exact match is listed in `missing` as "#rrggbbaa". Gray stores luma and alpha.
 * @param {Uint8Array} rgba @param {ColorMode} colorMode @param {string[]} palette @param {number} transparentIndex
 * @returns {{ bytes: Uint8Array, missing: string[] }}
 */
export function fromRgba(rgba, colorMode, palette, transparentIndex) {
  const n = pixelCount(rgba, "rgb");
  bytesPerPixel(colorMode);
  if (colorMode === "rgb") return { bytes: new Uint8Array(rgba), missing: [] };
  if (colorMode === "gray") {
    const bytes = new Uint8Array(n * 2);
    for (let p = 0; p < n; p++) {
      const a = rgba[p * 4 + 3];
      if (a) bytes.set([luma(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]), a], p * 2);
    }
    return { bytes, missing: [] };
  }
  const entries = palette
    .map((c, i) => ({ i, h: normHex(c) }))
    .filter(({ i, h }) => i !== transparentIndex && !h.endsWith("00"));
  const exact = new Map();
  for (const { i, h } of entries) if (!exact.has(h)) exact.set(h, i);
  const rgb = entries.map(({ i, h }) => [i, ...[0, 2, 4, 6].map((k) => parseInt(h.slice(k, k + 2), 16))]);
  const cache = new Map();
  const missing = [];
  const bytes = new Uint8Array(n).fill(transparentIndex);
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    if (rgba[o + 3] === 0) continue;
    const key = ((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0;
    let idx = cache.get(key);
    if (idx === undefined) {
      const h = key.toString(16).padStart(8, "0");
      idx = exact.get(h);
      if (idx === undefined) {
        missing.push("#" + h);
        idx = nearest(rgb, rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]) ?? transparentIndex;
      }
      cache.set(key, idx);
    }
    bytes[p] = idx;
  }
  return { bytes, missing };
}

function nearest(entries, r, g, b, a) {
  let best, bestD = Infinity;
  for (const [i, er, eg, eb, ea] of entries) {
    const d = (er - r) ** 2 + (eg - g) ** 2 + (eb - b) ** 2 + (ea - a) ** 2;
    if (d < bestD) [best, bestD] = [i, d];
  }
  return best;
}
