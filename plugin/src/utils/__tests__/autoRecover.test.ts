/**
 * Tests for taskCallWithAutoRecover -- the one-shot "server address went
 * stale, rediscover and retry" recovery ported from Ink2Day. Mocks
 * discoverServer directly (not the RNFS /proc reads it does internally)
 * since only its RESULT matters here, not how it finds it.
 */
import type {Ink2TaskConfig} from '../config';
import {loadConfig} from '../config';
import {taskCallWithAutoRecover} from '../autoRecover';
import * as discoverModule from '../discover';

const RNFS = require('react-native-fs');

function makeConfig(overrides: Partial<Ink2TaskConfig> = {}): Ink2TaskConfig {
  return {
    host: '10.0.0.50',
    port: 8942,
    listName: 'Inbox',
    profiles: [
      {label: 'Apple Reminders', backend: 'apple', host: '10.0.0.50', port: 8942, listName: 'Inbox'},
      {label: 'Google Tasks', backend: 'google', host: '10.0.0.50', port: 8943, listName: 'Inbox'},
    ],
    activeProfile: 0,
    notePath: '/Note/Ink2Task/Ink2Task.note',
    fontPath: '',
    listScale: 1,
    ...overrides,
  };
}

beforeEach(() => {
  RNFS.__reset();
  jest.restoreAllMocks();
});

test('a call that succeeds is returned as-is, with the SAME config -- discoverServer is never consulted', async () => {
  const discoverSpy = jest.spyOn(discoverModule, 'discoverServer');
  const config = makeConfig();
  const call = jest.fn(async (c: Ink2TaskConfig) => `ok:${c.host}`);

  const {result, config: outConfig} = await taskCallWithAutoRecover(config, call);

  expect(result).toBe('ok:10.0.0.50');
  expect(outConfig).toBe(config);
  expect(call).toHaveBeenCalledTimes(1);
  expect(discoverSpy).not.toHaveBeenCalled();
});

test('a non-network error is rethrown immediately -- discoverServer is never consulted', async () => {
  const discoverSpy = jest.spyOn(discoverModule, 'discoverServer');
  const config = makeConfig();
  const call = jest.fn(async () => {
    throw new Error('Server returned 404 while fetching reminders');
  });

  await expect(taskCallWithAutoRecover(config, call)).rejects.toThrow('404');
  expect(discoverSpy).not.toHaveBeenCalled();
});

test('a network error with a freshly-discovered DIFFERENT address retries once, ' +
  'returns the new result, and persists the fixed address to every profile that shared it', async () => {
  jest.spyOn(discoverModule, 'discoverServer').mockResolvedValue({host: '10.0.0.99', port: 8942});
  const config = makeConfig();
  const call = jest.fn(async (c: Ink2TaskConfig) => {
    if (c.host === '10.0.0.50') throw new TypeError('Network request failed');
    return `ok:${c.host}`;
  });

  const {result, config: outConfig} = await taskCallWithAutoRecover(config, call);

  expect(result).toBe('ok:10.0.0.99');
  expect(call).toHaveBeenCalledTimes(2);
  expect(outConfig.host).toBe('10.0.0.99');
  // Only the profile that shared the stale 10.0.0.50:8942 address updates --
  // the Google profile was on a different port (8943) and stays untouched.
  expect(outConfig.profiles[0].host).toBe('10.0.0.99');
  expect(outConfig.profiles[1].host).toBe('10.0.0.50');

  // Persisted to disk, so the NEXT sync doesn't have to rediscover at all.
  const saved = await loadConfig();
  expect(saved.host).toBe('10.0.0.99');
});

test('a network error where discovery finds NOTHING rethrows the original error, ' +
  'without a wasted retry', async () => {
  jest.spyOn(discoverModule, 'discoverServer').mockResolvedValue(null);
  const config = makeConfig();
  const call = jest.fn(async () => {
    throw new TypeError('Network request failed');
  });

  await expect(taskCallWithAutoRecover(config, call)).rejects.toThrow('Network request failed');
  expect(call).toHaveBeenCalledTimes(1); // no retry attempted
});

test('a network error where discovery finds the SAME address rethrows -- ' +
  'retrying an identical address would just fail the same way again', async () => {
  jest.spyOn(discoverModule, 'discoverServer').mockResolvedValue({host: '10.0.0.50', port: 8942});
  const config = makeConfig();
  const call = jest.fn(async () => {
    throw new TypeError('Network request failed');
  });

  await expect(taskCallWithAutoRecover(config, call)).rejects.toThrow('Network request failed');
  expect(call).toHaveBeenCalledTimes(1);
});

test('a SECOND failure against the freshly-discovered address is NOT retried again -- ' +
  'exactly one retry, not a loop', async () => {
  jest.spyOn(discoverModule, 'discoverServer').mockResolvedValue({host: '10.0.0.99', port: 8942});
  const config = makeConfig();
  const call = jest.fn(async () => {
    throw new TypeError('Network request failed');
  });

  await expect(taskCallWithAutoRecover(config, call)).rejects.toThrow('Network request failed');
  expect(call).toHaveBeenCalledTimes(2); // original attempt + exactly one retry
});
