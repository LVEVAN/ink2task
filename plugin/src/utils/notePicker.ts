/**
 * Path helpers for the one Ink2Task note. There's no note picker anymore --
 * Ink2Task always uses config.notePath -- these just normalize/display it.
 */
const NOTE_ROOT = '/storage/emulated/0';

/**
 * The SDK's page APIs want fully-qualified paths -- "/Note/x.note" fails with
 * "File does not exist. Cannot call the API." (1201), while
 * "/storage/emulated/0/Note/x.note" works, which is also the form
 * getCurrentFilePath hands back. Everything is normalised through here before
 * it reaches the SDK, so configs saved in the old short form keep working.
 */
export function toAbsolute(notePath: string): string {
  if (notePath.startsWith(NOTE_ROOT)) return notePath;
  return notePath.startsWith('/') ? `${NOTE_ROOT}${notePath}` : `${NOTE_ROOT}/${notePath}`;
}

/** Just the filename, for showing the current selection compactly. */
export function displayName(notePath: string): string {
  const name = notePath.split('/').pop() || notePath;
  return name.replace(/\.note$/i, '');
}
