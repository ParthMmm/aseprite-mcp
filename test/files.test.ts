import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { createWorkspace } from "../src/files.ts";
import type { Link } from "../src/link.ts";

interface Call {
  args: { sprite?: number; path: string };
  cmd: string;
}

const recordingLink = (): Link & { calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    request<T = unknown>(cmd: string, args: object = {}) {
      const call = { args, cmd } as Call;
      calls.push(call);
      if (cmd === "backup") {
        writeFileSync(call.args.path, "copy");
      }
      return Promise.resolve({ blobs: [], result: {} as T });
    },
    status: () => ({
      connected: true,
      error: null,
      extension: "0.3.0",
      port: 0,
    }),
  };
};

const tempWorkspace = (
  t: { after: (fn: () => void) => void },
  overrides: Parameters<typeof createWorkspace>[0] = {}
) => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "mcp-workspace-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const spritesDir = nodePath.join(dir, "sprites");
  const ws = createWorkspace({
    allowedDirs: [dir],
    autosaveDir: nodePath.join(dir, "autosave"),
    libDir: nodePath.join(dir, "lib"),
    palettesFile: nodePath.join(dir, "nested", "palettes.json"),
    spritesDir,
    tokenEnv: null,
    tokenFile: nodePath.join(dir, "token"),
    viewsDir: nodePath.join(dir, "views"),
    ...overrides,
  });
  return { dir, spritesDir, ws };
};

test("resolvePath handles bare names, allowed paths, relative paths and symlink escapes", async (t) => {
  const { dir, spritesDir, ws } = tempWorkspace(t);
  const bare = await ws.resolvePath("slime");
  assert.equal(nodePath.basename(bare), "slime.aseprite");
  assert.ok(bare.endsWith(nodePath.join("sprites", "slime.aseprite")));
  const refPath = await ws.resolvePath("ref", ".png");
  assert.ok(refPath.endsWith("ref.png"));

  await assert.rejects(ws.resolvePath("sub/slime.aseprite"), /is relative/u);
  await assert.rejects(
    ws.resolvePath("/etc/passwd"),
    /outside the allowed folders/u
  );

  await mkdir(spritesDir, { recursive: true });
  const escape = nodePath.join(dir, "escape.aseprite");
  await symlink("/etc/hosts", escape);
  await assert.rejects(ws.resolvePath(escape), /outside the allowed folders/u);
});

test("loadToken creates, reuses, renews and honours env override", async (t) => {
  const { dir, ws } = tempWorkspace(t);
  assert.equal(await ws.loadToken({ create: false }), null);
  const first = await ws.loadToken();
  assert.ok(first && first.length === 48);
  assert.equal(await ws.loadToken(), first);
  const renewed = await ws.loadToken({ renew: true });
  assert.ok(renewed && renewed !== first);

  const fromEnv = createWorkspace({
    tokenEnv: "env-token-value",
    tokenFile: nodePath.join(dir, "unused"),
  });
  assert.equal(await fromEnv.loadToken(), "env-token-value");
});

test("saveView and pruneViews keep only the newest viewsKeep PNGs", async (t) => {
  const { ws } = tempWorkspace(t, { viewsKeep: 2 });
  const p1 = await ws.saveView("hero", Buffer.from("a"));
  const p2 = await ws.saveView("hero", Buffer.from("b"));
  const p3 = await ws.saveView("hero", Buffer.from("c"));
  const now = Date.now() / 1000;
  await utimes(p1, now - 30, now - 30);
  await utimes(p2, now - 20, now - 20);
  await utimes(p3, now - 10, now - 10);
  await ws.pruneViews();
  const viewFiles = await readdir(ws.viewsDir);
  const remaining = viewFiles.toSorted();
  assert.deepEqual(remaining, [nodePath.basename(p2), nodePath.basename(p3)]);
});

test("named palettes save atomically, load and reject bad keys or colours", async (t) => {
  const { dir, ws } = tempWorkspace(t);
  await ws.savePalette("skin", { a: "#ffcd75", b: "#b13e53" });
  await ws.savePalette("sea", { s: "#29366f" });
  assert.deepEqual(await ws.loadPalette("skin"), {
    a: "#ffcd75",
    b: "#b13e53",
  });
  assert.deepEqual(
    Object.keys(
      JSON.parse(
        await readFile(nodePath.join(dir, "nested", "palettes.json"), "utf-8")
      )
    ),
    ["skin", "sea"]
  );
  await assert.rejects(
    ws.loadPalette("nope"),
    /No saved palette 'nope'. Saved: skin, sea/u
  );
  await assert.rejects(ws.savePalette("bad", { x: "blue" }), /Not a colour/u);
  await assert.rejects(
    ws.savePalette("bad", { ".": "#ffffff" }),
    /cannot be palette keys/u
  );
});

test("backups copy each changed sprite by id and cleanup evicts old or oversize files", async (t) => {
  const { dir, ws } = tempWorkspace(t, { backupBytes: 10, backupDays: 1 });
  const link = recordingLink();
  const backups = ws.createBackups({ link });

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
  const folders = link.calls.map((c) =>
    nodePath.basename(nodePath.dirname(c.args.path))
  );
  assert.equal(folders[2], "hero");
  assert.notEqual(
    folders[0],
    folders[1],
    "two untitled sprites never share a folder"
  );
  const autosaveDir = nodePath.join(dir, "autosave");
  assert.equal(readdirSync(autosaveDir).length, 3);

  // Add an aged folder and run cleanup: stale & oversize copies are evicted and empty folders removed.
  const oldFolder = nodePath.join(autosaveDir, "ancient");
  await mkdir(oldFolder, { recursive: true });
  const oldFile = nodePath.join(oldFolder, "old.aseprite");
  await writeFile(oldFile, "old-bytes-here");
  const ancient = Date.now() / 1000 - 10 * 86_400;
  await utimes(oldFile, ancient, ancient);
  await backups.cleanup();
  assert.equal(readdirSync(autosaveDir).includes("ancient"), false);
});
