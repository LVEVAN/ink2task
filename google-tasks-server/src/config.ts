/**
 * Persistent config for the Google Tasks backend.
 *
 * Lives right in this project's own folder (google-tasks-server/config.json,
 * next to credentials.env, package.json, etc.), gitignored so the refresh
 * token never gets committed. Holds the long-lived OAuth refresh token plus
 * the same list-name / port knobs the Mac server has, so the plugin sees an
 * identical service regardless of which backend is running.
 *
 * The application's OAuth client id/secret are NOT stored here -- they come
 * from the environment (.env). Only the per-user refresh token is persisted.
 *
 * History: this lived in the user's home directory until 2026-08-19, first
 * as a dot-prefixed hidden folder (`~/.ink2task-google`), then as a visible
 * one (`~/Ink2Task-Google`). Both were still too easy to lose track of --
 * a user has to actually open this file and copy the refreshToken value out
 * by hand (the plugin's token field can't paste), and "a folder in your home
 * directory" was consistently harder to relocate in practice than "the same
 * folder you're already sitting in to run npm commands." migrateOldConfig()
 * carries over anyone's existing config from either old location on first
 * run under the new path, so nobody has to re-authorize.
 */
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmdirSync} from 'node:fs';

export type ServerConfig = {
  /** OAuth2 refresh token from `npm run authorize`; absent until then. */
  refreshToken?: string;
  /** Google Tasks list title to sync, matched against the plugin's list name. */
  listName: string;
  /** TCP port the HTTP server listens on. 8942 matches mac-server's default. */
  port: number;
};

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = PROJECT_ROOT;
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const OLD_CONFIG_LOCATIONS = [
  join(homedir(), 'Ink2Task-Google', 'config.json'),
  join(homedir(), '.ink2task-google', 'config.json'),
];

const DEFAULT_CONFIG: ServerConfig = {
  listName: 'Supernote',
  port: 8942,
};

/**
 * One-time move from either old home-directory location into this project
 * folder. Best-effort: a failure here just means loadConfig falls back to
 * defaults, same as if this had never run.
 */
function migrateOldConfig(): void {
  if (existsSync(CONFIG_FILE)) return;
  for (const old of OLD_CONFIG_LOCATIONS) {
    if (!existsSync(old)) continue;
    try {
      renameSync(old, CONFIG_FILE);
      rmdirSync(dirname(old));
    } catch {
      // best-effort; loadConfig's existsSync check just won't find anything
    }
    return;
  }
}

/** Reads config, filling in defaults for any missing field. */
export function loadConfig(): ServerConfig {
  migrateOldConfig();
  if (!existsSync(CONFIG_FILE)) return {...DEFAULT_CONFIG};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return {...DEFAULT_CONFIG, ...parsed};
  } catch {
    return {...DEFAULT_CONFIG};
  }
}

/** Writes config, creating the directory on first use (a no-op here, but mirrors the old home-dir version's shape). */
export function saveConfig(config: ServerConfig): void {
  mkdirSync(CONFIG_DIR, {recursive: true});
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
