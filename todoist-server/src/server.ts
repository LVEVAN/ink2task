/**
 * Ink2Task Todoist server.
 *
 * A tiny HTTP service that speaks the exact same contract as mac-server and the
 * Google Tasks backend, so the Supernote plugin can't tell them apart. No
 * framework -- just node:http -- and no runtime dependencies: it talks to
 * Todoist's REST API v2 with plain fetch.
 *
 * Point the plugin's Host/Port settings at wherever this runs (any always-on
 * host: a VPS, a Raspberry Pi, a spare laptop).
 */
import http from 'node:http';
import {existsSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {URL} from 'node:url';
import {loadConfig, saveConfig, CONFIG_FILE} from './config.js';
import {
  findProjectId,
  listProjectNames,
  listOpenTasks,
  createTask,
  closeTask,
  reopenTask,
  verifyToken,
} from './todoist.js';

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

/** First non-internal IPv4 address, to print a reachable URL at startup. */
function likelyLanAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/**
 * Runs a per-task action across a batch, collecting successes and failures
 * instead of aborting on the first error -- so the plugin only advances the
 * tasks the server actually confirmed. Close/reopen act on a task id directly,
 * so no project lookup is needed.
 */
async function mutateEach(
  config: ReturnType<typeof loadConfig>,
  ids: string[],
  op: (config: ReturnType<typeof loadConfig>, id: string) => Promise<void>,
): Promise<{ok: string[]; failed: string[]}> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await op(config, id);
      ok.push(id);
    } catch (err) {
      console.error(`Task ${id} failed:`, (err as Error).message);
      failed.push(id);
    }
  }
  return {ok, failed};
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('Ink2Task Todoist server starting…');
  if (!config.token) {
    // Seed a template config file so there's somewhere to paste the token.
    if (!existsSync(CONFIG_FILE)) {
      saveConfig(config);
      console.error('Wrote a template config to ' + CONFIG_FILE);
    }
    console.error('No Todoist token set. Paste your personal API token into that file, then restart.');
    process.exit(1);
  }
  try {
    await verifyToken(config);
  } catch (err) {
    console.error((err as Error).message);
    console.error('Config file: ' + CONFIG_FILE);
    process.exit(1);
  }
  console.log(`Authorized. Syncing Todoist project: "${config.listName}"`);

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      // GET /health -> identify the backend (the "app" marker lets the plugin's
      // Wi-Fi auto-discovery recognize this server, same as the others).
      if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, {
          ok: true,
          app: 'ink2task',
          backend: 'todoist',
          listName: config.listName,
        });
      }

      // GET /lists -> {"lists": ["...", "..."]} for the plugin's list picker.
      if (method === 'GET' && path === '/lists') {
        const lists = await listProjectNames(config);
        return sendJson(res, 200, {lists});
      }

      // GET /reminders?list=<name> -> {"reminders": [{id, title, due?}]}
      if (method === 'GET' && path === '/reminders') {
        const listName = url.searchParams.get('list') ?? config.listName;
        const projectId = await findProjectId(config, listName);
        const reminders = await listOpenTasks(config, projectId);
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
        const projectId = await findProjectId(config, listName);
        const created = await createTask(config, projectId, title);
        return sendJson(res, 200, created);
      }

      // POST /complete {"ids": [...]} -> {"completed": [...], "failed": [...]}
      if (method === 'POST' && path === '/complete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const result = await mutateEach(config, ids, closeTask);
        return sendJson(res, 200, {completed: result.ok, failed: result.failed});
      }

      // POST /uncomplete {"ids": [...]} -> {"uncompleted": [...], "failed": [...]}
      if (method === 'POST' && path === '/uncomplete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const result = await mutateEach(config, ids, reopenTask);
        return sendJson(res, 200, {uncompleted: result.ok, failed: result.failed});
      }

      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
    } catch (err) {
      console.error(`${method} ${path} failed:`, (err as Error).message);
      sendJson(res, 500, {error: (err as Error).message});
    }
  });

  server.listen(config.port, () => {
    const host = likelyLanAddress() ?? '<this-host>';
    console.log('');
    console.log(`Listening on http://${host}:${config.port}`);
    console.log("Put that address into Ink2Task's settings on your Supernote.");
    console.log('Config file: ' + CONFIG_FILE);
    console.log('Press Ctrl+C to stop.');
  });
}

main().catch(err => {
  console.error('Server error:', err?.message ?? err);
  process.exit(1);
});
