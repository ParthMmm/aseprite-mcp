# Changelog

## Unreleased

- Programs run directly on `psychoscript` 0.3.0 (dropping `@opencode/codemode` and `effect`), with Node.js 24+ required. Programs can use ES classes, pass cel and image handles directly to `copy()`, and cancel when the caller aborts.
- Faster views, critique sheets, PNG/GIF encoding and decoding, selective outlines, and Aseprite extension `0.3.0` (`save`/`history` target sprites directly without an extra `sprites` round-trip).
- `serve --tailscale` serves the daemon to your tailnet through `tailscale serve`, open to the machine's owner. Set `ASEPRITE_MCP_TAILNET_USERS` to allow other users. Tailnet callers get view images inline and cannot stop the daemon.

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
