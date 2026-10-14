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
import path from "node:path";
import { env } from "node:process";

import type { Link } from "./link.ts";

export const CONFIG_DIR = path.join(
  env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
  "aseprite-mcp"
);
export const TOKEN_FILE =
  env.ASEPRITE_MCP_TOKEN_FILE ?? path.join(CONFIG_DIR, "token");
export const PALETTE_FILE =
  env.ASEPRITE_MCP_PALETTE_FILE ?? path.join(CONFIG_DIR, "palettes.json");
export const LIB_DIR = env.ASEPRITE_MCP_LIB_DIR ?? path.join(CONFIG_DIR, "lib");

export const SPRITES_DIR =
  env.ASEPRITE_MCP_SPRITES_DIR ??
  path.join(homedir(), "Pictures", "aseprite-mcp");
// macOS reports its temp dir as /var/folders/..., yet most tools write to /tmp.
const DEFAULT_DIRS = [
  SPRITES_DIR,
  tmpdir(),
  ...(platform() === "win32" ? [] : ["/tmp"]),
];
export const DEFAULT_FILE_DIRS = DEFAULT_DIRS.join(path.delimiter);
export const FILE_DIRS = [
  ...new Set(
    (env.ASEPRITE_MCP_FILE_DIRS ?? DEFAULT_FILE_DIRS)
      .split(path.delimiter)
      .filter(Boolean)
  ),
];

const cacheRoot =
  platform() === "darwin"
    ? path.join(homedir(), "Library", "Caches")
    : (env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"));
export const VIEWS_DIR =
  env.ASEPRITE_MCP_VIEWS_DIR ?? path.join(cacheRoot, "aseprite-mcp", "views");
export const VIEWS_KEEP = 200;
export const AUTOSAVE_DIR =
  env.ASEPRITE_MCP_AUTOSAVE === "off"
    ? null
    : env.ASEPRITE_MCP_AUTOSAVE || path.join(CONFIG_DIR, "autosave");

const positive = (text: string | undefined, fallback: number): number =>
  Number(text) > 0 ? Number(text) : fallback;
const BACKUP_KEEP = positive(env.ASEPRITE_MCP_AUTOSAVE_KEEP, 5);
const BACKUP_DAYS = positive(env.ASEPRITE_MCP_AUTOSAVE_DAYS, 14);
const BACKUP_BYTES = positive(env.ASEPRITE_MCP_AUTOSAVE_MB, 200) * 1024 * 1024;
const BACKUP_DELAY_MS = 3000;
const DAY_MS = 86_400_000;

const newToken = (): string => randomBytes(24).toString("hex");

const ignore = (): null => null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

const writeToken = async (token: string): Promise<void> => {
  const folder = path.dirname(TOKEN_FILE);
  await mkdir(folder, { mode: 0o700, recursive: true });
  await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  // writeFile keeps the mode of a file that already exists.
  await chmod(TOKEN_FILE, 0o600);
};

/**
 * The pairing token: ASEPRITE_MCP_TOKEN, else the token file. With `create` a missing file gets a new token;
 * `renew` replaces whatever is there. Returns null when there is none and `create` is off.
 */
export const loadToken = async ({
  create = true,
  renew = false,
}: { create?: boolean; renew?: boolean } = {}): Promise<string | null> => {
  if (renew) {
    const token = newToken();
    await writeToken(token);
    return token;
  }
  if (env.ASEPRITE_MCP_TOKEN) {
    return env.ASEPRITE_MCP_TOKEN;
  }
  try {
    const text = await readFile(TOKEN_FILE, "utf-8");
    const token = text.trim();
    if (token) {
      return token;
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  if (!create) {
    return null;
  }
  const token = newToken();
  await writeToken(token);
  return token;
};

/** True when `real`, an already resolved path, is one of `dirs` or lies below one. */
export const insideAllowedDir = async (
  real: string,
  dirs: readonly string[] = FILE_DIRS
): Promise<boolean> => {
  const bases = await Promise.all(
    dirs.map((dir) => realpath(dir).catch(ignore))
  );
  return bases.some(
    (base) =>
      base !== null &&
      (real === base ||
        real.startsWith(base.endsWith(path.sep) ? base : base + path.sep))
  );
};

/** Deletes all but the newest `keep` PNGs in the views folder. */
export const pruneViews = async (
  dir = VIEWS_DIR,
  keep = VIEWS_KEEP
): Promise<void> => {
  const listing = await readdir(dir).catch(() => [] as string[]);
  const names = listing.filter((n) => n.endsWith(".png"));
  if (names.length <= keep) {
    return;
  }
  const dated = await Promise.all(
    names.map(async (n) => {
      const info = await stat(path.join(dir, n)).catch(ignore);
      return { path: path.join(dir, n), t: info?.mtimeMs ?? 0 };
    })
  );
  dated.sort((a, b) => b.t - a.t);
  await Promise.all(dated.slice(keep).map((f) => unlink(f.path).catch(ignore)));
};

const pad = (v: number): string => String(v).padStart(2, "0");

const stampNow = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
};
// Every new sprite is called "Sprite" until saved, and ids restart with Aseprite, so untitled copies are kept
// apart by daemon start time plus id; otherwise trimming one sprite's folder would delete another's copies.
const folderName = (name: unknown, id: number, session: string): string => {
  const safe = String(name)
    .replaceAll(/[^\w. -]+/gu, "_")
    .trim()
    .slice(0, 60);
  return safe && safe !== "Sprite" ? safe : `untitled ${session} ${id}`;
};

const trimFolder = async (folder: string): Promise<void> => {
  const listing = await readdir(folder);
  const files = listing
    .filter((f) => f.endsWith(".aseprite"))
    .toSorted()
    .toReversed();
  await Promise.all(
    files
      .slice(BACKUP_KEEP)
      .map((f) => unlink(path.join(folder, f)).catch(ignore))
  );
};

export interface BackupSprite {
  sprite: number;
  name: string;
}

export interface BackupInfo {
  days: number;
  dir: string | null;
  enabled: boolean;
  keep: number;
  lastBackup: string | null;
  lastError: string | null;
}

export interface Backups {
  schedule: (sprites: BackupSprite[] | undefined) => void;
  flush: () => Promise<void>;
  cleanup: () => Promise<void>;
  info: () => BackupInfo;
}

export interface BackupOptions {
  link: Link;
  dir?: string | null;
  log?: (...args: unknown[]) => void;
}

/** Debounced copies of the sprites a program changed, saved by the extension's `backup` command. */
export const createBackups = ({
  link,
  dir = AUTOSAVE_DIR,
  log,
}: BackupOptions): Backups => {
  const queue = new Map<number, string>();
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();
  let lastBackup: string | null = null;
  let lastError: string | null = null;
  const session = stampNow();

  const backupOne = async (id: number, name: string): Promise<void> => {
    const folder = path.join(dir ?? "", folderName(name, id, session));
    try {
      await mkdir(folder, { recursive: true });
      await link.request("backup", {
        path: path.join(folder, `${stampNow()}.aseprite`),
        sprite: id,
      });
      await trimFolder(folder);
      lastBackup = new Date().toISOString();
      lastError = null;
    } catch (error) {
      lastError = errorMessage(error);
      log?.(`Backup of '${name}' failed: ${lastError}`);
    }
  };

  // One at a time: the extension saves a sprite per request.
  const backupAll = async (batch: [number, string][]): Promise<void> => {
    const [first, ...rest] = batch;
    if (!first) {
      return;
    }
    await backupOne(...first);
    await backupAll(rest);
  };

  const runAfter = async (
    previous: Promise<void>,
    batch: [number, string][]
  ): Promise<void> => {
    await previous;
    try {
      await backupAll(batch);
    } catch (error) {
      lastError = errorMessage(error);
      log?.("Backup failed:", lastError);
    }
  };

  const drain = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const batch = [...queue];
    queue.clear();
    if (batch.length === 0) {
      return chain;
    }
    chain = runAfter(chain, batch);
    return chain;
  };

  const cleanup = async (): Promise<void> => {
    if (!dir) {
      return;
    }
    const folders = await readdir(dir).catch(() => [] as string[]);
    const listed = await Promise.all(
      folders.map(async (folder) => {
        const files = await readdir(path.join(dir, folder)).catch(
          () => [] as string[]
        );
        return Promise.all(
          files
            .filter((file) => file.endsWith(".aseprite"))
            .map(async (file) => {
              const target = path.join(dir, folder, file);
              return { info: await stat(target).catch(ignore), target };
            })
        );
      })
    );
    const found = listed
      .flat()
      .flatMap(({ info, target }) =>
        info?.isFile()
          ? [{ path: target, size: info.size, t: info.mtimeMs }]
          : []
      )
      .toSorted((a, b) => b.t - a.t);
    let total = 0;
    const doomed: string[] = [];
    for (const f of found) {
      total += f.size;
      if (Date.now() - f.t > BACKUP_DAYS * DAY_MS || total > BACKUP_BYTES) {
        doomed.push(f.path);
      }
    }
    await Promise.all(
      doomed.map((doomedPath) => rm(doomedPath, { force: true }))
    );
    // Only succeeds when empty.
    await Promise.all(
      folders.map((folder) => rmdir(path.join(dir, folder)).catch(ignore))
    );
  };

  return {
    cleanup,
    flush: drain,
    info: () => ({
      days: BACKUP_DAYS,
      dir,
      enabled: dir !== null,
      keep: BACKUP_KEEP,
      lastBackup,
      lastError,
    }),
    schedule: (sprites) => {
      if (!dir || !sprites?.length) {
        return;
      }
      for (const s of sprites) {
        queue.set(s.sprite, s.name);
      }
      clearTimeout(timer);
      timer = setTimeout(drain, BACKUP_DELAY_MS);
      timer.unref();
    },
  };
};
