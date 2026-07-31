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
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);
}
