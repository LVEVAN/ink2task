/**
 * Direct-to-Todoist client (no companion server).
 *
 * When a Todoist profile has an API token, the plugin talks straight to
 * Todoist's cloud API from the device -- SuperTask-style -- using React Native's
 * native fetch (no CORS limits). This mirrors what todoist-server does, but
 * on-device, so no server has to run.
 *
 * Uses the **unified API v1** (`/api/v1`). The old REST v2 (`/rest/v2`) was
 * deprecated and now returns HTTP 410. The big shape change from v2: list
 * endpoints (`/projects`, `/tasks`) are cursor-paginated -- they return
 * `{results: [...], next_cursor}` instead of a bare array -- so we page through
 * `next_cursor` to the end. Todoist still calls the title `content`, and
 * close/reopen still return 204 with no body.
 */
import type {RemoteReminder} from './macServer';

const API_BASE = 'https://api.todoist.com/api/v1';
const TIMEOUT_MS = 12000; // cloud round-trip; more generous than the LAN timeout
const PAGE_LIMIT = 200; // max items per page when paginating list endpoints

type Project = {id: string; name: string};
type Task = {
  id: string;
  content: string;
  due?: {date?: string; datetime?: string | null} | null;
  /** Todoist's own scale: 4=p1 (urgent, red flag) down to 1=p4 (normal, no flag). */
  priority?: number;
  /**
   * Position within the project (what drag-to-reorder in the app changes).
   *
   * v1 actually returns this as `child_order`; `order` is what the older REST v2
   * called it and is absent here. Live-verified 2026-08-22 -- which means the
   * old `sort((a,b) => a.order - b.order)` was sorting by undefined and doing
   * nothing at all. Both names are read so either shape works.
   */
  order?: number;
  child_order?: number;
  /** Set when the task is a subtask; null/absent for top-level tasks. */
  parent_id?: string | null;
};

/** A v1 list response: cursor-paginated wrapper (older API returned a bare array). */
type Paginated<T> = {results?: T[]; next_cursor?: string | null};

async function td(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      ...(ctrl ? {signal: ctrl.signal} : {}),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? {'Content-Type': 'application/json'} : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Todoist ${res.status}${text ? `: ${text}` : ''}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GETs a v1 list endpoint to completion, following `next_cursor`. Tolerates both
 * the paginated `{results, next_cursor}` shape and a bare array, so it keeps
 * working if Todoist changes it back or a proxy unwraps it.
 */
async function getAll<T>(token: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const cur = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const data = (await (await td(token, `${path}${sep}limit=${PAGE_LIMIT}${cur}`)).json()) as
      | T[]
      | Paginated<T>;
    if (Array.isArray(data)) {
      out.push(...data);
      cursor = null;
    } else {
      out.push(...(data.results ?? []));
      cursor = data.next_cursor ?? null;
    }
  } while (cursor);
  return out;
}

async function projects(token: string): Promise<Project[]> {
  return getAll<Project>(token, '/projects');
}

/** Resolves a project name to its id (exact, then case-insensitive). */
async function projectId(token: string, name: string): Promise<string> {
  const want = name.trim();
  const list = await projects(token);
  const match =
    list.find(p => p.name === want) ??
    list.find(p => p.name.toLowerCase() === want.toLowerCase());
  if (!match) throw new Error(`No Todoist project named "${name}" was found`);
  return match.id;
}

/** Project names, for the plugin's list picker. */
export async function todoistLists(token: string): Promise<string[]> {
  return (await projects(token))
    .map(p => p.name)
    .filter(n => !!n)
    .sort((a, b) => a.localeCompare(b));
}

/** Open tasks in the named project, in the plugin's RemoteReminder shape. */
export async function todoistReminders(token: string, listName: string): Promise<RemoteReminder[]> {
  const id = await projectId(token, listName);
  const tasks = await getAll<Task>(token, `/tasks?project_id=${encodeURIComponent(id)}`);
  return tasks
    .filter(t => t.id && typeof t.content === 'string')
    // The API doesn't guarantee list order matches the app's manual
    // (drag-to-reorder) order, so sort explicitly. v1 calls the field
    // `child_order`; `order` is the v2 name, kept as a fallback.
    .sort((a, b) => orderOf(a) - orderOf(b))
    .map(t => {
      const out: RemoteReminder = {id: t.id, title: t.content.trim() || '(untitled)'};
      // v1 puts the time inside due.date ("2026-07-29T13:00:00"); v2 had a
      // separate datetime. Keep the time (YYYY-MM-DDTHH:MM) when present.
      const dueRaw = t.due?.datetime ?? t.due?.date;
      if (dueRaw) out.due = dueRaw.includes('T') ? dueRaw.slice(0, 16) : dueRaw.slice(0, 10);
      // Todoist's raw priority is inverted from its own UI numbering: raw
      // 4 = the UI's "Priority 1" (most urgent) ... raw 1 = "Priority 4", which
      // Todoist itself shows with no flag at all (its default/unset state).
      // Mirror that exactly: 5 - raw gives the UI number, and raw 1 is skipped
      // so a plain, never-prioritized task stays flag-free, same as in Todoist.
      if (t.priority && t.priority > 1) out.priority = (5 - t.priority) as 1 | 2 | 3;
      // `/tasks` returns subtasks inline with their parents, so pass the link
      // through and let the page mark them (checklistPage's SUBTASK_PREFIX).
      if (t.parent_id) out.parentId = t.parent_id;
      return out;
    });
}

/** A task's manual position, under either the v1 or v2 field name. */
function orderOf(t: Task): number {
  return t.child_order ?? t.order ?? 0;
}

/**
 * The `order` value that puts a new task strictly FIRST in its project.
 *
 * `order: 1` is not enough: it TIES with anything already sitting at 1, and
 * Todoist keeps both (device 2026-08-22 -- two "at the start" captures both
 * landed at child_order 1, so the second appeared second). Negative values are
 * accepted and sort ahead of everything, verified live, so go one below the
 * current minimum. Each subsequent "at the start" task therefore lands above
 * the previous one, which is what adding to the top should do.
 */
async function firstOrder(token: string, projectId: string): Promise<number> {
  try {
    const tasks = await getAll<Task>(token, `/tasks?project_id=${encodeURIComponent(projectId)}`);
    const top = tasks.filter(t => !t.parent_id);
    if (top.length === 0) return 1;
    return Math.min(...top.map(orderOf)) - 1;
  } catch {
    // Position is a nicety; never fail a capture over it.
    return 1;
  }
}

/**
 * Creates a task in the named project; returns its id and stored title. When
 * `due` (an ISO "YYYY-MM-DD") is given, it's sent as Todoist's `due_date`.
 */
export async function todoistCreate(
  token: string,
  listName: string,
  title: string,
  due?: string | null,
  /** Creates it as a subtask of this task id (Todoist nests up to 5 deep). */
  parentId?: string,
  /** Put it at the TOP of the list instead of appending. */
  atStart?: boolean,
): Promise<{id: string; title: string}> {
  const id = await projectId(token, listName);
  const body: Record<string, unknown> = {content: title, project_id: id};
  if (due) body.due_date = due;
  // Todoist derives the child's project from the parent, but sending both is
  // consistent with the non-subtask path and matches what the API documents.
  if (parentId) body.parent_id = parentId;
  // Note `child_order` is NOT honoured as a REQUEST field (sending it appends
  // instead); `order` is the one that works on create.
  if (atStart) body.order = await firstOrder(token, id);
  const res = await td(token, '/tasks', {method: 'POST', body: JSON.stringify(body)});
  const task = (await res.json()) as Task;
  if (!task.id) throw new Error('Todoist did not return a task id');
  return {id: task.id, title: task.content ?? title};
}

/** Sets (or changes) a task's due date to an ISO "YYYY-MM-DD" (POST /tasks/{id}). */
export async function todoistSetDue(token: string, id: string, due: string): Promise<void> {
  await td(token, `/tasks/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({due_date: due}),
  });
}

/** Completes tasks by id (POST /tasks/{id}/close -> 204, no body). */
export async function todoistComplete(
  token: string,
  ids: string[],
): Promise<{completed: string[]; failed: string[]}> {
  const completed: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await td(token, `/tasks/${encodeURIComponent(id)}/close`, {method: 'POST'});
      completed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return {completed, failed};
}

/** Confirms the token works (used by Test connection). */
export async function todoistCheck(token: string): Promise<void> {
  await projects(token);
}
