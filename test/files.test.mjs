import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createBackups } from "../src/files.mjs";

function recordingLink() {
  const calls = [];
  return {
    calls,
    async request(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === "backup") writeFileSync(args.path, "copy");
      return { result: {}, blobs: [] };
    },
  };
}

test("backups copy each changed sprite by id without switching the active sprite", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-backups-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = recordingLink();
  const backups = createBackups({ link, dir });

  backups.schedule([{ sprite: 1, name: "Sprite" }, { sprite: 2, name: "Sprite" }, { sprite: 3, name: "hero" }]);
  await backups.flush();

  assert.deepEqual(link.calls.map((c) => c.cmd), ["backup", "backup", "backup"], "no sprites/select calls");
  assert.deepEqual(link.calls.map((c) => c.args.sprite), [1, 2, 3]);
  const folders = link.calls.map((c) => basename(dirname(c.args.path)));
  assert.equal(folders[2], "hero");
  assert.notEqual(folders[0], folders[1], "two untitled sprites never share a folder");
  assert.equal(readdirSync(dir).length, 3);
});
