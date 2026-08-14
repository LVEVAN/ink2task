/**
 * Tests for the self-healing single-flight guard (see busy.ts's file-header
 * comment for why it exists: a plain boolean `busy` flag could get stuck
 * true forever if a hung native call never let its `finally` run).
 */
import {acquireBusy, releaseBusy} from '../busy';

beforeEach(() => {
  // Each test starts from a clean, unheld guard -- release defensively in
  // case a previous test left it held (acquireBusy has no "reset" of its
  // own; releaseBusy is always safe to call even when already free).
  releaseBusy();
  jest.restoreAllMocks();
});

test('acquireBusy succeeds when free, and blocks a second caller while held', () => {
  expect(acquireBusy()).toBe(true);
  expect(acquireBusy()).toBe(false); // still held
  expect(acquireBusy()).toBe(false); // repeated attempts also blocked
});

test('releaseBusy frees the guard for the next caller', () => {
  expect(acquireBusy()).toBe(true);
  releaseBusy();
  expect(acquireBusy()).toBe(true);
});

test('a guard held less than 90s stays blocked, even well after a normal sync would have finished', () => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  expect(acquireBusy()).toBe(true);

  jest.spyOn(Date, 'now').mockReturnValue(now + 89000);
  expect(acquireBusy()).toBe(false);
});

test('a guard held 90s or longer self-heals -- the next caller can acquire it ' +
  'without anyone ever calling releaseBusy', () => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  expect(acquireBusy()).toBe(true); // held, never released -- simulates a stuck hang

  jest.spyOn(Date, 'now').mockReturnValue(now + 90000);
  expect(acquireBusy()).toBe(true); // self-healed
});

test('self-healing resets the clock -- a fresh acquire needs its OWN 90s, not the original one', () => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  expect(acquireBusy()).toBe(true);

  jest.spyOn(Date, 'now').mockReturnValue(now + 90000);
  expect(acquireBusy()).toBe(true); // self-healed, reacquired at now+90000

  jest.spyOn(Date, 'now').mockReturnValue(now + 90001);
  expect(acquireBusy()).toBe(false); // just reacquired -- not stale yet
});
