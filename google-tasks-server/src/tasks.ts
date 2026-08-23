/**
 * Google Tasks operations, mapped onto the same shapes the plugin already
 * expects from mac-server. The plugin is backend-agnostic, so anything
 * Apple-Reminders-specific (priority, time-of-day dues) simply isn't produced
 * here -- Google Tasks doesn't model it. See the top-level README's
 * "Choosing a backend" note.
 */
import type {tasks_v1} from 'googleapis';

/** Matches the plugin's RemoteReminder: id, title, and an optional date-only due. */
export type RemoteTask = {
  id: string;
  title: string;
  /** "YYYY-MM-DD", or omitted. Google Tasks dues are date-only (no time). */
  due?: string;
  /**
   * Parent task id when this is a subtask; omitted for top-level tasks. Google
   * Tasks allows exactly one level of nesting (`Schema$Task.parent`).
   */
  parentId?: string;
};

export class ListNotFoundError extends Error {
  constructor(name: string) {
    super(`No Google Tasks list titled "${name}" was found.`);
    this.name = 'ListNotFoundError';
  }
}

/**
 * Some Google Tasks lists carry junk in their title (e.g. a trailing newline +
 * "@color:#767879" written by another app). Clean that off so titles display
 * and match on their real name -- the first line, minus a trailing color tag.
 */
export function cleanTitle(raw?: string | null): string {
  return (raw ?? '')
    .split('\n')[0]
    .replace(/\s*@color:#?[0-9a-fA-F]+\s*$/i, '')
    .trim();
}

/**
 * Resolves a task-list title to its id, forgivingly: exact title, then cleaned
 * title equals (case-insensitive), then cleaned starts-with, then contains. So
 * a plain "Inbox" still finds a list whose real title is "Inbox\n@color:#…".
 */
export async function findListId(
  tasks: tasks_v1.Tasks,
  title: string,
): Promise<string> {
  const lists = (await tasks.tasklists.list({maxResults: 100})).data.items ?? [];
  const want = title.trim();
  const wantN = cleanTitle(want).toLowerCase();
  const norm = (l: tasks_v1.Schema$TaskList) => cleanTitle(l.title).toLowerCase();

  const match =
    lists.find(l => l.title === want) ??
    lists.find(l => norm(l) === wantN) ??
    lists.find(l => wantN && norm(l).startsWith(wantN)) ??
    lists.find(l => wantN && norm(l).includes(wantN));

  if (!match?.id) throw new ListNotFoundError(title);
  return match.id;
}

/** Cleaned, de-duplicated titles of every task list, for the plugin's list picker. */
export async function listTaskListTitles(tasks: tasks_v1.Tasks): Promise<string[]> {
  const res = await tasks.tasklists.list({maxResults: 100});
  const cleaned = (res.data.items ?? [])
    .map(list => cleanTitle(list.title))
    .filter(t => !!t);
  return [...new Set(cleaned)].sort((a, b) => a.localeCompare(b));
}

/**
 * Incomplete tasks in the given list, oldest-first (by Google's manual
 * `position` order, which is stable between fetches). Paginates so lists longer
 * than one API page still come back whole.
 */
export async function listIncompleteTasks(
  tasks: tasks_v1.Tasks,
  listId: string,
): Promise<RemoteTask[]> {
  const items: tasks_v1.Schema$Task[] = [];
  let pageToken: string | undefined;
  do {
    const res = await tasks.tasks.list({
      tasklist: listId,
      showCompleted: false,
      showHidden: false,
      maxResults: 100,
      pageToken,
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return items
    .filter(task => task.id && task.status !== 'completed')
    .sort((a, b) => (a.position ?? '').localeCompare(b.position ?? ''))
    .map(task => {
      const out: RemoteTask = {
        id: task.id!,
        title: task.title?.trim() || '(untitled)',
      };
      // task.due is RFC3339 but Google Tasks only honors the date part.
      if (task.due) out.due = task.due.slice(0, 10);
      // Subtasks are returned flat alongside their parents, so pass the link
      // through for the page to mark.
      //
      // NOTE the `position` sort above does NOT put children under their
      // parents: Google scopes a child's position to its parent's own children,
      // so comparing the strings across a flat list scatters them (verified
      // 2026-08-22 -- a child sorted to row 1 with its parent at row 6). The
      // plugin reorders hierarchically after fetching, for every backend, since
      // Todoist has the same behaviour. See orderByHierarchy.
      if (task.parent) out.parentId = task.parent;
      return out;
    });
}

/** Marks a task completed. */
export async function completeTask(
  tasks: tasks_v1.Tasks,
  listId: string,
  taskId: string,
): Promise<void> {
  await tasks.tasks.patch({
    tasklist: listId,
    task: taskId,
    requestBody: {status: 'completed'},
  });
}

/** Reverses a completion (the plugin's un-check flow). */
export async function uncompleteTask(
  tasks: tasks_v1.Tasks,
  listId: string,
  taskId: string,
): Promise<void> {
  // Setting status back to needsAction clears the completed timestamp; sending
  // completed:null alongside makes that explicit for the API.
  await tasks.tasks.patch({
    tasklist: listId,
    task: taskId,
    requestBody: {status: 'needsAction', completed: null},
  });
}

/**
 * Creates a task from captured text; returns its id and stored title.
 *
 * Google Tasks inserts FIRST unless `previous` names the sibling to sit after.
 * So "end" looks up the current last sibling and inserts after it, and "start"
 * omits `previous`. For a subtask the sibling set is the parent's children, not
 * the top level -- see the plugin's newTaskPosition.
 */
export async function createTask(
  tasks: tasks_v1.Tasks,
  listId: string,
  title: string,
  due?: string,
  /**
   * Creates it as a subtask of this task id. Google Tasks allows exactly ONE
   * level of nesting, so passing a parent that is itself a subtask is rejected
   * by the API; the caller is responsible for not doing that.
   */
  parentId?: string,
  /** Put it at the TOP of the list instead of appending. */
  atStart?: boolean,
): Promise<{id: string; title: string}> {
  const requestBody: Record<string, string> = {title};
  if (due) requestBody.due = new Date(due + 'T00:00:00Z').toISOString();
  // `parent` and `previous` are insert PARAMETERS, not body fields.
  // `previous` names the sibling to insert AFTER, so omitting it means "first".
  //
  // That is why a subtask used to land at the TOP of its parent's children
  // (device 2026-08-22: "Bacon" became the first child, not the last): passing
  // `parent` alone omits `previous`. Appending needs BOTH -- the parent, and
  // that parent's current last child.
  const parentParam = parentId ? {parent: parentId} : {};
  const previous = atStart ? undefined : await lastSiblingTaskId(tasks, listId, parentId);

  let res;
  try {
    res = await tasks.tasks.insert({
      tasklist: listId,
      ...parentParam,
      ...(previous ? {previous} : {}),
      requestBody,
    });
  } catch (err) {
    // "Previous task id not found" (device 2026-08-22, on a handwritten "> Eggs").
    // `previous` has to name a sibling Google will accept as a position anchor,
    // and a completed or hidden one is not always addressable. Losing the task
    // over its POSITION is the worst outcome here -- the page redraw has already
    // erased the handwriting -- so fall back to inserting without a position.
    const msg = (err as Error)?.message ?? '';
    if (!previous || !/previous task/i.test(msg)) throw err;
    console.error(`Insert with previous=${previous} failed (${msg}); retrying unpositioned`);
    res = await tasks.tasks.insert({
      tasklist: listId,
      ...parentParam,
      requestBody,
    });
  }
  if (!res.data.id) throw new Error('Google Tasks did not return a task id');
  return {id: res.data.id, title: res.data.title ?? title};
}

/**
 * Id of the LAST sibling under `parentId`, or the last top-level task when
 * `parentId` is undefined. Undefined when there are no siblings yet, which
 * correctly makes the new task the first one.
 *
 * Only VISIBLE (not completed, not hidden) siblings are considered. Completed
 * tasks do still hold a position, which is why this used to include them, but
 * Google rejects a completed task as a `previous` anchor with "Previous task id
 * not found" -- and a task that fails to be created is far worse than one
 * positioned slightly early.
 */
async function lastSiblingTaskId(
  tasks: tasks_v1.Tasks,
  listId: string,
  parentId?: string,
): Promise<string | undefined> {
  const items: tasks_v1.Schema$Task[] = [];
  let pageToken: string | undefined;
  do {
    const res = await tasks.tasks.list({
      tasklist: listId,
      showCompleted: false,
      showHidden: false,
      maxResults: 100,
      pageToken,
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const siblings = items
    .filter(t => t.id && (parentId ? t.parent === parentId : !t.parent))
    .sort((a, b) => (a.position ?? '').localeCompare(b.position ?? ''));
  return siblings[siblings.length - 1]?.id ?? undefined;
}

/** Sets or clears the due date on an existing task. */
export async function updateTaskDue(
  tasks: tasks_v1.Tasks,
  listId: string,
  taskId: string,
  due: string,
): Promise<void> {
  await tasks.tasks.patch({
    tasklist: listId,
    task: taskId,
    requestBody: {due: new Date(due + 'T00:00:00Z').toISOString()},
  });
}
