/**
 * Ink2Task CalDAV (Apple Reminders) server.
 *
 * Speaks the exact same HTTP contract as google-tasks-server and mac-server,
 * so the plugin can't tell backends apart -- see server.ts in either of
 * those for the sibling implementations this one is deliberately structured
 * to match. Unlike mac-server this needs no local Mac or EventKit: it talks
 * to iCloud's CalDAV service directly with an app-specific password, so it
 * can run on any always-on host, including serverless platforms (Cloudflare
 * Workers, Google Cloud Run) with light adaptation of the http.createServer
 * wiring below.
 */
import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {URL} from 'node:url';
import {loadConfig, type ServerConfig} from './config.js';
import {caldavSession, verifyAuth, isAuthError, type CalDavSession} from './caldav.js';
import {findListId, listTaskListTitles, listIncompleteTasks, completeTask, uncompleteTask, createTask} from './tasks.js';

type Json = Record<string, unknown>;

function sendJson(res: http.ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Reads and JSON-parses a request body; returns {} for an empty body. */
async function readJsonBody(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Json;
}

type LanCandidate = {name: string; address: string};

const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|tailscale|wg|tun|utun|vEthernet|VirtualBox|Loopback)/i;

/** Every non-internal IPv4 address on this host, real LAN adapters first. */
function lanCandidates(): LanCandidate[] {
  const candidates: LanCandidate[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) candidates.push({name, address: addr.address});
    }
  }
  candidates.sort((a, b) => Number(VIRTUAL_IFACE.test(a.name)) - Number(VIRTUAL_IFACE.test(b.name)));
  return candidates;
}

/**
 * Resolves the CalDAV session AND, per-request, the target list -- unlike
 * the cached principal/home-set in session.discovery, the specific
 * collection is re-resolved by name on every call (same cost model as
 * google-tasks-server's findListId, which lists all tasklists on every
 * request too) so a list renamed on the Apple side is picked up without
 * needing to re-run setup.
 */
async function resolveTarget(
  config: ServerConfig,
  listName: string,
): Promise<{session: CalDavSession; calendarUrl: string}> {
  const session = caldavSession(config);
  const {url} = await findListId(session, session.discovery, listName);
  return {session, calendarUrl: url};
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('Ink2Task CalDAV (Apple Reminders) server starting…');
  try {
    await verifyAuth(config);
    console.log(`Authorized. Syncing Apple Reminders list: "${config.listName}"`);
  } catch (err) {
    console.error((err as Error).message);
    if (isAuthError(err)) {
      console.log('The server will report this to the plugin on the first sync attempt.');
    } else {
      process.exit(1);
    }
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      // GET /health -> identify the backend (the "app" marker lets the plugin's
      // Wi-Fi auto-discovery recognize this server, same as mac-server).
      if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, {
          ok: true,
          app: 'ink2task',
          backend: 'caldav',
          listName: config.listName,
        });
      }

      // GET /lists -> {"lists": ["...", "..."]} for the plugin's list picker.
      if (method === 'GET' && path === '/lists') {
        const session = caldavSession(config);
        const lists = await listTaskListTitles(session, session.discovery);
        return sendJson(res, 200, {lists});
      }

      // GET /reminders?list=<name> -> {"reminders": [{id, title, due?}]}
      if (method === 'GET' && path === '/reminders') {
        const listName = url.searchParams.get('list') ?? config.listName;
        const {session, calendarUrl} = await resolveTarget(config, listName);
        const reminders = await listIncompleteTasks(session, calendarUrl);
        return sendJson(res, 200, {reminders});
      }

      // POST /reminders {"title", "list"?} -> {"id", "title"}
      if (method === 'POST' && path === '/reminders') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"title": "..."}'});
        }
        const listName = typeof body.list === 'string' ? body.list : config.listName;
        const {session, calendarUrl} = await resolveTarget(config, listName);
        const created = await createTask(session, calendarUrl, title);
        return sendJson(res, 200, created);
      }

      // POST /complete {"ids": [...]} -> {"completed": [...], "failed": [...]}
      if (method === 'POST' && path === '/complete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const session = caldavSession(config);
        const result = await mutateEach(session, ids, completeTask);
        return sendJson(res, 200, {completed: result.ok, failed: result.failed});
      }

      // POST /uncomplete {"ids": [...]} -> {"uncompleted": [...], "failed": [...]}
      if (method === 'POST' && path === '/uncomplete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const session = caldavSession(config);
        const result = await mutateEach(session, ids, uncompleteTask);
        return sendJson(res, 200, {uncompleted: result.ok, failed: result.failed});
      }

      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
    } catch (err) {
      console.error(`${method} ${path} failed:`, (err as Error).message);
      if (isAuthError(err)) {
        // Deliberately does NOT clear the cached discovery here. An earlier
        // version did (on the theory that a stale home-set URL was a
        // plausible cause), but device-tested 2026-08-19: a single
        // transient 401 from Apple wiped a working config.json and broke
        // every subsequent request with "Not set up yet" until `npm run
        // setup` was re-run by hand -- destroying a good cache to maybe fix
        // a one-off server hiccup is worse than just reporting the error. No
        // auto-reconnect browser flow either (unlike Google Tasks): there's
        // no OAuth consent screen to relaunch, just a password, so the
        // plugin's error message points the user at re-running setup only
        // if the password itself actually needs replacing.
        return sendJson(res, 401, {
          error:
            'Apple ID or app-specific password was rejected. Run `npm run setup` again ' +
            'on the computer running this server to reconnect.',
        });
      }
      sendJson(res, 500, {error: (err as Error).message});
    }
  });

  server.listen(config.port, () => {
    const candidates = lanCandidates();
    const host = candidates[0]?.address ?? '<this-host>';
    console.log('');
    console.log(`Listening on http://${host}:${config.port}`);
    if (candidates.length > 1) {
      console.log("(Other addresses found on this machine -- try one of these");
      console.log(" instead if the Supernote can't reach the one above:");
      for (const c of candidates.slice(1)) {
        console.log(`   http://${c.address}:${config.port}  (${c.name})`);
      }
      console.log(')');
    }
    console.log("Put that address into Ink2Task's settings on your Supernote.");
    console.log('Press Ctrl+C to stop.');
  });
}

/**
 * Runs a per-task mutation across a batch, collecting successes and failures
 * instead of aborting on the first error -- so the plugin only advances the
 * tasks the server actually confirmed. Each op refetches its own object (see
 * tasks.ts's completeTask/uncompleteTask) so one id's 412 conflict doesn't
 * block the rest of the batch.
 */
async function mutateEach(
  session: CalDavSession,
  ids: string[],
  op: (auth: CalDavSession, id: string) => Promise<void>,
): Promise<{ok: string[]; failed: string[]}> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await op(session, id);
      ok.push(id);
    } catch (err) {
      console.error(`Task ${id} failed:`, (err as Error).message);
      failed.push(id);
    }
  }
  return {ok, failed};
}

main().catch(err => {
  console.error('Server error:', err?.message ?? err);
  process.exit(1);
});
