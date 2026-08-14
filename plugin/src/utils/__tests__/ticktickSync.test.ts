/**
 * Stage 3 tests: the TickTick sync engine.
 *
 * Covers exactly what requirement 18 asked for -- mapping/decisions,
 * duplicate prevention, sync decisions, conflicts, deletions, error
 * handling -- against the REAL config.ts persistence (backed by the
 * in-memory RNFS mock, see __mocks__/react-native-fs.js) and a mocked
 * global fetch standing in for ticktick-server. No RN components involved,
 * so this runs under plain jest with no special setup beyond the RNFS mock.
 */
import type {Ink2TaskConfig} from '../config';
import {loadTicktickOutbox, loadTicktickSyncState} from '../config';
import {
  decideDueSync,
  isNetworkError,
  pruneTicktickSyncState,
  enqueueTicktickOutbox,
  drainTicktickOutbox,
  runTicktickPostSync,
} from '../ticktickSync';
import {pushTicktickDue} from '../ticktickSync';

const RNFS = require('react-native-fs');

function makeConfig(overrides: Partial<Ink2TaskConfig> = {}): Ink2TaskConfig {
  return {
    host: '10.0.0.50',
    port: 8955,
    listName: 'Inbox',
    profiles: [{label: 'TickTick', backend: 'ticktick', host: '10.0.0.50', port: 8955, listName: 'Inbox'}],
    activeProfile: 0,
    notePath: '/Note/Ink2Task/Ink2Task.note',
    fontPath: '',
    listScale: 1,
    ...overrides,
  };
}

/** Builds a fetch mock that returns `body` (JSON) with `status` for every call, in order. */
function mockFetchSequence(responses: Array<{status: number; body?: unknown} | 'network-error'>) {
  let i = 0;
  (global as any).fetch = jest.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next === 'network-error') {
      throw new TypeError('Network request failed');
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
    };
  });
}

beforeEach(() => {
  RNFS.__reset();
  jest.restoreAllMocks();
});

// --- pure decision logic ----------------------------------------------

describe('decideDueSync', () => {
  test('pushes when there is no prior sync-state for this task', () => {
    expect(decideDueSync(undefined, 'etag-1')).toBe('push');
  });

  test('pushes when the etag has not changed since the last sync', () => {
    expect(decideDueSync({lastSyncedEtag: 'etag-1'}, 'etag-1')).toBe('push');
  });

  test('conflicts when the remote etag differs from last sync', () => {
    expect(decideDueSync({lastSyncedEtag: 'etag-1'}, 'etag-2')).toBe('conflict');
  });

  test('fails open (pushes) when the current remote etag is unavailable to compare', () => {
    // Can't prove a conflict without something to compare against -- blocking
    // every edit because of a missing etag would be worse than the rare
    // false negative this allows.
    expect(decideDueSync({lastSyncedEtag: 'etag-1'}, undefined)).toBe('push');
  });
});

describe('isNetworkError', () => {
  test('recognizes React Native\'s fetch-failure message', () => {
    expect(isNetworkError(new Error('Network request failed'))).toBe(true);
    expect(isNetworkError(new Error('network REQUEST failed'))).toBe(true); // case-insensitive
  });

  test('recognizes the withTimeout wrapper\'s message', () => {
    expect(isNetworkError(new Error('Timed out reaching TickTick server'))).toBe(true);
  });

  test('does not misclassify a genuine API rejection as a network error', () => {
    expect(isNetworkError(new Error('TickTick server returned 400 while updating the task'))).toBe(false);
    expect(isNetworkError(new Error('TickTick server returned 404'))).toBe(false);
  });

  test('handles non-Error thrown values without crashing', () => {
    expect(isNetworkError('a plain string')).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe('pruneTicktickSyncState', () => {
  test('keeps records for tasks still present remotely', () => {
    const state = {a: {reminderId: 'a', lastSyncedEtag: 'e1'}, b: {reminderId: 'b'}};
    expect(pruneTicktickSyncState(state, ['a', 'b'])).toEqual(state);
  });

  test('drops records for tasks no longer in the remote fetch (completed/deleted/moved out)', () => {
    const state = {a: {reminderId: 'a'}, b: {reminderId: 'b'}};
    expect(pruneTicktickSyncState(state, ['a'])).toEqual({a: {reminderId: 'a'}});
  });

  test('an empty live list prunes everything', () => {
    const state = {a: {reminderId: 'a'}};
    expect(pruneTicktickSyncState(state, [])).toEqual({});
  });
});

// --- outbox: duplicate prevention ---------------------------------------

describe('enqueueTicktickOutbox', () => {
  test('a second edit to the same field on the same task replaces the first, not both', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    await enqueueTicktickOutbox({id: 'b', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-02'}, queuedAt: 2});
    const outbox = await loadTicktickOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload?.due).toBe('2026-01-02'); // the LATER edit wins, not the first
  });

  test('different tasks, or different kinds on the same task, both stay queued', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    await enqueueTicktickOutbox({id: 'b', kind: 'setDue', reminderId: 'r2', payload: {due: '2026-01-01'}, queuedAt: 2});
    await enqueueTicktickOutbox({id: 'c', kind: 'complete', reminderId: 'r1', queuedAt: 3});
    expect(await loadTicktickOutbox()).toHaveLength(3);
  });
});

// --- outbox: drain / idempotent retry -----------------------------------

describe('drainTicktickOutbox', () => {
  test('an empty outbox is a no-op', async () => {
    const result = await drainTicktickOutbox(makeConfig());
    expect(result).toEqual({applied: 0, stillQueued: 0, dropped: 0});
  });

  test('a successful setDue is applied, removed from the outbox, and updates sync-state', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    mockFetchSequence([{status: 200, body: {id: 'r1', title: 'x', due: '2026-01-01', etag: 'e2'}}]);

    const result = await drainTicktickOutbox(makeConfig());
    expect(result).toEqual({applied: 1, stillQueued: 0, dropped: 0});
    expect(await loadTicktickOutbox()).toEqual([]);
    const state = await loadTicktickSyncState();
    expect(state.r1.lastSyncedEtag).toBe('e2');
    expect(state.r1.lastSyncedDue).toBe('2026-01-01');
  });

  test('a network failure leaves the entry queued for next time, and is not counted as applied', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    mockFetchSequence(['network-error']);

    const result = await drainTicktickOutbox(makeConfig());
    expect(result).toEqual({applied: 0, stillQueued: 1, dropped: 0});
    expect(await loadTicktickOutbox()).toHaveLength(1);
  });

  test('a genuine rejection (e.g. task deleted, 404) is dropped rather than retried forever', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    mockFetchSequence([{status: 404}]);

    const result = await drainTicktickOutbox(makeConfig());
    expect(result).toEqual({applied: 0, stillQueued: 0, dropped: 1});
    expect(await loadTicktickOutbox()).toEqual([]);
  });

  test('draining twice in a row without new failures does nothing the second time (idempotent)', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    mockFetchSequence([{status: 200, body: {id: 'r1', title: 'x', etag: 'e2'}}]);
    await drainTicktickOutbox(makeConfig());

    const second = await drainTicktickOutbox(makeConfig());
    expect(second).toEqual({applied: 0, stillQueued: 0, dropped: 0});
  });

  test('a delete entry removes the sync-state record for that task', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'delete', reminderId: 'r1', queuedAt: 1});
    mockFetchSequence([{status: 200, body: {ok: true}}]);
    await drainTicktickOutbox(makeConfig());
    const state = await loadTicktickSyncState();
    expect(state.r1).toBeUndefined();
  });

  test('mixed batch: one succeeds, one stays queued on a network error, independently', async () => {
    await enqueueTicktickOutbox({id: 'a', kind: 'setDue', reminderId: 'r1', payload: {due: '2026-01-01'}, queuedAt: 1});
    await enqueueTicktickOutbox({id: 'b', kind: 'complete', reminderId: 'r2', queuedAt: 2});
    mockFetchSequence([
      {status: 200, body: {id: 'r1', title: 'x', etag: 'e2'}}, // r1's setDue succeeds
      'network-error', // r2's complete fails
    ]);

    const result = await drainTicktickOutbox(makeConfig());
    expect(result.applied).toBe(1);
    expect(result.stillQueued).toBe(1);
    const remaining = await loadTicktickOutbox();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].reminderId).toBe('r2');
  });
});

// --- conflict handling ----------------------------------------------------

describe('pushTicktickDue (conflict detection)', () => {
  test('pushes normally when nothing has changed remotely since the last sync', async () => {
    mockFetchSequence([
      {status: 200, body: {id: 'r1', title: 'x', etag: 'e1'}}, // GET (conflict check)
      {status: 200, body: {id: 'r1', title: 'x', due: '2026-02-01', etag: 'e2'}}, // POST (update)
    ]);
    await pushTicktickDue(makeConfig(), 'r1', '2026-02-01');
    const state = await loadTicktickSyncState();
    expect(state.r1.lastSyncedEtag).toBe('e2');
    expect(state.r1.lastSyncedDue).toBe('2026-02-01');
  });

  test('a task never synced before (no sync-state) is not treated as a conflict', async () => {
    mockFetchSequence([
      {status: 200, body: {id: 'r1', title: 'x', etag: 'e1'}},
      {status: 200, body: {id: 'r1', title: 'x', etag: 'e1'}},
    ]);
    await expect(pushTicktickDue(makeConfig(), 'r1', '2026-02-01')).resolves.toBeUndefined();
  });

  test('conflict: remote wins -- the push is skipped and a descriptive error is thrown, not silently dropped', async () => {
    // Seed prior sync-state with an OLD etag, as if a previous sync recorded it.
    await drainTicktickOutbox(makeConfig()); // no-op, just to touch the module cleanly
    const {saveTicktickSyncState} = require('../config');
    await saveTicktickSyncState({r1: {reminderId: 'r1', lastSyncedEtag: 'old-etag'}});

    // The GET now returns a DIFFERENT etag -- something changed on TickTick's side.
    mockFetchSequence([{status: 200, body: {id: 'r1', title: 'x', etag: 'new-etag'}}]);

    await expect(pushTicktickDue(makeConfig(), 'r1', '2026-02-01')).rejects.toThrow(/changed in TickTick/i);

    // The conflicting edit must not have been silently applied, and the
    // stale sync-state must be untouched (still 'old-etag', not overwritten).
    const state = await loadTicktickSyncState();
    expect(state.r1.lastSyncedEtag).toBe('old-etag');
  });

  test('a network error while checking for conflicts queues the edit instead of throwing', async () => {
    mockFetchSequence(['network-error']);
    await expect(pushTicktickDue(makeConfig(), 'r1', '2026-02-01')).resolves.toBeUndefined();
    const outbox = await loadTicktickOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].kind).toBe('setDue');
    expect(outbox[0].reminderId).toBe('r1');
  });

  test('a network error while pushing (after a clean conflict check) also queues rather than throwing', async () => {
    mockFetchSequence([
      {status: 200, body: {id: 'r1', title: 'x', etag: 'e1'}}, // GET succeeds
      'network-error', // the actual update fails
    ]);
    await expect(pushTicktickDue(makeConfig(), 'r1', '2026-02-01')).resolves.toBeUndefined();
    expect(await loadTicktickOutbox()).toHaveLength(1);
  });

  test('a genuine rejection while pushing (not a conflict, not a network error) is surfaced, not swallowed', async () => {
    mockFetchSequence([
      {status: 200, body: {id: 'r1', title: 'x', etag: 'e1'}},
      {status: 400},
    ]);
    await expect(pushTicktickDue(makeConfig(), 'r1', '2026-02-01')).rejects.toThrow(/400/);
  });
});

// --- post-sync cleanup ------------------------------------------------

describe('runTicktickPostSync', () => {
  test('prunes and persists sync-state for tasks no longer live', async () => {
    const {saveTicktickSyncState} = require('../config');
    await saveTicktickSyncState({
      r1: {reminderId: 'r1', lastSyncedEtag: 'e1'},
      r2: {reminderId: 'r2', lastSyncedEtag: 'e2'},
    });
    await runTicktickPostSync(['r1']);
    const state = await loadTicktickSyncState();
    expect(state).toEqual({r1: {reminderId: 'r1', lastSyncedEtag: 'e1'}});
  });
});
