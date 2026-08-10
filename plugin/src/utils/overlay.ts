/**
 * JS side of the Phase 1 sync-progress overlay probe.
 *
 * Background: the on-page SYNC button has nowhere to show progress. A sync runs
 * ~18s with no feedback, because the JS SDK can only open the plugin view
 * FULLSCREEN (showPluginView() takes no arguments), which is more disruptive
 * than the wait it would be covering -- that's why the "Syncing…" popup was
 * tried and reverted. The way out is a native floating bubble
 * (WindowManager + TYPE_APPLICATION_OVERLAY) that survives closePluginView().
 *
 * This module doesn't draw a bubble yet. It reports whether the native side is
 * reachable at all and whether the overlay permission is grantable -- see the
 * comment in Ink2TaskOverlayModule.kt for why neither can be answered off-device.
 *
 * EVERY export here is safe to call when the native module is missing: if
 * PluginHost didn't load our ReactPackage, NativeModules.Ink2TaskOverlay is
 * null and these return "unavailable" rather than throwing. Nothing in the sync
 * path may ever break because a diagnostic wasn't there.
 */
import {NativeModules} from 'react-native';

const Native = (NativeModules as any)?.Ink2TaskOverlay ?? null;

export type OverlayDiagnostics = {
  /** False when PluginHost never instantiated our ReactPackage. */
  moduleLoaded: boolean;
  /**
   * The package the overlay permission actually belongs to. Expected to be
   * `com.ratta.supernote.pluginhost` -- our code runs in the host's process,
   * not its own app -- which is the crux of whether this feature can work.
   */
  packageName?: string;
  sdkInt?: number;
  deviceModel?: string;
  /** Whether the overlay permission is currently granted. */
  canDrawOverlays?: boolean;
  /** Whether the system even offers a screen to grant it on. */
  canRequestPermission?: boolean;
  /** Set when the native call itself failed. */
  error?: string;
};

/** True when the native module was registered and is callable. */
export function overlayModuleAvailable(): boolean {
  return !!Native;
}

/**
 * ── Troubleshooting helpers (no UI calls these) ───────────────────────────
 * These drove the Phase 1 probe panel in Settings, which was removed once the
 * overlay was confirmed working on-device (v1.0.6). They're kept because this
 * device has NO usable logcat (`adb shell`/`logcat` return "not support
 * command"), so if the bubble ever stops appearing -- permission revoked, a
 * firmware update, PluginHost no longer loading our ReactPackage -- an on-screen
 * readout is the only practical way to tell those apart. Re-expose by wiring
 * overlayDiagnostics() to a button; see git history for the panel that did it.
 */

/** One round-trip: module loaded? whose package? permission held? */
export async function overlayDiagnostics(): Promise<OverlayDiagnostics> {
  if (!Native) return {moduleLoaded: false};
  try {
    const d = await Native.diagnostics();
    return {moduleLoaded: true, ...(d || {})};
  } catch (e: any) {
    return {moduleLoaded: true, error: e?.message || 'diagnostics failed'};
  }
}

/** Opens the system "Display over other apps" screen. No-op if unavailable. */
export async function requestOverlayPermission(): Promise<boolean> {
  if (!Native) return false;
  try {
    await Native.requestPermission();
    return true;
  } catch {
    return false;
  }
}

/**
 * Shows (or updates) the floating progress bubble.
 *
 * Returns false when there's no bubble -- module missing, or the host doesn't
 * hold the overlay permission. Callers should IGNORE the result: a sync must
 * behave identically whether or not the indicator appeared. Never throws.
 */
export async function overlayShow(text: string): Promise<boolean> {
  if (!Native?.show) return false;
  try {
    return !!(await Native.show(text));
  } catch {
    return false;
  }
}

/** Updates the bubble's text in place. No-op when nothing is showing. */
export async function overlayUpdate(text: string): Promise<boolean> {
  if (!Native?.updateText) return false;
  try {
    return !!(await Native.updateText(text));
  } catch {
    return false;
  }
}

/**
 * Removes the bubble. MUST be called from a finally block -- if a sync throws
 * partway, an orphaned bubble stays painted on screen with nothing left to
 * clear it.
 */
export async function overlayHide(): Promise<void> {
  if (!Native?.hide) return;
  try {
    await Native.hide();
  } catch {
    // best-effort; invalidate() on the native side is the backstop
  }
}
