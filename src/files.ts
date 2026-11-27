// Deep Workspace storage module: owns path sandboxing, pairing token, views cache, saved palettes,
// and debounced autosave backups from explicit configuration (never frozen at import time).
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { env as processEnv } from "node:process";

import { formatHex, parseHex, RESERVED_KEYS } from "./color.ts";
import type { Palette } from "./color.ts";
import type { Link } from "./link.ts";

export interface WorkspaceConfig {
  tokenEnv: string | null;
  tokenFile: string;
  remoteTokenEnv: string | null;
  remoteTokenFile: string;
  palettesFile: string;
  libDir: string | null;
  spritesDir: string | null;
  allowedDirs: string[];
  viewsDir: string;
  viewsKeep: number;
  autosaveDir: string | null;
  backupKeep: number;
  backupDays: number;
  backupBytes: number;
}

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

export interface Workspace {
  readonly viewsDir: string;
  readonly libDir: string | null;
  readonly autosaveDir: string | null;
  resolvePath: (p: unknown, defaultExt?: string) => Promise<string>;
  loadToken: (opts?: {
    create?: boolean;
    renew?: boolean;
  }) => Promise<string | null>;
  loadRemoteToken: (opts?: {
    create?: boolean;
    renew?: boolean;
  }) => Promise<string | null>;
  saveView: (spriteName: string, png: Buffer) => Promise<string>;
  pruneViews: () => Promise<void>;
  loadPalette: (name: string) => Promise<Palette>;
  savePalette: (name: string, colors: Palette) => Promise<void>;
  createBackups: (opts: {
    link: Link;
    log?: (...args: unknown[]) => void;
  }) => Backups;
}

const BACKUP_DELAY_MS = 3000;
const DAY_MS = 86_400_000;

const positive = (text: string | undefined, fallback: number): number =>
  Number(text) > 0 ? Number(text) : fallback;

const newToken = (): string => randomBytes(24).toString("hex");
const ignore = (): null => null;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** Reads a WorkspaceConfig snapshot from `env` (defaults to `process.env`). */
export const workspaceConfigFromEnv = (
  env: NodeJS.ProcessEnv = processEnv
): WorkspaceConfig => {
  const home = homedir();
  const configDir = path.join(
    env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "aseprite-mcp"
  );
  const spritesDir =
    env.ASEPRITE_MCP_SPRITES_DIR ?? path.join(home, "Pictures", "aseprite-mcp");
  // macOS reports its temp dir as /var/folders/..., yet most tools write to /tmp.
  const defaultDirs = [
    spritesDir,
    tmpdir(),
    ...(platform() === "win32" ? [] : ["/tmp"]),
  ];
  const allowedDirs = [
    ...new Set(
      (env.ASEPRITE_MCP_FILE_DIRS ?? defaultDirs.join(path.delimiter))
        .split(path.delimiter)
        .filter(Boolean)
    ),
  ];
  const cacheRoot =
    platform() === "darwin"
      ? path.join(home, "Library", "Caches")
      : (env.XDG_CACHE_HOME ?? path.join(home, ".cache"));
  const autosaveDir =
    env.ASEPRITE_MCP_AUTOSAVE === "off"
      ? null
      : env.ASEPRITE_MCP_AUTOSAVE || path.join(configDir, "autosave");
  return {
    allowedDirs,
    autosaveDir,
    backupBytes: positive(env.ASEPRITE_MCP_AUTOSAVE_MB, 200) * 1024 * 1024,
    backupDays: positive(env.ASEPRITE_MCP_AUTOSAVE_DAYS, 14),
    backupKeep: positive(env.ASEPRITE_MCP_AUTOSAVE_KEEP, 5),
    libDir: env.ASEPRITE_MCP_LIB_DIR ?? path.join(configDir, "lib"),
    palettesFile:
      env.ASEPRITE_MCP_PALETTE_FILE ?? path.join(configDir, "palettes.json"),
    remoteTokenEnv: env.ASEPRITE_MCP_REMOTE_TOKEN || null,
    remoteTokenFile:
      env.ASEPRITE_MCP_REMOTE_TOKEN_FILE ??
      path.join(configDir, "remote-token"),
    spritesDir,
    tokenEnv: env.ASEPRITE_MCP_TOKEN || null,
    tokenFile: env.ASEPRITE_MCP_TOKEN_FILE ?? path.join(configDir, "token"),
    viewsDir:
      env.ASEPRITE_MCP_VIEWS_DIR ??
      path.join(cacheRoot, "aseprite-mcp", "views"),
    viewsKeep: 200,
  };
};

// Resolves symlinks, falling back to the parent folder for a file that does not exist yet.
const realOrParent = async (abs: string): Promise<string> => {
  try {
    return await realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    const dir = await realpath(parent).catch(() => parent);
    return path.join(dir, path.basename(abs));
  }
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

const writeTokenFile = async (file: string, token: string): Promise<void> => {
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  // writeFile keeps the mode of a file that already exists.
  await chmod(file, 0o600);
};

const loadSecret = async (
  tokenEnv: string | null,
  tokenFile: string,
  { create = true, renew = false }: { create?: boolean; renew?: boolean } = {}
): Promise<string | null> => {
  if (renew) {
    const token = newToken();
    await writeTokenFile(tokenFile, token);
    return token;
  }
  if (tokenEnv) {
    return tokenEnv;
  }
  try {
    const text = await readFile(tokenFile, "utf-8");
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
  await writeTokenFile(tokenFile, token);
  return token;
};

const readPalettesFile = async (
  file: string
): Promise<Record<string, Palette>> => {
  const text = await readFile(file, "utf-8").catch((error) => {
    if (!isMissing(error)) {
      throw error;
    }
    return null;
  });
  if (text === null) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The palettes file ${file} is not valid JSON.`);
  }
};

/** Creates a Workspace storage module from explicit config (merged over environment defaults). */
export const createWorkspace = (
  overrides: Partial<WorkspaceConfig> = {},
  env: NodeJS.ProcessEnv = processEnv
): Workspace => {
  const cfg: WorkspaceConfig = {
    ...workspaceConfigFromEnv(env),
    ...overrides,
  };
  let viewSeq = 0;

  const insideAllowedDir = async (real: string): Promise<boolean> => {
    const bases = await Promise.all(
      cfg.allowedDirs.map((dir) => realpath(dir).catch(ignore))
    );
    return bases.some(
      (base) =>
        base !== null &&
        (real === base ||
          real.startsWith(base.endsWith(path.sep) ? base : base + path.sep))
    );
  };

  // Symlinks are resolved first, so a link inside an allowed folder cannot reach outside it.
  const resolvePath = async (
    p: unknown,
    defaultExt = ".aseprite"
  ): Promise<string> => {
    if (typeof p !== "string" || !p) {
      throw new Error("Pass a file path as a string.");
    }
    let target = p;
    if (cfg.spritesDir && /^[^/\\~]+$/u.test(target)) {
      await mkdir(cfg.spritesDir, { recursive: true });
      target = path.join(
        cfg.spritesDir,
        path.extname(target) ? target : `${target}${defaultExt}`
      );
    }
    if (!path.isAbsolute(target) && !target.startsWith("~")) {
      throw new Error(
        `'${target}' is relative; pass a name such as "slime" or an absolute path.`
      );
    }
    const abs = path.resolve(target.replace(/^~(?=\/|$)/u, homedir()));
    const real = await realOrParent(abs);
    if (!(await insideAllowedDir(real))) {
      throw new Error(
        `'${abs}' is outside the allowed folders: ${cfg.allowedDirs.join(", ") || "(none configured)"}.`
      );
    }
    return real;
  };

  const loadToken = (opts?: {
    create?: boolean;
    renew?: boolean;
  }): Promise<string | null> => loadSecret(cfg.tokenEnv, cfg.tokenFile, opts);

  const loadRemoteToken = (opts?: {
    create?: boolean;
    renew?: boolean;
  }): Promise<string | null> =>
    loadSecret(cfg.remoteTokenEnv, cfg.remoteTokenFile, opts);

  const saveView = async (spriteName: string, png: Buffer): Promise<string> => {
    await mkdir(cfg.viewsDir, { recursive: true });
    const safe = spriteName.replaceAll(/[^\w.-]+/gu, "_").slice(0, 40);
    viewSeq += 1;
    const outPath = path.join(
      cfg.viewsDir,
      `${Date.now()}-${process.pid}-${viewSeq}-${safe}.png`
    );
    await writeFile(outPath, png);
    return outPath;
  };

  const pruneViews = async (): Promise<void> => {
    const listing = await readdir(cfg.viewsDir).catch(() => [] as string[]);
    const names = listing.filter((n) => n.endsWith(".png"));
    if (names.length <= cfg.viewsKeep) {
      return;
    }
    const dated = await Promise.all(
      names.map(async (n) => {
        const info = await stat(path.join(cfg.viewsDir, n)).catch(ignore);
        return { path: path.join(cfg.viewsDir, n), t: info?.mtimeMs ?? 0 };
      })
    );
    dated.sort((a, b) => b.t - a.t);
    await Promise.all(
      dated.slice(cfg.viewsKeep).map((f) => unlink(f.path).catch(ignore))
    );
  };

  const loadPalette = async (name: string): Promise<Palette> => {
    const all = await readPalettesFile(cfg.palettesFile);
    if (!Object.hasOwn(all, name)) {
      throw new Error(
        `No saved palette '${name}'. Saved: ${Object.keys(all).join(", ") || "none"}`
      );
    }
    return all[name];
  };

  const savePalette = async (name: string, colors: Palette): Promise<void> => {
    const clean: Palette = {};
    for (const [key, color] of Object.entries(colors)) {
      if ([...key].length !== 1 || RESERVED_KEYS.has(key)) {
        throw new Error(
          `${JSON.stringify(key)} cannot be palette keys: use one character other than "." and space.`
        );
      }
      clean[key] = formatHex(parseHex(color));
    }
    const all = await readPalettesFile(cfg.palettesFile);
    all[name] = clean;
    await mkdir(path.dirname(cfg.palettesFile), { recursive: true });
    const tmp = `${cfg.palettesFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`);
    await rename(tmp, cfg.palettesFile);
  };

  const createBackups = ({
    link,
    log,
  }: {
    link: Link;
    log?: (...args: unknown[]) => void;
  }): Backups => {
    const dir = cfg.autosaveDir;
    const queue = new Map<number, string>();
    let timer: NodeJS.Timeout | undefined;
    let chain: Promise<void> = Promise.resolve();
    let lastBackup: string | null = null;
    let lastError: string | null = null;
    const session = stampNow();

    const trimFolder = async (folder: string): Promise<void> => {
      const listing = await readdir(folder);
      const files = listing
        .filter((f) => f.endsWith(".aseprite"))
        .toSorted()
        .toReversed();
      await Promise.all(
        files
          .slice(cfg.backupKeep)
          .map((f) => unlink(path.join(folder, f)).catch(ignore))
      );
    };

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
        if (
          Date.now() - f.t > cfg.backupDays * DAY_MS ||
          total > cfg.backupBytes
        ) {
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
        days: cfg.backupDays,
        dir,
        enabled: dir !== null,
        keep: cfg.backupKeep,
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

  return {
    autosaveDir: cfg.autosaveDir,
    createBackups,
    libDir: cfg.libDir,
    loadPalette,
    loadRemoteToken,
    loadToken,
    pruneViews,
    resolvePath,
    savePalette,
    saveView,
    viewsDir: cfg.viewsDir,
  };
};
