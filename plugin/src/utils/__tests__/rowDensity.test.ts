import {
  DENSITY_ROWS,
  LEGACY_ROWS,
  UNRULED_LAYOUT_VERSION,
  densityRows,
  rowsForRun,
  rowScale,
  rowHeightFrac,
  HEADER_Y_FRAC,
} from '../rowDensity';

describe('densityRows', () => {
  it('maps the three presets', () => {
    expect(densityRows('standard')).toBe(14);
    expect(densityRows('compact')).toBe(18);
    expect(densityRows('dense')).toBe(21);
  });

  it('falls back to standard for unknown or missing values', () => {
    // A config written by a future build (or hand-edited over USB) must not
    // produce NaN rows -- that would break every pixel calculation downstream.
    expect(densityRows(undefined)).toBe(14);
    expect(densityRows('huge')).toBe(14);
    expect(densityRows('')).toBe(14);
  });

  it('agrees with the exported preset table', () => {
    for (const [name, rows] of Object.entries(DENSITY_ROWS)) {
      expect(densityRows(name)).toBe(rows);
    }
  });
});

describe('rowsForRun', () => {
  it('pins a legacy templated note to 14 rows regardless of density', () => {
    // The ruled background is baked into these notes' pages; drawing 18 rows
    // over a 14-row ruling would misalign every row with the printed lines.
    const run = rowsForRun({
      density: 'dense',
      noteLayoutVersion: 16,
      hasTemplatedPages: true,
    });
    expect(run.rows).toBe(LEGACY_ROWS);
    expect(run.legacyRuled).toBe(true);
  });

  it('lets an unruled (v17+) templated note follow the density setting', () => {
    const run = rowsForRun({
      density: 'compact',
      noteLayoutVersion: UNRULED_LAYOUT_VERSION,
      hasTemplatedPages: true,
    });
    expect(run.rows).toBe(18);
    expect(run.legacyRuled).toBe(false);
  });

  it('lets a note with no templated pages follow the density setting', () => {
    // "Use current note" pages have no baked background at all -- their ruling
    // is drawn as elements, so any density works whatever the marker says.
    const run = rowsForRun({
      density: 'dense',
      noteLayoutVersion: 0,
      hasTemplatedPages: false,
    });
    expect(run.rows).toBe(21);
    expect(run.legacyRuled).toBe(false);
  });

  it('treats an unknown version as legacy when templated pages exist', () => {
    // Version marker unreadable = assume the ruled background. The wrong guess
    // in the other direction draws dense rows over a printed 14-row ruling.
    const run = rowsForRun({
      density: 'compact',
      noteLayoutVersion: 0,
      hasTemplatedPages: true,
    });
    expect(run.rows).toBe(LEGACY_ROWS);
    expect(run.legacyRuled).toBe(true);
  });
});

describe('row geometry', () => {
  it('rowScale is 1 at the standard density and shrinks with more rows', () => {
    expect(rowScale(14)).toBe(1);
    expect(rowScale(21)).toBeCloseTo(14 / 21, 10);
  });

  it('rowHeightFrac at 14 rows reproduces the v1 template exactly', () => {
    // The v1 layout must stay pixel-identical: 112px rows on the 1872px
    // template design. Any drift here misaligns legacy notes' baked ruling.
    expect(rowHeightFrac(14)).toBeCloseTo(112 / 1872, 12);
  });

  it('rows always subdivide the same table band', () => {
    // Table band top (205/1872) plus n rows must always land on the baked
    // bottom frame line (1773/1872), for every density.
    for (const rows of Object.values(DENSITY_ROWS)) {
      expect(HEADER_Y_FRAC + rows * rowHeightFrac(rows)).toBeCloseTo(1773 / 1872, 10);
    }
  });
});
