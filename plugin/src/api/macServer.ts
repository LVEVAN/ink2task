/**
 * Thin client for the Ink2Task Mac companion server.
 *
 * The SDK ships no networking module (confirmed in SDK-REFERENCE.md), so
 * this uses React Native's built-in global `fetch`, same approach the
 * SDK docs point to for plugins that need a network call.
 *
 * There's no cloud service involved -- the plugin talks directly to a
 * small HTTP server the Mac runs on the same wifi network. See
 * mac-server/ for that half.
 */
import type {Ink2TaskConfig} from '../utils/config';
import {isDirectTodoist, activeProfileOf} from '../utils/config';
import {
  todoistLists,
  todoistReminders,
  todoistCreate,
  todoistComplete,
  todoistCheck,
  todoistSetDue,
} from './todoist';

export type RemoteReminder = {
  id: string;
  title: string;
  /** Due date as "YYYY-MM-DD" from the Mac, or absent/null if none. */
  due?: string | null;
  /**
   * The backend's own priority tier, 1 (most urgent) upward -- matches
   * Todoist's own p1-p4 numbering exactly (its API's raw scale is inverted:
   * raw 4 = p1/urgent = `priority: 1` here; raw 1 = p4/default, which Todoist
   * itself shows with no flag, so absent here too -- see todoist.ts).
   *
   * Apple Reminders only has 3 flagged tiers (High/Medium/Low, EKReminder's raw
   * priority 1-4/5/6-9), mapped by mac-server's Reminders.swift to 1/2/3 --
   * there's no Apple equivalent of Todoist's p4, so 4 only ever comes from
   * Todoist. Google Tasks has no priority concept, so this is never set there.
   *
   * Drives ONLY the flag drawn in checklistPage.ts -- it does not affect row
   * order (sort-to-top was tried in 0.2.85 and reverted).
   */
  priority?: 1 | 2 | 3 | 4;
};

/** The active profile's Todoist token (only meaningful in direct-Todoist mode). */
function token(config: Ink2TaskConfig): string {
  return activeProfileOf(config).token || '';
}

const TIMEOUT_MS = 6000;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out reaching Mac server')), TIMEOUT_MS),
    ),
  ]);
}

function baseUrl(config: Ink2TaskConfig): string {
  return `http://${config.host}:${config.port}`;
}

/** Confirms the Mac server is reachable and talking to the right list. */
export async function checkHealth(
  config: Ink2TaskConfig,
): Promise<{ok: true; listName: string} | {ok: false; error: string}> {
  try {
    if (isDirectTodoist(config)) {
      await todoistCheck(token(config));
      return {ok: true, listName: config.listName};
    }
    const res = await withTimeout(fetch(`${baseUrl(config)}/health`));
    if (!res.ok) return {ok: false, error: `Server returned ${res.status}`};
    const data = await res.json();
    return {ok: true, listName: data.listName};
  } catch (e: any) {
    return {ok: false, error: e?.message || 'Could not reach the server'};
  }
}

/** Lists the names of every list, for the on-device list picker. */
export async function fetchLists(config: Ink2TaskConfig): Promise<string[]> {
  if (isDirectTodoist(config)) return todoistLists(token(config));
  const res = await withTimeout(fetch(`${baseUrl(config)}/lists`));
  if (!res.ok) {
    throw new Error(`Server returned ${res.status} while loading lists`);
  }
  const data = await res.json();
  return data.lists || [];
}

/** Fetches the current incomplete reminders from the configured list. */
export async function fetchReminders(
  config: Ink2TaskConfig,
): Promise<RemoteReminder[]> {
  if (isDirectTodoist(config)) return todoistReminders(token(config), config.listName);
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/reminders?list=${encodeURIComponent(config.listName)}`),
  );
  if (!res.ok) {
    throw new Error(`Server returned ${res.status} while fetching reminders`);
  }
  const data = await res.json();
  return data.reminders || [];
}

/**
 * Marks the given reminder IDs as completed in Apple Reminders.
 * Returns which ones actually succeeded, since the page should only drop
 * items the Mac confirmed -- not everything that was checked.
 */
export async function completeReminders(
  config: Ink2TaskConfig,
  ids: string[],
): Promise<{completed: string[]; failed: string[]}> {
  if (ids.length === 0) return {completed: [], failed: []};
  if (isDirectTodoist(config)) return todoistComplete(token(config), ids);
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/complete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      // `list` tells the Google backend which task list the ids live in; the
      // Apple backend ignores it (its ids are globally unique).
      body: JSON.stringify({ids, list: config.listName}),
    }),
  );
  if (!res.ok) {
    throw new Error(`Mac server returned ${res.status} while completing reminders`);
  }
  const data = await res.json();
  return {completed: data.completed || [], failed: data.failed || []};
}

/**
 * Creates a new reminder from captured text; returns its id and title. `due`, if
 * given, is an ISO "YYYY-MM-DD" from a handwritten DUE cell. Server backends get
 * it in the body too (they ignore it until they add support).
 */
export async function createReminder(
  config: Ink2TaskConfig,
  title: string,
  due?: string | null,
): Promise<{id: string; title: string}> {
  if (isDirectTodoist(config)) return todoistCreate(token(config), config.listName, title, due);
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/reminders`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title, list: config.listName, ...(due ? {due} : {})}),
    }),
  );
  if (!res.ok) {
    throw new Error(`Mac server returned ${res.status} while creating the reminder`);
  }
  const data = await res.json();
  if (!data.id) throw new Error('Mac server did not return a reminder id');
  return {id: data.id, title: data.title ?? title};
}

/**
 * Sets the due date on an existing task to an ISO "YYYY-MM-DD" (from a
 * handwritten DUE cell on an already-synced row). Todoist only for now; the LAN
 * servers don't expose this yet, so it throws there and the caller logs it.
 */
export async function updateReminderDue(
  config: Ink2TaskConfig,
  id: string,
  due: string,
): Promise<void> {
  if (isDirectTodoist(config)) return todoistSetDue(token(config), id, due);
  throw new Error('Setting a due date is only supported for Todoist right now');
}

/** Reverses completion for the given reminder IDs (the un-check flow). */
export async function uncompleteReminders(
  config: Ink2TaskConfig,
  ids: string[],
): Promise<{uncompleted: string[]; failed: string[]}> {
  if (ids.length === 0) return {uncompleted: [], failed: []};
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/uncomplete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ids}),
    }),
  );
  if (!res.ok) {
    throw new Error(`Mac server returned ${res.status} while un-completing reminders`);
  }
  const data = await res.json();
  return {uncompleted: data.uncompleted || [], failed: data.failed || []};
}
