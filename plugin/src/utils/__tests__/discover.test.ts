import {fallbackSubnets} from '../discover';

describe('fallbackSubnets', () => {
  it('puts the currently configured /24 first', () => {
    // A router almost always hands the Mac a new address in the SAME subnet,
    // so this is by far the best guess when /proc is unreadable.
    expect(fallbackSubnets('10.0.0.3')[0]).toBe('10.0.0');
    expect(fallbackSubnets('192.168.7.42')[0]).toBe('192.168.7');
  });

  it('does not duplicate a known base that is also the current one', () => {
    const out = fallbackSubnets('10.0.0.3');
    expect(out.filter(b => b === '10.0.0')).toHaveLength(1);
  });

  it('still returns the common ranges when no host is configured', () => {
    // The Android 11 fresh-install case: no /proc, no saved host.
    const out = fallbackSubnets();
    expect(out).toContain('10.0.0');
    expect(out).toContain('192.168.1');
    expect(out.length).toBeGreaterThan(3);
  });

  it('ignores a non-IP host rather than deriving nonsense from it', () => {
    for (const bad of ['', '   ', 'my-mac.local', 'http://10.0.0.3', 'not.an.ip.x']) {
      const out = fallbackSubnets(bad);
      expect(out[0]).toBe('10.0.0'); // falls straight through to the known list
    }
  });
});
