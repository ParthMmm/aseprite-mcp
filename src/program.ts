// The code-mode runtime: one execute() runs one agent program against a SpriteSession, then commits what is
// left as one undo step per sprite. Globals: sprite, sprites, image, ramp, palette, lib, use, help. Handles are plain objects of
// closures; mutable state is behind methods because psychoscript copies plain fields once at the boundary.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath from "node:path";

import { Runtime } from "psychoscript";
import type { Diagnostic } from "psychoscript";

import { messageOf } from "./check.ts";
import { decodePng } from "./codecs.ts";
import { loadPalette, ramp, savePalette } from "./color.ts";
import { insideAllowedDir } from "./files.ts";
import { help } from "./help.ts";
import { listLibs, mapError, prepare, readLib, saveLib } from "./library.ts";
import type { MappedError, Prepared } from "./library.ts";
import type { Link } from "./link.ts";
import * as R from "./raster.ts";
import { buildSpriteExport, renderSpriteView } from "./render.ts";
import { createSpriteStore } from "./session.ts";
import type {
  ArtistChange,
  CommitInfo,
  DiscardedSprite,
  LayerOptions,
  SpriteDraft,
  SpriteSession,
  SpriteSummary,
  TagDirection,
} from "./session.ts";
import type { ColorMode } from "./wire.ts";

export { DESCRIPTION } from "./help.ts";
export type { ArtistChange, CommitInfo } from "./session.ts";

export interface Limits {
  draftBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface RuntimeOptions {
  link: Link;
  viewsDir: string;
  palettesFile: string;
  /** Where bare names such as "slime" are saved and opened; null disables bare names. */
  spritesDir?: string | null;
  /** Where lib() saves helper code; null turns lib() and use() off. */
  libDir?: string | null;
  allowedDirs?: string[];
  limits?: Partial<Limits>;
}

/** A rect, or "selection" for the artist's selection. */
type RectArg = R.Rect | "selection";
type WithRect<O> = Omit<O, "rect"> & { rect?: RectArg };

/**
 * What a program passes as `from` to copy(): a CelHandle, an ImageHandle, { layer, frame?, sprite? }, or { image }.
 * With translate.functions = "drop", handles cross as their plain data fields.
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
  bounds: () => R.Rect | null;
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
  background?: string;
}

export interface ViewResult {
  path: string;
  width: number;
  height: number;
}

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
  layer: (name: string, o?: LayerOptions) => void;
  layers: () => string[];
  redo: (n?: number) => Promise<void>;
  resize: (
    width: number,
    height: number,
    o?: { x?: number; y?: number }
  ) => SpriteHandle;
  save: (path?: unknown) => Promise<unknown>;
  selection: () => R.Rect | null;
  setFrames: (count: number, o?: { duration?: unknown }) => void;
  tag: (
    name: string,
    from: number,
    to: number,
    o?: { direction?: TagDirection }
  ) => void;
  undo: (n?: number) => Promise<void>;
  view: (o?: ViewOptions) => Promise<ViewResult>;
}

interface Run {
  session: SpriteSession;
  handles: Map<number, SpriteHandle>;
  /** Pictures loaded by image() in this run, indexed by ImageHandle.image. */
  loaded: R.Canvas[];
  images: string[];
  /** "map on \"body\"@0" -> opaque pixels dropped outside the canvas and the canvas size then. */
  clips: Map<string, { pixels: number; size: string }>;
  /** Libraries prepended to this run's program. */
  libraries: Set<string>;
}

export interface SpriteOptions {
  new?: [w: number, h: number];
  colorMode?: ColorMode;
  open?: unknown;
  id?: number;
  name?: string;
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
  /** Runtime diagnostics, then one line per drawing call that dropped pixels outside the canvas. */
  warnings?: readonly (Diagnostic | string)[];
}
export interface ExecuteFailure extends EnvelopeBase {
  ok: false;
  /** line is in the program, or in `library` when the error is inside a used library. */
  error: MappedError;
  discarded?: DiscardedSprite[];
}
/** What execute() hands back to the agent; it never rejects. */
export type ExecuteResult = ExecuteSuccess | ExecuteFailure;

export const DEFAULT_LIMITS: Limits = {
  draftBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64_000,
  timeoutMs: 60_000,
};

const noteClip = (
  run: Run,
  call: string,
  pixels: number,
  draft: SpriteDraft
): void => {
  const seen = run.clips.get(call);
  run.clips.set(call, {
    pixels: (seen?.pixels ?? 0) + pixels,
    size: `${draft.width}x${draft.height}`,
  });
};

const selectionRect = (draft: SpriteDraft): R.Rect => {
  const sel = draft.selection;
  if (!sel) {
    throw new Error(
      `No selection in '${draft.name}'; pass a rect [x, y, w, h] instead.`
    );
  }
  return sel;
};
const rectOf = (draft: SpriteDraft, r: RectArg): R.Rect =>
  r === "selection" ? selectionRect(draft) : r;
const rectIn = (
  draft: SpriteDraft,
  o?: { rect?: RectArg }
): R.Rect | undefined =>
  o?.rect === undefined ? undefined : rectOf(draft, o.rect);

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

const celHandle = (
  run: Run,
  draft: SpriteDraft,
  layer: string,
  frame: number
): CelHandle => {
  draft.readable(layer, frame);
  const canvas = (data: Uint8Array): R.Canvas => ({
    data,
    height: draft.height,
    width: draft.width,
  });
  const cv = () => canvas(draft.writable(layer, frame));
  const ro = () => canvas(draft.readable(layer, frame));
  const draw = (method: string, fn: (c: R.Canvas) => number): number => {
    const c = cv();
    const n = fn(c);
    if (c.clipped) {
      noteClip(
        run,
        `${method} on ${JSON.stringify(layer)}@${frame}`,
        c.clipped,
        draft
      );
    }
    return n;
  };
  return {
    bounds: () => draft.bounds(layer, frame),
    clear: (r) => R.clear(cv(), r === undefined ? undefined : rectOf(draft, r)),
    copy: (from, o) => {
      if (from?.image !== undefined) {
        const picture = run.loaded[from.image];
        const rect = o?.rect;
        if (!picture || rect === "selection") {
          throw new Error(
            "copy: pass an image handle from image(path) (or { image: img.image }); rect is [x, y, w, h] in the image."
          );
        }
        return draw("copy", (c) => R.copy(c, picture, { ...o, rect }));
      }
      const src =
        from?.sprite === undefined ? draft : run.session.get(from.sprite);
      if (!src || typeof from?.layer !== "string") {
        throw new Error(
          "copy: pass a cel handle, { layer, frame } (add sprite: id for another sprite), or an image handle."
        );
      }
      const data = src.readable(from.layer, from.frame ?? 0);
      return draw("copy", (c) =>
        R.copy(
          c,
          { data, height: src.height, width: src.width },
          { ...o, rect: rectIn(src, o) }
        )
      );
    },
    ellipse: (r, color, o) =>
      draw("ellipse", (c) => R.ellipse(c, rectOf(draft, r), color, o)),
    fill: (x, y, color) => R.fill(cv(), x, y, color),
    frame,
    layer,
    line: (x0, y0, x1, y1, color) =>
      draw("line", (c) => R.line(c, x0, y0, x1, y1, color)),
    map: (palette, rows, o) => {
      checkMap(palette, rows);
      return draw("map", (c) => R.map(c, palette, rows, o));
    },
    outline: (color, o) => {
      const [col, opts] =
        color && typeof color === "object" ? [undefined, color] : [color, o];
      return draw("outline", (c) =>
        R.outline(c, col, { ...opts, rect: rectIn(draft, opts) })
      );
    },
    px: (points) => draw("px", (c) => R.px(c, points)),
    read: (o) => R.read(ro(), { ...o, rect: rectIn(draft, o) }),
    recolor: (mapping, o) =>
      R.recolor(cv(), mapping, { ...o, rect: rectIn(draft, o) }),
    rect: (r, color, o) =>
      draw("rect", (c) => R.rect(c, rectOf(draft, r), color, o)),
    shift: (dx, dy, o) =>
      draw("shift", (c) =>
        R.shift(c, dx, dy, { ...o, rect: rectIn(draft, o) })
      ),
    sprite: draft.id,
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
  libDir = null,
  allowedDirs = [],
  limits = {},
}: RuntimeOptions): {
  execute: (
    code: string,
    options?: { signal?: AbortSignal }
  ) => Promise<ExecuteResult>;
} => {
  const lim: Limits = { ...DEFAULT_LIMITS, ...limits };
  const store = createSpriteStore({ draftBytes: lim.draftBytes, link });
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

  const view = async (
    run: Run,
    draft: SpriteDraft,
    o: ViewOptions = {}
  ): Promise<ViewResult> => {
    const n = draft.frames();
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
    const r = o.rect === undefined ? null : rectOf(draft, o.rect);
    const pics = frames.map((f) =>
      r ? R.crop(draft.flatten(f), r) : draft.flatten(f)
    );
    const out = renderSpriteView(pics, {
      background: o.background,
      critique: o.critique,
      scale: o.scale,
    });
    await mkdir(viewsDir, { recursive: true });
    const safe = draft.name.replaceAll(/[^\w.-]+/gu, "_").slice(0, 40);
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
    draft: SpriteDraft,
    nameOrPath: unknown,
    o: ExportOptions = {}
  ): Promise<ExportResult> => {
    if (typeof nameOrPath !== "string" || !nameOrPath) {
      throw new Error(
        'export: pass a name such as "slime" or an absolute path.'
      );
    }
    const { sheet = true, gif = false } = o;
    const base = nameOrPath.slice(
      0,
      nameOrPath.length - nodePath.extname(nameOrPath).length
    );
    const pathFor = (ext: string) => allowedPath(`${base}${ext}`);
    const [jsonPath, pngPath, gifPath] = await Promise.all([
      sheet ? pathFor(".json") : null,
      sheet ? pathFor(".png") : null,
      gif ? pathFor(".gif") : null,
    ]);
    await draft.commit("program");
    const frames = Array.from({ length: draft.frames() }, (_, f) =>
      draft.flatten(f)
    );
    const built = buildSpriteExport({
      columns: o.columns,
      durations: draft.durations,
      frames,
      gif,
      scale: o.scale,
      sheet,
      sheetImageName: pngPath ? nodePath.basename(pngPath) : undefined,
      tag: o.tag,
      tags: draft.tags,
    });
    const files: [string, Buffer | string][] = [];
    const out: ExportResult = {
      frames: built.frames,
      height: built.height,
      width: built.width,
    };
    if (pngPath && jsonPath && built.sheetPng && built.sheetJson) {
      out.sheet = pngPath;
      out.json = jsonPath;
      files.push([pngPath, built.sheetPng], [jsonPath, built.sheetJson]);
    }
    if (gifPath && built.gif) {
      out.gif = gifPath;
      files.push([gifPath, built.gif]);
    }
    await Promise.all(files.map(([abs, body]) => writeFile(abs, body)));
    return out;
  };

  const spriteHandle = (run: Run, draft: SpriteDraft): SpriteHandle => {
    const { id, name, width, height, colorMode } = draft;
    return {
      cel: (layer, frame = 0) => celHandle(run, draft, layer, frame),
      cels: (layer) => {
        draft.readable(layer, 0);
        return Array.from({ length: draft.frames() }, (_, f) =>
          celHandle(run, draft, layer, f)
        );
      },
      changes: () => draft.changes(),
      colorMode,
      commit: (label = "checkpoint") => draft.commit(String(label)),
      export: (nameOrPath, o) => exportSprite(draft, nameOrPath, o),
      frames: () => draft.frames(),
      height,
      id,
      layer: (layerName, o) => {
        draft.layer(layerName, o ?? {});
      },
      layers: () => draft.layers(),
      name,
      redo: (n) => draft.redo(n),
      resize: (w, h, o) => {
        for (const [layer, frame, pixels] of draft.resize(w, h, o ?? {})) {
          noteClip(
            run,
            `resize on ${JSON.stringify(layer)}@${frame}`,
            pixels,
            draft
          );
        }
        // Handles copy width and height once, so the new size needs a new handle.
        const fresh = spriteHandle(run, draft);
        run.handles.set(draft.id, fresh);
        return fresh;
      },
      save: async (path) => {
        const abs = path === undefined ? undefined : await allowedPath(path);
        return draft.save(abs);
      },
      selection: () => draft.selection,
      setFrames: (count, o = {}) => {
        draft.setFrames(count, o.duration);
      },
      tag: (tagName, from, to, o) => {
        draft.tag(tagName, from, to, o ?? {});
      },
      undo: (n) => draft.undo(n),
      view: (o) => view(run, draft, o),
      width,
    };
  };

  const libs = (): string => {
    if (libDir === null) {
      throw new Error("lib: saved libraries are turned off in this daemon.");
    }
    return libDir;
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
    lib(name?: unknown, code?: unknown): Promise<unknown> {
      if (name === undefined) {
        return listLibs(libs());
      }
      return code === undefined
        ? readLib(libs(), name)
        : saveLib(libs(), name, code);
    },
    palette: (name: string, colors?: Record<string, string>) =>
      colors === undefined
        ? loadPalette(palettesFile, name)
        : savePalette(palettesFile, name, colors),
    ramp: (base: string, keys: string, o?: { hueShift?: number }) =>
      ramp(base, keys, o),
    async sprite(o: SpriteOptions = {}): Promise<SpriteHandle> {
      const openPath =
        o.open === undefined ? undefined : await allowedPath(o.open);
      const draft = await run.session.open({
        colorMode: o.colorMode,
        id: o.id,
        name: o.name,
        new: o.new,
        openPath,
      });
      const existing = run.handles.get(draft.id);
      if (existing) {
        return existing;
      }
      const handle = spriteHandle(run, draft);
      run.handles.set(draft.id, handle);
      return handle;
    },
    sprites: (): Promise<SpriteSummary[]> => store.list(),
    use(name?: unknown): void {
      if (typeof name !== "string" || !run.libraries.has(name)) {
        throw new Error(
          `use(${JSON.stringify(name)}): write use("name") as its own top-level statement with a string literal; a library saved by this program is usable from the next one.`
        );
      }
    },
  });

  const execute = async (
    code: string,
    options?: { signal?: AbortSignal }
  ): Promise<ExecuteResult> => {
    const t0 = Date.now();
    const run: Run = {
      clips: new Map(),
      handles: new Map(),
      images: [],
      libraries: new Set(),
      loaded: [],
      session: store.openSession(),
    };
    const done = <E extends object>(e: E) => ({ ...e, ms: Date.now() - t0 });
    let prepared: Prepared;
    try {
      prepared = await prepare(libDir, code);
    } catch (error) {
      return done({
        commit: [],
        error: { kind: "LibraryError", message: messageOf(error) },
        images: [],
        ok: false as const,
      });
    }
    run.libraries = new Set(prepared.libraries);
    let r: Runtime.Result;
    try {
      const runtime = Runtime.make({
        globals: () => globals(run),
        limits: {
          maxOutputBytes: lim.maxOutputBytes,
          timeoutMs: lim.timeoutMs,
        },
        translate: { functions: "drop" },
      });
      r = await runtime.execute(prepared.code, { signal: options?.signal });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      r = {
        error: {
          kind: aborted ? "Aborted" : "ExecutionFailure",
          message: aborted
            ? `Execution aborted${error.cause ? `: ${messageOf(error.cause)}` : "."}`
            : messageOf(error),
        },
        metadata: null,
        ok: false,
      };
    }
    const logs = r.logs?.length ? { logs: r.logs } : {};
    const discarded = (): { discarded?: DiscardedSprite[] } => {
      const list = run.session.discarded();
      return list.length ? { discarded: list } : {};
    };
    if (!r.ok) {
      return done({
        commit: [...run.session.commits],
        error: mapError(prepared, r.error),
        ok: false as const,
        ...discarded(),
        images: run.images,
        ...logs,
      });
    }
    if (options?.signal?.aborted) {
      return done({
        commit: [...run.session.commits],
        error: { kind: "Aborted", message: "Execution aborted." },
        ok: false as const,
        ...discarded(),
        images: run.images,
        ...logs,
      });
    }
    try {
      await run.session.commitAll();
    } catch (error) {
      return done({
        commit: [...run.session.commits],
        error: { kind: "CommitFailed", message: messageOf(error) },
        ok: false as const,
        ...discarded(),
        images: run.images,
        ...logs,
      });
    }
    const clipped = [...run.clips].map(
      ([call, { pixels, size }]) =>
        `${call} dropped ${pixels} pixel${pixels === 1 ? "" : "s"} outside the ${size} canvas`
    );
    const all = [...(r.warnings ?? []), ...clipped];
    const warnings = all.length ? { warnings: all } : {};
    return done({
      commit: [...run.session.commits],
      images: run.images,
      ok: true as const,
      value: r.value,
      ...logs,
      ...warnings,
    });
  };

  return { execute };
};
