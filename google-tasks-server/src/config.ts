/**
 * Persistent config for the Google Tasks backend.
 *
 * Lives in the user's home directory (NOT in the repo, and deliberately
 * separate from mac-server's ~/.ink2task so the two backends never step on
 * each other). Holds the long-lived OAuth refresh token plus the same
 * list-name / port knobs the Mac server has, so the plugin sees an identical
 * service regardless of which backend is running.
 *
 * The application's OAuth client id/secret are NOT stored here -- they come
 * from the environment (.env). Only the per-user refresh token is persisted.
 */
import {homedir} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';

export type ServerConfig = {
  /** OAuth2 refresh token from `npm run authorize`; absent until then. */
  refreshToken?: string;
  /** Google Tasks list title to sync, matched against the plugin's list name. */
  listName: string;
  /** TCP port the HTTP server listens on. 8942 matches mac-server's default. */
  port: number;
};

export const CONFIG_DIR = join(homedir(), '.ink2task-google');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: ServerConfig = {
  listName: 'Supernote',
  port: 8942,
};

/** Reads config, filling in defaults for any missing field. */
export function loadConfig(): ServerConfig {
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
