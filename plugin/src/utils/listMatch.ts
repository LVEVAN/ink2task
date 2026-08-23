/**
 * Recovering from "the configured list does not exist on this backend".
 *
 * Every backend's list names are its own, but the plugin stores ONE default
 * ("Inbox") for a fresh profile. That name is real in Todoist, Apple Reminders
 * and Google Tasks, and absent in TickTick, whose projects are whatever the
 * user made -- so switching to the TickTick profile and syncing failed with
 * `No TickTick project named "Inbox" was found.` before it had ever worked
 * once (device-reported 2026-08-23; the available projects there were
 * "👋Work Tasks", "💼Work", "🏠Personal").
 *
 * Import-free on purpose so it stays unit testable -- see the note in
 * taskText.ts about Jest and the SDK's ESM.
 */

/** Wordings the four servers use when the requested list is not there. */
export function isListMissingError(message: string): boolean {
  return (
    // mac-server (Reminders.swift), todoist-server, ticktick-server, and the
    // plugin's own direct-Todoist path all phrase it this way.
    /No (?:\w+ )*(?:project|list|Reminders list) named "/i.test(message) ||
    // google-tasks-server's ListNotFoundError, plus the generic phrasing
    // explainSyncFailure produces.
    /list ".*" does not exist/i.test(message) ||
    /ListNotFoundError/.test(message)
  );
}

/**
 * Normalises a list name for comparison: drops case, and drops everything that
 * is not a letter or digit. That is what makes "🏠Personal" match "Personal" --
 * TickTick users routinely prefix an emoji, and the emoji is invisible to
 * someone typing the name into Settings.
 */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Names that mean "the default place things go", best-effort across backends. */
const DEFAULT_LIKE = ['inbox', 'tasks', 'mytasks', 'todo', 'todos', 'reminders'];

export type ListChoice = {
  name: string;
  /**
   * Why this name was picked, for the message shown to the user. Never silent:
   * a sync that quietly retargets which list it writes to is worse than an
   * error, because tasks land somewhere the user did not choose and did not
   * see.
   */
  reason: 'same-name' | 'only-list' | 'default-like';
};

/**
 * Picks a replacement for a missing list, but ONLY when the choice is
 * unambiguous. Returns null when a human has to decide, which is the common
 * case for a backend with several real projects -- guessing there could file
 * personal tasks into a work project.
 *
 * Order: the same name in different dress (case or emoji) beats everything,
 * since it is almost certainly the list meant; then a single available list,
 * where there is nothing else it could be; then a recognisable default/inbox,
 * but only when exactly one candidate matches, so "Tasks" plus "To Do" stays a
 * question rather than a coin flip.
 */
export function pickReplacementList(want: string, lists: string[]): ListChoice | null {
  const clean = lists.filter(n => typeof n === 'string' && n.trim().length > 0);
  if (clean.length === 0) return null;

  const target = normalise(want);
  const sameName = clean.filter(n => normalise(n) === target);
  if (sameName.length === 1) return {name: sameName[0], reason: 'same-name'};

  if (clean.length === 1) return {name: clean[0], reason: 'only-list'};

  const defaults = clean.filter(n => DEFAULT_LIKE.includes(normalise(n)));
  if (defaults.length === 1) return {name: defaults[0], reason: 'default-like'};

  return null;
}

/** One line explaining a switch, for the sync summary. */
export function describeListSwitch(from: string, choice: ListChoice): string {
  switch (choice.reason) {
    case 'same-name':
      return `Using "${choice.name}" -- same list as "${from}", spelled differently here.`;
    case 'only-list':
      return `"${from}" does not exist here, and "${choice.name}" is the only list, so it was used.`;
    default:
      return `"${from}" does not exist here, so the default list "${choice.name}" was used.`;
  }
}
