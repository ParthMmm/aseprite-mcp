// The execute tool description (API digest + rules) and the long-form help(topic) texts.

export const DESCRIPTION = `Draw pixel art live in the user's Aseprite by running a JavaScript program. Coordinates are 0-based, (0,0) top-left; frames are 0-based.

Globals:
sprite(o?: { new?: [w, h]; colorMode?: "rgb"|"indexed"|"gray"; open?: path; id?: number; name?: string }): Promise<Sprite>  // no args = the active sprite
sprites(): Promise<{ id, name, width, height, frames, active }[]>
image(path): Promise<Image>  // load a PNG reference: Image { image, width, height, read(o?), colors(max = 32), downscale(factor) }
ramp(base: string, keys: string, o?: { hueShift?: number }): Record<string, string>  // OKLCH shades, dark to light, one per key
palette(name, colors?): Promise<Record<string, string>>  // load, or save with colors, a named palette
lib(name?, code?): Promise<string[] | string>  // save helper code: lib(name, code); read: lib(name); list: lib()
use(name): void  // top-level use("style") puts a saved library's functions in scope; see help("lib")
help(topic?): string  // topics: maps, animation, critique, conflicts, files, export, lib

Sprite { id, name, width, height, colorMode
  layers(): string[]  // paths, bottom to top; "group/child"
  frames(): number; selection(): Rect | null
  cel(layer, frame = 0): Cel; cels(layer): Cel[]  // one per frame
  layer(name, o?: { below?, visible?, opacity? (0-255), rename?, remove? }): void  // unknown name = new layer
  setFrames(count, o?: { duration?: ms | ms[] }): void  // new frames copy the last frame
  tag(name, from, to, o?: { direction?: "forward"|"reverse"|"pingpong" }): void
  view(o?: { frame?: number | "all"; rect?: Rect; scale?: number; critique?: boolean; background?: "#080707" }): Promise<{ path, width, height }>  // background replaces the checkerboard
  resize(w, h, o?: { x?, y? }): Sprite  // canvas size, not scale; art moves by (x, y), default bottom-centred; use the returned handle
  commit(label?): Promise<{ label, cels, pixels, merged, lost }>  // checkpoint now
  undo(n = 1): Promise<void>; redo(n = 1): Promise<void>
  changes(): Promise<{ layer, frame, rect, palette, rows }[]>  // the artist's edits since you last looked
  save(nameOrPath?): Promise<string>  // save("slime") -> ~/Pictures/aseprite-mcp/slime.aseprite
  export(name, o?: { scale?, tag?, sheet? = true, gif?, columns? }): Promise<{ sheet?, json?, gif?, frames, width, height }> }  // sprite sheet PNG + JSON, GIF
Cel { layer, frame
  map(palette, rows, o?: { x?, y?, flip?: "h"|"v"|"hv" }): number  // one char per pixel; "." and " " skip; "#00000000" erases
  px(points: [x, y, color][]): number; line(x0, y0, x1, y1, color): number
  rect(r, color, o?: { fill? }): number; ellipse(r, color, o?: { fill? }): number; fill(x, y, color): number
  outline(color?, o?: { mode?: "selective"|"outside"|"inside"; rect? }): number  // selective needs no colour
  shift(dx, dy, o?: { rect? }): number
  copy(from: { layer, frame?, sprite? } | { image: img.image }, o?: { rect?, x?, y?, flip? }): number  // not the handle itself
  recolor(map: { "#from": "#to" }, o?: { rect? }): number; clear(r?): number
  bounds(): Rect | null  // [x, y, w, h] of the non-transparent pixels; null when empty
  read(o?: { rect?; palette? }): { palette, rows } }  // same format as map; pass your palette to keep its keys
Rect = [x, y, w, h] | "selection". Colours are "#rgb", "#rrggbb" or "#rrggbbaa". Drawing methods return pixels changed.

Rules:
- Edits go to a draft. When the program returns, each touched sprite commits as ONE undo step ("MCP: program").
- A throw or timeout commits nothing; the result lists the discarded cels. await s.commit("label") is a checkpoint that survives a later throw.
- Pixel loops belong in methods: map/rect/fill/shift run natively; a JS loop per pixel is slow.
- Return only what you need (counts, a few rows), never whole sprites or handles.
- view() writes a PNG and returns its path; open the file to look. Use critique: true to judge colour, values and silhouette in one image.
- The result's warnings name each drawing call that dropped pixels outside the canvas; move the art or s.resize().
- The result's commit list reports merged and lost: if the artist drew on the same cels meanwhile, both edits are kept and the artist wins where you overlap.

Example:
const s = await sprite({ new: [32, 32] })
const P = { k: "#1a1c2c", ...ramp("#b13e53", "rst") }
const c = s.cel("Layer 1")
c.ellipse([8, 8, 16, 16], P.s, { fill: true })
c.map(P, ["..tt", ".tsst"], { x: 12, y: 10 })
c.outline()
return await s.view({ critique: true })`;

type HelpTopic =
  | "animation"
  | "conflicts"
  | "critique"
  | "export"
  | "files"
  | "lib"
  | "maps";

const TOPICS: Record<HelpTopic, string> = {
  animation: `Animation
- s.setFrames(n, { duration: 100 }) sets the frame count. New frames copy the last frame, so draw frame 0
  fully first, then change only what moves in later frames. duration is in milliseconds, one number or one per frame.
- for (const c of s.cels("body")) c.shift(0, c.frame % 2) moves one layer per frame; copy(), map() with x/y,
  and recolor() work the same way per cel.
- Put parts that move independently (head, arm, effect) on their own layer: s.layer("arm") creates it.
- s.tag("run", 0, 7, { direction: "pingpong" }) names a frame range.
- Check motion with s.view({ frame: "all" }): every frame side by side in one image.
- The whole animation still commits as one undo step when the program returns.`,

  conflicts: `Drawing together with the artist
- Your program edits a private draft. At commit, every cel you wrote is compared with what Aseprite holds now.
- If the artist changed a cel you also changed, the two edits are merged: your pixels where only you changed
  them, the artist's elsewhere; where both changed the same pixel, the artist wins. The commit entry reports
  merged (cels) and lost (your pixels the artist overrode). The merge retries at most 3 times.
- If the artist removed or renamed a layer you write to, the commit fails with a message; call sprite() again.
- s.changes() lists what the artist drew since you last looked (layer, frame, rect, palette, rows).
  The first call on a sprite compares against the state your first sprite() call saw.
- "this part" or "here": the artist's selection is s.selection(); pass rect: "selection" to any method.
- undo/redo refuse to run while you have uncommitted edits; commit first. They act on whole undo steps,
  and each of your programs is one step.`,

  critique: `Critique
- s.view({ critique: true }) shows four panels: colour, grayscale values, silhouette and true size (1x).
  Values: the shapes must read in gray; if not, the shades are too close. Silhouette: the pose must read
  as a solid shape. True size: details smaller than a pixel cluster disappear.
- Zoom into a detail with rect: s.view({ rect: [8, 8, 16, 16] }).
- background: "#080707" draws the app's ground colour instead of the checkerboard, in the view and in the colour and
  gray critique panels. Use it to check that dark art still reads where it will be shown.
- Look once after the main shapes, then fix only the rows that are wrong (map with x/y). Do not view after
  every small change; each view is an image you must read.
- Style: light from the top-left. Avoid pure black outlines on coloured areas; outline() with the default
  selective mode derives a darker, cooler edge from each neighbour. Draw flat shapes first, then shading,
  then highlights, then outline.`,

  export: `Export and reference images
- await s.export("slime", { scale: 4, gif: true }) writes slime.png (the sprite sheet), slime.json and slime.gif
  next to each other; a name such as "slime" or "slime.png" means the sprites folder. Pending edits are committed
  first. It returns { sheet, json, gif, frames, width, height }: absolute paths, the frame count and one frame's
  size in the output.
- Each frame is the visible layers composited at their opacity, scaled up by scale (whole number, nearest
  neighbour). The sheet puts frames left to right in one row; columns: 4 wraps it into a grid.
- tag: "idle" exports only that tag's frames. sheet: false skips the PNG and JSON.
- The JSON lists frames ({ x, y, w, h, duration } in ms), tags ({ name, from, to, direction }), size and scale.
- The GIF loops, keeps each frame's duration (rounded to 10 ms, at least 20 ms) and has one transparent colour:
  alpha below 128 becomes transparent. More than 255 colours is an error; use fewer colours or the sheet only.
- const ref = await image("ref.png") loads a PNG from the sprites folder or an absolute path (8-bit, not
  interlaced). ref.width, ref.height; ref.colors(16) lists its most common colours as hex, for a palette.
- ref.read({ rect, palette }) returns palette + rows like cel.read. ref.downscale(4) returns a new image at
  1/4 size, each 4x4 block becoming its most common colour: use it on art drawn at 4x or 6x.
- c.copy({ image: ref.image }, { rect: [0, 0, 16, 16], x: 8, y: 8 }) pastes the image, or a rect of it, into a
  cel. Pass { image: ref.image }, not ref: a handle cannot be an argument. The same goes for cels:
  c.copy({ layer: "body", frame: 2 }) copies another cel; add sprite: id for another open sprite.`,

  files: `Files
- sprite({ open: "/abs/path.aseprite" }) opens a file; sprite({ new: [32, 32] }) creates a sprite.
  sprite({ id }) or sprite({ name }) picks an open sprite; sprites() lists them.
- A bare name such as "slime" or "slime.png" means the sprites folder (default ~/Pictures/aseprite-mcp).
  Other paths must be absolute (or start with ~) and inside the folders the user allowed.
- await s.save("slime") saves a new sprite there; await s.save() saves to the sprite's own file again.
  Pending edits are committed first. save("slime.png") writes one PNG per frame; s.export() writes a
  sprite sheet, its JSON and a GIF (see help("export")).
- Lost or unsaved work: the daemon keeps automatic backup copies after each commit.
- Keep sprites small: 16x16 to 64x64 is typical pixel art.`,

  lib: `Saved helper code (lib / use)
- await lib("style", code) saves code as a library (a-z, 0-9, _ and -, at most 40 characters). The code is parsed
  first; a syntax error names the line and nothing is saved. lib("style") returns the source; lib() lists the names.
- A program starts with use("style") statements, one per library, at the top level with a string literal. Before the
  program runs, those libraries are put in front of it, so the functions and consts they declare are in scope.
  use(name) inside a function or with a variable fails. A library saved in this program is usable from the next one.
- A library may use("base") other libraries. Each library loads once, dependencies first; a cycle or a missing
  library fails before anything runs.
- Write libraries as function declarations and consts: function blob(c, x, y) { ... }. Pass cels in as arguments.
  A library cannot return at the top level. Do not declare a name in the program that a library already declares.
- Error lines point at the program, or name the library and its line: (library 'style', line 8, col 10).
- Libraries are files in ~/.config/aseprite-mcp/lib (ASEPRITE_MCP_LIB_DIR). Saving again replaces the file.`,

  maps: `Pixel maps (map / read)
- A palette maps one-character keys to colours; each row string is one line of pixels, left to right.
  c.map({ k: "#1a1c2c", r: "#b13e53", w: "#f4f4f4" }, ["..kk..", ".krrk.", "krwrrk"], { x: 4, y: 2 })
- "." and space leave the pixel unchanged. Map a key to "#00000000" to erase. Rows may differ in length.
- flip: "h" mirrors each row, "v" reverses the row order, "hv" both. Use it for symmetric parts.
- Repeated parts: keep their rows in a const and map them at several x/y offsets (or flip them).
- read({ rect, palette }) returns the same format. Pass your palette so known colours keep their keys;
  new colours get fresh keys. Edit the rows in JS and map them back: read -> change -> map is lossless.
- Big generated art: compute the rows in the program instead of writing them out by hand.
- Palette: pick 4-16 colours first: a dark outline, 2-3 shades per material, 1 highlight.
  ramp("#b13e53", "rstu") gives hue-shifted shades, dark to light (cool shadows, warm lights).
  palette("hero", P) saves a palette by name; await palette("hero") loads it in a later program.
- Clipping: pixels that map, px, line, rect, ellipse, copy, shift or outline put outside the canvas are dropped. The
  result's warnings list each call once with its cel and count, for example
  map on "body"@0 dropped 12 pixels outside the 48x48 canvas. Move the art, or make room with resize.
- s.resize(64, 64) changes the canvas size, not the art's scale. Art moves by { x, y }; the default keeps it at the
  bottom centre, so a figure standing on a baseline stays on it. resize returns the handle with the new width and
  height; the old handle keeps the old numbers. Pixels outside a smaller canvas are dropped. It commits in the same
  single undo step as your other edits, and needs extension 0.2.0.
- c.bounds() is [x, y, w, h] of the non-transparent pixels, or null for an empty cel: use it to align or centre art.`,
};

// Most useful first; the agent reads this list in order.
const TOPIC_ORDER: readonly HelpTopic[] = [
  "maps",
  "animation",
  "critique",
  "conflicts",
  "files",
  "export",
  "lib",
];

const isTopic = (key: string): key is HelpTopic => Object.hasOwn(TOPICS, key);

/** help() lists the topics; help(topic) returns its text. */
export const help = (topic?: unknown): string => {
  if (topic === undefined || topic === null || topic === "") {
    return `Topics: ${TOPIC_ORDER.join(", ")}. Call help("maps") etc.`;
  }
  const key = String(topic).toLowerCase();
  if (!isTopic(key)) {
    throw new Error(
      `No help topic '${String(topic)}'. Topics: ${TOPIC_ORDER.join(", ")}.`
    );
  }
  return TOPICS[key];
};
