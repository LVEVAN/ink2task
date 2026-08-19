/**
 * VTODO <-> plugin task-shape mapping, plus the same operation set
 * google-tasks-server/src/tasks.ts exposes (findListId, listTaskListTitles,
 * listIncompleteTasks, completeTask, uncompleteTask, createTask) so server.ts
 * can be structured identically regardless of backend. Uses ical.js to parse
 * and (re)serialize VTODO components rather than hand-rolling iCalendar's
 * line-folding/escaping rules.
 */
import {randomUUID} from 'node:crypto';
import ICAL from 'ical.js';
import {
  type CalDavDiscovery,
  type DavObject,
  listVtodoCollections,
  fetchVtodoObjects,
  getVtodoObject,
  putVtodoObject,
} from './caldav.js';

/** Matches the plugin's RemoteReminder: id, title, and an optional date-only due. */
export type RemoteTask = {
  id: string;
  title: string;
  /** "YYYY-MM-DD", or omitted. */
  due?: string;
};

export class ListNotFoundError extends Error {
  constructor(name: string) {
    super(`No Apple Reminders list titled "${name}" was found.`);
    this.name = 'ListNotFoundError';
  }
}

type Auth = {appleId: string; appPassword: string};

function parseIcal(text: string): {vcalendar: ICAL.Component; vtodo: ICAL.Component} {
  const vcalendar = new ICAL.Component(ICAL.parse(text));
  const vtodo = vcalendar.getFirstSubcomponent('vtodo');
  if (!vtodo) throw new Error('CalDAV object had no VTODO component.');
  return {vcalendar, vtodo};
}

function dueToDateString(vtodo: ICAL.Component): string | undefined {
  const due = vtodo.getFirstPropertyValue('due') as ICAL.Time | null;
  if (!due) return undefined;
  return due.toJSDate().toISOString().slice(0, 10);
}

function objectToRemoteTask(obj: DavObject): RemoteTask {
  const {vtodo} = parseIcal(obj.ical);
  const title = (vtodo.getFirstPropertyValue('summary') as string | null)?.trim() || '(untitled)';
  const out: RemoteTask = {id: obj.href, title};
  const due = dueToDateString(vtodo);
  if (due) out.due = due;
  return out;
}

/**
 * Resolves a list title to its collection, forgivingly: exact title, then
 * case-insensitive equals, then starts-with, then contains -- same fallback
 * chain as google-tasks-server's findListId, since Apple Reminders list
 * names don't carry the same "@color:" suffix junk Google Tasks titles
 * sometimes do, but a little slack still helps a mistyped setting connect.
 */
export async function findListId(
  auth: Auth,
  discovery: CalDavDiscovery,
  title: string,
): Promise<{url: string; displayName: string}> {
  const collections = await listVtodoCollections(auth.appleId, auth.appPassword, discovery);
  const want = title.trim();
  const wantN = want.toLowerCase();
  const norm = (c: {displayName: string}) => c.displayName.trim().toLowerCase();

  const match =
    collections.find(c => c.displayName === want) ??
    collections.find(c => norm(c) === wantN) ??
    collections.find(c => wantN && norm(c).startsWith(wantN)) ??
    collections.find(c => wantN && norm(c).includes(wantN));

  if (!match) throw new ListNotFoundError(title);
  return {url: match.url, displayName: match.displayName};
}

/** Every VTODO-capable list's display name, for the plugin's list picker. */
export async function listTaskListTitles(auth: Auth, discovery: CalDavDiscovery): Promise<string[]> {
  const collections = await listVtodoCollections(auth.appleId, auth.appPassword, discovery);
  return [...new Set(collections.map(c => c.displayName.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Incomplete tasks in the given list, oldest-first (by DTSTAMP, the closest VTODO has to Google Tasks' stable manual order). */
export async function listIncompleteTasks(auth: Auth, calendarUrl: string): Promise<RemoteTask[]> {
  const objects = await fetchVtodoObjects(auth.appleId, auth.appPassword, calendarUrl);
  const incomplete = objects.filter(obj => {
    const {vtodo} = parseIcal(obj.ical);
    const status = (vtodo.getFirstPropertyValue('status') as string | null)?.toUpperCase();
    return status !== 'COMPLETED' && status !== 'CANCELLED';
  });
  return incomplete.map(objectToRemoteTask);
}

/** Marks a task completed, using the ETag from a fresh fetch as If-Match so a concurrent edit is rejected rather than overwritten. */
export async function completeTask(auth: Auth, id: string): Promise<void> {
  const obj = await getVtodoObject(auth.appleId, auth.appPassword, id);
  const {vcalendar, vtodo} = parseIcal(obj.ical);
  vtodo.updatePropertyWithValue('status', 'COMPLETED');
  vtodo.updatePropertyWithValue('completed', ICAL.Time.now());
  vtodo.updatePropertyWithValue('percent-complete', 100);
  await putVtodoObject(auth.appleId, auth.appPassword, obj.href, vcalendar.toString(), {ifMatch: obj.etag});
}

/** Reverses a completion (the plugin's un-check flow). */
export async function uncompleteTask(auth: Auth, id: string): Promise<void> {
  const obj = await getVtodoObject(auth.appleId, auth.appPassword, id);
  const {vcalendar, vtodo} = parseIcal(obj.ical);
  vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
  vtodo.removeProperty('completed');
  vtodo.updatePropertyWithValue('percent-complete', 0);
  await putVtodoObject(auth.appleId, auth.appPassword, obj.href, vcalendar.toString(), {ifMatch: obj.etag});
}

/** Creates a task from captured text; returns its id (href) and stored title. */
export async function createTask(
  auth: Auth,
  calendarUrl: string,
  title: string,
): Promise<{id: string; title: string}> {
  const uid = `ink2task-${randomUUID()}`;
  const href = new URL(`${uid}.ics`, calendarUrl).toString();

  const vcalendar = new ICAL.Component('vcalendar');
  vcalendar.addPropertyWithValue('version', '2.0');
  vcalendar.addPropertyWithValue('prodid', '-//Ink2Task//caldav-server//EN');
  const vtodo = new ICAL.Component('vtodo');
  vtodo.addPropertyWithValue('uid', uid);
  vtodo.addPropertyWithValue('summary', title);
  vtodo.addPropertyWithValue('status', 'NEEDS-ACTION');
  vtodo.addPropertyWithValue('dtstamp', ICAL.Time.now());
  vcalendar.addSubcomponent(vtodo);

  await putVtodoObject(auth.appleId, auth.appPassword, href, vcalendar.toString(), {ifNoneMatch: true});
  return {id: href, title};
}
