import assert from "node:assert/strict";
import { test } from "node:test";

import { createSpriteStore } from "../src/session.ts";
import { toRgba } from "../src/wire.ts";
import { createFakeLink, pixel } from "./fake-link.ts";
import type { FakeLink } from "./fake-link.ts";

const R = [255, 0, 0, 255];
const G = [0, 255, 0, 255];
const B = [0, 0, 255, 255];
const K = [0, 0, 0, 255];
const T = [0, 0, 0, 0];

const celRgba = (
  link: FakeLink,
  id: number,
  layer = "Layer 1",
  frame = 0
): Uint8Array | null => {
  const s = link.sprite(id).state;
  const raw = s.cels.get(`${layer}@${frame}`);
  return raw ? toRgba(raw, s.colorMode, s.palette, s.transparentIndex) : null;
};

const setup = (opts: { draftBytes?: number; extension?: string } = {}) => {
  const link = createFakeLink({ extension: opts.extension });
  const store = createSpriteStore({
    draftBytes: opts.draftBytes ?? 64 * 1024 * 1024,
    link,
  });
  return { link, store };
};

test("session edits commit as one undo step and rebase so a second commit is empty", async () => {
  const { link, store } = setup();
  const s1 = store.openSession();
  const d = await s1.open({ new: [4, 2] });
  d.writable("Layer 1", 0).set(R, 0);
  d.writable("Layer 1", 0).set(G, 4);
  const first = await d.commit("paint");
  assert.deepEqual(
    {
      cels: first.cels,
      label: first.label,
      lost: first.lost,
      merged: first.merged,
      pixels: first.pixels,
    },
    { cels: 1, label: "paint", lost: 0, merged: 0, pixels: 2 }
  );
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 0, 0), R);
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 1, 0), G);

  const second = await d.commit("noop");
  assert.equal(second.cels, 0);
  assert.equal(second.pixels, 0);
  assert.equal(link.sprite(d.id).undo.length, 1);
});

test("unknown layers, group layers and missing frames throw clear errors", async () => {
  const { link, store } = setup();
  const s = store.openSession();
  const d = await s.open({ new: [2, 1] });
  link.sprite(d.id).state.layers.push(
    { blend: "normal", group: true, opacity: 255, path: "fx", visible: true },
    {
      blend: "normal",
      group: false,
      opacity: 200,
      path: "fx/glow",
      visible: true,
    }
  );
  const fresh = await store.openSession().open({ id: d.id });
  assert.throws(
    () => fresh.writable("body", 0),
    /Unknown layer 'body'. Layers: Layer 1, fx, fx\/glow/u
  );
  assert.throws(() => fresh.writable("fx", 0), /'fx' is a group layer/u);
  assert.throws(
    () => fresh.readable("Layer 1", 2),
    /Frame 2 does not exist; the sprite has 1 frame \(0-0\)/u
  );
});

test("linked cels share one buffer and commit once per linked group", async () => {
  const { link, store } = setup();
  const s0 = store.openSession();
  const d0 = await s0.open({ new: [2, 1] });
  d0.setFrames(2);
  d0.writable("Layer 1", 0).set(R, 0);
  await s0.commitAll();
  const st = link.sprite(d0.id).state;
  st.cels.set("Layer 1@1", Uint8Array.from(st.cels.get("Layer 1@0") ?? []));
  st.links.set("Layer 1@0", 0);
  st.links.set("Layer 1@1", 0);

  const s1 = store.openSession();
  const d = await s1.open({ id: d0.id });
  d.writable("Layer 1", 1).set(B, 4);
  assert.deepEqual([...d.readable("Layer 1", 0).subarray(4, 8)], B);
  const info = await d.commit("linked");
  assert.equal(info.cels, 1);
  assert.equal(info.pixels, 1);
});

test("clearing all pixels deletes the cel on commit; touching an empty cel writes nothing", async () => {
  const { link, store } = setup();
  const s = store.openSession();
  const d = await s.open({ new: [2, 1] });
  d.writable("Layer 1", 0).set(R, 0);
  await d.commit("add");
  assert.ok(link.sprite(d.id).state.cels.has("Layer 1@0"));

  d.writable("Layer 1", 0).fill(0);
  const del = await d.commit("clear");
  assert.equal(del.cels, 1);
  assert.equal(link.sprite(d.id).state.cels.has("Layer 1@0"), false);

  d.writable("Layer 1", 0);
  assert.equal(s.discarded().length, 0);
});

test("indexed sprite appends missing palette colours, commits raw indices, and rejects >256 colours", async () => {
  const { link, store } = setup();
  const s = store.openSession();
  const d = await s.open({ colorMode: "indexed", new: [4, 2] });
  d.writable("Layer 1", 0).set(R, 0);
  d.writable("Layer 1", 0).set(B, 4);
  const info = await d.commit("indexed");
  assert.equal(info.pixels, 2);
  assert.deepEqual(link.sprite(d.id).state.palette, [
    "#00000000",
    "#ff0000ff",
    "#0000ffff",
  ]);
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 0, 0), R);
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 1, 0), B);

  // Fill palette to 256 colours and ensure a 257th colour fails cleanly before commit.
  const full = link.sprite(d.id).state;
  full.palette = Array.from(
    { length: 256 },
    (_, i) => `#0000${i.toString(16).padStart(2, "0")}ff`
  );
  const d2 = await store.openSession().open({ id: d.id });
  d2.writable("Layer 1", 0).set([1, 2, 3, 255], 8);
  await assert.rejects(
    () => d2.commit("overflow"),
    /would need 257 colours \(max 256\)/u
  );
});

test("indexed and gray sprites keep CAS aligned across resize and commit", async () => {
  await Promise.all(
    (["indexed", "gray"] as const).map(async (colorMode) => {
      const { link, store } = setup();
      const s = store.openSession();
      const d = await s.open({ colorMode, new: [4, 4] });
      d.writable("Layer 1", 0).set(
        colorMode === "gray" ? [128, 128, 128, 255] : R,
        0
      );
      await d.commit("base");

      // Shrink canvas and draw a new pixel: raw base bytes must shift in lockstep so CAS succeeds.
      const clipped = d.resize(2, 2, { x: -1, y: 0 });
      assert.deepEqual(clipped, [["Layer 1", 0, 1]]);
      d.writable("Layer 1", 0).set(
        colorMode === "gray" ? [200, 200, 200, 255] : G,
        0
      );
      const info = await d.commit("resized");
      assert.equal(info.merged, 0);
      assert.equal(link.sprite(d.id).state.width, 2);
      assert.equal(link.sprite(d.id).state.height, 2);
      assert.deepEqual(
        pixel(celRgba(link, d.id), 2, 0, 0),
        colorMode === "gray" ? [200, 200, 200, 255] : G
      );
    })
  );
});

test("resize rejects extensions older than 0.2.0 and checks draftBytes limit", async () => {
  const { store } = setup({ extension: "0.1.0" });
  const d = await store.openSession().open({ new: [4, 4] });
  assert.throws(
    () => d.resize(8, 8),
    /update the Aseprite extension to 0\.2\.0/u
  );

  const tiny = setup({ draftBytes: 64 });
  const d2 = await tiny.store.openSession().open({ new: [2, 2] });
  d2.writable("Layer 1", 0).set(R, 0);
  assert.throws(() => d2.resize(64, 64), /the limit is 1 MB/u);
});

test("layers, groups, renames, removals, frames and tags stage and commit cleanly", async () => {
  const { link, store } = setup();
  const s = store.openSession();
  const d = await s.open({ new: [2, 1] });
  d.writable("Layer 1", 0).set(R, 0);
  d.layer("bg", { below: "Layer 1", opacity: 128 });
  d.layer("Layer 1", { rename: "body", visible: false });
  d.setFrames(3, 80);
  d.tag("walk", 0, 2, { direction: "pingpong" });
  assert.deepEqual(d.layers(), ["bg", "body"]);
  assert.throws(() => d.writable("Layer 1", 0), /Unknown layer 'Layer 1'/u);

  await s.commitAll();
  const st = link.sprite(d.id).state;
  assert.deepEqual(
    st.layers.map((l) => [l.path, l.opacity, l.visible]),
    [
      ["bg", 128, true],
      ["body", 255, false],
    ]
  );
  assert.equal(st.frames.length, 3);
  assert.deepEqual(st.tags, [
    { direction: "pingpong", from: 0, name: "walk", to: 2 },
  ]);
  assert.deepEqual(pixel(celRgba(link, d.id, "body", 2), 2, 0, 0), R);

  d.layer("bg", { remove: true });
  await d.commit("drop bg");
  assert.deepEqual(
    link.sprite(d.id).state.layers.map((l) => l.path),
    ["body"]
  );
});

test("CAS conflicts merge up to 3 retries and fail cleanly on the 4th conflict", async () => {
  const { link, store } = setup();
  const s = store.openSession();
  const d = await s.open({ new: [4, 1] });
  d.writable("Layer 1", 0).set([...R, ...R, ...R, ...R], 0);
  await d.commit("seed");

  // Two artist edits on non-overlapping pixels during commit -> merges on retry.
  let hits = 0;
  link.beforeRequest = (cmd) => {
    if (cmd === "commit" && hits < 2) {
      hits += 1;
      link.artist(d.id, "Layer 1", 0, (bytes) => {
        bytes.set(K, hits === 1 ? 8 : 12);
      });
    }
  };
  d.writable("Layer 1", 0).set(G, 0);
  d.writable("Layer 1", 0).set(B, 8);
  const merged = await d.commit("merge");
  assert.equal(merged.merged, 1);
  assert.equal(merged.lost, 1);
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 0, 0), G);
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 2, 0), K);
  assert.deepEqual(pixel(celRgba(link, d.id), 4, 3, 0), K);

  // Endless conflicts exhaust MAX_RETRIES (3).
  link.beforeRequest = (cmd) => {
    if (cmd === "commit") {
      link.artist(d.id, "Layer 1", 0, (bytes) => {
        bytes[0] = (bytes[0] + 1) % 256;
      });
    }
  };
  d.writable("Layer 1", 0).set(B, 4);
  await assert.rejects(() => d.commit("stuck"), /gave up after 3 retries/u);
});

test("save, undo and redo skip activate on 0.3.0 and fall back to activate on 0.2.0", async () => {
  const modern = setup({ extension: "0.3.0" });
  const dm = await modern.store.openSession().open({ new: [4, 4] });
  dm.writable("Layer 1", 0).set(R, 0);
  await dm.save("/tmp/a.aseprite");
  modern.link.log.length = 0;
  await dm.undo();
  assert.deepEqual(modern.link.log, ["history", "snapshot"]);
  assert.equal(celRgba(modern.link, dm.id), null);
  await dm.redo();
  assert.deepEqual(pixel(celRgba(modern.link, dm.id), 4, 0, 0), R);

  const legacy = setup({ extension: "0.2.0" });
  const dl = await legacy.store.openSession().open({ new: [4, 4] });
  dl.writable("Layer 1", 0).set(R, 0);
  legacy.link.log.length = 0;
  await dl.save("/tmp/b.aseprite");
  assert.deepEqual(legacy.link.log, ["commit", "sprites", "save"]);
  legacy.link.log.length = 0;
  await dl.undo();
  assert.deepEqual(legacy.link.log, ["sprites", "history", "snapshot"]);
});

test("changes() reports artist edits once and list() summarises open sprites", async () => {
  const { link, store } = setup();
  const s = store.openSession();
  const d = await s.open({ new: [4, 4] });
  d.writable("Layer 1", 0).set(R, 0);
  await d.commit("init");

  link.artist(d.id, "Layer 1", 0, (bytes, w) => {
    bytes.set(B, (2 * w + 1) * 4);
  });
  const first = await d.changes();
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].rect, [1, 2, 1, 1]);
  assert.deepEqual(await d.changes(), []);

  const sprites = await store.list();
  assert.deepEqual(sprites, [
    { active: true, frames: 1, height: 4, id: 1, name: "Sprite-1", width: 4 },
  ]);
  assert.deepEqual(pixel(d.readable("Layer 1", 0), 4, 1, 2), B);
  assert.deepEqual(d.bounds("Layer 1", 0), [0, 0, 2, 3]);
  assert.deepEqual(pixel(d.flatten(0).data, 4, 0, 0), R);
  assert.deepEqual(pixel(d.flatten(0).data, 4, 3, 3), T);
});
