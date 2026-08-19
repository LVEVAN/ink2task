/**
 * Ink2Task TickTick server.
 *
 * Stage 3 adds the write surface (create/update/move/complete/delete) and a
 * per-task GET so the plugin's conflict check has something to compare
 * against. Still no sync-state or conflict logic HERE -- that lives entirely
 * on the plugin side (see plugin/src/utils/ticktickSync.ts), because the
 * "since last sync" state is fundamentally local to the device: this server
 * is a stateless proxy to TickTick, same as every other backend here.
 *
 * ⚠️ LOGGING RULE: never log the access/refresh token, and never log task
 * titles/content/notes (user data). Log method + path + status/error class
 * only, same as every other server in this repo.
 */
import './env.js';
import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {URL, pathToFileURL} from 'node:url';
import {loadConfig, saveConfig, CONFIG_FILE} from './config.js';
import type {ServerConfig} from './config.js';
import {
  listProjects,
  listProjectTasks,
  getTask,
  createTask,
  updateTask,
  moveTask,
  completeTask,
  deleteTask,
  ticktickFetch,
  verifyAuth,
  TickTickAuthError,
  TickTickNotFoundError,
  TickTickApiError,
  TickTickTimeoutError,
} from './ticktick.js';
import type {RemoteTask} from './ticktick.js';
import {runInteractiveAuthorization} from './reauth.js';

type Json = Record<string, unknown>;

function sendJson(res: http.ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Maps a typed ticktick.ts error to the right HTTP status; unknown errors are 500.
 * Exported so tests can check the mapping without spinning up the HTTP server. */
export function statusForError(err: unknown): number {
  if (err instanceof TickTickAuthError) return 401;
  if (err instanceof TickTickNotFoundError) return 404;
  if (err instanceof TickTickTimeoutError) return 504;
  if (err instanceof TickTickApiError) return err.status;
  return 500;
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

/** Reads and JSON-parses a request body; returns {} for an empty body. */
async function readJsonBody(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Json;
}

/**
 * The subset of RemoteTask sent over the wire to the plugin -- trims out
 * anything the plugin doesn't need (completed is implicit: this list is
 * always the incomplete ones) and omits empty optional fields rather than
 * sending them as null/undefined, matching every other backend's JSON shape.
 */
function toWireReminder(t: RemoteTask): Json {
  return {
    id: t.id,
    title: t.title,
    ...(t.notes ? {notes: t.notes} : {}),
    ...(t.due ? {due: t.due} : {}),
    ...(t.priority ? {priority: t.priority} : {}),
    ...(t.etag ? {etag: t.etag} : {}),
  };
}

/** Narrows an unknown JSON value to the plugin's 1-4 priority scale. */
function isPriorityTier(v: unknown): v is 1 | 2 | 3 | 4 {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

/**
 * Runs a per-task mutation across a batch, collecting successes and failures
 * instead of aborting on the first error -- so the plugin only advances the
 * tasks the server actually confirmed. Resolving the project once up front
 * means a bad list name fails the whole batch cleanly (every id reported
 * failed), same pattern as google-tasks-server's mutateEach.
 */
async function mutateEach(
  config: ServerConfig,
  listName: string,
  ids: string[],
  op: (cfg: ServerConfig, projectId: string, id: string) => Promise<{config: ServerConfig}>,
  onAuthError?: () => void,
): Promise<{ok: string[]; failed: string[]; config: ServerConfig}> {
  const ok: string[] = [];
  const failed: string[] = [];
  let cfg = config;
  let projectId: string;
  try {
    const resolved = await resolveProject(cfg, listName);
    cfg = resolved.config;
    projectId = resolved.id;
  } catch (err) {
    console.error('Could not resolve project for batch:', (err as Error).name, (err as Error).message);
    if (err instanceof TickTickAuthError) onAuthError?.();
    return {ok, failed: [...ids], config: cfg};
  }
  for (const id of ids) {
    try {
      const result = await op(cfg, projectId, id);
      cfg = result.config;
      ok.push(id);
    } catch (err) {
      console.error(`Task ${id} failed:`, (err as Error).name, (err as Error).message);
      if (err instanceof TickTickAuthError) onAuthError?.();
      failed.push(id);
    }
  }
  return {ok, failed, config: cfg};
}

/**
 * Resolves a project name to {id, name}, refreshing the cached projectId/Name
 * in config when it's stale. Centralizes the name-resolution + cache-refresh
 * logic that GET /reminders had inline in Stage 2 -- every write endpoint
 * needs the same resolution, so it's a shared helper now.
 */
export async function resolveProject(
  config: ServerConfig,
  wantName: string,
): Promise<{id: string; name: string; config: ServerConfig}> {
  const {projects, config: next} = await listProjects(config);
  const named = projects.filter(p => p.name === wantName);
  if (named.length === 0) {
    throw new TickTickNotFoundError(`No TickTick project named "${wantName}" was found.`);
  }
  // TickTick's actual system Inbox is a special pseudo-project whose id
  // follows the pattern "inbox<userId>" (confirmed via third-party TickTick
  // API research, not TickTick's own docs). GET /project appears to include
  // this pseudo-project alongside any REAL project a user separately named
  // "Inbox", and its data endpoint doesn't behave like a normal project's
  // (see listProjectTasks below, which turns its 404 into a clear message).
  // If a name collides with more than one project, prefer whichever match
  // does NOT look like that special id over one that does, rather than
  // blindly taking the first (list) match -- the ORDER TickTick returns
  // them in isn't something to rely on either.
  const match = named.find(p => !/^inbox/i.test(p.id)) ?? named[0];
  let cfg = next;
  if (match.id !== cfg.projectId || match.name !== cfg.projectName) {
    cfg = {...cfg, projectId: match.id, projectName: match.name};
    saveConfig(cfg);
  }
  return {id: match.id, name: match.name, config: cfg};
}

async function main(): Promise<void> {
  let config: ServerConfig = loadConfig();

  // Guards against opening a second browser tab / consent flow while one's
  // already in progress -- e.g. the Supernote retries a sync a few seconds
  // after the first failure, before the user's had a chance to click through
  // TickTick's consent screen yet. Same pattern as google-tasks-server's
  // triggerBackgroundReauth.
  let reauthInFlight: Promise<void> | null = null;

  /**
   * Kicks off (or, if one's already running, just lets it keep running)
   * on-demand reauthorization: opens the browser (or prints a URL, on a
   * headless machine) the SAME way `npm run authorize` does, and saves the
   * resulting tokens once the user completes it. Triggered only by a real
   * request from the Supernote hitting TickTickAuthError -- never on a
   * timer -- so nothing happens unless a sync was actually attempted and
   * failed.
   *
   * Defined here (inside main, closing over the mutable `config` binding)
   * rather than taking config as a parameter: unlike google-tasks-server's
   * `const config`, this file reassigns `config` throughout via spreads
   * (`config = result.config`, etc.), so updating a config OBJECT passed in
   * at the moment of the error could silently update a copy the request
   * handler has already moved past. Closing over the binding itself means
   * every subsequent request sees the refreshed tokens immediately.
   */
  function triggerBackgroundReauth(): void {
    if (reauthInFlight) return;
    console.log('');
    console.log('TickTick access has expired or was revoked -- reconnecting...');
    reauthInFlight = runInteractiveAuthorization({announce: m => console.log(m)})
      .then(tokens => {
        config = {
          ...config,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? config.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
        };
        saveConfig(config);
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

  console.log('Ink2Task TickTick server starting…');
  // Gated on accessToken, not refreshToken -- TickTick doesn't issue one (see
  // the note on verifyAuth in ticktick.ts), so a refreshToken-only check would
  // wrongly print "Not connected" on every startup right after authorizing.
  if (config.accessToken) {
    try {
      config = await verifyAuth(config);
      console.log('Authorized.' + (config.projectName ? ` Project: "${config.projectName}"` : ' No project selected yet.'));
    } catch (err) {
      // Don't exit like the other servers do -- unlike a missing Reminders
      // permission or a bad Google refresh token, TickTick auth can be fixed
      // by the user re-running authorize WHILE this process is running, and
      // failing every request until then (see verifyAuth's error surfacing
      // below) is friendlier than requiring a restart too.
      console.error('Startup auth check failed:', (err as Error).message);
      console.error('Requests will fail until `npm run authorize` is run again.');
    }
  } else {
    console.log('Not connected yet. Run `npm run authorize` first.');
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      // GET /health -> identify the backend, same contract as every other
      // server here so the plugin's Wi-Fi auto-discovery recognizes it.
      if (method === 'GET' && path === '/health') {
        return sendJson(res, 200, {
          ok: true,
          app: 'ink2task',
          backend: 'ticktick',
          connected: !!config.accessToken,
          listName: config.projectName ?? null,
        });
      }

      // GET /lists -> {"lists": ["...", "..."]} for the plugin's project
      // picker. Also refreshes the cached projectName if it's stale.
      if (method === 'GET' && path === '/lists') {
        const {projects, config: next} = await listProjects(config);
        config = next;
        if (config.projectId) {
          const match = projects.find(p => p.id === config.projectId);
          if (match && match.name !== config.projectName) {
            config = {...config, projectName: match.name};
            saveConfig(config);
          }
        }
        return sendJson(res, 200, {lists: projects.map(p => p.name)});
      }

      // GET /reminders?list=<project name> -> {"reminders": [...]}
      // Includes notes/etag now (Stage 3) -- the other backends never send
      // these, and the plugin's RemoteReminder type treats both as optional,
      // so this is additive to the shared contract, not a breaking change.
      if (method === 'GET' && path === '/reminders') {
        const wantName = url.searchParams.get('list') ?? config.projectName ?? '';
        const resolved = await resolveProject(config, wantName);
        config = resolved.config;
        const {tasks, config: afterTasks} = await listProjectTasks(config, resolved.id);
        config = afterTasks;
        const reminders = tasks.filter(t => !t.completed).map(toWireReminder);
        return sendJson(res, 200, {reminders});
      }

      // GET /reminders/:id?list=<project name> -> one task, WITH etag.
      // Added in Stage 3 specifically so the plugin can conflict-check a
      // single task (has it changed remotely since our last sync?) without
      // re-fetching the whole project -- see updateReminderDue's ticktick
      // branch in the plugin's macServer.ts.
      const oneReminderMatch = path.match(/^\/reminders\/([^/]+)$/);
      if (method === 'GET' && oneReminderMatch) {
        const id = decodeURIComponent(oneReminderMatch[1]);
        const wantName = url.searchParams.get('list') ?? config.projectName ?? '';
        const resolved = await resolveProject(config, wantName);
        config = resolved.config;
        const {task, config: afterTask} = await getTask(config, resolved.id, id);
        config = afterTask;
        return sendJson(res, 200, toWireReminder(task));
      }

      // POST /reminders {"title", "list"?, "notes"?, "due"?, "priority"?}
      // -> {"id", "title"} -- matches the other backends' create contract,
      // extended with the optional TickTick-specific fields.
      if (method === 'POST' && path === '/reminders') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"title": "..."}'});
        }
        const wantName = typeof body.list === 'string' ? body.list : (config.projectName ?? '');
        const resolved = await resolveProject(config, wantName);
        config = resolved.config;
        const {task, config: afterCreate} = await createTask(config, {
          projectId: resolved.id,
          title,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
          due: typeof body.due === 'string' ? body.due : undefined,
          priority: isPriorityTier(body.priority) ? body.priority : undefined,
        });
        config = afterCreate;
        return sendJson(res, 200, {id: task.id, title: task.title});
      }

      // POST /reminders/:id {"list", "title"?, "notes"?, "due"?, "priority"?}
      // -> updated task. `list` is REQUIRED (TickTick's update endpoint needs
      // the current projectId in the body) and is NOT how you move a task --
      // see POST /reminders/:id/move for that, which is the one place this
      // server relies on the dedicated move endpoint rather than the
      // ambiguous "does update also move" behavior (see the file-level note
      // in ticktick.ts on why).
      if (method === 'POST' && oneReminderMatch) {
        const id = decodeURIComponent(oneReminderMatch[1]);
        const body = await readJsonBody(req);
        const wantName = typeof body.list === 'string' ? body.list : (config.projectName ?? '');
        if (!wantName) {
          return sendJson(res, 400, {error: 'Expected JSON body to include "list".'});
        }
        const resolved = await resolveProject(config, wantName);
        config = resolved.config;
        const {task, config: afterUpdate} = await updateTask(config, {
          taskId: id,
          projectId: resolved.id,
          title: typeof body.title === 'string' ? body.title : undefined,
          notes: typeof body.notes === 'string' ? body.notes : undefined,
          due: body.due === null ? null : typeof body.due === 'string' ? body.due : undefined,
          priority: isPriorityTier(body.priority) ? body.priority : undefined,
        });
        config = afterUpdate;
        return sendJson(res, 200, toWireReminder(task));
      }

      // POST /reminders/:id/move {"fromList", "toList"} -> {"ok": true}
      const moveMatch = path.match(/^\/reminders\/([^/]+)\/move$/);
      if (method === 'POST' && moveMatch) {
        const id = decodeURIComponent(moveMatch[1]);
        const body = await readJsonBody(req);
        const fromName = typeof body.fromList === 'string' ? body.fromList : '';
        const toName = typeof body.toList === 'string' ? body.toList : '';
        if (!fromName || !toName) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"fromList", "toList"}'});
        }
        const from = await resolveProject(config, fromName);
        config = from.config;
        const to = await resolveProject(config, toName);
        config = to.config;
        const {config: afterMove} = await moveTask(config, {
          taskId: id,
          fromProjectId: from.id,
          toProjectId: to.id,
        });
        config = afterMove;
        return sendJson(res, 200, {ok: true});
      }

      // POST /complete {"ids": [...], "list"?} -> {"completed": [...], "failed": [...]}
      if (method === 'POST' && path === '/complete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const wantName = typeof body.list === 'string' ? body.list : (config.projectName ?? '');
        const result = await mutateEach(config, wantName, ids, completeTask, triggerBackgroundReauth);
        config = result.config;
        return sendJson(res, 200, {completed: result.ok, failed: result.failed});
      }

      // POST /uncomplete {"ids": [...], "list"?} -> {"uncompleted": [...], "failed": [...]}
      //
      // No source consulted for this project documents an "uncomplete"
      // endpoint for TickTick, unlike Google Tasks and Todoist. The
      // fallback -- setting status back to 0 via the general update
      // endpoint, even though `status` isn't among update's documented
      // fields either -- is DEVICE-VERIFIED to work (2026-08-11): completed
      // a real task, called this, confirmed via GET that status flipped and
      // the task reappeared in the project's incomplete list. Kept as a raw
      // ticktickFetch call (not the typed updateTask helper) only because
      // `status` has no place in UpdateTaskInput -- there's nothing
      // otherwise unverified about this path anymore.
      if (method === 'POST' && path === '/uncomplete') {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? (body.ids as string[]) : null;
        if (!ids) {
          return sendJson(res, 400, {error: 'Expected JSON body: {"ids": ["..."]}'});
        }
        const wantName = typeof body.list === 'string' ? body.list : (config.projectName ?? '');
        const result = await mutateEach(config, wantName, ids, async (cfg, projectId, id) => {
          const {config: after} = await ticktickFetch(cfg, `/task/${encodeURIComponent(id)}`, {
            method: 'POST',
            body: JSON.stringify({id, projectId, status: 0}),
          });
          return {config: after};
        }, triggerBackgroundReauth);
        config = result.config;
        return sendJson(res, 200, {uncompleted: result.ok, failed: result.failed});
      }

      // DELETE /reminders/:id?list=<project name> -> {"ok": true}
      if (method === 'DELETE' && oneReminderMatch) {
        const id = decodeURIComponent(oneReminderMatch[1]);
        const wantName = url.searchParams.get('list') ?? config.projectName ?? '';
        const resolved = await resolveProject(config, wantName);
        config = resolved.config;
        const {config: afterDelete} = await deleteTask(config, resolved.id, id);
        config = afterDelete;
        return sendJson(res, 200, {ok: true});
      }

      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Not found');
    } catch (err) {
      // Log the error CLASS and message, never request/response bodies.
      console.error(`${method} ${path} failed:`, (err as Error).name, (err as Error).message);
      if (err instanceof TickTickAuthError) {
        triggerBackgroundReauth();
        return sendJson(res, 401, {
          error:
            'TickTick needs you to reconnect -- check the computer running this server, ' +
            "a browser tab should have opened. Try syncing again once you've signed in.",
        });
      }
      sendJson(res, statusForError(err), {error: (err as Error).message});
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

// Only run the server when this file is executed directly (`npm start`), not
// when it's imported -- e.g. by tests, which import statusForError above and
// must not have that trigger a real HTTP server + TickTick auth check.
//
// MUST use pathToFileURL here, not a bare `file://${process.argv[1]}` string:
// this repo lives under a path containing spaces ("Personal stuff"), and
// import.meta.url percent-encodes those (%20) while naive concatenation does
// not. The two strings silently never matched, so main() never ran and
// `npm start` exited immediately with no error and no output -- confirmed on
// this exact machine/path (2026-08-11).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => {
    console.error('Server error:', err?.message ?? err);
    process.exit(1);
  });
}
