// Stands in for src/program.ts when a test starts the daemon with ASEPRITE_MCP_PROGRAM=<this file>.
// execute("view") writes a 1x1 PNG into the workspace views dir; "throw" fails; any other code echoes back.
import { encodePng } from "../../src/codecs.ts";
import type { Envelope, RuntimeOptions } from "../../src/daemon.ts";

export const DESCRIPTION = "FAKE execute: test runtime";

export const createRuntime = ({ link, workspace }: RuntimeOptions) => ({
  async execute(code: string): Promise<Envelope> {
    if (code === "throw") {
      return {
        commit: [],
        discarded: [],
        error: { kind: "ExecutionFailure", message: "Error: boom" },
        images: [],
        ms: 0,
        ok: false,
      };
    }
    const images: string[] = [];
    if (code === "view") {
      images.push(
        await workspace.saveView(
          "fake",
          encodePng(1, 1, Uint8Array.of(255, 0, 0, 255))
        )
      );
    }
    return {
      commit: [],
      images,
      ms: 0,
      ok: true,
      value: { code, connected: link.status().connected },
    };
  },
});
