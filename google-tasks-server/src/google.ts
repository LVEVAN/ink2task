/**
 * OAuth2 wiring for Google Tasks.
 *
 * Two consumers:
 *   - authorize.ts uses `oauthClient()` + a redirect URI to run the one-time
 *     consent flow and capture a refresh token.
 *   - server.ts uses `tasksClient()` to get an authenticated Tasks API client,
 *     built fresh from the stored refresh token so the short-lived access token
 *     is (re)minted on demand and never persisted across restarts.
 */
import './env.js';
import {google} from 'googleapis';
import type {tasks_v1} from 'googleapis';
import type {ServerConfig} from './config.js';

/** OAuth2 client instance type, derived so we don't import google-auth-library directly. */
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/** The single scope we need: full read/write to the user's Google Tasks. */
export const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

/** Loopback port used only during `npm run authorize` to catch the redirect. */
export function redirectPort(): number {
  const raw = process.env.OAUTH_REDIRECT_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 4571;
}

/** The loopback redirect URI, matching what a Desktop OAuth client allows. */
export function redirectUri(): string {
  return `http://127.0.0.1:${redirectPort()}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment or a .env file ` +
        `(copy .env.example to .env and fill it in).`,
    );
  }
  return value;
}

/** A bare OAuth2 client built from the app credentials in the environment. */
export function oauthClient(redirect: string = redirectUri()): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET'),
    redirect,
  );
}

/**
 * An authenticated Tasks API client for the ongoing server. The refresh token
 * is loaded from config and set as the credential; googleapis exchanges it for
 * a fresh access token on the first call and auto-refreshes when it expires, so
 * we never cache access tokens ourselves.
 */
let cachedAuth: OAuth2Client | null = null;

export function tasksClient(config: ServerConfig): tasks_v1.Tasks {
  if (!config.refreshToken) {
    throw new Error(
      'Not authorized yet. Run `npm run authorize` once to grant access to ' +
        'Google Tasks, then start the server.',
    );
  }
  // Reuse one authed client for the server's lifetime: googleapis caches the
  // short-lived access token on it and only re-mints when expired, so we avoid
  // a token-refresh round-trip to Google on every single request.
  if (!cachedAuth) {
    cachedAuth = oauthClient();
    cachedAuth.setCredentials({refresh_token: config.refreshToken});
  }
  return google.tasks({version: 'v1', auth: cachedAuth});
}

/**
 * Forces an access-token mint from the stored refresh token, so the server can
 * fail fast at startup with a clear message if the token is missing or revoked
 * rather than only erroring on the first plugin request.
 */
export async function verifyAuth(config: ServerConfig): Promise<void> {
  if (!config.refreshToken) {
    throw new Error('Not authorized yet. Run `npm run authorize` first.');
  }
  const auth = oauthClient();
  auth.setCredentials({refresh_token: config.refreshToken});
  await auth.getAccessToken();
}
