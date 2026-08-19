import {PluginCommAPI} from 'sn-plugin-lib';

/**
 * Shared unwrapping for the Supernote SDK's response envelopes.
 *
 * Every Plugin*API call resolves to {success, result, error} rather than the
 * bare value, and parameter validation *resolves* with success:false instead
 * of throwing. An unchecked call therefore fails silently and the envelope
 * gets used as if it were the payload -- which surfaces much later as an
 * opaque "undefined is not a function". Unwrap at every call site so failures
 * report themselves where they actually happen.
 */
export async function unwrap<T>(call: Promise<any>, what: string): Promise<T> {
  const res: any = await call;
  if (res && typeof res === 'object' && 'success' in res) {
    if (!res.success) {
      const {message = 'unknown error', code = '?'} = res.error ?? {};
      throw new Error(`${what} failed (${code}): ${message}`);
    }
    return res.result as T;
  }
  // Tolerate SDK builds that resolve the bare value instead of an envelope.
  return res as T;
}

/**
 * Races a promise against a timeout, rejecting if it hasn't settled in time.
 *
 * Some native calls (device-observed 0.2.89: getCurrentFilePath/getCurrentPageNum,
 * called from a context with no active note editor -- e.g. the plugin opened via
 * Settings > Apps > Plugins rather than from a note) don't reject quickly like a
 * normal error; they just never resolve at all. An un-timed await on one of those
 * hangs forever with no way to recover except force-closing the plugin. Wrap any
 * call that might run outside a guaranteed note context in this.
 */
/**
 * Frees the native-side cache behind a batch of elements.
 *
 * Elements are native-backed: both getElements and createElement hand back a
 * handle whose real data lives on the native side, and the SDK expects it to be
 * released when you're done. Skipping this leaks on EVERY sync -- a redraw
 * allocates ~66 elements and each page scan reads every element on the page --
 * and the plugin lives in a long-running PluginHost process, so it accumulates
 * across a session.
 *
 * NOTE: use `recycleElement(uuid)`, NOT `element.recycle()`. The SDK's Element
 * CLASS has a recycle() method, but nothing we hold is an instance of it --
 * `transformElements`/`createElement` mutate the raw bridge objects in place
 * (attaching data accessors) rather than constructing Elements, so `.recycle`
 * is undefined on them. Verified against sn-plugin-lib 0.1.43.
 *
 * Best-effort and never throws: a failed recycle must not fail a sync, and
 * double-recycling a handle is not worth guarding against at every call site.
 */
export function recycleElements(elements: any[] | null | undefined): void {
  for (const el of elements || []) {
    try {
      const uuid = el?.uuid;
      if (typeof uuid === 'string' && uuid) PluginCommAPI.recycleElement(uuid);
    } catch {
      // already recycled, or a handle the host has since dropped
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
}

/**
 * Translates known raw error messages into something a user can actually act
 * on. Two sources feed this: React Native's own bare "Network request
 * failed" (fetch() throws the same string for everything from "wrong IP" to
 * "server's not running" to "phone's on the wrong Wi-Fi"), and whatever the
 * backend servers pass through verbatim from their own API client -- e.g.
 * google-tasks-server used to relay Google's raw OAuth error codes unchanged
 * (device-confirmed 2026-08-19: a stale token surfaced as the bare string
 * "invalid_grant", meaningless without context). Previously only the on-page
 * SYNC button and lasso capture (index.js) translated the network case; the
 * Settings screen showed raw strings verbatim, which is exactly what showed
 * up unexplained in ink2task#2's early reports before we worked out what was
 * actually wrong. Anywhere a caught error's `.message` reaches the user
 * should go through this.
 *
 * The invalid_grant case below is a fallback, not the primary path: a
 * current google-tasks-server now catches this itself and auto-launches
 * reauthorization (see its server.ts), returning its OWN already-friendly
 * "check the computer running this server" message rather than the raw
 * Google error code -- so this branch should only ever fire against an
 * older server version, or some other path that still leaks the raw code.
 */
export function friendlyErrorMessage(raw: string): string {
  if (/network request failed/i.test(raw)) {
    return "Couldn't reach the sync server -- check you're online and on the right Wi-Fi.";
  }
  if (/invalid_grant/i.test(raw)) {
    return (
      'Google Tasks needs to be reconnected -- the stored access has expired or was ' +
      'revoked. A current google-tasks-server does this automatically: check the ' +
      "computer running it for a browser sign-in prompt, then try again once you've " +
      'signed in. If nothing happens, run `npm run authorize` there manually as a ' +
      'fallback.'
    );
  }
  return raw;
}
