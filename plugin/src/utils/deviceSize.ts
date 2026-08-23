/**
 * Which panel this device has, from more than one signal.
 *
 * NO IMPORTS on purpose so it stays unit testable (see ./taskText for why).
 *
 * `PluginManager.getDeviceType()` is the documented way to tell a Manta (5)
 * from a Nomad (4) or A5X (3), but it cannot be the ONLY signal: a real Manta
 * seen 2026-08-22 reports `ro.product.model = "Supernote Nomad"` and
 * `ro.build.product = rk3566_ht_eink`, with a 1920x2560 panel. Ratta clearly
 * reuses those strings across models, so if the device-type enum is derived
 * from them it can be wrong too, and the cost of getting it wrong is the
 * 1404x1872 template baked into a 1920x2560 note.
 *
 * The panel SIZE cannot lie, so it wins whenever it is known.
 */

/** Manta's panel. A5X and Nomad are both 1404x1872. */
export const MANTA_WIDTH = 1920;
export const MANTA_HEIGHT = 2560;

/**
 * True when this is Manta-class hardware.
 *
 * `deviceType` is the enum, when it could be read at all. `screen` is the
 * reported screen or page size, in either orientation. Either signal alone is
 * enough: a type of 5 is definitive, and so is a panel at least as large as
 * Manta's.
 */
export function isMantaClass(opts: {
  deviceType?: number;
  /** React Native's Dimensions, which are in DP -- see pixelRatio. */
  screen?: {width?: number; height?: number};
  /**
   * PixelRatio.get(). REQUIRED for the screen check to mean anything: RN
   * reports Dimensions in density-independent points, not pixels. A real Manta
   * reads 1024 x 1365.33 dp at ratio 1.875, so comparing those numbers against
   * 1920x2560 always said "not Manta" and the fallback was dead code
   * (device-observed 2026-08-23).
   */
  pixelRatio?: number;
}): boolean {
  if (opts.deviceType === 5) return true;
  const ratio = opts.pixelRatio && opts.pixelRatio > 0 ? opts.pixelRatio : 1;
  const w = (opts.screen?.width ?? 0) * ratio;
  const h = (opts.screen?.height ?? 0) * ratio;
  if (!w || !h) return false;
  // Orientation-agnostic, and rounded: dp * ratio lands a pixel or two short.
  const long = Math.round(Math.max(w, h));
  const short = Math.round(Math.min(w, h));
  return long >= MANTA_HEIGHT - 2 && short >= MANTA_WIDTH - 2;
}
