/**
 * Works out which page of the ONE Ink2Task note the checklist should be
 * written to.
 *
 * There's exactly one note (config.notePath) -- no picker, no "sync whatever
 * note is open" mode. But it's still multi-PAGE: if you're currently viewing
 * that note (e.g. on a page you added yourself with the device's own note
 * tools, to hold a second list), the checklist lands on the page you're on,
 * not always page 0 -- the registry is keyed by note+page, so several pages
 * of the same note can each hold their own checklist. If you're not currently
 * on that note (e.g. you opened the plugin from Settings), it defaults to
 * page 0.
 */
import {PluginCommAPI, PluginFileAPI, PluginManager, PluginNoteAPI, FileUtils} from 'sn-plugin-lib';
import {unwrap} from './sdk';
import {toAbsolute} from './notePicker';
import type {Ink2TaskConfig} from './config';

export type Target = {notePath: string; page: number; isTemplatePage: boolean};

/**
 * Page 0 is the first page: PluginFileAPI's page-taking calls are documented
 * 0-indexed. Also the ONLY page created with the template background baked in
 * (via ensureNote); any other page number was added afterward with the
 * device's own note tools and needs its chrome (SYNC/DUE/divider/lines) drawn
 * -- see drawChrome in actions.ts/Home.tsx.
 */
export const FIRST_PAGE = 0;

export async function resolveTarget(config: Ink2TaskConfig): Promise<Target> {
  const notePath = toAbsolute(config.notePath);
  let rawPath = '';
  try {
    rawPath = (await unwrap<string>(PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath')) || '';
  } catch {
    // not on any note (e.g. opened from Settings) -- fall through to page 0
  }
  if (toAbsolute(rawPath) !== notePath) {
    return {notePath, page: FIRST_PAGE, isTemplatePage: true};
  }
  const page = await unwrap<number>(PluginCommAPI.getCurrentPageNum(), 'getCurrentPageNum');
  const resolvedPage = typeof page === 'number' ? page : FIRST_PAGE;

  let isTemplatePage = resolvedPage === FIRST_PAGE;
  if (!isTemplatePage) {
    // Unlike PluginFileAPI's page params, getCurrentPageNum's own indexing
    // convention (0- vs 1-based) is undocumented -- if it's actually
    // 1-indexed, resolvedPage would be 1 on a brand-new single-page note and
    // the check above wrongly concludes "not the template page", drawing the
    // chrome a second time on top of what's already baked into the
    // background (reported on-device: duplicate SYNC button + DUE header).
    // A note with exactly one page is unambiguously the templated one no
    // matter which convention getCurrentPageNum uses, so fall back to that
    // when the FIRST_PAGE guess says no.
    try {
      const total = await unwrap<number>(PluginFileAPI.getNoteTotalPageNum(notePath), 'getNoteTotalPageNum');
      if (total === 1) isTemplatePage = true;
    } catch {
      // best effort; keep the index-based guess
    }
  }
  return {notePath, page: resolvedPage, isTemplatePage};
}

/**
 * Works out which page a LASSO capture (made on ANY note, not the Ink2Task
 * note) should land on. If you're lassoing while actually sitting ON the
 * Ink2Task note itself, that's unambiguous -- use the page you're on, same as
 * resolveTarget. Otherwise (the normal case: lassoing text on some OTHER
 * note), fall back to the pinned lassoTargetOverride if set, else whichever
 * page was last synced, else page 0 -- so captures follow whichever list is
 * actively in use rather than always landing on page 0 regardless.
 */
export async function resolveLassoTarget(config: Ink2TaskConfig): Promise<{notePath: string; page: number}> {
  const notePath = toAbsolute(config.notePath);
  let rawPath = '';
  try {
    rawPath = (await unwrap<string>(PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath')) || '';
  } catch {
    // not on any note -- fall through to the default target below
  }
  if (toAbsolute(rawPath) === notePath) {
    const page = await unwrap<number>(PluginCommAPI.getCurrentPageNum(), 'getCurrentPageNum');
    return {notePath, page: typeof page === 'number' ? page : FIRST_PAGE};
  }
  const fallback = config.lassoTargetOverride || config.lastSyncedPage;
  return fallback
    ? {notePath: toAbsolute(fallback.notePath), page: fallback.page}
    : {notePath, page: FIRST_PAGE};
}

/**
 * Persists the current note, then asks the host to re-read it.
 *
 * The save is essential, not cosmetic: after a sync wipes the ink layer and
 * redraws the checklist, that new state lives only in memory. Without saving,
 * reloadFile re-reads the OLD on-disk copy -- so the erased handwriting comes
 * back, most visibly after the note is closed and reopened. Saving first makes
 * the cleared page the on-disk truth.
 */
export async function reloadIfOpen(expectedPath?: string): Promise<void> {
  // saveCurrentNote() has NO path parameter -- it always saves whatever note is
  // currently open. So when we've just redrawn a note that ISN'T the open one
  // (the lasso flow redraws the checklist while the user is still on some other
  // note), calling it would save the WRONG note and never flush our changes.
  // Skip entirely in that case: there's no open buffer of ours to persist and
  // nothing of ours on screen to repaint.
  if (expectedPath) {
    let current = '';
    try {
      current = (await unwrap<string>(PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath')) || '';
    } catch {
      current = '';
    }
    if (toAbsolute(current) !== toAbsolute(expectedPath)) return;
  }
  // Both calls are required, and this is why the sync ends with two e-ink paints:
  //  - saveCurrentNote commits the wiped-and-redrawn page to disk so the erased
  //    handwriting doesn't come back on reopen. (It does NOT repaint the open view.)
  //  - reloadFile re-reads the saved file and repaints, which is what actually
  //    shows the new checklist. Dropping it (tried in 0.2.56) left the page stale
  //    until the user touched it, so it's kept.
  // The double refresh appears inherent to this SDK's full e-ink refresh; there's
  // no combined save+display call exposed.
  try {
    await unwrap(PluginNoteAPI.saveCurrentNote(), 'saveCurrentNote');
  } catch {
    // best-effort persist; the reload below still refreshes the view
  }
  try {
    await unwrap(PluginCommAPI.reloadFile(), 'reloadFile');
  } catch {
    // Purely cosmetic: a failed refresh isn't worth a user-visible error.
  }
}

/**
 * Navigates to the checklist note so the user actually sees it -- otherwise,
 * fetching from the plugin while a *different* note is open writes to the
 * Ink2Task note off-screen and looks like nothing happened. Closes the
 * plugin view first, then opens the note file.
 */
export async function openNote(notePath: string): Promise<void> {
  try {
    await PluginManager.closePluginView();
  } catch {
    // ignore -- opening the file is what matters
  }
  try {
    await FileUtils.openFilePath(toAbsolute(notePath));
  } catch {
    // best-effort navigation; the checklist is already written either way
  }
}
