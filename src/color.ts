// Colour text, OKLCH maths for shade ramps, and the named-palette file.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type Rgba = [number, number, number, number];
export type Oklch = [number, number, number];
export type Palette = Record<string, string>;

// "." and " " mean "leave the pixel alone" in pixel maps, so a palette may not use them as keys.
const RESERVED_KEYS = new Set([".", " "]);

/** Any of #rgb, #rgba, #rrggbb, #rrggbbaa (the # is optional) to "rrggbbaa" in lower case. */
export const normHex = (c: unknown): string => {
  const m = /^#?(?<digits>[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(
    typeof c === "string" ? c.trim() : ""
  );
  if (!m) {
    throw new Error(
      `Not a colour: ${JSON.stringify(c)}. Use #rgb, #rgba, #rrggbb or #rrggbbaa.`
    );
  }
  let h = (m.groups?.digits ?? "").toLowerCase();
  if (h.length <= 4) {
    h = [...h].map((d) => d + d).join("");
  }
  return h.padEnd(8, "f");
};

export const parseHex = (c: unknown): Rgba => {
  const hex = normHex(c);
  const [r, g, b, a] = [0, 2, 4, 6].map((i) =>
    Number.parseInt(hex.slice(i, i + 2), 16)
  );
  return [r, g, b, a];
};

/** "#rrggbb" for opaque colours, "#rrggbbaa" otherwise. */
const hex = (v: number): string => Math.round(v).toString(16).padStart(2, "0");

export const formatHex = ([r, g, b, a = 255]: readonly number[]): string =>
  `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? "" : hex(a)}`;

// Oklab per Björn Ottosson, with sRGB transfer curves.
const toLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const fromLinear = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

/** [L 0..1, chroma, hue in degrees 0..360) */
export const rgbToOklch = (r: number, g: number, b: number): Oklch => {
  const [lr, lg, lb] = [r, g, b].map((v) => toLinear(v / 255));
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  );
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  return [
    L,
    C,
    C < 1e-7 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  ];
};

const LMS_TO_LINEAR: readonly Oklch[] = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

const linearFromOklch = (L: number, C: number, h: number): number[] => {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return LMS_TO_LINEAR.map(([kl, km, ks]) => kl * l + km * m + ks * s);
};

/** Colours outside sRGB keep lightness and hue and lose chroma. */
export const oklchToRgb = (L: number, C: number, h: number): Oklch => {
  const EPS = 5e-4;
  const inGamut = (rgb: number[]): boolean =>
    rgb.every((v) => v >= -EPS && v <= 1 + EPS);
  let rgb = linearFromOklch(L, C, h);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i += 1) {
      const probe = (lo + hi) / 2;
      if (inGamut(linearFromOklch(L, probe, h))) {
        lo = probe;
      } else {
        hi = probe;
      }
    }
    rgb = linearFromOklch(L, lo, h);
  }
  const [r, g, b] = rgb.map((v) =>
    Math.round(
      Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255
    )
  );
  return [r, g, b];
};

/** Moves hue h towards `target` along the shorter arc, by at most `deg` degrees. */
export const hueToward = (h: number, target: number, deg: number): number => {
  const arc = ((target - h + 540) % 360) - 180;
  return (h + Math.sign(arc) * Math.min(Math.abs(arc), deg) + 360) % 360;
};

// Violet: shadows cool down.
export const SHADOW_HUE = 290;
// Yellow: highlights warm up.
export const LIGHT_HUE = 100;

/** `n` hex colours from dark to light; the base sits at index floor(n / 2). */
export const rampColors = (base: string, n: number, shift = 20): string[] => {
  const baseRgba = parseHex(base);
  const { 3: alpha } = baseRgba;
  const [L, C, h] = rgbToOklch(baseRgba[0], baseRgba[1], baseRgba[2]);
  const mid = Math.floor(n / 2);
  const darkest = L * 0.45;
  const lightest = L + (0.96 - L) * 0.75;
  return Array.from({ length: n }, (_, i) => {
    if (i === mid) {
      return formatHex(baseRgba);
    }
    const below = i < mid;
    const t = below ? (mid - i) / mid : (i - mid) / (n - 1 - mid);
    const lum = below ? L + (darkest - L) * t : L + (lightest - L) * t;
    const hue = hueToward(h, below ? SHADOW_HUE : LIGHT_HUE, shift * t);
    return formatHex([...oklchToRgb(lum, C, hue), alpha]);
  });
};

/** ramp("#b13e53", "rstu") gives { r, s, t, u }, dark to light. */
export const ramp = (
  base: string,
  keys: string,
  { hueShift = 20 }: { hueShift?: number } = {}
): Palette => {
  const chars = [...String(keys)];
  const bad = chars.filter((k) => RESERVED_KEYS.has(k));
  if (bad.length) {
    throw new Error(
      `${bad.map((k) => JSON.stringify(k)).join(", ")} cannot be palette keys: they skip a pixel.`
    );
  }
  if (new Set(chars).size !== chars.length) {
    throw new Error(`Ramp keys must be distinct, got "${keys}".`);
  }
  const colors = rampColors(base, chars.length, hueShift);
  return Object.fromEntries(chars.map((k, i) => [k, colors[i]]));
};

/** The palettes file: { name: { key: colour } }. A missing file is an empty set. */
export const loadPalettes = async (
  file: string
): Promise<Record<string, Palette>> => {
  const text = await readFile(file, "utf-8").catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return null;
  });
  if (text === null) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The palettes file ${file} is not valid JSON.`);
  }
};

export const loadPalette = async (
  file: string,
  name: string
): Promise<Palette> => {
  const all = await loadPalettes(file);
  if (!Object.hasOwn(all, name)) {
    throw new Error(
      `No saved palette '${name}'. Saved: ${Object.keys(all).join(", ") || "none"}`
    );
  }
  return all[name];
};

export const savePalette = async (
  file: string,
  name: string,
  colors: Palette
): Promise<void> => {
  const clean: Palette = {};
  for (const [key, color] of Object.entries(colors)) {
    if ([...key].length !== 1 || RESERVED_KEYS.has(key)) {
      throw new Error(
        `${JSON.stringify(key)} cannot be palette keys: use one character other than "." and space.`
      );
    }
    clean[key] = formatHex(parseHex(color));
  }
  const all = await loadPalettes(file);
  all[name] = clean;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`);
  await rename(tmp, file);
};
