/**
 * Handwritten-task capture (no manual lasso).
 *
 * On Fetch, each blank row's rectangle is scanned for handwriting -- not via
 * lassoElements (which wouldn't register a selection programmatically), but by
 * reading all page strokes and keeping the ones whose center falls inside the
 * box (SuperTemplate's fallback, and the same detection we use for checkmarks).
 * The matched strokes are OCR'd with recognizeElements, which takes the note
 * page size and handles coordinate interpretation internally.
 *
 * This first pass only recognizes and returns text, so we can confirm the
 * pipeline on-device before wiring up reminder creation and the in-place layout.
 */
import {PluginCommAPI} from 'sn-plugin-lib';
import {unwrap} from './sdk';
import {
  scanMainLayer,
  strokesInRect,
  textElementsInRect,
} from './checklistPage';
import type {MainLayerScan} from './checklistPage';
import {loadRegistry, saveRegistryEntries, registryKey} from './config';
import {resolveTarget} from './target';
import type {Target} from './target';
import {createReminder, updateReminderDue} from '../api/macServer';
import {parseDueDate} from './dateParse';
import type {ChecklistEntry, Ink2TaskConfig} from './config';

type Rect = {left: number; top: number; right: number; bottom: number};

export type CaptureResult = {
  /** Titles of tasks created from handwriting this pass. */
  created: string[];
  /** Due dates read from the DUE boxes and saved, as "<task> → <date>". */
  duesSet: string[];
  /**
   * User-facing failures (couldn't create a task, couldn't save a due date).
   * Surfaced in the sync summary -- these are silent data loss otherwise, since
   * the redraw erases the handwriting either way.
   */
  warnings: string[];
};

export type CapturedBox = {
  /** Index into the entries array of the blank row this came from. */
  entryIndex: number;
  text: string;
  rect: Rect;
};

/**
 * Scans the blank boxes, creates a reminder for each recognized phrase, and
 * marks those rows captured-in-place in the registry. Call this BEFORE any
 * reloadFile in the flow -- a reload discards freshly-written, unsaved strokes,
 * which is why capture must run first. Returns the recognized titles created.
 */
export async function captureAndCreate(
  config: Ink2TaskConfig,
  scan?: MainLayerScan,
  target?: Target,
): Promise<CaptureResult> {
  // The Sync flows resolve the target once and pass it down; resolving it again
  // per step costs several native round-trips (and those calls can hang -- see
  // withTimeout in sdk.ts). Standalone callers still resolve their own.
  const {notePath, page} = target ?? (await resolveTarget(config));
  const key = registryKey(notePath, page);
  const registry = await loadRegistry();
  const entries = registry[key] || [];

  // One shared page read for the whole capture pass (blank boxes + due boxes).
  // The Sync builds this once and passes it in; standalone callers get their own.
  const s = scan ?? (await scanMainLayer(notePath, page));
  const boxes = await captureBlankRows(entries, s);
  // Dates handwritten in the DUE column, per row (both new tasks and existing
  // synced rows that had no due yet), already parsed to ISO "YYYY-MM-DD".
  const dues = await captureDueDates(entries, s);
  if (boxes.length === 0 && dues.size === 0) return {created: [], duesSet: [], warnings: []};

  // NOTE: we deliberately do NOT saveCurrentNote here. The strokes stay in the
  // unsaved buffer so the redraw's replaceElements (later this sync) can actually
  // wipe them -- committing them first appears to make the wipe a no-op, leaving
  // the ink behind. reloadIfOpen saves the cleared page at the end.

  const created: string[] = [];
  // Failures the user MUST be told about. These used to be console.log-only,
  // which on this device is invisible (no logcat access) -- so a due date that
  // failed to save looked identical to one that was never read: the handwriting
  // got erased by the redraw and the date silently vanished.
  const warnings: string[] = [];
  const duesSet: string[] = [];
  const newlyCreated = new Set<number>();
  for (const box of boxes) {
    try {
      const due = dues.get(box.entryIndex) ?? null; // create with its DUE cell, if any
      const {id, title} = await createReminder(config, box.text, due);
      const entry = entries[box.entryIndex];
      if (entry && entry.kind === 'blank') {
        entry.kind = 'synced';
        entry.captured = true;
        entry.reminderId = id;
        entry.title = title;
      }
      newlyCreated.add(box.entryIndex);
      created.push(title);
    } catch (err: any) {
      console.log('[Ink2Task] create failed for', JSON.stringify(box.text), err?.message);
      warnings.push(`Couldn't add "${box.text}": ${err?.message || 'unknown error'}`);
    }
  }

  // A date written into an already-synced row's DUE box sets that task's due.
  for (const [idx, due] of dues) {
    if (newlyCreated.has(idx)) continue; // its due went in at create time
    const entry = entries[idx];
    if (!entry || entry.kind !== 'synced' || !entry.reminderId) continue;
    try {
      await updateReminderDue(config, entry.reminderId, due);
      duesSet.push(`"${entry.title || '(task)'}" → ${due}`);
    } catch (err: any) {
      console.log('[Ink2Task] set-due failed for', due, err?.message);
      warnings.push(`Couldn't set due ${due}: ${err?.message || 'unknown error'}`);
    }
  }

  await saveRegistryEntries(key, entries);
  return {created, duesSet, warnings};
}

/**
 * Scans each row's DUE box for handwriting (or a native text box), OCRs it, and
 * parses it into an ISO "YYYY-MM-DD". Returns a map of entry index -> ISO date
 * for every box that held a recognizable date. Read-only.
 */
export async function captureDueDates(
  entries: ChecklistEntry[],
  scan: MainLayerScan,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const rows = entries.map((e, i) => ({e, i})).filter(x => !!x.e.dueRect);
  if (rows.length === 0) return out;
  const {centers, texts, pageSize} = scan;
  for (const {e, i} of rows) {
    const r = e.dueRect!;
    // Pad the detection region: a handwritten date easily overshoots the narrow
    // DUE box, so a tight rect can miss the strokes.
    const rect = {left: r.left - 18, top: r.top - 8, right: r.right + 18, bottom: r.bottom + 8};
    try {
      const boxes = textElementsInRect(texts, rect);
      let text = '';
      if (boxes.length > 0) {
        text = boxes.map(b => b.text).join(' ').trim();
      } else {
        const strokes = strokesInRect(centers, rect);
        if (strokes.length === 0) continue; // empty box, nothing written
        text = (
          (await unwrap<string>(
            PluginCommAPI.recognizeElements(strokes, pageSize),
            'recognizeElements',
          )) || ''
        ).trim();
      }
      if (!text) continue;
      const iso = parseDueDate(text);
      if (iso) out.set(i, iso);
    } catch (err: any) {
      console.log('[Ink2Task] due-date OCR failed:', err?.message);
    }
  }
  return out;
}

/**
 * Scans each blank row's rectangle for handwriting and OCRs it. Returns one
 * entry per box that contained recognizable text. Read-only.
 */
export async function captureBlankRows(
  entries: ChecklistEntry[],
  scan: MainLayerScan,
): Promise<CapturedBox[]> {
  const results: CapturedBox[] = [];
  const blanks = entries.filter(e => e.kind === 'blank' && e.rect);
  if (blanks.length === 0) return results;
  const {centers, texts, pageSize} = scan;
  if (centers.length === 0 && texts.length === 0) return results; // nothing written
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== 'blank' || !e.rect) continue;
    try {
      // Prefer a native text box (typed with the [T] tool): its text is exact,
      // no OCR needed. Otherwise recognize handwriting strokes.
      const boxes = textElementsInRect(texts, e.rect);
      let text = '';
      if (boxes.length > 0) {
        text = boxes.map(b => b.text).join(' ').trim();
      } else {
        const strokes = strokesInRect(centers, e.rect);
        if (strokes.length === 0) continue;
        text = (
          (await unwrap<string>(
            PluginCommAPI.recognizeElements(strokes, pageSize),
            'recognizeElements',
          )) || ''
        ).trim();
      }
      if (text) results.push({entryIndex: i, text, rect: e.rect});
    } catch (err: any) {
      console.log('[Ink2Task] capture box', i, 'failed:', err?.message);
    }
  }
  return results;
}
