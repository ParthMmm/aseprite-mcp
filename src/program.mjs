// The code-mode runtime: one execute() runs one agent program against per-sprite Drafts, then commits what is
// left as one undo step per sprite. Globals: sprite, sprites, ramp, palette, help. Handles are plain objects of
// closures; mutable state is behind methods because codemode copies plain fields once at the boundary.
import { mkdir, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CodeMode, Extension } from "@opencode/codemode";
import { Effect } from "effect";
import { ramp, loadPalette, savePalette } from "./color.mjs";
import * as D from "./draft.mjs";
import * as R from "./raster.mjs";
import { composite, critiqueSheet, frameStrip, renderView } from "./render.mjs";
import { fromRgba, toRgba } from "./wire.mjs";
import { DESCRIPTION, help } from "./help.mjs";
import { insideAllowedDir } from "./files.mjs";

export { DESCRIPTION };

export const DEFAULT_LIMITS = { timeoutMs: 60_000, maxOutputBytes: 64_000, maxToolCalls: 10_000, draftBytes: 64 * 1024 * 1024 };
const MAX_RETRIES = 3;
const KEEP_VIEWS = 200;
const AUTO_LABEL = "program"; // Lua prefixes "MCP: "

/** @typedef {import("./draft.mjs").Draft} Draft */
/** @typedef {{ sprite: number, name: string, label: string, cels: number, pixels: number, merged: number, lost: number }} CommitInfo */
/** One sprite inside one run: `d` is replaced on undo/redo/changes, so handles read it through `st`. */
/** @typedef {{ d: Draft, handle?: object }} SpriteState */
/** @typedef {{ states: Map<number, SpriteState>, images: string[], commits: CommitInfo[] }} Run */

const parseKey = (key) => {
  const at = key.lastIndexOf("@");
  return { layer: key.slice(0, at), frame: Number(key.slice(at + 1)) };
};
const mb = (n) => Math.ceil(n / (1024 * 1024));

/** cel key -> base bytes: what Aseprite holds according to this draft. */
function baseMap(d) {
  const out = new Map();
  for (const [key, buf] of d.cels) if (buf.base) out.set(key, buf.base);
  return out;
}

function pending(d) {
  try {
    const p = D.plan(d);
    return { dirty: p.ops.length > 0 || p.writes.length > 0, cels: p.writes.length };
  } catch {
    return { dirty: true, cels: 0 };
  }
}

const visible = (a, i) => (a[i + 3] === 0 ? 0 : ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0);

/** Bounding rect of pixels whose visible value differs; null = no difference. */
function diffRect(a, b, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((a ? visible(a, i) : 0) === (b ? visible(b, i) : 0)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/**
 * @param {{ link: import("./link.mjs").Link, viewsDir: string, palettesFile: string, allowedDirs: string[], limits?: object }} o
 */
export function createRuntime({ link, viewsDir, palettesFile, allowedDirs = [], limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  /** sprite id -> cel key -> RGBA this daemon last saw in Aseprite (for changes()). */
  const lastSeen = new Map();
  /** RGBA buffer -> the exact sprite-mode bytes it came from, so CAS bases match Aseprite byte for byte. */
  const rawBytes = new WeakMap();
  let viewSeq = 0;

  // Symlinks are resolved first, so a link inside an allowed folder cannot reach outside it.
  async function allowedPath(p) {
    if (typeof p !== "string" || !p) throw new Error("Pass a file path as a string.");
    if (!isAbsolute(p) && !p.startsWith("~")) throw new Error(`'${p}' is relative; pass an absolute path.`);
    const abs = resolve(p.replace(/^~(?=\/|$)/, homedir()));
    const real = await realpath(abs).catch(async () => join(await realpath(dirname(abs)).catch(() => abs), basename(abs)));
    if (!(await insideAllowedDir(real, allowedDirs))) throw new Error(`'${abs}' is outside the allowed folders: ${allowedDirs.join(", ") || "(none configured)"}.`);
    return real;
  }

  async function snapshot(ref) {
    const { result, blobs } = await link.request("snapshot", ref === undefined ? {} : { sprite: ref });
    const s = result.sprite;
    const bytes = blobs.length * s.width * s.height * 4;
    if (bytes > lim.draftBytes) {
      throw new Error(`Sprite '${s.name}' holds ${mb(bytes)} MB of cel pixels; the limit is ${mb(lim.draftBytes)} MB. Work on a smaller sprite.`);
    }
    const rgba = blobs.map((b) => {
      const x = toRgba(b, s.colorMode, result.palette, s.transparentIndex);
      rawBytes.set(x, b);
      return x;
    });
    s.path ??= null;
    const d = D.fromSnapshot({ ...result, selection: result.selection ?? null }, rgba);
    if (!lastSeen.has(d.sprite.id)) lastSeen.set(d.sprite.id, baseMap(d));
    return d;
  }

  async function activate(id) {
    const { result } = await link.request("sprites", {});
    if (result.active !== id) await link.request("sprites", { select: id });
  }

  /** plan -> commit -> on conflict merge3 and retry (max 3) -> rebase. A clean draft sends nothing. */
  async function commitDraft(/** @type {Run} */ run, /** @type {SpriteState} */ st, label) {
    const d = st.d;
    const { colorMode: mode, transparentIndex: ti } = d.sprite;
    const merged = new Set();
    let lost = 0;
    for (let attempt = 0; ; attempt++) {
      const p = D.plan(d);
      if (!p.ops.length && !p.writes.length) return null;
      const blobs = [];
      const add = (bytes) => (blobs.push(bytes), blobs.length - 1);
      const writes = p.writes.map((w) => ({
        layer: w.layer,
        frame: w.frame,
        base: w.base ? add(rawBytes.get(w.base) ?? fromRgba(w.base, mode, p.palette, ti).bytes) : null,
        next: w.next ? add(fromRgba(w.next, mode, p.palette, ti).bytes) : null,
      }));
      const { result, blobs: current } = await link.request("commit", { sprite: d.sprite.id, label, ops: p.ops, writes }, blobs);
      if (result.applied) {
        p.writes.forEach((w, i) => w.next && rawBytes.set(w.next, blobs[writes[i].next]));
        D.rebase(d, p);
        lastSeen.set(d.sprite.id, baseMap(d));
        const info = { sprite: d.sprite.id, name: d.sprite.name, label, cels: result.cels, pixels: p.pixels, merged: merged.size, lost };
        run.commits.push(info);
        return info;
      }
      if (result.reason !== "conflict") {
        throw new Error(`Commit '${label}' failed: ${result.message}. Call sprite() again to see the current layers.`);
      }
      if (attempt === MAX_RETRIES) {
        throw new Error(`Commit '${label}' gave up after ${MAX_RETRIES} retries: the artist kept changing the same cels. Run the program again.`);
      }
      for (const c of result.conflicts) {
        const w = p.writes[c.write];
        const raw = c.blob === undefined || c.blob === null ? null : current[c.blob];
        const theirs = raw ? toRgba(raw, mode, d.sprite.palette, ti) : null;
        if (theirs) rawBytes.set(theirs, raw);
        lost += D.resolveConflict(d, w.key, theirs).lost;
        merged.add(w.key);
      }
    }
  }

  function selectionRect(d) {
    const sel = d.sprite.selection;
    if (!sel) throw new Error(`No selection in '${d.sprite.name}'; pass a rect [x, y, w, h] instead.`);
    return sel;
  }
  const rectOf = (d, r) => (r === "selection" ? selectionRect(d) : r);
  const withRect = (d, o) => (o && o.rect !== undefined ? { ...o, rect: rectOf(d, o.rect) } : o);

  function checkMap(palette, rows) {
    if (!Array.isArray(rows) || rows.some((r) => typeof r !== "string")) throw new Error("map: rows must be an array of strings.");
    const keys = new Set(Object.keys(palette ?? {}));
    rows.forEach((row, j) => {
      for (const ch of row) {
        if (ch === "." || ch === " " || keys.has(ch)) continue;
        throw new Error(`map: row ${j} uses key ${JSON.stringify(ch)}, which is not in the palette (keys: ${[...keys].join("") || "none"}). Use "." or space to skip a pixel.`);
      }
    });
  }

  function celHandle(/** @type {Run} */ run, /** @type {SpriteState} */ st, layer, frame) {
    D.readable(st.d, layer, frame);
    const canvas = (data) => ({ width: st.d.sprite.width, height: st.d.sprite.height, data });
    const cv = () => canvas(D.writable(st.d, layer, frame));
    const ro = () => canvas(D.readable(st.d, layer, frame));
    return {
      sprite: st.d.sprite.id,
      layer,
      frame,
      map: (palette, rows, o) => (checkMap(palette, rows), R.map(cv(), palette, rows, o)),
      px: (points) => R.px(cv(), points),
      line: (x0, y0, x1, y1, color) => R.line(cv(), x0, y0, x1, y1, color),
      rect: (r, color, o) => R.rect(cv(), rectOf(st.d, r), color, o),
      ellipse: (r, color, o) => R.ellipse(cv(), rectOf(st.d, r), color, o),
      fill: (x, y, color) => R.fill(cv(), x, y, color),
      outline: (color, o) => {
        if (color && typeof color === "object") [color, o] = [undefined, color];
        return R.outline(cv(), color, withRect(st.d, o));
      },
      shift: (dx, dy, o) => R.shift(cv(), dx, dy, withRect(st.d, o)),
      copy: (from, o) => {
        const src = from?.sprite === undefined ? st : run.states.get(from.sprite);
        if (!src || typeof from?.layer !== "string") throw new Error("copy: pass a cel from s.cel(layer, frame).");
        const dst = cv();
        const data = D.readable(src.d, from.layer, from.frame ?? 0);
        return R.copy(dst, { width: src.d.sprite.width, height: src.d.sprite.height, data }, withRect(src.d, o));
      },
      recolor: (mapping, o) => R.recolor(cv(), mapping, withRect(st.d, o)),
      clear: (r) => R.clear(cv(), r === undefined ? undefined : rectOf(st.d, r)),
      read: (o) => R.read(ro(), withRect(st.d, o)),
    };
  }

  /** Visible pixel layers of one frame, composited bottom to top; a hidden group hides its children. */
  function flatten(d, frame) {
    const byPath = new Map(d.structure.layers.map((l) => [l.path, l]));
    const shown = (path) => {
      for (let p = path; ; p = p.slice(0, p.lastIndexOf("/"))) {
        if (!byPath.get(p)?.visible) return false;
        if (!p.includes("/")) return true;
      }
    };
    const layers = d.structure.layers
      .filter((l) => !l.group && shown(l.path))
      .map((l) => ({ data: D.readable(d, l.path, frame), opacity: l.opacity }));
    return composite(layers, d.sprite.width, d.sprite.height);
  }

  async function view(/** @type {Run} */ run, /** @type {SpriteState} */ st, o = {}) {
    const d = st.d;
    const n = d.structure.durations.length;
    const frames = o.frame === "all" ? Array.from({ length: n }, (_, f) => f) : [o.frame ?? 0];
    for (const f of frames) {
      if (!Number.isInteger(f) || f < 0 || f >= n) throw new Error(`view: frame ${f} does not exist; the sprite has ${n} frame(s) (0-${n - 1}) or use "all".`);
    }
    const r = o.rect === undefined ? null : rectOf(d, o.rect);
    const pics = frames.map((f) => (r ? R.crop(flatten(d, f), r) : flatten(d, f)));
    const cv = pics.length === 1 ? pics[0] : frameStrip(pics);
    const out = o.critique ? critiqueSheet(cv, { scale: o.scale }) : renderView(cv, { scale: o.scale });
    await mkdir(viewsDir, { recursive: true });
    const safe = d.sprite.name.replace(/[^\w.-]+/g, "_").slice(0, 40);
    const path = join(viewsDir, `${Date.now()}-${process.pid}-${++viewSeq}-${safe}.png`);
    await writeFile(path, out.png);
    run.images.push(path);
    return { path, width: out.width, height: out.height };
  }

  async function history(/** @type {SpriteState} */ st, action, n = 1) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${action}(n): n must be a whole number >= 1, got ${n}.`);
    if (pending(st.d).dirty) throw new Error(`${action}() would drop this program's uncommitted edits; call await s.commit() first.`);
    const id = st.d.sprite.id;
    await activate(id);
    await link.request("history", { action, steps: n });
    st.d = await snapshot(id);
    lastSeen.set(id, baseMap(st.d));
  }

  /** Cels whose pixels differ from what this daemon last saw (artist edits), as palette + rows. */
  async function changes(/** @type {SpriteState} */ st) {
    const id = st.d.sprite.id;
    const fresh = await snapshot(id);
    const before = lastSeen.get(id) ?? new Map();
    const after = baseMap(fresh);
    const { width: w, height: h } = fresh.sprite;
    const out = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const now = after.get(key) ?? null;
      const rect = diffRect(before.get(key) ?? null, now, w, h);
      if (!rect) continue;
      const { layer, frame } = parseKey(key);
      out.push({ layer, frame, rect, ...R.read({ width: w, height: h, data: now ?? new Uint8Array(w * h * 4) }, { rect }) });
    }
    lastSeen.set(id, after);
    if (!pending(st.d).dirty) st.d = fresh;
    return out.sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : a.frame - b.frame));
  }

  function spriteHandle(/** @type {Run} */ run, /** @type {SpriteState} */ st) {
    const { id, name, width, height, colorMode } = st.d.sprite;
    return {
      id,
      name,
      width,
      height,
      colorMode,
      layers: () => st.d.structure.layers.map((l) => l.path),
      frames: () => st.d.structure.durations.length,
      selection: () => st.d.sprite.selection ?? null,
      cel: (layer, frame = 0) => celHandle(run, st, layer, frame),
      cels: (layer) => {
        D.readable(st.d, layer, 0);
        return st.d.structure.durations.map((_, f) => celHandle(run, st, layer, f));
      },
      layer: (layerName, o) => void D.stageLayer(st.d, layerName, o ?? {}),
      setFrames: (count, o = {}) => {
        const layers = st.d.structure.layers.filter((l) => !l.group).length;
        const bytes = count * layers * width * height * 4;
        if (bytes > lim.draftBytes) {
          throw new Error(`setFrames(${count}): ${layers} layer(s) x ${count} frames is ${mb(bytes)} MB of pixels; the limit is ${mb(lim.draftBytes)} MB.`);
        }
        D.setFrames(st.d, count, o.duration);
      },
      tag: (tagName, from, to, o) => void D.stageTag(st.d, tagName, from, to, o ?? {}),
      view: (o) => view(run, st, o),
      commit: async (label = "checkpoint") =>
        (await commitDraft(run, st, String(label))) ?? { sprite: id, name, label: String(label), cels: 0, pixels: 0, merged: 0, lost: 0 },
      undo: (n) => history(st, "undo", n),
      redo: (n) => history(st, "redo", n),
      changes: () => changes(st),
      save: async (path) => {
        const abs = path === undefined ? undefined : await allowedPath(path);
        await commitDraft(run, st, AUTO_LABEL);
        await activate(id);
        const { result } = await link.request("save", abs === undefined ? {} : { path: abs });
        return result.saved;
      },
    };
  }

  function globals(/** @type {Run} */ run) {
    return {
      async sprite(o = {}) {
        let ref = o.id ?? o.name;
        if (o.new) {
          const [w, h] = o.new;
          if (![w, h].every((x) => Number.isInteger(x) && x >= 1 && x <= 4096)) throw new Error(`sprite({ new: [w, h] }): whole numbers 1-4096, got ${JSON.stringify(o.new)}.`);
          ref = (await link.request("new_sprite", { width: w, height: h, colorMode: o.colorMode ?? "rgb" })).result.spriteId;
        } else if (o.open !== undefined) {
          ref = (await link.request("open", { path: await allowedPath(o.open) })).result.spriteId;
        }
        const d = await snapshot(ref);
        const known = run.states.get(d.sprite.id);
        if (known) {
          if (!pending(known.d).dirty) known.d = d;
          return known.handle;
        }
        /** @type {SpriteState} */
        const st = { d };
        st.handle = spriteHandle(run, st);
        run.states.set(d.sprite.id, st);
        return st.handle;
      },
      async sprites() {
        const { result } = await link.request("sprites", {});
        return result.sprites.map(({ id, name, width, height, frames, active }) => ({ id, name, width, height, frames, active }));
      },
      ramp: (base, keys, o) => ramp(base, keys, o),
      palette: (name, colors) => (colors === undefined ? loadPalette(palettesFile, name) : savePalette(palettesFile, name, colors)),
      help: (topic) => help(topic),
    };
  }

  async function pruneViews() {
    try {
      const names = (await readdir(viewsDir)).filter((n) => n.endsWith(".png"));
      if (names.length <= KEEP_VIEWS) return;
      const files = await Promise.all(names.map(async (n) => ({ p: join(viewsDir, n), t: (await stat(join(viewsDir, n))).mtimeMs })));
      files.sort((a, b) => b.t - a.t);
      await Promise.all(files.slice(KEEP_VIEWS).map((f) => unlink(f.p).catch(() => {})));
    } catch {}
  }

  /** @returns {Promise<object>} the result envelope; never rejects */
  async function execute(code) {
    const t0 = Date.now();
    /** @type {Run} */
    const run = { states: new Map(), images: [], commits: [] };
    const done = (e) => ({ ...e, ms: Date.now() - t0 });
    let r;
    try {
      const runtime = CodeMode.make({
        tools: {},
        extensions: [Extension.make({ name: "aseprite", globals: globals(run) })],
        limits: { timeoutMs: lim.timeoutMs, maxOutputBytes: lim.maxOutputBytes, maxToolCalls: lim.maxToolCalls },
      });
      r = await Effect.runPromise(runtime.execute(code));
    } catch (err) {
      r = { ok: false, error: { kind: "ExecutionFailure", message: String(err?.message ?? err) } };
    }
    if (run.images.length) await pruneViews();
    const logs = r.logs?.length ? { logs: r.logs } : {};
    const discarded = () => {
      const list = [...run.states.values()].map((st) => ({ sprite: st.d.sprite.id, ...pending(st.d) })).filter((x) => x.dirty);
      return list.length ? { discarded: list.map(({ sprite, cels }) => ({ sprite, cels })) } : {};
    };
    if (!r.ok) {
      const { kind, message, location } = r.error;
      const error = { kind, message, ...(location && { line: location.line }) };
      return done({ ok: false, error, commit: run.commits, ...discarded(), images: run.images, ...logs });
    }
    for (const st of run.states.values()) {
      try {
        await commitDraft(run, st, AUTO_LABEL);
      } catch (err) {
        const error = { kind: "CommitFailed", message: String(err?.message ?? err) };
        return done({ ok: false, error, commit: run.commits, ...discarded(), images: run.images, ...logs });
      }
    }
    const warnings = r.warnings?.length ? { warnings: r.warnings } : {};
    return done({ ok: true, value: r.value, commit: run.commits, images: run.images, ...logs, ...warnings });
  }

  return { execute };
}
