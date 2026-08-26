/**
 * What Ink2Task needs permission for, and what to say when it is refused.
 *
 * Import-free so it stays unit testable (see taskText.ts on Jest and the SDK's
 * ESM). The half that actually calls the SDK lives in permissions.ts.
 *
 * Background: the plugin preview build (Chauvet 3.29.43 / 2.26.40, 2026-08-24)
 * added permission management. A permission must be listed in
 * PluginConfig.json's `uses-permissions` before it can even be requested --
 * requesting an undeclared one fails with 1500, and an unrecognised one with
 * 1502. Keep this list and that file in step.
 */

export const PERMISSIONS = {
  /**
   * Every backend call: the three companion servers over the LAN and Todoist
   * over the internet. Also covers the native raw socket in lanHttp.ts -- the
   * docs are explicit that this gates "native RN/Android/C++ network APIs",
   * not just requests made through sn-plugin-lib, so the cleartext workaround
   * needs it too.
   */
  INTERNET: 'plugin.permission.INTERNET',
  /**
   * Reading config.json, the checklist registry, and every page of the note.
   * Nothing works without it: only the plugin's own private directory is
   * readable by default, and everything we touch lives in MyStyle/ and Note/.
   */
  FILE_READ: 'plugin.permission.FILE:READ',
  /**
   * Writing those same files, creating the checklist note, and drawing onto
   * its pages. Note this ALSO covers deleting elements and pages -- the docs
   * are explicit that the element-deletion methods are validated against
   * FILE:WRITE, not FILE:DELETE.
   */
  FILE_WRITE: 'plugin.permission.FILE:WRITE',
  /**
   * Deleting an actual FILE from shared storage. We do this in exactly one
   * place: clearing the loose template file left behind by builds before the
   * SuperRemind -> Ink2Task rename. Page reclamation and element clearing do
   * NOT need this (see FILE_WRITE), which is why a refusal here is survivable.
   */
  FILE_DELETE: 'plugin.permission.FILE:DELETE',
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * The ones a sync genuinely cannot proceed without.
 *
 * FILE:DELETE is deliberately NOT here, and FILE:READ deliberately IS.
 * sn-plugin-lib's own documentation comments omit FILE:READ, which briefly made
 * it look optional, but the permission docs settle it: it is real, it is "not
 * granted by default", and there is a dedicated error code (1503) for calling
 * without it. Reading the config, the registry and the note pages is the first
 * thing every sync does, so a refusal there is fatal.
 *
 * FILE:DELETE, by contrast, only gates deleting a real file from shared
 * storage, which we do once, for a leftover from the July rename. Element and
 * page deletion are validated against FILE:WRITE. Blocking a sync because a
 * stale file could not be tidied would be absurd.
 */
export const REQUIRED: PermissionName[] = [
  PERMISSIONS.INTERNET,
  PERMISSIONS.FILE_READ,
  PERMISSIONS.FILE_WRITE,
];

/** Every permission worth asking for, in the order the dialogs should appear. */
export const REQUESTED: PermissionName[] = [
  PERMISSIONS.INTERNET,
  PERMISSIONS.FILE_READ,
  PERMISSIONS.FILE_WRITE,
  PERMISSIONS.FILE_DELETE,
];

/**
 * requestPermission's answer. 1 and 2 both mean yes -- the difference is only
 * how long it lasts (1 is this session, 2 persists), which is the host's
 * business, not ours. -1 is the user dismissing the dialog without choosing,
 * which is a "not now", not a refusal.
 */
export type PermissionResult = -1 | 0 | 1 | 2;

export function isGranted(result: number | null | undefined): boolean {
  return result === 1 || result === 2;
}

/**
 * Why we want each one, shown in the authorization dialog.
 *
 * The host only uses this when the permission was previously declined -- that
 * request puts up a redirect-to-settings dialog rather than a fresh prompt, so
 * this text is what a stuck user reads. Worth writing for that moment
 * specifically, not as a generic blurb.
 */
export function permissionReason(name: string): string | undefined {
  switch (name) {
    case PERMISSIONS.INTERNET:
      return 'Ink2Task needs internet access to reach your task list.';
    case PERMISSIONS.FILE_READ:
      return 'Ink2Task needs to read your checklist note to see what you have written and ticked off.';
    case PERMISSIONS.FILE_WRITE:
      return 'Ink2Task needs to write to your checklist note to draw your task list onto the page.';
    case PERMISSIONS.FILE_DELETE:
      return 'Ink2Task uses this only to clear out a leftover file from an older version.';
    default:
      return undefined;
  }
}

/** Plain-English name for a permission, for messages. */
export function permissionLabel(name: string): string {
  switch (name) {
    case PERMISSIONS.INTERNET:
      return 'internet access';
    case PERMISSIONS.FILE_READ:
      return 'reading your notes and settings';
    case PERMISSIONS.FILE_WRITE:
      return 'saving to your notes and settings';
    case PERMISSIONS.FILE_DELETE:
      return 'tidying up an old leftover file';
    default:
      return name;
  }
}

/**
 * The message shown when a sync cannot run. Names what was refused and how to
 * undo it, because a permission dialog answered "don't allow" is easy to do by
 * accident and impossible to guess your way out of.
 */
export function explainDenied(denied: string[]): string {
  if (denied.length === 0) return '';
  const what = denied.map(permissionLabel);
  const list =
    what.length === 1
      ? what[0]
      : `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}`;
  // Says WHERE to fix it. The first version said only "that was declined",
  // which was wrong twice over: the user had cancelled the dialog rather than
  // refusing, and once they did want to grant it there was nothing on screen
  // telling them where to go (device-reported 2026-08-25). The path below is
  // where the tablet actually keeps it.
  return (
    `Ink2Task needs permission for ${list}. Nothing was synced.\n\n` +
    'Either tap Sync again and choose Allow when the tablet asks, or set it ' +
    'yourself in the tablet\'s Settings > Apps > Plugins > Ink2Task, where ' +
    'Modify Files should be Allow rather than Ask Every Time.'
  );
}

/**
 * Prefix stamped on a permission-refusal Error, so code that catches it can
 * tell "you did not allow this" apart from "the network failed" WITHOUT
 * importing the SDK -- this module has no imports, which is what lets
 * discover.ts (and its tests) recognise a refusal while staying loadable.
 *
 * It exists because those two cases looked identical on screen: a refused
 * permission made every discovery probe fail, and the button reported "no
 * matching server", which reads as "your server is off". Stripped before the
 * text is ever shown.
 */
const DENIED_MARKER = '[permission-denied] ';

/** The Error message to throw when a required permission was refused. */
export function deniedMessage(denied: string[]): string {
  return DENIED_MARKER + explainDenied(denied);
}

/** True if this Error message came from a permission refusal. */
export function isDenialMessage(message: string): boolean {
  return typeof message === 'string' && message.startsWith(DENIED_MARKER);
}

/** The human half of a denial message, for display. */
export function withoutDenialMarker(message: string): string {
  return isDenialMessage(message) ? message.slice(DENIED_MARKER.length) : message;
}
