/**
 * Asks the host for the permissions the plugin preview build introduced.
 *
 * Two things make this different from every other SDK call in this codebase:
 *
 * 1. **hasPermission/requestPermission return a PLAIN number, not the usual
 *    {success, data, error} envelope.** Putting them through unwrap() would
 *    throw on a perfectly good answer. Verified against sn-plugin-lib 0.1.65's
 *    source, where both return Promise<number> straight from the native module.
 *
 * 2. **They do not exist on older firmware, and that must not be fatal.** A
 *    device on the current public build has no permission system at all, and
 *    the same .snplg has to keep working there. So a missing function, a
 *    throw, or an unrecognised-permission error (1502) all mean "this host does
 *    not gate that -- carry on", never "refused".
 *
 * Only an explicit 0 from a host that DOES have the API counts as a refusal.
 */
import {PluginManager} from 'sn-plugin-lib';
import {
  PERMISSIONS,
  REQUIRED,
  REQUESTED,
  isGranted,
  explainDenied,
  deniedMessage,
  permissionReason,
  type PermissionName,
} from './permissionPolicy';

export type PermissionCheck = {
  /** False only when something in REQUIRED was actually refused. */
  ok: boolean;
  /** Required permissions the user declined, for the message. */
  denied: PermissionName[];
  /** True when this host has no permission system (older firmware). */
  unsupported: boolean;
};

/** True once the host has answered, so a sync does not re-ask every time. */
let cached: PermissionCheck | null = null;
let inFlight: Promise<PermissionCheck> | null = null;
/**
 * Per-permission answers, so a single-permission gate (see ensureInternet)
 * asks for ONLY what it needs. Tapping "Find server on Wi-Fi" prompting for
 * file access would be baffling.
 */
const one = new Map<string, Promise<boolean>>();

function apiPresent(): boolean {
  const pm = PluginManager as any;
  return typeof pm?.hasPermission === 'function' && typeof pm?.requestPermission === 'function';
}

/**
 * Resolves one permission: granted already, or ask. Anything unexpected
 * resolves to granted -- see the note above on not being fatal.
 */
/**
 * ONLY GRANTS ARE CACHED.
 *
 * Caching a refusal was actively harmful: closing the dialog once meant the
 * plugin never asked again for the rest of the session, so after the user set
 * Modify Files to Allow in the tablet's own settings, syncing STILL failed with
 * "that was declined" and there was no way back short of restarting the plugin
 * (device-reported 2026-08-25). A grant cannot be taken away behind our back
 * mid-session, so caching that is safe. A refusal is exactly the state the user
 * goes off to change, so it must not outlive the attempt.
 *
 * The cost is that someone who genuinely means no is asked again on their next
 * sync. That is the better failure.
 */
async function resolveOneCached(name: PermissionName): Promise<boolean> {
  const pending = one.get(name);
  if (pending) {
    if (await pending) return true;
    one.delete(name); // never let a refusal stick
  }
  const fresh = resolveOne(name);
  one.set(name, fresh);
  return fresh;
}

async function resolveOne(name: PermissionName): Promise<boolean> {
  const pm = PluginManager as any;
  try {
    const has = await pm.hasPermission(name);
    if (isGranted(has)) return true;
  } catch (e: any) {
    // 1502 means this host does not recognise the permission at all. Anything
    // else here is equally not a refusal. Either way, do not block on it -- a
    // real refusal arrives as a 0 from requestPermission, not as a throw.
    console.log(`[Ink2Task] hasPermission(${name}) failed:`, e?.message || e);
    return true;
  }
  try {
    // The description is only surfaced when this permission was previously
    // declined, which is exactly the case where the user needs telling why.
    const asked = await pm.requestPermission(name, permissionReason(name));
    // -1 is the dialog being closed without choosing. Logged separately because
    // the user was told they had "declined" when they had only cancelled, and
    // the two feel nothing alike -- only one of them means no. Neither is
    // cached; see resolveOneCached.
    if (asked === -1) console.log(`[Ink2Task] ${name}: dialog closed without an answer`);
    return isGranted(asked);
  } catch (e: any) {
    console.log(`[Ink2Task] requestPermission(${name}) failed:`, e?.message || e);
    return true;
  }
}

async function run(): Promise<PermissionCheck> {
  if (!apiPresent()) {
    console.log('[Ink2Task] permissions: host has no permission API (older firmware)');
    return {ok: true, denied: [], unsupported: true};
  }
  const denied: PermissionName[] = [];
  // Sequential, not parallel: each one can put a dialog on screen, and firing
  // four at once would stack them.
  for (const name of REQUESTED) {
    const granted = await resolveOneCached(name);
    if (!granted && REQUIRED.includes(name)) denied.push(name);
  }
  const result = {ok: denied.length === 0, denied, unsupported: false};
  console.log(
    `[Ink2Task] permissions: ${result.ok ? 'all granted' : 'DENIED ' + denied.join(', ')}`,
  );
  return result;
}

/**
 * Call before the first file or network work of an operation. Memoised, so the
 * dialogs appear once per plugin session rather than once per sync.
 *
 * A refusal is NOT cached as final in the sense of being unrecoverable: the
 * host's own settings can grant it later, and the cache dies with the session.
 */
export async function ensurePermissions(): Promise<PermissionCheck> {
  // Only a fully-granted result is reused, for the same reason resolveOneCached
  // caches grants only: a refusal is precisely the state the user goes off to
  // change in the tablet's own settings, and it must not outlive that.
  if (cached && cached.ok) return cached;
  if (!inFlight) {
    inFlight = run()
      .then(r => {
        cached = r;
        return r;
      })
      .catch(e => {
        console.log('[Ink2Task] permissions check threw:', e?.message || e);
        // Never let this be the thing that breaks a sync.
        const fallback: PermissionCheck = {ok: true, denied: [], unsupported: true};
        cached = fallback;
        return fallback;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Gate for anything that touches the network, on its own so it can sit at the
 * BOTTOM of the stack rather than at each button.
 *
 * The bug this exists for: permissions were only requested when a sync began,
 * so "Find server on Wi-Fi" swept the whole subnet with no internet permission,
 * every probe failed, and it reported "no matching server" -- indistinguishable
 * from the server genuinely being off (device-reported 2026-08-24). Gating the
 * button would have fixed that one button; gating here fixes every current and
 * future caller, because they all go through lanFetch, the discovery probe, or
 * Todoist's own request helper.
 *
 * Asks for INTERNET only. Requesting the file permissions here too would put
 * three unrelated dialogs in front of someone who just tapped a search button.
 */
export async function ensureInternet(): Promise<{ok: boolean; message: string}> {
  if (!apiPresent()) return {ok: true, message: ''};
  const granted = await resolveOneCached(PERMISSIONS.INTERNET).catch(() => true);
  return granted
    ? {ok: true, message: ''}
    : {ok: false, message: deniedMessage([PERMISSIONS.INTERNET])};
}

/**
 * Gate for anything that touches shared storage, at the bottom of the stack for
 * the same reason as ensureInternet.
 *
 * The bug: DECLARING a permission in PluginConfig.json is not granting it. The
 * plugin reads its config the moment it starts, long before any sync asks for
 * anything, so on the preview firmware that first read happened unpermitted and
 * the host refused it -- "Plugin [ink2task001] has no WRITE permission on
 * sdcard". Everything downstream then failed quietly, including saving a token
 * that looked accepted (device-reported 2026-08-24).
 *
 * Asks for READ and WRITE, the two a sync cannot work without. DELETE is left
 * out on purpose: it gates one leftover-file cleanup, and a dialog for that at
 * startup would be noise. It is requested with the rest at sync time.
 */
export async function ensureFiles(
  which: PermissionName[] = [PERMISSIONS.FILE_READ, PERMISSIONS.FILE_WRITE],
): Promise<{ok: boolean; message: string}> {
  if (!apiPresent()) return {ok: true, message: ''};
  const denied: PermissionName[] = [];
  // Sequential: each can raise a dialog, and stacking them is unreadable.
  for (const name of which) {
    const granted = await resolveOneCached(name).catch(() => true);
    if (!granted) denied.push(name);
  }
  return denied.length === 0
    ? {ok: true, message: ''}
    : {ok: false, message: deniedMessage(denied)};
}

/** Throws the explanation, for call sites whose failure path reports an Error. */
export async function requireInternet(): Promise<void> {
  const res = await ensureInternet();
  if (!res.ok) throw new Error(res.message);
}

/**
 * Ask for READING files only.
 *
 * Split from writing on purpose. Opening Settings only READS the config, so
 * asking for both put two permission dialogs on screen before the user had seen
 * anything at all -- and the second one, asking to modify files, is not needed
 * to look at your own settings. Now the write dialog appears when something is
 * actually saved, which is a moment the user caused and can understand.
 */
export async function requireFileRead(): Promise<void> {
  const res = await ensureFiles([PERMISSIONS.FILE_READ]);
  if (!res.ok) throw new Error(res.message);
}

/** Ask for WRITING files (implies reading, which is asked for first). */
export async function requireFileWrite(): Promise<void> {
  const res = await ensureFiles([PERMISSIONS.FILE_READ, PERMISSIONS.FILE_WRITE]);
  if (!res.ok) throw new Error(res.message);
}

/** Both, for callers that will certainly do both. */
export async function requireFiles(): Promise<void> {
  const res = await ensureFiles();
  if (!res.ok) throw new Error(res.message);
}

/**
 * Forget one cached answer, so the next call asks the host again.
 *
 * Used after a refusal on an explicit user action: the host answers a REPEAT
 * request for something already declined with a redirect-to-settings dialog,
 * which is the only route back. Caching the refusal for the session would mean
 * pressing the button again just replays our own error text forever.
 */
export function forgetPermission(name: PermissionName): void {
  one.delete(name);
  cached = null;
}

/** Test seam: forget the cached answers so the next call re-asks. */
export function resetPermissionCache(): void {
  cached = null;
  inFlight = null;
  one.clear();
}
