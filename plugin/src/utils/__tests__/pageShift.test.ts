import {
  parsePageKey,
  shiftPageKeys,
  shiftPageRef,
  shiftTemplatedCount,
  unshiftPageKeys,
  unshiftPageRef,
} from '../pageShift';

const NOTE = '/Note/Ink2Task/Ink2Task Manta.note';
const OTHER = '/Note/Ink2Task/Ink2Task.note';

describe('parsePageKey', () => {
  it('splits a real key', () => {
    expect(parsePageKey(`${NOTE}#3`)).toEqual({notePath: NOTE, page: 3});
  });

  it('uses the LAST hash, since a note path may contain one', () => {
    expect(parsePageKey('/Note/my#note.note#2')).toEqual({
      notePath: '/Note/my#note.note',
      page: 2,
    });
  });

  it('rejects anything that is not a page key', () => {
    for (const bad of ['', 'nohash', '#3', `${NOTE}#`, `${NOTE}#x`, `${NOTE}#-1`, `${NOTE}#1.5`]) {
      expect(parsePageKey(bad)).toBeNull();
    }
  });
});

describe('shiftPageKeys', () => {
  it('moves pages at and above the insertion point', () => {
    const store = {[`${NOTE}#0`]: 'a', [`${NOTE}#1`]: 'b', [`${NOTE}#2`]: 'c'};
    expect(shiftPageKeys(store, NOTE, 1)).toEqual({
      [`${NOTE}#0`]: 'a',
      [`${NOTE}#2`]: 'b',
      [`${NOTE}#3`]: 'c',
    });
  });

  it('never merges two pages into one', () => {
    // The bug this guards: shifting lowest-first writes page 1 onto page 2
    // before page 2 has moved, and one page's records vanish.
    const store: {[k: string]: string} = {};
    for (let p = 0; p < 6; p++) store[`${NOTE}#${p}`] = `page${p}`;
    const out = shiftPageKeys(store, NOTE, 0);
    expect(Object.keys(out)).toHaveLength(6);
    for (let p = 0; p < 6; p++) expect(out[`${NOTE}#${p + 1}`]).toBe(`page${p}`);
  });

  it('leaves other notes completely alone', () => {
    const store = {[`${NOTE}#1`]: 'mine', [`${OTHER}#1`]: 'theirs'};
    expect(shiftPageKeys(store, NOTE, 0)).toEqual({
      [`${NOTE}#2`]: 'mine',
      [`${OTHER}#1`]: 'theirs',
    });
  });

  it('leaves keys below the insertion point alone', () => {
    const store = {[`${NOTE}#0`]: 'a', [`${NOTE}#5`]: 'f'};
    expect(shiftPageKeys(store, NOTE, 9)).toEqual(store);
  });

  it('passes through keys that are not page keys', () => {
    const store = {someOtherSetting: 'x', [`${NOTE}#1`]: 'b'};
    expect(shiftPageKeys(store, NOTE, 0)).toEqual({
      someOtherSetting: 'x',
      [`${NOTE}#2`]: 'b',
    });
  });

  it('handles gaps without inventing pages', () => {
    const store = {[`${NOTE}#0`]: 'a', [`${NOTE}#4`]: 'e'};
    expect(shiftPageKeys(store, NOTE, 1)).toEqual({
      [`${NOTE}#0`]: 'a',
      [`${NOTE}#5`]: 'e',
    });
  });
});

describe('shiftPageRef', () => {
  it('moves a ref at or above the insertion point', () => {
    expect(shiftPageRef({notePath: NOTE, page: 2}, NOTE, 2)).toEqual({notePath: NOTE, page: 3});
  });

  it('leaves earlier pages, other notes, and absent refs', () => {
    expect(shiftPageRef({notePath: NOTE, page: 0}, NOTE, 1)).toEqual({notePath: NOTE, page: 0});
    expect(shiftPageRef({notePath: OTHER, page: 5}, NOTE, 1)).toEqual({notePath: OTHER, page: 5});
    expect(shiftPageRef(null, NOTE, 1)).toBeNull();
    expect(shiftPageRef(undefined, NOTE, 1)).toBeUndefined();
  });
});

describe('shiftTemplatedCount', () => {
  it('grows when the page lands inside our run', () => {
    expect(shiftTemplatedCount(3, 0)).toBe(4);
    expect(shiftTemplatedCount(3, 2)).toBe(4);
  });

  it('does not grow when the page lands outside it', () => {
    expect(shiftTemplatedCount(3, 3)).toBe(3);
    expect(shiftTemplatedCount(3, 7)).toBe(3);
  });
});

describe('unshiftPageKeys', () => {
  it('slides pages above the removed one down, and drops its own records', () => {
    const store = {
      [`${NOTE}#0`]: 'a',
      [`${NOTE}#1`]: 'gone',
      [`${NOTE}#2`]: 'c',
      [`${NOTE}#3`]: 'd',
    };
    expect(unshiftPageKeys(store, NOTE, 1)).toEqual({
      [`${NOTE}#0`]: 'a',
      [`${NOTE}#1`]: 'c',
      [`${NOTE}#2`]: 'd',
    });
  });

  it('never merges two pages into one', () => {
    // Going downwards, page N+1 has to land in N before N+2 lands in N+1. The
    // wrong order silently loses a page's records.
    const store: {[k: string]: string} = {};
    for (let p = 0; p < 6; p++) store[`${NOTE}#${p}`] = `page${p}`;
    const out = unshiftPageKeys(store, NOTE, 0);
    expect(Object.keys(out)).toHaveLength(5);
    for (let p = 1; p < 6; p++) expect(out[`${NOTE}#${p - 1}`]).toBe(`page${p}`);
  });

  it('leaves other notes and earlier pages alone', () => {
    const store = {[`${NOTE}#0`]: 'keep', [`${NOTE}#5`]: 'move', [`${OTHER}#5`]: 'theirs'};
    expect(unshiftPageKeys(store, NOTE, 3)).toEqual({
      [`${NOTE}#0`]: 'keep',
      [`${NOTE}#4`]: 'move',
      [`${OTHER}#5`]: 'theirs',
    });
  });

  it('round-trips with shiftPageKeys', () => {
    const store = {[`${NOTE}#0`]: 'a', [`${NOTE}#1`]: 'b', [`${NOTE}#2`]: 'c'};
    expect(unshiftPageKeys(shiftPageKeys(store, NOTE, 1), NOTE, 1)).toEqual(store);
  });
});

describe('unshiftPageRef', () => {
  it('moves a ref above the removed page down', () => {
    expect(unshiftPageRef({notePath: NOTE, page: 3}, NOTE, 1)).toEqual({notePath: NOTE, page: 2});
  });

  it('leaves earlier pages and other notes', () => {
    expect(unshiftPageRef({notePath: NOTE, page: 0}, NOTE, 2)).toEqual({notePath: NOTE, page: 0});
    expect(unshiftPageRef({notePath: OTHER, page: 9}, NOTE, 2)).toEqual({notePath: OTHER, page: 9});
  });

  it('keeps the index when the page it pointed at is the one removed', () => {
    // Whatever followed has slid into that slot, so the same number is the
    // closest thing to still-correct.
    expect(unshiftPageRef({notePath: NOTE, page: 2}, NOTE, 2)).toEqual({notePath: NOTE, page: 2});
  });
});
