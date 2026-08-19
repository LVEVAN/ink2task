/**
 * Ink2Task Google Tasks server.
 *
 * A tiny HTTP service that speaks the exact same contract as mac-server, so the
 * Supernote plugin can't tell the two apart. No framework -- just node:http --
 * to stay dependency-light; googleapis does the heavy lifting.
 *
 * Unlike mac-server this has no OS dependency, so it can live on any always-on
 * host (VPS, Raspberry Pi, spare laptop). Point the plugin's Host/Port settings
 * at wherever this runs.
 */
import './env.js';
import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {URL} from 'node:url';
import {loadConfig, saveConfig, CONFIG_FILE} from './config.js';
import {tasksClient, verifyAuth, resetAuthCache} from './google.js';
import {runInteractiveAuthorization} from './reauth.js';
import {
  findListId,
  listTaskListTitles,
  listIncompleteTasks,
  completeTask,
  uncompleteTask,
  createTask,
} from './tasks.js';

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

// Interface names for VPNs, containers, and virtual bridges -- these commonly
// sort before the real Wi-Fi/Ethernet adapter but aren't reachable from
// another device on the LAN. A host running Docker, Tailscale, or a VPN
// client (common on a Pi or Windows PC) can easily have one of these listed
// first, which used to make the startup banner print an address the plugin
// could never reach.
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
 * True for anything meaning "there's no usable Google token right now" --
 * either Google's own "this refresh token no longer works" error
 * (invalid_grant), or our own "there's no token at all yet" guard in
 * google.ts's tasksClient()/verifyAuth() ("Not authorized yet..."), which
 * fires the same way for a blank/missing refreshToken. Device-confirmed
 * 2026-08-19: these are NOT the same error message, and a blank token needs
 * the exact same auto-reauth response as a revoked one -- both mean "run the
 * consent flow again," so both should trigger it.
 */
function isInvalidGrant(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return /invalid_grant/i.test(msg) || /not authorized yet/i.test(msg);
}

// Guards against opening a second browser tab / consent flow while one's
// already in progress -- e.g. the Supernote retries a sync a few seconds
// after the first failure, before the user's had a chance to click through
// Google's consent screen yet.
let reauthInFlight: Promise<void> | null = null;

/**
 * Kicks off (or, if one's already running, just lets it keep running)
 * on-demand reauthorization: opens the browser (or prints a URL, on a
 * headless machine) the SAME way `npm run authorize` does, and saves the
 * resulting token once the user completes it. Triggered only by a real
 * request from the Supernote hitting invalid_grant -- never on a timer --
 * so nothing happens unless a sync was actually attempted and failed.
 *
 * Never throws: this runs detached from the request that triggered it (that
 * request already got its own error response, see the catch blocks below),
 * so a failure here just logs and gives up -- the next real sync attempt
 * will trigger another try.
 */
function triggerBackgroundReauth(config: ReturnType<typeof loadConfig>): void {
  if (reauthInFlight) return;
  console.log('');
  console.log('Google Tasks access has expired or was revoked -- reconnecting...');
  reauthInFlight = runInteractiveAuthorization({announce: m => console.log(m)})
    .then(refreshToken => {
      config.refreshToken = refreshToken;
      saveConfig(config);
      resetAuthCache();
      console.log('');
      console.log('Reconnected. Try syncing from the Supernote again.');
    })
    .catch(err => {
      console.error('Automatic reconnect failed:', err?.message ?? err);
      console.error('Run `npm run authorize` manually to try again.');
    })
    .finally(() => {
      reauthInFlight = null;
    });
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('Ink2Task Google Tasks server starting…');
  try {
    await verifyAuth(config);
    console.log(`Authorized. Syncing Google Tasks list: "${config.listName}"`);
  } catch (err) {
    if (isInvalidGrant(err)) {
      // Don't block startup on this -- start the server anyway and let the
      // first real Supernote sync attempt trigger reauthorization on demand,
      // same as any other invalid_grant. Keeps this ONE code path instead of
      // a separate startup-specific flow.
      console.log('Google Tasks access has expired or was revoked.');
      console.log("The server will prompt you to reconnect the first time the Supernote tries to sync.");
    } else {
      console.error((err as Error).message);
      console.error('Config file: ' + CONFIG_FILE);
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
          backend: 'google',
          listName: config.listName,
        });
      }

      // GET /lists -> {"lists": ["...", "..."]} for the plugin's list picker.
      if (method === 'GET' && path === '/lists') {
        const tasks = tasksClient(config);
        const lists = await listTaskListTitles(tasks);
        return sendJson(res, 200, {lists});
      }

      // GET /reminders?list=<name> -> {"reminders": [{id, title, due?}]}
      if (method === 'GET' && path === '/reminders') {
        const listName = url.searchParams.get('list') ?? config.listName;
        const tasks = tasksClient(config);
        const listId = await findListId(tasks, listName);
        const reminders = await listIncompleteTasks(tasks, listId);
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
        const tasks = tasksClient(config);
        const listId = await findListId(tasks, listName);
        const created = await createTask(tasks, listId, title);
        return sendJson(res, 200, created);
      }

      // POST /complete {"ids": [...]} -> {"completed": [...], "failed": [...]}
      if (method === 'POST' && path === '/complete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const listName = typeof body.list === 'string' ? body.list : config.listName;
        const result = await mutateEach(config, listName, ids, completeTask);
        return sendJson(res, 200, {completed: result.ok, failed: result.failed});
      }

      // POST /uncomplete {"ids": [...]} -> {"uncompleted": [...], "failed": [...]}
      if (method === 'POST' && path === '/uncomplete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const listName = typeof body.list === 'string' ? body.list : config.listName;
        const result = await mutateEach(config, listName, ids, uncompleteTask);
        return sendJson(res, 200, {uncompleted: result.ok, failed: result.failed});
      }

      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
    } catch (err) {
      console.error(`${method} ${path} failed:`, (err as Error).message);
      if (isInvalidGrant(err)) {
        triggerBackgroundReauth(config);
        return sendJson(res, 401, {
          error:
            'Google needs you to reconnect -- check the computer running this server, ' +
            "a browser tab should have opened. Try syncing again once you've signed in.",
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
      console.log('(Other addresses found on this machine -- try one of these');
      console.log(' instead if the Supernote can\'t reach the one above:');
      for (const c of candidates.slice(1)) {
        console.log(`   http://${c.address}:${config.port}  (${c.name})`);
      }
      console.log(')');
    }
    console.log("Put that address into Ink2Task's settings on your Supernote.");
    console.log('Config file: ' + CONFIG_FILE);
    console.log('Press Ctrl+C to stop.');
  });
}

/**
 * Runs a per-task mutation across a batch, collecting successes and failures
 * instead of aborting on the first error -- so the plugin only advances the
 * tasks the server actually confirmed. Resolving the list once up front means a
 * bad list name fails the whole batch cleanly (every id reported failed).
 */
async function mutateEach(
  config: ReturnType<typeof loadConfig>,
  listName: string,
  ids: string[],
  op: (tasks: import('googleapis').tasks_v1.Tasks, listId: string, id: string) => Promise<void>,
): Promise<{ok: string[]; failed: string[]}> {
  const ok: string[] = [];
  const failed: string[] = [];
  let tasks: import('googleapis').tasks_v1.Tasks;
  let listId: string;
  try {
    tasks = tasksClient(config);
    listId = await findListId(tasks, listName);
  } catch (err) {
    console.error('Could not resolve list for batch:', (err as Error).message);
    if (isInvalidGrant(err)) triggerBackgroundReauth(config);
    return {ok, failed: [...ids]};
  }
  for (const id of ids) {
    try {
      await op(tasks, listId, id);
      ok.push(id);
    } catch (err) {
      console.error(`Task ${id} failed:`, (err as Error).message);
      if (isInvalidGrant(err)) triggerBackgroundReauth(config);
      failed.push(id);
    }
  }
  return {ok, failed};
}

main().catch(err => {
  console.error('Server error:', err?.message ?? err);
  process.exit(1);
});
