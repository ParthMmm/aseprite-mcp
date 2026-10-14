// The code-mode runtime: one execute() runs one agent program against per-sprite Drafts, then commits what is
// left as one undo step per sprite. Globals: sprite, sprites, image, ramp, palette, help. Handles are plain objects of
// closures; mutable state is behind methods because codemode copies plain fields once at the boundary.
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import nodePath from "node:path";

import { CodeMode, Extension } from "@opencode/codemode";
import { Effect } from "effect";

import { ramp, loadPalette, savePalette } from "./color.ts";
import * as D from "./draft.ts";
import type { CelKey, Draft } from "./draft.ts";
import { insideAllowedDir } from "./files.ts";
import { help } from "./help.ts";
import type { Link } from "./link.ts";
import * as R from "./raster.ts";
import {
  composite,
  critiqueSheet,
  decodePng,
  encodeGif,
  encodePng,
  frameStrip,
  gridSheet,
  renderView,
  upscale,
} from "./render.ts";
import { fromRgba, toRgba } from "./wire.ts";
import type { ColorMode } from "./wire.ts";

export { DESCRIPTION } from "./help.ts";

/** The daemon's connection to the Aseprite extension; replies are unchecked extension JSON. */

export interface Limits {
  draftBytes: number;
  maxOutputBytes: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface RuntimeOptions {
  link: Link;
  viewsDir: string;
  palettesFile: string;
  /** Where bare names such as "slime" are saved and opened; null disables bare names. */
  spritesDir?: string | null;
  allowedDirs?: string[];
  limits?: Partial<Limits>;
}

export interface CommitInfo {
  sprite: number;
  name: string;
  label: string;
  cels: number;
  pixels: number;
  merged: number;
  lost: number;
}

/** A rect, or "selection" for the artist's selection. */
type RectArg = R.Rect | "selection";
type WithRect<O> = Omit<O, "rect"> & { rect?: RectArg };

/**
 * What a program passes as `from` to copy(): { layer, frame?, sprite? } or { image }. Handles themselves cannot
 * cross back into a host call because codemode refuses arguments that hold functions.
 */
interface CelRef {
  layer?: string;
  frame?: number;
  sprite?: number;
  image?: number;
}

/** A PNG loaded by image(); `image` indexes the run's loaded pictures. */
export interface ImageHandle {
  image: number;
  width: number;
  height: number;
  colors: (max?: number) => string[];
  downscale: (factor: number) => ImageHandle;
  read: (o?: R.ReadOptions) => R.PixelRows;
}

export interface ExportOptions {
  scale?: number;
  tag?: string;
  sheet?: boolean;
  gif?: boolean;
  columns?: number;
}

/** Absolute paths of the files written; width and height are one frame's size in them. */
export interface ExportResult {
  sheet?: string;
  json?: string;
  gif?: string;
  frames: number;
  width: number;
  height: number;
}

export interface CelHandle {
  layer: string;
  frame: number;
  sprite: number;
  clear: (r?: RectArg) => number;
  copy: (from: CelRef | undefined, o?: WithRect<R.CopyOptions>) => number;
  ellipse: (r: RectArg, color: string, o?: R.FillOptions) => number;
  fill: (x: number, y: number, color: string) => number;
  line: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string
  ) => number;
  map: (
    palette: R.Palette | undefined,
    rows: unknown,
    o?: R.MapOptions
  ) => number;
  outline: (
    color?: string | WithRect<R.OutlineOptions>,
    o?: WithRect<R.OutlineOptions>
  ) => number;
  px: (points: R.Point[]) => number;
  read: (o?: WithRect<R.ReadOptions>) => R.PixelRows;
  recolor: (
    mapping: Record<string, string>,
    o?: WithRect<R.RectOptions>
  ) => number;
  rect: (r: RectArg, color: string, o?: R.FillOptions) => number;
  shift: (dx: number, dy: number, o?: WithRect<R.RectOptions>) => number;
}

export interface ViewOptions {
  frame?: number | "all";
  rect?: RectArg;
  scale?: number;
  critique?: boolean;
}

export interface ViewResult {
  path: string;
  width: number;
  height: number;
}

/** One cel the artist changed since this daemon last looked. */
export type ArtistChange = R.PixelRows & {
  layer: string;
  frame: number;
  rect: R.Rect;
};

export interface SpriteHandle {
  id: number;
  name: string;
  width: number;
  height: number;
  colorMode: ColorMode;
  cel: (layer: string, frame?: number) => CelHandle;
  cels: (layer: string) => CelHandle[];
  changes: () => Promise<ArtistChange[]>;
  commit: (label?: unknown) => Promise<CommitInfo>;
  export: (nameOrPath: unknown, o?: ExportOptions) => Promise<ExportResult>;
  frames: () => number;
  layer: (name: string, o?: D.LayerOptions) => void;
  layers: () => string[];
  redo: (n?: number) => Promise<void>;
  save: (path?: unknown) => Promise<unknown>;
  selection: () => R.Rect | null;
  setFrames: (count: number, o?: { duration?: unknown }) => void;
  tag: (
    name: string,
    from: number,
    to: number,
    o?: { direction?: D.TagDirection }
  ) => void;
  undo: (n?: number) => Promise<void>;
  view: (o?: ViewOptions) => Promise<ViewResult>;
}

/** One sprite inside one run: `d` is replaced on undo/redo/changes, so handles read it through the state. */
interface SpriteState {
  d: Draft;
  handle?: SpriteHandle;
}

interface Run {
  states: Map<number, SpriteState>;
  /** Pictures loaded by image() in this run, indexed by ImageHandle.image. */
  loaded: R.Canvas[];
  images: string[];
  commits: CommitInfo[];
}

export interface SpriteOptions {
  new?: [w: number, h: number];
  colorMode?: ColorMode;
  open?: unknown;
  id?: number;
  name?: string;
}

interface Discarded {
  cels: number;
  sprite: number;
}

interface EnvelopeBase {
  commit: CommitInfo[];
  images: string[];
  logs?: readonly string[];
  ms: number;
}
export interface ExecuteSuccess extends EnvelopeBase {
  ok: true;
  value: unknown;
  warnings?: readonly CodeMode.Diagnostic[];
}
export interface ExecuteFailure extends EnvelopeBase {
  ok: false;
  error: { kind: string; message: string; line?: number };
  discarded?: Discarded[];
}
/** What execute() hands back to the agent; it never rejects. */
export type ExecuteResult = ExecuteSuccess | ExecuteFailure;

interface CommitReply {
  applied?: boolean;
  cels?: number;
  reason?: string;
  message?: string;
  conflicts?: { write: number; blob?: number | null }[];
}

export const DEFAULT_LIMITS: Limits = {
  draftBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64_000,
  maxToolCalls: 10_000,
  timeoutMs: 60_000,
};
const MAX_RETRIES = 3;
const KEEP_VIEWS = 200;
// Lua prefixes "MCP: ".
const AUTO_LABEL = "program";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const record = (cmd: string, v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) {
    throw new Error(`Aseprite sent a malformed ${cmd} reply.`);
  }
  return v;
};

const isSnapshot = (v: unknown): v is D.SnapshotReply =>
  isRecord(v) &&
  isRecord(v.sprite) &&
  Array.isArray(v.palette) &&
  Array.isArray(v.frames) &&
  Array.isArray(v.layers) &&
  Array.isArray(v.tags) &&
  Array.isArray(v.cels);

const isCommitReply = (v: unknown): v is CommitReply =>
  isRecord(v) && (v.conflicts === undefined || Array.isArray(v.conflicts));

const messageOf = (e: unknown): string =>
  String(
    (typeof e === "object" && e !== null && "message" in e
      ? e.message
      : undefined) ?? e
  );

const mb = (n: number): number => Math.ceil(n / (1024 * 1024));

/** cel key -> base bytes: what Aseprite holds according to this draft. */
const baseMap = (d: Draft): Map<CelKey, Uint8Array> => {
  const out = new Map<CelKey, Uint8Array>();
  for (const [key, buf] of d.cels) {
    if (buf.base) {
      out.set(key, buf.base);
    }
  }
  return out;
};

const pending = (d: Draft): { cels: number; dirty: boolean } => {
  try {
    const p = D.plan(d);
    return {
      cels: p.writes.length,
      dirty: p.ops.length > 0 || p.writes.length > 0,
    };
  } catch {
    return { cels: 0, dirty: true };
  }
};

const visible = (a: Uint8Array, i: number): number =>
  a[i + 3] === 0
    ? 0
    : ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0;

/** Bounding rect of pixels whose visible value differs; null = no difference. */
const diffRect = (
  a: Uint8Array | null,
  b: Uint8Array | null,
  w: number,
  h: number
): R.Rect | null => {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if ((a ? visible(a, i) : 0) === (b ? visible(b, i) : 0)) {
        continue;
      }
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
};

const byLayerThenFrame = (a: ArtistChange, b: ArtistChange): number => {
  if (a.layer < b.layer) {
    return -1;
  }
  if (a.layer > b.layer) {
    return 1;
  }
  return a.frame - b.frame;
};

const selectionRect = (d: Draft): R.Rect => {
  const sel = d.sprite.selection;
  if (!sel) {
    throw new Error(
      `No selection in '${d.sprite.name}'; pass a rect [x, y, w, h] instead.`
    );
  }
  return sel;
};
const rectOf = (d: Draft, r: RectArg): R.Rect =>
  r === "selection" ? selectionRect(d) : r;
const rectIn = (d: Draft, o?: { rect?: RectArg }): R.Rect | undefined =>
  o?.rect === undefined ? undefined : rectOf(d, o.rect);

const checkMap: (
  palette: R.Palette | undefined,
  rows: unknown
) => asserts rows is string[] = (palette, rows) => {
  if (!Array.isArray(rows) || rows.some((r) => typeof r !== "string")) {
    throw new Error("map: rows must be an array of strings.");
  }
  const keys = new Set(Object.keys(palette ?? {}));
  for (const [j, row] of rows.entries()) {
    for (const ch of row) {
      if (ch === "." || ch === " " || keys.has(ch)) {
        continue;
      }
      throw new Error(
        `map: row ${j} uses key ${JSON.stringify(ch)}, which is not in the palette (keys: ${[...keys].join("") || "none"}). Use "." or space to skip a pixel.`
      );
    }
  }
};

/** Visible pixel layers of one frame, composited bottom to top; a hidden group hides its children. */
const flatten = (d: Draft, frame: number): R.Canvas => {
  const byPath = new Map(d.structure.layers.map((l) => [l.path, l]));
  const shown = (path: string): boolean => {
    for (let p = path; ; p = p.slice(0, p.lastIndexOf("/"))) {
      if (!byPath.get(p)?.visible) {
        return false;
      }
      if (!p.includes("/")) {
        return true;
      }
    }
  };
  const layers = d.structure.layers
    .filter((l) => !l.group && shown(l.path))
    .map((l) => ({ data: D.readable(d, l.path, frame), opacity: l.opacity }));
  return composite(layers, d.sprite.width, d.sprite.height);
};

const celHandle = (
  run: Run,
  st: SpriteState,
  layer: string,
  frame: number
): CelHandle => {
  D.readable(st.d, layer, frame);
  const canvas = (data: Uint8Array): R.Canvas => ({
    data,
    height: st.d.sprite.height,
    width: st.d.sprite.width,
  });
  const cv = () => canvas(D.writable(st.d, layer, frame));
  const ro = () => canvas(D.readable(st.d, layer, frame));
  return {
    clear: (r) => R.clear(cv(), r === undefined ? undefined : rectOf(st.d, r)),
    copy: (from, o) => {
      if (from?.image !== undefined) {
        const picture = run.loaded[from.image];
        if (!picture || o?.rect === "selection") {
          throw new Error(
            "copy: pass { image: img.image } for an image from image(path); rect is [x, y, w, h] in the image."
          );
        }
        return R.copy(cv(), picture, { ...o, rect: o?.rect });
      }
      const src = from?.sprite === undefined ? st : run.states.get(from.sprite);
      if (!src || typeof from?.layer !== "string") {
        throw new Error(
          "copy: pass { layer, frame } (add sprite: id for another sprite) or { image: img.image }."
        );
      }
      const dst = cv();
      const data = D.readable(src.d, from.layer, from.frame ?? 0);
      return R.copy(
        dst,
        { data, height: src.d.sprite.height, width: src.d.sprite.width },
        { ...o, rect: rectIn(src.d, o) }
      );
    },
    ellipse: (r, color, o) => R.ellipse(cv(), rectOf(st.d, r), color, o),
    fill: (x, y, color) => R.fill(cv(), x, y, color),
    frame,
    layer,
    line: (x0, y0, x1, y1, color) => R.line(cv(), x0, y0, x1, y1, color),
    map: (palette, rows, o) => {
      checkMap(palette, rows);
      return R.map(cv(), palette, rows, o);
    },
    outline: (color, o) => {
      const [c, opts] =
        color && typeof color === "object" ? [undefined, color] : [color, o];
      return R.outline(cv(), c, { ...opts, rect: rectIn(st.d, opts) });
    },
    px: (points) => R.px(cv(), points),
    read: (o) => R.read(ro(), { ...o, rect: rectIn(st.d, o) }),
    recolor: (mapping, o) =>
      R.recolor(cv(), mapping, { ...o, rect: rectIn(st.d, o) }),
    rect: (r, color, o) => R.rect(cv(), rectOf(st.d, r), color, o),
    shift: (dx, dy, o) =>
      R.shift(cv(), dx, dy, { ...o, rect: rectIn(st.d, o) }),
    sprite: st.d.sprite.id,
  };
};

const imageHandle = (run: Run, picture: R.Canvas): ImageHandle => {
  run.loaded.push(picture);
  return {
    colors: (max) => R.colors(picture, max),
    downscale: (factor) => imageHandle(run, R.downscale(picture, factor)),
    height: picture.height,
    image: run.loaded.length - 1,
    read: (o) => R.read(picture, o),
    width: picture.width,
  };
};

const wholeOption = (
  name: string,
  value: unknown,
  fallback: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `export: ${name} must be a whole number >= 1, got ${JSON.stringify(value)}.`
    );
  }
  return value;
};

/** Frame range of the whole sprite, or of one tag. */
const exportRange = (d: Draft, tag: unknown): { from: number; to: number } => {
  if (tag === undefined) {
    return { from: 0, to: d.structure.durations.length - 1 };
  }
  const found = d.structure.tags.find((t) => t.name === tag);
  if (!found) {
    const names = d.structure.tags.map((t) => t.name);
    throw new Error(
      `export: no tag '${String(tag)}'. Tags: ${names.join(", ") || "none"}.`
    );
  }
  return found;
};

// Resolves symlinks, falling back to the parent folder for a file that does not exist yet.
const realOrParent = async (abs: string): Promise<string> => {
  try {
    return await realpath(abs);
  } catch {
    const parent = nodePath.dirname(abs);
    const dir = await realpath(parent).catch(() => parent);
    return nodePath.join(dir, nodePath.basename(abs));
  }
};

export const createRuntime = ({
  link,
  viewsDir,
  palettesFile,
  spritesDir = null,
  allowedDirs = [],
  limits = {},
}: RuntimeOptions): { execute: (code: string) => Promise<ExecuteResult> } => {
  const lim: Limits = { ...DEFAULT_LIMITS, ...limits };
  /** sprite id -> cel key -> RGBA this daemon last saw in Aseprite (for changes()). */
  const lastSeen = new Map<number, Map<CelKey, Uint8Array>>();
  /** RGBA buffer -> the exact sprite-mode bytes it came from, so CAS bases match Aseprite byte for byte. */
  const rawBytes = new WeakMap<Uint8Array, Uint8Array>();
  let viewSeq = 0;

  // Symlinks are resolved first, so a link inside an allowed folder cannot reach outside it.
  const allowedPath = async (
    p: unknown,
    defaultExt = ".aseprite"
  ): Promise<string> => {
    if (typeof p !== "string" || !p) {
      throw new Error("Pass a file path as a string.");
    }
    let target = p;
    if (spritesDir && /^[^/\\~]+$/u.test(target)) {
      await mkdir(spritesDir, { recursive: true });
      target = nodePath.join(
        spritesDir,
        nodePath.extname(target) ? target : `${target}${defaultExt}`
      );
    }
    if (!nodePath.isAbsolute(target) && !target.startsWith("~")) {
      throw new Error(
        `'${target}' is relative; pass a name such as "slime" or an absolute path.`
      );
    }
    const abs = nodePath.resolve(target.replace(/^~(?=\/|$)/u, homedir()));
    const real = await realOrParent(abs);
    if (!(await insideAllowedDir(real, allowedDirs))) {
      throw new Error(
        `'${abs}' is outside the allowed folders: ${allowedDirs.join(", ") || "(none configured)"}.`
      );
    }
    return real;
  };

  const snapshot = async (ref?: unknown): Promise<Draft> => {
    const { result, blobs } = await link.request(
      "snapshot",
      ref === undefined ? {} : { sprite: ref }
    );
    if (!isSnapshot(result)) {
      throw new Error("Aseprite sent a malformed snapshot reply.");
    }
    const s = result.sprite;
    const bytes = blobs.length * s.width * s.height * 4;
    if (bytes > lim.draftBytes) {
      throw new Error(
        `Sprite '${s.name}' holds ${mb(bytes)} MB of cel pixels; the limit is ${mb(lim.draftBytes)} MB. Work on a smaller sprite.`
      );
    }
    const rgba = blobs.map((b) => {
      const x = toRgba(b, s.colorMode, result.palette, s.transparentIndex);
      rawBytes.set(x, b);
      return x;
    });
    s.path ??= null;
    const d = D.fromSnapshot(
      { ...result, selection: result.selection ?? null },
      rgba
    );
    if (!lastSeen.has(d.sprite.id)) {
      lastSeen.set(d.sprite.id, baseMap(d));
    }
    return d;
  };

  const activate = async (id: number): Promise<void> => {
    const { result } = await link.request("sprites", {});
    if (record("sprites", result).active !== id) {
      await link.request("sprites", { select: id });
    }
  };

  /** plan -> commit -> on conflict merge3 and retry (max 3) -> rebase. A clean draft sends nothing. */
  const commitDraft = (
    run: Run,
    st: SpriteState,
    label: string
  ): Promise<CommitInfo | null> => {
    const { d } = st;
    const { colorMode: mode, transparentIndex: ti } = d.sprite;
    const merged = new Set<CelKey>();
    let lost = 0;
    const attempt = async (n: number): Promise<CommitInfo | null> => {
      const p = D.plan(d);
      if (!p.ops.length && !p.writes.length) {
        return null;
      }
      const blobs: Uint8Array[] = [];
      const add = (bytes: Uint8Array): number => {
        blobs.push(bytes);
        return blobs.length - 1;
      };
      const writes = p.writes.map((w) => ({
        base: w.base
          ? add(
              rawBytes.get(w.base) ??
                fromRgba(w.base, mode, p.palette, ti).bytes
            )
          : null,
        frame: w.frame,
        layer: w.layer,
        next: w.next ? add(fromRgba(w.next, mode, p.palette, ti).bytes) : null,
      }));
      const { result, blobs: current } = await link.request(
        "commit",
        { label, ops: p.ops, sprite: d.sprite.id, writes },
        blobs
      );
      if (!isCommitReply(result)) {
        throw new Error("Aseprite sent a malformed commit reply.");
      }
      if (result.applied) {
        for (const [i, w] of p.writes.entries()) {
          const at = writes[i].next;
          if (w.next && at !== null) {
            rawBytes.set(w.next, blobs[at]);
          }
        }
        D.rebase(d, p);
        lastSeen.set(d.sprite.id, baseMap(d));
        const info: CommitInfo = {
          cels: result.cels ?? 0,
          label,
          lost,
          merged: merged.size,
          name: d.sprite.name,
          pixels: p.pixels,
          sprite: d.sprite.id,
        };
        run.commits.push(info);
        return info;
      }
      if (result.reason !== "conflict") {
        throw new Error(
          `Commit '${label}' failed: ${result.message}. Call sprite() again to see the current layers.`
        );
      }
      if (n === MAX_RETRIES) {
        throw new Error(
          `Commit '${label}' gave up after ${MAX_RETRIES} retries: the artist kept changing the same cels. Run the program again.`
        );
      }
      for (const c of result.conflicts ?? []) {
        const w = p.writes[c.write];
        const raw =
          c.blob === undefined || c.blob === null ? null : current[c.blob];
        const theirs = raw ? toRgba(raw, mode, d.sprite.palette, ti) : null;
        if (theirs && raw) {
          rawBytes.set(theirs, raw);
        }
        lost += D.resolveConflict(d, w.key, theirs).lost;
        merged.add(w.key);
      }
      return attempt(n + 1);
    };
    return attempt(0);
  };

  // Sprites commit one after another; the first failure stops the rest.
  const commitAll = async (run: Run, states: SpriteState[]): Promise<void> => {
    const [st, ...rest] = states;
    if (!st) {
      return;
    }
    await commitDraft(run, st, AUTO_LABEL);
    await commitAll(run, rest);
  };

  const view = async (
    run: Run,
    st: SpriteState,
    o: ViewOptions = {}
  ): Promise<ViewResult> => {
    const { d } = st;
    const n = d.structure.durations.length;
    const frames =
      o.frame === "all"
        ? Array.from({ length: n }, (_, f) => f)
        : [o.frame ?? 0];
    for (const f of frames) {
      if (!Number.isInteger(f) || f < 0 || f >= n) {
        throw new Error(
          `view: frame ${f} does not exist; the sprite has ${n} frame(s) (0-${n - 1}) or use "all".`
        );
      }
    }
    const r = o.rect === undefined ? null : rectOf(d, o.rect);
    const pics = frames.map((f) =>
      r ? R.crop(flatten(d, f), r) : flatten(d, f)
    );
    const cv = pics.length === 1 ? pics[0] : frameStrip(pics);
    const out = o.critique
      ? critiqueSheet(cv, { scale: o.scale })
      : renderView(cv, { scale: o.scale });
    await mkdir(viewsDir, { recursive: true });
    const safe = d.sprite.name.replaceAll(/[^\w.-]+/gu, "_").slice(0, 40);
    viewSeq += 1;
    const path = nodePath.join(
      viewsDir,
      `${Date.now()}-${process.pid}-${viewSeq}-${safe}.png`
    );
    await writeFile(path, out.png);
    run.images.push(path);
    return { height: out.height, path, width: out.width };
  };

  /** Writes <name>.png + <name>.json (the sheet) and/or <name>.gif, only after every part encoded. */
  const exportSprite = async (
    run: Run,
    st: SpriteState,
    nameOrPath: unknown,
    o: ExportOptions = {}
  ): Promise<ExportResult> => {
    if (typeof nameOrPath !== "string" || !nameOrPath) {
      throw new Error(
        'export: pass a name such as "slime" or an absolute path.'
      );
    }
    const { sheet = true, gif = false } = o;
    if (!sheet && !gif) {
      throw new Error(
        "export: sheet and gif are both false; nothing to write."
      );
    }
    const scale = wholeOption("scale", o.scale, 1);
    const base = nameOrPath.slice(
      0,
      nameOrPath.length - nodePath.extname(nameOrPath).length
    );
    const pathFor = (ext: string) => allowedPath(`${base}${ext}`);
    const sheetPaths = sheet
      ? { json: await pathFor(".json"), png: await pathFor(".png") }
      : null;
    const gifPath = gif ? await pathFor(".gif") : null;
    const files: [string, Buffer | string][] = [];
    await commitDraft(run, st, AUTO_LABEL);
    const { d } = st;
    const { durations, tags } = d.structure;
    const { from, to } = exportRange(d, o.tag);
    const indices = Array.from({ length: to - from + 1 }, (_, n) => from + n);
    const frames = indices.map((f) => upscale(flatten(d, f), scale));
    const [{ width, height }] = frames;
    const out: ExportResult = { frames: frames.length, height, width };
    if (sheetPaths) {
      const { png, json } = sheetPaths;
      const columns = wholeOption("columns", o.columns, frames.length);
      const { sheet: cv, cells } = gridSheet(frames, columns);
      out.sheet = png;
      out.json = json;
      const data = {
        frames: cells.map(([x, y], n) => ({
          duration: durations[indices[n]],
          h: height,
          w: width,
          x,
          y,
        })),
        image: nodePath.basename(png),
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
      files.push(
        [png, encodePng(cv.width, cv.height, cv.data)],
        [json, `${JSON.stringify(data, null, 2)}\n`]
      );
    }
    if (gifPath) {
      const delays = indices.map((f) =>
        Math.max(2, Math.round(durations[f] / 10))
      );
      out.gif = gifPath;
      files.push([gifPath, encodeGif(frames, delays)]);
    }
    await Promise.all(files.map(([abs, body]) => writeFile(abs, body)));
    return out;
  };

  const history = async (
    st: SpriteState,
    action: "undo" | "redo",
    n = 1
  ): Promise<void> => {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`${action}(n): n must be a whole number >= 1, got ${n}.`);
    }
    if (pending(st.d).dirty) {
      throw new Error(
        `${action}() would drop this program's uncommitted edits; call await s.commit() first.`
      );
    }
    const { id } = st.d.sprite;
    await activate(id);
    await link.request("history", { action, steps: n });
    st.d = await snapshot(id);
    lastSeen.set(id, baseMap(st.d));
  };

  /** Cels whose pixels differ from what this daemon last saw (artist edits), as palette + rows. */
  const changes = async (st: SpriteState): Promise<ArtistChange[]> => {
    const { id } = st.d.sprite;
    const fresh = await snapshot(id);
    const before = lastSeen.get(id) ?? new Map<CelKey, Uint8Array>();
    const after = baseMap(fresh);
    const { width: w, height: h } = fresh.sprite;
    const out: ArtistChange[] = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const now = after.get(key) ?? null;
      const rect = diffRect(before.get(key) ?? null, now, w, h);
      if (!rect) {
        continue;
      }
      const { layer, frame } = D.parseKey(key);
      out.push({
        frame,
        layer,
        rect,
        ...R.read(
          { data: now ?? new Uint8Array(w * h * 4), height: h, width: w },
          { rect }
        ),
      });
    }
    lastSeen.set(id, after);
    if (!pending(st.d).dirty) {
      st.d = fresh;
    }
    return out.toSorted(byLayerThenFrame);
  };

  const spriteHandle = (run: Run, st: SpriteState): SpriteHandle => {
    const { id, name, width, height, colorMode } = st.d.sprite;
    return {
      cel: (layer, frame = 0) => celHandle(run, st, layer, frame),
      cels: (layer) => {
        D.readable(st.d, layer, 0);
        return st.d.structure.durations.map((_, f) =>
          celHandle(run, st, layer, f)
        );
      },
      changes: () => changes(st),
      colorMode,
      commit: async (label = "checkpoint") =>
        (await commitDraft(run, st, String(label))) ?? {
          cels: 0,
          label: String(label),
          lost: 0,
          merged: 0,
          name,
          pixels: 0,
          sprite: id,
        },
      export: (nameOrPath, o) => exportSprite(run, st, nameOrPath, o),
      frames: () => st.d.structure.durations.length,
      height,
      id,
      layer: (layerName, o) => {
        D.stageLayer(st.d, layerName, o ?? {});
      },
      layers: () => st.d.structure.layers.map((l) => l.path),
      name,
      redo: (n) => history(st, "redo", n),
      save: async (path) => {
        const abs = path === undefined ? undefined : await allowedPath(path);
        await commitDraft(run, st, AUTO_LABEL);
        await activate(id);
        const { result } = await link.request(
          "save",
          abs === undefined ? {} : { path: abs }
        );
        return record("save", result).saved;
      },
      selection: () => st.d.sprite.selection ?? null,
      setFrames: (count, o = {}) => {
        const layers = st.d.structure.layers.filter((l) => !l.group).length;
        const bytes = count * layers * width * height * 4;
        if (bytes > lim.draftBytes) {
          throw new Error(
            `setFrames(${count}): ${layers} layer(s) x ${count} frames is ${mb(bytes)} MB of pixels; the limit is ${mb(lim.draftBytes)} MB.`
          );
        }
        D.setFrames(st.d, count, o.duration);
      },
      tag: (tagName, from, to, o) => {
        D.stageTag(st.d, tagName, from, to, o ?? {});
      },
      undo: (n) => history(st, "undo", n),
      view: (o) => view(run, st, o),
      width,
    };
  };

  const openSprite = async (o: SpriteOptions): Promise<unknown> => {
    if (o.new) {
      const [w, h] = o.new;
      if (![w, h].every((x) => Number.isInteger(x) && x >= 1 && x <= 4096)) {
        throw new Error(
          `sprite({ new: [w, h] }): whole numbers 1-4096, got ${JSON.stringify(o.new)}.`
        );
      }
      const { result } = await link.request("new_sprite", {
        colorMode: o.colorMode ?? "rgb",
        height: h,
        width: w,
      });
      return record("new_sprite", result).spriteId;
    }
    if (o.open !== undefined) {
      const { result } = await link.request("open", {
        path: await allowedPath(o.open),
      });
      return record("open", result).spriteId;
    }
    return o.id ?? o.name;
  };

  const globals = (run: Run) => ({
    help: (topic?: unknown) => help(topic),
    async image(path: unknown): Promise<ImageHandle> {
      const abs = await allowedPath(path, ".png");
      try {
        return imageHandle(run, decodePng(await readFile(abs)));
      } catch (error) {
        throw new Error(`image('${abs}'): ${messageOf(error)}`, {
          cause: error,
        });
      }
    },
    palette: (name: string, colors?: Record<string, string>) =>
      colors === undefined
        ? loadPalette(palettesFile, name)
        : savePalette(palettesFile, name, colors),
    ramp: (base: string, keys: string, o?: { hueShift?: number }) =>
      ramp(base, keys, o),
    async sprite(o: SpriteOptions = {}): Promise<SpriteHandle | undefined> {
      const d = await snapshot(await openSprite(o));
      const known = run.states.get(d.sprite.id);
      if (known) {
        if (!pending(known.d).dirty) {
          known.d = d;
        }
        return known.handle;
      }
      const st: SpriteState = { d };
      st.handle = spriteHandle(run, st);
      run.states.set(d.sprite.id, st);
      return st.handle;
    },
    async sprites(): Promise<Record<string, unknown>[]> {
      const { result } = await link.request("sprites", {});
      const { sprites } = record("sprites", result);
      if (!Array.isArray(sprites) || !sprites.every((x) => isRecord(x))) {
        throw new Error("Aseprite sent a malformed sprites reply.");
      }
      return sprites.map(({ id, name, width, height, frames, active }) => ({
        active,
        frames,
        height,
        id,
        name,
        width,
      }));
    },
  });

  const pruneViews = async (): Promise<void> => {
    try {
      const all = await readdir(viewsDir);
      const names = all.filter((n) => n.endsWith(".png"));
      if (names.length <= KEEP_VIEWS) {
        return;
      }
      const files = await Promise.all(
        names.map(async (n) => {
          const p = nodePath.join(viewsDir, n);
          const info = await stat(p);
          return { p, t: info.mtimeMs };
        })
      );
      await Promise.all(
        files
          .toSorted((a, b) => b.t - a.t)
          .slice(KEEP_VIEWS)
          .map((f) => unlink(f.p).catch(() => null))
      );
    } catch {
      // Pruning is housekeeping; a failure must never fail the program that drew.
    }
  };

  const execute = async (code: string): Promise<ExecuteResult> => {
    const t0 = Date.now();
    const run: Run = {
      commits: [],
      images: [],
      loaded: [],
      states: new Map(),
    };
    const done = <E extends object>(e: E) => ({ ...e, ms: Date.now() - t0 });
    let r: CodeMode.Result;
    try {
      const runtime = CodeMode.make({
        extensions: [
          Extension.make({ globals: globals(run), name: "aseprite" }),
        ],
        limits: {
          maxOutputBytes: lim.maxOutputBytes,
          maxToolCalls: lim.maxToolCalls,
          timeoutMs: lim.timeoutMs,
        },
        tools: {},
      });
      r = await Effect.runPromise(runtime.execute(code));
    } catch (error) {
      r = {
        error: { kind: "ExecutionFailure", message: messageOf(error) },
        ok: false,
        toolCalls: [],
      };
    }
    if (run.images.length) {
      await pruneViews();
    }
    const logs = r.logs?.length ? { logs: r.logs } : {};
    const discarded = (): { discarded?: Discarded[] } => {
      const list = [...run.states.values()]
        .map((st) => ({ sprite: st.d.sprite.id, ...pending(st.d) }))
        .filter((x) => x.dirty);
      return list.length
        ? { discarded: list.map(({ sprite, cels }) => ({ cels, sprite })) }
        : {};
    };
    if (!r.ok) {
      const { kind, message, location } = r.error;
      const diagnostic = {
        kind,
        message,
        ...(location && { line: location.line }),
      };
      return done({
        commit: run.commits,
        error: diagnostic,
        ok: false as const,
        ...discarded(),
        images: run.images,
        ...logs,
      });
    }
    try {
      await commitAll(run, [...run.states.values()]);
    } catch (error) {
      return done({
        commit: run.commits,
        error: { kind: "CommitFailed", message: messageOf(error) },
        ok: false as const,
        ...discarded(),
        images: run.images,
        ...logs,
      });
    }
    const warnings = r.warnings?.length ? { warnings: r.warnings } : {};
    return done({
      commit: run.commits,
      images: run.images,
      ok: true as const,
      value: r.value,
      ...logs,
      ...warnings,
    });
  };

  return { execute };
};
