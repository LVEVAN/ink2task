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
import {NativeModules} from 'react-native';
import {lanFetch} from './lanHttp';
import {isDenialMessage, withoutDenialMarker} from './permissionPolicy';

// Per-host probe timeout, and how many hosts are probed at once.
//
// Was 700ms / 24. Each host probes every known port IN PARALLEL, so 24 hosts
// meant up to 96 simultaneous fetches on an e-ink device -- enough load that a
// probe to a HEALTHY server could exceed 700ms and be aborted, making discovery
// miss a server that was sitting right there. A false negative is much worse
// than a slow sweep, since it sends the user off to type an IP by hand.
//
// 1500ms is slower per host in the worst case but far steadier, and in practice
// the server answers in the first few hundred ms.
//
// Concurrency went 8 -> 32 when the probe moved onto lanHttp's native socket
// (2026-08-23). Before that, cleartext HTTP was blocked for this process, so
// every probe failed in microseconds and the sweep's wall time was fiction --
// 1016 probes finished in 2.8s without a single packet leaving the device. Now
// that the probes are real, a dead address costs the FULL timeout, so 8 at a
// time meant 254/8 * 1.5s ≈ 48s of staring at a button. A native probe is a
// bare socket on its own thread, not an HTTP stack, so 32 hosts x 4 ports is
// affordable where 24 fetches was not: 254/32 * 1.5s ≈ 12s worst case.
const HEALTH_TIMEOUT_MS = 1500;
const CONCURRENCY = 32;

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
 * The device's own subnet base from the NATIVE module, or null.
 *
 * This is the reliable source and is tried before anything else. Android 11
 * blocks /proc/net for apps, and guessing common ranges is exactly that -- a
 * guess. See Ink2TaskNetModule for why it needs no permission of its own.
 *
 * Returns null (never throws) when the module is absent, which happens if
 * Ink2TaskPackage did not make it into PluginConfig.json's reactPackages -- a
 * documented build hazard, so this must degrade rather than fail.
 */
export async function nativeSubnet(): Promise<{base: string; ip: string; source: string} | null> {
  try {
    const mod = (NativeModules as any)?.Ink2TaskNet;
    if (!mod?.getLocalIpv4) return null;
    const res = await mod.getLocalIpv4();
    const ip: string = res?.ip ?? '';
    const prefix: number = res?.prefixLength ?? 24;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
    // Only a /24 or narrower maps onto the .1-.254 sweep this module does. A
    // wider mask (a /16, say) would need 65k probes, so treat the containing
    // /24 as the best affordable guess rather than pretending to scan it all.
    if (prefix < 24) {
      console.log(`[Ink2Task] native ip ${ip}/${prefix}: wider than /24, sweeping its /24 only`);
    }
    return {base: base24(ip), ip, source: res?.source ?? 'native'};
  } catch {
    return null;
  }
}

/**
 * /24 bases worth sweeping when /proc/net cannot be read.
 *
 * ANDROID 11 BLOCKS /proc/net FOR APPS. The Manta runs Android 11 (SDK 30) and
 * SELinux labels those files `proc_net`, so an untrusted app gets EACCES even
 * though the mode is world-readable -- `adb shell` can read them only because
 * it runs as `shell`. The A5X was Android 8.1, where the read worked, so this
 * silently regressed on newer hardware and discovery reported "no matching
 * server" instantly, without probing anything (2026-08-23).
 *
 * Order matters: the /24 of an address the user already had working is by far
 * the best guess (a router usually hands the Mac a new address in the SAME
 * subnet), so it goes first. The rest are the common home ranges.
 */
export function fallbackSubnets(currentHost?: string): string[] {
  const bases: string[] = [];
  const add = (b: string) => {
    if (b && !bases.includes(b)) bases.push(b);
  };
  if (currentHost && /^\d+\.\d+\.\d+\.\d+$/.test(currentHost.trim())) {
    add(base24(currentHost.trim()));
  }
  for (const b of ['10.0.0', '192.168.1', '192.168.0', '10.0.1', '192.168.4', '172.20.10']) {
    add(b);
  }
  return bases;
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
const KNOWN_PORTS = [8942, 8943, 8944, 8955]; // 8955 = ticktick-server

export type Found = {host: string; port: number};

type Probe = {ok: true; backend?: string} | null;

/**
 * Why probes failed during the last sweep. Counted, not logged per host: 254
 * hosts x 5 ports is over a thousand attempts, and one line each would bury
 * everything else.
 *
 * Exists because a sweep that finds nothing is otherwise indistinguishable
 * between "swept fine, server absent" and "every request was refused before it
 * left the device". The suspect for the latter: the plugin host targets SDK 35
 * and declares neither usesCleartextTraffic nor a networkSecurityConfig, and
 * Android blocks plain http:// by default from SDK 28 up. Our own manifest
 * cannot change that -- it governs nothing, we run in the host's process.
 */
const probeErrors = new Map<string, number>();
/**
 * Set when a probe failed because the user refused internet permission, rather
 * than because nothing answered. Without this the sweep reports "no matching
 * server", which reads as "your server is off" -- the two were indistinguishable
 * on screen, which is what made the refusal so confusing (2026-08-24).
 */
let deniedReason = '';
/**
 * Ink2Task servers found during the sweep whose backend is not the one this
 * profile wants, as backend -> "host:port". Surfaced by lastDiscoveryReport.
 */
const otherBackends = new Map<string, string>();
/** Counts of each distinct probe failure, for the on-screen summary. */
let lastCounts = {refused: 0, timedOut: 0, other: 0};
function noteProbeError(err: unknown): void {
  let msg = err instanceof Error ? err.message : String(err);
  if (isDenialMessage(msg)) {
    deniedReason = withoutDenialMarker(msg);
    return;
  }
  // Categorised as well as aggregated: "refused" means the plugin reached a
  // machine and was turned away, which proves the network works -- the single
  // most useful thing to know when a search comes back empty.
  if (/ECONNREFUSED|Connection refused/i.test(msg)) lastCounts.refused++;
  else if (/after \d+ms|timed? ?out/i.test(msg)) lastCounts.timedOut++;
  else lastCounts.other++;
  // Collapse the host/port out so the same failure aggregates.
  // Mask the addresses AND the ports. Android's connect-timeout message carries
  // the SOURCE port too ("from /10.0.0.82 (port 45112)"), which is different on
  // every single connection -- so masking only the IP left ~1000 near-unique
  // strings and the "top 3" summary reported "2x" for each, hiding the fact
  // that every probe had failed the same way (2026-08-24).
  msg = msg
    .replace(/\b\d+\.\d+\.\d+\.\d+/g, '<host>')
    .replace(/\(port \d+\)/g, '(port <n>)')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .slice(0, 140);
  probeErrors.set(msg, (probeErrors.get(msg) ?? 0) + 1);
}

/** Probes one host:port's /health; returns the backend id if it's a Ink2Task server. */
async function probe(host: string, port: number): Promise<Probe> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl?.abort(), HEALTH_TIMEOUT_MS);
  try {
    // lanFetch routes around the cleartext block. On the native path it
    // enforces the timeout at the socket level; the AbortController still
    // covers the fallback fetch path.
    const res = await lanFetch(
      `http://${host}:${port}/health`,
      ctrl ? {signal: ctrl.signal} : {},
      HEALTH_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const data = await res.json();
    // 'app' marks newer servers; 'ok' keeps discovery working against an older
    // server that predates the marker.
    if (data && (data.app === 'ink2task' || data.ok === true)) {
      return {ok: true, backend: typeof data.backend === 'string' ? data.backend : undefined};
    }
    return null;
  } catch (err) {
    noteProbeError(err);
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
        // Remember servers of the WRONG kind. Refusing them is right -- syncing
        // a Todoist page against a Reminders server would be worse than failing
        // -- but reporting "no matching server" when an Ink2Task server was
        // sitting right there, answering, is what made this look like a network
        // fault instead of the wrong profile being selected.
        if (r.backend && r.backend !== wantBackend) {
          otherBackends.set(r.backend, `${r.host}:${r.port}`);
        }
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
export async function discoverServer(
  port: number,
  backend?: string,
  /** Currently configured host, if any -- its /24 is the best fallback guess. */
  currentHost?: string,
): Promise<Found | null> {
  // Native first: it is the only source that actually KNOWS the answer.
  const native = await nativeSubnet();
  const detected = native ? [native.base] : await candidateSubnets();
  const bases = detected.length > 0 ? detected : fallbackSubnets(currentHost);
  const how = native
    ? `native ${native.ip} via ${native.source}`
    : detected.length
      ? 'from /proc'
      : 'FALLBACK, /proc unreadable and no native module';
  // NOTE: the internet-permission gate lives in lanFetch, not here. Importing
  // it directly would pull sn-plugin-lib into this module and make it (and its
  // tests) unloadable under Jest -- see the import-free note in taskText.ts.
  // The first probe therefore surfaces a refusal, which noteProbeError spots by
  // its marker and turns into an immediate, honest failure below.
  deniedReason = '';
  otherBackends.clear();
  lastCounts = {refused: 0, timedOut: 0, other: 0};
  probeErrors.clear();
  // Ask the platform whether plain http:// is even allowed in this process
  // before blaming the network. See Ink2TaskNetModule.getCleartextPolicy.
  try {
    const mod = (NativeModules as any)?.Ink2TaskNet;
    if (mod?.getCleartextPolicy) {
      const p = await mod.getCleartextPolicy();
      if (p && p.permittedGlobally === false) {
        console.log(
          '[Ink2Task] cleartext http is blocked for this process ' +
            `(global=${p.permittedGlobally} lan=${p.permittedForPrivateLan}) -- ` +
            'probes go through the native socket instead. Not an error.',
        );
      } else {
        console.log(
          `[Ink2Task] cleartext allowed (global=${p?.permittedGlobally} ` +
            `lan=${p?.permittedForPrivateLan}${p?.error ? ' err=' + p.error : ''})`,
        );
      }
    }
  } catch {
    // diagnostic only
  }
  // A mangled port (a stray "8" was seen on device after editing the field)
  // would otherwise add a useless probe per host. Keep only plausible ports.
  const ports = [...new Set([port, ...KNOWN_PORTS])].filter(p => p >= 1024 && p <= 65535);
  // Logged because this used to fail completely silently: on Android 11 the
  // /proc read throws, `detected` is empty, and the old code returned null
  // without probing a single host -- indistinguishable from "swept everything
  // and found nothing".
  console.log(
    `[Ink2Task] discover: subnets=${JSON.stringify(bases)} (${how}) ` +
      `ports=${JSON.stringify(ports)}`,
  );
  for (const base of bases) {
    const hosts = Array.from({length: 254}, (_, i) => `${base}.${i + 1}`);
    const found = await scanPool(hosts, ports, backend);
    // A refusal is not a failed search, and must never be reported as one.
    // Thrown rather than returned as null so the caller shows this text instead
    // of its own "no matching server".
    if (deniedReason) throw new Error(deniedReason);
    if (found) {
      console.log(`[Ink2Task] discover: found ${found.host}:${found.port} on ${base}.x`);
      return found;
    }
    // Report WHY nothing answered, most common first. If every attempt failed
    // with the same non-network reason, the sweep never really happened.
    const summary = [...probeErrors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([msg, n]) => `${n}x ${msg}`);
    console.log(
      `[Ink2Task] discover: nothing on ${base}.x` +
        (summary.length ? ` -- errors: ${summary.join(' | ')}` : ' -- no errors recorded'),
    );
  }
  return null;
}

/**
 * Display name for a backend id, because the ids are ours and mean nothing to
 * the person reading the message. "apple" is "Apple Reminders" on screen and in
 * the profile switcher, and the message has to match what they can see.
 */
function serviceName(backend?: string): string {
  switch (backend) {
    case 'apple':
      return 'Apple Reminders';
    case 'google':
      return 'Google Tasks';
    case 'todoist':
      return 'Todoist';
    case 'ticktick':
      return 'TickTick';
    default:
      return 'this profile';
  }
}

/**
 * A plain-English account of the last sweep, for the screen rather than the log.
 *
 * "No matching server found" was ambiguous between three situations that need
 * completely different actions: the server is not running, the server IS
 * running but belongs to a different profile, or nothing on the network could
 * be reached. Each one now says which it is, names the service involved, and
 * says what to do next.
 */
export function lastDiscoveryReport(wantBackend?: string): string {
  const want = serviceName(wantBackend);

  // The most confusing case by far: a working server is sitting right there,
  // answering, and gets refused because it belongs to another profile.
  if (otherBackends.size > 0) {
    const [backend, where] = [...otherBackends.entries()][0];
    const other = serviceName(backend);
    return (
      `Found the ${other} server at ${where}, but this page is set to ${want}. ` +
      `Either switch to ${other} using the buttons at the top of Settings, ` +
      `or start the ${want} server on your computer.`
    );
  }

  const {refused, timedOut} = lastCounts;
  if (refused > 0) {
    // Reaching other devices proves the tablet HAS a network. It does NOT prove
    // the computer is reachable, and an earlier version of this message said
    // "your Wi-Fi is fine", which was wrong in the real case that produced it:
    // a mesh satellite had silently stopped passing traffic between devices, so
    // the tablet could reach 111 addresses and not the Mac, on the same network
    // name (2026-08-24). Reconnecting the COMPUTER'S Wi-Fi is what cleared it,
    // not the tablet's -- worth naming that end first, since it is the less
    // obvious one to suspect when the tablet is the device complaining.
    return (
      `The tablet reached other devices on this Wi-Fi, but not the ${want} ` +
      'server. Check it is running and the computer is awake. ' +
      "If it is, turn the COMPUTER'S Wi-Fi off and on again, then the tablet's " +
      '-- a mesh extender or guest network can stop two devices seeing each ' +
      'other while both still look connected.'
    );
  }
  if (timedOut > 0) {
    return (
      `Nothing on this Wi-Fi answered at all, so the ${want} server was never ` +
      'reached. Check the tablet and the computer are on the same Wi-Fi, and ' +
      'that the computer is awake.'
    );
  }
  return `Could not find the ${want} server on this Wi-Fi.`;
}
