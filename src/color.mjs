// Colour text, OKLCH maths for shade ramps, and the named-palette file.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** @typedef {[number, number, number, number]} Rgba */

// "." and " " mean "leave the pixel alone" in pixel maps, so a palette may not use them as keys.
const RESERVED_KEYS = new Set([".", " "]);

/** Any of #rgb, #rgba, #rrggbb, #rrggbbaa (the # is optional) to "rrggbbaa" in lower case. */
export function normHex(c) {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(typeof c === "string" ? c.trim() : "");
  if (!m) throw new Error(`Not a colour: ${JSON.stringify(c)}. Use #rgb, #rgba, #rrggbb or #rrggbbaa.`);
  let h = m[1].toLowerCase();
  if (h.length <= 4) h = [...h].map((d) => d + d).join("");
  return h.padEnd(8, "f");
}

/** @returns {Rgba} */
export function parseHex(c) {
  const hex = normHex(c);
  return /** @type {Rgba} */ ([0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)));
}

/** "#rrggbb" for opaque colours, "#rrggbbaa" otherwise. */
export function formatHex([r, g, b, a = 255]) {
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;
}

// Oklab per Björn Ottosson, with sRGB transfer curves.
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** @returns {[number, number, number]} [L 0..1, chroma, hue in degrees 0..360) */
export function rgbToOklch(r, g, b) {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  return [L, C, C < 1e-7 ? 0 : (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360];
}

const LMS_TO_LINEAR = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

function linearFromOklch(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return LMS_TO_LINEAR.map(([kl, km, ks]) => kl * l + km * m + ks * s);
}

/** Colours outside sRGB keep lightness and hue and lose chroma. @returns {[number, number, number]} */
export function oklchToRgb(L, C, h) {
  const EPS = 5e-4;
  const inGamut = (rgb) => rgb.every((v) => v >= -EPS && v <= 1 + EPS);
  let rgb = linearFromOklch(L, C, h);
  if (!inGamut(rgb)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 24; i++) {
      const probe = (lo + hi) / 2;
      if (inGamut(linearFromOklch(L, probe, h))) lo = probe;
      else hi = probe;
    }
    rgb = linearFromOklch(L, lo, h);
  }
  return /** @type {[number, number, number]} */ (rgb.map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255)));
}

/** Moves hue h towards `target` along the shorter arc, by at most `deg` degrees. */
export function hueToward(h, target, deg) {
  const arc = ((target - h + 540) % 360) - 180;
  return (h + Math.sign(arc) * Math.min(Math.abs(arc), deg) + 360) % 360;
}

export const SHADOW_HUE = 290; // violet: shadows cool down
export const LIGHT_HUE = 100; // yellow: highlights warm up

/** `n` hex colours from dark to light; the base sits at index floor(n / 2). */
export function rampColors(base, n, shift = 20) {
  const baseRgba = parseHex(base);
  const alpha = baseRgba[3];
  const [L, C, h] = rgbToOklch(...baseRgba);
  const mid = Math.floor(n / 2);
  const darkest = L * 0.45;
  const lightest = L + (0.96 - L) * 0.75;
  return [...Array(n).keys()].map((i) => {
    if (i === mid) return formatHex(baseRgba);
    const below = i < mid;
    const t = below ? (mid - i) / mid : (i - mid) / (n - 1 - mid);
    const lum = below ? L + (darkest - L) * t : L + (lightest - L) * t;
    const hue = hueToward(h, below ? SHADOW_HUE : LIGHT_HUE, shift * t);
    return formatHex([...oklchToRgb(lum, C, hue), alpha]);
  });
}

/** ramp("#b13e53", "rstu") gives { r, s, t, u }, dark to light. */
export function ramp(base, keys, { hueShift = 20 } = {}) {
  const chars = [...String(keys)];
  const bad = chars.filter((k) => RESERVED_KEYS.has(k));
  if (bad.length) throw new Error(`${bad.map((k) => JSON.stringify(k)).join(", ")} cannot be palette keys: they skip a pixel.`);
  if (new Set(chars).size !== chars.length) throw new Error(`Ramp keys must be distinct, got "${keys}".`);
  const colors = rampColors(base, chars.length, hueShift);
  return Object.fromEntries(chars.map((k, i) => [k, colors[i]]));
}

/** The palettes file: { name: { key: colour } }. A missing file is an empty set. */
export async function loadPalettes(file) {
  const text = await readFile(file, "utf8").catch((err) => {
    if (err.code !== "ENOENT") throw err;
    return null;
  });
  if (text === null) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The palettes file ${file} is not valid JSON.`);
  }
}

/** @returns {Promise<Record<string, string>>} */
export async function loadPalette(file, name) {
  const all = await loadPalettes(file);
  if (!Object.hasOwn(all, name)) throw new Error(`No saved palette '${name}'. Saved: ${Object.keys(all).join(", ") || "none"}`);
  return all[name];
}

export async function savePalette(file, name, colors) {
  const clean = {};
  for (const [key, color] of Object.entries(colors)) {
    if ([...key].length !== 1 || RESERVED_KEYS.has(key)) throw new Error(`${JSON.stringify(key)} cannot be palette keys: use one character other than "." and space.`);
    clean[key] = formatHex(parseHex(color));
  }
  const all = await loadPalettes(file);
  all[name] = clean;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(all, null, 2) + "\n");
  await rename(tmp, file);
}
