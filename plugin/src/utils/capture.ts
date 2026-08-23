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
import {parseDueDate, formatDueForDialog} from './dateParse';
import {parseSubtaskPrefix, findParent} from './taskText';
import {MANTA_WIDTH, MANTA_HEIGHT} from './deviceSize';
import type {ChecklistEntry, Ink2TaskConfig} from './config';

type Rect = {left: number; top: number; right: number; bottom: number};

const PLUGIN_TEXT = /^(UPDATED:|GOOGLE TASKS|APPLE REMINDERS|TODOIST|TICKTICK|\+\s*\d+\s*MORE)/i;

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
  /**
   * Rows from the page immediately BEFORE this one, in page order.
   *
   * Only used to resolve a handwritten ">" written on the first row of a
   * continuation page: its parent is the last task of the previous page, which
   * this page's own registry knows nothing about. Without it, a subtask written
   * at the top of page 2 falls back to a normal task plus a warning.
   */
  precedingEntries: ChecklistEntry[] = [],
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
  const unreadable = takeCaptureFailures();
  // Dates handwritten in the DUE column, per row (both new tasks and existing
  // synced rows that had no due yet), already parsed to ISO "YYYY-MM-DD".
  const dues = await captureDueDates(entries, s);
  // Diagnostic: capture failing silently is very hard to tell apart from "you
  // wrote outside a box" after the fact, because the redraw erases the ink
  // either way. One line per pass, so the sync is still readable in logcat.
  const blankRows = entries.filter(e => e.kind === 'blank' && !!e.rect).length;
  console.log(
    `[Ink2Task] capture p${page}: ${blankRows} blank row(s), ` +
      `${boxes.length} with ink, ${dues.size} due box(es)` +
      (boxes.length ? ` -> ${JSON.stringify(boxes.map(b => b.text))}` : ''),
  );
  if (boxes.length === 0 && dues.size === 0) {
    return {
      created: [],
      duesSet: [],
      warnings:
        unreadable > 0
          ? [
              `Couldn't read the handwriting in ${unreadable} box(es), so nothing was added. Try writing it again.`,
            ]
          : [],
    };
  }

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
  if (unreadable > 0) {
    warnings.push(
      unreadable === 1
        ? "Couldn't read the handwriting in 1 box, so no task was added. Try writing it again."
        : `Couldn't read the handwriting in ${unreadable} boxes, so no tasks were added from them. Try writing them again.`,
    );
  }
  const duesSet: string[] = [];
  const newlyCreated = new Set<number>();
  for (const box of boxes) {
    try {
      const due = dues.get(box.entryIndex) ?? null; // create with its DUE cell, if any
      // A handwritten ">" (or ">>") makes this a subtask of the nearest row
      // above it that sits one level shallower -- the same marker the page
      // draws for existing subtasks, so what you read is what you write.
      const {depth, rest} = parseSubtaskPrefix(box.text);
      // ANY number of chevrons means the same thing: make this a subtask of the
      // task above. The count on the page numbers siblings (see subtaskMarker),
      // and you cannot ask to be the 2nd child of something, so ">>" written by
      // hand must not be read as "nest me two levels deep".
      const parent =
        depth > 0
          ? findParent(
              [...precedingEntries, ...entries],
              precedingEntries.length + box.entryIndex,
              1,
            )
          : undefined;
      // Marker written but no parent found above: create it as a normal task
      // rather than dropping it. The alternative is silent data loss, since the
      // redraw erases the handwriting either way.
      if (depth > 0 && !parent) {
        warnings.push(
          `"${rest}" was written as a subtask but has no task above it to attach to, so it was added as a normal task.`,
        );
      }
      const text = depth > 0 ? rest : box.text;
      console.log(
        `[Ink2Task] create p${page} row${box.entryIndex}: ${JSON.stringify(text)}` +
          ` depth=${depth} parent=${parent ? parent.id : 'none'}`,
      );
      const {id, title} = await createReminder(config, text, due, parent?.id);
      console.log(`[Ink2Task] created ${id} ${JSON.stringify(title)}`);
      const entry = entries[box.entryIndex];
      if (entry && entry.kind === 'blank') {
        entry.kind = 'synced';
        entry.captured = true;
        entry.reminderId = id;
        entry.title = title;
        // Record the depth now so a ">>" written on the row BELOW this one, in
        // this same capture pass, can find this row as its parent.
        if (parent) entry.depth = parent.depth;
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
      duesSet.push(`"${entry.title || '(task)'}" → ${formatDueForDialog(due)}`);
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
    // Pad the detection region for overshoot, but NOT to the left: the DUE box
    // now sits just a few px right of the column divider, so a left pad would
    // reach back into the task column and could read the tail of a long
    // handwritten task as the date. Right and vertical overshoot is safe --
    // there's only the page margin and the ruled lines out there.
    const rect = {left: r.left, top: r.top - 8, right: r.right + 18, bottom: r.bottom + 8};
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
  const failures: number[] = [];
  const blanks = entries.filter(e => e.kind === 'blank' && e.rect);
  if (blanks.length === 0) return results;
  const {centers, texts, pageSize} = scan;
  if (centers.length === 0 && texts.length === 0) return results; // nothing written
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== 'blank' || !e.rect) continue;
    // Pad for overshoot, the same way captureDueDates does. Without this the
    // LAST row was unreadable: on any other row, ink that drifts below the box
    // still lands in the next row's rect, but under the last row there is only
    // dead space, so those strokes were dropped and the recognizer got a
    // FRAGMENT of the word -- which fails with 117 "Recognition failed"
    // (device 2026-08-22, reproduced on two consecutive syncs).
    //
    // Vertical and right padding only. A left pad would reach the checkbox and
    // could swallow a tick that overshot its box.
    const rect = {
      left: e.rect.left,
      top: e.rect.top - 10,
      bottom: e.rect.bottom + 10,
      right: e.rect.right + 12,
    };
    try {
      // Prefer a native text box (typed with the [T] tool): its text is exact,
      // no OCR needed. Otherwise recognize handwriting strokes.
      const boxes = textElementsInRect(texts, rect);
      let text = '';
      if (boxes.length > 0) {
        text = boxes.map(b => b.text).join(' ').trim();
      } else {
        const strokes = strokesInRect(centers, rect);
        if (strokes.length === 0) continue;
        // Log the rect and where the matched ink actually sits. This separates
        // the two remaining explanations for a 117 that survives a retry AND a
        // split: either the ink itself is unreadable, or this rect is wrong and
        // is sweeping up strokes from elsewhere on the page.
        const hit = centers.filter(
          c => c.cx >= rect.left && c.cx <= rect.right && c.cy >= rect.top && c.cy <= rect.bottom,
        );
        const xs = hit.map(c => Math.round(c.cx));
        const ys = hit.map(c => Math.round(c.cy));
        console.log(
          `[Ink2Task] box ${i} rect=${rect.left},${rect.top},${rect.right},${rect.bottom} ` +
            `strokes=${strokes.length} x=${Math.min(...xs)}..${Math.max(...xs)} ` +
            `y=${Math.min(...ys)}..${Math.max(...ys)}`,
        );
        text = (await recognizeResilient(strokes, pageSize, i)).trim();
      }
      if (text && !PLUGIN_TEXT.test(text)) results.push({entryIndex: i, text, rect: e.rect});
    } catch (err: any) {
      console.log('[Ink2Task] capture box', i, 'failed:', err?.message);
      // NEVER silent: the redraw is about to erase this handwriting, so if it
      // could not be read the user has to be told, or the task simply vanishes.
      failures.push(i);
    }
  }
  if (failures.length > 0) {
    console.log('[Ink2Task] unreadable box(es):', JSON.stringify(failures));
  }
  captureFailures = failures.length;
  return results;
}

/**
 * How many boxes had ink that could not be recognised on the last
 * captureBlankRows call. Module-level rather than a return value so the
 * signature stays as-is for the other callers.
 */
let captureFailures = 0;
export function takeCaptureFailures(): number {
  const n = captureFailures;
  captureFailures = 0;
  return n;
}

/**
 * recognizeElements, but resilient to a batch the recogniser refuses.
 *
 * Error 117 ("Recognition failed. Please try again!") turned out to be
 * DETERMINISTIC on a real 11-stroke word: retrying failed identically, the
 * stroke data was sane (all type 0 / layer 0, correct pageSize, sensible EMR
 * bounds), and widening the detection rect changed nothing. So the recogniser
 * rejects certain whole batches rather than any individual stroke being bad.
 *
 * Splitting the batch and recognising each half recovers the text in that case,
 * which is far better than erasing the user's handwriting and adding nothing.
 * Halving (rather than going straight to single strokes) keeps letters grouped,
 * so the recogniser still sees enough context to read words rather than
 * guessing at isolated pen marks.
 *
 * Returns '' when even single strokes fail, and the caller reports that as
 * unreadable rather than silently dropping it.
 */
/**
 * The other page size this firmware recognises, or undefined if the size is not
 * one we know. Both are listed in the SDK's own page-size table: A5X/Nomad use
 * 1404x1872 and Manta uses 1920x2560.
 */
function alternatePageSize(size: any): {width: number; height: number} | undefined {
  const w = size?.width;
  const h = size?.height;
  // Only ever go LARGER. The point is to move low strokes further from the
  // bottom edge, so declaring a SMALLER canvas is worse than useless -- on a
  // Manta page (1920x2560) it would put ink at y~2400 outside a 1872-tall
  // canvas entirely. Manta is already the largest size the firmware knows, so
  // there is no fallback there and the retry is skipped.
  if (w === 1404 && h === 1872) return {width: MANTA_WIDTH, height: MANTA_HEIGHT};
  return undefined;
}

async function recognizeResilient(
  strokes: any[],
  pageSize: unknown,
  boxIndex: number,
  depth = 0,
): Promise<string> {
  try {
    return (
      (await unwrap<string>(
        PluginCommAPI.recognizeElements(strokes as any, pageSize as any),
        'recognizeElements',
      )) || ''
    );
  } catch (err: any) {
    if (depth === 0) {
      console.log(
        `[Ink2Task] recognize box ${boxIndex}: ${strokes.length} stroke(s) rejected ` +
          `(${err?.message}); retrying on a taller canvas`,
      );
      // POSITIONAL failure, isolated on device 2026-08-22: identical ink in a
      // middle row reads fine (y 766..838 -> "TOP of list") while the LAST row
      // fails every time (y 1694..1727), with 4, 8, 11 and 14 strokes alike. So
      // the recogniser rejects strokes near the bottom of the declared canvas.
      //
      // Declaring the OTHER supported page size (Manta's 1920x2560) leaves the
      // stroke coordinates untouched but moves them from 92% down the canvas to
      // about 67%, which is well inside. Only the two sizes the firmware knows
      // are ever passed -- an unsupported size fails with "unknown pageSize"
      // (see the recognizeElements note in [[ink2task-sdk-gotchas]]).
      const alt = alternatePageSize(pageSize);
      if (alt) {
        try {
          const out =
            (await unwrap<string>(
              PluginCommAPI.recognizeElements(strokes as any, alt as any),
              'recognizeElements',
            )) || '';
          if (out.trim()) {
            console.log(
              `[Ink2Task] recognize box ${boxIndex} read on taller canvas: ${JSON.stringify(out)}`,
            );
            return out;
          }
        } catch (e: any) {
          console.log(`[Ink2Task] taller canvas also failed: ${e?.message}`);
        }
      }
    }
    // A single stroke that will not recognise has nothing left to split.
    if (strokes.length < 2 || depth > 4) return '';
    const mid = Math.ceil(strokes.length / 2);
    const [a, b] = await Promise.all([
      recognizeResilient(strokes.slice(0, mid), pageSize, boxIndex, depth + 1),
      recognizeResilient(strokes.slice(mid), pageSize, boxIndex, depth + 1),
    ]);
    const joined = `${a}${b}`.trim();
    if (depth === 0) {
      console.log(
        `[Ink2Task] recognize box ${boxIndex} recovered by splitting: ${JSON.stringify(joined)}`,
      );
    }
    return joined;
  }
}
