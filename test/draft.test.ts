import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fromSnapshot,
  writable,
  readable,
  setFrames,
  stageLayer,
  stageTag,
  plan,
  merge3,
  resolveConflict,
  rebase,
} from "../src/draft.ts";
import type { ColorMode } from "../src/wire.ts";

const T = [0, 0, 0, 0];
const R = [255, 0, 0, 255];
const G = [0, 255, 0, 255];
const B = [0, 0, 255, 255];
const K = [0, 0, 0, 255];
const cel = (...pixels: number[][]) => new Uint8Array(pixels.flat());
const pixels = (buf: Uint8Array | null) => {
  assert.ok(buf, "cel bytes exist");
  return Array.from({ length: buf.length / 4 }, (_, i) => [
    ...buf.subarray(i * 4, i * 4 + 4),
  ]);
};

/** 2x1 sprite: layers bg, fx (group), fx/glow; 2 frames; bg@0 and bg@1 linked; fx/glow@0. */
function snapshot({
  colorMode = "rgb",
  palette = ["#00000000"],
}: { colorMode?: ColorMode; palette?: string[] } = {}) {
  const reply = {
    cels: [
      { blob: 0, frame: 0, layer: "bg", link: 0 },
      { blob: 0, frame: 1, layer: "bg", link: 0 },
      { blob: 1, frame: 0, layer: "fx/glow", link: null },
    ],
    frames: [{ duration: 0.1 }, { duration: 0.1 }],
    layers: [
      {
        blend: "normal",
        group: false,
        opacity: 255,
        path: "bg",
        visible: true,
      },
      { blend: "normal", group: true, opacity: 255, path: "fx", visible: true },
      {
        blend: "normal",
        group: false,
        opacity: 200,
        path: "fx/glow",
        visible: true,
      },
    ],
    palette,
    selection: null,
    sprite: {
      colorMode,
      height: 1,
      id: 1,
      name: "s",
      path: null,
      transparentIndex: 0,
      width: 2,
    },
    tags: [],
  };
  return fromSnapshot(reply, [cel(R, T), cel(T, G)]);
}

test("fromSnapshot shares one buffer between linked cels", () => {
  const d = snapshot();
  writable(d, "bg", 1).set(B, 4);
  assert.deepEqual(pixels(readable(d, "bg", 0)), [R, B]);
  assert.deepEqual(
    d.structure.layers.map((l) => l.path),
    ["bg", "fx", "fx/glow"]
  );
});

test("readable never creates a cel; empty cels read as transparent", () => {
  const d = snapshot();
  assert.deepEqual(pixels(readable(d, "fx/glow", 1)), [T, T]);
  assert.equal(d.cels.has("fx/glow@1"), false);
});

test("unknown layers, group layers and missing frames throw program-facing errors", () => {
  const d = snapshot();
  assert.throws(
    () => writable(d, "body", 0),
    /Unknown layer 'body'. Layers: bg, fx, fx\/glow/u
  );
  assert.throws(() => writable(d, "fx", 0), /'fx' is a group layer/u);
  assert.throws(
    () => readable(d, "bg", 2),
    /Frame 2 does not exist; the sprite has 2 frames \(0-1\)/u
  );
});

test("plan lists only changed cels, once per linked group", () => {
  const d = snapshot();
  writable(d, "fx/glow", 0);
  const g = writable(d, "fx/glow", 1);
  g.set(G, 0);
  g.set(T, 0);
  writable(d, "bg", 1).set(K, 4);
  const p = plan(d);
  assert.deepEqual(p.ops, []);
  assert.deepEqual(
    p.writes.map((w) => [w.key, w.layer, w.frame]),
    [["bg@0", "bg", 0]]
  );
  assert.deepEqual(pixels(p.writes[0].base), [R, T]);
  assert.deepEqual(pixels(p.writes[0].next), [R, K]);
  assert.equal(p.pixels, 1);
});

test("an all-transparent cel becomes a delete; a new cel left empty is not written", () => {
  const d = snapshot();
  writable(d, "fx/glow", 0).fill(0);
  writable(d, "fx/glow", 1);
  const p = plan(d);
  assert.deepEqual(
    p.writes.map((w) => [w.key, w.next]),
    [["fx/glow@0", null]]
  );
});

test("indexed: colours missing from the palette become one palette.append, first", () => {
  const d = snapshot({
    colorMode: "indexed",
    palette: ["#00000000", "#ff0000ff", "#00ff00ff"],
  });
  writable(d, "bg", 0).set([...B, ...B]);
  writable(d, "fx/glow", 0).set(K, 0);
  stageLayer(d, "bg", { visible: false });
  const p = plan(d);
  assert.deepEqual(p.ops[0], {
    colors: ["#0000ffff", "#000000ff"],
    op: "palette.append",
  });
  assert.equal(p.ops[1].op, "layer.set");
  assert.deepEqual(p.palette, [
    "#00000000",
    "#ff0000ff",
    "#00ff00ff",
    "#0000ffff",
    "#000000ff",
  ]);
});

test("indexed: more than 256 colours fails with a clear message", () => {
  const d = snapshot({
    colorMode: "indexed",
    palette: Array.from(
      { length: 256 },
      (_, i) => `#0000${i.toString(16).padStart(2, "0")}ff`
    ),
  });
  writable(d, "bg", 0).set([1, 2, 3, 255], 0);
  assert.throws(() => plan(d), /would need 257 colours \(max 256\)/u);
});

test("setFrames copies each layer's last frame into new frames and sets durations", () => {
  const d = snapshot();
  writable(d, "fx/glow", 1).set(B, 0);
  setFrames(d, 4);
  assert.deepEqual(d.structure.durations, [0.1, 0.1, 0.1, 0.1]);
  for (const f of [2, 3]) {
    assert.deepEqual(pixels(readable(d, "bg", f)), [R, T]);
    assert.deepEqual(pixels(readable(d, "fx/glow", f)), [B, T]);
  }
  writable(d, "bg", 3).set(G, 0);
  assert.deepEqual(
    pixels(readable(d, "bg", 2)),
    [R, T],
    "new frames are not linked to each other"
  );
  const p = plan(d);
  assert.deepEqual(p.ops, [
    { count: 4, durations: [0.1, 0.1, 0.1, 0.1], op: "frames.set" },
  ]);
  assert.deepEqual(
    p.writes.map((w) => [w.key, w.base]),
    [
      ["fx/glow@1", null],
      ["bg@2", null],
      ["fx/glow@2", null],
      ["bg@3", null],
      ["fx/glow@3", null],
    ]
  );
});

test("setFrames shrinks, takes durations, and a shrunk-then-grown frame keeps its snapshot base", () => {
  const d = snapshot();
  setFrames(d, 1, [0.25]);
  assert.throws(() => readable(d, "bg", 1), /Frame 1 does not exist/u);
  assert.deepEqual(plan(d).ops, [
    { count: 1, durations: [0.25], op: "frames.set" },
  ]);
  setFrames(d, 2, 0.1);
  const p = plan(d);
  assert.deepEqual(p.ops, []);
  assert.deepEqual(
    p.writes.map((w) => [w.key, w.base]),
    [["fx/glow@1", null]],
    "bg@1 equals its snapshot base, so only the new glow cel is written"
  );
  assert.throws(
    () => setFrames(d, 3, [0.1]),
    /durations has 1 entries for 3 frames/u
  );
});

test("layer and tag staging become ordered struct ops", () => {
  const d = snapshot();
  stageLayer(d, "bg", { opacity: 128 });
  stageLayer(d, "fx/glow", { visible: false });
  stageLayer(d, "fx", { rename: "magic" });
  stageLayer(d, "magic/glow", { rename: "shine" });
  stageLayer(d, "outline", { below: "magic/shine", visible: false });
  stageLayer(d, "top");
  stageTag(d, "walk", 0, 1, { direction: "pingpong" });
  assert.throws(() => writable(d, "fx/glow", 0), /Unknown layer 'fx\/glow'/u);
  writable(d, "magic/shine", 0).set(R, 0);
  assert.deepEqual(
    d.structure.layers.map((l) => l.path),
    ["bg", "magic", "outline", "magic/shine", "top"]
  );
  const p = plan(d);
  assert.deepEqual(p.ops, [
    { op: "layer.set", opacity: 128, path: "bg" },
    { op: "layer.set", path: "fx/glow", visible: false },
    { op: "layer.set", path: "fx/glow", rename: "shine" },
    { op: "layer.set", path: "fx", rename: "magic" },
    { below: "magic/shine", op: "layer.add", path: "outline" },
    { op: "layer.set", path: "outline", visible: false },
    { op: "layer.add", path: "top" },
    { direction: "pingpong", from: 0, name: "walk", op: "tag.set", to: 1 },
  ]);
  assert.deepEqual(
    p.writes.map((w) => w.key),
    ["magic/shine@0"]
  );
});

test("removing a group removes its children once and drops their cels", () => {
  const d = snapshot();
  writable(d, "fx/glow", 0).set(B, 0);
  stageLayer(d, "fx", { remove: true });
  const p = plan(d);
  assert.deepEqual(p.ops, [{ op: "layer.remove", path: "fx" }]);
  assert.deepEqual(p.writes, []);
  assert.throws(
    () => stageLayer(d, "nope", { remove: true }),
    /Unknown layer 'nope'/u
  );
});

test("merge3: ours where only we changed, theirs elsewhere, the artist wins conflicts", () => {
  const base = cel(R, R, R, R, R);
  const ours = cel(R, G, R, G, B);
  const theirs = cel(R, R, K, B, B);
  const { merged, kept, lost } = merge3(base, ours, theirs);
  assert.deepEqual(pixels(merged), [R, G, K, B, B]);
  assert.equal(kept, 2, "pixel 1 applied; pixel 4 matches what the artist did");
  assert.equal(lost, 1, "pixel 3 changed on both sides");
});

test("merge3 treats a missing cel as transparent on any side", () => {
  const { merged, kept, lost } = merge3(null, cel(R, T), null);
  assert.deepEqual(pixels(merged), [R, T]);
  assert.deepEqual([kept, lost], [1, 0]);
  const deleted = merge3(cel(R, R), cel(R, G), null);
  assert.deepEqual(
    pixels(deleted.merged),
    [T, T],
    "the artist deleted the cel and wins the changed pixel"
  );
  assert.equal(deleted.lost, 1);
});

test("resolveConflict merges onto the artist's bytes, which become the new base", () => {
  const d = snapshot();
  writable(d, "fx/glow", 0).set(R, 0);
  const theirs = cel(T, B);
  assert.deepEqual(resolveConflict(d, "fx/glow@0", theirs), {
    kept: 1,
    lost: 0,
  });
  const [w] = plan(d).writes;
  assert.equal(w.base, theirs);
  assert.deepEqual(pixels(w.next), [R, B]);
});

test("rebase makes the next plan empty, and a second rebase changes nothing", () => {
  const d = snapshot({
    colorMode: "indexed",
    palette: ["#00000000", "#ff0000ff", "#00ff00ff"],
  });
  writable(d, "bg", 0).set(B, 4);
  writable(d, "fx/glow", 0).fill(0);
  stageLayer(d, "new", { opacity: 10 });
  stageLayer(d, "fx/glow", { rename: "g" });
  stageTag(d, "t", 0, 0);
  setFrames(d, 3);
  const first = plan(d);
  assert.ok(first.ops.length && first.writes.length);
  rebase(d, first);
  const second = plan(d);
  assert.deepEqual([second.ops, second.writes, second.pixels], [[], [], 0]);
  assert.deepEqual(d.sprite.palette, first.palette);
  rebase(d, second);
  assert.deepEqual(plan(d).writes, []);
  assert.deepEqual(pixels(readable(d, "bg", 0)), [R, B]);
  assert.equal(d.cels.get("fx/g@0")?.base, null);
});

test("edits made after plan stay dirty through rebase", () => {
  const d = snapshot();
  const buf = writable(d, "bg", 0);
  buf.set(G, 0);
  const p = plan(d);
  buf.set(B, 4);
  rebase(d, p);
  const [w] = plan(d).writes;
  assert.deepEqual(pixels(w.base), [G, T]);
  assert.deepEqual(pixels(w.next), [G, B]);
});
