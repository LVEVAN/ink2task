/**
 * Persistent config for the Todoist backend.
 *
 * Lives in the user's home directory (NOT in the repo, and in its own dir so it
 * never collides with mac-server's ~/.ink2task or the Google backend's
 * ~/.ink2task-google). Holds the Todoist personal API token plus the same
 * list-name / port knobs the other backends have, so the plugin sees an
 * identical service regardless of which backend is running.
 */
import {homedir} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';

export type ServerConfig = {
  /** Todoist personal API token (Settings > Integrations > Developer). */
  token?: string;
  /** Todoist project name to sync, matched against the plugin's list name. */
  listName: string;
  /** TCP port the HTTP server listens on. 8942 matches mac-server's default. */
  port: number;
};

export const CONFIG_DIR = join(homedir(), '.ink2task-todoist');
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

/** Writes config, creating the directory on first use (used to seed a template). */
export function saveConfig(config: ServerConfig): void {
  mkdirSync(CONFIG_DIR, {recursive: true});
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
