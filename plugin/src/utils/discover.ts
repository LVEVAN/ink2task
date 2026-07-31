/**
 * Zero-dependency LAN discovery of the Ink2Task Mac server.
 *
 * The plugin sandbox has no mDNS/Bonjour and no way to read its own IP through
 * an SDK call, so instead we read Android's routing tables (world-readable
 * /proc files) to learn the local /24 subnet, then sweep it over HTTP looking
 * for a host whose /health identifies itself as our server. Uses only RNFS
 * (already a dependency) and the global fetch -- nothing native to add.
 *
 * If the /proc files aren't readable (some locked-down Androids block them),
 * discovery just returns null and the user falls back to typing the IP.
 */
import RNFS from 'react-native-fs';

const HEALTH_TIMEOUT_MS = 700; // per-host probe; hosts that aren't there hang until this
const CONCURRENCY = 24; // parallel probes; ~254/24 * 0.7s ≈ 7s worst case per subnet

/** Little-endian 8-hex-digit address (as /proc/net/route stores them) -> dotted IP. */
function hexLEtoIp(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const b = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)].map(h =>
    parseInt(h, 16),
  );
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`; // reversed: little-endian
}

/** First three octets of an IP, i.e. its /24 base ("192.168.5.1" -> "192.168.5"). */
function base24(ip: string): string {
  return ip.split('.').slice(0, 3).join('.');
}

/**
 * Best-effort guess of the local /24 subnet base(s), e.g. "192.168.5", from the
 * default gateway and directly-connected routes. Reads two /proc files and
 * merges what it finds; returns [] if neither is readable.
 */
export async function candidateSubnets(): Promise<string[]> {
  const bases = new Set<string>();

  // /proc/net/route: hex, little-endian. The default route (dest 00000000) and
  // any /24 route (mask 00FFFFFF) both pin the subnet.
  try {
    const route = await RNFS.readFile('/proc/net/route', 'utf8');
    for (const line of route.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 3) continue;
      const [, dest, gw] = f;
      if (dest === '00000000' && gw && gw !== '00000000') {
        const ip = hexLEtoIp(gw);
        if (ip) bases.add(base24(ip));
      }
      if (f.length >= 8 && f[7] === '00FFFFFF' && dest !== '00000000') {
        const ip = hexLEtoIp(dest);
        if (ip) bases.add(base24(ip));
      }
    }
  } catch {
    // not readable on this device; try arp
  }

  // /proc/net/arp: dotted-decimal IPs of hosts we've talked to (the gateway is
  // almost always here). Easy to parse, good fallback.
  try {
    const arp = await RNFS.readFile('/proc/net/arp', 'utf8');
    for (const line of arp.split('\n').slice(1)) {
      const ip = line.trim().split(/\s+/)[0];
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0') bases.add(base24(ip));
    }
  } catch {
    // also not readable
  }

  return [...bases];
}

/** Well-known ports the backends default to; scanned alongside the current one. */
const KNOWN_PORTS = [8942, 8943, 8944];

export type Found = {host: string; port: number};

type Probe = {ok: true; backend?: string} | null;

/** Probes one host:port's /health; returns the backend id if it's a Ink2Task server. */
async function probe(host: string, port: number): Promise<Probe> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/health`, ctrl ? {signal: ctrl.signal} : {});
    if (!res.ok) return null;
    const data = await res.json();
    // 'app' marks newer servers; 'ok' keeps discovery working against an older
    // server that predates the marker.
    if (data && (data.app === 'ink2task' || data.ok === true)) {
      return {ok: true, backend: typeof data.backend === 'string' ? data.backend : undefined};
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scans hosts x ports with bounded concurrency (ports probed in parallel per
 * host, so a host still costs ~one timeout). Prefers a server whose backend
 * matches `wantBackend`; falls back to a server that reports no backend (an
 * older build), but never returns one whose backend is a different, known kind.
 */
async function scanPool(
  hosts: string[],
  ports: number[],
  wantBackend?: string,
): Promise<Found | null> {
  let idx = 0;
  let match: Found | null = null;
  let fallback: Found | null = null;
  async function worker(): Promise<void> {
    while (match === null && idx < hosts.length) {
      const host = hosts[idx++];
      const results = await Promise.all(
        ports.map(async p => {
          const r = await probe(host, p);
          return r ? {host, port: p, backend: r.backend} : null;
        }),
      );
      for (const r of results) {
        if (!r) continue;
        if (wantBackend && r.backend === wantBackend) {
          match = {host: r.host, port: r.port};
          return;
        }
        if (!wantBackend) {
          match = {host: r.host, port: r.port};
          return;
        }
        // wantBackend set: only an unlabeled (older) server is an acceptable fallback.
        if (r.backend === undefined && !fallback) fallback = {host: r.host, port: r.port};
      }
    }
  }
  await Promise.all(
    Array.from({length: Math.min(CONCURRENCY, hosts.length)}, () => worker()),
  );
  return match ?? fallback;
}

/**
 * Finds the Ink2Task server on the current Wi-Fi and returns its host AND
 * port, or null. Scans each candidate /24 across the current port plus the
 * known backend ports, and (when given) matches the desired backend so the
 * right server is picked even when both run on the same machine.
 */
export async function discoverServer(port: number, backend?: string): Promise<Found | null> {
  const bases = await candidateSubnets();
  const ports = [...new Set([port, ...KNOWN_PORTS])];
  for (const base of bases) {
    const hosts = Array.from({length: 254}, (_, i) => `${base}.${i + 1}`);
    const found = await scanPool(hosts, ports, backend);
    if (found) return found;
  }
  return null;
}
