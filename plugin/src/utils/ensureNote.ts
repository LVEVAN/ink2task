import RNFS from 'react-native-fs';
import {requireFileWrite} from './permissions';
import {Dimensions, PixelRatio} from 'react-native';
import {isMantaClass} from './deviceSize';
import {PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {toAbsolute} from './notePicker';
import {TEMPLATE_PNG_BASE64} from './templateAsset';
import {TEMPLATE_MANTA_PNG_BASE64} from './templateAssetManta';

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
// Which template version the CURRENT note (at config.notePath) was actually
// CREATED from -- NOT the same thing as TEMPLATE_VERSION above, which only
// tracks the template PNG FILE on disk. Rewriting that file (ensureTemplate,
// below) does nothing to a note that already exists -- createNote bakes the
// template into the note's background ONCE, and there is no API to change a
// note's background after the fact (device-confirmed, see
// [[ink2task-sdk-gotchas]]). So an existing note keeps whatever background it
// was created with regardless of how many times the shipped template changes.
// This file is the only reliable record of what THIS note actually has baked
// in; see checklistPage.ts's use of it (via getNoteTemplateVersion) to decide
// whether it's safe to skip drawing checkboxes as elements.
const NOTE_TEMPLATE_VERSION_FILE = '/MyStyle/Ink2Task/Ink2Task_Note.version';

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
//   v11 - checkboxes baked into the background (see CHECKBOX_BAKE_VERSION)
//   v12 - baked-in checkboxes thinned to stroke-width 2, matching the DUE
//         box/ruled-line/divider weight (were stroke-width 4, too thick)
//   v13 - "DUE" header baseline aligned with SYNC's (was 3px high)
//   v14 - SYNC button and platform:list title swapped: SYNC now centered
//         in the top row, title moved to SYNC's old left spot
const TEMPLATE_VERSION = '16';

/**
 * The template version at which checkboxes were added to the baked-in
 * background. checklistPage.ts skips drawing them as elements (a real sync-
 * time saving -- see the change log) ONLY on a note whose OWN recorded
 * creation version (getNoteTemplateVersion) is at least this, so an existing
 * note created before this change keeps drawing them as elements -- exactly
 * as it does today -- until it's recreated against the new template.
 */
export const CHECKBOX_BAKE_VERSION = 11;

/**
 * Makes sure the template PNG exists on the device and matches the version this
 * build ships. Writes the bundled copy when it's missing or out of date, so an
 * install that only has the .snplg always ends up with the current design (and
 * so redesigns don't require manually deleting the old PNG).
 */
async function templateBase64ForDevice(): Promise<string> {
  const manta = await detectMantaClass();
  return manta ? TEMPLATE_MANTA_PNG_BASE64 : TEMPLATE_PNG_BASE64;
}

/**
 * Manta-class check that does not trust the device-type enum alone -- see
 * isMantaClass. Logs both signals, because baking the wrong template into a
 * note is invisible until you look closely at a blurry background, and there is
 * no API to change a note's background afterwards.
 */
async function detectMantaClass(): Promise<boolean> {
  let deviceType: number | undefined;
  try {
    deviceType = await PluginManager.getDeviceType();
  } catch {
    // enum unavailable; the screen size below is then the only signal
  }
  const screen = Dimensions.get('screen');
  const manta = isMantaClass({deviceType, screen, pixelRatio: PixelRatio.get()});
  console.log(
    `[Ink2Task] device: type=${deviceType ?? '?'} screen=${screen.width}x${screen.height}dp ` +
      `ratio=${PixelRatio.get()} ` +
      `-> ${manta ? 'MANTA' : 'standard'} template`,
  );
  return manta;
}

async function ensureTemplate(): Promise<void> {
  // Writes the template PNG into MyStyle, so this one genuinely needs the write
  // permission -- see utils/permissions.ts. Cheap after the first call.
  await requireFileWrite();
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
    const base64 = await templateBase64ForDevice();
    await RNFS.writeFile(path, base64, 'base64');
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
  // Record which template version this note's background was actually baked
  // from -- see NOTE_TEMPLATE_VERSION_FILE's comment above. Best-effort, same
  // reasoning as ensureTemplate's own version-marker write: without it, the
  // next check just falls back to "assume old template" (still correct, just
  // draws checkboxes as elements unnecessarily on this one note).
  try {
    await RNFS.writeFile(toAbsolute(NOTE_TEMPLATE_VERSION_FILE), TEMPLATE_VERSION, 'utf8');
  } catch {
    // non-critical, see above
  }
  return true;
}

/**
 * Whether the CURRENT note (the one at config.notePath) was created from a
 * template version that already has checkboxes baked into its background --
 * i.e. whether it's safe to skip drawing them as elements. Reads the marker
 * ensureNote() writes at creation time; missing/unreadable defaults to false
 * (draw them, the always-correct fallback) rather than assuming a newer
 * version than we can actually confirm.
 */
export async function noteHasBakedInCheckboxes(): Promise<boolean> {
  try {
    const raw = (await RNFS.readFile(toAbsolute(NOTE_TEMPLATE_VERSION_FILE), 'utf8')).trim();
    const version = parseInt(raw, 10);
    return Number.isFinite(version) && version >= CHECKBOX_BAKE_VERSION;
  } catch {
    return false;
  }
}

/**
 * How many pages the note currently has, or 0 if it cannot be determined.
 * Never throws: a failed read must not take a sync down with it.
 */
export async function notePageCount(notePath: string): Promise<number> {
  try {
    const res: any = await PluginFileAPI.getNoteTotalPageNum(toAbsolute(notePath));
    const n = typeof res === 'number' ? res : res?.result;
    if (typeof n === 'number' && n > 0) return n;
    // 0 means "unknown", and the whole page-growth decision hinges on it: with
    // 0 the plugin believes it cannot extend the list and reports "the list
    // could not use page 2" without saying why. Silent before, which is how
    // that message reached a user with nothing to act on (2026-08-25).
    console.log(
      `[Ink2Task] getNoteTotalPageNum gave no usable count: ${JSON.stringify(res)?.slice(0, 200)}`,
    );
    return 0;
  } catch (e: any) {
    console.log('[Ink2Task] getNoteTotalPageNum threw:', e?.message || e);
    return 0;
  }
}

/**
 * Appends one page to the checklist note, built from the SAME template as page 0.
 *
 * Using the template (rather than an inserted blank page) is what lets a
 * continuation page look identical to the first: the ruled rows, DUE column,
 * divider, and SYNC button are baked into its background, so the checklist can
 * be drawn on it with `drawChrome: false` exactly like page 0. A blank inserted
 * page would need all of that redrawn as elements on every sync.
 *
 * Returns true only when the page really was added, verified by re-reading the
 * page count rather than trusting the response shape: createNote is documented
 * to resolve with `success: false` instead of throwing, and insertNotePage sits
 * behind the same wrapper, so a silent failure is the likely mode.
 *
 * Caller must record the new templated page (see withTemplatedPages in
 * ./config), otherwise the next sync will think the page is un-templated and
 * draw a second SYNC button on top of the baked one.
 */
/**
 * Inserts one of our template pages AT a given index, not at the end.
 *
 * Why this exists: a list can only grow into the page directly after it, so a
 * Todoist list on page 0 with an Apple Reminders list on page 1 had nowhere to
 * go -- appending landed at the end of the note, past the Apple page, which can
 * never extend the run. insertNotePage has always taken a position; we simply
 * never used it.
 *
 * The caller MUST call shiftRecordsForInsertedPage straight afterwards when
 * this returns true. Inserting renumbers every later page, and six stores key
 * their data by absolute page index.
 */
export async function insertTemplatedPageAt(
  notePath: string,
  page: number,
): Promise<boolean> {
  const absolutePath = toAbsolute(notePath);
  await ensureTemplate();
  const before = await notePageCount(absolutePath);
  if (before <= 0) return false;
  // Inserting past the end is an append, which has its own function and does
  // not need any renumbering. Refuse rather than quietly doing something else.
  if (page < 0 || page > before) return false;
  try {
    const res: any = await PluginFileAPI.insertNotePage({
      notePath: absolutePath,
      page,
      template: toAbsolute(TEMPLATE),
    });
    if (res && typeof res === 'object' && 'success' in res && !res.success) {
      const {message = 'unknown error', code = '?'} = res.error ?? {};
      console.log(`[Ink2Task] insertNotePage(at ${page}) failed (${code}): ${message}`);
      return false;
    }
  } catch (e: any) {
    console.log('[Ink2Task] insertNotePage threw:', e?.message);
    return false;
  }
  const after = await notePageCount(absolutePath);
  // Verified rather than assumed: the records only get renumbered if a page
  // really did appear, and renumbering when nothing moved is its own corruption.
  const grew = after === before + 1;
  if (!grew) {
    console.log(`[Ink2Task] insertNotePage(at ${page}): count went ${before} -> ${after}, not +1`);
  }
  return grew;
}

export async function appendTemplatedPage(notePath: string): Promise<boolean> {
  const absolutePath = toAbsolute(notePath);
  await ensureTemplate();
  const before = await notePageCount(absolutePath);
  try {
    // `page` is where the new page goes. Appending means the current count,
    // i.e. one past the last 0-indexed page.
    const res: any = await PluginFileAPI.insertNotePage({
      notePath: absolutePath,
      page: before,
      template: toAbsolute(TEMPLATE),
    });
    if (res && typeof res === 'object' && 'success' in res && !res.success) {
      const {message = 'unknown error', code = '?'} = res.error ?? {};
      console.log(`[Ink2Task] insertNotePage failed (${code}): ${message}`);
      return false;
    }
  } catch (e: any) {
    console.log('[Ink2Task] insertNotePage threw:', e?.message);
    return false;
  }
  const after = await notePageCount(absolutePath);
  // If the count could not be read at all (0), fall back to trusting the call.
  return after === 0 ? true : after > before;
}

/**
 * Removes one page from the note. Returns true only if the page count actually
 * dropped, so a silent `success: false` cannot be mistaken for a deletion.
 *
 * DESTRUCTIVE. Callers must have already established that the page is one we
 * created, is past what the list needs, carries no ink, and is not bound to
 * another list -- see pagesToReclaim in ./pagination, which is where those
 * conditions live and are tested. This function deliberately checks none of
 * them: it is the mechanism, not the policy.
 */
export async function removeNotePageAt(notePath: string, page: number): Promise<boolean> {
  const absolutePath = toAbsolute(notePath);
  const before = await notePageCount(absolutePath);
  // Refuse to empty the note entirely, whatever the caller thinks.
  if (before <= 1) return false;
  try {
    const res: any = await PluginFileAPI.removeNotePage(absolutePath, page);
    if (res && typeof res === 'object' && 'success' in res && !res.success) {
      const {message = 'unknown error', code = '?'} = res.error ?? {};
      console.log(`[Ink2Task] removeNotePage(${page}) failed (${code}): ${message}`);
      return false;
    }
  } catch (e: any) {
    console.log('[Ink2Task] removeNotePage threw:', e?.message);
    return false;
  }
  const after = await notePageCount(absolutePath);
  // Unknown count (0) means the check itself failed; report failure rather than
  // claiming a deletion we cannot see, since the caller decrements state on true.
  return after > 0 && after < before;
}
