// Stands in for src/program.ts when a test starts the daemon with ASEPRITE_MCP_PROGRAM=<this file>.
// execute("view") writes a 1x1 PNG into viewsDir; "throw" fails; any other code echoes back with the link status.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encodePng } from "../../src/render.ts";

export const DESCRIPTION = "FAKE execute: test runtime";

export function createRuntime({ link, viewsDir }) {
  return {
    async execute(code) {
      if (code === "throw") {
        return {
          ok: false,
          error: { kind: "ExecutionFailure", message: "Error: boom" },
          commit: [],
          discarded: [],
          images: [],
          ms: 0,
        };
      }
      const images = [];
      if (code === "view") {
        const path = join(viewsDir, `fake-${process.pid}-${Date.now()}.png`);
        await writeFile(path, encodePng(1, 1, Uint8Array.of(255, 0, 0, 255)));
        images.push(path);
      }
      return {
        commit: [],
        images,
        ms: 0,
        ok: true,
        value: { code, connected: link.status().connected },
      };
    },
  };
}
