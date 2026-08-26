/**
 * Spreading a task list across up to MAX_PAGES continuation pages.
 *
 * No imports on purpose (same reason as ./taskText and ../api/serverFeatures):
 * checklistPage.ts pulls in sn-plugin-lib, which Jest cannot transform, so the
 * decision logic lives here where it can be tested.
 */

/**
 * Hard ceiling on pages one list may occupy.
 *
 * Raised 3 -> 5 on 2026-08-24, once the per-page cost stopped being paid on
 * every sync. Each page still costs a full page read and an OCR capture pass,
 * but a page whose content has not changed no longer gets repainted at all --
 * only its timestamp is rewritten in place (see utils/pageSignature.ts and
 * refreshTimestampOnly). The repaint was the expensive part and the visible
 * one, since each is a full-screen e-ink refresh, so five pages now costs
 * roughly what three did before.
 *
 * Reading is still linear in page count, so this is not free and should not
 * keep climbing without another look at where the time goes.
 */
export const MAX_PAGES = 5;

export type PlannedPage<T> = {
  /** 0 = the page the user synced from, 1 = the next page, and so on. */
  offset: number;
  tasks: T[];
  /** Text for the bottom-margin footer. Empty means draw nothing. */
  footer: string;
};

export type PagePlan<T> = {
  pages: PlannedPage<T>[];
  /** Tasks that fit on no page at all and are only reported as a count. */
  overflow: number;
  /**
   * Pages this list WANTS, capped at MAX_PAGES and independent of how many are
   * actually available. Compare against usablePages to decide whether to offer
   * to add one.
   */
  pagesNeeded: number;
};

/**
 * Groups a display-ordered list into blocks of a parent plus its descendants.
 *
 * Kept for grouping only. Blocks are NO LONGER moved whole to the next page --
 * see pack() for why.
 */
function blocksOf<T extends {id: string}>(
  tasks: T[],
  depths: Map<string, number>,
): T[][] {
  const blocks: T[][] = [];
  for (const task of tasks) {
    const depth = depths.get(task.id) ?? 0;
    if (depth === 0 || blocks.length === 0) blocks.push([task]);
    else blocks[blocks.length - 1].push(task);
  }
  return blocks;
}

/**
 * Packs tasks into pages, returning the per-page task lists.
 *
 * FILLS EVERY ROW. A block that does not fit in what is left of a page is
 * split across the break rather than moved whole to the next page.
 *
 * It used to move whole, to avoid a page opening with a bare ">" row whose
 * parent is on the previous page. That cost more than it was worth. Moving a
 * 4-task block out of 2 remaining rows leaves those 2 rows empty, and empty
 * rows are expensive here: the list is capped at MAX_PAGES, so every wasted row
 * pushes a real task off the end into the "+N more" count where the user cannot
 * see or check it at all. Device-reported 2026-08-23 -- page 1 drew 11 tasks on
 * a 14-row page and the user read it, correctly, as miscounting.
 *
 * Splitting is survivable in a way that a dropped task is not: the child still
 * carries its ">" marker, and captureAndCreate already resolves a ">" in the
 * first row of a page against the previous page's entries (precedingEntries),
 * so a parent at the bottom of page 1 still adopts a child written at the top
 * of page 2.
 */
function pack<T extends {id: string}>(
  blocks: T[][],
  rowsPerPage: number,
  pageLimit: number,
): {pages: T[][]; leftover: number} {
  const pages: T[][] = [];
  let current: T[] = [];
  let placed = 0;

  const flush = () => {
    if (current.length > 0) pages.push(current);
    current = [];
  };

  // Blocks only order the tasks now; the fill is flat and never leaves a gap.
  outer: for (const block of blocks) {
    for (const task of block) {
      if (current.length === rowsPerPage) {
        flush();
        if (pages.length >= pageLimit) break outer;
      }
      current.push(task);
      placed++;
    }
  }
  flush();

  const total = blocks.reduce((n, b) => n + b.length, 0);
  return {pages: pages.slice(0, pageLimit), leftover: total - placed};
}

/**
 * Builds the footer line for one page.
 *
 * Kept together in one place so the four cases stay consistent: a middle page
 * points forward, the last page reports what still didn't fit, a lone page
 * behaves exactly as it did before this feature existed, and a page label is
 * only shown once there is more than one page (a "PAGE 1 OF 1" on every
 * single-page list would be pure noise).
 */
/**
 * The label a continuation page leads with, and the reason it is worded this
 * way rather than "BACK TO PAGE 1".
 *
 * The list's first page is NOT necessarily page 1 of the note -- the anchor is
 * wherever the user started the checklist, which can be page 5 of a notebook
 * full of other things. The footer's own "PAGE 2 OF 3" counts pages of the
 * LIST, so a note-page number here would be a third numbering in the same
 * line. "TOP OF LIST" sidesteps all of it and says what tapping actually does.
 */
export const BACK_TO_TOP = 'TOP OF LIST';

export function footerFor(
  offset: number,
  totalPages: number,
  overflow: number,
): string {
  const parts: string[] = [];
  const isLast = offset === totalPages - 1;
  // Continuation pages lead with the way back, because that is the tappable
  // part (see ChecklistStyle.footerLinkTo) and it should be the first thing
  // read. The anchor page gets nothing: it IS the top of the list.
  if (offset > 0) parts.push(BACK_TO_TOP);
  // No "CONTINUED ON PAGE N". Dropped 2026-08-24: "PAGE 1 OF 3" already says
  // there is more and where you are in it, so the two together were saying the
  // same thing twice in a line with no room to spare.
  if (isLast && overflow > 0) parts.push(`+ ${overflow} MORE NOT SHOWN`);
  if (totalPages > 1) parts.push(`PAGE ${offset + 1} OF ${totalPages}`);
  // ASCII separator on purpose. A nicer glyph risks rendering as a tofu box on
  // device, which is exactly what happened to the first subtask marker.
  return parts.join('  -  ');
}

/**
 * Decides which tasks go on which page.
 *
 * `usablePages` is how many pages may actually be drawn on right now (pages
 * that exist and are not bound to some other list). `pagesNeeded` comes back
 * computed against MAX_PAGES instead, so the caller can tell the difference
 * between "everything fits" and "one more page would help".
 */
/**
 * Rows a page may fill with tasks, given the reserved write row.
 *
 * ALWAYS KEEP ONE BLANK ROW ON EVERY PAGE: a page filled to the bottom leaves
 * nowhere to handwrite a new task, and lasso capture becomes the only way to add
 * one. Reserving on the LAST page alone was not enough -- on a three-page run the
 * first two pages filled completely, so writing a task meant paging to the end
 * (device 2026-08-22, "capture p3: 0 blank row(s)").
 *
 * Simply lowering the per-page capacity does the whole job: a short list already
 * has blank rows and is unaffected, and nothing has to be popped or moved.
 */
function usableRows(rowsPerPage: number, reserve: boolean): number {
  return reserve ? Math.max(1, rowsPerPage - 1) : rowsPerPage;
}

export function planPages<T extends {id: string}>(
  tasks: T[],
  depths: Map<string, number>,
  opts: {rowsPerPage: number; usablePages: number; reserveWriteRow?: boolean},
): PagePlan<T> {
  const reserve = opts.reserveWriteRow !== false;
  const rows = usableRows(Math.max(1, opts.rowsPerPage), reserve);
  const usable = Math.max(1, Math.min(opts.usablePages, MAX_PAGES));
  const blocks = blocksOf(tasks, depths);

  // What it would take if every allowed page were available, so the caller can
  // offer to add one. Same row budget, or the two would disagree.
  const pagesNeeded = pack(blocks, rows, MAX_PAGES).pages.length;

  const {pages: packed, leftover} = pack(blocks, rows, usable);
  const totalPages = Math.max(1, packed.length);
  const pages: PlannedPage<T>[] = [];
  for (let i = 0; i < totalPages; i++) {
    pages.push({
      offset: i,
      tasks: packed[i] ?? [],
      footer: footerFor(i, totalPages, i === totalPages - 1 ? leftover : 0),
    });
  }
  return {pages, overflow: leftover, pagesNeeded: Math.max(pagesNeeded, 1)};
}

/**
 * Which continuation pages should be removed because the list shrank.
 *
 * Reclaiming pages is destructive, so every condition here is a veto and the
 * defaults are all "keep":
 *
 *  - Never the anchor page. It holds the baked template and is the note's
 *    reason for existing.
 *  - Only pages THIS PLUGIN created (`templatedPages`). A page the user added
 *    themselves is theirs, even if it currently happens to sit past the list.
 *  - Only pages past what the list now needs.
 *  - Only pages with NO ink on them. Capture runs before this, so anything
 *    handwritten has already become a task; a page that still has strokes had
 *    something capture could not read, and deleting it would destroy it.
 *  - Never a page bound to another list, which is somebody else's page.
 *
 * Returned HIGHEST FIRST: removing a page shifts every index after it, so
 * deleting from the end keeps the remaining targets valid.
 */
export function pagesToReclaim(opts: {
  /** The page the user synced from. */
  anchorPage: number;
  /** How many pages the list actually needs now (>= 1). */
  pagesUsed: number;
  /** Count of leading pages carrying our template (see config.templatedPages). */
  templatedPages: number;
  /** Stroke count per absolute page index. A page absent here is treated as unknown, so kept. */
  inkByPage: Map<number, number>;
  /** Absolute page indices bound to some other list. */
  boundPages: Set<number>;
}): number[] {
  const {anchorPage, pagesUsed, templatedPages, inkByPage, boundPages} = opts;
  const out: number[] = [];
  // Highest templated page index, then walk back toward the first page we could
  // legally drop.
  for (let p = templatedPages - 1; p > anchorPage; p--) {
    if (p < anchorPage + pagesUsed) break; // still in use, and so is everything below
    if (boundPages.has(p)) continue;
    const ink = inkByPage.get(p);
    if (ink === undefined || ink > 0) continue; // unknown or dirty: keep it
    out.push(p);
  }
  return out;
}

/**
 * How many pages a run may actually use, and whether it is allowed to grow.
 *
 * Two separate reasons a run can be short, and conflating them is what caused
 * runaway page creation on device (2026-08-22): the run wanted 3 pages, the very
 * next page was BOUND to another list, so only 1 page was usable -- and the
 * grow step then appended a page at the END of the note on every single sync,
 * where it could never help. `canGrow` exists to say "the shortfall is fixable
 * by adding a page", which is only true when:
 *
 *  - the next page is not bound to another list (inserting would displace it), and
 *  - the run currently ends at the LAST page of the note.
 *
 * That second condition matters because page indices are positional: every
 * pageBinding and registry key is `notePath#index`, so inserting a page in the
 * MIDDLE silently renumbers every page after it and repoints all of them at the
 * wrong content. Appending past the end shifts nothing.
 */
export function pageBudget(opts: {
  anchorPage: number;
  /** Total pages the note has right now, or 0 if it could not be read. */
  existingPages: number;
  /** Absolute page indices bound to some other list. */
  boundPages: Set<number>;
}): {usablePages: number; canGrow: boolean; blockedByBinding: boolean} {
  const {anchorPage, existingPages, boundPages} = opts;
  let usable = 1;
  let blockedByBinding = false;
  while (usable < MAX_PAGES) {
    const next = anchorPage + usable;
    if (boundPages.has(next)) {
      blockedByBinding = true;
      break;
    }
    if (existingPages <= 0 || next >= existingPages) break; // page does not exist
    usable++;
  }
  const nextPage = anchorPage + usable;
  const canGrow =
    usable < MAX_PAGES &&
    !boundPages.has(nextPage) &&
    existingPages > 0 &&
    nextPage >= existingPages; // run ends at the note's end, so appending is safe
  return {usablePages: usable, canGrow, blockedByBinding};
}
