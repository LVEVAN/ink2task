/**
 * "Add to Ink2Task" from a lasso selection made on ANY note.
 *
 * Registered as a type-2 (lasso toolbar) button (see index.js), so it appears
 * in the native lasso toolbar after the user selects content on whatever note
 * they're currently on -- not just the Ink2Task checklist page.
 *
 * NEVER DESTRUCTIVE to the source note: the lassoed handwriting is copied, not
 * moved -- nothing there is deleted or rewritten. The one thing written back is
 * an additive "→ Ink2Task" link (insertBackLink), inserted with insertElements
 * so it can only ADD to that page, never replace it. The checklist's own
 * page-wiping redraw (replaceElements) is never pointed at a note the plugin
 * doesn't manage -- see the on-page SYNC button's safety gate in actions.ts.
 */
import {PluginCommAPI, PluginFileAPI, PluginNoteAPI, Element} from 'sn-plugin-lib';
import {unwrap} from './sdk';
import {emrToScreen} from './checklistPage';
import {loadConfig, effectiveConfigForPage, saveTaskSource} from './config';
import {resolveLassoTarget} from './target';
import {toAbsolute} from './notePicker';
import {parseDueDate} from './dateParse';
import {createReminder} from '../api/macServer';

type PageSize = {width: number; height: number};
type Rect = {left: number; top: number; right: number; bottom: number};

/**
 * Reads the current lasso selection, OCRs it (or uses native typed text
 * directly, no OCR needed), and creates a reminder from the result. Returns
 * the created task's title, or null if there was nothing to add (empty
 * selection, or nothing recognizable in it).
 */
export async function addLassoedTaskToInk2Task(): Promise<string | null> {
  const lassoRes = await unwrap<any[]>(PluginCommAPI.getLassoElements(), 'getLassoElements');
  const elements = lassoRes || [];
  if (elements.length === 0) {
    // Most likely the selection was already cleared by the time we ran (the
    // host may drop it when the plugin view opens). Say so specifically --
    // "nothing recognizable" would wrongly blame the handwriting.
    throw new Error('No lasso selection found. Re-select and tap "Add to Ink2Task" again.');
  }

  // Where this came from, so the checklist can draw a link back to it.
  const srcPath = await unwrap<string>(PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath');
  const srcPage = await unwrap<number>(PluginCommAPI.getCurrentPageNum(), 'getCurrentPageNum');
  // Read the selection's rectangle NOW, while the lasso still exists -- it's
  // where the back-link gets placed on the source note.
  let lassoRect: Rect | null = null;
  try {
    lassoRect = (await unwrap<Rect>(PluginCommAPI.getLassoRect(), 'getLassoRect')) || null;
  } catch {
    // no rect -> back-link placement falls back to a default spot
  }

  // Native typed text ([T] tool): exact, no OCR needed. Otherwise OCR the
  // handwritten strokes in the selection.
  const textEls = elements.filter((el: any) => el.type === Element.TYPE_TEXT);
  let text = '';
  if (textEls.length > 0) {
    text = textEls
      .map((el: any) => (el.textBox?.textContentFull ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  } else {
    const strokes = elements.filter((el: any) => el.type === Element.TYPE_STROKE);
    if (strokes.length === 0) {
      throw new Error(
        `Selection had ${elements.length} item(s) but no handwriting or text to read.`,
      );
    }
    const size = await unwrap<PageSize>(PluginFileAPI.getPageSize(srcPath, srcPage), 'getPageSize');
    text = (
      (await unwrap<string>(
        PluginCommAPI.recognizeElements(strokes, size),
        'recognizeElements',
      )) || ''
    ).trim();
  }
  if (!text) return null;

  // A date written as part of the task ("Call dentist 8/9") should become the
  // task's DUE date, not part of its title.
  const {title: taskText, due} = splitTrailingDue(text);

  const config = await loadConfig();
  // Create into the PROFILE+LIST the CHECKLIST PAGE is bound to, not just the
  // active profile's default -- pages can each sync a different backend/list
  // (pageBindings), and fetch reads the page's bound one. Using config as-is
  // here could send the task to the wrong backend entirely (e.g. Todoist)
  // for a page that's actually bound to Reminders, or file it into a list
  // the user's checklist page never displays -- either way a successful
  // capture would look like it silently did nothing.
  const {notePath, page} = await resolveLassoTarget(config);
  const eff = effectiveConfigForPage(config, notePath, page);
  const {id, title} = await createReminder(eff, taskText, due);
  // Remember where it came from so writeChecklist can draw a tappable link
  // back to that note page. Best-effort -- the task is already created.
  if (id) await saveTaskSource(id, {notePath: srcPath, page: srcPage});
  // Drop a link on the SOURCE note pointing at the checklist, so the two are
  // navigable in both directions.
  await insertBackLink(srcPath, srcPage, notePath, page, lassoRect, id);
  return title;
}

/**
 * Tag stored in a back-link's fullText so each link can be matched to the task
 * it belongs to. The visible label lives in showText; fullText is free for us
 * to use. Without this, a note with two lassoed tasks has two links that look
 * identical (same destPath), and completing either one removed BOTH.
 */
function backLinkTag(reminderId: string): string {
  return `Ink2Task:${reminderId}`;
}

/**
 * Removes ONE task's "→ Ink2Task" back-link from a source note -- called when
 * that task is completed or deleted, so it doesn't leave a dead link behind.
 *
 * Matches on the fullText tag, not just destPath: a note can hold links for
 * several lassoed tasks, all pointing at the same checklist, and matching by
 * destPath alone wiped every one of them when a single task was completed.
 *
 * Links without our tag are left alone. That covers both links the user made
 * themselves and back-links from builds before the tag existed -- an untagged
 * one can't be attributed to a task, and leaving a stale link is far better
 * than deleting the wrong thing. Best-effort throughout: the completion already
 * succeeded, so a leftover link must never fail the sync.
 */
export async function removeBackLink(
  srcPath: string,
  srcPage: number,
  destPath: string,
  reminderId: string,
): Promise<void> {
  if (!srcPath || srcPath === destPath || !reminderId) return;
  try {
    const all = await unwrap<any[]>(
      PluginFileAPI.getElements(srcPage, srcPath),
      'getElements',
    );
    const tag = backLinkTag(reminderId);
    const nums = (all || [])
      .filter(
        (el: any) =>
          el.type === Element.TYPE_LINK &&
          toAbsolute(el.link?.destPath || '') === toAbsolute(destPath) &&
          (el.link?.fullText || '') === tag,
      )
      .map((el: any) => el.numInPage)
      .filter((n: any) => typeof n === 'number');
    if (nums.length === 0) return;

    // Same open-note ordering as the insert: flush the editor's buffer first so
    // nothing unsaved is lost, delete from the file, then repaint from the file.
    try {
      await unwrap(PluginNoteAPI.saveCurrentNote(), 'saveCurrentNote');
    } catch {
      // best-effort flush
    }
    await unwrap(PluginFileAPI.deleteElements(srcPath, srcPage, nums), 'deleteElements');
    try {
      await unwrap(PluginCommAPI.reloadFile(), 'reloadFile');
    } catch {
      // cosmetic
    }
  } catch (e: any) {
    console.log('[Ink2Task] back-link removal failed:', e?.message);
  }
}

/**
 * Pulls a date off the END of a captured phrase, so "Call dentist 8/9" becomes
 * title "Call dentist" + due 2026-08-09. Tries the last 1-3 words (dates like
 * "next tuesday" or "Aug 8 2026" span several), longest first, and only accepts
 * a split that leaves a non-empty title -- a bare date stays the title rather
 * than creating an untitled task.
 */
function splitTrailingDue(text: string): {title: string; due: string | null} {
  const words = text.split(/\s+/).filter(Boolean);
  for (let take = Math.min(3, words.length - 1); take >= 1; take--) {
    const candidate = words.slice(words.length - take).join(' ');
    const iso = parseDueDate(candidate);
    if (iso) {
      return {title: words.slice(0, words.length - take).join(' '), due: iso};
    }
  }
  return {title: text, due: null};
}

/**
 * Drops a small "→ Ink2Task" link on the SOURCE note, just under the lassoed
 * selection, so you can jump from the original handwriting to the checklist.
 *
 * This is the ONE place Ink2Task writes to a note it doesn't manage, and it is
 * deliberately additive: a single insertElements, never replaceElements, so it
 * cannot wipe anything on that page (unlike the checklist redraw). Skipped when
 * the source IS the checklist note -- linking a page to itself is pointless,
 * and it keeps this well clear of the checklist's own capture/erase cycle.
 * Entirely best-effort: the task is already created, so a failure here is
 * logged and swallowed rather than surfaced as a capture error.
 */
async function insertBackLink(
  srcPath: string,
  srcPage: number,
  destPath: string,
  destPage: number,
  lassoRect: Rect | null,
  reminderId: string,
): Promise<void> {
  if (!srcPath || srcPath === destPath || !reminderId) return;
  try {
    const size = await unwrap<PageSize>(
      PluginFileAPI.getPageSize(srcPath, srcPage),
      'getPageSize',
    );
    // Small and unobtrusive -- this sits on the user's own note, so it should
    // read as a discreet marker, not compete with their handwriting.
    const fontSize = Math.max(14, Math.round(size.height * 0.011));
    const w = Math.round(size.width * 0.16);
    const h = Math.round(fontSize * 1.5);

    // getLassoRect's coordinate space isn't documented. Stroke geometry comes
    // back in EMR digitizer space (~8.5x page pixels, axes swapped), and if the
    // rect is EMR too then using it raw puts the link far below the selection --
    // clamped to the page bottom, which is exactly what "too far under" looked
    // like. Detect it: values past the page bounds can only be EMR, so convert.
    let anchor = lassoRect;
    if (anchor && (anchor.bottom > size.height || anchor.right > size.width)) {
      const tl = emrToScreen({x: anchor.left, y: anchor.top}, size);
      const br = emrToScreen({x: anchor.right, y: anchor.bottom}, size);
      anchor = {
        left: Math.min(tl.x, br.x),
        top: Math.min(tl.y, br.y),
        right: Math.max(tl.x, br.x),
        bottom: Math.max(tl.y, br.y),
      };
    }

    // Tucked right against the selection's bottom-left, no gap: a lasso is
    // usually drawn loosely around the writing, so its rect already sits well
    // below the ink -- any extra padding reads as "floating too far down".
    // Without a usable rect, fall back to the bottom-left margin.
    const left = Math.max(0, Math.min(anchor ? Math.round(anchor.left) : 0, size.width - w));
    const top = Math.max(
      0,
      Math.min(anchor ? Math.round(anchor.bottom) - h : size.height - h - 4, size.height - h),
    );

    const el = await unwrap<any>(PluginCommAPI.createElement(Element.TYPE_LINK), 'createElement');
    el.pageNum = srcPage;
    el.layerNum = 0; // links are main-layer only (code 203 otherwise)
    el.link = {
      category: 0,
      X: left,
      Y: top,
      width: w,
      height: h,
      page: srcPage,
      style: 0, // solid underline
      linkType: 0, // jump to note page
      destPath,
      destPage,
      fontSize,
      // showText is what's drawn; fullText carries the task tag so this link
      // can later be removed on its own, without touching other tasks' links
      // on the same note.
      fullText: backLinkTag(reminderId),
      showText: '→ Ink2Task',
      italic: 0,
      controlTrailNums: [],
    };
    // Order matters, and this is why the lassoed handwriting appeared to vanish
    // (0.2.73): insertElements writes to the note FILE, while the open editor is
    // showing an in-memory buffer. Without flushing first, the buffer and file
    // diverge and the view repaints from a stale mix -- the handwriting looked
    // deleted (it wasn't; it came back on reopen).
    //   1. saveCurrentNote  -- commit whatever is on screen, so nothing unsaved
    //                          is lost and the file is current before we add to it.
    //   2. insertElements   -- add the link to the file.
    //   3. reloadFile       -- repaint from the file, so the page shows the
    //                          handwriting AND the new link.
    try {
      await unwrap(PluginNoteAPI.saveCurrentNote(), 'saveCurrentNote');
    } catch {
      // best-effort flush
    }
    await unwrap(PluginFileAPI.insertElements(srcPath, srcPage, [el]), 'insertElements');
    try {
      await unwrap(PluginCommAPI.reloadFile(), 'reloadFile');
    } catch {
      // cosmetic: the link is already in the file either way
    }
  } catch (e: any) {
    console.log('[Ink2Task] back-link insert failed:', e?.message);
  }
}
