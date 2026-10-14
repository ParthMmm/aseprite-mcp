// Where aseprite-mcp keeps things on disk: pairing token, allowed folders, view PNGs and autosave copies.
// Locations come from the environment once, at import.
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { env } from "node:process";

export const CONFIG_DIR = join(
  env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "aseprite-mcp"
);
export const TOKEN_FILE =
  env.ASEPRITE_MCP_TOKEN_FILE ?? join(CONFIG_DIR, "token");
export const PALETTE_FILE =
  env.ASEPRITE_MCP_PALETTE_FILE ?? join(CONFIG_DIR, "palettes.json");

export const SPRITES_DIR =
  env.ASEPRITE_MCP_SPRITES_DIR ?? join(homedir(), "Pictures", "aseprite-mcp");
// macOS reports its temp dir as /var/folders/..., yet most tools write to /tmp.
const DEFAULT_DIRS = [
  SPRITES_DIR,
  tmpdir(),
  ...(platform() === "win32" ? [] : ["/tmp"]),
];
export const DEFAULT_FILE_DIRS = DEFAULT_DIRS.join(delimiter);
export const FILE_DIRS = [
  ...new Set(
    (env.ASEPRITE_MCP_FILE_DIRS ?? DEFAULT_FILE_DIRS)
      .split(delimiter)
      .filter(Boolean)
  ),
];

const cacheRoot =
  platform() === "darwin"
    ? join(homedir(), "Library", "Caches")
    : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
export const VIEWS_DIR =
  env.ASEPRITE_MCP_VIEWS_DIR ?? join(cacheRoot, "aseprite-mcp", "views");
export const VIEWS_KEEP = 200;
export const AUTOSAVE_DIR =
  env.ASEPRITE_MCP_AUTOSAVE === "off"
    ? null
    : env.ASEPRITE_MCP_AUTOSAVE || join(CONFIG_DIR, "autosave");

const positive = (text, fallback) =>
  Number(text) > 0 ? Number(text) : fallback;
const BACKUP_KEEP = positive(env.ASEPRITE_MCP_AUTOSAVE_KEEP, 5);
const BACKUP_DAYS = positive(env.ASEPRITE_MCP_AUTOSAVE_DAYS, 14);
const BACKUP_BYTES = positive(env.ASEPRITE_MCP_AUTOSAVE_MB, 200) * 1024 * 1024;
const BACKUP_DELAY_MS = 3000;
const DAY_MS = 86_400_000;

const newToken = () => randomBytes(24).toString("hex");

async function writeToken(token) {
  const folder = dirname(TOKEN_FILE);
  await mkdir(folder, { mode: 0o700, recursive: true });
  await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600); // writeFile keeps the mode of a file that already exists
}

/**
 * The pairing token: ASEPRITE_MCP_TOKEN, else the token file. With `create` a missing file gets a new token;
 * `renew` replaces whatever is there. Returns null when there is none and `create` is off.
 */
export async function loadToken({ create = true, renew = false } = {}) {
  if (renew) {
    const token = newToken();
    await writeToken(token);
    return token;
  }
  if (env.ASEPRITE_MCP_TOKEN) {
    return env.ASEPRITE_MCP_TOKEN;
  }
  try {
    const token = (await readFile(TOKEN_FILE, "utf-8")).trim();
    if (token) {
      return token;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!create) {
    return null;
  }
  const token = newToken();
  await writeToken(token);
  return token;
}

/** True when `real`, an already resolved path, is one of `dirs` or lies below one. */
export async function insideAllowedDir(real, dirs = FILE_DIRS) {
  for (const dir of dirs) {
    const base = await realpath(dir).catch(() => null);
    if (
      base &&
      (real === base || real.startsWith(base.endsWith(sep) ? base : base + sep))
    ) {
      return true;
    }
  }
  return false;
}

/** Deletes all but the newest `keep` PNGs in the views folder. */
export async function pruneViews(dir = VIEWS_DIR, keep = VIEWS_KEEP) {
  const names = (await readdir(dir).catch(() => [])).filter((n) =>
    n.endsWith(".png")
  );
  if (names.length <= keep) {
    return;
  }
  const dated = await Promise.all(
    names.map(async (n) => ({
      path: join(dir, n),
      t: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0,
    }))
  );
  dated.sort((a, b) => b.t - a.t);
  await Promise.all(
    dated.slice(keep).map((f) => unlink(f.path).catch(() => {}))
  );
}

const stampNow = () => {
  const d = new Date();
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};
// Every new sprite is called "Sprite" until saved, and ids restart with Aseprite, so untitled copies are kept
// apart by daemon start time plus id; otherwise trimming one sprite's folder would delete another's copies.
const folderName = (name, id, session) => {
  const safe = String(name)
    .replaceAll(/[^\w. -]+/g, "_")
    .trim()
    .slice(0, 60);
  return safe && safe !== "Sprite" ? safe : `untitled ${session} ${id}`;
};

/**
 * Debounced copies of the sprites a program changed, saved by the extension's `backup` command.
 * @param {{ link: import("./link.ts").Link, dir?: string | null, log?: (...a: any[]) => void }} o
 * @returns {{ schedule(sprites: { sprite: number, name: string }[]): void, flush(): Promise<void>, cleanup(): Promise<void>, info(): any }}
 */
export function createBackups({ link, dir = AUTOSAVE_DIR, log = () => {} }) {
  const queue = new Map();
  let timer = null;
  let chain = Promise.resolve();
  let lastBackup = null;
  let lastError = null;
  const session = stampNow();

  async function backupAll(batch) {
    for (const [id, name] of batch) {
      const folder = join(dir, folderName(name, id, session));
      try {
        await mkdir(folder, { recursive: true });
        await link.request("backup", {
          path: join(folder, `${stampNow()}.aseprite`),
          sprite: id,
        });
        await trimFolder(folder);
        lastBackup = new Date().toISOString();
        lastError = null;
      } catch (error) {
        lastError = error.message;
        log(`Backup of '${name}' failed: ${error.message}`);
      }
    }
  }

  async function trimFolder(folder) {
    const files = (await readdir(folder))
      .filter((f) => f.endsWith(".aseprite"))
      .sort()
      .reverse();
    await Promise.all(
      files
        .slice(BACKUP_KEEP)
        .map((f) => unlink(join(folder, f)).catch(() => {}))
    );
  }

  function drain() {
    clearTimeout(timer);
    timer = null;
    const batch = [...queue];
    queue.clear();
    if (!batch.length) {
      return chain;
    }
    chain = chain
      .then(() => backupAll(batch))
      .catch((error) => {
        lastError = error.message;
        log("Backup failed:", error.message);
      });
    return chain;
  }

  async function cleanup() {
    if (!dir) {
      return;
    }
    const found = [];
    for (const folder of await readdir(dir).catch(() => [])) {
      const files = await readdir(join(dir, folder)).catch(() => []);
      for (const file of files) {
        const path = join(dir, folder, file);
        const info = await stat(path).catch(() => null);
        if (info?.isFile() && file.endsWith(".aseprite")) {
          found.push({ path, t: info.mtimeMs, size: info.size });
        }
      }
    }
    found.sort((a, b) => b.t - a.t);
    let total = 0;
    for (const f of found) {
      total += f.size;
      if (Date.now() - f.t > BACKUP_DAYS * DAY_MS || total > BACKUP_BYTES) {
        await rm(f.path, { force: true });
      }
    }
    for (const folder of await readdir(dir).catch(() => [])) {
      await rmdir(join(dir, folder)).catch(() => {});
    } // only succeeds when empty
  }

  return {
    cleanup,
    flush: drain,
    info: () => ({
      enabled: dir !== null,
      dir,
      keep: BACKUP_KEEP,
      days: BACKUP_DAYS,
      lastBackup,
      lastError,
    }),
    schedule(sprites) {
      if (!dir || !sprites?.length) return;
      for (const s of sprites) queue.set(s.sprite, s.name);
      clearTimeout(timer);
      timer = setTimeout(drain, BACKUP_DELAY_MS);
      timer.unref();
    },
  };
}
