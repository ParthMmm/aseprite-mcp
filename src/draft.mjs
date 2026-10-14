// The host-side mirror of ONE sprite for ONE program run; pixel truth during a program lives here.
// Each program owns its Draft. Aseprite is the only shared state, and the only merge point is commit:
// compare-and-swap per cel in Lua, then merge3 here when the artist changed a cel underneath us.
import { fromRgba } from "./wire.mjs";

/** @typedef {"rgb" | "indexed" | "gray"} ColorMode */
/** @typedef {string} CelKey  `${layerPath}@${frame}`, frame 0-based */

/**
 * One cel as full-canvas RGBA. `base` is exactly what Aseprite held at snapshot (null = no cel). `cur` is null
 * until the first write (copy-on-write), so dirty is derived from cur vs base, never tracked by hand.
 * Linked cels share one CelBuf, so a write through either key is one write.
 * @typedef {{ base: Uint8Array | null, cur: Uint8Array | null, link: number | null }} CelBuf
 */

/**
 * `from` is the layer's path at snapshot (null = staged new layer); it is the identity plan() diffs on.
 * @typedef {{ path: string, from: string | null, visible: boolean, opacity: number, blend: string, group: boolean, below?: string, seq?: number }} Layer
 * @typedef {{ name: string, from: number, to: number, direction: string }} Tag
 * @typedef {{ layers: Layer[], durations: number[], tags: Tag[] }} Structure  layers bottom to top
 */

/**
 * @typedef {{
 *   sprite: { id: number, name: string, path: string | null, width: number, height: number, colorMode: ColorMode,
 *             transparentIndex: number, palette: string[], selection: [number, number, number, number] | null },
 *   baseStructure: Structure,
 *   structure: Structure,
 *   cels: Map<CelKey, CelBuf>,
 *   seq: number,
 * }} Draft
 */

/** @typedef {{ key: CelKey, layer: string, frame: number, base: Uint8Array | null, next: Uint8Array | null }} Write */
/** @typedef {{ ops: object[], writes: Write[], pixels: number, palette: string[] }} Plan */

export const celKey = (layer, frame) => `${layer}@${frame}`;
function parseKey(key) {
  const at = key.lastIndexOf("@");
  return { frame: Number(key.slice(at + 1)), layer: key.slice(0, at) };
}
const clone = (s) => structuredClone(s);
const parentOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const within = (path, root) => path === root || path.startsWith(`${root}/`);

/** Build a Draft from a snapshot reply whose blobs are already full-canvas RGBA (wire.toRgba). @returns {Draft} */
export function fromSnapshot(reply, rgbaBlobs) {
  const { sprite: s } = reply;
  const size = s.width * s.height * 4;
  /** @type {Structure} */
  const structure = {
    durations: reply.frames.map((f) => f.duration),
    layers: reply.layers.map((l) => ({
      path: l.path,
      from: l.path,
      visible: l.visible,
      opacity: l.opacity,
      blend: l.blend,
      group: l.group,
    })),
    tags: reply.tags.map((t) => ({ ...t })),
  };
  const cels = new Map();
  const linked = new Map();
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
    seq: 0,
    sprite: { ...s, palette: [...reply.palette], selection: reply.selection },
    structure,
  };
}

/** @returns {Layer} */
function layerOf(d, path) {
  const l = d.structure.layers.find((x) => x.path === path);
  if (!l) {
    throw new Error(
      `Unknown layer '${path}'. Layers: ${d.structure.layers.map((x) => x.path).join(", ") || "(none)"}.`
    );
  }
  return l;
}

function checkFrame(d, frame) {
  const n = d.structure.durations.length;
  if (!Number.isInteger(frame) || frame < 0 || frame >= n) {
    throw new Error(
      `Frame ${frame} does not exist; the sprite has ${n} frame${n === 1 ? "" : "s"} (0-${n - 1}).`
    );
  }
}

const canvasBytes = (d) => d.sprite.width * d.sprite.height * 4;

/** The writable buffer for a cel; creates `cur` from `base` (or a transparent canvas) on first call. */
export function writable(d, layer, frame) {
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
    d.cels.set(key, (buf = { base: null, cur: null, link: null }));
  }
  buf.cur ??= buf.base ? buf.base.slice() : new Uint8Array(canvasBytes(d));
  return buf.cur;
}

/** Read-only pixels of a cel: cur, else base, else a fresh transparent canvas. Callers must not write to it. */
export function readable(d, layer, frame) {
  layerOf(d, layer);
  checkFrame(d, frame);
  const buf = d.cels.get(celKey(layer, frame));
  return buf?.cur ?? buf?.base ?? new Uint8Array(canvasBytes(d));
}

/**
 * Set the frame count. New frames copy every layer's last frame. `durations`: one number for every frame, an
 * array of `count` numbers, or undefined to keep existing durations and give new frames the last one.
 */
export function setFrames(d, count, durations) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Frame count must be a whole number >= 1, got ${count}.`);
  }
  const old = d.structure.durations;
  const n = old.length;
  if (Array.isArray(durations) && durations.length !== count) {
    throw new Error(
      `durations has ${durations.length} entries for ${count} frames.`
    );
  }
  for (let f = n; f < count; f++) {
    for (const l of d.structure.layers) {
      if (l.group) {
        continue;
      }
      const last = d.cels.get(celKey(l.path, n - 1));
      const src = last?.cur ?? last?.base;
      // a frame that existed at snapshot (shrunk, then grown again) keeps its base so CAS still matches Aseprite
      const base = d.cels.get(celKey(l.path, f))?.base ?? null;
      if (src || base) {
        d.cels.set(celKey(l.path, f), {
          base,
          cur: src ? src.slice() : new Uint8Array(canvasBytes(d)),
          link: null,
        });
      }
    }
  }
  const next = Array.from({ length: count }, (_, f) =>
    Array.isArray(durations)
      ? durations[f]
      : typeof durations === "number"
        ? durations
        : old[Math.min(f, n - 1)]
  );
  if (!next.every((x) => typeof x === "number" && x > 0)) {
    throw new Error(
      "Frame durations must be positive numbers of milliseconds."
    );
  }
  d.structure.durations = next;
}

/**
 * Stage a layer change. An unknown name creates a layer, on top or below `below`.
 * `rename` is the new name inside the same group; `remove` drops the layer (and a group's children).
 * @param {{ below?: string, visible?: boolean, opacity?: number, rename?: string, remove?: boolean }} [o]
 */
export function stageLayer(d, name, o = {}) {
  const { layers } = d.structure;
  const existing = layers.find((l) => l.path === name);
  if (
    o.opacity !== undefined &&
    !(Number.isInteger(o.opacity) && o.opacity >= 0 && o.opacity <= 255)
  ) {
    throw new Error(`opacity must be a whole number 0-255, got ${o.opacity}.`);
  }
  if (o.remove) {
    layerOf(d, name);
    d.structure.layers = layers.filter((l) => !within(l.path, name));
    for (const key of [...d.cels.keys()]) {
      if (within(parseKey(key).layer, name)) d.cels.delete(key);
    }
    return;
  }
  let l = existing;
  if (!l) {
    if (o.below !== undefined) {
      layerOf(d, o.below);
    }
    l = {
      below: o.below,
      blend: "normal",
      from: null,
      group: false,
      opacity: 255,
      path: name,
      seq: d.seq++,
      visible: true,
    };
    const at =
      o.below === undefined
        ? layers.length
        : layers.findIndex((x) => x.path === o.below);
    layers.splice(at, 0, l);
  }
  if (o.visible !== undefined) {
    l.visible = o.visible;
  }
  if (o.opacity !== undefined) {
    l.opacity = o.opacity;
  }
  if (o.rename !== undefined && o.rename !== nameOf(l.path)) {
    if (!o.rename || o.rename.includes("/")) {
      throw new Error(
        `rename must be a plain layer name, got ${JSON.stringify(o.rename)}.`
      );
    }
    const parent = parentOf(l.path);
    const to = parent ? `${parent}/${o.rename}` : o.rename;
    if (layers.some((x) => x.path === to)) {
      throw new Error(`A layer named '${to}' already exists.`);
    }
    const from = l.path;
    const move = (p) => to + p.slice(from.length);
    for (const x of layers) {
      if (within(x.path, from)) x.path = move(x.path);
    }
    for (const x of layers) {
      if (x.below !== undefined && within(x.below, from))
        x.below = move(x.below);
    }
    for (const [key, buf] of [...d.cels]) {
      const { layer, frame } = parseKey(key);
      if (!within(layer, from)) {
        continue;
      }
      d.cels.delete(key);
      d.cels.set(celKey(move(layer), frame), buf);
    }
  }
}

/** Create or change a tag over frames from..to (0-based, inclusive). */
export function stageTag(d, name, from, to, { direction = "forward" } = {}) {
  checkFrame(d, from);
  checkFrame(d, to);
  if (from > to) {
    throw new Error(`Tag '${name}': from (${from}) is after to (${to}).`);
  }
  if (!["forward", "reverse", "pingpong"].includes(direction)) {
    throw new Error(`Tag direction must be forward, reverse or pingpong.`);
  }
  const tag = { direction, from, name, to };
  const i = d.structure.tags.findIndex((t) => t.name === name);
  if (i !== -1) {
    d.structure.tags[i] = tag;
  } else {
    d.structure.tags.push(tag);
  }
}

const visibleKey = (a, i) =>
  a[i + 3] === 0
    ? 0
    : ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0;

/** Pixels whose visible value differs; null is a transparent canvas. */
function diffCount(a, b) {
  const len = (a ?? b)?.length ?? 0;
  let n = 0;
  for (let i = 0; i < len; i += 4) {
    if ((a ? visibleKey(a, i) : 0) !== (b ? visibleKey(b, i) : 0)) n++;
  }
  return n;
}
const isEmpty = (a) => diffCount(a, null) === 0;

/**
 * Diff the draft into a commit plan. Writes list only cels whose pixels changed, once per linked group;
 * an all-transparent result deletes the cel. Indexed sprites get a `palette.append` for colours not in the palette.
 * @returns {Plan}
 */
export function plan(d) {
  const { baseStructure: was, structure: now } = d;
  const ops = [];

  const kept = new Set(now.layers.map((l) => l.from));
  const removed = was.layers
    .filter((l) => !kept.has(l.path))
    .map((l) => l.path);
  for (const path of removed) {
    if (!removed.includes(parentOf(path)))
      ops.push({ op: "layer.remove", path });
  }

  const props = (l, b) => ({
    ...(l.visible !== (b?.visible ?? true) && { visible: l.visible }),
    ...(l.opacity !== (b?.opacity ?? 255) && { opacity: l.opacity }),
  });
  const renames = [];
  for (const l of now.layers) {
    if (l.from === null) {
      continue;
    }
    const b = was.layers.find((x) => x.path === l.from);
    const p = props(l, b);
    if (Object.keys(p).length) {
      ops.push({ op: "layer.set", path: l.from, ...p });
    }
    if (nameOf(l.path) !== nameOf(l.from)) {
      renames.push(l);
    }
  }
  // children first, so a group rename never invalidates a child's path
  renames.sort((a, b) => b.from.split("/").length - a.from.split("/").length);
  for (const l of renames) {
    ops.push({ op: "layer.set", path: l.from, rename: nameOf(l.path) });
  }
  for (const l of now.layers
    .filter((x) => x.from === null)
    .sort((a, b) => a.seq - b.seq)) {
    ops.push({
      op: "layer.add",
      path: l.path,
      ...(l.below !== undefined && { below: l.below }),
    });
    const p = props(l, null);
    if (Object.keys(p).length) {
      ops.push({ op: "layer.set", path: l.path, ...p });
    }
  }

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

  const frames = now.durations.length;
  const layerPaths = new Set(now.layers.map((l) => l.path));
  /** @type {Write[]} */
  const writes = [];
  const seen = new Set();
  let pixels = 0;
  for (const [key, buf] of d.cels) {
    const { layer, frame } = parseKey(key);
    if (frame >= frames || !layerPaths.has(layer) || seen.has(buf)) {
      continue;
    }
    seen.add(buf);
    if (!buf.cur) {
      continue;
    }
    const n = diffCount(buf.base, buf.cur);
    if (n === 0) {
      continue;
    }
    pixels += n;
    writes.push({
      base: buf.base,
      frame,
      key,
      layer,
      next: isEmpty(buf.cur) ? null : buf.cur.slice(),
    });
  }

  let { palette } = d.sprite;
  if (d.sprite.colorMode === "indexed") {
    const missing = new Set();
    for (const w of writes) {
      if (w.next) {
        for (const c of fromRgba(
          w.next,
          "indexed",
          palette,
          d.sprite.transparentIndex
        ).missing)
          missing.add(c);
      }
    }
    if (missing.size) {
      if (palette.length + missing.size > 256) {
        throw new Error(
          `The indexed palette would need ${palette.length + missing.size} colours (max 256). Use fewer colours or convert the sprite to RGB.`
        );
      }
      ops.unshift({ colors: [...missing], op: "palette.append" });
      palette = [...palette, ...missing];
    }
  }
  return { ops, palette, pixels, writes };
}

/**
 * 3-way merge for one cel: base (our snapshot), ours (cur), theirs (Aseprite now); null = no cel.
 * Ours where ours != base, theirs elsewhere; where both changed differently the artist wins.
 * @returns {{ merged: Uint8Array, kept: number, lost: number }}
 */
export function merge3(base, ours, theirs) {
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
      lost++;
    } else if (oursChanged) {
      kept++;
    }
    const src = oursChanged && !theirsChanged ? ours : theirs;
    if (src) {
      merged.set(src.subarray(i, i + 4), i);
    }
  }
  return { kept, lost, merged };
}

/** A commit conflict on `key`: merge our edits onto what Aseprite holds now, which becomes the new base. */
export function resolveConflict(d, key, theirs) {
  const buf = d.cels.get(key);
  if (!buf) {
    throw new Error(`No cel ${key} in the draft.`);
  }
  const { merged, kept, lost } = merge3(buf.base, buf.cur, theirs);
  buf.base = theirs;
  buf.cur = merged;
  return { kept, lost };
}

/** After a successful commit: base := what was written, staged structure becomes the base. A second plan is empty. */
export function rebase(d, /** @type {Plan} */ applied) {
  for (const w of applied.writes) {
    const buf = d.cels.get(w.key);
    if (!buf) {
      continue;
    }
    buf.base = w.next;
    // edits made while the commit was in flight stay dirty against the new base
    if (buf.cur && diffCount(buf.cur, w.next) === 0) {
      buf.cur = null;
    }
  }
  const frames = d.structure.durations.length;
  for (const key of [...d.cels.keys()]) {
    if (parseKey(key).frame >= frames) d.cels.delete(key);
  }
  for (const l of d.structure.layers) {
    l.from = l.path;
    delete l.below;
    delete l.seq;
  }
  d.baseStructure = clone(d.structure);
  d.sprite.palette = [...applied.palette];
}
