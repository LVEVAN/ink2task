/**
 * TickTick two-way sync engine: conflict detection, the offline outbox, and
 * duplicate/id-mapping bookkeeping.
 *
 * ⚠️ SCOPE, READ THIS FIRST -- what's genuinely two-way today vs. what this
 * engine merely supports:
 *
 * This plugin's on-page UI can trigger exactly THREE local changes to an
 * existing task: check a box (complete), uncheck one (uncomplete -- device-
 * confirmed working, see ticktick-server's README), and write a new date
 * into an already-synced row's DUE box (edit due). There is currently no
 * on-page way to edit a title, write notes (nothing on the page even shows
 * notes), set a priority, or move a task between projects -- those are all
 * either display-only or Settings-level actions today, not per-task
 * handwriting affordances. Requirement 8 asks for all of these as supported
 * two-way ACTIONS: the API client (ticktick-server, plugin/src/api/
 * ticktick.ts) and the field mapping below are fully general and handle
 * every one of them correctly -- update a task's title, notes, priority, or
 * project and this engine will sync it -- but only DUE currently has a path
 * for a user to actually trigger that edit by hand on the page. The rest
 * become reachable the moment a future Settings/UI affordance calls
 * pushTicktickFields with something other than `due`; nothing here needs to
 * change for that.
 *
 * Conflict handling (per the project decision): remote wins. If a task
 * changed on TickTick's side since our last sync AND the user also just
 * wrote a new due date locally, the local edit is NOT applied -- the remote
 * value stays authoritative on the page, and a warning is surfaced through
 * the same mechanism every other capture failure already uses (capture.ts's
 * existing try/catch around updateReminderDue), so the user is told their
 * edit didn't take rather than it silently vanishing.
 */
import type {Ink2TaskConfig, TickTickSyncState, TickTickOutboxEntry} from './config';
import {
  loadTicktickSyncState,
  saveTicktickSyncState,
  loadTicktickOutbox,
  saveTicktickOutbox,
} from './config';
import {
  ticktickGetReminder,
  ticktickUpdateReminder,
  ticktickDeleteReminder,
  ticktickComplete,
  ticktickUncomplete,
} from '../api/ticktick';
// Deliberately NOT importing from '../api/macServer' here, even though its
// generic completeReminders/uncompleteReminders would work fine against
// ticktick-server (same contract) -- macServer.ts's updateReminderDue needs
// to import pushTicktickDue from THIS file, and importing macServer.ts back
// from here would make that a cycle. See the note on ticktickComplete in
// api/ticktick.ts.

/**
 * True for a connectivity/timeout failure (couldn't reach the server at
 * all); false for the server responding with a rejection (bad request,
 * TickTick API error, 404, etc). Only the former is worth queuing for later
 * -- retrying a rejection without anything changing would just fail again,
 * or loop forever.
 *
 * Matches on message text because errors crossing the LAN-call boundary
 * (macServer.ts, api/ticktick.ts) are plain `Error` objects by the time
 * they reach here -- there's no typed error class shared between this
 * plugin and ticktick-server's own typed errors, which stay server-side.
 * "Network request failed" is React Native's own fetch failure message
 * (confirmed elsewhere in this codebase, see actions.ts/index.js's existing
 * handling of the same string); "Timed out reaching" is macServer.ts's and
 * api/ticktick.ts's own withTimeout wrapper.
 */
export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /network request failed/i.test(msg) || /timed out reaching/i.test(msg);
}

function newOutboxId(): string {
  return `tt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Decides what a DUE push should do, given the remote task's CURRENT etag
 * and what we last synced. Pure and separately testable from the network
 * calls around it.
 *
 * - No prior sync-state (never synced this field before) -> push, nothing to
 *   conflict with.
 * - Etag unchanged since last sync -> push; remote hasn't moved.
 * - Etag changed -> conflict; remote wins, caller must not push.
 */
export function decideDueSync(
  syncRecord: {lastSyncedEtag?: string} | undefined,
  currentRemoteEtag: string | undefined,
): 'push' | 'conflict' {
  if (!syncRecord?.lastSyncedEtag) return 'push';
  if (!currentRemoteEtag) return 'push'; // can't compare -- fail open rather than block every edit
  return syncRecord.lastSyncedEtag === currentRemoteEtag ? 'push' : 'conflict';
}

/**
 * Pushes a handwritten due-date edit for an existing TickTick task, with
 * conflict detection. This is the function updateReminderDue's ticktick
 * branch (macServer.ts) delegates to.
 *
 * On a network failure, queues the edit to the outbox and returns normally
 * (does NOT throw) -- the caller sees this as "handled," with a friendlier
 * "saved offline" message rather than the generic failure warning capture.ts
 * shows for every other kind of failure. On a genuine conflict, throws a
 * descriptive error, which capture.ts's EXISTING catch-and-warn already
 * turns into a visible warning -- no capture.ts change needed for that.
 */
export async function pushTicktickDue(
  config: Ink2TaskConfig,
  reminderId: string,
  due: string,
): Promise<void> {
  const state = await loadTicktickSyncState();
  const record = state[reminderId];

  let currentEtag: string | undefined;
  try {
    const remote = await ticktickGetReminder(config, reminderId);
    currentEtag = remote.etag;
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueueTicktickOutbox({
        id: newOutboxId(),
        kind: 'setDue',
        reminderId,
        payload: {due},
        queuedAt: Date.now(),
      });
      return; // handled -- see the "saved offline" framing in the file doc above
    }
    throw err; // a real rejection (e.g. task deleted remotely, 404) -- surface it
  }

  if (decideDueSync(record, currentEtag) === 'conflict') {
    throw new Error(
      'This task changed in TickTick since the last sync -- your handwritten ' +
        `due date ("${due}") was not applied, to avoid overwriting the newer ` +
        'change. Review the task in TickTick and re-write the date if it still applies.',
    );
  }

  try {
    const updated = await ticktickUpdateReminder(config, reminderId, {due});
    state[reminderId] = {reminderId, lastSyncedEtag: updated.etag, lastSyncedDue: due};
    await saveTicktickSyncState(state);
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueueTicktickOutbox({
        id: newOutboxId(),
        kind: 'setDue',
        reminderId,
        payload: {due},
        queuedAt: Date.now(),
      });
      return;
    }
    throw err;
  }
}

/**
 * General field push (title/notes/due/priority) for a future editing UI --
 * see the file-level scope note. Same conflict/outbox handling as
 * pushTicktickDue, generalized. Not called from anywhere yet.
 */
export async function pushTicktickFields(
  config: Ink2TaskConfig,
  reminderId: string,
  fields: {title?: string; notes?: string; due?: string | null; priority?: 1 | 2 | 3 | 4},
): Promise<void> {
  const state = await loadTicktickSyncState();
  const record = state[reminderId];

  let currentEtag: string | undefined;
  try {
    currentEtag = (await ticktickGetReminder(config, reminderId)).etag;
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueueTicktickOutbox({
        id: newOutboxId(),
        kind: 'update',
        reminderId,
        payload: fields,
        queuedAt: Date.now(),
      });
      return;
    }
    throw err;
  }

  if (decideDueSync(record, currentEtag) === 'conflict') {
    throw new Error(
      'This task changed in TickTick since the last sync -- your edit was not ' +
        'applied, to avoid overwriting the newer change.',
    );
  }

  try {
    const updated = await ticktickUpdateReminder(config, reminderId, fields);
    state[reminderId] = {
      ...record,
      reminderId,
      lastSyncedEtag: updated.etag,
      ...(fields.due !== undefined ? {lastSyncedDue: fields.due ?? undefined} : {}),
    };
    await saveTicktickSyncState(state);
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueueTicktickOutbox({
        id: newOutboxId(),
        kind: 'update',
        reminderId,
        payload: fields,
        queuedAt: Date.now(),
      });
      return;
    }
    throw err;
  }
}

/** Appends an outbox entry. De-dupes on (kind, reminderId): a second edit to
 * the same field before the first one drains REPLACES it rather than queuing
 * both -- only the latest value matters, and replaying an earlier one after
 * a later one would silently revert the user's most recent edit. */
export async function enqueueTicktickOutbox(entry: TickTickOutboxEntry): Promise<void> {
  const outbox = await loadTicktickOutbox();
  const next = outbox.filter(e => !(e.kind === entry.kind && e.reminderId === entry.reminderId));
  next.push(entry);
  await saveTicktickOutbox(next);
}

export type DrainResult = {applied: number; stillQueued: number; dropped: number};

/**
 * Retries every queued outbox entry. Call this FIRST in a ticktick sync pass
 * (before reading fresh remote state), so a pending local edit lands before
 * the fresh fetch that will redraw the page from remote values -- otherwise
 * a successfully-drained edit could be immediately overwritten by a stale
 * read in the same sync.
 *
 * Per entry:
 *   - succeeds -> removed from the outbox, sync-state updated (for setDue/update)
 *   - fails with a network error -> LEFT in the outbox, tried again next time
 *   - fails with 404 (task/project gone) -> DROPPED; nothing to apply to anymore
 *   - fails any other way -> DROPPED and logged; retrying an outright
 *     rejection without anything changing would only fail again
 *
 * Never throws -- offline draining is best-effort background work, not
 * something that should abort a sync.
 */
export async function drainTicktickOutbox(config: Ink2TaskConfig): Promise<DrainResult> {
  const outbox = await loadTicktickOutbox();
  if (outbox.length === 0) return {applied: 0, stillQueued: 0, dropped: 0};

  const remaining: TickTickOutboxEntry[] = [];
  let applied = 0;
  let dropped = 0;
  const state = await loadTicktickSyncState();

  for (const entry of outbox) {
    try {
      switch (entry.kind) {
        case 'setDue':
        case 'update': {
          const updated = await ticktickUpdateReminder(config, entry.reminderId, entry.payload ?? {});
          state[entry.reminderId] = {
            ...state[entry.reminderId],
            reminderId: entry.reminderId,
            lastSyncedEtag: updated.etag,
            ...(entry.payload?.due !== undefined ? {lastSyncedDue: entry.payload.due ?? undefined} : {}),
          };
          break;
        }
        case 'complete': {
          const ok = await ticktickComplete(config, entry.reminderId);
          if (!ok) throw new Error('TickTick server did not confirm completion');
          break;
        }
        case 'uncomplete': {
          const ok = await ticktickUncomplete(config, entry.reminderId);
          if (!ok) throw new Error('TickTick server did not confirm un-completion');
          break;
        }
        case 'delete': {
          await ticktickDeleteReminder(config, entry.reminderId);
          delete state[entry.reminderId];
          break;
        }
      }
      applied++;
    } catch (err) {
      if (isNetworkError(err)) {
        remaining.push(entry); // still offline (or server down) -- try again next sync
      } else {
        // A real rejection (404, bad request, etc) -- won't succeed by
        // retrying unchanged, so don't keep it forever.
        console.log('[Ink2Task] TickTick outbox entry dropped:', entry.kind, (err as Error)?.message);
        dropped++;
      }
    }
  }

  await saveTicktickSyncState(state);
  await saveTicktickOutbox(remaining);
  return {applied, stillQueued: remaining.length, dropped};
}

/**
 * Drops sync-state records for tasks no longer in the current remote fetch
 * (completed, deleted, or moved out of the synced project) -- mirrors
 * actions.ts's reconcileBackLinks, which does the same cleanup for
 * task-sources.json. Keeps the state file from growing unboundedly and
 * avoids ever comparing against a stale etag for a task that's gone.
 */
export function pruneTicktickSyncState(
  state: TickTickSyncState,
  liveReminderIds: string[],
): TickTickSyncState {
  const live = new Set(liveReminderIds);
  const next: TickTickSyncState = {};
  for (const [id, record] of Object.entries(state)) {
    if (live.has(id)) next[id] = record;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Orchestration entry points -- NOT YET CALLED from anywhere.
//
// Why: complete/uncomplete/due-edit already work correctly for TickTick
// through the EXISTING generic sync flow in actions.ts, with zero changes to
// that file -- ticktick-server matches the shared HTTP contract exactly for
// completeReminders/uncompleteReminders, and updateReminderDue's ticktick
// branch (macServer.ts) already handles the due-edit path. The two things
// below are the only genuinely NEW per-sync steps, and they have no natural
// per-task dispatch point to hook into -- they need an explicit call site.
// That call site is `if (activeProfileOf(eff).backend === 'ticktick') { ... }`
// in actions.ts's syncThenFetch, added in Stage 4 alongside the Settings UI
// that lets a TickTick profile exist at all. Adding that branch NOW, before
// any profile can select 'ticktick', would be dead code with no way to
// exercise it -- these functions are complete, tested, and ready for that
// call whenever Stage 4 adds it.
// ---------------------------------------------------------------------------

/** Call FIRST in a ticktick sync pass, before fetching fresh remote state --
 * see drainTicktickOutbox's own doc for why the ordering matters. */
export async function runTicktickPreSync(config: Ink2TaskConfig): Promise<DrainResult> {
  return drainTicktickOutbox(config);
}

/** Call AFTER a successful fetch, with the ids of every task that fetch
 * returned, to drop sync-state for anything no longer live. */
export async function runTicktickPostSync(liveReminderIds: string[]): Promise<void> {
  const state = await loadTicktickSyncState();
  await saveTicktickSyncState(pruneTicktickSyncState(state, liveReminderIds));
}
