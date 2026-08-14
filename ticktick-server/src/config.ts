/**
 * Persistent config for the TickTick backend.
 *
 * Lives in the user's home directory (NOT in the repo, and deliberately
 * separate from the other backends' own ~/.ink2task* dirs so none of them
 * ever step on each other). Holds the long-lived OAuth tokens plus the
 * selected project, so the plugin sees an identical service shape regardless
 * of which backend is running.
 *
 * SECURITY: per the project's decision to keep OAuth entirely server-side
 * (see ticktick-server/README.md), this file holds BOTH the access token and
 * the refresh token. The Supernote device never receives either -- it only
 * ever talks to this server over the LAN, the same as every other backend.
 * That means this file is the single most sensitive thing this server
 * writes: treat ~/.ink2task-ticktick like you would a password vault, and
 * never print its contents in logs (see the "never log tokens" rule in
 * ticktick.ts).
 *
 * The application's OAuth client id/secret are NOT stored here -- they come
 * from the environment (.env / credentials.env). Only the per-user tokens are
 * persisted.
 */
import {homedir} from 'node:os';
import {join} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';

export type ServerConfig = {
  /** OAuth2 access token from the most recent authorize/refresh. */
  accessToken?: string;
  /** OAuth2 refresh token from `npm run authorize`; absent until then. */
  refreshToken?: string;
  /**
   * When accessToken expires, as an epoch-ms timestamp -- undefined if the
   * token response never included expires_in (TickTick's exact access-token
   * lifetime isn't documented anywhere I could find). When undefined, the
   * client treats the token as possibly-expired and refreshes proactively;
   * see shouldRefresh() in ticktick.ts.
   */
  accessTokenExpiresAt?: number;
  /** The TickTick project (list) id to sync. Undefined until chosen. */
  projectId?: string;
  /**
   * Cached display name for projectId, so the server (and the plugin, via
   * /health) can show a human-readable name without an extra API call on
   * every request. Refreshed whenever /lists is called.
   */
  projectName?: string;
  /** TCP port the HTTP server listens on. Next free slot after the other backends' 8952-8954. */
  port: number;
};

export const CONFIG_DIR = join(homedir(), '.ink2task-ticktick');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: ServerConfig = {
  port: 8955,
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
