import RNFS from 'react-native-fs';
import {PluginFileAPI} from 'sn-plugin-lib';
import {toAbsolute} from './notePicker';
import {TEMPLATE_PNG_BASE64} from './templateAsset';

/**
 * createNote requires a non-empty template path -- omitting it makes the call
 * resolve with success:false instead of throwing, so the note silently never
 * gets created and the failure only shows up further down the page APIs.
 *
 * The Ink2Task template is the ruled "Ink2Task List" page (title, DUE
 * column, divider, rows, and the on-page SYNC button) that the checklist
 * layout is aligned to. The plugin ships it embedded and writes it to MyStyle
 * on first run (see ensureTemplate), so installing just the .snplg is enough.
 */
// Kept inside the plugin's own MyStyle/Ink2Task/ folder (alongside its
// config) rather than loose in MyStyle root.
const TEMPLATE = '/MyStyle/Ink2Task/Ink2Task_Template.png';
const TEMPLATE_VERSION_FILE = '/MyStyle/Ink2Task/Ink2Task_Template.version';
const OLD_TEMPLATE = '/MyStyle/Ink2Task_Template.png';

// Bump whenever the embedded template PNG design changes, so devices that
// already have an older copy get the new one rewritten on the next run.
//   v2 - narrower DUE column, "DUE" header, SYNC button pill, bolder logo
//   v3 - logo tweak: thicker clipboard outline, thinner checkmark
//   v4 - SYNC button nudged right off the left edge
//   v5 - Ink2Task rebrand: ink-drop logo replaces the checkmark square
//   v6 - SYNC label nudged left, closer to the drop
//   v7 - smaller SYNC pill, drop + label centered inside it
//   v8 - SYNC button left-aligned with the checkbox column
//   v9 - SYNC button pushed to the left page edge
//   v10 - SYNC button left edge aligned with the ruled-line margin
const TEMPLATE_VERSION = '10';

/**
 * Makes sure the template PNG exists on the device and matches the version this
 * build ships. Writes the bundled copy when it's missing or out of date, so an
 * install that only has the .snplg always ends up with the current design (and
 * so redesigns don't require manually deleting the old PNG).
 */
async function ensureTemplate(): Promise<void> {
  const path = toAbsolute(TEMPLATE);
  const versionPath = toAbsolute(TEMPLATE_VERSION_FILE);
  let current = '';
  try {
    if (await RNFS.exists(versionPath)) current = (await RNFS.readFile(versionPath, 'utf8')).trim();
  } catch {
    // treat unreadable version as "needs rewrite"
  }
  if (!(await RNFS.exists(path)) || current !== TEMPLATE_VERSION) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (!(await RNFS.exists(dir))) await RNFS.mkdir(dir);
    await RNFS.writeFile(path, TEMPLATE_PNG_BASE64, 'base64');
    try {
      await RNFS.writeFile(versionPath, TEMPLATE_VERSION, 'utf8');
    } catch {
      // non-critical: without the marker it just rewrites again next run
    }
  }
  // Tidy up the old loose copy from earlier builds, if present.
  try {
    const old = toAbsolute(OLD_TEMPLATE);
    if (await RNFS.exists(old)) await RNFS.unlink(old);
  } catch {
    // non-critical
  }
}

/** Creates the checklist note (and its folder) the first time it's needed. */
/**
 * Ensures the checklist note exists (creating it from the template if not).
 * Returns true only when it CREATED the note this call -- i.e. the very first
 * run -- so the caller can land the user on the brand-new note once, without
 * yanking them there on every later sync.
 */
export async function ensureNote(notePath: string): Promise<boolean> {
  // Run first, every time: this also migrates the template into the
  // MyStyle/Ink2Task/ folder and clears the old loose copy, even when the
  // note itself already exists (below) and nothing else needs doing.
  await ensureTemplate();

  const absolutePath = toAbsolute(notePath);
  if (await RNFS.exists(absolutePath)) return false;

  const res: any = await PluginFileAPI.createNote({
    notePath: absolutePath,
    template: toAbsolute(TEMPLATE),
    mode: 0,
    isPortrait: true,
  });
  if (res && typeof res === 'object' && 'success' in res && !res.success) {
    const {message = 'unknown error', code = '?'} = res.error ?? {};
    // 102 = the host won't allow createNote from this context. It happens when
    // the plugin was opened from Settings > Apps > Plugins rather than from
    // inside a note -- creating notes is only permitted in the note editor.
    if (code === 102) {
      throw new Error(
        'Open a note first, then tap the Ink2Task icon to Fetch. ' +
          '(Creating the checklist note is not allowed from the Settings screen.)',
      );
    }
    throw new Error(`Could not create ${notePath} (${code}): ${message}`);
  }
  return true;
}
