import {signatureOf, canSkipRedraw} from '../pageSignature';

const base = {tasks: [{id: 'a', title: 'Milk'}], footer: 'PAGE 1 OF 2', blankRows: 1};

describe('signatureOf', () => {
  it('is stable for identical input', () => {
    expect(signatureOf(base)).toBe(signatureOf({...base}));
  });

  it('notices anything that changes the drawing', () => {
    const changes = [
      {...base, tasks: [{id: 'a', title: 'Bread'}]},
      {...base, tasks: [{id: 'b', title: 'Milk'}]},
      {...base, tasks: [{id: 'a', title: 'Milk', due: '2026-08-25'}]},
      {...base, tasks: [{id: 'a', title: 'Milk', priority: 1}]},
      {...base, tasks: [{id: 'a', title: 'Milk', parentId: 'p'}]},
      {...base, footer: 'PAGE 2 OF 2'},
      {...base, blankRows: 2},
      {...base, header: 'todoist/Inbox'},
      {...base, flags: [true]},
    ];
    for (const c of changes) {
      expect(signatureOf(c)).not.toBe(signatureOf(base));
    }
  });

  it('notices a reorder, since row order is visible', () => {
    const a = {...base, tasks: [{id: '1', title: 'A'}, {id: '2', title: 'B'}]};
    const b = {...base, tasks: [{id: '2', title: 'B'}, {id: '1', title: 'A'}]};
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  it('cannot be fooled by a title containing the field separator', () => {
    const a = {...base, tasks: [{id: 'a', title: 'x'}, {id: 'b', title: 'y'}]};
    const b = {...base, tasks: [{id: 'axb', title: 'y'}]};
    expect(signatureOf(a)).not.toBe(signatureOf(b));
  });

  it('ignores the timestamp entirely', () => {
    // The whole point: the "UPDATED" stamp changes every sync and is refreshed
    // in place, so it must never appear in the signature.
    expect(signatureOf(base)).not.toContain('UPDATED');
  });
});

describe('canSkipRedraw', () => {
  const sig = signatureOf(base);

  it('skips an unchanged, ink-free page', () => {
    expect(canSkipRedraw({previous: sig, next: sig, inkStrokes: 0})).toBe(true);
  });

  it('never skips a page with ink on it', () => {
    // The repaint is the ONLY thing that erases handwriting. Skipping here
    // would leave a captured task written on the page forever.
    expect(canSkipRedraw({previous: sig, next: sig, inkStrokes: 1})).toBe(false);
  });

  it('never skips when the ink count is unknown', () => {
    expect(canSkipRedraw({previous: sig, next: sig, inkStrokes: undefined})).toBe(false);
  });

  it('never skips a page it has no record of', () => {
    expect(canSkipRedraw({previous: undefined, next: sig, inkStrokes: 0})).toBe(false);
    expect(canSkipRedraw({previous: '', next: sig, inkStrokes: 0})).toBe(false);
  });

  it('redraws when the content changed', () => {
    const other = signatureOf({...base, footer: 'PAGE 2 OF 2'});
    expect(canSkipRedraw({previous: sig, next: other, inkStrokes: 0})).toBe(false);
  });
});
