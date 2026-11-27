// In-memory Aseprite behind the Link seam: RGB, indexed, and gray sprites, full-canvas raw sprite-mode bytes,
// one undo step per applied commit, compare-and-swap per written cel, and configurable extension version.
import type { Link, LinkReply, LinkStatus } from "../src/link.ts";
import type { Rect } from "../src/raster.ts";
import { moveCanvas } from "../src/session.ts";
import type { Op, Tag } from "../src/session.ts";
import { fromRgba, toRgba } from "../src/wire.ts";
import type { ColorMode } from "../src/wire.ts";

interface FakeLayer {
  path: string;
  visible: boolean;
  opacity: number;
  blend: string;
  group: boolean;
}

interface State {
  id: number;
  name: string;
  path: string | null;
  width: number;
  height: number;
  colorMode: ColorMode;
  transparentIndex: number;
  palette: string[];
  selection: Rect | null;
  layers: FakeLayer[];
  frames: { duration: number }[];
  tags: Tag[];
  /** Stored as raw sprite-mode bytes (4 bpp rgb, 2 bpp gray, 1 bpp indexed). */
  cels: Map<string, Uint8Array>;
  /** Optional link groups: cel key -> canonical frame number in that layer. */
  links: Map<string, number>;
}

interface Step {
  label: string;
  state: State;
}

interface Entry {
  state: State;
  undo: Step[];
  redo: Step[];
}

/** A cel write as it travels on the wire: base and next index the blob list, null means no cel. */
interface WireWrite {
  layer: string;
  frame: number;
  base: number | null;
  next: number | null;
}

interface Reply {
  result: unknown;
  blobs?: Uint8Array[];
}

export interface FakeLinkOptions {
  extension?: string;
}

export interface FakeLink extends Link {
  artist: (
    id: number,
    layer: string,
    frame: number,
    fn: (bytes: Uint8Array, width: number) => void
  ) => void;
  beforeRequest: ((cmd: string, args: object) => unknown) | null;
  log: string[];
  sprite: (id: number) => Entry;
  setExtension: (version: string) => void;
}

const bppOf = (mode: ColorMode): number => {
  if (mode === "indexed") {
    return 1;
  }
  return mode === "gray" ? 2 : 4;
};

const blankRaw = (
  s: Pick<State, "width" | "height" | "colorMode" | "transparentIndex">
): Uint8Array => {
  const bytes = new Uint8Array(s.width * s.height * bppOf(s.colorMode));
  if (s.colorMode === "indexed" && s.transparentIndex !== 0) {
    bytes.fill(s.transparentIndex);
  }
  return bytes;
};

const hasVisible = (bytes: Uint8Array, s: State): boolean => {
  if (s.colorMode === "rgb") {
    for (let i = 3; i < bytes.length; i += 4) {
      if (bytes[i] !== 0) {
        return true;
      }
    }
    return false;
  }
  if (s.colorMode === "gray") {
    for (let i = 1; i < bytes.length; i += 2) {
      if (bytes[i] !== 0) {
        return true;
      }
    }
    return false;
  }
  for (const idx of bytes) {
    if (idx !== s.transparentIndex) {
      return true;
    }
  }
  return false;
};

const clone = (s: State): State => ({
  ...s,
  cels: new Map([...s.cels].map(([k, v]) => [k, Uint8Array.from(v)])),
  frames: s.frames.map((f) => ({ ...f })),
  layers: s.layers.map((l) => ({ ...l })),
  links: new Map(s.links),
  palette: [...s.palette],
  tags: s.tags.map((t) => ({ ...t })),
});
const key = (layer: string, frame: number): string => `${layer}@${frame}`;
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);
const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

class StructureError extends Error {
  override name = "StructureError";
}

const renameLayer = (s: State, l: FakeLayer, rename: string) => {
  const from = l.path;
  const to = from.includes("/")
    ? from.slice(0, from.lastIndexOf("/") + 1) + rename
    : rename;
  for (const x of s.layers) {
    if (within(x.path, from)) {
      x.path = to + x.path.slice(from.length);
    }
  }
  for (const [k, v] of s.cels.entries().toArray()) {
    const at = k.lastIndexOf("@");
    if (!within(k.slice(0, at), from)) {
      continue;
    }
    s.cels.delete(k);
    s.cels.set(to + k.slice(from.length), v);
  }
};

const resizeState = (
  s: State,
  op: Extract<Op, { op: "canvas.resize" }>
): void => {
  const fill = s.colorMode === "indexed" ? s.transparentIndex : 0;
  for (const [k, v] of s.cels.entries().toArray()) {
    const moved = moveCanvas(
      v,
      [s.width, s.height],
      [op.width, op.height],
      [op.x, op.y],
      fill
    );
    if (hasVisible(moved, s)) {
      s.cels.set(k, moved);
    } else {
      s.cels.delete(k);
    }
  }
  s.width = op.width;
  s.height = op.height;
};

const applyOp = (s: State, op: Op) => {
  const find = (path: string): FakeLayer => {
    const l = s.layers.find((x) => x.path === path);
    if (!l) {
      throw new StructureError(`layer '${path}' does not exist`);
    }
    return l;
  };
  switch (op.op) {
    case "layer.add": {
      if (s.layers.some((x) => x.path === op.path)) {
        throw new StructureError(`layer '${op.path}' already exists`);
      }
      const at =
        op.below === undefined
          ? s.layers.length
          : s.layers.indexOf(find(op.below));
      s.layers.splice(at, 0, {
        blend: "normal",
        group: false,
        opacity: 255,
        path: op.path,
        visible: true,
      });
      return;
    }
    case "layer.set": {
      const l = find(op.path);
      if (op.visible !== undefined) {
        l.visible = op.visible;
      }
      if (op.opacity !== undefined) {
        l.opacity = op.opacity;
      }
      if (op.rename !== undefined) {
        renameLayer(s, l, op.rename);
      }
      return;
    }
    case "layer.remove": {
      find(op.path);
      s.layers = s.layers.filter((x) => !within(x.path, op.path));
      for (const k of s.cels.keys()) {
        if (within(k.slice(0, k.lastIndexOf("@")), op.path)) {
          s.cels.delete(k);
        }
      }
      return;
    }
    case "frames.set": {
      s.frames = op.durations.map((duration) => ({ duration }));
      for (const k of s.cels.keys()) {
        if (Number(k.slice(k.lastIndexOf("@") + 1)) >= op.count) {
          s.cels.delete(k);
        }
      }
      return;
    }
    case "tag.set": {
      const tag = {
        direction: op.direction,
        from: op.from,
        name: op.name,
        to: op.to,
      };
      const i = s.tags.findIndex((t) => t.name === op.name);
      if (i === -1) {
        s.tags.push(tag);
      } else {
        s.tags[i] = tag;
      }
      return;
    }
    case "palette.append": {
      s.palette.push(...op.colors);
      return;
    }
    case "canvas.resize": {
      resizeState(s, op);
      return;
    }
    default: {
      throw new Error(`unknown op ${(op as { op: string }).op}`);
    }
  }
};

export const createFakeLink = ({
  extension: initialExtension = "0.3.0",
}: FakeLinkOptions = {}): FakeLink => {
  let extension = initialExtension;
  const sprites = new Map<number, Entry>();
  let nextId = 1;
  let active: number | null = null;
  const log: string[] = [];

  const byId = (id: number): Entry => {
    const found = sprites.get(id);
    if (!found) {
      throw new Error(`No open sprite '${id}'.`);
    }
    return found;
  };

  const need = (ref?: number | string | null): Entry => {
    if (ref === undefined || ref === null) {
      if (active === null) {
        throw new Error("No active sprite.");
      }
      return byId(active);
    }
    const found = [...sprites.values()].find(
      (e) => e.state.id === ref || e.state.name === ref
    );
    if (!found) {
      throw new Error(`No open sprite '${ref}'.`);
    }
    return found;
  };

  const handlers = {
    commit(
      {
        sprite,
        label,
        ops,
        writes,
      }: {
        sprite?: number | string;
        label: string;
        ops: Op[];
        writes: WireWrite[];
      },
      blobs: Uint8Array[]
    ): Reply {
      const entry = need(sprite);
      const next = clone(entry.state);
      try {
        for (const op of ops) {
          applyOp(next, op);
        }
        for (const w of writes) {
          const l = next.layers.find((x) => x.path === w.layer);
          if (!l || l.group) {
            throw new StructureError(`layer '${w.layer}' does not exist`);
          }
          if (w.frame >= next.frames.length) {
            throw new StructureError(`frame ${w.frame} does not exist`);
          }
        }
      } catch (error) {
        if (error instanceof StructureError) {
          return {
            result: {
              applied: false,
              message: error.message,
              reason: "structure",
            },
          };
        }
        throw error;
      }
      const blank = blankRaw(next);
      const conflicts: { write: number; blob?: number }[] = [];
      const current: Uint8Array[] = [];
      for (const [i, w] of writes.entries()) {
        const cur = next.cels.get(key(w.layer, w.frame)) ?? null;
        const base = w.base === null ? null : blobs[w.base];
        if (!equal(cur ?? blank, base ?? blank)) {
          conflicts.push({
            write: i,
            ...(cur && { blob: current.push(Uint8Array.from(cur)) - 1 }),
          });
        }
      }
      if (conflicts.length) {
        return {
          blobs: current,
          result: { applied: false, conflicts, reason: "conflict" },
        };
      }
      for (const w of writes) {
        const k = key(w.layer, w.frame);
        if (w.next === null) {
          next.cels.delete(k);
        } else {
          next.cels.set(k, Uint8Array.from(blobs[w.next]));
        }
      }
      entry.undo.push({ label: `MCP: ${label}`, state: entry.state });
      entry.redo = [];
      entry.state = next;
      return { result: { applied: true, cels: writes.length, label } };
    },
    history({
      action,
      sprite,
      steps = 1,
    }: {
      action: "undo" | "redo";
      sprite?: number | string;
      steps?: number;
    }): Reply {
      const entry = need(sprite);
      if (sprite !== undefined) {
        active = entry.state.id;
      }
      for (let i = 0; i < steps; i += 1) {
        const [from, to] =
          action === "undo"
            ? [entry.undo, entry.redo]
            : [entry.redo, entry.undo];
        const step = from.pop();
        if (!step) {
          break;
        }
        to.push({ label: step.label, state: entry.state });
        entry.state = step.state;
      }
      return { result: { done: action, steps } };
    },
    new_sprite({
      width,
      height,
      colorMode = "rgb",
    }: {
      width: number;
      height: number;
      colorMode?: ColorMode;
    }): Reply {
      const id = nextId;
      nextId += 1;
      const state: State = {
        cels: new Map(),
        colorMode,
        frames: [{ duration: 100 }],
        height,
        id,
        layers: [
          {
            blend: "normal",
            group: false,
            opacity: 255,
            path: "Layer 1",
            visible: true,
          },
        ],
        links: new Map(),
        name: `Sprite-${id}`,
        palette: colorMode === "indexed" ? ["#00000000"] : [],
        path: null,
        selection: null,
        tags: [],
        transparentIndex: 0,
        width,
      };
      sprites.set(id, { redo: [], state, undo: [] });
      active = id;
      return {
        result: { height, name: state.name, sprite: true, spriteId: id, width },
      };
    },
    open({ path }: { path: string }): Reply {
      throw new Error(`File not found: ${path}`);
    },
    save({ path, sprite }: { path?: string; sprite?: number | string }): Reply {
      const { state } = need(sprite);
      const saved = path ?? state.path;
      if (!saved) {
        throw new Error("Sprite has no file name yet - please pass a path.");
      }
      state.path = saved;
      return { result: { copy: false, saved } };
    },
    snapshot({ sprite }: { sprite?: number | string }): Reply {
      const { state: s } = need(sprite);
      const blobs: Uint8Array[] = [];
      const cels = [];
      for (const [k, bytes] of s.cels) {
        const at = k.lastIndexOf("@");
        const linkFrame = s.links.get(k);
        cels.push({
          blob: blobs.length,
          frame: Number(k.slice(at + 1)),
          layer: k.slice(0, at),
          ...(linkFrame !== undefined && { link: linkFrame }),
        });
        blobs.push(Uint8Array.from(bytes));
      }
      const { id, name, path, width, height, colorMode, transparentIndex } = s;
      const result = {
        cels,
        frames: s.frames.map((f) => ({ ...f })),
        layers: s.layers.map((l) => ({ ...l })),
        palette: [...s.palette],
        sprite: {
          colorMode,
          height,
          id,
          name,
          transparentIndex,
          width,
          ...(path && { path }),
        },
        tags: s.tags.map((t) => ({ ...t })),
        ...(s.selection && { selection: s.selection }),
      };
      return { blobs, result };
    },
    sprites({ select }: { select?: number | string } = {}): Reply {
      if (select !== undefined) {
        active = need(select).state.id;
      }
      const list = [...sprites.values()].map(({ state: s }) => ({
        active: s.id === active,
        frames: s.frames.length,
        height: s.height,
        id: s.id,
        name: s.name,
        width: s.width,
      }));
      return { result: { active, sprites: list } };
    },
  };

  const link: FakeLink = {
    /** An artist edit outside any program: mutates RGBA view and stores back in the sprite's color mode. */
    artist(id, layer, frame, fn) {
      const entry = byId(id);
      const next = clone(entry.state);
      const k = key(layer, frame);
      const existing = next.cels.get(k);
      const rgba = existing
        ? toRgba(existing, next.colorMode, next.palette, next.transparentIndex)
        : new Uint8Array(next.width * next.height * 4);
      fn(rgba, next.width);
      const encoded = fromRgba(
        rgba,
        next.colorMode,
        next.palette,
        next.transparentIndex
      );
      if (next.colorMode === "indexed" && encoded.missing.length) {
        next.palette.push(...encoded.missing);
        next.cels.set(
          k,
          fromRgba(rgba, "indexed", next.palette, next.transparentIndex).bytes
        );
      } else {
        next.cels.set(k, encoded.bytes);
      }
      entry.undo.push({ label: "artist", state: entry.state });
      entry.state = next;
    },
    beforeRequest: null,
    log,
    async request<T = unknown>(
      cmd: string,
      args: object = {},
      blobs: Uint8Array[] = []
    ): Promise<LinkReply<T>> {
      log.push(cmd);
      if (link.beforeRequest) {
        await link.beforeRequest(cmd, args);
      }
      if (!Object.hasOwn(handlers, cmd)) {
        throw new Error(`Unknown command '${cmd}'.`);
      }
      const h = handlers[cmd as keyof typeof handlers] as (
        a: never,
        b: Uint8Array[]
      ) => Reply;
      const { result, blobs: out = [] } = h(
        structuredClone(args) as never,
        blobs
      );
      return { blobs: out, result: result as T };
    },
    setExtension(version: string) {
      extension = version;
    },
    sprite: byId,
    status: (): LinkStatus => ({
      connected: true,
      error: null,
      extension,
      port: 9123,
    }),
  };
  return link;
};

/** RGBA of pixel (x, y) in a full-canvas RGB buffer, or null when the cel does not exist. */
export const pixel = (
  bytes: Uint8Array | null | undefined,
  width: number,
  x: number,
  y: number
): [number, number, number, number] | null => {
  if (!bytes) {
    return null;
  }
  const i = (y * width + x) * 4;
  return [
    bytes[i] ?? 0,
    bytes[i + 1] ?? 0,
    bytes[i + 2] ?? 0,
    bytes[i + 3] ?? 0,
  ];
};
