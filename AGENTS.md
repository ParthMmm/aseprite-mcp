# AGENTS.md

MCP server that lets an AI agent draw pixel art live in Aseprite. The agent sends one JavaScript program per `execute` call. TypeScript on Node 24+ (run directly, no server build), a Lua extension inside Aseprite, Ultracite (oxlint + oxfmt) for lint and format.

## Project map

- `bin/aseprite-mcp.ts` - CLI: `serve`, `token`, `status`, `stop`; no argument runs the stdio MCP proxy
- `src/daemon.ts` - HTTP MCP server (`/mcp`, `/health`, `/shutdown`), loopback, tailnet and remote auth
- `src/program.ts` - `psychoscript` sandbox runtime and the `execute` program API
- `src/help.ts` - `execute` tool description and `help(topic)` texts
- `src/session.ts` - Sprite Session: drafts, diffs, compare-and-swap commits, conflict merges
- `src/link.ts`, `src/wire.ts` - WebSocket link to the extension and the binary frame protocol
- `src/render.ts`, `src/codecs.ts` - views, critique sheets, sprite sheet and GIF export, PNG/GIF codecs
- `src/raster.ts`, `src/color.ts` - per-pixel ops and OKLCH/hex color math
- `src/files.ts`, `src/library.ts` - Workspace storage (path sandboxing, tokens, views, backups, palettes) and saved libraries
- `src/tailnet.ts` - Tailscale Serve and address discovery
- `extension/` - Aseprite Lua plugin (`plugin.lua` client, `handlers.lua` commands)
- `test/` - `node:test` suites; `fake-link.ts` is an in-memory Aseprite; `fixtures/` holds the daemon env and a fake runtime
- `GLOSSARY.md` - domain terms (Sprite, Cel, Sprite Session, Link, View, Workspace, Library)

<important if="you need to run commands to build, test, lint, typecheck, or run the daemon">

| Command | What it does |
| --- | --- |
| `npm test` | Run all tests (`node --test`) |
| `npm run typecheck` | `tsc -p .`, type check only |
| `npm run check` | Ultracite check (`npx ultracite check`) |
| `npm run fix` | Ultracite safe fixes and formatting (`npx ultracite fix`) |
| `npx ultracite doctor` | Diagnose the Ultracite setup |
| `npm run build` | Pack `extension/` into `dist/aseprite-mcp.aseprite-extension` |
| `npm start` | Start the daemon (`node bin/aseprite-mcp.ts serve`) |
| `npm run token` | Print the pairing token (`--new` rotates, `--remote` for the HTTP bearer token) |
| `node bin/aseprite-mcp.ts status` / `stop` | Daemon status / stop |

CI runs typecheck, check, and every test except `test/aseprite.test.ts`. Run `npm run fix` after editing; it is not run on commit.

</important>

<important if="you are writing or running tests">

- `test/aseprite.test.ts` runs `test/aseprite-handlers.lua` in real Aseprite (`aseprite -b`) and skips when the app is missing. Set `ASEPRITE=/path/to/aseprite` to point to it.
- Use `test/fake-link.ts` for anything behind the Link instead of a real extension.
- Daemon and e2e tests use `test/fixtures/daemon-env.ts` (free ports, isolated env) and `ASEPRITE_MCP_PROGRAM=test/fixtures/fake-program.ts`.
</important>

<important if="you are changing the extension version, package version, or the minimum extension the daemon accepts">

`test/versions.test.ts` enforces these. Keep in sync:

- `package.json` and `package-lock.json` version
- `extension/package.json` version and `VERSION` in `extension/handlers.lua`
- `MIN_EXTENSION` in `src/link.ts` must not exceed the shipped extension version
- README mentions the extension version in Development and Architecture
</important>

<important if="you are changing the wire protocol or the messages between the daemon and the Lua extension">

- Bump `PROTOCOL` in both `src/wire.ts` and `extension/plugin.lua`.
- Pixels cross as full-canvas `Image.bytes` in the sprite's color mode; `src/wire.ts` is the only place that converts to RGBA.
- New handler features that the daemon depends on need an extension version bump and a version gate (see `src/session.ts`).
</important>

<important if="you are adding or changing globals, handles, or methods in the execute program API">

- Handles are plain objects of closures, and mutable state lives behind methods: `psychoscript` copies plain fields once at the sandbox boundary (see `src/program.ts`).
- Update `DESCRIPTION` and the matching topic in `src/help.ts`. Keep the description short (about 1,000 tokens); put detail in `help(topic)`.
- Update "The program API" in `README.md` and add a `CHANGELOG.md` entry.
</important>

<important if="you are touching file paths, workspace storage, tokens, or daemon auth">

- All host file access goes through the injectable Workspace in `src/files.ts`, which sandboxes paths. Do not read config or env at import time; pass it in.
- Remote and tailnet callers must not be able to stop the daemon. Compare tokens with `timingSafeEqual`.
</important>

<important if="you are naming new modules, types, or concepts">
Use the terms in `GLOSSARY.md` and avoid the listed alternatives (for example "Link", not "socket" or "bridge"). Add new domain terms there.
</important>

<important if="you are adding TypeScript imports or syntax">
Import local files with the `.ts` extension, and use only erasable syntax (no `enum`, `namespace`, or parameter properties): Node runs the sources without a build.
</important>
