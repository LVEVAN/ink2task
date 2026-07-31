/**
 * Todoist REST API v2 operations, mapped onto the shapes the plugin already
 * expects from the other backends. Plain fetch -- the API is small enough that
 * a dependency isn't worth it. Every call sends the personal token as a Bearer
 * header.
 *
 * A couple of Todoist-specific quirks the mapping smooths over:
 *   - Todoist calls a task's title `content`, not `title`.
 *   - Closing a task (POST /tasks/{id}/close) returns 204 No Content -- there's
 *     no JSON body to parse, unlike Google Tasks' PATCH.
 */
import type {ServerConfig} from './config.js';

const API_BASE = 'https://api.todoist.com/rest/v2';

/** Matches the plugin's RemoteReminder: id, title, and an optional due string. */
export type RemoteTask = {
  id: string;
  title: string;
  /** "YYYY-MM-DD", or "YYYY-MM-DDTHH:MM" when the task has a time, or omitted. */
  due?: string;
};

export class ListNotFoundError extends Error {
  constructor(name: string) {
    super(`No Todoist project named "${name}" was found.`);
    this.name = 'ListNotFoundError';
  }
}

type Project = {id: string; name: string};
type Task = {
  id: string;
  content: string;
  due?: {date?: string; datetime?: string | null} | null;
};

/** Fetches a Todoist REST endpoint with the Bearer token; throws on non-2xx. */
async function api(
  config: ServerConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!config.token) {
    throw new Error(
      'No Todoist token set. Paste your personal API token into ' +
        '~/.ink2task-todoist/config.json, then restart.',
    );
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(init.body ? {'Content-Type': 'application/json'} : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Todoist API ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res;
}

async function projects(config: ServerConfig): Promise<Project[]> {
  const res = await api(config, '/projects');
  return (await res.json()) as Project[];
}

/**
 * Resolves a project name to its id, forgivingly: exact match, then
 * case-insensitive. Project names are clean in Todoist, so this stays simple.
 */
export async function findProjectId(config: ServerConfig, name: string): Promise<string> {
  const want = name.trim();
  const list = await projects(config);
  const match =
    list.find(p => p.name === want) ??
    list.find(p => p.name.toLowerCase() === want.toLowerCase());
  if (!match) throw new ListNotFoundError(name);
  return match.id;
}

/** Project names, for the plugin's list picker. */
export async function listProjectNames(config: ServerConfig): Promise<string[]> {
  return (await projects(config))
    .map(p => p.name)
    .filter(n => !!n)
    .sort((a, b) => a.localeCompare(b));
}

/** Open (incomplete) tasks in a project, mapped to the plugin's shape. */
export async function listOpenTasks(
  config: ServerConfig,
  projectId: string,
): Promise<RemoteTask[]> {
  const res = await api(config, `/tasks?project_id=${encodeURIComponent(projectId)}`);
  const tasks = (await res.json()) as Task[];
  return tasks
    .filter(t => t.id && typeof t.content === 'string')
    .map(t => {
      const out: RemoteTask = {id: t.id, title: t.content.trim() || '(untitled)'};
      // Todoist's due carries `datetime` (RFC3339) when a time is set, else
      // `date` (date-only). Map to the plugin's "YYYY-MM-DD[THH:MM]" format.
      if (t.due?.datetime) out.due = t.due.datetime.slice(0, 16);
      else if (t.due?.date) out.due = t.due.date.slice(0, 10);
      return out;
    });
}

/** Creates a task from captured text; returns its id and stored title. */
export async function createTask(
  config: ServerConfig,
  projectId: string,
  title: string,
): Promise<{id: string; title: string}> {
  const res = await api(config, '/tasks', {
    method: 'POST',
    // Todoist calls the title field "content".
    body: JSON.stringify({content: title, project_id: projectId}),
  });
  const task = (await res.json()) as Task;
  if (!task.id) throw new Error('Todoist did not return a task id');
  return {id: task.id, title: task.content ?? title};
}

/**
 * Completes a task. POST /tasks/{id}/close returns 204 No Content on success --
 * there is NO response body to read, so we only rely on api() not throwing.
 */
export async function closeTask(config: ServerConfig, taskId: string): Promise<void> {
  await api(config, `/tasks/${encodeURIComponent(taskId)}/close`, {method: 'POST'});
}

/** Reverses a completion (POST /tasks/{id}/reopen, also a 204). */
export async function reopenTask(config: ServerConfig, taskId: string): Promise<void> {
  await api(config, `/tasks/${encodeURIComponent(taskId)}/reopen`, {method: 'POST'});
}

/** Confirms the token works (used at startup to fail fast with a clear message). */
export async function verifyToken(config: ServerConfig): Promise<void> {
  await api(config, '/projects');
}
