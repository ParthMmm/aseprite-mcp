import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { createBackups } from "../src/files.ts";
import type { Link } from "../src/link.ts";

interface Call {
  args: { sprite?: number; path: string };
  cmd: string;
}

function recordingLink(): Link & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request<T = unknown>(cmd: string, args: object = {}) {
      const call = { args, cmd } as Call;
      calls.push(call);
      if (cmd === "backup") {
        writeFileSync(call.args.path, "copy");
      }
      return { blobs: [], result: {} as T };
    },
    status: () => ({
      connected: true,
      error: null,
      extension: "0.1.0",
      port: 0,
    }),
  };
}

test("backups copy each changed sprite by id without switching the active sprite", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-backups-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const link = recordingLink();
  const backups = createBackups({ dir, link });

  backups.schedule([
    { name: "Sprite", sprite: 1 },
    { name: "Sprite", sprite: 2 },
    { name: "hero", sprite: 3 },
  ]);
  await backups.flush();

  assert.deepEqual(
    link.calls.map((c) => c.cmd),
    ["backup", "backup", "backup"],
    "no sprites/select calls"
  );
  assert.deepEqual(
    link.calls.map((c) => c.args.sprite),
    [1, 2, 3]
  );
  const folders = link.calls.map((c) => basename(dirname(c.args.path)));
  assert.equal(folders[2], "hero");
  assert.notEqual(
    folders[0],
    folders[1],
    "two untitled sprites never share a folder"
  );
  assert.equal(readdirSync(dir).length, 3);
});
