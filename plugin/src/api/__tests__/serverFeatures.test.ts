/**
 * Tests for serverMissingSubtasks, the plugin/server compatibility check.
 *
 * Worth testing despite being small: a wrong answer here shows the user a
 * misleading message in Settings. A false positive tells an Apple Reminders
 * user to "update your server" for something EventKit can never do, and a
 * false negative leaves a genuinely stale server looking fine while subtasks
 * silently render as ordinary rows.
 *
 * The distinction that matters is `features` ABSENT (server too old to report
 * capabilities) versus `features: []` (current server, nothing extra).
 */
// Import the pure module directly, not macServer: that would pull in config.ts
// -> sn-plugin-lib, a native ESM module Jest cannot transform.
import {serverMissingSubtasks, type HealthResult} from '../serverFeatures';

const ok = (extra: Partial<Extract<HealthResult, {ok: true}>> = {}): HealthResult => ({
  ok: true,
  listName: 'Inbox',
  ...extra,
});

describe('serverMissingSubtasks', () => {
  it('is false when the server advertises subtasks', () => {
    for (const backend of ['todoist', 'google', 'ticktick']) {
      expect(serverMissingSubtasks(ok({backend, features: ['subtasks']}))).toBe(false);
    }
  });

  it('is true for a capable backend whose server never reported features', () => {
    // The real "your halves have drifted" case: an old server predates the
    // features key entirely, so it omits it rather than sending [].
    for (const backend of ['todoist', 'google', 'ticktick']) {
      expect(serverMissingSubtasks(ok({backend}))).toBe(true);
    }
  });

  it('is true for a capable backend reporting features that omit subtasks', () => {
    expect(serverMissingSubtasks(ok({backend: 'ticktick', features: []}))).toBe(true);
    expect(serverMissingSubtasks(ok({backend: 'todoist', features: ['somethingElse']}))).toBe(true);
  });

  it('is false for Apple regardless of what it reports', () => {
    // EventKit has no subtask API, so this is permanent, not a version gap.
    // Telling the user to update their Mac server would be actively wrong.
    expect(serverMissingSubtasks(ok({backend: 'apple', features: []}))).toBe(false);
    expect(serverMissingSubtasks(ok({backend: 'apple'}))).toBe(false);
  });

  it('is false when no backend was reported, rather than guessing', () => {
    // A server this old predates the backend field too. Staying quiet beats a
    // possibly-wrong warning.
    expect(serverMissingSubtasks(ok())).toBe(false);
    expect(serverMissingSubtasks(ok({features: []}))).toBe(false);
  });

  it('is false for an unknown future backend', () => {
    // Fail closed: don't warn about a backend whose capabilities we can't know.
    expect(serverMissingSubtasks(ok({backend: 'notion', features: []}))).toBe(false);
  });

  it('is false when the health check failed, so errors are reported once', () => {
    // checkHealth's caller already surfaces the connection error; a capability
    // warning stacked on top would just be noise.
    expect(serverMissingSubtasks({ok: false, error: 'Timed out'})).toBe(false);
  });
});
