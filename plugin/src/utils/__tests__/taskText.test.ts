import {
  findParent,
  orderByHierarchy,
  subtaskSiblingIndex,
  measureText,
  fitTitle,
  parseSubtaskPrefix,
  subtaskMarker,
  subtaskDepths,
  MAX_SUBTASK_DEPTH,
} from '../taskText';

// The real geometry of a task row on a 1404x1872 page: text spans
// TASK_TEXT_LEFT(172) to TASK_TEXT_RIGHT(1140) and the font is ~40px.
const W = 1140 - 172; // 968
const FS = 40;

describe('measureText', () => {
  it('charges narrow glyphs less than wide ones', () => {
    expect(measureText('iiii', FS)).toBeLessThan(measureText('mmmm', FS));
  });

  it('scales linearly with font size', () => {
    expect(measureText('hello', 80)).toBeCloseTo(measureText('hello', 40) * 2, 5);
  });

  it('treats CJK as roughly square, so it cannot silently overflow', () => {
    expect(measureText('漢', FS)).toBeGreaterThanOrEqual(FS);
  });
});

describe('fitTitle', () => {
  it('leaves a short title untouched', () => {
    expect(fitTitle('Finish Q3 report', W, FS)).toBe('Finish Q3 report');
  });

  it('leaves a title that exactly fills two lines untouched', () => {
    // Two lines' worth of real text should survive intact, no ellipsis.
    const t = 'Reply to the client about the invoice and then schedule the follow up call';
    expect(fitTitle(t, W, FS)).toBe(t);
  });

  it('keeps more of a long title than the old flat-average estimate did', () => {
    // Regression guard for the actual complaint. This is the title from the
    // device screenshot; the old code (charsPerLine * 2 with CHAR_W 0.485)
    // allowed 98 characters and cut at "That i...". Measuring real glyph
    // widths must do better than that on this string.
    const t =
      'Syncing task from the plugin settings kicks me out to the note folder ' +
      'each time on sync. That is annoying and should be fixed soon';
    const out = fitTitle(t, W, FS);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeGreaterThan(98);
  });

  it('never returns lines that would overflow the available width', () => {
    const t = 'a'.repeat(400);
    const out = fitTitle(t, W, FS, 2);
    // Two lines' worth of width is the hard ceiling; allow the ellipsis itself.
    expect(measureText(out, FS)).toBeLessThanOrEqual(W * 2 + 1);
  });

  it('hard-breaks a single word longer than the line rather than hanging', () => {
    const out = fitTitle('x'.repeat(500), W, FS, 2);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeGreaterThan(10);
  });

  it('handles a narrow width without crashing', () => {
    expect(typeof fitTitle('some title', 10, FS)).toBe('string');
  });

  it('returns empty for empty input', () => {
    expect(fitTitle('   ', W, FS)).toBe('');
  });

  it('fits more narrow-glyph text than wide-glyph text', () => {
    // The whole point of per-glyph measurement.
    const narrow = fitTitle('illi '.repeat(80), W, FS);
    const wide = fitTitle('mmmm '.repeat(80), W, FS);
    expect(narrow.length).toBeGreaterThan(wide.length);
  });
});

describe('parseSubtaskPrefix', () => {
  it('reads no marker on an ordinary line', () => {
    expect(parseSubtaskPrefix('Buy milk')).toEqual({depth: 0, rest: 'Buy milk'});
  });

  it('reads one and two levels', () => {
    expect(parseSubtaskPrefix('> Buy milk')).toEqual({depth: 1, rest: 'Buy milk'});
    expect(parseSubtaskPrefix('>> Buy milk')).toEqual({depth: 2, rest: 'Buy milk'});
  });

  it('tolerates spacing the way handwriting does', () => {
    expect(parseSubtaskPrefix('>Buy milk')).toEqual({depth: 1, rest: 'Buy milk'});
    expect(parseSubtaskPrefix('  >  >  Buy milk')).toEqual({depth: 2, rest: 'Buy milk'});
  });

  it('accepts OCR stand-ins for the chevron', () => {
    expect(parseSubtaskPrefix('› Buy milk')).toEqual({depth: 1, rest: 'Buy milk'});
    // A single "»" glyph reads as two chevrons.
    expect(parseSubtaskPrefix('» Buy milk')).toEqual({depth: 2, rest: 'Buy milk'});
  });

  it('caps depth so the marker cannot eat the row', () => {
    expect(parseSubtaskPrefix('>>>>>>>>>> Buy milk').depth).toBe(MAX_SUBTASK_DEPTH);
  });

  it('treats a markers-only line as plain text, not an empty subtask', () => {
    expect(parseSubtaskPrefix('>')).toEqual({depth: 0, rest: '>'});
    expect(parseSubtaskPrefix('>>  ')).toEqual({depth: 0, rest: '>>'});
  });

  it('does not treat a mid-string chevron as a marker', () => {
    expect(parseSubtaskPrefix('a > b')).toEqual({depth: 0, rest: 'a > b'});
  });
});

describe('subtaskMarker', () => {
  it('grows one chevron per sibling position and caps', () => {
    expect(subtaskMarker(0)).toBe('');
    expect(subtaskMarker(1)).toBe('>');
    expect(subtaskMarker(2)).toBe('>>');
    expect(subtaskMarker(3)).toBe('>>>');
    expect(subtaskMarker(99)).toBe('>'.repeat(MAX_SUBTASK_DEPTH));
  });
});

describe('subtaskSiblingIndex', () => {
  it('numbers siblings of the same parent 1, 2, 3', () => {
    // The device case: three subtasks all children of "Another Test", which a
    // depth-based marker gave a single ">" each.
    const m = subtaskSiblingIndex([
      {id: 'p'},
      {id: 'a', parentId: 'p'},
      {id: 'b', parentId: 'p'},
      {id: 'c', parentId: 'p'},
    ]);
    expect(m.get('p')).toBe(0);
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual([1, 2, 3]);
  });

  it('counts per parent, not globally', () => {
    const m = subtaskSiblingIndex([
      {id: 'p1'}, {id: 'a', parentId: 'p1'},
      {id: 'p2'}, {id: 'b', parentId: 'p2'},
    ]);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(1);
  });

  it('gives every top-level task 0', () => {
    const m = subtaskSiblingIndex([{id: 'x'}, {id: 'y'}]);
    expect([m.get('x'), m.get('y')]).toEqual([0, 0]);
  });

  it('numbers a grandchild from its own parent', () => {
    const m = subtaskSiblingIndex([
      {id: 'p'}, {id: 'a', parentId: 'p'}, {id: 'g', parentId: 'a'},
    ]);
    expect(m.get('a')).toBe(1);
    expect(m.get('g')).toBe(1);
  });
});

describe('subtaskDepths', () => {
  it('gives top-level tasks depth 0', () => {
    const d = subtaskDepths([{id: 'a'}, {id: 'b'}]);
    expect(d.get('a')).toBe(0);
    expect(d.get('b')).toBe(0);
  });

  it('walks a multi-level chain', () => {
    const d = subtaskDepths([
      {id: 'a'},
      {id: 'b', parentId: 'a'},
      {id: 'c', parentId: 'b'},
      {id: 'e', parentId: 'c'},
    ]);
    expect(d.get('b')).toBe(1);
    expect(d.get('c')).toBe(2);
    expect(d.get('e')).toBe(3);
  });

  it('is order independent', () => {
    // Backends do not guarantee parents come before children.
    const d = subtaskDepths([{id: 'c', parentId: 'b'}, {id: 'b', parentId: 'a'}, {id: 'a'}]);
    expect(d.get('c')).toBe(2);
  });

  it('counts a task whose parent is absent as depth 1, not 0', () => {
    // Completing a parent must not silently un-indent its children.
    const d = subtaskDepths([{id: 'b', parentId: 'gone'}]);
    expect(d.get('b')).toBe(1);
  });

  it('survives a parent cycle instead of recursing forever', () => {
    const d = subtaskDepths([{id: 'a', parentId: 'b'}, {id: 'b', parentId: 'a'}]);
    expect(d.get('a')).toBeGreaterThanOrEqual(1);
    expect(d.get('b')).toBeGreaterThanOrEqual(1);
  });

  it('caps very deep chains', () => {
    const tasks = [{id: 't0'} as {id: string; parentId?: string}];
    for (let i = 1; i < 12; i++) tasks.push({id: `t${i}`, parentId: `t${i - 1}`});
    expect(subtaskDepths(tasks).get('t11')).toBe(MAX_SUBTASK_DEPTH);
  });
});

describe('findParent', () => {
  // Rows as the registry stores them: page order, top to bottom.
  const rows = [
    {reminderId: 'top1', depth: 0},
    {reminderId: 'kid1', depth: 1},
    {reminderId: 'top2', depth: 0},
    {}, // a blank row being written into
  ];

  it('attaches "> x" to the nearest top-level row above', () => {
    expect(findParent(rows, 3, 1)).toEqual({id: 'top2', depth: 1});
  });

  it('attaches ">> x" to a depth-1 row above when there is one', () => {
    expect(findParent(rows, 2, 2)).toEqual({id: 'kid1', depth: 2});
  });

  it('falls back to a shallower row rather than failing', () => {
    // ">>" written directly under a top-level task behaves like ">", instead of
    // silently refusing to nest.
    expect(findParent(rows, 3, 2)).toEqual({id: 'top2', depth: 1});
  });

  it('returns undefined when nothing is above it', () => {
    expect(findParent(rows, 0, 1)).toBeUndefined();
  });

  it('skips rows with no reminderId', () => {
    const r = [{reminderId: 'a', depth: 0}, {}, {}];
    expect(findParent(r, 2, 1)).toEqual({id: 'a', depth: 1});
  });

  it('treats a missing depth as top level', () => {
    expect(findParent([{reminderId: 'a'}], 1, 1)).toEqual({id: 'a', depth: 1});
  });

  it('will not nest below a parent that is already at the cap', () => {
    // No shallower row exists, so there is nothing legal to attach to.
    expect(findParent([{reminderId: 'a', depth: MAX_SUBTASK_DEPTH}], 1, MAX_SUBTASK_DEPTH))
      .toBeUndefined();
  });

  it('clamps the resulting depth to the cap', () => {
    const got = findParent([{reminderId: 'a', depth: MAX_SUBTASK_DEPTH}], 1, MAX_SUBTASK_DEPTH + 1);
    expect(got).toEqual({id: 'a', depth: MAX_SUBTASK_DEPTH});
  });
});

describe('orderByHierarchy', () => {
  const ids = (a: {id: string}[]) => a.map(x => x.id);

  it('puts a child immediately after its parent', () => {
    // The device case: the child sorted to row 1 while its parent sat at row 6.
    const out = orderByHierarchy([
      {id: 'kid', parentId: 'milk'},
      {id: 'cereal'},
      {id: 'soap'},
      {id: 'milk'},
    ]);
    expect(ids(out)).toEqual(['cereal', 'soap', 'milk', 'kid']);
  });

  it('keeps several children in their given order under one parent', () => {
    // Todoist returned all three children ABOVE the parent.
    const out = orderByHierarchy([
      {id: 'a', parentId: 'p'},
      {id: 'b', parentId: 'p'},
      {id: 'c', parentId: 'p'},
      {id: 'p'},
      {id: 'other'},
    ]);
    expect(ids(out)).toEqual(['p', 'a', 'b', 'c', 'other']);
  });

  it('preserves top-level order otherwise', () => {
    const out = orderByHierarchy([{id: 'x'}, {id: 'y'}, {id: 'z'}]);
    expect(ids(out)).toEqual(['x', 'y', 'z']);
  });

  it('nests grandchildren under their own parent', () => {
    const out = orderByHierarchy([
      {id: 'g', parentId: 'c'},
      {id: 'c', parentId: 'p'},
      {id: 'p'},
    ]);
    expect(ids(out)).toEqual(['p', 'c', 'g']);
  });

  it('treats a task whose parent is absent as top-level, keeping its place', () => {
    const out = orderByHierarchy([{id: 'a'}, {id: 'orphan', parentId: 'gone'}, {id: 'b'}]);
    expect(ids(out)).toEqual(['a', 'orphan', 'b']);
  });

  it('never loses or duplicates a task', () => {
    const input = [
      {id: 'a'}, {id: 'b', parentId: 'a'}, {id: 'c', parentId: 'b'},
      {id: 'd'}, {id: 'e', parentId: 'd'}, {id: 'f', parentId: 'zzz'},
    ];
    const out = orderByHierarchy(input);
    expect(out).toHaveLength(input.length);
    expect(new Set(ids(out)).size).toBe(input.length);
  });

  it('survives a parent cycle instead of hanging', () => {
    const out = orderByHierarchy([{id: 'a', parentId: 'b'}, {id: 'b', parentId: 'a'}]);
    expect(out).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(orderByHierarchy([])).toEqual([]);
  });
});
