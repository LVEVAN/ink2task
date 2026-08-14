/**
 * Thin client for the Ink2Task TickTick companion server (ticktick-server/).
 *
 * ticktick-server speaks the SAME base contract as mac-server/
 * google-tasks-server (GET /health, /lists, /reminders; POST /reminders,
 * /complete; POST /uncomplete), so the EXISTING generic functions in
 * ./macServer.ts (fetchLists, fetchReminders, completeReminders,
 * uncompleteReminders, createReminder) already work against it unchanged --
 * this file only adds what those don't cover: reading/updating/moving/
 * deleting ONE task by id, and getting its current etag for conflict
 * detection. None of this exists for any other backend yet, so none of it
 * is called from anywhere generic -- only from the ticktick-specific paths
 * in macServer.ts and ticktickSync.ts.
 */
import type {Ink2TaskConfig} from '../utils/config';

const TIMEOUT_MS = 6000; // matches macServer.ts's LAN timeout -- same kind of call

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out reaching TickTick server')), TIMEOUT_MS),
    ),
  ]);
}

function baseUrl(config: Ink2TaskConfig): string {
  return `http://${config.host}:${config.port}`;
}

/** Matches ticktick-server's toWireReminder shape. */
export type TicktickRemoteTask = {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  priority?: 1 | 2 | 3 | 4;
  etag?: string;
};

/** GET /reminders/:id -- one task, always including etag when TickTick has one. */
export async function ticktickGetReminder(
  config: Ink2TaskConfig,
  id: string,
): Promise<TicktickRemoteTask> {
  const res = await withTimeout(
    fetch(
      `${baseUrl(config)}/reminders/${encodeURIComponent(id)}?list=${encodeURIComponent(config.listName)}`,
    ),
  );
  if (!res.ok) {
    throw new Error(`TickTick server returned ${res.status} while reading the task`);
  }
  return res.json();
}

export type TicktickUpdateFields = {
  title?: string;
  notes?: string;
  /** Explicit null clears the due date; undefined leaves it unchanged. */
  due?: string | null;
  priority?: 1 | 2 | 3 | 4;
};

/** POST /reminders/:id -- updates title/notes/due/priority. Never moves the task. */
export async function ticktickUpdateReminder(
  config: Ink2TaskConfig,
  id: string,
  fields: TicktickUpdateFields,
): Promise<TicktickRemoteTask> {
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/reminders/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({list: config.listName, ...fields}),
    }),
  );
  if (!res.ok) {
    throw new Error(`TickTick server returned ${res.status} while updating the task`);
  }
  return res.json();
}

/** POST /reminders/:id/move -- moves a task to a different TickTick project. */
export async function ticktickMoveReminder(
  config: Ink2TaskConfig,
  id: string,
  fromList: string,
  toList: string,
): Promise<void> {
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/reminders/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({fromList, toList}),
    }),
  );
  if (!res.ok) {
    throw new Error(`TickTick server returned ${res.status} while moving the task`);
  }
}

/** DELETE /reminders/:id -- permanently deletes a task. */
export async function ticktickDeleteReminder(config: Ink2TaskConfig, id: string): Promise<void> {
  const res = await withTimeout(
    fetch(
      `${baseUrl(config)}/reminders/${encodeURIComponent(id)}?list=${encodeURIComponent(config.listName)}`,
      {method: 'DELETE'},
    ),
  );
  if (!res.ok) {
    throw new Error(`TickTick server returned ${res.status} while deleting the task`);
  }
}

/**
 * Single-task complete/uncomplete, kept HERE rather than reusing macServer.ts's
 * generic completeReminders/uncompleteReminders (which would work fine against
 * ticktick-server too, same contract). The duplication is deliberate: it keeps
 * this file a leaf module with no local imports beyond the config type, so
 * ticktickSync.ts (which needs both this file AND to be importable FROM
 * macServer.ts, for the conflict-aware due-date push) can depend on this
 * without creating a macServer.ts <-> ticktickSync.ts import cycle.
 */
export async function ticktickComplete(config: Ink2TaskConfig, id: string): Promise<boolean> {
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/complete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ids: [id], list: config.listName}),
    }),
  );
  if (!res.ok) throw new Error(`TickTick server returned ${res.status} while completing the task`);
  const data = await res.json();
  return Array.isArray(data.completed) && data.completed.includes(id);
}

export async function ticktickUncomplete(config: Ink2TaskConfig, id: string): Promise<boolean> {
  const res = await withTimeout(
    fetch(`${baseUrl(config)}/uncomplete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ids: [id], list: config.listName}),
    }),
  );
  if (!res.ok) throw new Error(`TickTick server returned ${res.status} while un-completing the task`);
  const data = await res.json();
  return Array.isArray(data.uncompleted) && data.uncompleted.includes(id);
}
