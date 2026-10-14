// Pixels to PNG files: the encoder, layer compositing, upscaled views and the critique sheet.
import { deflateSync } from "node:zlib";

/** @typedef {{ width: number, height: number, data: Uint8Array }} Canvas RGBA, row-major */
/** @typedef {{ png: Buffer, width: number, height: number, scale: number }} Rendered */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MAX_OUTPUT_PIXELS = 4096 * 4096;

const CRC_LUT = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let bit = 0; bit < 8; bit++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_LUT[n] = c >>> 0;
}

function crc32(...parts) {
  let crc = 0xff_ff_ff_ff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++)
      crc = CRC_LUT[(crc ^ part[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function pngChunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8), body), 8 + body.length);
  return out;
}

/** 8-bit RGBA PNG; every row uses filter type 0. @param {Uint8Array} rgba */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // depth 8, colour type 6 (RGBA), deflate, adaptive filtering, no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Visible layers, bottom to top, source-over at their opacity (0-255).
 * Aseprite's other blend modes are drawn as normal on purpose: a view only has to be close.
 * @param {{ data: Uint8Array, visible?: boolean, opacity?: number }[]} layers
 * @returns {Canvas}
 */
export function composite(layers, width, height) {
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
      for (let c = 0; c < 3; c++) {
        data[i + c] = Math.round(
          (src[i + c] * sa + data[i + c] * da * (1 - sa)) / outA
        );
      }
      data[i + 3] = Math.round(outA * 255);
    }
  }
  return { data, height, width };
}

const checkerShade = (x, y, cell) =>
  (((x / cell) | 0) + ((y / cell) | 0)) & 1 ? 255 : 204;

function defaultScale(w, h, target) {
  return Math.max(1, Math.floor(target / Math.max(w, h)));
}

function guardSize(W, H, scale) {
  if (W * H > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `A ${scale}x view would be ${W}x${H} px, over the limit; use a smaller scale or a rect.`
    );
  }
}

/** Upscaled view; transparency shows a grey checkerboard. Without `scale` the longer side lands near 512 px. @returns {Rendered} */
export function renderView(
  cv,
  { scale = defaultScale(cv.width, cv.height, 512), checker = true } = {}
) {
  const W = cv.width * scale;
  const H = cv.height * scale;
  guardSize(W, H, scale);
  const out = new Uint8Array(W * H * 4);
  const cell = Math.max(2, scale >> 1);
  for (let y = 0; y < H; y++) {
    const sy = (y / scale) | 0;
    for (let x = 0; x < W; x++) {
      const s = (sy * cv.width + ((x / scale) | 0)) * 4;
      const o = (y * W + x) * 4;
      const a = cv.data[s + 3];
      if (!checker || a === 255) {
        out.set(cv.data.subarray(s, s + 4), o);
        continue;
      }
      const bg = checkerShade(x, y, cell);
      for (let c = 0; c < 3; c++) {
        out[o + c] = Math.round((cv.data[s + c] * a + bg * (255 - a)) / 255);
      }
      out[o + 3] = 255;
    }
  }
  return { height: H, png: encodePng(W, H, out), scale, width: W };
}

export const CRITIQUE_PANELS = ["color", "gray", "silhouette", "deutan", "1x"];
const SHEET_GAP = 4;
const SHEET_BACKGROUND = [96, 96, 104, 255];
// Machado et al. 2009, deuteranopia at full severity, applied to linear light.
const DEUTAN = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
];
const toLinear = (v) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fromLinear = (v) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

function shadePanel(kind, r, g, b) {
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
}

/**
 * Panels side by side for judging a sprite: colour, values (gray), silhouette, true size (1x), optionally deutan.
 * Without `scale`, a panel's longer side lands near 1024 px at most.
 * @returns {Rendered}
 */
export function critiqueSheet(
  cv,
  {
    panels = ["color", "gray", "silhouette", "1x"],
    scale = defaultScale(cv.width, cv.height, 1024),
  } = {}
) {
  for (const p of panels) {
    if (!CRITIQUE_PANELS.includes(p))
      throw new Error(
        `Unknown critique panel '${p}'. Choose from ${CRITIQUE_PANELS.join(", ")}.`
      );
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
  panels.forEach((kind, n) => {
    const s = scales[n];
    const cell = Math.max(2, s >> 1);
    for (let y = 0; y < h * s; y++) {
      for (let x = 0; x < w * s; x++) {
        const i = (((y / s) | 0) * w + ((x / s) | 0)) * 4;
        const a = data[i + 3];
        let rgb;
        let cover = a / 255;
        let bg = checkerShade(x, y, cell);
        if (kind === "silhouette") {
          rgb = [0, 0, 0];
          cover = a >= 128 ? 1 : 0;
          bg = 255;
        } else {
          rgb = shadePanel(kind, data[i], data[i + 1], data[i + 2]);
        }
        const o = ((SHEET_GAP + y) * W + left + x) * 4;
        for (let c = 0; c < 3; c++) {
          out[o + c] = Math.round(rgb[c] * cover + bg * (1 - cover));
        }
        out[o + 3] = 255;
      }
    }
    left += w * s + SHEET_GAP;
  });
  return { height: H, png: encodePng(W, H, out), scale, width: W };
}

/** Frames left to right, `gap` transparent columns apart, tops aligned. @param {Canvas[]} frames @returns {Canvas} */
export function frameStrip(frames, gap = 1) {
  const width = frames.reduce(
    (sum, f) => sum + f.width,
    gap * (frames.length - 1)
  );
  const height = Math.max(...frames.map((f) => f.height));
  const data = new Uint8Array(width * height * 4);
  let left = 0;
  for (const f of frames) {
    for (let y = 0; y < f.height; y++) {
      data.set(
        f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4),
        (y * width + left) * 4
      );
    }
    left += f.width + gap;
  }
  return { data, height, width };
}
