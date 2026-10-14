# Aseprite MCP

Aseprite MCP lets an AI agent draw pixel art live in [Aseprite](https://www.aseprite.org/). The agent writes one JavaScript program per step ("code mode"). The server exposes one tool, `execute`.

## Why it is fast

- One program is one round trip and one undo step, however many pixels it changes.
- Pixel work runs natively. Methods such as `map`, `rect`, `fill` and `shift` change many pixels per call.
- The tool description is under about 1,000 tokens. The agent reads longer guidance on demand with `help(topic)`.

Measured on an Apple Silicon Mac with Aseprite 1.3.18: a program that draws a 48×48 sprite, builds a 12-frame animation and renders a critique view takes about 80 ms on Node and about 55 ms on Bun, from request to result.

## Install

Requires Aseprite and Node.js 22.18 or later (it runs the TypeScript sources directly). [Bun](https://bun.sh/) also runs the daemon, about 30% faster. The tests need Node.

1. Clone the repository and build the extension.

   ```sh
   git clone https://github.com/ParthMmm/aseprite-mcp.git
   cd aseprite-mcp
   npm install
   npm run build
   ```

2. In Aseprite, open **Preferences > Extensions**, choose **Add Extension**, and select `dist/aseprite-mcp.aseprite-extension`.
3. Restart Aseprite.
4. Print the pairing token.

   ```sh
   node bin/aseprite-mcp.ts token
   ```

5. In Aseprite, choose **File > Aseprite MCP...**, paste the token, and select **Connect**.

To make a new token, run `node bin/aseprite-mcp.ts token --new`, then paste it in the dialog again.

## Run

Start the shared daemon:

```sh
node bin/aseprite-mcp.ts serve   # or: bun bin/aseprite-mcp.ts serve
```

The daemon serves MCP at `http://127.0.0.1:9124/mcp`. Aseprite connects to it on `ws://127.0.0.1:9123`.

Connect a client in one of two ways:

- **Executor:** use Quick Add with the URL `http://127.0.0.1:9124/mcp`.
- **Any stdio client:** set the command to `node /path/to/aseprite-mcp/bin/aseprite-mcp.ts`. It starts the daemon if none runs.

By default, a view is returned as a file path. Use `http://127.0.0.1:9124/mcp?images=inline` to also get image blocks in the result.

Other commands:

| Command | Action |
| --- | --- |
| `node bin/aseprite-mcp.ts status` | Show whether the daemon runs and Aseprite is connected. |
| `node bin/aseprite-mcp.ts stop` | Stop the daemon. |

### Start the daemon at login on macOS

Save this as `~/Library/LaunchAgents/com.parthmmm.aseprite-mcp.plist`. Replace both paths: the first is your `node` or `bun` binary (`which bun`), the second is your clone.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.parthmmm.aseprite-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>/path/to/aseprite-mcp/bin/aseprite-mcp.ts</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/aseprite-mcp.log</string>
</dict>
</plist>
```

Then load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.parthmmm.aseprite-mcp.plist
```

After you update the code, restart it with `launchctl kickstart -k gui/$(id -u)/com.parthmmm.aseprite-mcp`. Aseprite reconnects by itself.

### macOS: keep Aseprite awake

macOS App Nap slows apps that sit in the background, and Aseprite then stalls saves until you bring it to the front. Turn App Nap off for Aseprite once, then restart Aseprite:

```sh
defaults write org.aseprite.Aseprite NSAppSleepDisabled -bool YES
```

### Settings

Set these environment variables for the daemon.

| Variable | Default |
| --- | --- |
| `ASEPRITE_MCP_HTTP_PORT` | `9124` |
| `ASEPRITE_MCP_PORT` | `9123` (WebSocket port for the extension) |
| `ASEPRITE_MCP_TIMEOUT` | `15000` ms per command (at least 60000 for snapshot and commit) |
| `ASEPRITE_MCP_TOKEN` | Token file |
| `ASEPRITE_MCP_TOKEN_FILE` | `~/.config/aseprite-mcp/token` |
| `ASEPRITE_MCP_PALETTE_FILE` | `~/.config/aseprite-mcp/palettes.json` |
| `ASEPRITE_MCP_LIB_DIR` | `~/.config/aseprite-mcp/lib`, where `lib(name, code)` saves helper code |
| `ASEPRITE_MCP_SPRITES_DIR` | `~/Pictures/aseprite-mcp`, where `s.save("name")` writes |
| `ASEPRITE_MCP_FILE_DIRS` | The sprites folder and the temporary directories |
| `ASEPRITE_MCP_VIEWS_DIR` | The user cache directory |
| `ASEPRITE_MCP_AUTOSAVE` | `~/.config/aseprite-mcp/autosave`, or `off` |
| `ASEPRITE_MCP_AUTOSAVE_KEEP` | `5` copies per sprite |
| `ASEPRITE_MCP_AUTOSAVE_DAYS` | `14` |
| `ASEPRITE_MCP_AUTOSAVE_MB` | `200` |

## The program API

The agent calls `execute` with a JavaScript program. Coordinates are 0-based, with (0,0) at the top left.

Globals:

```text
sprite(o?: { new?: [w, h]; colorMode?: "rgb"|"indexed"|"gray"; open?: path; id?: number; name?: string }): Promise<Sprite>
sprites(): Promise<{ id, name, width, height, frames, active }[]>
image(path): Promise<Image>
ramp(base: string, keys: string, o?: { hueShift?: number }): Record<string, string>
palette(name, colors?): Promise<Record<string, string>>
lib(name?, code?): Promise<string[] | string>
use(name): void
help(topic?): string
```

- `sprite()` with no arguments returns the active sprite.
- `ramp` makes OKLCH shades, dark to light, one per key.
- `palette` loads a named palette, or saves it when you pass colors.
- `image` loads a PNG as pixels. See [Sprite sheets, GIFs and reference images](#sprite-sheets-gifs-and-reference-images).
- `lib` saves, reads or lists helper code. See [Saved helper code](#saved-helper-code).
- `help` has the topics `maps`, `animation`, `critique`, `conflicts`, `files`, `export` and `lib`.

A `Sprite` has `layers()`, `frames()`, `selection()`, `cel(layer, frame)`, `cels(layer)`, `layer(name, opts)`, `setFrames(count, opts)`, `tag(name, from, to, opts)`, `view(opts)`, `resize(width, height, opts)`, `commit(label)`, `undo(n)`, `redo(n)`, `changes()`, `save(path)` and `export(name, opts)`.

A `Cel` has `map`, `px`, `line`, `rect`, `ellipse`, `fill`, `outline`, `shift`, `copy`, `recolor`, `clear`, `read` and `bounds`. Drawing methods return the number of pixels changed. `bounds()` returns `[x, y, w, h]` of the non-transparent pixels, or `null` for an empty cel.

Colors are `"#rgb"`, `"#rrggbb"` or `"#rrggbbaa"`. A pixel map uses a palette of one-character keys and one string per row:

```js
const s = await sprite({ new: [32, 32] });
const P = { k: "#1a1c2c", ...ramp("#b13e53", "rst") };
const c = s.cel("Layer 1");
c.ellipse([8, 8, 16, 16], P.s, { fill: true });
c.map(P, ["..tt", ".tsst"], { x: 12, y: 10 });
c.outline();
return await s.view({ critique: true });
```

Rules:

- Edits go to a draft. When the program returns, each touched sprite commits as one undo step labeled `MCP: program`.
- A throw or a timeout commits nothing. Call `await s.commit("label")` for a checkpoint that survives a later throw.
- Do not loop over single pixels in JavaScript. Use `map`, `rect`, `fill` and `shift`.
- Return only what you need, such as counts or a few rows.
- `view()` writes a PNG and returns its path. With `critique: true`, the image shows color, grayscale values, silhouette and true size. `background: "#080707"` draws that color instead of the checkerboard.
- Pixels that a drawing call puts outside the canvas are dropped. The result's `warnings` list each such call once, for example `map on "body"@0 dropped 12 pixels outside the 48x48 canvas`.
- `s.resize(64, 64, { x, y })` changes the canvas size, not the scale of the art. The art moves by `(x, y)`. By default it stays at the bottom center, so a figure on a baseline stays on it. `resize` returns a handle with the new `width` and `height`, and it commits in the same undo step as the other edits. It needs extension 0.2.0.

### Saved helper code

`lib(name, code)` saves JavaScript helpers to `~/.config/aseprite-mcp/lib/<name>.js`. A later program loads them with a top-level `use("name")` statement. Before the program runs, the daemon puts each used library in front of it, dependencies first, so the functions it declares are in scope.

```js
await lib(
  "style",
  'use("base")\nfunction blob(c, x, y) { c.rect([x, y, 4, 4], INK, { fill: true }) }'
);
// next program:
use("style");
const s = await sprite({ new: [48, 48] });
blob(s.cel("Layer 1"), 10, 10);
```

- `lib(name)` returns the source and `lib()` lists the names. A name has 1 to 40 characters from `a-z`, `0-9`, `_` and `-`.
- The daemon parses the code before it saves it. A syntax error names the line, and nothing is saved.
- A library can `use` other libraries. A missing library or a cycle fails before the program runs.
- An error inside a library names the library and its line. Lines in the program stay as you wrote them.

### Sprite sheets, GIFs and reference images

`s.export(name, opts)` writes a sprite sheet and an animated GIF for apps and previews. A bare name such as `"slime"` goes to the sprites folder.

```js
const s = await sprite();
return await s.export("slime", { scale: 4, gif: true, columns: 4 });
// { sheet: ".../slime.png", json: ".../slime.json", gif: ".../slime.gif", frames: 8, width: 192, height: 192 }
```

- `slime.png` holds every frame, composited from the visible layers and scaled up by `scale` with nearest-neighbor sampling. Frames run left to right; `columns` wraps them into a grid.
- `slime.json` gives each frame's `x`, `y`, `w`, `h` and `duration` in milliseconds, the tags with `from`, `to` and `direction`, the sheet `size` and the `scale`.
- `slime.gif` loops and keeps the frame durations. It has one transparent color and at most 255 other colors.
- `tag: "idle"` exports only that tag's frames. `sheet: false` writes only the GIF.

`image(path)` loads a PNG, such as a reference drawing, as pixels. It returns `{ image, width, height }` with `read(opts)`, `colors(max)` and `downscale(factor)`. `downscale(4)` turns art drawn at 4x back into one pixel per block. To paste it into a cel, pass its id: `c.copy({ image: ref.image }, { x: 8, y: 8 })`. The decoder reads 8-bit PNGs and palette PNGs; it refuses interlaced and 16-bit files.

## Safety

- The daemon listens on loopback addresses only (`127.0.0.1`).
- Aseprite and the daemon pair with a shared token. Each side proves it knows the token with an HMAC-SHA256 exchange, and the extension checks the server too. The token never crosses the connection.
- A program can read and write files only inside the allowed folders: by default `~/Pictures/aseprite-mcp` and the temporary directories. Set `ASEPRITE_MCP_FILE_DIRS` to change it.
- Each program runs in a sandboxed interpreter. Defaults: 60 seconds, 64,000 bytes of output, 10,000 tool calls and a 64 MB draft.
- The daemon saves backup copies after each commit and removes old ones by count, age and size.

See [DISCLAIMER.md](DISCLAIMER.md).

## Undo and conflicts

Each program is one undo step in Aseprite. Press Ctrl+Z (Cmd+Z on macOS) to undo the whole program.

The program edits a private draft of the sprite. At commit, the daemon compares each cel it wrote with what Aseprite holds now. If you changed the same cel meanwhile, the daemon merges both edits. Where you both changed the same pixel, your edit wins. The commit result reports `merged` cels and `lost` pixels. After three failed retries, the commit fails and the agent runs the program again.

`s.changes()` lists what you drew since the agent last looked. Use `s.selection()` or `rect: "selection"` for "this part".

## Development

The code is TypeScript that Node and Bun run directly; there is no build step for the server.

```sh
npm install
npm test             # node --test
npm run typecheck    # tsc, type check only
npm run check        # Ultracite: oxlint and oxfmt
npm run fix          # apply safe fixes, then rerun the tests
```

`node --test` also runs `test/aseprite.test.ts`. It runs `test/aseprite-handlers.lua` in a real Aseprite in batch mode, and it skips when it cannot find the app. Set `ASEPRITE=/path/to/aseprite` to point to the binary.

`npm run build` writes `dist/aseprite-mcp.aseprite-extension`.

## License

Public domain under [the Unlicense](LICENSE). Use, copy, change and sell it for any purpose, with no conditions and no attribution needed.
