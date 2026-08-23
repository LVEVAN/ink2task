import {formatDueForDialog} from '../dateParse';

describe('formatDueForDialog', () => {
  it('formats a date-only value as MM/DD/YY', () => {
    expect(formatDueForDialog('2026-07-29')).toBe('07/29/26');
  });

  it('drops the time part, since the dialog line is a confirmation', () => {
    expect(formatDueForDialog('2026-08-12T22:00')).toBe('08/12/26');
  });

  it('keeps the zero padding', () => {
    expect(formatDueForDialog('2026-01-05')).toBe('01/05/26');
  });

  it('handles a century boundary', () => {
    expect(formatDueForDialog('2100-12-31')).toBe('12/31/00');
  });

  it('passes an unrecognised value through instead of throwing mid-sync', () => {
    expect(formatDueForDialog('tomorrow')).toBe('tomorrow');
    expect(formatDueForDialog('')).toBe('');
  });
});
