// The deep Sprite Session module: owns the host-side mirror of open sprites, compare-and-swap commits,
// 3-way conflict merging, raw sprite-mode base bytes, extension version gating, and artist-change tracking
// directly over the Link seam.
import { checkCanvasSize, wholeNumber } from "./check.ts";
import { compareVersions } from "./link.ts";
import type { Link } from "./link.ts";
import * as R from "./raster.ts";
import { composite } from "./render.ts";
import { fromRgba, toRgba } from "./wire.ts";
import type { ColorMode } from "./wire.ts";

/** `${layerPath}@${frame}`, frame 0-based. */
export type CelKey = `${string}@${number}`;

export type TagDirection = "forward" | "reverse" | "pingpong";

/** Snapshot tags may carry any direction Aseprite knows; staged tags use TagDirection. */
export interface Tag {
  name: string;
  from: number;
  to: number;
  direction: string;
}

export interface LayerOptions {
  below?: string;
  visible?: boolean;
  opacity?: number;
  rename?: string;
  remove?: boolean;
}

/** A canvas size change: art moves by (x, y); pixels that land outside are dropped. */
export interface Resize {
  width: number;
  height: number;
  x: number;
  y: number;
}

type LayerProps = Partial<{ visible: boolean; opacity: number }>;

/** One structural change for extension/handlers.lua, applied in list order. */
export type Op =
  | { op: "palette.append"; colors: string[] }
  | ({ op: "canvas.resize" } & Resize)
  | { op: "layer.remove"; path: string }
  | ({ op: "layer.set"; path: string; rename?: string } & LayerProps)
  | { op: "layer.add"; path: string; below?: string }
  | { op: "frames.set"; count: number; durations: number[] }
  | ({ op: "tag.set" } & Tag);

export interface CommitInfo {
  sprite: number;
  name: string;
  label: string;
  cels: number;
  pixels: number;
  merged: number;
  lost: number;
}

/** One cel the artist changed since this daemon last looked. */
export type ArtistChange = R.PixelRows & {
  layer: string;
  frame: number;
  rect: R.Rect;
};

export interface SpriteSummary {
  id: number;
  name: string;
  width: number;
  height: number;
  frames: number;
  active: boolean;
}

export interface OpenSpriteOptions {
  new?: [w: number, h: number];
  colorMode?: ColorMode;
  openPath?: string;
  id?: number;
  name?: string;
}

export interface DiscardedSprite {
  cels: number;
  sprite: number;
}

export interface SpriteDraft {
  readonly id: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly colorMode: ColorMode;
  readonly selection: R.Rect | null;
  readonly durations: readonly number[];
  readonly tags: readonly Tag[];
  layers: () => string[];
  frames: () => number;
  readable: (layer: string, frame: number) => Uint8Array;
  writable: (layer: string, frame: number) => Uint8Array;
  bounds: (layer: string, frame: number) => R.Rect | null;
  flatten: (frame: number) => R.Canvas;
  layer: (name: string, o?: LayerOptions) => void;
  setFrames: (count: number, duration?: unknown) => void;
  tag: (
    name: string,
    from: number,
    to: number,
    o?: { direction?: TagDirection }
  ) => void;
  resize: (
    width: number,
    height: number,
    o?: { x?: number; y?: number }
  ) => [layer: string, frame: number, pixels: number][];
  commit: (label?: string) => Promise<CommitInfo>;
  undo: (n?: number) => Promise<void>;
  redo: (n?: number) => Promise<void>;
  save: (absPath?: string) => Promise<unknown>;
  changes: () => Promise<ArtistChange[]>;
}

export interface SpriteSession {
  readonly commits: readonly CommitInfo[];
  open: (o?: OpenSpriteOptions) => Promise<SpriteDraft>;
  get: (id: number) => SpriteDraft | undefined;
  commitAll: (label?: string) => Promise<void>;
  discarded: () => DiscardedSprite[];
}

export interface SpriteStore {
  list: () => Promise<SpriteSummary[]>;
  openSession: () => SpriteSession;
}

/**
 * One cel as full-canvas RGBA plus its exact sprite-mode bytes at snapshot.
 * `cur` is null until first write (copy-on-write); linked cels share one CelBuf.
 */
interface CelBuf {
  base: Uint8Array | null;
  raw: Uint8Array | null;
  cur: Uint8Array | null;
  link: number | null;
}

interface Layer {
  path: string;
  from: string | null;
  visible: boolean;
  opacity: number;
  blend: string;
  group: boolean;
  below?: string;
  seq?: number;
}

interface Structure {
  layers: Layer[];
  durations: number[];
  tags: Tag[];
}

interface SpriteInfo {
  id: number;
  name: string;
  path: string | null;
  width: number;
  height: number;
  colorMode: ColorMode;
  transparentIndex: number;
  palette: string[];
  selection: R.Rect | null;
}

interface DraftState {
  sprite: SpriteInfo;
  baseStructure: Structure;
  structure: Structure;
  cels: Map<CelKey, CelBuf>;
  resizes: Resize[];
  seq: number;
}

interface SnapshotReply {
  sprite: Omit<SpriteInfo, "palette" | "selection">;
  palette: string[];
  selection?: R.Rect | null;
  frames: { duration: number }[];
  layers: Pick<Layer, "path" | "visible" | "opacity" | "blend" | "group">[];
  tags: Tag[];
  cels: { layer: string; frame: number; blob: number; link?: number | null }[];
}

interface CommitReply {
  applied?: boolean;
  cels?: number;
  reason?: string;
  message?: string;
  conflicts?: { write: number; blob?: number | null }[];
}

interface CelWrite {
  key: CelKey;
  layer: string;
  frame: number;
  base: Uint8Array | null;
  baseRaw: Uint8Array | null;
  next: Uint8Array | null;
}

interface Plan {
  ops: Op[];
  writes: CelWrite[];
  pixels: number;
  palette: string[];
}

const MAX_RETRIES = 3;
const RESIZE_EXTENSION = "0.2.0";
const DIRECT_TARGET_EXTENSION = "0.3.0";
const AUTO_LABEL = "program";
const TAG_DIRECTIONS = new Set<string>(["forward", "reverse", "pingpong"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const record = (cmd: string, v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) {
    throw new Error(`Aseprite sent a malformed ${cmd} reply.`);
  }
  return v;
};

const isSnapshot = (v: unknown): v is SnapshotReply =>
  isRecord(v) &&
  isRecord(v.sprite) &&
  Array.isArray(v.palette) &&
  Array.isArray(v.frames) &&
  Array.isArray(v.layers) &&
  Array.isArray(v.tags) &&
  Array.isArray(v.cels);

const isCommitReply = (v: unknown): v is CommitReply =>
  isRecord(v) && (v.conflicts === undefined || Array.isArray(v.conflicts));

const mb = (n: number): number => Math.ceil(n / (1024 * 1024));
const celKey = (layer: string, frame: number): CelKey => `${layer}@${frame}`;
const parseKey = (key: CelKey): { frame: number; layer: string } => {
  const at = key.lastIndexOf("@");
  return { frame: Number(key.slice(at + 1)), layer: key.slice(0, at) };
};
const cloneStructure = (s: Structure): Structure => structuredClone(s);
const parentOf = (path: string): string =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);
const depth = (path: string): number => path.split("/").length;
const isDuration = (x: unknown): x is number => typeof x === "number" && x > 0;
const canvasBytes = (d: DraftState): number =>
  d.sprite.width * d.sprite.height * 4;

const visibleKey = (a: Uint8Array, i: number): number =>
  a[i + 3] === 0
    ? 0
    : ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0;

const diffCount = (a: Uint8Array | null, b: Uint8Array | null): number => {
  const len = (a ?? b)?.length ?? 0;
  let n = 0;
  for (let i = 0; i < len; i += 4) {
    if ((a ? visibleKey(a, i) : 0) !== (b ? visibleKey(b, i) : 0)) {
      n += 1;
    }
  }
  return n;
};
const isEmpty = (a: Uint8Array): boolean => diffCount(a, null) === 0;
const opaque = (a: Uint8Array | null): number => (a ? diffCount(a, null) : 0);

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
      if ((a ? visibleKey(a, i) : 0) === (b ? visibleKey(b, i) : 0)) {
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

/** A full-canvas buffer of `bpp` bytes per pixel copied into a w2 x h2 canvas at (dx, dy); the rest is `fill`. */
export const moveCanvas = (
  src: Uint8Array,
  [w, h]: [number, number],
  [w2, h2]: [number, number],
  [dx, dy]: [number, number],
  fill = 0
): Uint8Array => {
  const bpp = src.length / (w * h);
  const out = new Uint8Array(w2 * h2 * bpp).fill(fill);
  const x0 = Math.max(0, dx);
  const x1 = Math.min(w2, w + dx);
  if (x1 <= x0) {
    return out;
  }
  for (let y = Math.max(0, dy); y < Math.min(h2, h + dy); y += 1) {
    const from = ((y - dy) * w + x0 - dx) * bpp;
    out.set(src.subarray(from, from + (x1 - x0) * bpp), (y * w2 + x0) * bpp);
  }
  return out;
};

const baseMap = (d: DraftState): Map<CelKey, Uint8Array> => {
  const out = new Map<CelKey, Uint8Array>();
  for (const [key, buf] of d.cels) {
    if (buf.base) {
      out.set(key, buf.base);
    }
  }
  return out;
};

const buildDraft = (
  reply: SnapshotReply,
  rawBlobs: readonly Uint8Array[]
): DraftState => {
  const { sprite: s } = reply;
  const rgbaSize = s.width * s.height * 4;
  const rgbaBlobs = rawBlobs.map((raw) =>
    toRgba(raw, s.colorMode, reply.palette, s.transparentIndex)
  );
  const structure: Structure = {
    durations: reply.frames.map((f) => f.duration),
    layers: reply.layers.map((l) => ({
      blend: l.blend,
      from: l.path,
      group: l.group,
      opacity: l.opacity,
      path: l.path,
      visible: l.visible,
    })),
    tags: reply.tags.map((t) => ({ ...t })),
  };
  const cels = new Map<CelKey, CelBuf>();
  const linked = new Map<CelKey, CelBuf>();
  for (const c of reply.cels) {
    const base = rgbaBlobs[c.blob];
    const raw = rawBlobs[c.blob];
    if (!base || !raw || base.length !== rgbaSize) {
      throw new Error(
        `Snapshot cel ${c.layer}@${c.frame}: expected ${rgbaSize} RGBA bytes.`
      );
    }
    const group =
      c.link === null || c.link === undefined ? null : celKey(c.layer, c.link);
    let buf = group && linked.get(group);
    if (!buf) {
      buf = { base, cur: null, link: c.link ?? null, raw };
      if (group) {
        linked.set(group, buf);
      }
    }
    cels.set(celKey(c.layer, c.frame), buf);
  }
  return {
    baseStructure: cloneStructure(structure),
    cels,
    resizes: [],
    seq: 0,
    sprite: {
      ...s,
      palette: [...reply.palette],
      path: s.path ?? null,
      selection: reply.selection ?? null,
    },
    structure,
  };
};

const layerOf = (d: DraftState, path: string): Layer => {
  const l = d.structure.layers.find((x) => x.path === path);
  if (!l) {
    throw new Error(
      `Unknown layer '${path}'. Layers: ${d.structure.layers.map((x) => x.path).join(", ") || "(none)"}.`
    );
  }
  return l;
};

const checkFrame = (d: DraftState, frame: number): void => {
  const n = d.structure.durations.length;
  if (!Number.isInteger(frame) || frame < 0 || frame >= n) {
    throw new Error(
      `Frame ${frame} does not exist; the sprite has ${n} frame${n === 1 ? "" : "s"} (0-${n - 1}).`
    );
  }
};

const writableOf = (
  d: DraftState,
  layer: string,
  frame: number
): Uint8Array => {
  const l = layerOf(d, layer);
  if (l.group) {
    throw new Error(
      `'${layer}' is a group layer; draw on one of the layers inside it.`
    );
  }
  checkFrame(d, frame);
  const key = celKey(layer, frame);
  let buf = d.cels.get(key);
  if (!buf) {
    buf = { base: null, cur: null, link: null, raw: null };
    d.cels.set(key, buf);
  }
  buf.cur ??= buf.base
    ? new Uint8Array(buf.base)
    : new Uint8Array(canvasBytes(d));
  return buf.cur;
};

const readableOf = (
  d: DraftState,
  layer: string,
  frame: number
): Uint8Array => {
  layerOf(d, layer);
  checkFrame(d, frame);
  const buf = d.cels.get(celKey(layer, frame));
  return buf?.cur ?? buf?.base ?? new Uint8Array(canvasBytes(d));
};

const applySetFrames = (
  d: DraftState,
  count: number,
  durations: unknown,
  draftBytes: number
): void => {
  wholeNumber("Frame count", count);
  const layerCount = d.structure.layers.filter((l) => !l.group).length;
  const bytes = count * layerCount * d.sprite.width * d.sprite.height * 4;
  if (bytes > draftBytes) {
    throw new Error(
      `setFrames(${count}): ${layerCount} layer(s) x ${count} frames is ${mb(bytes)} MB of pixels; the limit is ${mb(draftBytes)} MB.`
    );
  }
  const old = d.structure.durations;
  const n = old.length;
  if (Array.isArray(durations) && durations.length !== count) {
    throw new Error(
      `durations has ${durations.length} entries for ${count} frames.`
    );
  }
  for (let f = n; f < count; f += 1) {
    for (const l of d.structure.layers) {
      if (l.group) {
        continue;
      }
      const last = d.cels.get(celKey(l.path, n - 1));
      const src = last?.cur ?? last?.base;
      const existing = d.cels.get(celKey(l.path, f));
      const base = existing?.base ?? null;
      const raw = existing?.raw ?? null;
      if (src || base) {
        d.cels.set(celKey(l.path, f), {
          base,
          cur: src ? new Uint8Array(src) : new Uint8Array(canvasBytes(d)),
          link: null,
          raw,
        });
      }
    }
  }
  const durationOf = (f: number): unknown => {
    if (Array.isArray(durations)) {
      return durations[f];
    }
    if (typeof durations === "number") {
      return durations;
    }
    return old[Math.min(f, n - 1)];
  };
  const next = Array.from({ length: count }, (_, f) => durationOf(f));
  if (!next.every((x) => isDuration(x))) {
    throw new Error(
      "Frame durations must be positive numbers of milliseconds."
    );
  }
  d.structure.durations = next;
};

const removeLayer = (d: DraftState, name: string): void => {
  layerOf(d, name);
  d.structure.layers = d.structure.layers.filter((l) => !within(l.path, name));
  for (const key of d.cels.keys()) {
    if (within(parseKey(key).layer, name)) {
      d.cels.delete(key);
    }
  }
};

const addLayer = (d: DraftState, name: string, below?: string): Layer => {
  const { layers } = d.structure;
  if (below !== undefined) {
    layerOf(d, below);
  }
  const l: Layer = {
    below,
    blend: "normal",
    from: null,
    group: false,
    opacity: 255,
    path: name,
    seq: d.seq,
    visible: true,
  };
  d.seq += 1;
  const at =
    below === undefined
      ? layers.length
      : layers.findIndex((x) => x.path === below);
  layers.splice(at, 0, l);
  return l;
};

const renameLayer = (d: DraftState, l: Layer, rename: string): void => {
  const { layers } = d.structure;
  if (!rename || rename.includes("/")) {
    throw new Error(
      `rename must be a plain layer name, got ${JSON.stringify(rename)}.`
    );
  }
  const parent = parentOf(l.path);
  const to = parent ? `${parent}/${rename}` : rename;
  if (layers.some((x) => x.path === to)) {
    throw new Error(`A layer named '${to}' already exists.`);
  }
  const from = l.path;
  const move = (p: string): string => to + p.slice(from.length);
  for (const x of layers) {
    if (within(x.path, from)) {
      x.path = move(x.path);
    }
  }
  for (const x of layers) {
    if (x.below !== undefined && within(x.below, from)) {
      x.below = move(x.below);
    }
  }
  const moved: [CelKey, CelKey, CelBuf][] = [];
  for (const [key, buf] of d.cels) {
    const { layer, frame } = parseKey(key);
    if (within(layer, from)) {
      moved.push([key, celKey(move(layer), frame), buf]);
    }
  }
  for (const [key, next, buf] of moved) {
    d.cels.delete(key);
    d.cels.set(next, buf);
  }
};

const applyStageLayer = (
  d: DraftState,
  name: string,
  o: LayerOptions = {}
): void => {
  if (
    o.opacity !== undefined &&
    !(Number.isInteger(o.opacity) && o.opacity >= 0 && o.opacity <= 255)
  ) {
    throw new Error(`opacity must be a whole number 0-255, got ${o.opacity}.`);
  }
  if (o.remove) {
    removeLayer(d, name);
    return;
  }
  const l =
    d.structure.layers.find((x) => x.path === name) ??
    addLayer(d, name, o.below);
  if (o.visible !== undefined) {
    l.visible = o.visible;
  }
  if (o.opacity !== undefined) {
    l.opacity = o.opacity;
  }
  if (o.rename !== undefined && o.rename !== nameOf(l.path)) {
    renameLayer(d, l, o.rename);
  }
};

const applyStageTag = (
  d: DraftState,
  name: string,
  from: number,
  to: number,
  { direction = "forward" }: { direction?: TagDirection } = {}
): void => {
  checkFrame(d, from);
  checkFrame(d, to);
  if (from > to) {
    throw new Error(`Tag '${name}': from (${from}) is after to (${to}).`);
  }
  if (!TAG_DIRECTIONS.has(direction)) {
    throw new Error("Tag direction must be forward, reverse or pingpong.");
  }
  const tag = { direction, from, name, to };
  const i = d.structure.tags.findIndex((t) => t.name === name);
  if (i === -1) {
    d.structure.tags.push(tag);
  } else {
    d.structure.tags[i] = tag;
  }
};

const applyResize = (
  d: DraftState,
  r: Resize
): [layer: string, frame: number, pixels: number][] => {
  const { width: w, height: h, colorMode, transparentIndex } = d.sprite;
  const size: [number, number] = [w, h];
  const nextSize: [number, number] = [r.width, r.height];
  const offset: [number, number] = [r.x, r.y];
  const rawFill = colorMode === "indexed" ? transparentIndex : 0;
  const clipped: [string, number, number][] = [];
  const seen = new Set<CelBuf>();
  for (const [key, buf] of d.cels) {
    if (seen.has(buf)) {
      continue;
    }
    seen.add(buf);
    const before = opaque(buf.cur ?? buf.base);
    if (buf.base) {
      buf.base = moveCanvas(buf.base, size, nextSize, offset);
    }
    if (buf.raw) {
      buf.raw = moveCanvas(buf.raw, size, nextSize, offset, rawFill);
    }
    if (buf.cur) {
      buf.cur = moveCanvas(buf.cur, size, nextSize, offset);
    }
    const lost = before - opaque(buf.cur ?? buf.base);
    if (lost) {
      const { layer, frame } = parseKey(key);
      clipped.push([layer, frame, lost]);
    }
  }
  const sel = d.sprite.selection;
  d.sprite.selection = sel && [sel[0] + r.x, sel[1] + r.y, sel[2], sel[3]];
  d.sprite.width = r.width;
  d.sprite.height = r.height;
  d.resizes.push({ ...r });
  return clipped;
};

const changedProps = (l: Layer, b: Layer | null | undefined): LayerProps => ({
  ...(l.visible !== (b?.visible ?? true) && { visible: l.visible }),
  ...(l.opacity !== (b?.opacity ?? 255) && { opacity: l.opacity }),
});

const layerOps = (was: Structure, now: Structure): Op[] => {
  const ops: Op[] = [];
  const kept = new Set(now.layers.map((l) => l.from));
  const removed = was.layers
    .filter((l) => !kept.has(l.path))
    .map((l) => l.path);
  for (const path of removed) {
    if (!removed.includes(parentOf(path))) {
      ops.push({ op: "layer.remove", path });
    }
  }
  const renames: { from: string; path: string }[] = [];
  for (const l of now.layers) {
    if (l.from === null) {
      continue;
    }
    const { from } = l;
    const b = was.layers.find((x) => x.path === from);
    const p = changedProps(l, b);
    if (Object.keys(p).length) {
      ops.push({ op: "layer.set", path: from, ...p });
    }
    if (nameOf(l.path) !== nameOf(from)) {
      renames.push({ from, path: l.path });
    }
  }
  // Children first, so a group rename never invalidates a child's path.
  for (const l of renames.toSorted((a, b) => depth(b.from) - depth(a.from))) {
    ops.push({ op: "layer.set", path: l.from, rename: nameOf(l.path) });
  }
  const added = now.layers
    .filter((x) => x.from === null)
    .toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const l of added) {
    ops.push({
      op: "layer.add",
      path: l.path,
      ...(l.below !== undefined && { below: l.below }),
    });
    const p = changedProps(l, null);
    if (Object.keys(p).length) {
      ops.push({ op: "layer.set", path: l.path, ...p });
    }
  }
  return ops;
};

const timelineOps = (was: Structure, now: Structure): Op[] => {
  const ops: Op[] = [];
  if (
    now.durations.length !== was.durations.length ||
    now.durations.some((x, i) => x !== was.durations[i])
  ) {
    ops.push({
      count: now.durations.length,
      durations: [...now.durations],
      op: "frames.set",
    });
  }
  for (const t of now.tags) {
    const b = was.tags.find((x) => x.name === t.name);
    if (
      !b ||
      b.from !== t.from ||
      b.to !== t.to ||
      b.direction !== t.direction
    ) {
      ops.push({ op: "tag.set", ...t });
    }
  }
  return ops;
};

const celWrites = (d: DraftState): { writes: CelWrite[]; pixels: number } => {
  const frames = d.structure.durations.length;
  const layerPaths = new Set(d.structure.layers.map((l) => l.path));
  const writes: CelWrite[] = [];
  const seen = new Set<CelBuf>();
  let pixels = 0;
  for (const [key, buf] of d.cels) {
    const { layer, frame } = parseKey(key);
    if (frame >= frames || !layerPaths.has(layer) || seen.has(buf)) {
      continue;
    }
    seen.add(buf);
    const { cur } = buf;
    const n = cur ? diffCount(buf.base, cur) : 0;
    if (!cur || n === 0) {
      continue;
    }
    pixels += n;
    writes.push({
      base: buf.base,
      baseRaw: buf.raw,
      frame,
      key,
      layer,
      next: isEmpty(cur) ? null : new Uint8Array(cur),
    });
  }
  return { pixels, writes };
};

const missingColors = (d: DraftState, writes: CelWrite[]): Set<string> => {
  const missing = new Set<string>();
  const { palette, transparentIndex } = d.sprite;
  for (const w of writes) {
    if (!w.next) {
      continue;
    }
    for (const c of fromRgba(w.next, "indexed", palette, transparentIndex)
      .missing) {
      missing.add(c);
    }
  }
  return missing;
};

const buildPlan = (d: DraftState): Plan => {
  const { baseStructure: was, structure: now } = d;
  const ops: Op[] = [
    ...d.resizes.map((r): Op => ({ op: "canvas.resize", ...r })),
    ...layerOps(was, now),
    ...timelineOps(was, now),
  ];
  const { writes, pixels } = celWrites(d);
  let { palette } = d.sprite;
  const missing =
    d.sprite.colorMode === "indexed"
      ? missingColors(d, writes)
      : new Set<string>();
  if (missing.size) {
    if (palette.length + missing.size > 256) {
      throw new Error(
        `The indexed palette would need ${palette.length + missing.size} colours (max 256). Use fewer colours or convert the sprite to RGB.`
      );
    }
    ops.unshift({ colors: [...missing], op: "palette.append" });
    palette = [...palette, ...missing];
  }
  return { ops, palette, pixels, writes };
};

const pendingOf = (d: DraftState): { cels: number; dirty: boolean } => {
  try {
    const p = buildPlan(d);
    return {
      cels: p.writes.length,
      dirty: p.ops.length > 0 || p.writes.length > 0,
    };
  } catch {
    return { cels: 0, dirty: true };
  }
};

/** 3-way merge for one cel: ours where ours != base, theirs elsewhere; where both changed differently the artist wins. */
const merge3 = (
  base: Uint8Array | null,
  ours: Uint8Array | null,
  theirs: Uint8Array | null
): { merged: Uint8Array; lost: number } => {
  const len = (base ?? ours ?? theirs)?.length ?? 0;
  const merged = new Uint8Array(len);
  let lost = 0;
  for (let i = 0; i < len; i += 4) {
    const b = base ? visibleKey(base, i) : 0;
    const o = ours ? visibleKey(ours, i) : 0;
    const t = theirs ? visibleKey(theirs, i) : 0;
    const oursChanged = o !== b;
    const theirsChanged = t !== b;
    if (oursChanged && theirsChanged && o !== t) {
      lost += 1;
    }
    const src = oursChanged && !theirsChanged ? ours : theirs;
    if (src) {
      merged[i] = src[i];
      merged[i + 1] = src[i + 1];
      merged[i + 2] = src[i + 2];
      merged[i + 3] = src[i + 3];
    }
  }
  return { lost, merged };
};

const rebaseDraft = (
  d: DraftState,
  applied: Plan,
  nextRaw: readonly (Uint8Array | null)[]
): void => {
  for (const [i, w] of applied.writes.entries()) {
    const buf = d.cels.get(w.key);
    if (!buf) {
      continue;
    }
    buf.base = w.next;
    buf.raw = nextRaw[i] ?? null;
    if (buf.cur && diffCount(buf.cur, w.next) === 0) {
      buf.cur = null;
    }
  }
  const frames = d.structure.durations.length;
  for (const key of d.cels.keys()) {
    if (parseKey(key).frame >= frames) {
      d.cels.delete(key);
    }
  }
  for (const l of d.structure.layers) {
    l.from = l.path;
    delete l.below;
    delete l.seq;
  }
  d.baseStructure = cloneStructure(d.structure);
  d.resizes.splice(
    0,
    applied.ops.filter((o) => o.op === "canvas.resize").length
  );
  d.sprite.palette = [...applied.palette];
};

const flattenDraft = (d: DraftState, frame: number): R.Canvas => {
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
    .map((l) => ({
      data: readableOf(d, l.path, frame),
      opacity: l.opacity,
    }));
  return composite(layers, d.sprite.width, d.sprite.height);
};

export const createSpriteStore = ({
  link,
  draftBytes,
}: {
  link: Link;
  draftBytes: number;
}): SpriteStore => {
  /** sprite id -> cel key -> RGBA this daemon last saw in Aseprite (for changes()). */
  const lastSeen = new Map<number, Map<CelKey, Uint8Array>>();

  const directTarget = (): boolean =>
    compareVersions(link.status().extension, DIRECT_TARGET_EXTENSION) >= 0;

  const activate = async (id: number): Promise<void> => {
    const { result } = await link.request("sprites", {});
    if (record("sprites", result).active !== id) {
      await link.request("sprites", { select: id });
    }
  };

  const snapshot = async (ref?: unknown): Promise<DraftState> => {
    const { result, blobs } = await link.request(
      "snapshot",
      ref === undefined ? {} : { sprite: ref }
    );
    if (!isSnapshot(result)) {
      throw new Error("Aseprite sent a malformed snapshot reply.");
    }
    const s = result.sprite;
    const bytes = blobs.length * s.width * s.height * 4;
    if (bytes > draftBytes) {
      throw new Error(
        `Sprite '${s.name}' holds ${mb(bytes)} MB of cel pixels; the limit is ${mb(draftBytes)} MB. Work on a smaller sprite.`
      );
    }
    const d = buildDraft(result, blobs);
    if (!lastSeen.has(d.sprite.id)) {
      lastSeen.set(d.sprite.id, baseMap(d));
    }
    return d;
  };

  const openRef = async (o: OpenSpriteOptions): Promise<unknown> => {
    if (o.new) {
      const [w, h] = o.new;
      checkCanvasSize("sprite({ new: [w, h] })", w, h);
      const { result } = await link.request("new_sprite", {
        colorMode: o.colorMode ?? "rgb",
        height: h,
        width: w,
      });
      return record("new_sprite", result).spriteId;
    }
    if (o.openPath !== undefined) {
      const { result } = await link.request("open", { path: o.openPath });
      return record("open", result).spriteId;
    }
    return o.id ?? o.name;
  };

  const list = async (): Promise<SpriteSummary[]> => {
    const { result } = await link.request("sprites", {});
    const { sprites } = record("sprites", result);
    if (!Array.isArray(sprites) || !sprites.every((x) => isRecord(x))) {
      throw new Error("Aseprite sent a malformed sprites reply.");
    }
    return sprites.map(({ id, name, width, height, frames, active }) => ({
      active: Boolean(active),
      frames: Number(frames),
      height: Number(height),
      id: Number(id),
      name: String(name),
      width: Number(width),
    }));
  };

  const openSession = (): SpriteSession => {
    const states = new Map<number, { d: DraftState; api: SpriteDraft }>();
    const commits: CommitInfo[] = [];

    const commitState = (
      st: { d: DraftState },
      label: string
    ): Promise<CommitInfo | null> => {
      const { d } = st;
      const { colorMode: mode, transparentIndex: ti } = d.sprite;
      const merged = new Set<CelKey>();
      let lost = 0;

      const attempt = async (n: number): Promise<CommitInfo | null> => {
        const p = buildPlan(d);
        if (!p.ops.length && !p.writes.length) {
          return null;
        }
        const blobs: Uint8Array[] = [];
        const add = (bytes: Uint8Array): number => {
          blobs.push(bytes);
          return blobs.length - 1;
        };
        const nextRaw: (Uint8Array | null)[] = [];
        const writes = p.writes.map((w) => {
          const encodedNext = w.next
            ? fromRgba(w.next, mode, p.palette, ti).bytes
            : null;
          nextRaw.push(encodedNext);
          return {
            base: w.base
              ? add(w.baseRaw ?? fromRgba(w.base, mode, p.palette, ti).bytes)
              : null,
            frame: w.frame,
            layer: w.layer,
            next: encodedNext ? add(encodedNext) : null,
          };
        });
        const { result, blobs: current } = await link.request(
          "commit",
          { label, ops: p.ops, sprite: d.sprite.id, writes },
          blobs
        );
        if (!isCommitReply(result)) {
          throw new Error("Aseprite sent a malformed commit reply.");
        }
        if (result.applied) {
          rebaseDraft(d, p, nextRaw);
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
          commits.push(info);
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
          const buf = d.cels.get(w.key);
          if (!buf) {
            throw new Error(`No cel ${w.key} in the draft.`);
          }
          const res = merge3(buf.base, buf.cur, theirs);
          buf.base = theirs;
          buf.raw = raw;
          buf.cur = res.merged;
          lost += res.lost;
          merged.add(w.key);
        }
        return attempt(n + 1);
      };
      return attempt(0);
    };

    const history = async (
      st: { d: DraftState },
      action: "undo" | "redo",
      n = 1
    ): Promise<void> => {
      wholeNumber(`${action}(n): n`, n);
      if (pendingOf(st.d).dirty) {
        throw new Error(
          `${action}() would drop this program's uncommitted edits; call await s.commit() first.`
        );
      }
      const { id } = st.d.sprite;
      if (directTarget()) {
        await link.request("history", { action, sprite: id, steps: n });
      } else {
        await activate(id);
        await link.request("history", { action, steps: n });
      }
      st.d = await snapshot(id);
      lastSeen.set(id, baseMap(st.d));
    };

    const changesOf = async (st: {
      d: DraftState;
    }): Promise<ArtistChange[]> => {
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
        const { layer, frame } = parseKey(key);
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
      if (!pendingOf(st.d).dirty) {
        st.d = fresh;
      }
      return out.toSorted(byLayerThenFrame);
    };

    const makeDraft = (st: { d: DraftState }): SpriteDraft => ({
      bounds: (layer, frame) =>
        diffRect(
          null,
          readableOf(st.d, layer, frame),
          st.d.sprite.width,
          st.d.sprite.height
        ),
      changes: () => changesOf(st),
      get colorMode() {
        return st.d.sprite.colorMode;
      },
      commit: async (label = "checkpoint") =>
        (await commitState(st, label)) ?? {
          cels: 0,
          label,
          lost: 0,
          merged: 0,
          name: st.d.sprite.name,
          pixels: 0,
          sprite: st.d.sprite.id,
        },
      get durations() {
        return st.d.structure.durations;
      },
      flatten: (frame) => flattenDraft(st.d, frame),
      frames: () => st.d.structure.durations.length,
      get height() {
        return st.d.sprite.height;
      },
      get id() {
        return st.d.sprite.id;
      },
      layer: (name, o) => {
        applyStageLayer(st.d, name, o);
      },
      layers: () => st.d.structure.layers.map((l) => l.path),
      get name() {
        return st.d.sprite.name;
      },
      readable: (layer, frame) => readableOf(st.d, layer, frame),
      redo: (n) => history(st, "redo", n),
      resize: (width, height, o = {}) => {
        const { extension } = link.status();
        if (compareVersions(extension, RESIZE_EXTENSION) < 0) {
          throw new Error(
            `resize: the connected Aseprite extension is ${extension ?? "unknown"}; update the Aseprite extension to ${RESIZE_EXTENSION}.`
          );
        }
        const { d } = st;
        const { width: w, height: h } = d.sprite;
        const x = o.x ?? Math.floor((width - w) / 2);
        const y = o.y ?? height - h;
        checkCanvasSize("resize(width, height)", width, height);
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
          throw new TypeError(
            `resize: x and y must be whole numbers, got ${x}, ${y}.`
          );
        }
        const bytes = d.cels.size * width * height * 4;
        if (bytes > draftBytes) {
          throw new Error(
            `resize(${width}, ${height}): ${d.cels.size} cels at that size are ${mb(bytes)} MB of pixels; the limit is ${mb(draftBytes)} MB.`
          );
        }
        return applyResize(d, { height, width, x, y });
      },
      save: async (absPath) => {
        await commitState(st, AUTO_LABEL);
        const { id } = st.d.sprite;
        const args = {
          ...(absPath !== undefined && { path: absPath }),
          ...(directTarget() && { sprite: id }),
        };
        if (!directTarget()) {
          await activate(id);
        }
        const { result } = await link.request("save", args);
        return record("save", result).saved;
      },
      get selection() {
        return st.d.sprite.selection;
      },
      setFrames: (count, duration) => {
        applySetFrames(st.d, count, duration, draftBytes);
      },
      tag: (name, from, to, o) => {
        applyStageTag(st.d, name, from, to, o);
      },
      get tags() {
        return st.d.structure.tags;
      },
      undo: (n) => history(st, "undo", n),
      get width() {
        return st.d.sprite.width;
      },
      writable: (layer, frame) => writableOf(st.d, layer, frame),
    });

    const open = async (o: OpenSpriteOptions = {}): Promise<SpriteDraft> => {
      const d = await snapshot(await openRef(o));
      const known = states.get(d.sprite.id);
      if (known) {
        if (!pendingOf(known.d).dirty) {
          known.d = d;
        }
        return known.api;
      }
      const entry: { d: DraftState; api: SpriteDraft } = {
        api: undefined as unknown as SpriteDraft,
        d,
      };
      entry.api = makeDraft(entry);
      states.set(d.sprite.id, entry);
      return entry.api;
    };

    const commitAll = async (label = AUTO_LABEL): Promise<void> => {
      const entries = [...states.values()];
      const step = async (index: number): Promise<void> => {
        const st = entries[index];
        if (!st) {
          return;
        }
        await commitState(st, label);
        await step(index + 1);
      };
      await step(0);
    };

    const discarded = (): DiscardedSprite[] =>
      [...states.values()]
        .map((st) => ({ sprite: st.d.sprite.id, ...pendingOf(st.d) }))
        .filter((x) => x.dirty)
        .map(({ sprite, cels }) => ({ cels, sprite }));

    return {
      commitAll,
      commits,
      discarded,
      get: (id) => states.get(id)?.api,
      open,
    };
  };

  return { list, openSession };
};
