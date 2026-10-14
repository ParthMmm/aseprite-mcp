import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { help } from "../src/help.ts";
import { createRuntime, DESCRIPTION } from "../src/program.ts";
import type {
  ExecuteFailure,
  ExecuteResult,
  ExecuteSuccess,
} from "../src/program.ts";
import { createFakeLink, pixel } from "./fake-link.ts";
import type { FakeLink } from "./fake-link.ts";

const pass = (r: ExecuteResult): ExecuteSuccess => {
  assert.equal(r.ok, true, JSON.stringify(r.ok ? null : r.error));
  return r as ExecuteSuccess;
};

const fail = (r: ExecuteResult): ExecuteFailure => {
  assert.equal(r.ok, false);
  return r as ExecuteFailure;
};

const setup = async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "aseprite-mcp-program-"));
  const link = createFakeLink();
  const runtime = createRuntime({
    allowedDirs: [dir],
    link,
    palettesFile: nodePath.join(dir, "palettes.json"),
    viewsDir: nodePath.join(dir, "views"),
  });
  return { dir, link, run: (code: string) => runtime.execute(code) };
};

const cel = (link: FakeLink, id: number, layer = "Layer 1", frame = 0) =>
  link.sprite(id).state.cels.get(`${layer}@${frame}`);
const opaque = (bytes: Uint8Array | undefined) => {
  assert.ok(bytes, "cel exists");
  let n = 0;
  for (let i = 3; i < bytes.length; i += 4) {
    if (bytes[i]) {
      n += 1;
    }
  }
  return n;
};

test("48x48 map + outline + critique view writes a PNG and commits once", async () => {
  const { link, run } = await setup();
  const r = await run(`
    const s = await sprite({ new: [48, 48] })
    const P = { k: "#1a1c2c", ...ramp("#b13e53", "rst") }
    const c = s.cel("Layer 1")
    c.ellipse([12, 12, 24, 24], P.s, { fill: true })
    const rows = []
    for (let y = 0; y < 6; y++) rows.push("t".repeat(6 - y))
    c.map(P, rows, { x: 16, y: 16 })
    const edge = c.outline()
    const v = await s.view({ critique: true })
    return { edge, v, layers: s.layers() }
  `);
  const rOk = pass(r);
  assert.equal(r.images.length, 1);
  assert.equal((rOk.value as { v: { path: string } }).v.path, r.images[0]);
  const png = await readFile(r.images[0]);
  assert.deepEqual(
    [...png.subarray(1, 4)],
    [0x50, 0x4e, 0x47],
    "PNG signature"
  );
  assert.ok((rOk.value as { edge: number }).edge > 0, "outline drew pixels");
  assert.equal(r.commit.length, 1);
  assert.deepEqual(
    {
      cels: r.commit[0].cels,
      label: r.commit[0].label,
      lost: r.commit[0].lost,
      merged: r.commit[0].merged,
    },
    { cels: 1, label: "program", lost: 0, merged: 0 }
  );
  const id = r.commit[0].sprite;
  assert.equal(link.sprite(id).undo.length, 1, "one undo step");
  assert.equal(opaque(cel(link, id)), r.commit[0].pixels);
  assert.deepEqual(pixel(cel(link, id), 48, 0, 0), [0, 0, 0, 0]);
});

test("12-frame animation commits one undo step; undo restores one frame", async () => {
  const { link, run } = await setup();
  const r = await run(`
    const s = await sprite({ new: [16, 16] })
    s.cel("Layer 1").map({ a: "#ff0000" }, ["aa", "aa"], { x: 2, y: 2 })
    s.setFrames(12, { duration: 80 })
    let moved = 0
    for (const c of s.cels("Layer 1")) moved += c.shift(c.frame % 4, 0)
    s.tag("run", 0, 11)
    const strip = await s.view({ frame: "all", scale: 1 })
    return { frames: s.frames(), moved, strip }
  `);
  const rOk = pass(r);
  assert.equal(r.commit.length, 1);
  assert.equal(r.commit[0].cels, 12);
  const id = r.commit[0].sprite;
  const entry = link.sprite(id);
  assert.equal(entry.undo.length, 1);
  assert.equal(entry.state.frames.length, 12);
  assert.ok(entry.state.frames.every((f) => f.duration === 80));
  assert.deepEqual(entry.state.tags, [
    { direction: "forward", from: 0, name: "run", to: 11 },
  ]);
  assert.deepEqual(
    pixel(cel(link, id, "Layer 1", 3), 16, 5, 2),
    [255, 0, 0, 255],
    "frame 3 shifted 3 px right"
  );
  assert.deepEqual(pixel(cel(link, id, "Layer 1", 3), 16, 2, 2), [0, 0, 0, 0]);
  assert.equal(
    (rOk.value as { strip: { width: number } }).strip.width,
    12 * 16 + 11
  );

  const u = await run(
    `const s = await sprite(); await s.undo(); return s.frames()`
  );
  const uOk = pass(u);
  assert.equal(uOk.value, 1);
  assert.deepEqual(u.commit, []);
});

test("read -> recolor -> map round trip", async () => {
  const { link, run } = await setup();
  const a = await run(`
    const s = await sprite({ new: [8, 8] })
    s.cel("Layer 1").map({ r: "#ff0000", b: "#0000ff" }, ["rrb", ".br", "r.r"], { x: 1, y: 1 })
    return s.id
  `);
  const id = pass(a).value as number;
  const before = Uint8Array.from(cel(link, id) ?? []);
  const b = await run(`
    const c = (await sprite()).cel("Layer 1")
    const first = c.read({ rect: [0, 0, 8, 8], palette: { r: "#ff0000" } })
    const changed = c.recolor({ "#ff0000": "#00ff00" })
    const green = c.read({ palette: { g: "#00ff00" } })
    c.clear()
    c.map(first.palette, first.rows)
    return { first, changed, green: green.rows }
  `);
  const bOk = pass(b);
  assert.deepEqual((bOk.value as { first: { rows: string[] } }).first.rows, [
    "",
    ".rra",
    "..ar",
    ".r.r",
    "",
    "",
    "",
    "",
  ]);
  assert.equal((bOk.value as { changed: number }).changed, 5);
  assert.deepEqual((bOk.value as { green: string[] }).green.slice(1, 4), [
    ".gga",
    "..ag",
    ".g.g",
  ]);
  assert.deepEqual(
    b.commit,
    [],
    "mapping the read rows back restores the cel exactly, so nothing commits"
  );
  assert.deepEqual(cel(link, id), before);
});

test("a throwing program commits nothing and lists discarded cels", async () => {
  const { link, run } = await setup();
  const r = await run(`
    const s = await sprite({ new: [8, 8] })
    s.cel("Layer 1").px([[1, 1, "#ffffff"]])
    throw new Error("boom")
  `);
  const rBad = fail(r);
  assert.match(rBad.error.message, /boom/u);
  assert.deepEqual(r.commit, []);
  assert.deepEqual(rBad.discarded, [{ cels: 1, sprite: 1 }]);
  assert.equal(cel(link, 1), undefined);
  assert.equal(link.sprite(1).undo.length, 0);
});

test("an artist edit between snapshot and commit merges and reports lost pixels", async () => {
  const { link, run } = await setup();
  await run(
    `(await sprite({ new: [8, 8] })).cel("Layer 1").rect([0, 0, 8, 8], "#808080", { fill: true })`
  );
  let injected = false;
  link.beforeRequest = (cmd) => {
    if (cmd !== "commit" || injected) {
      return;
    }
    injected = true;
    link.artist(1, "Layer 1", 0, (bytes, w) => {
      bytes.set([0, 0, 255, 255], (0 * w + 1) * 4);
      bytes.set([255, 255, 255, 255], (5 * w + 5) * 4);
    });
  };
  const r = await run(
    `(await sprite()).cel("Layer 1").px([[0, 0, "#00ff00"], [1, 0, "#00ff00"]])`
  );
  const rOk = pass(r);
  assert.equal(r.commit.length, 1);
  assert.equal(r.commit[0].merged, 1);
  assert.equal(r.commit[0].lost, 1);
  const bytes = cel(link, 1);
  assert.deepEqual(pixel(bytes, 8, 0, 0), [0, 255, 0, 255], "ours kept");
  assert.deepEqual(
    pixel(bytes, 8, 1, 0),
    [0, 0, 255, 255],
    "artist wins the overlap"
  );
  assert.deepEqual(
    pixel(bytes, 8, 5, 5),
    [255, 255, 255, 255],
    "artist edit kept"
  );
});

test("s.commit() checkpoint survives a later throw", async () => {
  const { link, run } = await setup();
  const r = await run(`
    const s = await sprite({ new: [8, 8] })
    s.cel("Layer 1").px([[0, 0, "#ff0000"]])
    await s.commit("first")
    s.cel("Layer 1").px([[1, 0, "#ff0000"]])
    throw new Error("later")
  `);
  const rBad = fail(r);
  assert.deepEqual(
    r.commit.map((c) => [c.label, c.pixels]),
    [["first", 1]]
  );
  assert.deepEqual(rBad.discarded, [{ cels: 1, sprite: 1 }]);
  assert.deepEqual(pixel(cel(link, 1), 8, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixel(cel(link, 1), 8, 1, 0), [0, 0, 0, 0]);
  assert.equal(link.sprite(1).undo.length, 1);
});

test("program errors name what exists", async () => {
  const { run } = await setup();
  const layer = await run(`(await sprite({ new: [4, 4] })).cel("Body")`);
  const layerBad = fail(layer);
  assert.match(
    layerBad.error.message,
    /Unknown layer 'Body'\. Layers: Layer 1\./u
  );

  const key = await run(
    `(await sprite()).cel("Layer 1").map({ a: "#fff" }, ["aa", "aX"])`
  );
  assert.match(fail(key).error.message, /row 1 uses key "X".*keys: a/u);

  const frame = await run(`(await sprite()).cel("Layer 1", 3)`);
  assert.match(
    fail(frame).error.message,
    /Frame 3 does not exist; the sprite has 1 frame \(0-0\)/u
  );

  const open = await run(`await sprite({ open: "/etc/passwd" })`);
  assert.match(fail(open).error.message, /outside the allowed folders/u);
});

test("a symlink inside an allowed folder cannot reach outside it", async () => {
  const { dir, run } = await setup();
  await symlink("/etc/hosts", nodePath.join(dir, "hosts.aseprite"));
  const r = await run(
    `await sprite({ open: ${JSON.stringify(nodePath.join(dir, "hosts.aseprite"))} })`
  );
  const rBad = fail(r);
  assert.match(rBad.error.message, /outside the allowed folders/u);
});

test("changes() reports the artist's edits once", async () => {
  const { link, run } = await setup();
  await run(
    `(await sprite({ new: [8, 8] })).cel("Layer 1").px([[0, 0, "#ff0000"]])`
  );
  link.artist(1, "Layer 1", 0, (bytes, w) =>
    bytes.set([0, 0, 255, 255], (2 * w + 3) * 4)
  );
  const r = await run(
    `const s = await sprite(); return [await s.changes(), await s.changes()]`
  );
  const rOk = pass(r);
  assert.deepEqual(rOk.value, [
    [
      {
        frame: 0,
        layer: "Layer 1",
        palette: { a: "#0000ff" },
        rect: [3, 2, 1, 1],
        rows: ["a"],
      },
    ],
    [],
  ]);
});

test("DESCRIPTION stays under 5,500 characters and help topics resolve", () => {
  assert.ok(
    DESCRIPTION.length < 5500,
    `DESCRIPTION is ${DESCRIPTION.length} characters`
  );
  for (const t of ["maps", "animation", "critique", "conflicts", "files"]) {
    assert.ok(help(t).length > 200, t);
  }
  assert.throws(() => help("nope"), /Topics: maps/u);
});
