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
  loadTaskSources,
  saveTaskSources,
  loadErasedInk,
  saveErasedInk,
  saveTicktickSyncMeta,
} from './utils/config';
import {
  fetchReminders,
  completeReminders,
} from './api/macServer';
import {
  writeChecklist,
  detectCheckedBoxes,
  scanMainLayer,
  takeRedrawWarning,
  dropGhostStrokes,
  inkPrintsOf,
  verifyEraseAndRetry,
  recycleScan,
} from './utils/checklistPage';
import type {MainLayerScan} from './utils/checklistPage';
import {ensureNote, noteHasBakedInCheckboxes} from './utils/ensureNote';
import {resolveTarget, reloadIfOpen} from './utils/target';
import type {Target} from './utils/target';
import {captureAndCreate} from './utils/capture';
import {friendlyErrorMessage} from './utils/sdk';
import {removeBackLink} from './utils/lassoCapture';
import {runTicktickPreSync, runTicktickPostSync} from './utils/ticktickSync';
import {taskCallWithAutoRecover} from './utils/autoRecover';

/** Pull the latest reminders and (re)draw the checklist onto its note page. */
export async function fetchAndWrite(
  config: Ink2TaskConfig,
  opts: {skipReload?: boolean; target?: Target} = {},
): Promise<number> {
  const {notePath, page, isTemplatePage} = opts.target ?? (await resolveTarget(config));
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
  const entries = await writeChecklist(notePath, page, reminders, previous, {
    fontPath: config.fontPath,
    scale: config.listScale,
    header: {platform: activeProfileOf(config).label, list: config.listName},
    // The template page has the background baked in (ensureNote); any other
    // page was added afterward with the device's own note tools and starts
    // blank. isTemplatePage (from resolveTarget) is more reliable than a
    // raw page-index comparison -- see the comment in target.ts.
    drawChrome: !isTemplatePage,
    sources,
    // Google Tasks/Todoist have a real manual-order field and already return
    // reminders sorted by it. Apple Reminders has none, so it stays
    // slot-stable. TickTick ALSO stays slot-stable (device-confirmed
    // 2026-08-14): its API doesn't return a reliable manual order -- newly
    // created tasks came back first, so a lassoed capture appeared at the TOP
    // of the list instead of the bottom.
    honorBackendOrder: ['google', 'todoist'].includes(activeProfileOf(config).backend),
    use24HourTime: config.use24HourTime,
    checkboxesBaked: await noteHasBakedInCheckboxes(),
  });
  await saveRegistryEntries(key, entries);
  // Clean up back-links for tasks that are gone, and forget their sources.
  await reconcileBackLinks(reminders.map(r => r.id), notePath);
  if (!opts.skipReload) await reloadIfOpen(notePath);
  return entries.length;
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
  /** Set when checkbox detection found nothing despite strokes on the page. */
  checkboxDiagnostic?: string;
};

/**
 * Builds the sync summary shown in the dialog / status box: an "Added:" section
 * and a "Completed:" section, each task on its own line. Sections are omitted
 * when empty; if nothing happened it's "List up to date."
 */
export function formatSyncSummary(
  added: string[],
  completed: string[],
  warnings: string[] = [],
  duesSet: string[] = [],
  checkboxDiagnostic?: string,
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
  const body = lines.length > 0 ? lines.join('\n') : 'List up to date.';
  const parts = [body];
  if (checkboxDiagnostic) parts.push(checkboxDiagnostic);
  if (warnings.length > 0) parts.push(`⚠ ${warnings.join('\n⚠ ')}`);
  return parts.join('\n\n');
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
    const strokeCount = opts.scan?.centers?.length ?? 0;
    const syncedCount = entries.filter(e => e.kind === 'synced' && !e.completed).length;
    let checkboxDiagnostic: string | undefined;
    if (strokeCount > 0 && syncedCount > 0) {
      const firstStroke = opts.scan!.centers[0];
      const firstBox = entries.find(e => e.kind === 'synced' && !e.completed);
      const ps = opts.scan!.pageSize;
      let detail = `[Debug] ${strokeCount} stroke(s), ${syncedCount} checkbox(es), 0 matched.`;
      detail += ` Page ${ps.width}x${ps.height}.`;
      if (firstStroke) detail += ` Stroke center: (${Math.round(firstStroke.cx)},${Math.round(firstStroke.cy)}).`;
      if (firstBox) detail += ` Box: (${Math.round(firstBox.box.left)},${Math.round(firstBox.box.top)})-(${Math.round(firstBox.box.right)},${Math.round(firstBox.box.bottom)}).`;
      checkboxDiagnostic = detail;
    }
    return {completed: 0, completedTitles: [], unchecked: 0, failed: 0, checkboxDiagnostic};
  }

  const res = await completeReminders(config, detected.map(d => d.reminderId));
  const cset = new Set(res.completed);
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
  opts: {requireOpenNote?: boolean; onPhase?: (message: string) => void; target?: Target} = {},
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
  const target = opts.target ?? (await resolveTarget(config));
  const {notePath, page} = target;

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

  // Read the page ONCE and share it: capture (blank + due boxes) and completion
  // detection all work off this single scan instead of each re-reading the page
  // and re-bounding every stroke -- the biggest sync-speed lever.
  phase('Reading the page…');
  const rawScan = await scanMainLayer(notePath, page);
  const inkKey = registryKey(notePath, page);
  // Installing the plugin can make the host revert page edits, bringing back
  // ink a PREVIOUS sync already erased -- the per-stroke ghost filter is what
  // catches that (and everything else already-erased), by fingerprint, on
  // every sync, not just the first one after an install.
  const scan = dropGhostStrokes(rawScan, (await loadErasedInk())[inkKey] || []);
  // Capture handwritten tasks AND complete checked ones concurrently. Both only
  // READ (from the shared scan) and hit the backend on independent requests, so
  // running them together shaves a network round-trip off every sync. Both must
  // settle before the fetch so the redraw reflects the just-created and
  // just-completed tasks.
  phase('Reading your handwriting…');
  const [cap, s] = await Promise.all([
    captureAndCreate(eff, scan, target).catch((e: any) => {
      console.log('[Ink2Task] capture failed:', e?.message);
      return {
        created: [] as string[],
        duesSet: [] as string[],
        warnings: [`Capture failed: ${friendlyErrorMessage(e?.message || 'unknown error')}`],
      };
    }),
    syncCompleted(eff, {skipReload: true, scan, target}),
  ]);

  // Nothing of the user's was on the page, so there's nothing the redraw could
  // fail to erase -- skip both erase checks (a getElements round-trip inside
  // the erase check below) on what is the common repeat-sync case.
  const hadInk = (rawScan.strokes?.length ?? 0) > 0;

  // fetchAndWrite does the ONE page mutation: writeChecklist -> replaceElements
  // wipes all user ink and draws the fresh, repacked list in a single op.
  phase('Fetching and redrawing…');
  const added = await fetchAndWrite(eff, {skipReload: true, target});
  // Remember the ink this sync just erased, so if the host restores it on a
  // reinstall the next sync can tell those strokes from genuinely new ones.
  // Fingerprints the RAW scan: ghosts stay ghosts until real ink replaces them.
  await saveErasedInk(inkKey, inkPrintsOf(rawScan));
  // If the redraw couldn't erase the handwriting, say so -- otherwise the page
  // looks fine (the checklist covers the ink) until the plugin is removed.
  const redrawWarning = takeRedrawWarning();
  const warnings = redrawWarning ? [...cap.warnings, redrawWarning] : cap.warnings;
  phase('Saving…');
  await reloadIfOpen(notePath);

  // Verify the erase AFTER the save/reload -- this is the state the user
  // actually sees, and the only place a retry is worth an extra repaint. Only
  // runs when there was ink to erase in the first place.
  if (hadInk) {
    const {leftover, retried} = await verifyEraseAndRetry(notePath, page);
    // A retry rewrote the page after the reload, so repaint to show it. Rare:
    // only when ink genuinely survived the first pass.
    if (retried && leftover === 0) await reloadIfOpen(notePath);
    if (leftover > 0) {
      warnings.push(
        `Handwriting not erased -- ${leftover} stroke(s) still on the page after saving.`,
      );
    }
  }
  // Everything that needed the scanned page handles (capture/OCR, completion
  // detection, the erase checks) is done -- hand them back. Recycling the raw
  // scan covers the ghost-filtered one too; they share the same objects.
  recycleScan(rawScan);
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
  return {...s, added, captured: cap.created, warnings, duesSet: cap.duesSet};
}
