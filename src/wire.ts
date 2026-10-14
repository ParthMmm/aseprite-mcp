// The binary frame between the daemon and plugin.lua, and the colour-mode boundary: blobs on the wire are
// Image.bytes in the sprite's mode; everything past this module sees full-canvas RGBA.
import { normHex, parseHex } from "./color.ts";

export type ColorMode = "rgb" | "indexed" | "gray";
/** A frame's JSON message; its fields are unchecked extension or daemon data. */
export type WireMessage = Record<string, unknown>;
export interface DecodedFrame {
  msg: WireMessage;
  blobs: Uint8Array[];
}
export interface SpriteBytes {
  bytes: Uint8Array;
  /** Colours without an exact palette match, as "#rrggbbaa". */
  missing: string[];
}
/** [palette index, r, g, b, a] */
type PaletteEntry = [i: number, r: number, g: number, b: number, a: number];

export const PROTOCOL = 3;
const MAGIC = "AB";
const HEADER = 8;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isLengths = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 0);

/** One BINARY frame: "AB", version, flags 0, u32 LE JSON length, JSON (msg plus "blobs": lengths), blobs. */
export const encodeFrame = (
  msg: object,
  blobs: readonly Uint8Array[]
): Buffer => {
  const json = Buffer.from(
    JSON.stringify({ ...msg, blobs: blobs.map((b) => b.length) }),
    "utf-8"
  );
  let total = HEADER + json.length;
  for (const b of blobs) {
    total += b.length;
  }
  const out = Buffer.allocUnsafe(total);
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
};

/** Inverse of encodeFrame. Blobs are views into `buf` (no copy); `msg` comes back without its "blobs" field. */
export const decodeFrame = (buf: Uint8Array): DecodedFrame => {
  const b = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < HEADER || b.toString("latin1", 0, 2) !== MAGIC) {
    throw new Error("Not a binary frame: bad magic.");
  }
  if (b[2] !== PROTOCOL) {
    throw new Error(`Binary frame protocol ${b[2]}, expected ${PROTOCOL}.`);
  }
  if (b[3] !== 0) {
    throw new Error(`Binary frame flags ${b[3]} are not supported.`);
  }
  const jsonLen = b.readUInt32LE(4);
  if (HEADER + jsonLen > b.length) {
    throw new Error("Binary frame JSON runs past the end of the frame.");
  }
  const parsed: unknown = JSON.parse(
    b.toString("utf-8", HEADER, HEADER + jsonLen)
  );
  const { blobs: lengths, ...msg } = isRecord(parsed) ? parsed : {};
  if (!isLengths(lengths)) {
    throw new Error(
      'Binary frame JSON needs "blobs": an array of byte lengths.'
    );
  }
  let o = HEADER + jsonLen;
  const blobs = lengths.map((n) => {
    const blob = b.subarray(o, o + n);
    o += n;
    return blob;
  });
  if (o !== b.length) {
    throw new Error(
      `Binary frame blob lengths add up to ${o - HEADER - jsonLen} bytes, frame carries ${b.length - HEADER - jsonLen}.`
    );
  }
  return { blobs, msg };
};

const BYTES_PER_PIXEL: Record<ColorMode, number> = {
  gray: 2,
  indexed: 1,
  rgb: 4,
};

// The mode comes from the extension, so an unknown one is a runtime error, not a type error.
const bytesPerPixel = (colorMode: ColorMode): number => {
  const bpp = BYTES_PER_PIXEL[colorMode];
  if (!bpp) {
    throw new Error(`Unknown colour mode '${colorMode}'.`);
  }
  return bpp;
};

const pixelCount = (bytes: Uint8Array, colorMode: ColorMode): number => {
  const bpp = bytesPerPixel(colorMode);
  if (bytes.length % bpp) {
    throw new Error(
      `${bytes.length} bytes is not a whole number of ${colorMode} pixels.`
    );
  }
  return bytes.length / bpp;
};

/** Aseprite's rgba_luma. */
const luma = (r: number, g: number, b: number): number =>
  Math.floor((r * 2126 + g * 7152 + b * 722) / 10_000);

/**
 * Image.bytes in the sprite's mode -> RGBA. Indexed: the transparent index (and any index past the palette)
 * is transparent. Gray: (value, alpha) per pixel.
 */
export const toRgba = (
  bytes: Uint8Array,
  colorMode: ColorMode,
  palette: readonly string[],
  transparentIndex: number
): Uint8Array => {
  const n = pixelCount(bytes, colorMode);
  if (colorMode === "rgb") {
    return new Uint8Array(bytes);
  }
  const out = new Uint8Array(n * 4);
  if (colorMode === "gray") {
    for (let p = 0; p < n; p += 1) {
      const v = bytes[p * 2];
      const a = bytes[p * 2 + 1];
      if (a) {
        out.set([v, v, v, a], p * 4);
      }
    }
    return out;
  }
  const lut = palette.map((c) => parseHex(c));
  for (let p = 0; p < n; p += 1) {
    const idx = bytes[p];
    if (idx !== transparentIndex && idx < lut.length && lut[idx][3]) {
      out.set(lut[idx], p * 4);
    }
  }
  return out;
};

const nearest = (
  entries: readonly PaletteEntry[],
  r: number,
  g: number,
  b: number,
  a: number
): number | undefined => {
  let best: number | undefined;
  let bestD = Infinity;
  for (const [i, er, eg, eb, ea] of entries) {
    const d = (er - r) ** 2 + (eg - g) ** 2 + (eb - b) ** 2 + (ea - a) ** 2;
    if (d < bestD) {
      [best, bestD] = [i, d];
    }
  }
  return best;
};

/**
 * RGBA -> Image.bytes in the sprite's mode. Indexed: exact palette match, else the nearest entry; every colour
 * without an exact match is listed in `missing`. Gray stores luma and alpha.
 */
export const fromRgba = (
  rgba: Uint8Array,
  colorMode: ColorMode,
  palette: readonly string[],
  transparentIndex: number
): SpriteBytes => {
  const n = pixelCount(rgba, "rgb");
  bytesPerPixel(colorMode);
  if (colorMode === "rgb") {
    return { bytes: new Uint8Array(rgba), missing: [] };
  }
  if (colorMode === "gray") {
    const bytes = new Uint8Array(n * 2);
    for (let p = 0; p < n; p += 1) {
      const a = rgba[p * 4 + 3];
      if (a) {
        bytes.set(
          [luma(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]), a],
          p * 2
        );
      }
    }
    return { bytes, missing: [] };
  }
  const entries = palette
    .map((c, i) => ({ h: normHex(c), i }))
    .filter(({ i, h }) => i !== transparentIndex && !h.endsWith("00"));
  const exact = new Map<string, number>();
  for (const { i, h } of entries) {
    if (!exact.has(h)) {
      exact.set(h, i);
    }
  }
  const rgb = entries.map(({ i, h }): PaletteEntry => {
    const [r, g, b, a] = [0, 2, 4, 6].map((k) =>
      Number.parseInt(h.slice(k, k + 2), 16)
    );
    return [i, r, g, b, a];
  });
  const cache = new Map<number, number>();
  const missing: string[] = [];
  const bytes = new Uint8Array(n).fill(transparentIndex);
  for (let p = 0; p < n; p += 1) {
    const o = p * 4;
    if (rgba[o + 3] === 0) {
      continue;
    }
    const key =
      ((rgba[o] << 24) |
        (rgba[o + 1] << 16) |
        (rgba[o + 2] << 8) |
        rgba[o + 3]) >>>
      0;
    let idx = cache.get(key);
    if (idx === undefined) {
      const h = key.toString(16).padStart(8, "0");
      idx = exact.get(h);
      if (idx === undefined) {
        missing.push(`#${h}`);
        idx =
          nearest(rgb, rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]) ??
          transparentIndex;
      }
      cache.set(key, idx);
    }
    bytes[p] = idx;
  }
  return { bytes, missing };
};
