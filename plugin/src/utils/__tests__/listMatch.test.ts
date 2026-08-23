import {isListMissingError, pickReplacementList, describeListSwitch} from '../listMatch';

describe('isListMissingError', () => {
  it('matches every server wording', () => {
    for (const msg of [
      'No TickTick project named "Inbox" was found.',
      'No Todoist project named "Inbox" was found',
      'No Reminders list named "Inbox" was found.',
      'Reached the server, but list "Inbox" does not exist.',
      'ListNotFoundError: Inbox',
    ]) {
      expect(isListMissingError(msg)).toBe(true);
    }
  });

  it('ignores unrelated failures', () => {
    for (const msg of [
      'Network request failed',
      'Todoist 401: {"error":"Unauthorized"}',
      'Timed out reaching TickTick server',
      'recognizeElements failed (117)',
    ]) {
      expect(isListMissingError(msg)).toBe(false);
    }
  });
});

describe('pickReplacementList', () => {
  it('matches through an emoji prefix', () => {
    // The real TickTick projects from the 2026-08-23 device report.
    const lists = ['👋Work Tasks', '💼Work', '🏠Personal'];
    expect(pickReplacementList('Personal', lists)).toEqual({
      name: '🏠Personal',
      reason: 'same-name',
    });
  });

  it('matches through case', () => {
    expect(pickReplacementList('inbox', ['Inbox', 'Work'])?.name).toBe('Inbox');
  });

  it('takes the only list there is', () => {
    expect(pickReplacementList('Inbox', ['Personal'])).toEqual({
      name: 'Personal',
      reason: 'only-list',
    });
  });

  it('takes a lone default-looking list', () => {
    expect(pickReplacementList('Inbox', ['My Tasks', 'Work', 'Groceries'])).toEqual({
      name: 'My Tasks',
      reason: 'default-like',
    });
  });

  it('refuses to guess between several real projects', () => {
    // This is the case that must stay an error: filing personal tasks into a
    // work project unasked is worse than a failed sync.
    expect(pickReplacementList('Inbox', ['👋Work Tasks', '💼Work', '🏠Personal'])).toBeNull();
  });

  it('refuses when two lists both look like defaults', () => {
    expect(pickReplacementList('Inbox', ['Tasks', 'To Do', 'Work'])).toBeNull();
  });

  it('refuses when two lists normalise to the same name', () => {
    expect(pickReplacementList('Work', ['Work', '💼Work'])).toBeNull();
  });

  it('survives an empty or junk list', () => {
    expect(pickReplacementList('Inbox', [])).toBeNull();
    expect(pickReplacementList('Inbox', ['', '  '])).toBeNull();
  });
});

describe('describeListSwitch', () => {
  it('says which list was used and why', () => {
    expect(describeListSwitch('Personal', {name: '🏠Personal', reason: 'same-name'}))
      .toContain('🏠Personal');
    expect(describeListSwitch('Inbox', {name: 'Personal', reason: 'only-list'}))
      .toContain('only list');
  });
});
