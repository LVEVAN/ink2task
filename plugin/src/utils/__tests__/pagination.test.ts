import {planPages, footerFor, pagesToReclaim, pageBudget, MAX_PAGES} from '../pagination';

const ROWS = 14;

/** n plain top-level tasks. */
const flat = (n: number) => Array.from({length: n}, (_, i) => ({id: `t${i}`}));
const noDepths = new Map<string, number>();

describe('footerFor', () => {
  it('says nothing for a single page that fits', () => {
    expect(footerFor(0, 1, 0)).toBe('');
  });

  it('reports overflow on a lone page, as it always did', () => {
    expect(footerFor(0, 1, 6)).toBe('+ 6 MORE NOT SHOWN');
  });

  it('points forward on a non-last page and labels it', () => {
    expect(footerFor(0, 3, 0)).toBe('CONTINUED ON PAGE 2  -  PAGE 1 OF 3');
    expect(footerFor(1, 3, 0)).toBe('CONTINUED ON PAGE 3  -  PAGE 2 OF 3');
  });

  it('labels the last page and reports anything still hidden', () => {
    expect(footerFor(2, 3, 0)).toBe('PAGE 3 OF 3');
    expect(footerFor(2, 3, 5)).toBe('+ 5 MORE NOT SHOWN  -  PAGE 3 OF 3');
  });

  it('never prints PAGE 1 OF 1', () => {
    expect(footerFor(0, 1, 0)).not.toContain('OF 1');
    expect(footerFor(0, 1, 3)).not.toContain('OF 1');
  });
});

describe('planPages', () => {
  it('uses one page and no footer when everything fits', () => {
    const p = planPages(flat(10), noDepths, {rowsPerPage: ROWS, usablePages: 3});
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0].tasks).toHaveLength(10);
    expect(p.pages[0].footer).toBe('');
    expect(p.overflow).toBe(0);
    expect(p.pagesNeeded).toBe(1);
  });

  it('keeps a row to write in, hiding one task when no other page is allowed', () => {
    const p = planPages(flat(ROWS), noDepths, {rowsPerPage: ROWS, usablePages: 1});
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0].tasks).toHaveLength(ROWS - 1);
    expect(p.pages[0].footer).toBe('+ 1 MORE NOT SHOWN');
    // A second page WOULD help, so say so.
    expect(p.pagesNeeded).toBe(2);
  });

  it('spills onto a second page and points at it', () => {
    const p = planPages(flat(20), noDepths, {rowsPerPage: ROWS, usablePages: 3});
    expect(p.pages).toHaveLength(2);
    // Every page keeps its last row free to write in, so 13 per page, not 14.
    expect(p.pages[0].tasks).toHaveLength(ROWS - 1);
    expect(p.pages[1].tasks).toHaveLength(20 - (ROWS - 1));
    expect(p.pages[0].footer).toBe('CONTINUED ON PAGE 2  -  PAGE 1 OF 2');
    expect(p.pages[1].footer).toBe('PAGE 2 OF 2');
    expect(p.overflow).toBe(0);
  });

  it('caps at MAX_PAGES and reports the rest as overflow', () => {
    const p = planPages(flat(60), noDepths, {rowsPerPage: ROWS, usablePages: 9});
    expect(p.pages).toHaveLength(MAX_PAGES);
    // (ROWS - 1) per page, since every page reserves a write row.
    expect(p.overflow).toBe(60 - (ROWS - 1) * MAX_PAGES);
    expect(p.pages[MAX_PAGES - 1].footer).toBe('+ 21 MORE NOT SHOWN  -  PAGE 3 OF 3');
  });

  it('respects usablePages, and pagesNeeded still shows what would help', () => {
    // 20 tasks but only one page available: behaves exactly like the old build.
    const p = planPages(flat(20), noDepths, {rowsPerPage: ROWS, usablePages: 1});
    expect(p.pages).toHaveLength(1);
    // 20 - (ROWS - 1 drawn) = 7, the extra one being the reserved write row.
    expect(p.overflow).toBe(7);
    expect(p.pages[0].footer).toBe('+ 7 MORE NOT SHOWN');
    // ...but the caller can see more pages would fix it.
    expect(p.pagesNeeded).toBe(2);
  });

  it('keeps a parent and its subtasks together when they fit', () => {
    // 10 fillers leaves 3 rows, exactly enough for the block.
    const tasks = [...flat(10), {id: 'p'}, {id: 'c1'}, {id: 'c2'}];
    const depths = new Map([['c1', 1], ['c2', 1]]);
    const p = planPages(tasks, depths, {rowsPerPage: ROWS, usablePages: 3});
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0].tasks.map(t => t.id).slice(-3)).toEqual(['p', 'c1', 'c2']);
  });

  it('splits a block across the break rather than leaving rows empty', () => {
    // 11 fillers leaves 2 rows and the block needs 4. This is the case from the
    // 2026-08-23 device report: moving the block whole left page 1 with 11 of 13
    // rows used. Rows are too scarce to waste -- MAX_PAGES caps the list, so an
    // empty row costs a real task its place. NOTE: these two tests previously
    // used flat(13), which fills the page exactly, so neither of them actually
    // exercised a straddling block and both passed either way.
    const tasks = [...flat(11), {id: 'p'}, {id: 'c1'}, {id: 'c2'}, {id: 'c3'}];
    const depths = new Map([['c1', 1], ['c2', 1], ['c3', 1]]);
    const p = planPages(tasks, depths, {rowsPerPage: ROWS, usablePages: 3});
    expect(p.pages[0].tasks).toHaveLength(13);
    expect(p.pages[0].tasks.map(t => t.id).slice(-2)).toEqual(['p', 'c1']);
    expect(p.pages[1].tasks.map(t => t.id)).toEqual(['c2', 'c3']);
  });

  it('fills every usable row on every page it continues past', () => {
    const p = planPages(flat(40), noDepths, {rowsPerPage: ROWS, usablePages: 3});
    // Only the last page may be short.
    for (const page of p.pages.slice(0, -1)) {
      expect(page.tasks).toHaveLength(ROWS - 1);
    }
  });

  it('splits a block that is taller than a whole page, rather than dropping it', () => {
    // A parent with 20 children cannot be kept whole on a 14-row page.
    const tasks = [{id: 'p'}, ...Array.from({length: 20}, (_, i) => ({id: `c${i}`}))];
    const depths = new Map(tasks.slice(1).map(t => [t.id, 1] as [string, number]));
    const p = planPages(tasks, depths, {rowsPerPage: ROWS, usablePages: 3});
    const drawn = p.pages.flatMap(pg => pg.tasks).length;
    expect(drawn).toBe(21);
    expect(p.overflow).toBe(0);
  });

  it('never loses a task: drawn plus overflow always equals the input', () => {
    for (const n of [0, 1, 13, 14, 15, 28, 29, 42, 43, 100]) {
      for (const usable of [1, 2, 3]) {
        const p = planPages(flat(n), noDepths, {rowsPerPage: ROWS, usablePages: usable});
        const drawn = p.pages.reduce((a, pg) => a + pg.tasks.length, 0);
        expect(drawn + p.overflow).toBe(n);
      }
    }
  });

  it('handles an empty list', () => {
    const p = planPages([], noDepths, {rowsPerPage: ROWS, usablePages: 3});
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0].tasks).toEqual([]);
    expect(p.pages[0].footer).toBe('');
  });

  it('clamps nonsense inputs instead of misbehaving', () => {
    expect(planPages(flat(5), noDepths, {rowsPerPage: 0, usablePages: 0}).pages.length).toBeGreaterThan(0);
    expect(planPages(flat(5), noDepths, {rowsPerPage: ROWS, usablePages: 99}).pages).toHaveLength(1);
  });
});

describe('pagesToReclaim', () => {
  const base = {
    anchorPage: 0,
    pagesUsed: 1,
    templatedPages: 3,
    inkByPage: new Map([[1, 0], [2, 0]]),
    boundPages: new Set<number>(),
  };

  it('reclaims unused templated pages, highest first', () => {
    // Deleting shifts later indices, so the order matters.
    expect(pagesToReclaim(base)).toEqual([2, 1]);
  });

  it('keeps pages the list still needs', () => {
    expect(pagesToReclaim({...base, pagesUsed: 2})).toEqual([2]);
    expect(pagesToReclaim({...base, pagesUsed: 3})).toEqual([]);
  });

  it('never touches the anchor page', () => {
    expect(pagesToReclaim({...base, templatedPages: 1})).toEqual([]);
    // Even when the anchor is not page 0.
    const r = pagesToReclaim({
      ...base,
      anchorPage: 2,
      templatedPages: 3,
      inkByPage: new Map([[2, 0]]),
    });
    expect(r).toEqual([]);
  });

  it('keeps a page that still has ink on it', () => {
    // Capture runs first, so leftover strokes are something it could not read.
    const r = pagesToReclaim({...base, inkByPage: new Map([[1, 0], [2, 4]])});
    expect(r).toEqual([1]);
  });

  it('keeps a page whose ink is unknown', () => {
    // Absent from the map means we never scanned it. Never guess.
    expect(pagesToReclaim({...base, inkByPage: new Map([[1, 0]])})).toEqual([1]);
  });

  it('keeps a page bound to another list', () => {
    const r = pagesToReclaim({...base, boundPages: new Set([2])});
    expect(r).toEqual([1]);
  });

  it('never reclaims a page the user added themselves', () => {
    // 5 real pages but only 2 are ours: pages 2..4 are the user's.
    const r = pagesToReclaim({
      ...base,
      templatedPages: 2,
      inkByPage: new Map([[1, 0], [2, 0], [3, 0], [4, 0]]),
    });
    expect(r).toEqual([1]);
  });

  it('reclaims nothing when there is nothing spare', () => {
    expect(pagesToReclaim({...base, templatedPages: 1, pagesUsed: 1})).toEqual([]);
  });
});

describe('pageBudget', () => {
  const S = (...n: number[]) => new Set(n);

  it('uses every existing free page up to the cap', () => {
    expect(pageBudget({anchorPage: 0, existingPages: 3, boundPages: S()}))
      .toEqual({usablePages: 3, canGrow: false, blockedByBinding: false});
  });

  it('can grow when the run ends at the last page', () => {
    expect(pageBudget({anchorPage: 0, existingPages: 1, boundPages: S()}))
      .toEqual({usablePages: 1, canGrow: true, blockedByBinding: false});
  });

  it('REGRESSION: refuses to grow when the next page is bound to another list', () => {
    // The device bug: page 1 bound to Errands, so only 1 page usable -- and the
    // old code appended a page at the end of the note on EVERY sync forever.
    expect(pageBudget({anchorPage: 0, existingPages: 8, boundPages: S(1, 2)}))
      .toEqual({usablePages: 1, canGrow: false, blockedByBinding: true});
  });

  it('REGRESSION: refuses to grow mid-note, where inserting would renumber pages', () => {
    // Run at pages 0..0 but the note has 8 pages: appending lands at index 8,
    // which can never extend this run.
    expect(pageBudget({anchorPage: 0, existingPages: 8, boundPages: S(1)}).canGrow).toBe(false);
    // Same anchor, nothing bound: pages 1 and 2 already exist, so it uses them
    // rather than creating anything.
    expect(pageBudget({anchorPage: 0, existingPages: 8, boundPages: S()}))
      .toEqual({usablePages: 3, canGrow: false, blockedByBinding: false});
  });

  it('grows from a mid-note anchor only when that anchor is the last page', () => {
    expect(pageBudget({anchorPage: 5, existingPages: 6, boundPages: S()}))
      .toEqual({usablePages: 1, canGrow: true, blockedByBinding: false});
    expect(pageBudget({anchorPage: 5, existingPages: 9, boundPages: S()}).canGrow).toBe(false);
  });

  it('never exceeds MAX_PAGES', () => {
    const r = pageBudget({anchorPage: 0, existingPages: 99, boundPages: S()});
    expect(r.usablePages).toBe(MAX_PAGES);
    expect(r.canGrow).toBe(false);
  });

  it('does not grow when the page count could not be read', () => {
    // existingPages 0 means the read failed. Guessing here is how pages multiply.
    expect(pageBudget({anchorPage: 0, existingPages: 0, boundPages: S()}))
      .toEqual({usablePages: 1, canGrow: false, blockedByBinding: false});
  });
});

describe('reserved write row', () => {
  it('gives back the last row when the page fills to the bottom', () => {
    // Exactly 14 tasks used to fill every row, leaving nowhere to handwrite.
    const p = planPages(flat(ROWS), noDepths, {rowsPerPage: ROWS, usablePages: 1});
    expect(p.pages[0].tasks).toHaveLength(ROWS - 1);
    expect(p.overflow).toBe(1);
    expect(p.pages[0].footer).toBe('+ 1 MORE NOT SHOWN');
  });

  it('costs nothing when the list is short', () => {
    const p = planPages(flat(5), noDepths, {rowsPerPage: ROWS, usablePages: 1});
    expect(p.pages[0].tasks).toHaveLength(5);
    expect(p.overflow).toBe(0);
    expect(p.pages[0].footer).toBe('');
  });

  it('reserves a write row on EVERY page, not just the last', () => {
    // Reserving only on the last page meant a three-page run had no writable
    // row until you paged to the end (device 2026-08-22).
    const p = planPages(flat(28), noDepths, {rowsPerPage: ROWS, usablePages: 2});
    expect(p.pages[0].tasks).toHaveLength(ROWS - 1);
    expect(p.pages[1].tasks).toHaveLength(ROWS - 1);
    expect(p.overflow).toBe(28 - 2 * (ROWS - 1));
  });

  it('still loses no tasks: drawn plus overflow equals the input', () => {
    for (const n of [1, 13, 14, 15, 28, 42, 43]) {
      for (const usable of [1, 2, 3]) {
        const p = planPages(flat(n), noDepths, {rowsPerPage: ROWS, usablePages: usable});
        const drawn = p.pages.reduce((a, pg) => a + pg.tasks.length, 0);
        expect(drawn + p.overflow).toBe(n);
      }
    }
  });

  it('never empties a page to reserve a row', () => {
    const p = planPages(flat(3), noDepths, {rowsPerPage: 1, usablePages: 1});
    expect(p.pages[0].tasks).toHaveLength(1);
  });

  it('can be turned off', () => {
    const p = planPages(flat(ROWS), noDepths, {
      rowsPerPage: ROWS, usablePages: 1, reserveWriteRow: false,
    });
    expect(p.pages[0].tasks).toHaveLength(ROWS);
    expect(p.overflow).toBe(0);
  });
});

describe('reserved row cooperates with continuation', () => {
  it('asks for another page when reserving is what caused the overflow', () => {
    // 14 tasks fit a 14-row page exactly. Reserving the write row displaces one,
    // so a second page is genuinely useful and pagesNeeded must report it --
    // otherwise the displaced task is hidden while continuation is switched on.
    const p = planPages(flat(ROWS), noDepths, {rowsPerPage: ROWS, usablePages: 1});
    expect(p.overflow).toBe(1);
    expect(p.pagesNeeded).toBe(2);
  });

  it('moves the displaced task onto the next page when one is available', () => {
    // The write row stays on page 1, where the user is looking, and the task it
    // displaced continues onto page 2 instead of being hidden.
    const p = planPages(flat(ROWS), noDepths, {rowsPerPage: ROWS, usablePages: 2});
    expect(p.pages).toHaveLength(2);
    expect(p.pages[0].tasks).toHaveLength(ROWS - 1);
    expect(p.pages[1].tasks).toHaveLength(1);
    expect(p.overflow).toBe(0);
  });

  it('does not inflate pagesNeeded when nothing overflowed', () => {
    expect(planPages(flat(5), noDepths, {rowsPerPage: ROWS, usablePages: 1}).pagesNeeded).toBe(1);
  });

  it('never asks for more than MAX_PAGES', () => {
    const p = planPages(flat(ROWS * MAX_PAGES), noDepths, {rowsPerPage: ROWS, usablePages: MAX_PAGES});
    expect(p.pagesNeeded).toBe(MAX_PAGES);
  });
});
