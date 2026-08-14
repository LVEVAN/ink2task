/**
 * TickTick (Open API) OAuth client + task/project operations.
 *
 * There is no official TickTick SDK, so this is plain fetch -- same approach
 * as todoist-server, which is architecturally the closest sibling here (a
 * cloud REST API, no local daemon like EventKit, no SDK like googleapis).
 *
 * ⚠️ VERIFIED-VS-ASSUMED, read before touching this file:
 * The official docs at developer.ticktick.com could not be fetched directly
 * (blocked/404 from this environment), so this was built against several
 * independent third-party transcriptions and then DEVICE-VERIFIED against a
 * real account (2026-08-11: full create/get/update/complete/uncomplete/
 * move/delete round-trip, see ticktick-server's git history for the session).
 * Confirmed live: Basic auth for the token exchange, `content` as the notes
 * field, and the status:0 uncomplete fallback (see server.ts) all work
 * exactly as implemented. One thing remains genuinely untested:
 *   - Whether POST /task/{id} with a new projectId moves the task, or
 *     whether /task/move is required (see moveTask) -- never tested either
 *     way, because this code always uses the dedicated /task/move endpoint
 *     (confirmed working) and never relies on the ambiguous path.
 */
import './env.js';
import type {ServerConfig} from './config.js';
import {saveConfig} from './config.js';

const AUTH_BASE = 'https://ticktick.com/oauth';
const API_BASE = 'https://api.ticktick.com/open/v1';
export const TICKTICK_SCOPE = 'tasks:read tasks:write';

// ---------------------------------------------------------------------------
// Errors -- typed so callers (server.ts, and eventually the sync engine) can
// react differently to "you need to reconnect" vs. "TickTick is unreachable"
// vs. "that task/project is gone" without parsing message strings.
// ---------------------------------------------------------------------------

/** The access token is missing, expired, or was rejected -- reconnect needed. */
export class TickTickAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TickTickAuthError';
  }
}

/** The requested task or project doesn't exist (404) -- e.g. deleted remotely. */
export class TickTickNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TickTickNotFoundError';
  }
}

/** Any other non-2xx response from the API. */
export class TickTickApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TickTickApiError';
  }
}

/** The request didn't complete within the timeout -- network/outage, not auth. */
export class TickTickTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TickTickTimeoutError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment or a .env file ` +
        `(copy credentials.example.env to credentials.env and fill it in).`,
    );
  }
  return value;
}

export function clientId(): string {
  return requireEnv('TICKTICK_CLIENT_ID');
}

function clientSecret(): string {
  return requireEnv('TICKTICK_CLIENT_SECRET');
}

/** Loopback port used only during `npm run authorize` to catch the redirect. */
export function redirectPort(): number {
  const raw = process.env.OAUTH_REDIRECT_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 4577;
}

/**
 * The loopback redirect URI. Includes a concrete path (not just the bare
 * origin) because this must match EXACTLY what's registered in the TickTick
 * Developer Center, and several OAuth providers reject a bare-origin
 * registration -- safer to commit to a specific path from the start.
 */
export function redirectUri(): string {
  return `http://127.0.0.1:${redirectPort()}/oauth/callback`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  /**
   * Seconds until expiry, per standard OAuth2 -- but TickTick's actual
   * behavior here is UNCONFIRMED (not stated in any source checked). Treated
   * as optional; see config.ts's accessTokenExpiresAt for the fallback.
   */
  expires_in?: number;
};

type Tokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

function tokensFromResponse(json: TokenResponse): Tokens {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt:
      typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

/** Builds the URL to send the user's browser to for the consent screen. */
export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    scope: TICKTICK_SCOPE,
    state,
    redirect_uri: redirectUri(),
    response_type: 'code',
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * HTTP Basic auth for the client credentials -- device-confirmed working
 * 2026-08-11 (`npm run authorize` completed end to end). Sources had
 * disagreed with client_secret_post (form body); the commented fallback
 * below is kept only as a historical note, not because this is in doubt.
 */
export async function exchangeCode(code: string): Promise<Tokens> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    // If Basic auth turns out to be wrong, uncomment these two and drop the
    // Authorization header below instead:
    // client_id: clientId(),
    // client_secret: clientSecret(),
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TickTickAuthError(`Token exchange failed (${res.status})${text ? `: ${text}` : ''}`);
  }
  return tokensFromResponse((await res.json()) as TokenResponse);
}

/** Exchanges a refresh token for a new access token (and possibly a new refresh token). */
export async function refreshTokens(refreshToken: string): Promise<Tokens> {
  const basic = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TickTickAuthError(
      `Token refresh failed (${res.status})${text ? `: ${text}` : ''}. ` +
        'The refresh token may have been revoked -- run `npm run authorize` again.',
    );
  }
  return tokensFromResponse((await res.json()) as TokenResponse);
}

// ---------------------------------------------------------------------------
// Authenticated request wrapper
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 12_000; // cloud round-trip; matches the plugin's own direct-Todoist client

/** True when we KNOW the token is expired, or don't know either way. */
function shouldRefreshProactively(config: ServerConfig): boolean {
  if (!config.accessTokenExpiresAt) return true; // unknown lifetime -- refresh to be safe
  return Date.now() > config.accessTokenExpiresAt - 60_000; // 60s safety margin
}

async function doRefresh(config: ServerConfig): Promise<ServerConfig> {
  if (!config.refreshToken) {
    throw new TickTickAuthError('Not connected. Run `npm run authorize` first.');
  }
  const tokens = await refreshTokens(config.refreshToken);
  const next: ServerConfig = {
    ...config,
    accessToken: tokens.accessToken,
    // Not every refresh response includes a new refresh token; keep the old
    // one in that case. When it DOES include one, the old one may already be
    // invalidated server-side, so we must not keep using it.
    refreshToken: tokens.refreshToken ?? config.refreshToken,
    accessTokenExpiresAt: tokens.expiresAt,
  };
  // Persist immediately -- if the process dies right after this, we'd rather
  // have the fresh token on disk than force the user through authorize again.
  saveConfig(next);
  return next;
}

/**
 * Fetches a TickTick Open API endpoint with the access token, refreshing
 * proactively when we believe it's expired (or don't know), and reactively
 * once more on an actual 401 in case our tracking was wrong. Never logs the
 * token or the request/response body -- see the logging rule in server.ts.
 */
export async function ticktickFetch(
  config: ServerConfig,
  path: string,
  init: RequestInit = {},
): Promise<{res: Response; config: ServerConfig}> {
  let cfg = config;
  if (!cfg.accessToken || shouldRefreshProactively(cfg)) {
    cfg = cfg.refreshToken ? await doRefresh(cfg) : cfg;
  }
  if (!cfg.accessToken) {
    throw new TickTickAuthError('Not connected. Run `npm run authorize` first.');
  }

  const attempt = async (accessToken: string): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? {'Content-Type': 'application/json'} : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new TickTickTimeoutError(`TickTick did not respond within ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt(cfg.accessToken);
  if (res.status === 401 && cfg.refreshToken) {
    // Our expiry tracking said this token was fine, but the server disagreed.
    // Refresh once more and retry exactly once -- never loop.
    cfg = await doRefresh(cfg);
    res = await attempt(cfg.accessToken!);
  }
  if (res.status === 401) {
    throw new TickTickAuthError('TickTick rejected the access token. Run `npm run authorize` again.');
  }
  if (res.status === 404) {
    const text = await res.text().catch(() => '');
    throw new TickTickNotFoundError(`Not found${text ? `: ${text}` : ''}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TickTickApiError(res.status, `TickTick API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return {res, config: cfg};
}

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

/** Raw TickTick project shape (the fields we actually use). */
export type TickTickProject = {
  id: string;
  name: string;
};

/** Raw TickTick task shape (the fields we actually use). */
export type TickTickTaskRaw = {
  id: string;
  projectId: string;
  title?: string;
  /**
   * Notes/description. `content` is confirmed as the correct field --
   * device-verified 2026-08-11: wrote `content` via the update endpoint,
   * read it back correctly via GET. `desc` is still read defensively as a
   * fallback (see mapTask) in case some task predates this and only has
   * `desc` set, but is never written -- there's no evidence it needs to be.
   */
  content?: string;
  desc?: string;
  isAllDay?: boolean;
  dueDate?: string; // "yyyy-MM-dd'T'HH:mm:ssZ"
  timeZone?: string; // IANA zone, e.g. "America/Los_Angeles"
  priority?: number; // 0 | 1 | 3 | 5
  status?: number; // 0 = active, 2 = completed (corroborated by multiple third-party integrations, not seen first-party)
  /** Present on GET responses; used as our change-detection signal since
   * TickTick tasks carry no documented modified/updated timestamp. */
  etag?: string;
  /**
   * TickTick's manual ordering position within a project -- a signed integer,
   * ascending = the order shown in the TickTick app. The `/project/{id}/data`
   * endpoint does NOT return tasks pre-sorted by this (device-confirmed: the
   * plugin's checklist order didn't match the app), so listProjectTasks sorts
   * by it explicitly below.
   */
  sortOrder?: number;
};

export type TickTickProjectData = {
  project: TickTickProject;
  tasks: TickTickTaskRaw[];
};

/**
 * The shape the sync engine (Stage 3) will work with -- a cleaned-up version
 * of TickTickTaskRaw with the plugin's date format and priority tier, but
 * NOT yet the plugin's wire type (RemoteReminder), which is narrower and
 * lives in the plugin repo. Mapping down to that happens in server.ts once
 * the HTTP contract is extended (Stage 3).
 */
export type RemoteTask = {
  id: string;
  projectId: string;
  title: string;
  notes?: string;
  /** "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM" when the task has a time, or omitted. */
  due?: string;
  /** 1 (most urgent) - 4, matching the plugin's existing priority scale, or
   * absent for TickTick's "None" tier. TickTick has no 5th tier, so plugin
   * priority 4 is never produced here -- same situation Apple Reminders is
   * already in (see plugin/src/api/macServer.ts). */
  priority?: 1 | 2 | 3 | 4;
  completed: boolean;
  /** Change-detection signal for the sync engine -- see TickTickTaskRaw.etag. */
  etag?: string;
  /** See TickTickTaskRaw.sortOrder. Sorted on already by listProjectTasks --
   * kept here mainly so callers/tests can assert on it. */
  sortOrder?: number;
};

/** TickTick raw priority (0/1/3/5) -> the plugin's 1-4 scale, or undefined for "None". */
export function priorityFromTickTick(raw: number | undefined): 1 | 2 | 3 | 4 | undefined {
  switch (raw) {
    case 5:
      return 1; // High -> most urgent
    case 3:
      return 2; // Medium
    case 1:
      return 3; // Low
    default:
      return undefined; // 0 / None / unrecognized -- no flag, matches Todoist's raw-1 "no flag" convention
  }
}

/** The plugin's 1-4 scale -> TickTick's raw priority. Inverse of priorityFromTickTick. */
export function priorityToTickTick(tier: 1 | 2 | 3 | 4 | undefined): 0 | 1 | 3 | 5 {
  switch (tier) {
    case 1:
      return 5;
    case 2:
      return 3;
    case 3:
      return 1;
    default:
      return 0; // tiers 4 and undefined both collapse to "None" -- TickTick has no 4th tier
  }
}

/**
 * TickTick's dueDate ("yyyy-MM-dd'T'HH:mm:ssZ") -> the plugin's simpler
 * "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:MM" (timed) format, matching what
 * every other backend already produces (see mac-server's dueString, or
 * todoist-server's due mapping).
 */
export function dueFromTickTick(dueDate: string | undefined, isAllDay: boolean | undefined): string | undefined {
  if (!dueDate) return undefined;
  if (isAllDay) return dueDate.slice(0, 10);
  // dueDate carries an offset (e.g. +0000); slicing to minute precision drops
  // the offset and gives a naive local-looking datetime, same simplification
  // the plugin already applies to Todoist's due.datetime.
  return dueDate.slice(0, 16);
}

/**
 * The plugin's "YYYY-MM-DD" / "YYYY-MM-DDTHH:MM" -> TickTick's dueDate +
 * isAllDay + timeZone, for writes. timeZone defaults to this SERVER's local
 * zone, since the plugin's date input carries no zone info of its own --
 * documented explicitly because it's a real behavioral choice, not an
 * incidental default.
 */
export function dueToTickTick(
  due: string,
): {dueDate: string; isAllDay: boolean; timeZone: string} {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hasTime = due.length > 10;
  if (!hasTime) {
    return {dueDate: `${due}T00:00:00+0000`, isAllDay: true, timeZone};
  }
  // "YYYY-MM-DDTHH:MM" -> "YYYY-MM-DDTHH:MM:00+0000". Using +0000 (UTC) and
  // relying on the separate timeZone field for TickTick to interpret it
  // matches how TickTick's own examples pair the two fields.
  return {dueDate: `${due}:00+0000`, isAllDay: false, timeZone};
}

/** Raw TickTick task -> the sync engine's RemoteTask. */
export function mapTask(raw: TickTickTaskRaw): RemoteTask {
  return {
    id: raw.id,
    projectId: raw.projectId,
    title: raw.title?.trim() || '(untitled)',
    notes: (raw.content ?? raw.desc)?.trim() || undefined,
    due: dueFromTickTick(raw.dueDate, raw.isAllDay),
    priority: priorityFromTickTick(raw.priority),
    completed: raw.status === 2,
    etag: raw.etag,
    sortOrder: raw.sortOrder,
  };
}

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

export async function listProjects(config: ServerConfig): Promise<{projects: TickTickProject[]; config: ServerConfig}> {
  const {res, config: next} = await ticktickFetch(config, '/project');
  const projects = (await res.json()) as TickTickProject[];
  return {projects, config: next};
}

/**
 * Tasks in one project via the project's /data endpoint -- there is no
 * documented "list all tasks" endpoint across every project. Sorted by
 * sortOrder ascending to match the manual order shown in the TickTick app;
 * the endpoint's own response order doesn't (device-confirmed). Tasks
 * missing sortOrder (shouldn't happen, but the field isn't documented as
 * required) sort after everything that has one, keeping the sort stable
 * rather than throwing them to the top via `undefined`'s NaN comparison.
 */
export async function listProjectTasks(
  config: ServerConfig,
  projectId: string,
): Promise<{tasks: RemoteTask[]; config: ServerConfig}> {
  let res, next;
  try {
    ({res, config: next} = await ticktickFetch(config, `/project/${encodeURIComponent(projectId)}/data`));
  } catch (err) {
    // See resolveProject's comment (server.ts) -- ids matching this pattern
    // are TickTick's special system-Inbox pseudo-project, which is known
    // (device-reported, not officially documented) to 404 on this same
    // endpoint that works for a normal project. Re-thrown with a pointer to
    // the actual fix rather than a bare "Not found", since the underlying
    // TickTickNotFoundError gives no hint that the PROJECT NAME was right.
    if (err instanceof TickTickNotFoundError && /^inbox/i.test(projectId)) {
      throw new TickTickNotFoundError(
        `TickTick's built-in Inbox can't be synced directly (its API doesn't ` +
          `support this the way a normal list does). Create or use a regular ` +
          `list instead of Inbox, and select that in the plugin's Settings.`,
      );
    }
    throw err;
  }
  const data = (await res.json()) as TickTickProjectData;
  const tasks = (data.tasks ?? []).map(mapTask).sort((a, b) => {
    if (a.sortOrder === undefined && b.sortOrder === undefined) return 0;
    if (a.sortOrder === undefined) return 1;
    if (b.sortOrder === undefined) return -1;
    return a.sortOrder - b.sortOrder;
  });
  return {tasks, config: next};
}

export async function getTask(
  config: ServerConfig,
  projectId: string,
  taskId: string,
): Promise<{task: RemoteTask; config: ServerConfig}> {
  const {res, config: next} = await ticktickFetch(
    config,
    `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
  );
  const raw = (await res.json()) as TickTickTaskRaw;
  return {task: mapTask(raw), config: next};
}

export type CreateTaskInput = {
  projectId: string;
  title: string;
  notes?: string;
  due?: string;
  priority?: 1 | 2 | 3 | 4;
};

export async function createTask(
  config: ServerConfig,
  input: CreateTaskInput,
): Promise<{task: RemoteTask; config: ServerConfig}> {
  const body: Record<string, unknown> = {
    projectId: input.projectId,
    title: input.title,
  };
  if (input.notes) body.content = input.notes;
  if (input.priority !== undefined) body.priority = priorityToTickTick(input.priority);
  if (input.due) Object.assign(body, dueToTickTick(input.due));

  const {res, config: next} = await ticktickFetch(config, '/task', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as TickTickTaskRaw;
  return {task: mapTask(raw), config: next};
}

export type UpdateTaskInput = {
  taskId: string;
  projectId: string;
  title?: string;
  notes?: string;
  /** Explicit null clears the due date; undefined leaves it unchanged. */
  due?: string | null;
  priority?: 1 | 2 | 3 | 4 | undefined;
};

/**
 * Updates title/notes/due/priority. Does NOT change project -- see moveTask,
 * which is the dedicated (and unambiguous) way to do that.
 */
export async function updateTask(
  config: ServerConfig,
  input: UpdateTaskInput,
): Promise<{task: RemoteTask; config: ServerConfig}> {
  const body: Record<string, unknown> = {
    id: input.taskId,
    projectId: input.projectId,
  };
  if (input.title !== undefined) body.title = input.title;
  if (input.notes !== undefined) body.content = input.notes;
  if (input.priority !== undefined) body.priority = priorityToTickTick(input.priority);
  if (input.due === null) {
    body.dueDate = null;
  } else if (input.due) {
    Object.assign(body, dueToTickTick(input.due));
  }

  const {res, config: next} = await ticktickFetch(config, `/task/${encodeURIComponent(input.taskId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as TickTickTaskRaw;
  return {task: mapTask(raw), config: next};
}

/** Moves a task to a different project via the dedicated endpoint (see the
 * file-level note on why this is never done through updateTask instead). */
export async function moveTask(
  config: ServerConfig,
  args: {taskId: string; fromProjectId: string; toProjectId: string},
): Promise<{config: ServerConfig}> {
  const {config: next} = await ticktickFetch(config, '/task/move', {
    method: 'POST',
    body: JSON.stringify([
      {taskId: args.taskId, fromProjectId: args.fromProjectId, toProjectId: args.toProjectId},
    ]),
  });
  return {config: next};
}

export async function completeTask(
  config: ServerConfig,
  projectId: string,
  taskId: string,
): Promise<{config: ServerConfig}> {
  const {config: next} = await ticktickFetch(
    config,
    `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
    {method: 'POST'},
  );
  return {config: next};
}

export async function deleteTask(
  config: ServerConfig,
  projectId: string,
  taskId: string,
): Promise<{config: ServerConfig}> {
  const {config: next} = await ticktickFetch(
    config,
    `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
    {method: 'DELETE'},
  );
  return {config: next};
}

/**
 * Forces a token refresh/verify so the server can fail fast at startup with a
 * clear message if not authorized, rather than only erroring on the first
 * plugin request -- same pattern as google-tasks-server's verifyAuth.
 *
 * Gated on accessToken, NOT refreshToken: device-confirmed 2026-08-11 that
 * TickTick's token response does not include a refresh_token (the access
 * token itself is long-lived -- ~180 days in that run). A refreshToken-only
 * check would report "not authorized" right after a successful authorize.
 */
export async function verifyAuth(config: ServerConfig): Promise<ServerConfig> {
  if (!config.accessToken) {
    throw new TickTickAuthError('Not authorized yet. Run `npm run authorize` first.');
  }
  const {config: next} = await listProjects(config);
  return next;
}
