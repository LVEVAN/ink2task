/**
 * Low-level CalDAV client: discovery, fetching VTODOs, and writing them back.
 * No task-shape mapping here -- that's tasks.ts, same split as
 * google-tasks-server's google.ts (auth/transport) vs tasks.ts (task shape).
 *
 * Talks to iCloud's CalDAV service (RFC 4791) with HTTP Basic auth using an
 * app-specific password. Apple's own discovery flow (documented informally,
 * confirmed against real account behavior):
 *   1. PROPFIND https://caldav.icloud.com/ -> redirects to the account's
 *      actual pod, e.g. https://pNN-caldav.icloud.com/
 *   2. PROPFIND that pod's root for <current-user-principal/> -> a href like
 *      /1234567890/principal/
 *   3. PROPFIND the principal for <calendar-home-set/> -> a href like
 *      /1234567890/calendars/
 * listVtodoCollections() then PROPFINDs the home-set (Depth: 1) to list the
 * actual reminder lists, filtered to ones whose supported-calendar-component-set
 * includes VTODO (iCloud's CalDAV exposes both event calendars and reminder
 * lists side by side under the same home-set).
 */
import {XMLParser} from 'fast-xml-parser';
import type {ServerConfig} from './config.js';

export class CalDavError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CalDavError';
    this.status = status;
  }
}

/** True for an auth rejection -- the app-specific password was never valid, or was revoked. */
export function isAuthError(err: unknown): boolean {
  return err instanceof CalDavError && (err.status === 401 || err.status === 403);
}

export type CalDavDiscovery = {
  server: string;
  principalUrl: string;
  homeSetUrl: string;
};

export type DavCollection = {
  url: string;
  displayName: string;
  ctag?: string;
};

export type DavObject = {
  href: string;
  etag: string;
  ical: string;
};

const TIMEOUT_MS = 15000;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
});

function basicAuthHeader(appleId: string, appPassword: string): string {
  return 'Basic ' + Buffer.from(`${appleId}:${appPassword}`).toString('base64');
}

/**
 * A single DAV request with a timeout and manual redirect-following.
 *
 * Redirects are followed BY HAND (rather than letting fetch do it) because
 * step 1 of discovery relies on a 301 from caldav.icloud.com to the account's
 * real pod for a PROPFIND request -- some fetch implementations rewrite
 * non-GET/HEAD methods to GET on a 301/302, which would silently turn the
 * PROPFIND into a plain GET and break discovery. Preserving method, headers,
 * and body across the hop keeps this predictable everywhere it runs
 * (Node, Cloudflare Workers, Cloud Run).
 */
async function davRequest(
  url: string,
  method: 'GET' | 'PROPFIND' | 'REPORT' | 'PUT',
  appleId: string,
  appPassword: string,
  opts: {body?: string; headers?: Record<string, string>} = {},
): Promise<{status: number; headers: Headers; text: string; url: string}> {
  let currentUrl = url;
  for (let redirects = 0; redirects < 5; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: basicAuthHeader(appleId, appPassword),
          'Content-Type': 'application/xml; charset=utf-8',
          ...opts.headers,
        },
        body: opts.body,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new CalDavError(`Timed out reaching ${new URL(currentUrl).host}`);
      }
      throw new CalDavError(`Could not reach ${new URL(currentUrl).host}: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new CalDavError(`Redirect from ${currentUrl} had no Location header`, res.status);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      // The bare "rejected" message is what the plugin/user sees, but the
      // raw body (often a DAV:error XML block naming the actual reason) is
      // appended here too, after a newline, purely for the server's own
      // console log -- server.ts's catch block only logs err.message and
      // never forwards it to the client, so this doesn't leak anything, it
      // just makes `npm start`'s terminal output useful for debugging a
      // per-collection 401 instead of every one looking identical.
      const detail = text.trim() ? `\n${method} ${currentUrl} -> ${res.status}\n${text.trim().slice(0, 2000)}` : '';
      throw new CalDavError(`Apple ID or app-specific password was rejected.${detail}`, res.status);
    }
    if (res.status >= 400) {
      throw new CalDavError(
        `CalDAV server returned ${res.status} for ${method} ${currentUrl}${text.trim() ? '\n' + text.trim().slice(0, 2000) : ''}`,
        res.status,
      );
    }
    return {status: res.status, headers: res.headers, text, url: currentUrl};
  }
  throw new CalDavError(`Too many redirects resolving ${url}`);
}

function resolveHref(base: string, href: string): string {
  return new URL(href, base).toString();
}

/** Finds the first <href> text anywhere under a parsed multistatus node. */
function findHref(node: unknown): string | undefined {
  if (node == null) return undefined;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findHref(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('href' in obj) return findHref(obj.href);
    if ('#text' in obj) return findHref(obj['#text']);
  }
  return undefined;
}

/** Normalizes fast-xml-parser's "one item vs array" ambiguity for repeated elements. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Runs the discovery chain (steps 1-3 above) and returns the results to
 * cache. Called once per account, not per sync -- see config.ts's
 * ServerConfig.discovery.
 */
export async function discover(appleId: string, appPassword: string): Promise<CalDavDiscovery> {
  const principalBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`;

  // Step 1+2: the root PROPFIND redirects to the account's real pod, and that
  // pod's response to the SAME PROPFIND carries the principal href.
  const rootRes = await davRequest('https://caldav.icloud.com/', 'PROPFIND', appleId, appPassword, {
    body: principalBody,
    headers: {Depth: '0'},
  });
  const server = new URL(rootRes.url).origin;
  const rootParsed: any = xmlParser.parse(rootRes.text);
  const principalHref = findHref(rootParsed?.multistatus?.response?.propstat?.prop?.['current-user-principal']);
  if (!principalHref) throw new CalDavError('Could not find current-user-principal in CalDAV discovery response.');
  const principalUrl = resolveHref(server, principalHref);

  // Step 3: PROPFIND the principal for calendar-home-set.
  const homeSetBody = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`;
  const principalRes = await davRequest(principalUrl, 'PROPFIND', appleId, appPassword, {
    body: homeSetBody,
    headers: {Depth: '0'},
  });
  const principalParsed: any = xmlParser.parse(principalRes.text);
  const homeSetHref = findHref(principalParsed?.multistatus?.response?.propstat?.prop?.['calendar-home-set']);
  if (!homeSetHref) throw new CalDavError('Could not find calendar-home-set in CalDAV discovery response.');
  const homeSetUrl = resolveHref(server, homeSetHref);

  return {server, principalUrl, homeSetUrl};
}

/**
 * Lists every collection under the home-set that supports VTODO (Apple
 * Reminders lists), so the plugin's list picker only ever shows things a
 * user could actually sync -- event calendars under the same home-set are
 * filtered out.
 */
export async function listVtodoCollections(
  appleId: string,
  appPassword: string,
  discovery: CalDavDiscovery,
): Promise<DavCollection[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <C:supported-calendar-component-set/>
    <CS:getctag/>
  </D:prop>
</D:propfind>`;

  const res = await davRequest(discovery.homeSetUrl, 'PROPFIND', appleId, appPassword, {
    body,
    headers: {Depth: '1'},
  });
  const parsed: any = xmlParser.parse(res.text);
  const responses = asArray(parsed?.multistatus?.response);

  const collections: DavCollection[] = [];
  for (const entry of responses) {
    const propstats = asArray(entry?.propstat);
    const okPropstat = propstats.find((p: any) => String(p?.status ?? '').includes('200')) ?? propstats[0];
    const prop = okPropstat?.prop;
    if (!prop) continue;

    // iCloud's calendar-home-set also contains special delivery collections
    // (schedule-outbox, schedule-inbox, notification, dropbox) that are NOT
    // real lists a user could pick -- confirmed against a real account
    // 2026-08-19, where the outbox showed up in this listing because it
    // declares VTODO in its supported-calendar-component-set even though
    // it's not a place tasks are actually stored. Their resourcetype names
    // this explicitly, so filter on that rather than the URL shape.
    const resourceTypeKeys = Object.keys(prop.resourcetype ?? {});
    if (resourceTypeKeys.some(k => /schedule-inbox|schedule-outbox|notification|dropbox/i.test(k))) {
      continue;
    }

    // A real Apple Reminders list declares VTODO only. The account's default
    // event calendar (auto-named after the account holder -- confirmed
    // against a real account 2026-08-19, where it showed up here as a false
    // positive named "Evan Hartsell" and rejected REPORT with a 401) also
    // advertises VTODO support even though Apple's own Reminders app never
    // treats it as a task list, so VEVENT+VTODO together means "this is a
    // calendar, not a list" -- excluded.
    const components = asArray(prop['supported-calendar-component-set']?.comp).map(
      (c: any) => c?.['@_name'],
    );
    if (!components.includes('VTODO') || components.includes('VEVENT')) continue;

    const href = findHref(entry?.href);
    if (!href) continue;
    const displayName = typeof prop.displayname === 'string' ? prop.displayname : prop.displayname?.['#text'];
    collections.push({
      url: resolveHref(discovery.homeSetUrl, href),
      displayName: displayName || href,
      ctag: typeof prop.getctag === 'string' ? prop.getctag : prop.getctag?.['#text'],
    });
  }
  return collections;
}

/**
 * Fetches every VTODO in a collection via a calendar-query REPORT, returning
 * each object's href, ETag (for optimistic-locking writes), and raw
 * iCalendar text. Parsing that text into title/completion/due happens in
 * tasks.ts.
 */
export async function fetchVtodoObjects(
  appleId: string,
  appPassword: string,
  calendarUrl: string,
): Promise<DavObject[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const res = await davRequest(calendarUrl, 'REPORT', appleId, appPassword, {
    body,
    headers: {Depth: '1'},
  });
  const parsed: any = xmlParser.parse(res.text);
  const responses = asArray(parsed?.multistatus?.response);

  const objects: DavObject[] = [];
  for (const entry of responses) {
    const propstats = asArray(entry?.propstat);
    const okPropstat = propstats.find((p: any) => String(p?.status ?? '').includes('200')) ?? propstats[0];
    const prop = okPropstat?.prop;
    const href = findHref(entry?.href);
    const ical = typeof prop?.['calendar-data'] === 'string' ? prop['calendar-data'] : prop?.['calendar-data']?.['#text'];
    const etag = typeof prop?.getetag === 'string' ? prop.getetag : prop?.getetag?.['#text'];
    if (!href || !ical) continue;
    objects.push({href: resolveHref(calendarUrl, href), etag: etag ?? '', ical});
  }
  return objects;
}

/**
 * Fetches a single VTODO object by its href, with a fresh ETag -- used
 * before completeTask/uncompleteTask mutate it, since the plugin's
 * /complete and /uncomplete requests only carry the task id (href), not the
 * ETag from whatever fetch originally listed it. A REPORT-based batch fetch
 * would work too, but a plain GET on the one resource is cheaper and is
 * exactly what CalDAV (built on WebDAV) defines GET to do for a calendar
 * object resource.
 */
export async function getVtodoObject(
  appleId: string,
  appPassword: string,
  href: string,
): Promise<DavObject> {
  const res = await davRequest(href, 'GET', appleId, appPassword, {});
  return {href, etag: res.headers.get('etag') ?? '', ical: res.text};
}

/**
 * Writes a VTODO back (create or update). When `ifMatch` is given, the PUT
 * carries an If-Match header so a concurrent edit (made from an iPhone, say,
 * between our fetch and this write) causes the server to reject the write
 * with 412 rather than silently clobbering it -- the caller should treat a
 * 412 as "re-fetch and retry," not a hard failure.
 *
 * When creating a brand new object, pass `ifNoneMatch: true` instead, which
 * asks the server to reject the write if something already exists at that
 * href (guards against two clients picking the same UID).
 */
export async function putVtodoObject(
  appleId: string,
  appPassword: string,
  href: string,
  ical: string,
  opts: {ifMatch?: string; ifNoneMatch?: boolean} = {},
): Promise<{etag?: string}> {
  const headers: Record<string, string> = {'Content-Type': 'text/calendar; charset=utf-8'};
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  if (opts.ifNoneMatch) headers['If-None-Match'] = '*';

  try {
    const res = await davRequest(href, 'PUT', appleId, appPassword, {body: ical, headers});
    return {etag: res.headers.get('etag') ?? undefined};
  } catch (err) {
    if (err instanceof CalDavError && err.status === 412) {
      throw new CalDavError('The task changed on the server since it was last fetched (conflicting edit).', 412);
    }
    throw err;
  }
}

/** Everything a sync needs: credentials plus the already-resolved home-set + chosen list. */
export type CalDavSession = {
  appleId: string;
  appPassword: string;
  discovery: CalDavDiscovery;
  calendarUrl: string;
};

/**
 * Bundles config into a session, or throws the same style of "not set up
 * yet" error google-tasks-server's tasksClient() throws for a missing
 * refresh token -- both mean "the plugin's settings screen needs to walk the
 * user through connecting this backend before it can sync."
 */
export function caldavSession(config: ServerConfig): CalDavSession {
  if (!config.appleId || !config.appPassword) {
    throw new Error(
      'Not set up yet. Enter your Apple ID and an app-specific password ' +
        '(generated at appleid.apple.com) in the plugin settings, or run ' +
        '`npm run setup` here.',
    );
  }
  if (!config.discovery || !config.selectedList) {
    throw new Error(
      'Not set up yet. Run `npm run setup` once to discover your reminder ' +
        'lists and choose one to sync.',
    );
  }
  return {
    appleId: config.appleId,
    appPassword: config.appPassword,
    discovery: config.discovery,
    calendarUrl: config.selectedList.url,
  };
}

/**
 * Runs discovery fresh (ignoring any cache) to confirm the stored credential
 * still works, the same role google-tasks-server's verifyAuth() plays by
 * forcing an access-token mint at startup -- fails fast with a clear message
 * instead of only erroring on the first plugin request. Only called once at
 * startup (and from `npm run setup`), never per-sync -- see fetchVtodoObjects
 * and the CalDavSession type for the cached path ongoing syncs actually use.
 */
export async function verifyAuth(config: ServerConfig): Promise<void> {
  if (!config.appleId || !config.appPassword) {
    throw new Error('Not set up yet. Run `npm run setup` first.');
  }
  await discover(config.appleId, config.appPassword);
}
