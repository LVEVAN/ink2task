/**
 * Row-density presets: how many task rows a checklist page carries, and how
 * the rest of the layout scales to match.
 *
 * No imports on purpose (same reason as ./pagination and ./taskText):
 * anything that must be unit-testable cannot touch sn-plugin-lib, which Jest
 * cannot transform. checklistPage.ts and actions.ts import from here, never
 * the other way around.
 *
 * The one geometric invariant, tested in __tests__/rowDensity.test.ts: every
 * density subdivides the SAME table band (y 205..1773 on the 1404x1872
 * template design), because the band's frame lines, the column divider, and
 * everything above and below it are baked into the template background and do
 * not move. 14 rows must reproduce the v1 layout's 112px rows EXACTLY, or
 * legacy notes drift off their printed ruling.
 */

export type RowDensity = 'standard' | 'compact' | 'dense';

export const DENSITY_ROWS: Record<RowDensity, number> = {
  standard: 14,
  compact: 18,
  dense: 21,
};

/** Rows on the v1 ruled template -- the only layout its baked background fits. */
export const LEGACY_ROWS = 14;

/**
 * First template version whose background has NO baked-in row ruling or
 * checkboxes (see ensureNote.ts's TEMPLATE_VERSION log). From here on the rows
 * are drawn as elements, so a note's density can change at any time. Notes
 * created before this keep their printed 14-row ruling forever -- there is no
 * API to change a page background after creation.
 */
export const UNRULED_LAYOUT_VERSION = 17;

// The template's design height and the table band the rows subdivide. These
// mirror checklistPage.ts's TPL_H / HEADER_Y / the bottom frame line at 1773;
// duplicated here (three numbers) so this module stays import-free.
const TPL_H = 1872;
const TABLE_TOP = 205;
const TABLE_BOTTOM = 1773;

/** Top of the first row, as a fraction of page height. */
export const HEADER_Y_FRAC = TABLE_TOP / TPL_H;

/** Row height for a given density, as a fraction of page height. */
export function rowHeightFrac(rows: number): number {
  return (TABLE_BOTTOM - TABLE_TOP) / rows / TPL_H;
}

/**
 * How much smaller than the v1 layout everything inside a row draws:
 * text, checkboxes, capture boxes. 1 at 14 rows.
 */
export function rowScale(rows: number): number {
  return LEGACY_ROWS / rows;
}

/**
 * Rows for a density setting. Tolerates anything a hand-edited or future
 * config might hold -- unknown values mean the standard 14, never NaN.
 */
export function densityRows(density: string | undefined): number {
  return DENSITY_ROWS[density as RowDensity] ?? DENSITY_ROWS.standard;
}

/**
 * Resolves the row count for one sync run (all pages of a run share it --
 * pagination packs tasks against a single rows-per-page).
 *
 * `legacyRuled` means the note's templated pages carry the v1 baked ruling,
 * which pins the run to 14 rows AND tells the caller to stage the v1 template
 * asset when appending pages (a new page must match its siblings' background).
 * An unknown version (0) counts as legacy: the wrong guess in the other
 * direction draws dense rows over a printed 14-row ruling.
 */
export function rowsForRun(opts: {
  density: string | undefined;
  noteLayoutVersion: number;
  hasTemplatedPages: boolean;
}): {rows: number; legacyRuled: boolean} {
  const legacyRuled =
    opts.hasTemplatedPages && opts.noteLayoutVersion < UNRULED_LAYOUT_VERSION;
  return {
    rows: legacyRuled ? LEGACY_ROWS : densityRows(opts.density),
    legacyRuled,
  };
}
