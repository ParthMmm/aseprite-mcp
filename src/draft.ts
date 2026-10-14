// The host-side mirror of ONE sprite for ONE program run; pixel truth during a program lives here.
// Each program owns its Draft. Aseprite is the only shared state, and the only merge point is commit:
// compare-and-swap per cel in Lua, then merge3 here when the artist changed a cel underneath us.
import { wholeNumber } from "./check.ts";
import type { Rect } from "./raster.ts";
import { fromRgba } from "./wire.ts";
import type { ColorMode } from "./wire.ts";

/** `${layerPath}@${frame}`, frame 0-based. */
export type CelKey = `${string}@${number}`;

/**
 * One cel as full-canvas RGBA. `base` is exactly what Aseprite held at snapshot (null = no cel). `cur` is null
 * until the first write (copy-on-write), so dirty is derived from cur vs base, never tracked by hand.
 * Linked cels share one CelBuf, so a write through either key is one write.
 */
export interface CelBuf {
  base: Uint8Array | null;
  cur: Uint8Array | null;
  link: number | null;
}

/** `from` is the layer's path at snapshot (null = staged new layer); it is the identity plan() diffs on. */
export interface Layer {
  path: string;
  from: string | null;
  visible: boolean;
  opacity: number;
  blend: string;
  group: boolean;
  below?: string;
  seq?: number;
}

export type TagDirection = "forward" | "reverse" | "pingpong";
/** Snapshot tags may carry any direction Aseprite knows; staged tags use TagDirection. */
export interface Tag {
  name: string;
  from: number;
  to: number;
  direction: string;
}

export interface Structure {
  /** Bottom to top. */
  layers: Layer[];
  durations: number[];
  tags: Tag[];
}

export interface SpriteInfo {
  id: number;
  name: string;
  path: string | null;
  width: number;
  height: number;
  colorMode: ColorMode;
  transparentIndex: number;
  palette: string[];
  selection: Rect | null;
}

/** A canvas size change: art moves by (x, y); pixels that land outside are dropped. */
export interface Resize {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface Draft {
  sprite: SpriteInfo;
  baseStructure: Structure;
  structure: Structure;
  cels: Map<CelKey, CelBuf>;
  /** Canvas size changes since the last commit, in order; cel buffers already have the latest size. */
  resizes: Resize[];
  seq: number;
}

/** The extension's snapshot reply; cel blobs index the RGBA blobs passed beside it. */
export interface SnapshotReply {
  sprite: Omit<SpriteInfo, "palette" | "selection">;
  palette: string[];
  selection: Rect | null;
  frames: { duration: number }[];
  layers: Pick<Layer, "path" | "visible" | "opacity" | "blend" | "group">[];
  tags: Tag[];
  cels: { layer: string; frame: number; blob: number; link?: number | null }[];
}

export interface CelWrite {
  key: CelKey;
  layer: string;
  frame: number;
  base: Uint8Array | null;
  /** null deletes the cel. */
  next: Uint8Array | null;
}

type LayerProps = Partial<Pick<Layer, "visible" | "opacity">>;

/** One structural change for plugin.lua, applied in list order. */
export type Op =
  | { op: "palette.append"; colors: string[] }
  | ({ op: "canvas.resize" } & Resize)
  | { op: "layer.remove"; path: string }
  | ({ op: "layer.set"; path: string; rename?: string } & LayerProps)
  | { op: "layer.add"; path: string; below?: string }
  | { op: "frames.set"; count: number; durations: number[] }
  | ({ op: "tag.set" } & Tag);

export interface Plan {
  ops: Op[];
  writes: CelWrite[];
  pixels: number;
  palette: string[];
}

export interface LayerOptions {
  below?: string;
  visible?: boolean;
  opacity?: number;
  rename?: string;
  remove?: boolean;
}

export interface MergeResult {
  merged: Uint8Array;
  kept: number;
  lost: number;
}

const TAG_DIRECTIONS = new Set<string>(["forward", "reverse", "pingpong"]);

export const celKey = (layer: string, frame: number): CelKey =>
  `${layer}@${frame}`;
export const parseKey = (key: CelKey): { frame: number; layer: string } => {
  const at = key.lastIndexOf("@");
  return { frame: Number(key.slice(at + 1)), layer: key.slice(0, at) };
};
const clone = (s: Structure): Structure => structuredClone(s);
const parentOf = (path: string): string =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/** Build a Draft from a snapshot reply whose blobs are already full-canvas RGBA (wire.toRgba). */
export const fromSnapshot = (
  reply: SnapshotReply,
  rgbaBlobs: readonly Uint8Array[]
): Draft => {
  const { sprite: s } = reply;
  const size = s.width * s.height * 4;
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
    const bytes = rgbaBlobs[c.blob];
    if (!bytes || bytes.length !== size) {
      throw new Error(
        `Snapshot cel ${c.layer}@${c.frame}: expected ${size} RGBA bytes.`
      );
    }
    const group =
      c.link === null || c.link === undefined ? null : celKey(c.layer, c.link);
    let buf = group && linked.get(group);
    if (!buf) {
      buf = { base: bytes, cur: null, link: c.link ?? null };
      if (group) {
        linked.set(group, buf);
      }
    }
    cels.set(celKey(c.layer, c.frame), buf);
  }
  return {
    baseStructure: clone(structure),
    cels,
    resizes: [],
    seq: 0,
    sprite: { ...s, palette: [...reply.palette], selection: reply.selection },
    structure,
  };
};

const layerOf = (d: Draft, path: string): Layer => {
  const l = d.structure.layers.find((x) => x.path === path);
  if (!l) {
    throw new Error(
      `Unknown layer '${path}'. Layers: ${d.structure.layers.map((x) => x.path).join(", ") || "(none)"}.`
    );
  }
  return l;
};

const checkFrame = (d: Draft, frame: number): void => {
  const n = d.structure.durations.length;
  if (!Number.isInteger(frame) || frame < 0 || frame >= n) {
    throw new Error(
      `Frame ${frame} does not exist; the sprite has ${n} frame${n === 1 ? "" : "s"} (0-${n - 1}).`
    );
  }
};

const canvasBytes = (d: Draft): number => d.sprite.width * d.sprite.height * 4;

/** The writable buffer for a cel; creates `cur` from `base` (or a transparent canvas) on first call. */
export const writable = (
  d: Draft,
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
    buf = { base: null, cur: null, link: null };
    d.cels.set(key, buf);
  }
  buf.cur ??= buf.base
    ? new Uint8Array(buf.base)
    : new Uint8Array(canvasBytes(d));
  return buf.cur;
};

/** Read-only pixels of a cel: cur, else base, else a fresh transparent canvas. Callers must not write to it. */
export const readable = (
  d: Draft,
  layer: string,
  frame: number
): Uint8Array => {
  layerOf(d, layer);
  checkFrame(d, frame);
  const buf = d.cels.get(celKey(layer, frame));
  return buf?.cur ?? buf?.base ?? new Uint8Array(canvasBytes(d));
};

const isDuration = (x: unknown): x is number => typeof x === "number" && x > 0;

/**
 * Set the frame count. New frames copy every layer's last frame. `durations`: one number for every frame, an
 * array of `count` numbers, or undefined to keep existing durations and give new frames the last one.
 */
export const setFrames = (
  d: Draft,
  count: number,
  durations?: unknown
): void => {
  wholeNumber("Frame count", count);
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
      // A frame that existed at snapshot (shrunk, then grown again) keeps its base so CAS still matches Aseprite.
      const base = d.cels.get(celKey(l.path, f))?.base ?? null;
      if (src || base) {
        d.cels.set(celKey(l.path, f), {
          base,
          cur: src ? new Uint8Array(src) : new Uint8Array(canvasBytes(d)),
          link: null,
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

const removeLayer = (d: Draft, name: string): void => {
  layerOf(d, name);
  d.structure.layers = d.structure.layers.filter((l) => !within(l.path, name));
  for (const key of d.cels.keys()) {
    if (within(parseKey(key).layer, name)) {
      d.cels.delete(key);
    }
  }
};

const addLayer = (d: Draft, name: string, below?: string): Layer => {
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

const renameLayer = (d: Draft, l: Layer, rename: string): void => {
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

/**
 * Stage a layer change. An unknown name creates a layer, on top or below `below`.
 * `rename` is the new name inside the same group; `remove` drops the layer (and a group's children).
 */
export const stageLayer = (
  d: Draft,
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

/** Create or change a tag over frames from..to (0-based, inclusive). */
export const stageTag = (
  d: Draft,
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
    throw new Error(`Tag direction must be forward, reverse or pingpong.`);
  }
  const tag = { direction, from, name, to };
  const i = d.structure.tags.findIndex((t) => t.name === name);
  if (i === -1) {
    d.structure.tags.push(tag);
  } else {
    d.structure.tags[i] = tag;
  }
};

const visibleKey = (a: Uint8Array, i: number): number =>
  a[i + 3] === 0
    ? 0
    : ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0;

/** Pixels whose visible value differs; null is a transparent canvas. */
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

export interface ResizeResult {
  /** Opaque pixels each cel lost outside the new canvas. */
  dropped: [CelKey, number][];
  /** Each snapshot buffer and the moved buffer that replaced it. */
  bases: [Uint8Array, Uint8Array][];
}

/** Change the canvas size: every cel moves by (x, y) and is clipped to the new size. */
export const resize = (d: Draft, r: Resize): ResizeResult => {
  const size: [number, number] = [d.sprite.width, d.sprite.height];
  const move = (a: Uint8Array): Uint8Array =>
    moveCanvas(a, size, [r.width, r.height], [r.x, r.y]);
  const out: ResizeResult = { bases: [], dropped: [] };
  const seen = new Set<CelBuf>();
  for (const [key, buf] of d.cels) {
    if (seen.has(buf)) {
      continue;
    }
    seen.add(buf);
    const before = opaque(buf.cur ?? buf.base);
    if (buf.base) {
      const next = move(buf.base);
      out.bases.push([buf.base, next]);
      buf.base = next;
    }
    if (buf.cur) {
      buf.cur = move(buf.cur);
    }
    const lost = before - opaque(buf.cur ?? buf.base);
    if (lost) {
      out.dropped.push([key, lost]);
    }
  }
  const sel = d.sprite.selection;
  d.sprite.selection = sel && [sel[0] + r.x, sel[1] + r.y, sel[2], sel[3]];
  d.sprite.width = r.width;
  d.sprite.height = r.height;
  d.resizes.push({ ...r });
  return out;
};

const changedProps = (l: Layer, b: Layer | null | undefined): LayerProps => ({
  ...(l.visible !== (b?.visible ?? true) && { visible: l.visible }),
  ...(l.opacity !== (b?.opacity ?? 255) && { opacity: l.opacity }),
});

const depth = (path: string): number => path.split("/").length;

/** Removals, property changes, renames (children first) and additions, in the order plugin.lua applies them. */
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

/** Cels whose pixels changed, once per linked group; an all-transparent result deletes the cel. */
const celWrites = (d: Draft): { writes: CelWrite[]; pixels: number } => {
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
      frame,
      key,
      layer,
      next: isEmpty(cur) ? null : new Uint8Array(cur),
    });
  }
  return { pixels, writes };
};

/** Colours the writes use that the indexed palette lacks. */
const missingColors = (d: Draft, writes: CelWrite[]): Set<string> => {
  const missing = new Set<string>();
  for (const w of writes) {
    if (!w.next) {
      continue;
    }
    const { palette, transparentIndex } = d.sprite;
    for (const c of fromRgba(w.next, "indexed", palette, transparentIndex)
      .missing) {
      missing.add(c);
    }
  }
  return missing;
};

/**
 * Diff the draft into a commit plan. Writes list only cels whose pixels changed, once per linked group;
 * an all-transparent result deletes the cel. Indexed sprites get a `palette.append` for colours not in the palette.
 */
export const plan = (d: Draft): Plan => {
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

/**
 * 3-way merge for one cel: base (our snapshot), ours (cur), theirs (Aseprite now); null = no cel.
 * Ours where ours != base, theirs elsewhere; where both changed differently the artist wins.
 */
export const merge3 = (
  base: Uint8Array | null,
  ours: Uint8Array | null,
  theirs: Uint8Array | null
): MergeResult => {
  const len = (base ?? ours ?? theirs)?.length ?? 0;
  const merged = new Uint8Array(len);
  let kept = 0;
  let lost = 0;
  for (let i = 0; i < len; i += 4) {
    const b = base ? visibleKey(base, i) : 0;
    const o = ours ? visibleKey(ours, i) : 0;
    const t = theirs ? visibleKey(theirs, i) : 0;
    const oursChanged = o !== b;
    const theirsChanged = t !== b;
    if (oursChanged && theirsChanged && o !== t) {
      lost += 1;
    } else if (oursChanged) {
      kept += 1;
    }
    const src = oursChanged && !theirsChanged ? ours : theirs;
    if (src) {
      merged.set(src.subarray(i, i + 4), i);
    }
  }
  return { kept, lost, merged };
};

/** A commit conflict on `key`: merge our edits onto what Aseprite holds now, which becomes the new base. */
export const resolveConflict = (
  d: Draft,
  key: CelKey,
  theirs: Uint8Array | null
): { kept: number; lost: number } => {
  const buf = d.cels.get(key);
  if (!buf) {
    throw new Error(`No cel ${key} in the draft.`);
  }
  const { merged, kept, lost } = merge3(buf.base, buf.cur, theirs);
  buf.base = theirs;
  buf.cur = merged;
  return { kept, lost };
};

/** After a successful commit: base := what was written, staged structure becomes the base. A second plan is empty. */
export const rebase = (d: Draft, applied: Plan): void => {
  for (const w of applied.writes) {
    const buf = d.cels.get(w.key);
    if (!buf) {
      continue;
    }
    buf.base = w.next;
    // Edits made while the commit was in flight stay dirty against the new base.
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
  d.baseStructure = clone(d.structure);
  d.resizes.splice(
    0,
    applied.ops.filter((o) => o.op === "canvas.resize").length
  );
  d.sprite.palette = [...applied.palette];
};
