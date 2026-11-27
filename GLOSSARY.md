# Aseprite MCP

Aseprite MCP lets an AI agent edit pixel art live in a running Aseprite instance by executing confined JavaScript programs.

## Language

### Sprite & editing

**Sprite**: An open pixel-art document in Aseprite with a canvas size, color mode (`rgb`, `indexed`, or `gray`), palette, layer tree, frames, tags, and optional selection. _Avoid_: Document, image, canvas (use canvas only for a single pixel buffer)

**Cel**: One layer's full-canvas pixel buffer on a single 0-based frame; linked cels share one buffer across frames. _Avoid_: Frame image, tile

**Sprite Session**: The host-side mirror of open sprites during a program run that tracks local edits, diffs, compare-and-swap commits, conflict merges, and artist changes over a Link. _Avoid_: Draft manager, sync service

**Link**: The authenticated transport between the daemon and the Aseprite extension carrying JSON commands and raw sprite-mode pixel blobs. _Avoid_: Socket, bridge, client

### Rendering & export

**View**: An upscaled PNG preview of one or more flattened frames rendered for inspection. _Avoid_: Preview, screenshot, thumbnail

**Critique Sheet**: A multi-panel view placing color, grayscale values, silhouette, true size (1x), and optional color-blindness panels side by side. _Avoid_: Contact sheet, inspection grid

**Image Codecs**: Pure binary encoders and decoders converting between full-canvas RGBA pixel buffers and PNG or GIF89a files. _Avoid_: Image utilities, formatters

### Host storage & execution

**Workspace**: The host directories and files the daemon owns or admits: allowed folders, sprites folder, views cache, saved palettes, saved libraries, pairing token, and autosave backups. _Avoid_: Storage service, file system, config dirs

**Library**: A named JavaScript helper file saved in the workspace and prepended into programs that declare a top-level `use("name")`. _Avoid_: Module, snippet, plugin
