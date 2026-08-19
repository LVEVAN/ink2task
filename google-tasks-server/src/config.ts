/**
 * Persistent config for the Google Tasks backend.
 *
 * Lives in the user's home directory (NOT in the repo, and deliberately
 * separate from mac-server's Ink2Task folder so the two backends never step
 * on each other). Holds the long-lived OAuth refresh token plus the same
 * list-name / port knobs the Mac server has, so the plugin sees an identical
 * service regardless of which backend is running.
 *
 * The application's OAuth client id/secret are NOT stored here -- they come
 * from the environment (.env). Only the per-user refresh token is persisted.
 *
 * Deliberately NOT a dot-prefixed folder (it was `~/.ink2task-google` until
 * 2026-08-18) -- a hidden folder is invisible in Finder/Explorer by default,
 * which matters here because a user has to actually open this file and copy
 * the refreshToken value out by hand (the plugin's token field can't paste).
 * migrateOldConfigDir() carries over anyone's existing hidden-folder config
 * on first run under the new path, so nobody has to re-authorize.
 */
import {homedir} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmdirSync} from 'node:fs';

export type ServerConfig = {
  /** OAuth2 refresh token from `npm run authorize`; absent until then. */
  refreshToken?: string;
  /** Google Tasks list title to sync, matched against the plugin's list name. */
  listName: string;
  /** TCP port the HTTP server listens on. 8942 matches mac-server's default. */
  port: number;
};

export const CONFIG_DIR = join(homedir(), 'Ink2Task-Google');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const OLD_CONFIG_DIR = join(homedir(), '.ink2task-google');
const OLD_CONFIG_FILE = join(OLD_CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: ServerConfig = {
  listName: 'Supernote',
  port: 8942,
};

/**
 * One-time move from the old hidden folder to the new visible one. Best-effort:
 * a failure here just means loadConfig falls back to defaults, same as if
 * this had never run.
 */
function migrateOldConfigDir(): void {
  try {
    if (existsSync(CONFIG_FILE) || !existsSync(OLD_CONFIG_FILE)) return;
    mkdirSync(CONFIG_DIR, {recursive: true});
    renameSync(OLD_CONFIG_FILE, CONFIG_FILE);
    rmdirSync(OLD_CONFIG_DIR);
  } catch {
    // best-effort; loadConfig's existsSync check just won't find anything
  }
}

/** Reads config, filling in defaults for any missing field. */
export function loadConfig(): ServerConfig {
  migrateOldConfigDir();
  if (!existsSync(CONFIG_FILE)) return {...DEFAULT_CONFIG};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return {...DEFAULT_CONFIG, ...parsed};
  } catch {
    return {...DEFAULT_CONFIG};
  }
}

/** Writes config, creating the directory on first use. */
export function saveConfig(config: ServerConfig): void {
  mkdirSync(CONFIG_DIR, {recursive: true});
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
