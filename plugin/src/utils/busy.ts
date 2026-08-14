/**
 * Self-healing single-flight guard for index.js's on-page SYNC button and
 * lasso-capture button (they share this state so the two can't run at
 * once -- a sync and a lasso capture both mutate the checklist note).
 *
 * Complements the withTimeout wrapping already around syncThenFetch /
 * addLassoedTaskToInk2Task (added v1.0.19 after a device-reported hang left
 * the OLD boolean `busy` flag stuck true forever, silently disabling both
 * buttons with zero visible symptom until a device reboot): that recovery
 * only works IF the wrapped promise itself eventually settles via the
 * timeout race. This is a second, independent line of defense that doesn't
 * depend on that race firing at all -- it just checks a wall-clock
 * timestamp on the NEXT tap, so even a failure mode that somehow defeats
 * the timeout race still self-heals on whatever tap comes after it.
 *
 * Ported from a peer Supernote plugin (vincentaravantinos/
 * supernote-collapse-expand, src/logic/busy.ts) that hit the same class of
 * "stuck busy flag forever" bug independently and designed this specific
 * pattern for exactly that reason.
 */
// Comfortably longer than any legitimate operation: a real sync is
// device-measured at ~5-9s, and the withTimeout wrapping above already
// caps any single attempt at 60s -- 90s only kicks in if THAT somehow
// didn't clear the flag.
const STALE_MS = 90000;

let busySince: number | null = null;

/** True if the guard was free (or stale) and is now held by the caller. */
export function acquireBusy(): boolean {
  if (busySince !== null) {
    if (Date.now() - busySince < STALE_MS) return false;
    console.log(
      `Ink2Task: busy guard stale (held >${STALE_MS / 1000}s) -- self-healing`,
    );
  }
  busySince = Date.now();
  return true;
}

export function releaseBusy(): void {
  busySince = null;
}
