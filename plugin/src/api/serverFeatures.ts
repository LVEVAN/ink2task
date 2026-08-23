/**
 * Plugin/server capability negotiation. Pure logic, deliberately in its own
 * module with NO imports: macServer.ts pulls in config.ts, which pulls in
 * sn-plugin-lib, which is a native ESM module Jest cannot transform. Keeping
 * this here is what makes it unit-testable at all (see __tests__/serverFeatures).
 *
 * macServer.ts re-exports everything below, so callers can keep importing from
 * there and don't need to know this split exists.
 */

/**
 * Optional wire capabilities a server can advertise on /health, for features
 * that need BOTH halves updated to work. The plugin and the servers ship
 * separately (the user installs a .snplg but updates a server by pulling the
 * repo), so they drift routinely and there was previously no way to notice.
 *
 * A capability list, not a version number, because every server in this repo
 * still reports package.json `0.1.0` and never bumps it, so a version compare
 * would be meaningless. The KEY distinction is presence:
 *
 *   features absent   -> server predates capability reporting, i.e. out of date
 *   features: []      -> current server that genuinely supports nothing extra
 *   features: ['x']   -> current server that supports x
 *
 * Without that, "no subtasks" from an old server would be indistinguishable
 * from "no subtasks" from Apple, which can never support them at all.
 */
export type ServerFeature = 'subtasks';

/**
 * Backends whose API can express subtasks, so a missing `subtasks` capability
 * means the SERVER is behind rather than the backend being incapable. Apple is
 * deliberately absent: EventKit has no subtask API (see RemoteReminder.parentId),
 * so telling the user to update their Mac server would be actively wrong.
 */
const SUBTASK_CAPABLE_BACKENDS = ['todoist', 'google', 'ticktick'];

export type HealthResult =
  | {
      ok: true;
      listName: string;
      /** Backend the server reported, if it said. Absent on very old servers. */
      backend?: string;
      /** Absent (not empty) when the server is too old to report capabilities. */
      features?: string[];
    }
  | {ok: false; error: string};

/**
 * True when this backend COULD do subtasks but the connected server isn't
 * advertising them, i.e. the server half needs updating. False for Apple
 * (permanently incapable), for an unrecognised backend, and whenever we can't
 * tell: a wrong "update your server" is worse than staying quiet.
 */
export function serverMissingSubtasks(health: HealthResult): boolean {
  if (!health.ok) return false;
  // No backend reported at all means a server far older than this check.
  if (!health.backend) return false;
  if (!SUBTASK_CAPABLE_BACKENDS.includes(health.backend)) return false;
  return !health.features?.includes('subtasks');
}
