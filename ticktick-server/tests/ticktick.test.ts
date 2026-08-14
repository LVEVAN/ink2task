/**
 * Stage 2 tests: pure-function mapping + error classification.
 *
 * No network, no real TickTick account needed -- these test the data-shaping
 * logic that Stage 3's sync engine will build on, so mistakes here are cheap
 * to catch instead of discovered against a live account. Run with `npm test`.
 *
 * Deliberately does NOT set TICKTICK_CLIENT_ID/SECRET env vars: importing
 * ticktick.ts must not throw just because credentials.env doesn't exist in
 * this test environment (env.ts's dotenv load is a no-op if the file is
 * missing) -- only functions that actually NEED the credentials should throw,
 * and none of the pure mapping functions under test here do.
 *
 * ⚠️ NO TEST IN THIS FILE MAY TOUCH THE REAL FILESYSTEM. config.ts's
 * saveConfig() writes unconditionally to ~/.ink2task-ticktick/config.json --
 * the SAME file the live, real, running server reads its access token and
 * project from. There is no test-env override for that path. A test that
 * exercises any code path calling saveConfig() (resolveProject does, on
 * every project-id/name change) WILL overwrite the user's real TickTick
 * credentials with test fixture data if fs.writeFileSync isn't mocked first
 * -- this happened for real (2026-08-12): a resolveProject test replaced the
 * live config's accessToken with the literal string "tok", and the server
 * started rejecting every request until `npm run authorize` was re-run.
 * mockFs() below is the required guard for any test touching config.ts,
 * directly or indirectly (resolveProject, saveConfig, loadConfig).
 */
import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
// CJS-style require (not `import * as fs`) -- an ESM namespace import's
// bindings are read-only and mock.method can't redefine them ("Cannot
// redefine property"), device/CI-confirmed while adding this guard. The CJS
// module object returned by require() for a core module IS mutable and is
// the same underlying module config.ts's own `import {writeFileSync} from
// 'node:fs'` resolves against, so mocking it here actually intercepts
// config.ts's calls.
import {createRequire} from 'node:module';
const fs = createRequire(import.meta.url)('node:fs');
import {
  priorityFromTickTick,
  priorityToTickTick,
  dueFromTickTick,
  dueToTickTick,
  mapTask,
  listProjectTasks,
  TickTickAuthError,
  TickTickNotFoundError,
  TickTickApiError,
  TickTickTimeoutError,
} from '../src/ticktick.js';
import {statusForError, resolveProject} from '../src/server.js';

/**
 * Stubs fs.writeFileSync/mkdirSync for the duration of one test, so any
 * saveConfig() call inside it is a harmless no-op instead of a write to the
 * user's real ~/.ink2task-ticktick/config.json. ALWAYS call the returned
 * restore() in a finally block. See the file-header warning above.
 */
function mockFs(): {restore: () => void} {
  const write = mock.method(fs, 'writeFileSync', () => {});
  const mkdir = mock.method(fs, 'mkdirSync', () => {});
  return {
    restore: () => {
      write.mock.restore();
      mkdir.mock.restore();
    },
  };
}

// --- priority mapping ------------------------------------------------------

test('priorityFromTickTick maps TickTick\'s 4 raw tiers to the plugin\'s scale', () => {
  assert.equal(priorityFromTickTick(5), 1); // High -> most urgent
  assert.equal(priorityFromTickTick(3), 2); // Medium
  assert.equal(priorityFromTickTick(1), 3); // Low
  assert.equal(priorityFromTickTick(0), undefined); // None -> no flag
});

test('priorityFromTickTick treats unrecognized/missing values as no flag, not a crash', () => {
  assert.equal(priorityFromTickTick(undefined), undefined);
  assert.equal(priorityFromTickTick(2), undefined); // not one of 0/1/3/5 -- malformed data
  assert.equal(priorityFromTickTick(99), undefined);
});

test('priorityToTickTick is the inverse of priorityFromTickTick for every real tier', () => {
  for (const tier of [1, 2, 3] as const) {
    assert.equal(priorityFromTickTick(priorityToTickTick(tier)), tier);
  }
});

test('priorityToTickTick collapses tier 4 and undefined to None (0) -- TickTick has no 5th tier', () => {
  assert.equal(priorityToTickTick(4), 0);
  assert.equal(priorityToTickTick(undefined), 0);
});

// --- due-date mapping --------------------------------------------------

test('dueFromTickTick returns a date-only string for an all-day task', () => {
  assert.equal(dueFromTickTick('2026-04-07T00:00:00+0000', true), '2026-04-07');
});

test('dueFromTickTick returns a date+time string (offset dropped) for a timed task', () => {
  assert.equal(dueFromTickTick('2026-04-07T14:30:00+0000', false), '2026-04-07T14:30');
});

test('dueFromTickTick returns undefined when there is no due date at all', () => {
  assert.equal(dueFromTickTick(undefined, false), undefined);
  assert.equal(dueFromTickTick(undefined, undefined), undefined);
});

test('dueToTickTick marks a date-only input as all-day', () => {
  const out = dueToTickTick('2026-04-07');
  assert.equal(out.isAllDay, true);
  assert.equal(out.dueDate, '2026-04-07T00:00:00+0000');
  assert.equal(typeof out.timeZone, 'string');
  assert.ok(out.timeZone.length > 0);
});

test('dueToTickTick marks a date+time input as timed', () => {
  const out = dueToTickTick('2026-04-07T14:30');
  assert.equal(out.isAllDay, false);
  assert.equal(out.dueDate, '2026-04-07T14:30:00+0000');
});

test('due mapping round-trips a date-only value', () => {
  const written = dueToTickTick('2026-04-07');
  const readBack = dueFromTickTick(written.dueDate, written.isAllDay);
  assert.equal(readBack, '2026-04-07');
});

test('due mapping round-trips a timed value to minute precision', () => {
  const written = dueToTickTick('2026-04-07T14:30');
  const readBack = dueFromTickTick(written.dueDate, written.isAllDay);
  assert.equal(readBack, '2026-04-07T14:30');
});

// --- task mapping ------------------------------------------------------

test('mapTask maps a fully-populated raw task', () => {
  const t = mapTask({
    id: 'abc123',
    projectId: 'proj1',
    title: '  Buy milk  ',
    content: 'and eggs',
    dueDate: '2026-04-07T00:00:00+0000',
    isAllDay: true,
    priority: 5,
    status: 0,
    etag: 'e1',
    sortOrder: -1234,
  });
  assert.deepEqual(t, {
    id: 'abc123',
    projectId: 'proj1',
    title: 'Buy milk', // trimmed
    notes: 'and eggs',
    due: '2026-04-07',
    priority: 1,
    completed: false,
    etag: 'e1',
    sortOrder: -1234,
  });
});

test('mapTask falls back to desc when content is absent (see the uncertain-field note in ticktick.ts)', () => {
  const t = mapTask({id: '1', projectId: 'p', title: 'x', desc: 'from desc'});
  assert.equal(t.notes, 'from desc');
});

test('mapTask prefers content over desc when both are present', () => {
  const t = mapTask({id: '1', projectId: 'p', title: 'x', content: 'from content', desc: 'from desc'});
  assert.equal(t.notes, 'from content');
});

test('mapTask treats status 2 as completed and anything else as not', () => {
  assert.equal(mapTask({id: '1', projectId: 'p', title: 'x', status: 2}).completed, true);
  assert.equal(mapTask({id: '1', projectId: 'p', title: 'x', status: 0}).completed, false);
  assert.equal(mapTask({id: '1', projectId: 'p', title: 'x', status: undefined}).completed, false);
});

test('mapTask never produces an empty title -- falls back to a placeholder', () => {
  assert.equal(mapTask({id: '1', projectId: 'p', title: ''}).title, '(untitled)');
  assert.equal(mapTask({id: '1', projectId: 'p', title: '   '}).title, '(untitled)');
  assert.equal(mapTask({id: '1', projectId: 'p'}).title, '(untitled)');
});

test('mapTask omits notes entirely when there is nothing to show, rather than an empty string', () => {
  const t = mapTask({id: '1', projectId: 'p', title: 'x', content: '   '});
  assert.equal(t.notes, undefined);
  assert.ok(!('notes' in t) || t.notes === undefined);
});

// --- task ordering -----------------------------------------------------

test('listProjectTasks sorts by sortOrder ascending, matching the TickTick app -- ' +
  'the /data endpoint does NOT return tasks pre-sorted (device-confirmed)', async () => {
  const realFetch = global.fetch;
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        project: {id: 'p1', name: 'Test'},
        tasks: [
          {id: 'a', projectId: 'p1', title: 'Working?', sortOrder: -2748779069440},
          {id: 'b', projectId: 'p1', title: 'New one test', sortOrder: -1099511627776},
          {id: 'c', projectId: 'p1', title: 'And another one!', sortOrder: -1649267441664},
        ],
      }),
      {status: 200},
    )) as typeof fetch;
  try {
    const {tasks} = await listProjectTasks({accessToken: 'tok', port: 8955}, 'p1');
    assert.deepEqual(
      tasks.map(t => t.title),
      ['Working?', 'And another one!', 'New one test'],
    );
  } finally {
    global.fetch = realFetch;
  }
});

test('listProjectTasks puts tasks with no sortOrder last, rather than crashing or sorting them first', async () => {
  const realFetch = global.fetch;
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        project: {id: 'p1', name: 'Test'},
        tasks: [
          {id: 'a', projectId: 'p1', title: 'No order'},
          {id: 'b', projectId: 'p1', title: 'Has order', sortOrder: -5},
        ],
      }),
      {status: 200},
    )) as typeof fetch;
  try {
    const {tasks} = await listProjectTasks({accessToken: 'tok', port: 8955}, 'p1');
    assert.deepEqual(tasks.map(t => t.title), ['Has order', 'No order']);
  } finally {
    global.fetch = realFetch;
  }
});

test('listProjectTasks turns a 404 on the special system-Inbox pseudo-project into a clear ' +
  'message instead of a bare "Not found"', async () => {
  const realFetch = global.fetch;
  global.fetch = (async () => new Response('not found', {status: 404})) as typeof fetch;
  try {
    await assert.rejects(
      listProjectTasks({accessToken: 'tok', port: 8955}, 'inbox123456'),
      (err: Error) => {
        assert.ok(err instanceof TickTickNotFoundError);
        assert.match(err.message, /built-in Inbox can't be synced directly/);
        return true;
      },
    );
  } finally {
    global.fetch = realFetch;
  }
});

test('listProjectTasks leaves a 404 on a NORMAL project id as the plain error -- the friendlier ' +
  'message is only for ids matching the inbox pattern', async () => {
  const realFetch = global.fetch;
  global.fetch = (async () => new Response('not found', {status: 404})) as typeof fetch;
  try {
    await assert.rejects(
      listProjectTasks({accessToken: 'tok', port: 8955}, 'a-real-project-id'),
      (err: Error) => {
        assert.ok(err instanceof TickTickNotFoundError);
        assert.doesNotMatch(err.message, /built-in Inbox/);
        return true;
      },
    );
  } finally {
    global.fetch = realFetch;
  }
});

// --- project name resolution ---------------------------------------------

test('resolveProject prefers a real project over a same-named system-Inbox ' +
  'pseudo-project, regardless of which one the API lists first', async () => {
  const realFetch = global.fetch;
  const {restore} = mockFs(); // resolveProject calls saveConfig -- see file header
  global.fetch = (async () =>
    new Response(
      JSON.stringify([
        {id: 'inbox987654', name: 'Inbox'},
        {id: 'real-project-id', name: 'Inbox'},
      ]),
      {status: 200},
    )) as typeof fetch;
  try {
    const {id, name} = await resolveProject({accessToken: 'tok', port: 8955}, 'Inbox');
    assert.equal(id, 'real-project-id');
    assert.equal(name, 'Inbox');
  } finally {
    global.fetch = realFetch;
    restore();
  }
});

test('resolveProject falls back to the system-Inbox pseudo-project when it is the ONLY match ' +
  '-- listProjectTasks is what turns that into a clear error, not this function', async () => {
  const realFetch = global.fetch;
  const {restore} = mockFs(); // resolveProject calls saveConfig -- see file header
  global.fetch = (async () =>
    new Response(JSON.stringify([{id: 'inbox987654', name: 'Inbox'}]), {status: 200})) as typeof fetch;
  try {
    const {id} = await resolveProject({accessToken: 'tok', port: 8955}, 'Inbox');
    assert.equal(id, 'inbox987654');
  } finally {
    global.fetch = realFetch;
    restore();
  }
});

// --- error classification -----------------------------------------------

test('statusForError maps each typed ticktick.ts error to the right HTTP status', () => {
  assert.equal(statusForError(new TickTickAuthError('x')), 401);
  assert.equal(statusForError(new TickTickNotFoundError('x')), 404);
  assert.equal(statusForError(new TickTickTimeoutError('x')), 504);
  assert.equal(statusForError(new TickTickApiError(429, 'rate limited')), 429);
});

test('statusForError falls back to 500 for an unrecognized error', () => {
  assert.equal(statusForError(new Error('something else')), 500);
  assert.equal(statusForError('not even an Error object'), 500);
});
