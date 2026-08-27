/**
 * Standalone Fetch / Sync orchestration, callable without the plugin's UI.
 *
 * The on-page SYNC button (a background motion listener in index.js) has no
 * React screen to drive, so the workflow lives here as plain async functions
 * that take a config and return a summary. The Home screen keeps its own copy
 * of this flow wired to status text; this module deliberately duplicates it so
 * the button can't regress the screen and vice-versa.
 */
import type {Ink2TaskConfig} from './utils/config';
import {
  loadRegistry,
  saveRegistryEntries,
  registryKey,
  effectiveConfigForPage,
  bindPage,
  withLastViewedPage,
  saveConfig,
  activeProfileOf,
  isDirectTodoist,
  isTodoistMissingToken,
  setActiveConnection,
  loadTaskSources,
  saveTaskSources,
  loadErasedInk,
  saveErasedInk,
  saveTicktickSyncMeta,
} from './utils/config';
import {
  checkHealth,
  fetchLists,
  fetchReminders,
  completeReminders,
} from './api/macServer';
import {
  writeChecklist,
  refreshTimestampOnly,
  readPageHeading,
  detectCheckedBoxes,
  scanMainLayer,
  takeRedrawWarning,
  dropGhostStrokes,
  inkPrintsOf,
  verifyEraseAndRetry,
  recycleScan,
} from './utils/checklistPage';
import type {MainLayerScan} from './utils/checklistPage';
import {ensureNote, noteHasBakedInCheckboxes, noteLayoutVersion} from './utils/ensureNote';
import {resolveTarget, reloadIfOpen} from './utils/target';
import type {Target} from './utils/target';
import {captureAndCreate} from './utils/capture';
import {rowsForRun} from './utils/rowDensity';
import type {RemoteReminder} from './api/macServer';
import type {ChecklistEntry} from './utils/config';
import {subtaskDepths, orderByHierarchy} from './utils/taskText';
import {planPages, pagesToReclaim, pageBudget, MAX_PAGES} from './utils/pagination';
import {
  notePageCount,
  appendTemplatedPage,
  insertTemplatedPageAt,
  removeNotePageAt,
} from './utils/ensureNote';
import {
  withTemplatedPages,
  isTemplatedPage,
  templatedPageCount,
  bindPageToHeading,
  shiftRecordsForInsertedPage,
  pruneBindingsPastEnd,
  shiftRecordsForRemovedPage,
  anchorPageFor,
} from './utils/config';
import {friendlyErrorMessage, isAuthFailure, withTimeout} from './utils/sdk';
import {isListMissingError, pickReplacementList, describeListSwitch} from './utils/listMatch';
import {ensurePermissions} from './utils/permissions';
import {signatureOf, canSkipRedraw} from './utils/pageSignature';
import {confirmRemovePages} from './utils/dialogs';
import {explainDenied} from './utils/permissionPolicy';
import type {ListChoice} from './utils/listMatch';
import {removeBackLink} from './utils/lassoCapture';
import {runTicktickPreSync, runTicktickPostSync} from './utils/ticktickSync';
import {taskCallWithAutoRecover, checkHealthWithAutoRecover} from './utils/autoRecover';

/** Pull the latest reminders and (re)draw the checklist onto its note page. */
export type FetchAndWriteResult = {
  /** Tasks drawn on the anchor page (what `added` has always meant). */
  added: number;
  /** How many pages were actually drawn this sync. */
  pagesWritten: number;
  /** How many pages the list wants, capped at MAX_PAGES. */
  pagesNeeded: number;
  /** How many pages were available to draw on. */
  usablePages: number;
  /** Tasks that fit nowhere and are only reported as a count. */
  overflow: number;
  /** Continuation pages removed this sync because the list shrank. */
  pagesReclaimed: number;
  /**
   * True when the list could not continue because the NEXT page is bound to a
   * different list. Adding a page cannot fix that, so the user has to be told
   * rather than left with a silently short list.
   */
  blockedByBinding: boolean;
  /**
   * Pages the redraw refused to touch because they belong to another list, so
   * whatever was meant for them was not drawn at all.
   */
  skippedForeignPages: number[];
  /** Continuation pages are switched on in Settings. */
  autoAddOn: boolean;
  /** The list is already using MAX_PAGES pages. */
  atPageLimit: boolean;
  /** Adding a page was attempted and the note refused it. */
  growFailed: boolean;
};

export async function fetchAndWrite(
  config: Ink2TaskConfig,
  opts: {
    skipReload?: boolean;
    target?: Target;
    /** Per-page stroke counts from harvestPages; enables page reclamation. */
    inkByPage?: Map<number, number>;
  } = {},
): Promise<FetchAndWriteResult> {
  const resolvedTarget = opts.target ?? (await resolveTarget(config));
  const {notePath} = resolvedTarget;
  // Always draw from the run's first page -- see anchorPageFor.
  const page = anchorPageFor(config, notePath, resolvedTarget.page);
  const isTemplatePage =
    page === resolvedTarget.page
      ? resolvedTarget.isTemplatePage
      : isTemplatedPage(config, notePath, page);
  await ensureNote(notePath);
  const key = registryKey(notePath, page);
  const previous = (await loadRegistry())[key] || [];

  // Wrapped in taskCallWithAutoRecover: a connectivity failure (stale host,
  // e.g. the Mac's LAN IP changed) gets ONE auto-rediscover-and-retry
  // before throwing -- see autoRecover.ts. Reassigns the local `config` so
  // anything else in THIS call (TickTick outbox/prune below, the redraw's
  // header label) uses the corrected address too. Ported from Ink2Day.
  const fetchResult = await taskCallWithAutoRecover(config, fetchReminders);
  config = fetchResult.config;
  const reminders = fetchResult.result;
  // The other half of the completion picture: if a task was ticked and the
  // backend accepted it, it must NOT come back in this list. When it does, the
  // completion never really landed, and the page redrawing it is a symptom
  // rather than the fault.
  console.log(`[Ink2Task] fetched ${reminders.length} task(s) to draw`);
  // TickTick only: drop sync-state for anything no longer in this fetch
  // (completed, deleted, or moved out of the synced project remotely) --
  // best-effort, mirrors reconcileBackLinks' cleanup below for task-sources.
  if (activeProfileOf(config).backend === 'ticktick') {
    try {
      await runTicktickPostSync(reminders.map(r => r.id));
    } catch (e: any) {
      console.log('[Ink2Task] TickTick sync-state prune failed:', e?.message);
    }
  }
  const sources = await loadTaskSources();
  const paged = await writePaginated({
    config,
    notePath,
    page,
    isTemplatePage,
    reminders,
    previousForAnchor: previous,
    sources,
    header: {platform: activeProfileOf(config).label, list: config.listName},
    honorBackendOrder: ['google', 'todoist'].includes(activeProfileOf(config).backend),
    inkByPage: opts.inkByPage,
  });

  // Clean up back-links for tasks that are gone, and forget their sources.
  await reconcileBackLinks(reminders.map(r => r.id), notePath);
  if (!opts.skipReload) await reloadIfOpen(notePath);
  return paged;
}

/**
 * Pages of `notePath` that currently hold a drawn checklist: the anchor page
 * plus any of the next MAX_PAGES - 1 pages the last sync wrote entries to.
 *
 * Driven by the REGISTRY rather than the note's page count, because that is the
 * record of where this plugin actually drew. A page the user added for their own
 * notes has no entries and must not be scanned, captured from, or redrawn.
 *
 * Includes pages the shrinking list no longer needs: they may still hold
 * handwriting that has to be captured before the page is reclaimed.
 */
export async function activeChecklistPages(
  notePath: string,
  anchorPage: number,
  /** Pages bound to another list, which are NOT part of this run. */
  boundPages: Set<number> = new Set(),
): Promise<number[]> {
  const registry = await loadRegistry();
  // The registry is a HINT, never the truth. The user can delete pages with the
  // device's own page manager at any time, and then the registry still lists
  // them -- scanning one of those made getPageSize fail with 1207 "page does
  // not exist" and took the whole sync down (device 2026-08-22). Clamp to what
  // the note actually has.
  const total = await notePageCount(notePath);
  const pages = [anchorPage];
  for (let i = 1; i < MAX_PAGES; i++) {
    const p = anchorPage + i;
    if (total > 0 && p >= total) break; // page is gone
    // A bound page is a list in its own right, not a continuation of this one --
    // the same rule pageBudget uses when deciding what may be drawn on. Without
    // this, harvest read those pages and ran capture and completion against the
    // ANCHOR's backend, so a check drawn on an Errands page could be completed
    // in Todoist instead.
    if (boundPages.has(p)) break;
    const entries = registry[registryKey(notePath, p)];
    if (!entries || entries.length === 0) break; // contiguous run only
    pages.push(p);
  }
  // Forget registry entries for pages that no longer exist, so the stale keys
  // do not keep being reconsidered on every future sync.
  if (total > 0) {
    for (const key of Object.keys(registry)) {
      if (!key.startsWith(`${notePath}#`)) continue;
      const p = Number(key.slice(key.lastIndexOf('#') + 1));
      if (Number.isFinite(p) && p >= total) {
        await saveRegistryEntries(key, []);
      }
    }
  }
  return pages;
}

export type HarvestedPage = {
  page: number;
  /** Raw scan, kept for ink fingerprinting and for recycling at the end. */
  rawScan: MainLayerScan;
  /** Ghost-filtered scan, what capture and completion actually read. */
  scan: MainLayerScan;
  /** Whether this page had any ink, so the erase check can be skipped when it did not. */
  hadInk: boolean;
};

export type HarvestResult = {
  pages: HarvestedPage[];
  captured: string[];
  duesSet: string[];
  warnings: string[];
  completed: number;
  completedTitles: string[];
  unchecked: number;
  failed: number;
  /** Stroke count per page, for pagesToReclaim's "is this page clean" veto. */
  inkByPage: Map<number, number>;
};

/**
 * Reads EVERY page holding a checklist, then captures handwriting and processes
 * checkmarks on each, before anything is redrawn.
 *
 * Order is the whole point. `replaceElements` wipes a page, so every page must
 * be read before any page is written -- and the created tasks have to exist
 * before the single fetch that follows, or they would not appear in the redraw.
 *
 * Shared by both sync entry points so the multi-page behaviour cannot drift
 * between the on-page button and the Settings screen.
 */
export async function harvestPages(
  eff: Ink2TaskConfig,
  notePath: string,
  anchorPage: number,
  target: Target,
  phase: (m: string) => void = () => {},
): Promise<HarvestResult> {
  // Pages bound to another list must be left alone entirely: they are not part
  // of this run, and reading them here would apply this backend to their rows.
  const bound = new Set<number>();
  for (let i = 1; i < MAX_PAGES; i++) {
    if (eff.pageBindings?.[registryKey(notePath, anchorPage + i)]) bound.add(anchorPage + i);
  }
  const pageNums = await activeChecklistPages(notePath, anchorPage, bound);
  const erased = await loadErasedInk();

  phase('Reading the page…');
  const pages: HarvestedPage[] = [];
  const inkByPage = new Map<number, number>();
  for (const page of pageNums) {
    const rawScan = await scanMainLayer(notePath, page);
    const scan = dropGhostStrokes(rawScan, erased[registryKey(notePath, page)] || []);
    const hadInk = (rawScan.strokes?.length ?? 0) > 0;
    pages.push({page, rawScan, scan, hadInk});
    inkByPage.set(page, scan.strokes?.length ?? 0);
  }

  // Capture and completion both only READ (from the shared per-page scan) and
  // hit the backend on independent requests, so they run together per page.
  // Pages run SEQUENTIALLY: each capture creates tasks, and the ">" subtask
  // lookup for page N+1 needs page N's entries already updated.
  phase('Reading your handwriting…');
  const captured: string[] = [];
  const duesSet: string[] = [];
  const warnings: string[] = [];
  let completed = 0;
  let unchecked = 0;
  let failed = 0;
  const completedTitles: string[] = [];

  const registry = await loadRegistry();
  for (const p of pages) {
    const pageTarget: Target = {...target, page: p.page};
    // Rows of the page above, so a ">" on this page's first row can find a
    // parent that lives at the bottom of the previous page.
    const preceding =
      p.page > anchorPage ? registry[registryKey(notePath, p.page - 1)] || [] : [];
    const [cap, s] = await Promise.all([
      captureAndCreate(eff, p.scan, pageTarget, preceding).catch((e: any) => {
        console.log('[Ink2Task] capture failed on page', p.page, e?.message);
        return {
          created: [] as string[],
          duesSet: [] as string[],
          warnings: [`Capture failed: ${friendlyErrorMessage(e?.message || 'unknown error')}`],
        };
      }),
      syncCompleted(eff, {skipReload: true, scan: p.scan, target: pageTarget}),
    ]);
    captured.push(...cap.created);
    duesSet.push(...cap.duesSet);
    warnings.push(...cap.warnings);
    completed += s.completed;
    unchecked += s.unchecked;
    failed += s.failed;
    completedTitles.push(...s.completedTitles);
    // Logged because completion was a blind spot: a page could report tasks
    // completed while they stayed on the page, and nothing in the log said
    // whether the ticks were seen, whether the backend accepted them, or
    // whether the redraw simply drew them again (2026-08-24).
    if (s.completed || s.unchecked || s.failed) {
      console.log(
        `[Ink2Task] completions p${p.page}: completed=${s.completed} ` +
          `unchecked=${s.unchecked} failed=${s.failed} ` +
          (s.completedTitles.length ? ` -> ${JSON.stringify(s.completedTitles.slice(0, 6))}` : ''),
      );
    }
  }

  return {
    pages,
    captured,
    duesSet,
    warnings,
    completed,
    completedTitles,
    unchecked,
    failed,
    inkByPage,
  };
}

/**
 * Draws a task list across the anchor page and, when the list is too long and
 * the user has opted in, up to MAX_PAGES - 1 continuation pages after it.
 *
 * Shared by BOTH sync entry points (the on-page button via fetchAndWrite, and
 * the Settings screen's own pipeline in Home.tsx) so pagination cannot drift
 * between them -- the two paths already keep separate copies of the surrounding
 * sync steps, and having two copies of the page planning as well is how they
 * would end up disagreeing about which page a task belongs on.
 */
export async function writePaginated(params: {
  config: Ink2TaskConfig;
  notePath: string;
  page: number;
  isTemplatePage: boolean;
  reminders: RemoteReminder[];
  /** Registry entries already on the anchor page (the caller usually has these). */
  previousForAnchor: ChecklistEntry[];
  sources: Awaited<ReturnType<typeof loadTaskSources>>;
  header: {platform: string; list: string};
  honorBackendOrder: boolean;
  /**
   * Stroke count per page from harvestPages. Required for page reclamation: a
   * page whose ink is unknown is never removed. Omit to disable reclamation.
   */
  inkByPage?: Map<number, number>;
}): Promise<FetchAndWriteResult> {
  let {config} = params;
  const {notePath, page, isTemplatePage, previousForAnchor, sources} = params;
  // Reorder so every child sits directly under its parent. No backend returns
  // them that way -- their position fields are scoped per parent, so a flat
  // sort scatters children (device 2026-08-22: a Google subtask drew at row 1
  // with its parent at row 6). Done here, once, for every backend, and before
  // depths/sibling numbers/page packing, all of which assume this order.
  const reminders = orderByHierarchy(params.reminders);

  // Only pages that already exist AND are not bound to another list are
  // eligible: stealing a page the user deliberately bound to a different
  // backend would silently retarget it.
  const depths = subtaskDepths(reminders);
  // MUTABLE on purpose. The growth loop below appends pages, and the draw guard
  // at the end compares against this: reading it once and never refreshing meant
  // a freshly appended page was skipped by the guard on the very sync that
  // created it, so continuation pages only appeared on the SECOND sync (device
  // 2026-08-22). Every append updates it.
  // "<PLATFORM> - <LIST>", matching what writeChecklist prints across the top of
  // every page it owns. Declared here because it is needed BEFORE planning (to
  // decide whose pages are whose) as well as by the draw, clear and remove
  // steps further down.
  const myHeadingUpper = params.header
    ? `${params.header.platform} - ${params.header.list}`.trim().toUpperCase()
    : '';
  let existingPages = await notePageCount(notePath);
  // A binding above the note's real page count makes pageBudget stop short at a
  // page that does not exist, so the list refuses room it actually has. Clear
  // those before deciding anything.
  const prunedConfig = pruneBindingsPastEnd(config, notePath, existingPages);
  if (prunedConfig !== config) {
    config = prunedConfig;
    try {
      await saveConfig(config);
    } catch {
      // best-effort; it re-prunes next sync
    }
  }
  const boundPages = new Set<number>();
  for (let i = 1; i < MAX_PAGES; i++) {
    if (config.pageBindings?.[registryKey(notePath, page + i)]) boundPages.add(page + i);
  }
  let budget = pageBudget({anchorPage: page, existingPages, boundPages});
  let growFailed = false;
  let usablePages = budget.usablePages;

  // One row count for the whole run (pagination packs against a single
  // rows-per-page). A note whose templated pages carry the old ruled
  // background is pinned to its printed 14 rows; everything else follows the
  // density setting -- see utils/rowDensity.ts.
  const {rows: rowsPerPage, legacyRuled} = rowsForRun({
    density: config.rowDensity,
    noteLayoutVersion: await noteLayoutVersion(notePath),
    hasTemplatedPages: isTemplatePage || templatedPageCount(config, notePath) > 0,
  });

  let plan = planPages(reminders, depths, {rowsPerPage, usablePages});

  // OWNERSHIP BEFORE PLANNING, not just before drawing.
  //
  // The draw-time guard stops another list's page being flattened, but by then
  // the plan has already counted that page as room -- so the tasks assigned to
  // it were simply never drawn anywhere. The user added a task, it WAS created
  // in Todoist, and it never appeared on the page (device 2026-08-25). Silent
  // truncation instead of silent destruction is an improvement, not a fix.
  //
  // So ask the pages themselves whose they are BEFORE deciding how much room
  // there is. A page that names another list counts as bound, which both keeps
  // it out of the plan and lets the insert branch below make real room by
  // pushing it down.
  //
  // Only runs when more than one page is actually needed, and only for pages
  // that exist and are not already known to be bound -- each check costs a page
  // read, and the single-page case is the common one.
  if (plan.pagesNeeded > 1 && myHeadingUpper) {
    let foundForeign = false;
    for (let i = 1; i < usablePages; i++) {
      const probe = page + i;
      if (boundPages.has(probe)) continue;
      if (existingPages > 0 && probe >= existingPages) break;
      const heading = await readPageHeading(notePath, probe);
      if (heading && heading.toUpperCase() !== myHeadingUpper) {
        console.log(
          `[Ink2Task] p${probe} belongs to "${heading}", not this list -- not counting it as room`,
        );
        boundPages.add(probe);
        config = bindPageToHeading(config, notePath, probe, heading);
        foundForeign = true;
      }
    }
    if (foundForeign) {
      budget = pageBudget({anchorPage: page, existingPages, boundPages});
      usablePages = budget.usablePages;
      plan = planPages(reminders, depths, {rowsPerPage, usablePages});
      try {
        await saveConfig(config);
      } catch {
        // best-effort; the heading check re-derives it next sync
      }
    }
  }

  // Logged unconditionally, because every "tasks didn't fit" report so far has
  // come down to one of these five numbers and none of them were recorded --
  // leaving the on-screen message as the only evidence, and it was guessing.
  console.log(
    `[Ink2Task] pages: anchor=${page} existing=${existingPages} usable=${usablePages} ` +
      `needed=${plan.pagesNeeded} overflow=${plan.overflow} canGrow=${budget.canGrow} ` +
      `boundNext=${budget.blockedByBinding} autoAdd=${config.autoAddPages !== false}`,
  );
  // Grow only when the user opted in AND the shortfall is actually fixable by
  // adding a page (budget.canGrow). Growing on any shortfall is what made pages
  // multiply on device: the next page was bound to another list, so appending
  // could never help, and every sync appended another one anyway.
  // BLOCKED MID-NOTE: the run cannot be extended by appending, because the page
  // straight after it already exists. Insert one in place instead, which is
  // what insertNotePage's page argument is for -- appending would land past
  // whatever follows and never join this run.
  //
  // This DOES insert ahead of a page bound to another list, pushing it one page
  // down the note. It was refused at first on the grounds that moving somebody
  // else's checklist is not ours to do; the user's answer (2026-08-25) is that
  // adding the page is the expected default and being told "6 tasks didn't fit"
  // instead is the wrong behaviour. Nothing is destroyed -- the other list's
  // page moves, and shiftRecordsForInsertedPage moves its records with it.
  // If that renumbering were ever wrong, the page-heading check in the clear
  // and remove steps is what stops the misalignment being acted on.
  if (config.autoAddPages !== false && plan.pagesNeeded > usablePages && !budget.canGrow) {
    const at = page + usablePages;
    console.log(
      `[Ink2Task] list is blocked at p${at}` +
        (budget.blockedByBinding ? ' (bound to another list, pushing it down)' : '') +
        '; inserting a page there',
    );
    if (await insertTemplatedPageAt(notePath, at, {legacyRuled})) {
      // Renumber BEFORE anything reads a page-indexed store again.
      config = await shiftRecordsForInsertedPage(config, notePath, at);
      // Record the new page as one WE created, the same way the append path
      // does. Without this it is a page nothing can ever tidy away: page
      // removal only touches pages in this record, so an inserted page would
      // outlive the list that needed it. Note shiftTemplatedCount does not
      // cover this case -- inserting at the END of our run leaves the count
      // alone, and this insert always lands exactly there.
      config = withTemplatedPages(config, notePath, at + 1);
      try {
        await saveConfig(config);
      } catch {
        // The files are already renumbered; a lost config costs bindings being
        // one page out, which the page-heading check catches.
      }
      existingPages = await notePageCount(notePath);
      // REBUILD boundPages from the shifted config, do not reuse the set from
      // before the insert. That set still said page N was bound to another
      // list, when the insert had just moved that list to N+1 and made N ours.
      // So the budget came back unchanged, the plan stayed one page, and the
      // user was told "6 tasks didn't fit" on a page that had just been created
      // for them -- and since the condition was still true, the next sync
      // inserted ANOTHER page (device-reported 2026-08-25).
      boundPages.clear();
      for (let i = 1; i < MAX_PAGES; i++) {
        if (config.pageBindings?.[registryKey(notePath, page + i)]) boundPages.add(page + i);
      }
      budget = pageBudget({anchorPage: page, existingPages, boundPages});
      usablePages = budget.usablePages;
      plan = planPages(reminders, depths, {rowsPerPage, usablePages});
      console.log(
        `[Ink2Task] after insert: existing=${existingPages} usable=${usablePages} ` +
          `needed=${plan.pagesNeeded} overflow=${plan.overflow} ` +
          `bound=[${[...boundPages].join(',')}]`,
      );
    } else {
      growFailed = true;
    }
  }

  if (config.autoAddPages !== false && plan.pagesNeeded > usablePages && budget.canGrow) {
    let grown = false;
    while (usablePages < plan.pagesNeeded && budget.canGrow) {
      if (!(await appendTemplatedPage(notePath, {legacyRuled}))) {
        // Silent before, which is how "couldn't add a page" ended up reported
        // to the user as "turn on the setting that is already on".
        console.log('[Ink2Task] could not add a page to the note; giving up on growing');
        growFailed = true;
        break;
      }
      usablePages++;
      grown = true;
      // Record it immediately: a page we created has the template baked in, and
      // forgetting that draws a second SYNC button over the first.
      config = withTemplatedPages(config, notePath, page + usablePages);
      // Re-derive rather than assuming: the append could have landed elsewhere.
      existingPages = await notePageCount(notePath);
      budget = pageBudget({anchorPage: page, existingPages, boundPages});
    }
    if (grown) {
      try {
        await saveConfig(config);
      } catch {
        // best-effort; the pages exist either way and the count re-derives
      }
      plan = planPages(reminders, depths, {rowsPerPage, usablePages});
    }
  }

  const baseStyle = {
    fontPath: config.fontPath,
    scale: config.listScale,
    rows: rowsPerPage,
    // v17+ template pages bake only the density-independent chrome, so the
    // interior row lines must be drawn (ignored on drawChrome pages, whose
    // path draws the full ruling regardless). Legacy pages' ruling is printed.
    drawInteriorRules: !legacyRuled,
    // The v17 template's SYNC/DUE header art is ~2/3 size; the drawn title
    // matches it. Legacy pages keep the old size next to their old baked art.
    compactHeader: !legacyRuled,
    header: params.header,
    sources,
    honorBackendOrder: params.honorBackendOrder,
    use24HourTime: config.use24HourTime,
    checkboxesBaked: await noteHasBakedInCheckboxes(notePath),
  };

  // Sequential on purpose: each page is its own replaceElements (a whole-page
  // mutation) built from a shared native element cache, so overlapping them
  // risks interleaving two pages' batches. Nearest page first, so the one the
  // user is looking at updates even if a later page fails.
  let firstPageCount = 0;
  /** Pages the draw loop refused because they belong to another list. */
  const skippedForeignPages: number[] = [];
  let signaturesChanged = false;
  let pageIndex = -1;
  for (const planned of plan.pages) {
    pageIndex++;
    const target = page + planned.offset;
    // Hard guard: drawing onto a missing page fails with getPageSize 1207 and
    // aborts the sync. planPages is bounded by usablePages, but the note can be
    // edited between that calculation and here, and the anchor page itself is
    // the only one we can assume exists.
    if (existingPages > 0 && target >= existingPages) break;
    // OWNERSHIP CHECK BEFORE DRAWING. Drawing is destructive -- it wipes the
    // page -- and this was the one destructive step without the check. Clearing
    // and removing both read the heading printed on the page first; the draw
    // loop trusted the bindings alone, and a binding that is missing or stale
    // is exactly how another list's page gets flattened. That is what happened
    // to a page of Apple Reminders on 2026-08-25.
    //
    // Skipped for the anchor (it is the page the user synced from, by
    // definition ours) and for pages with no heading yet (a page we just
    // created has nothing drawn on it).
    if (target !== page && myHeadingUpper) {
      const heading = await readPageHeading(notePath, target);
      if (heading && heading.toUpperCase() !== myHeadingUpper) {
        console.log(
          `[Ink2Task] p${target}: NOT drawing here -- the page says "${heading}", ` +
            `this list is "${myHeadingUpper}"`,
        );
        config = bindPageToHeading(config, notePath, target, heading);
        signaturesChanged = true;
        // Reaching here means the ownership check before planning missed it, so
        // the rows meant for this page go nowhere. Say so: the failure the user
        // hit was precisely a task that synced but never appeared, with nothing
        // on screen admitting it (2026-08-25).
        skippedForeignPages.push(target);
        continue;
      }
    }
    const pageKey = registryKey(notePath, target);
    const prev = planned.offset === 0 ? previousForAnchor : (await loadRegistry())[pageKey] || [];
    const isLastPlanned = pageIndex === plan.pages.length - 1;
    const maxBlankRows = isLastPlanned ? undefined : 1;
    const footerLinkTo =
      planned.offset === 0 ? undefined : {destPath: notePath, destPage: page};

    // Can this page keep the drawing it already has? Every page repainted is a
    // full e-ink refresh, and on a three-page list only one page usually
    // changed. See utils/pageSignature.ts -- and note ink on the page vetoes
    // the skip, because the repaint is the only thing that erases it.
    const signature = signatureOf({
      tasks: planned.tasks,
      footer: planned.footer,
      blankRows: maxBlankRows ?? rowsPerPage,
      header: params.header ? `${params.header.platform}/${params.header.list}` : '',
      flags: [
        config.listScale,
        rowsPerPage,
        legacyRuled,
        config.use24HourTime,
        baseStyle.checkboxesBaked,
        !!footerLinkTo,
        params.honorBackendOrder,
      ],
    });
    if (
      canSkipRedraw({
        previous: config.pageSignatures?.[pageKey],
        next: signature,
        inkStrokes: params.inkByPage?.get(target),
      })
    ) {
      // Nothing to redraw, but the "UPDATED" stamp still has to move on, so
      // rewrite just that one line in place. If even that fails, fall through
      // to a full redraw rather than leave a stale time on the page.
      const refreshed = await refreshTimestampOnly(notePath, target, !!config.use24HourTime);
      if (refreshed) {
        console.log(`[Ink2Task] p${target}: unchanged, skipped the repaint`);
        if (planned.offset === 0) firstPageCount = prev.length;
        continue;
      }
      console.log(`[Ink2Task] p${target}: timestamp refresh failed, redrawing`);
    }

    const entries = await writeChecklist(notePath, target, planned.tasks, prev, {
      ...baseStyle,
      // Pages this plugin created carry the same baked template as page 0, so
      // their chrome must NOT be redrawn -- see appendTemplatedPage.
      drawChrome:
        planned.offset === 0 ? !isTemplatePage : !isTemplatedPage(config, notePath, target),
      footerText: planned.footer,
      // One write row on a page that continues; fill the last page as before.
      // See ChecklistStyle.maxBlankRows for why the middle pages differ.
      // Indexed, not offset-derived: offsets happen to be contiguous from 0
      // today, but the last ENTRY of the plan is what "last page" means here.
      maxBlankRows,
      // Continuation pages get a tappable footer back to the anchor. The anchor
      // itself does not: it IS the top of the list, and a link to the page you
      // are already on is just a dead spot on the page.
      footerLinkTo,
    });
    await saveRegistryEntries(pageKey, entries);
    // Only after the page really was drawn, so a failed write cannot leave a
    // signature claiming the page is up to date.
    config = {
      ...config,
      pageSignatures: {...(config.pageSignatures ?? {}), [pageKey]: signature},
    };
    signaturesChanged = true;
    if (planned.offset === 0) {
      firstPageCount = entries.length;
    }
  }

  // ---- Clear pages the list has SHRUNK past --------------------------------
  // When the list gets shorter, the plan covers fewer pages -- and the pages
  // that dropped out of it were simply never touched again, so they went on
  // displaying the old list forever. Tick off everything on page 2, and the
  // tasks are correctly completed on the backend and correctly absent from the
  // redraw, yet still sitting there on screen (device 2026-08-24: 11 completed,
  // 24 tasks became 13, one page's worth, and pages 2 and 3 kept their old
  // contents). Reclamation could not save it either, because the checkmarks
  // still counted as ink and ink vetoes removing a page.
  //
  // Redrawing them empty fixes both halves: the stale list goes, and the
  // leftover ink goes with it, which is what makes the page eligible for
  // reclamation (and therefore the delete prompt) on this same sync.
  const plannedTargets = new Set(plan.pages.map(pp => page + pp.offset));
  const activePages = await activeChecklistPages(notePath, page, boundPages);

  // ---- Re-learning which pages are ours: REVERTED 2026-08-24 ---------------
  // This block used to raise config.templatedPages to cover the whole run of
  // pages carrying our checklist, so that pages orphaned by a lost config could
  // be tidied away again. It shipped in 1.4.2 and the user reported pages
  // disappearing from the note on the very next sync.
  //
  // Whether it was the direct cause is NOT established. What is established is
  // that it widened the set of pages this plugin is willing to DELETE, on
  // evidence ("this page carries our drawing") that cannot distinguish a page
  // we created from a page the user made that the list later grew onto. That is
  // the wrong side to be wrong on: the cost of not deleting a page is clutter,
  // the cost of deleting one is losing someone's notes with no undo.
  //
  // If it comes back it needs a signal that actually proves authorship -- a
  // marker written into the page at creation time, say -- not an inference.

  const myHeading = myHeadingUpper;
  for (const active of activePages) {
    if (plannedTargets.has(active)) continue;
    if (existingPages > 0 && active >= existingPages) continue;
    // Does this page actually belong to the list being synced? pageBindings
    // says so, but it lives in the settings file -- and when that was reset,
    // pages holding an APPLE REMINDERS checklist looked unclaimed, so a Todoist
    // sync cleared and then deleted them (2026-08-24, real loss). The heading
    // drawn across the top of the page is the same claim, stored in the note
    // where a settings reset cannot reach it.
    const heading = await readPageHeading(notePath, active);
    if (heading && myHeading && heading.toUpperCase() !== myHeading) {
      console.log(
        `[Ink2Task] p${active}: leaving it alone -- it belongs to "${heading}", not "${myHeading}"`,
      );
      // Re-record the binding we lost, so the rest of the plugin knows too.
      config = bindPageToHeading(config, notePath, active, heading);
      signaturesChanged = true;
      continue;
    }
    console.log(`[Ink2Task] p${active}: no longer part of the list, clearing it`);
    const key = registryKey(notePath, active);
    const entries = await writeChecklist(notePath, active, [], [], {
      ...baseStyle,
      drawChrome: !isTemplatedPage(config, notePath, active),
      // No footer: this page is no longer part of the list, so "PAGE 2 OF 3"
      // would be a lie and a link back to the top would imply it still belongs.
      footerText: '',
    });
    await saveRegistryEntries(key, entries);
    // It has no tasks now, so it must not claim to be up to date.
    config = {...config, pageSignatures: {...(config.pageSignatures ?? {}), [key]: ''}};
    signaturesChanged = true;
    // Reclamation reads this to decide whether the page is safe to remove, and
    // the redraw just wiped the page, so the count it holds is stale.
    params.inkByPage?.set(active, 0);
  }

  if (signaturesChanged) {
    try {
      await saveConfig(config);
    } catch {
      // Best-effort: a lost signature only costs one extra repaint next sync.
    }
  }

  // ---- Reclaim pages the shrunken list no longer needs ---------------------
  // Runs AFTER the redraw, so a page being dropped has already had its
  // handwriting captured and its checkmarks processed by harvestPages. Every
  // veto lives in pagesToReclaim; this only executes the decision.
  let reclaimed = 0;
  if (config.autoAddPages !== false && params.inkByPage) {
    const boundPages = new Set<number>();
    for (let i = 1; i < MAX_PAGES; i++) {
      if (config.pageBindings?.[registryKey(notePath, page + i)]) boundPages.add(page + i);
    }
    const drop = pagesToReclaim({
      anchorPage: page,
      pagesUsed: plan.pages.length,
      templatedPages: templatedPageCount(config, notePath),
      inkByPage: params.inkByPage,
      boundPages,
    });
    // ASK before deleting. The tasks on a continuation page can be ticked off
    // somewhere else entirely -- a phone, or the web -- so the first this
    // tablet hears of it is a page that has gone empty. Deleting it silently
    // takes anything else written on that page with it, with no undo. The
    // veto list in pagesToReclaim already refuses pages with ink on them, but
    // that check runs on what the LAST sync saw, and this is cheap insurance
    // on an irreversible action. See confirmRemovePages: anything other than a
    // clear yes keeps the page.
    if (drop.length > 0 && !(await confirmRemovePages(drop))) {
      console.log(`[Ink2Task] page removal declined for ${drop.join(', ')}`);
      drop.length = 0;
    }
    // ONE PAGE PER SYNC, hard cap. Whatever else is wrong, a bug in the
    // decision above can then cost at most a single page per sync instead of
    // several in one go -- and the user sees the prompt each time rather than
    // once for a batch. Added 2026-08-24 after pages went missing from a note.
    // drop is highest-index-first, so this takes the last page, which is the
    // only one whose removal cannot renumber another page we are about to act
    // on.
    for (const p of drop.slice(0, 1)) {
      // Never remove a page that still holds tasks. drop should already exclude
      // it, but this is the last gate before an irreversible call and it costs
      // one file read.
      const stillListed = ((await loadRegistry())[registryKey(notePath, p)] || []).filter(
        e => e.kind === 'synced',
      ).length;
      if (stillListed > 0) {
        console.log(`[Ink2Task] refusing to remove p${p}: still holds ${stillListed} task(s)`);
        continue;
      }
      // Same check again immediately before the irreversible call. Cheap, and
      // this is the last chance to notice the page is someone else's.
      const heading = await readPageHeading(notePath, p);
      if (heading && myHeading && heading.toUpperCase() !== myHeading) {
        console.log(`[Ink2Task] refusing to remove p${p}: it belongs to "${heading}"`);
        continue;
      }
      const before = await notePageCount(notePath);
      // Clear our registry entry FIRST: if the removal succeeds, a stale entry
      // would make activeChecklistPages scan a page that no longer exists.
      await saveRegistryEntries(registryKey(notePath, p), []);
      if (await removeNotePageAt(notePath, p)) {
        const after = await notePageCount(notePath);
        console.log(`[Ink2Task] removed p${p}: note went from ${before} to ${after} page(s)`);
        reclaimed++;
        // Renumber what is left. Every page above the removed one just slid
        // down, and records that still describe the old numbers are how a page
        // belonging to another list ends up looking unclaimed.
        config = await shiftRecordsForRemovedPage(config, notePath, p);
        config = withTemplatedPages(config, notePath, p, {shrink: true});
      }
    }
    if (reclaimed > 0) {
      try {
        await saveConfig(config);
      } catch {
        // best-effort; the count re-derives from the note next sync
      }
    }
  }

  return {
    added: firstPageCount,
    pagesWritten: plan.pages.length,
    pagesNeeded: plan.pagesNeeded,
    usablePages,
    overflow: plan.overflow,
    pagesReclaimed: reclaimed,
    skippedForeignPages,
    blockedByBinding: budget.blockedByBinding,
    // Why the list could not get more room, so the summary can say the true
    // reason instead of assuming the setting is off (2026-08-25: the user was
    // told to turn on a setting that was already on).
    autoAddOn: config.autoAddPages !== false,
    atPageLimit: usablePages >= MAX_PAGES,
    growFailed,
  };
}

/**
 * Sweeps away "→ Ink2Task" back-links whose task no longer exists, and drops
 * the source records that pointed at them.
 *
 * Driven by the freshly-fetched list rather than by any single event, so it
 * catches EVERY way a task can vanish -- checked off on the page, completed in
 * the app, or deleted outright -- instead of just the completion path. Also
 * what keeps task-sources.json from growing without bound.
 *
 * Order matters: the link has to come off the note BEFORE its source record is
 * dropped, since that record is the only thing that says which note to look at.
 * Wholly best-effort -- a leftover link must never fail a sync.
 */
export async function reconcileBackLinks(
  liveIds: string[],
  checklistPath: string,
): Promise<void> {
  try {
    const sources = await loadTaskSources();
    const live = new Set(liveIds);
    const dead = Object.keys(sources).filter(id => !live.has(id));
    if (dead.length === 0) return;
    for (const id of dead) {
      const src = sources[id];
      if (src) await removeBackLink(src.notePath, src.page, checklistPath, id);
      delete sources[id];
    }
    await saveTaskSources(sources);
  } catch (e: any) {
    console.log('[Ink2Task] back-link reconcile failed:', e?.message);
  }
}

export type SyncResult = {
  completed: number;
  /** Titles of the tasks that were completed this sync (for the summary). */
  completedTitles: string[];
  unchecked: number;
  failed: number;
};

/**
 * Builds the sync summary shown in the dialog / status box: an "Added:" section
 * and a "Completed:" section, each task on its own line. Sections are omitted
 * when empty; if nothing happened it's "List up to date."
 */
/**
 * Why some tasks could not be shown, so the message can name the real reason.
 *
 * The first version had only `blockedByBinding` and otherwise assumed the
 * "continue on more pages" setting was off -- so a user with it already ON was
 * told to turn it on (2026-08-25). Each field below is a distinct cause with a
 * distinct thing to do about it.
 */
export type PageOffer = {
  /** Tasks that did not fit anywhere. */
  hidden: number;
  /** How many pages the list wanted. */
  needed: number;
  /** The next page belongs to another list. */
  blockedByBinding?: boolean;
  /** Continuation pages are switched on. */
  autoAddOn?: boolean;
  /** Already using the maximum number of pages. */
  atPageLimit?: boolean;
  /** A page was requested and the note refused to add it. */
  growFailed?: boolean;
};

export function formatSyncSummary(
  added: string[],
  completed: string[],
  warnings: string[] = [],
  duesSet: string[] = [],
  /**
   * Set when the list needed more pages than it was allowed to use. Reported as
   * a plain note rather than a warning: nothing failed, the user just has not
   * turned continuation pages on (or has deliberately said no).
   */
  pageOffer?: PageOffer,
  /** Continuation pages removed this sync because the list shrank. */
  pagesReclaimed = 0,
  /**
   * Pages the redraw refused because they belong to another list. LAST on
   * purpose: every argument here is passed positionally, including from
   * index.js, so inserting a parameter in the middle silently shifts the ones
   * after it -- pagesReclaimed became this, on both on-page call sites.
   */
  skippedPages?: number[],
): string {
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push('Added:');
    for (const t of added) lines.push(`"${t}"`);
  }
  if (completed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Completed:');
    for (const t of completed) lines.push(`"${t}"`);
  }
  if (duesSet.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Added due date:');
    for (const d of duesSet) lines.push(d);
  }
  if (pageOffer && pageOffer.hidden > 0) {
    if (lines.length > 0) lines.push('');
    if (pageOffer.growFailed) {
      lines.push(
        `${pageOffer.hidden} task(s) didn't fit, and Ink2Task couldn't add ` +
          'another page to this note. Add a page yourself at the end of the ' +
          'note, then sync again.',
      );
    } else if (pageOffer.atPageLimit) {
      lines.push(
        `${pageOffer.hidden} task(s) didn't fit. The list is already using its ` +
          `maximum of ${MAX_PAGES} pages. Complete or remove some tasks to see them.`,
      );
    } else if (!pageOffer.autoAddOn) {
      lines.push(
        `${pageOffer.hidden} task(s) didn't fit, and the list could not use ` +
          `page ${pageOffer.needed}. Complete some tasks, or start the list on a ` +
          'page with room after it.',
      );
    } else if (pageOffer.blockedByBinding) {
      // NO LONGER says "move that page further down". That was written when the
      // plugin refused to insert ahead of another list's page, so the user had
      // to move it by hand. It now inserts and pushes that page down itself
      // (2026-08-25), which makes this message reachable only when the insert
      // was not attempted or did not help -- so it must not hand out an
      // instruction the plugin has already carried out.
      lines.push(
        `${pageOffer.hidden} task(s) didn't fit. The next page of the note syncs a ` +
          'different list, and Ink2Task could not add a page ahead of it. ' +
          'Complete some tasks, or add a page to the note yourself just after this one.',
      );
    } else {
      lines.push(
        `${pageOffer.hidden} task(s) didn't fit, and the list could not use ` +
          `page ${pageOffer.needed}. Complete some tasks, or start the list on a ` +
          'page with room after it.',
      );
    }
  }
  if (skippedPages && skippedPages.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Some tasks were not drawn: page ${skippedPages.map(n => n + 1).join(', ')} of ` +
        'this note belongs to a different list, so Ink2Task left it alone. ' +
        'Any task you added is still saved in your task app.',
    );
  }
  if (pagesReclaimed > 0) {
    if (lines.length > 0) lines.push('');
    // Singular and plural are ALTERNATIVES, not two sentences. They were
    // originally two array elements chosen between; a sweep that joined
    // multi-element pushes into one wrapped string concatenated them instead,
    // so the dialog said it twice (2026-08-25).
    lines.push(
      pagesReclaimed === 1
        ? 'Removed 1 empty page the list no longer needs.'
        : `Removed ${pagesReclaimed} empty pages the list no longer needs.`,
    );
  }
  const body = lines.length > 0 ? lines.join('\n') : 'List up to date.';
  if (warnings.length === 0) return body;
  return `${body}\n\n⚠ ${warnings.join('\n⚠ ')}`;
}

/**
 * Complete the tasks whose boxes were checked. This ONLY talks to the backend --
 * it deliberately does NOT remove rows from the page or prune the registry. The
 * redraw that follows (fetchAndWrite -> writeChecklist -> replaceElements) wipes
 * and repacks the whole page in one op, and the completed tasks are already gone
 * from the freshly-fetched list, so the list rebuilds correctly with a single
 * visual update instead of a remove-now / repack-after-the-network-fetch flicker.
 */
export async function syncCompleted(
  config: Ink2TaskConfig,
  opts: {skipReload?: boolean; scan?: MainLayerScan; target?: Target} = {},
): Promise<SyncResult> {
  const {notePath, page} = opts.target ?? (await resolveTarget(config));
  const key = registryKey(notePath, page);
  const entries = (await loadRegistry())[key] || [];
  if (entries.length === 0) return {completed: 0, completedTitles: [], unchecked: 0, failed: 0};

  const detected = await detectCheckedBoxes(notePath, page, entries, opts.scan);
  if (detected.length === 0) {
    return {completed: 0, completedTitles: [], unchecked: 0, failed: 0};
  }

  const ids = detected.map(d => d.reminderId);
  const res = await completeReminders(config, ids);
  const cset = new Set(res.completed);
  // Split out from the caller's summary on purpose: "9 completed" on screen and
  // 9 tasks still drawn on the page are only contradictory if you know whether
  // the BACKEND accepted them. res.failed is that answer.
  if (res.failed.length) {
    console.log(
      `[Ink2Task] p${page}: backend REJECTED ${res.failed.length} of ${ids.length} completion(s)`,
    );
  }
  const completedTitles: string[] = [];
  for (const d of detected) {
    if (cset.has(d.reminderId)) completedTitles.push(d.entry.title || '(task)');
  }

  // NOTE: dead back-links aren't cleaned up here. reconcileBackLinks (called
  // from fetchAndWrite, after the fetch) handles it for EVERY reason a task can
  // disappear -- completed here, completed in the app, or deleted outright --
  // rather than only the completion path.

  return {
    completed: res.completed.length,
    completedTitles,
    unchecked: 0,
    failed: res.failed.length,
  };
}

export type SyncThenFetch = SyncResult & {
  added: number;
  captured: string[];
  /**
   * True when the tap landed on a note the plugin does NOT manage, so nothing
   * was synced or drawn. The button uses this to stay completely silent rather
   * than wiping/redrawing an unrelated note.
   */
  skipped?: boolean;
  /** Failures worth telling the user about (see CaptureResult.warnings). */
  warnings?: string[];
  /** Due dates read from the DUE boxes and saved this sync. */
  duesSet?: string[];
  /**
   * Present when tasks didn't fit and more pages would have helped, but the
   * user has continuation pages turned off (config.autoAddPages === false),
   * or the next page is bound elsewhere. The caller shows
   * this so a shortened list is never silent about why.
   */
  pageOffer?: PageOffer;
  /** Continuation pages removed this sync because the list shrank. */
  pagesReclaimed?: number;
};

const SKIPPED_RESULT: SyncThenFetch = {
  added: 0,
  captured: [],
  completed: 0,
  completedTitles: [],
  unchecked: 0,
  failed: 0,
  skipped: true,
};

/**
 * The on-page button action: process the checks you've drawn (Sync), then pull
 * the latest list and redraw (Fetch). Sync runs first so a Fetch redraw can't
 * wipe your checkmarks before they're read.
 *
 * `requireOpenNote` makes this a no-op unless the checklist note is the one on
 * screen. The on-page SYNC button MUST pass it -- its motion listener is global
 * and fires on screen coordinates alone, so without it a corner tap on any
 * other note starts a sync. Lasso capture deliberately leaves it off: it runs
 * from whatever note you lassoed on and needs the checklist redrawn in the
 * background.
 *
 * `target`, if given, is used AS-IS instead of a fresh `resolveTarget(config)`
 * call. Lasso capture's redraw MUST pass the same target `resolveLassoTarget`
 * already resolved for the capture itself -- re-resolving independently here
 * (device-confirmed 2026-08-14) can land on a DIFFERENT page than the one just
 * captured to: resolveTarget's "am I on the checklist note" check relies on
 * getCurrentFilePath(), which only reports the last note THIS PLUGIN touched
 * (see resolveLassoTarget's doc) -- and reading the lassoed selection's SOURCE
 * note in between (to OCR/read it) changes that "last touched" value, so by
 * the time this second resolve runs it can see a different note than the
 * capture did and silently fall back to page 0, redrawing the wrong page's
 * list while the just-created task sits correctly on the backend but never
 * gets painted onto the page the user is actually looking at.
 */
export async function syncThenFetch(
  config: Ink2TaskConfig,
  opts: {
    requireOpenNote?: boolean;
    onPhase?: (message: string) => void;
    target?: Target;
    /** Set only by the missing-list retry below, to cap it at one attempt. */
    isListRetry?: boolean;
  } = {},
): Promise<SyncThenFetch> {
  // Progress reporting is a CALLBACK, not a UI call, so this module stays free
  // of presentation concerns: index.js drives the floating bubble with it, the
  // Home screen drives its own status text, and neither knows about the other.
  // Phases are deliberately coarse -- each one repaints the bubble, and e-ink
  // repaints are slow and visible.
  const phase = (m: string) => {
    try {
      opts.onPhase?.(m);
    } catch {
      // a progress indicator must never be able to fail a sync
    }
  };
  // The on-page SYNC button is physically ON a note/page, so it always syncs
  // THAT page -- resolveTarget already does this (it uses the current page
  // when you're on the Ink2Task note, else falls back to page 0). Resolved
  // ONCE here and threaded into every step below: each resolve is several
  // native round-trips, and the steps all act on the same page anyway.
  const resolved = opts.target ?? (await resolveTarget(config));
  const {notePath} = resolved;
  // The page the user is LOOKING at, which is not necessarily where the list
  // starts. Kept so the sync can put them back on it afterwards.
  const viewedPage = resolved.page;
  // The list always redraws from the FIRST page of its run. Syncing from a
  // continuation page used to make that page the new start, walking the whole
  // run down the note one sync at a time -- see anchorPageFor.
  const page = anchorPageFor(config, notePath, viewedPage);
  const target: Target =
    page === viewedPage
      ? resolved
      : {...resolved, page, isTemplatePage: isTemplatedPage(config, notePath, page)};

  // ⚠️ SAFETY GATE: the on-page listener fires on screen COORDINATES alone, on
  // ANY open note -- a tap in the top-left corner of an UNRELATED note used to
  // kick off a full sync (0.2.52 wiped that note; today it targets the
  // checklist note instead, so it's a surprise sync + dialog rather than data
  // loss -- but it still must not happen).
  //
  // This gate USED to read `notePath !== toAbsolute(config.notePath)`, which
  // could never be true: resolveTarget always returns the configured checklist
  // path, never the open note's. It went dead when "use current note" mode was
  // removed and stayed dead. target.isOpen is the real check.
  //
  // Only the on-page button passes requireOpenNote -- lasso capture calls this
  // from whatever note you lassoed on, and legitimately needs the background
  // redraw.
  if (opts.requireOpenNote && !target.isOpen) return SKIPPED_RESULT;

  const eff = effectiveConfigForPage(config, notePath, page);
  // Remember which profile+list this page actually just synced with, so it
  // keeps using that backend even if the "currently selected" profile changes
  // elsewhere (Settings, or syncing a different page) in between visits --
  // this is what lets each page recognize and stick to its own backend
  // instead of borrowing whatever's globally active right now. Also record it
  // as the last-VIEWED page (set here, before the sync below even runs --
  // this is the point we actually confirmed you're on it), so a lasso
  // capture made from some OTHER note defaults here instead of always page 0
  // -- see resolveLassoTarget.
  const boundConfig = withLastViewedPage(
    bindPage(config, notePath, page, eff.activeProfile, eff.listName),
    notePath,
    page,
  );
  try {
    await saveConfig(boundConfig);
  } catch {
    // best-effort; the sync below still uses the right profile either way
  }

  // Permission gate. Runs before the first file or network work of the sync,
  // and no-ops entirely on firmware without a permission system. See
  // utils/permissions.ts.
  const perms = await ensurePermissions();
  if (!perms.ok) throw new Error(explainDenied(perms.denied));

  // TickTick only: retry anything queued while offline BEFORE reading fresh
  // remote state below -- draining after the fetch could let a just-applied
  // edit get immediately overwritten by a stale read from the same sync.
  // Best-effort: draining must never block or fail a sync.
  if (activeProfileOf(eff).backend === 'ticktick') {
    try {
      await runTicktickPreSync(eff);
    } catch (e: any) {
      console.log('[Ink2Task] TickTick outbox drain failed:', e?.message);
    }
  }

  // Read EVERY page holding a checklist, then capture handwriting and process
  // checkmarks on each, before anything is redrawn. replaceElements wipes a
  // page, so all reads must precede all writes -- and created tasks must exist
  // before the single fetch below, or they would not appear in the redraw.
  // A list that does not exist on this backend is worth fixing rather than
  // reporting, but only when the replacement is unambiguous -- see
  // recoverMissingList. The on-page SYNC button has no settings UI to fall back
  // on, so without this a first TickTick sync from the page just failed.
  let harvest;
  try {
    harvest = await harvestPages(eff, notePath, page, target, phase);
  } catch (e) {
    if (opts.isListRetry) throw e;
    const rescue = await recoverMissingList(eff, e).catch(() => null);
    if (!rescue?.choice) throw e;
    phase(`Using "${rescue.choice.name}"…`);
    // Re-enter with the corrected config rather than patching `eff` in place:
    // the list name is baked into this page's binding above, so the whole pass
    // has to be redone for the page to end up bound to the list it really used.
    const retried = await syncThenFetch(rescue.config, {...opts, isListRetry: true});
    return {
      ...retried,
      warnings: [...(retried.warnings ?? []), describeListSwitch(eff.listName, rescue.choice)],
    };
  }

  // fetchAndWrite does the page mutations: one fetch, then writeChecklist ->
  // replaceElements per page, wiping user ink and drawing the repacked list.
  phase('Fetching and redrawing…');
  const write = await fetchAndWrite(eff, {
    skipReload: true,
    target,
    inkByPage: harvest.inkByPage,
  });
  const added = write.added;

  // If the redraw couldn't erase the handwriting, say so -- otherwise the page
  // looks fine (the checklist covers the ink) until the plugin is removed.
  const redrawWarning = takeRedrawWarning();
  const warnings = redrawWarning ? [...harvest.warnings, redrawWarning] : harvest.warnings;
  phase('Saving…');
  await reloadIfOpen(notePath);

  // Verify the erase AFTER the save/reload -- this is the state the user
  // actually sees, and the only place a retry is worth an extra repaint. Only
  // pages that HAD ink are worth checking.
  let repainted = false;
  const eraseFailed = new Set<number>();
  for (const p of harvest.pages) {
    if (!p.hadInk) continue;
    const {leftover, retried} = await verifyEraseAndRetry(notePath, p.page);
    if (retried && leftover === 0) repainted = true;
    if (leftover > 0) {
      eraseFailed.add(p.page);
      warnings.push(
        `Handwriting not erased on page ${p.page + 1} -- ${leftover} stroke(s) still there after saving.`,
      );
    }
  }

  // Remember the ink each page just erased, so if the host restores it on a
  // reinstall the next sync can tell those strokes from genuinely new ones.
  // Fingerprints the RAW scan: ghosts stay ghosts until real ink replaces them.
  //
  // MOVED AFTER THE VERIFY, and skipped for any page whose erase FAILED. Doing
  // this unconditionally was a self-perpetuating trap: when the erase failed,
  // the surviving strokes were recorded as "already erased", so every later
  // sync silently discarded them as ghosts -- including checkmarks drawn in
  // those same boxes. The user ticked off a whole page, synced, and got "List
  // up to date" with nothing completed, permanently (device 2026-08-24). Ink
  // that is still on the page is REAL ink, whatever we intended.
  for (const p of harvest.pages) {
    const key = registryKey(notePath, p.page);
    if (eraseFailed.has(p.page)) {
      // CLEAR rather than merely skip. A page poisoned by an earlier build
      // still carries fingerprints covering the surviving strokes, so leaving
      // them would keep discarding the user's checkmarks forever. Wiping them
      // costs nothing -- the worst case is that genuinely restored ink is
      // treated as new once -- and it makes the fix retroactive for pages that
      // are already stuck.
      await saveErasedInk(key, []);
      continue;
    }
    await saveErasedInk(key, inkPrintsOf(p.rawScan));
  }
  // A retry rewrote a page after the reload, so repaint once to show it. Rare:
  // only when ink genuinely survived the first pass.
  if (repainted) await reloadIfOpen(notePath);

  // Everything that needed the scanned page handles (capture/OCR, completion
  // detection, the erase checks) is done -- hand them back. Recycling the raw
  // scan covers the ghost-filtered one too; they share the same objects.
  for (const p of harvest.pages) recycleScan(p.rawScan);
  // TickTick only: persist what Settings shows as "last sync" -- see the
  // matching comment in Home.tsx's runFetchAndWrite. Recorded here (the
  // on-page button path) too, so the status is accurate regardless of which
  // entry point was used to sync. Unlike Home.tsx, there's no matching
  // catch-block save for an outright crash -- index.js already shows an
  // error dialog for that case, and touching it (a global motion listener)
  // isn't worth the risk for what would only improve a Settings-screen
  // status line the user wasn't looking at anyway when the crash happened.
  if (activeProfileOf(eff).backend === 'ticktick') {
    try {
      await saveTicktickSyncMeta({
        lastSyncAt: Date.now(),
        lastError: warnings.length > 0 ? warnings.join('; ') : undefined,
      });
    } catch {
      // best-effort; the sync itself already succeeded
    }
  }
  const pageOffer =
    write.overflow > 0 && write.pagesNeeded > write.usablePages
      ? {
          hidden: write.overflow,
          needed: write.pagesNeeded,
          blockedByBinding: write.blockedByBinding,
          autoAddOn: write.autoAddOn,
          atPageLimit: write.atPageLimit,
          growFailed: write.growFailed,
        }
      : undefined;
  return {
    completed: harvest.completed,
    completedTitles: harvest.completedTitles,
    unchecked: harvest.unchecked,
    failed: harvest.failed,
    added,
    captured: harvest.captured,
    warnings,
    duesSet: harvest.duesSet,
    pageOffer,
    pagesReclaimed: write.pagesReclaimed,
  };
}


/**
 * Turns a sync failure into the plain-language explanation the old "TEST MY
 * SETUP" button used to produce.
 *
 * That button existed because "Network request failed" alone took many rounds
 * to diagnose in a real support thread (ink2task#2). Removing the button only
 * makes sense if the SYNC itself says as much, so this runs the same checks --
 * can the server be reached, does the configured list exist -- and reports them
 * on the same lines. It runs only on the failure path, so a working sync pays
 * nothing for it.
 *
 * Never throws: a diagnostic that fails must not replace the original error.
 */
/**
 * A missing list is recoverable without bothering the user WHEN the right
 * replacement is obvious -- see pickReplacementList for what counts as obvious
 * and, more importantly, what does not. Persists the choice so the next sync
 * needs no recovery, and returns the corrected config for the caller to retry
 * with ONCE.
 *
 * `lists` comes back either way, so a caller that gets `choice: null` can put
 * the names straight in front of the user instead of making them go and look.
 */
export async function recoverMissingList(
  config: Ink2TaskConfig,
  err: unknown,
): Promise<{
  config: Ink2TaskConfig;
  choice: ListChoice | null;
  note?: string;
  lists: string[];
} | null> {
  const message = (err as Error)?.message || '';
  if (!isListMissingError(message)) return null;
  let lists: string[] = [];
  try {
    lists = await fetchLists(config);
  } catch {
    return null; // cannot even see the lists; the original error stands
  }
  const from = config.listName;
  const choice = pickReplacementList(from, lists);
  if (!choice) return {config, choice: null, lists};
  const fixed = setActiveConnection(config, {listName: choice.name});
  await saveConfig(fixed).catch(() => {});
  return {config: fixed, choice, note: describeListSwitch(from, choice), lists};
}

export async function explainSyncFailure(
  config: Ink2TaskConfig,
  err: unknown,
): Promise<string> {
  const raw = (err as Error)?.message || 'Sync failed.';
  const profileLabel = activeProfileOf(config).label;
  const base = friendlyErrorMessage(raw, profileLabel);
  const lines: string[] = [base];
  // A rejected token is already fully explained, and the reachability probe
  // below would only add noise: it uses the SAME bad token, so it fails too and
  // then blames the network. That is exactly what happened on 2026-08-23 -- a
  // Todoist token off by one letter produced "No address is set for Todoist,
  // and no server answered on this Wi-Fi. Start the server on your computer",
  // advice that was both wrong and impossible to act on (direct-Todoist mode
  // has no server to start).
  if (isAuthFailure(raw)) return base;
  // Checked before anything about servers or Wi-Fi: a Todoist profile with no
  // token cannot reach anything, and every message below would send the user
  // off to fix the wrong thing.
  if (isTodoistMissingToken(config)) {
    return (
      'No Todoist token is saved, so there is nothing to sync with. ' +
      'Open Settings and enter your token from Todoist, under Settings, ' +
      'Integrations, Developer. Type it in slowly: the field cannot paste, ' +
      'and one wrong character is enough.'
    );
  }
  // A missing list already says which list. Adding "Reached the server, but
  // list X does not exist" underneath just says it twice; the useful half is
  // the names, which the branch below supplies.
  if (isListMissingError(raw)) {
    try {
      const lists = await fetchLists(config);
      return lists.length
        ? `${base}\n\nPick one of these in Settings: ${lists.join(', ')}`
        : `${base}\n\nThis account has no lists at all -- make one first.`;
    } catch {
      return base;
    }
  }
  // Direct-Todoist talks to Todoist over the internet, so there is no address,
  // no server and no Wi-Fi to advise about. An empty host is CORRECT here.
  if (isDirectTodoist(config)) {
    try {
      const lists = await fetchLists(config);
      if (!lists.includes(config.listName)) {
        lines.push(
        ' ' +
          `Todoist has no project named "${config.listName}". ` +
          `Available: ${lists.join(', ')} ` +
          'Todoist reported no projects at all.',
      );
      }
    } catch {
      lines.push('', "Couldn't reach Todoist -- check the Supernote is online.");
    }
    return lines.join('\n');
  }
  try {
    const {result: health, config: healed} = await checkHealthWithAutoRecover(config, checkHealth);
    if (!health.ok) {
      const profile = activeProfileOf(config);
      lines.push('');
      if (!config.host.trim()) {
        lines.push(
        `No address is set for ${profile.label}, and no server answered on this Wi-Fi. ` +
          'Start the server on your computer, then sync again.',
      );
      } else {
        lines.push(
        `Couldn't reach ${profile.label} at ${config.host}:${config.port}. ` +
          'Check the server is running and on the same Wi-Fi.',
      );
      }
      return lines.join('\n');
    }
    // Reachable, so the list name is the next thing a sync would trip over.
    const lists = await fetchLists(healed);
    if (lists.length === 0) {
      lines.push(
        ' ' +
          'Reached the server, but it reported no lists at all.',
      );
    } else if (!lists.includes(healed.listName)) {
      lines.push(
        ' ' +
          `Reached the server, but list "${healed.listName}" does not exist. ` +
          `Available: ${lists.join(', ')}`,
      );
    } else {
      lines.push(
        ' ' +
          `Reached the server and list "${healed.listName}" exists.`,
      );
    }
  } catch {
    // Diagnosis itself failed; the original message still stands.
  }
  return lines.join('\n');
}
