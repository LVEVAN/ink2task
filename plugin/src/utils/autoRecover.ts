/**
 * One-shot auto-recovery for a sync's network calls, when the configured
 * server address has gone stale (e.g. the Mac's LAN IP changed via DHCP --
 * device-reported 2026-08-13, on Ink2Day first: a sync hung/failed with no
 * clear explanation until the address mismatch was found by hand). A full
 * "Find server on Wi-Fi" subnet sweep is too slow (worst case ~7s) to run
 * before EVERY sync, so this only pays that cost reactively, exactly when a
 * call has already failed with a connectivity error -- the common case
 * (server reachable) costs nothing extra.
 *
 * Ported from Ink2Day's utils/autoRecover.ts (same problem, same fix) --
 * this is the task-only version, since Ink2Task has no calendar side.
 */
import {discoverServer} from './discover';
import {isNetworkError} from './ticktickSync';
import {replaceStaleServerAddress, saveConfig} from './config';
import type {Ink2TaskConfig} from './config';

/**
 * Runs a task-backend call (fetchReminders, createReminder, ...) against
 * `config`. On a connectivity failure, scans the current Wi-Fi once for a
 * server matching this profile's backend; if a DIFFERENT address turns up,
 * retries the same call against it and -- only once that retry actually
 * succeeds -- persists the new address (to every profile that shared the
 * stale one, see replaceStaleServerAddress) so later syncs don't have to
 * rediscover at all.
 *
 * Exactly one retry, not a loop: a fresh discovery that still doesn't work
 * means something else is wrong (server down, wrong list, ...), and
 * retrying further would just add network round-trips without fixing
 * anything. Returns the possibly-updated config alongside the result so
 * the rest of the SAME sync pass can use the corrected address too, not
 * just the next one -- though only the caller that made the failing call
 * gets that benefit; concurrent calls already in flight against the old
 * config don't retroactively see the fix until their own next sync.
 */
export async function taskCallWithAutoRecover<T>(
  config: Ink2TaskConfig,
  call: (config: Ink2TaskConfig) => Promise<T>,
): Promise<{result: T; config: Ink2TaskConfig}> {
  try {
    return {result: await call(config), config};
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const backend = config.profiles[config.activeProfile]?.backend;
    const found = await discoverServer(config.port, backend).catch(() => null);
    if (!found || (found.host === config.host && found.port === config.port)) throw e;
    const patched = {...config, host: found.host, port: found.port};
    const result = await call(patched); // one retry only -- let a second failure throw uncaught
    const fixed = replaceStaleServerAddress(config, config.host, config.port, found.host, found.port);
    await saveConfig(fixed).catch(() => {});
    return {result, config: fixed};
  }
}
