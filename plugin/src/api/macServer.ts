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
import {ticktickMoveReminder, ticktickDeleteReminder} from './ticktick';
// Static import is safe here (no cycle): ticktickSync.ts does NOT import this
// file -- it uses api/ticktick.ts's own ticktickComplete/ticktickUncomplete
// instead of this file's generic ones, specifically so this import can exist.
// See the comment on those functions in api/ticktick.ts.
import {pushTicktickDue, pushTicktickFields} from '../utils/ticktickSync';

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
  /**
   * Notes/description. Only ever set by TickTick today -- the other three
   * backends' servers don't send it, and nothing on the checklist page
   * currently has room to display it (see ticktickSync.ts's scope note).
   * Purely additive: existing code that never reads `.notes` is unaffected.
   */
  notes?: string;
  /**
   * Change-detection signal, TickTick only. TickTick tasks have no
   * modified-time field, but `etag` changes on every mutation (device-
   * verified) -- see TickTickSyncRecord in ../utils/config.ts for how this
   * drives conflict detection.
   */
  etag?: string;
};

/** The active profile's Todoist token (only meaningful in direct-Todoist mode). */
function token(config: Ink2TaskConfig): string {
  return activeProfileOf(config).token || '';
}

const TIMEOUT_MS = 6000;

/**
 * Human-readable name of whichever server this config's active profile talks
 * to, for error messages. This module is shared by all non-direct-Todoist
 * backends (Apple/Google/TickTick), so a bare "Mac server" in a timeout or
 * status error was misleading for the other two -- see serverLabel call sites.
 */
function serverLabel(config: Ink2TaskConfig): string {
  switch (activeProfileOf(config).backend) {
    case 'google':
      return 'Google Tasks server';
    case 'ticktick':
      return 'TickTick server';
    default:
      return 'Mac server';
  }
}

async function withTimeout<T>(promise: Promise<T>, config: Ink2TaskConfig): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out reaching ${serverLabel(config)}`)), TIMEOUT_MS),
    ),
  ]);
}

/**
 * Builds the server URL from host/port. Always assumed plain HTTP over the
 * LAN, until a real user (GitHub issue #2, 2026-08-19) reported using an
 * ngrok tunnel to test connectivity: ngrok's public address is HTTPS-only,
 * so a hardcoded `http://` here silently sent every request to the wrong
 * protocol on port 443 -- a TLS listener rejecting a plain-HTTP request,
 * which surfaces to the user as an opaque "can't reach server" with no clue
 * that the scheme was the problem. If the Host field itself already starts
 * with "http://" or "https://" (a tunnel/reverse-proxy address, not a bare
 * LAN IP), that scheme is respected instead of being overridden -- a bare
 * LAN IP/hostname (the normal case) is untouched and still gets plain HTTP.
 */
function baseUrl(config: Ink2TaskConfig): string {
  const host = config.host.trim();
  if (/^https?:\/\//i.test(host)) {
    return /:\d+$/.test(host) ? host : `${host}:${config.port}`;
  }
  return `http://${host}:${config.port}`;
}

/**
 * Every server here (mac-server, google-tasks-server, ticktick-server) sends
 * `{error: "..."}` on a non-2xx response with a specific, useful reason (e.g.
 * "No TickTick project named X was found") -- a bare "Server returned 404"
 * threw that away and left no way to tell a wrong list name from anything
 * else. Falls back to the generic message if the body isn't JSON or has no
 * `error` field (e.g. an unexpected proxy/gateway response).
 */
async function describeError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch {
    // body wasn't JSON (or was empty) -- fall through to the generic message
  }
  return fallback;
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
    const res = await withTimeout(fetch(`${baseUrl(config)}/health`), config);
    if (!res.ok) {
      return {ok: false, error: await describeError(res, `Server returned ${res.status}`)};
    }
    const data = await res.json();
    return {ok: true, listName: data.listName};
  } catch (e: any) {
    return {ok: false, error: e?.message || 'Could not reach the server'};
  }
}

/** Lists the names of every list, for the on-device list picker. */
export async function fetchLists(config: Ink2TaskConfig): Promise<string[]> {
  if (isDirectTodoist(config)) return todoistLists(token(config));
  const res = await withTimeout(fetch(`${baseUrl(config)}/lists`), config);
  if (!res.ok) {
    throw new Error(await describeError(res, `Server returned ${res.status} while loading lists`));
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
    config,
  );
  if (!res.ok) {
    throw new Error(await describeError(res, `Server returned ${res.status} while fetching reminders`));
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
    config,
  );
  if (!res.ok) {
    throw new Error(await describeError(res, `${serverLabel(config)} returned ${res.status} while completing reminders`));
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
    config,
  );
  if (!res.ok) {
    throw new Error(await describeError(res, `${serverLabel(config)} returned ${res.status} while creating the reminder`));
  }
  const data = await res.json();
  if (!data.id) throw new Error(`${serverLabel(config)} did not return a reminder id`);
  return {id: data.id, title: data.title ?? title};
}

/**
 * Sets the due date on an existing task to an ISO "YYYY-MM-DD" (from a
 * handwritten DUE cell on an already-synced row). Todoist and TickTick only
 * for now; mac-server and google-tasks-server don't expose this yet, so it
 * throws there and the caller logs it.
 *
 * The TickTick branch is conflict-aware (see pushTicktickDue in
 * ../utils/ticktickSync) -- Todoist's is not, since Todoist has no
 * change-detection field to compare against and this plugin has never
 * attempted conflict handling for it.
 */
export async function updateReminderDue(
  config: Ink2TaskConfig,
  id: string,
  due: string,
): Promise<void> {
  if (isDirectTodoist(config)) return todoistSetDue(token(config), id, due);
  if (activeProfileOf(config).backend === 'ticktick') return pushTicktickDue(config, id, due);
  throw new Error('Setting a due date is only supported for Todoist and TickTick right now');
}

/**
 * Updates a TickTick task's title/notes/due/priority. No equivalent exists
 * for the other backends yet (Todoist's direct client only has setDue), so
 * this is TickTick-only rather than dispatched like updateReminderDue --
 * there's nothing to dispatch TO for anyone else. Conflict-aware, same as
 * updateReminderDue's ticktick branch -- see pushTicktickFields.
 */
export async function updateReminderFields(
  config: Ink2TaskConfig,
  id: string,
  fields: {title?: string; notes?: string; due?: string | null; priority?: 1 | 2 | 3 | 4},
): Promise<void> {
  if (activeProfileOf(config).backend !== 'ticktick') {
    throw new Error('Editing task fields is only supported for TickTick right now');
  }
  return pushTicktickFields(config, id, fields);
}

/** Moves a TickTick task to a different project (list). TickTick-only -- see updateReminderFields. */
export async function moveReminder(
  config: Ink2TaskConfig,
  id: string,
  fromList: string,
  toList: string,
): Promise<void> {
  if (activeProfileOf(config).backend !== 'ticktick') {
    throw new Error('Moving a task between lists is only supported for TickTick right now');
  }
  return ticktickMoveReminder(config, id, fromList, toList);
}

/** Permanently deletes a TickTick task. TickTick-only -- see updateReminderFields. */
export async function deleteReminder(config: Ink2TaskConfig, id: string): Promise<void> {
  if (activeProfileOf(config).backend !== 'ticktick') {
    throw new Error('Deleting a task is only supported for TickTick right now');
  }
  return ticktickDeleteReminder(config, id);
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
    config,
  );
  if (!res.ok) {
    throw new Error(await describeError(res, `${serverLabel(config)} returned ${res.status} while un-completing reminders`));
  }
  const data = await res.json();
  return {uncompleted: data.uncompleted || [], failed: data.failed || []};
}
