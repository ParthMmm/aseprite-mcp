# Changelog

## 0.1.0

First release.

- One `execute` tool: the agent draws by writing a JavaScript program per step.
- Each program commits as one undo step in Aseprite.
- Native pixel methods: `map`, `rect`, `ellipse`, `fill`, `line`, `outline`, `shift`, `copy`, `recolor`.
- OKLCH color ramps and saved named palettes.
- Layers, frames, tags and animation from a program.
- `view()` renders PNG previews, including a four-panel critique image.
- Merge with the artist's edits when both change the same cels.
- Shared daemon with HTTP and stdio clients.
- HMAC pairing between the daemon and the Aseprite extension.
- Automatic backup copies after each commit.
