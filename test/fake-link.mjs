// In-memory Aseprite behind the Link interface: RGB sprites only, full-canvas cel bytes, one undo step per
// applied commit, compare-and-swap per written cel. Enough for program.test.mjs; the real Lua is in extension/.

const clone = (s) => ({
  ...s,
  palette: [...s.palette],
  layers: s.layers.map((l) => ({ ...l })),
  frames: s.frames.map((f) => ({ ...f })),
  tags: s.tags.map((t) => ({ ...t })),
  cels: new Map([...s.cels].map(([k, v]) => [k, v.slice()])),
});
const key = (layer, frame) => `${layer}@${frame}`;
const within = (path, root) => path === root || path.startsWith(root + "/");
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

class StructureError extends Error {}

export function createFakeLink() {
  const sprites = new Map();
  let nextId = 1;
  let active = null;
  const log = [];

  const need = (ref) => {
    if (ref === undefined || ref === null) {
      if (active === null) throw new Error("No active sprite.");
      return sprites.get(active);
    }
    const found = [...sprites.values()].find((e) => e.state.id === ref || e.state.name === ref);
    if (!found) throw new Error(`No open sprite '${ref}'.`);
    return found;
  };

  function applyOp(s, op) {
    const find = (path) => {
      const l = s.layers.find((x) => x.path === path);
      if (!l) throw new StructureError(`layer '${path}' does not exist`);
      return l;
    };
    switch (op.op) {
      case "layer.add": {
        if (s.layers.some((x) => x.path === op.path)) throw new StructureError(`layer '${op.path}' already exists`);
        const at = op.below === undefined ? s.layers.length : s.layers.indexOf(find(op.below));
        s.layers.splice(at, 0, { path: op.path, visible: true, opacity: 255, blend: "normal", group: false });
        return;
      }
      case "layer.set": {
        const l = find(op.path);
        if (op.visible !== undefined) l.visible = op.visible;
        if (op.opacity !== undefined) l.opacity = op.opacity;
        if (op.rename !== undefined) {
          const from = l.path;
          const to = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) + op.rename : op.rename;
          for (const x of s.layers) if (within(x.path, from)) x.path = to + x.path.slice(from.length);
          for (const [k, v] of [...s.cels]) {
            const at = k.lastIndexOf("@");
            if (!within(k.slice(0, at), from)) continue;
            s.cels.delete(k);
            s.cels.set(to + k.slice(from.length), v);
          }
        }
        return;
      }
      case "layer.remove": {
        find(op.path);
        s.layers = s.layers.filter((x) => !within(x.path, op.path));
        for (const k of [...s.cels.keys()]) if (within(k.slice(0, k.lastIndexOf("@")), op.path)) s.cels.delete(k);
        return;
      }
      case "frames.set": {
        s.frames = op.durations.map((duration) => ({ duration }));
        for (const k of [...s.cels.keys()]) if (Number(k.slice(k.lastIndexOf("@") + 1)) >= op.count) s.cels.delete(k);
        return;
      }
      case "tag.set": {
        const tag = { name: op.name, from: op.from, to: op.to, direction: op.direction };
        const i = s.tags.findIndex((t) => t.name === op.name);
        if (i >= 0) s.tags[i] = tag;
        else s.tags.push(tag);
        return;
      }
      case "palette.append":
        s.palette.push(...op.colors);
        return;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }

  const handlers = {
    new_sprite({ width, height, colorMode = "rgb" }) {
      if (colorMode !== "rgb") throw new Error("fake link: rgb sprites only");
      const id = nextId;
      nextId += 1;
      const state = {
        id, name: `Sprite-${id}`, path: null, width, height, colorMode, transparentIndex: 0, palette: [], selection: null,
        layers: [{ path: "Layer 1", visible: true, opacity: 255, blend: "normal", group: false }],
        frames: [{ duration: 100 }], tags: [], cels: new Map(),
      };
      sprites.set(id, { state, undo: [], redo: [] });
      active = id;
      return { result: { sprite: true, spriteId: id, name: state.name, width, height } };
    },
    snapshot({ sprite }) {
      const { state: s } = need(sprite);
      const blobs = [];
      const cels = [];
      for (const [k, bytes] of s.cels) {
        const at = k.lastIndexOf("@");
        cels.push({ layer: k.slice(0, at), frame: Number(k.slice(at + 1)), blob: blobs.length });
        blobs.push(bytes.slice());
      }
      const { id, name, path, width, height, colorMode, transparentIndex } = s;
      const result = {
        sprite: { id, name, width, height, colorMode, transparentIndex, ...(path && { path }) },
        palette: [...s.palette], layers: s.layers.map((l) => ({ ...l })), frames: s.frames.map((f) => ({ ...f })),
        tags: s.tags.map((t) => ({ ...t })), cels, ...(s.selection && { selection: s.selection }),
      };
      return { result, blobs };
    },
    commit({ sprite, label, ops, writes }, blobs) {
      const entry = need(sprite);
      const next = clone(entry.state);
      try {
        for (const op of ops) applyOp(next, op);
        for (const w of writes) {
          const l = next.layers.find((x) => x.path === w.layer);
          if (!l || l.group) throw new StructureError(`layer '${w.layer}' does not exist`);
          if (w.frame >= next.frames.length) throw new StructureError(`frame ${w.frame} does not exist`);
        }
      } catch (err) {
        if (err instanceof StructureError) return { result: { applied: false, reason: "structure", message: err.message } };
        throw err;
      }
      const blank = new Uint8Array(next.width * next.height * 4);
      const conflicts = [];
      const current = [];
      writes.forEach((w, i) => {
        const cur = next.cels.get(key(w.layer, w.frame)) ?? null;
        const base = w.base === null ? null : blobs[w.base];
        if (!equal(cur ?? blank, base ?? blank)) {
          conflicts.push({ write: i, ...(cur && { blob: current.push(cur.slice()) - 1 }) });
        }
      });
      if (conflicts.length) return { result: { applied: false, reason: "conflict", conflicts }, blobs: current };
      for (const w of writes) {
        if (w.next === null) next.cels.delete(key(w.layer, w.frame));
        else next.cels.set(key(w.layer, w.frame), blobs[w.next].slice());
      }
      entry.undo.push({ label: `MCP: ${label}`, state: entry.state });
      entry.redo = [];
      entry.state = next;
      return { result: { applied: true, label, cels: writes.length } };
    },
    history({ action, steps = 1 }) {
      const entry = need();
      for (let i = 0; i < steps; i++) {
        const [from, to] = action === "undo" ? [entry.undo, entry.redo] : [entry.redo, entry.undo];
        const step = from.pop();
        if (!step) break;
        to.push({ label: step.label, state: entry.state });
        entry.state = step.state;
      }
      return { result: { done: action, steps } };
    },
    sprites({ select } = {}) {
      if (select !== undefined) active = need(select).state.id;
      const list = [...sprites.values()].map(({ state: s }) => ({
        id: s.id, name: s.name, width: s.width, height: s.height, frames: s.frames.length, active: s.id === active,
      }));
      return { result: { sprites: list, active } };
    },
    save({ path }) {
      const { state } = need();
      const saved = path ?? state.path;
      if (!saved) throw new Error("Sprite has no file name yet - please pass a path.");
      state.path = saved;
      return { result: { saved, copy: false } };
    },
    open({ path }) {
      throw new Error(`File not found: ${path}`);
    },
  };

  const link = {
    /** Called before each request is handled; tests use it to inject an artist edit. */
    beforeRequest: null,
    async request(cmd, args = {}, blobs = []) {
      log.push(cmd);
      if (link.beforeRequest) await link.beforeRequest(cmd, args);
      const h = handlers[cmd];
      if (!h) throw new Error(`Unknown command '${cmd}'.`);
      const { result, blobs: out = [] } = h(structuredClone(args), blobs);
      return { result, blobs: out };
    },
    status: () => ({ connected: true, extension: "0.1.0", port: 9123, error: null }),
    /** test helpers */
    log,
    sprite: (id) => sprites.get(id),
    /** An artist edit outside any program: changes the cel and records its own undo step. */
    artist(id, layer, frame, fn) {
      const entry = sprites.get(id);
      const next = clone(entry.state);
      const k = key(layer, frame);
      const bytes = next.cels.get(k) ?? new Uint8Array(next.width * next.height * 4);
      fn(bytes, next.width);
      next.cels.set(k, bytes);
      entry.undo.push({ label: "artist", state: entry.state });
      entry.state = next;
    },
  };
  return link;
}

/** RGBA of pixel (x, y) in a full-canvas buffer, or null when the cel does not exist. */
export function pixel(bytes, width, x, y) {
  if (!bytes) return null;
  const i = (y * width + x) * 4;
  return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]];
}
