import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      // Pixel packing, PNG/zip CRCs and colour-key hashing are bitwise by nature.
      files: [
        "scripts/build-extension.ts",
        "src/draft.ts",
        "src/program.ts",
        "src/raster.ts",
        "src/render.ts",
        "src/wire.ts",
        "test/render.test.ts",
        "test/wire.test.ts",
      ],
      rules: { "no-bitwise": "off" },
    },
  ],
});
