/**
 * HTTP for the LAN backends, routed around Android's cleartext block.
 *
 * THE PROBLEM: the plugin host targets SDK 35 and declares neither
 * usesCleartextTraffic nor a networkSecurityConfig, so
 * NetworkSecurityPolicy.isCleartextTrafficPermitted() is FALSE for the process
 * we run in. Device-confirmed on a Manta (Android 11) 2026-08-23: every
 * http:// request through fetch fails instantly with React Native's generic
 * "Network request failed" -- 1016 discovery probes failed in 2.8 seconds,
 * including one aimed at a server that answered a raw socket from that same
 * device. The A5X (Android 8.1) never hit this. Our own manifest cannot fix it:
 * this APK is never installed as an app, so its manifest governs nothing.
 *
 * THE ROUTE AROUND IT: the policy applies to the platform HTTP stacks, not to
 * java.net.Socket, so Ink2TaskNetModule speaks HTTP/1.0 down a raw socket.
 *
 * `lanFetch` keeps the shape of the `fetch` calls it replaces (ok / status /
 * json() / text()) so the call sites read the same, and falls back to the real
 * fetch whenever it can: for https:// URLs, when cleartext is permitted, and
 * when the native module is missing. That last case matters -- if
 * Ink2TaskPackage ever fails to reach PluginConfig.json's reactPackages, this
 * must degrade to previous behaviour rather than break every request.
 */
import {NativeModules} from 'react-native';

/**
 * The subset of `Response` this codebase actually uses. Exported so helpers
 * that take a response (describeError) can accept either this or a real
 * `Response` without a cast.
 */
export type LanResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
};

/**
 * Cached, because the answer cannot change while the process lives. The PROMISE
 * is cached, not just the result: the discovery sweep fires many probes at once,
 * and caching only the resolved value let several of them get past the guard
 * before the first answer landed, so they each asked the native side again and
 * each logged the transport line (seen twice in the 1.2.40 device log).
 */
/**
 * Lazily resolved, so the SDK never loads merely because this module was
 * imported. ./permissions imports sn-plugin-lib; a static import here would
 * drag it into every module that touches lanHttp, which is what broke
 * discover.test.ts (its subject is a pure string helper).
 */
async function requirePermission(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {requireInternet} = require('./permissions');
  await requireInternet();
}

let cleartextBlocked: boolean | null = null;
let policyInFlight: Promise<boolean> | null = null;

function isCleartextBlocked(): Promise<boolean> {
  if (cleartextBlocked !== null) return Promise.resolve(cleartextBlocked);
  if (!policyInFlight) policyInFlight = askCleartextPolicy();
  return policyInFlight;
}

async function askCleartextPolicy(): Promise<boolean> {
  try {
    const mod = (NativeModules as any)?.Ink2TaskNet;
    if (!mod?.getCleartextPolicy) {
      cleartextBlocked = false;
      return cleartextBlocked;
    }
    const p = await mod.getCleartextPolicy();
    cleartextBlocked = p?.permittedGlobally === false;
    console.log(
      cleartextBlocked
        ? '[Ink2Task] LAN transport: native socket (cleartext HTTP is blocked for this process)'
        : '[Ink2Task] LAN transport: fetch (cleartext HTTP is permitted)',
    );
  } catch {
    cleartextBlocked = false; // cannot tell; behave as before
  }
  return cleartextBlocked;
}

/** Exposed so a caller can report the condition rather than guess at symptoms. */
export async function cleartextIsBlocked(): Promise<boolean> {
  return isCleartextBlocked();
}

function toResponse(status: number, body: string): LanResponse {
  return {
    // Mirror fetch: 2xx only.
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

/**
 * fetch-compatible enough for this codebase's LAN calls.
 *
 * `timeoutMs` is applied by the native socket (connect AND read), which is why
 * the discovery sweep can still bound itself per host.
 */
export async function lanFetch(
  url: string,
  init: {method?: string; body?: string; headers?: Record<string, string>; signal?: any} = {},
  timeoutMs = 6000,
): Promise<LanResponse> {
  // The bottom of the stack, so no caller can forget the permission gate.
  // Memoised in permissions.ts, so this is a resolved promise after the first
  // request.
  //
  // Required lazily, NOT imported at the top: ./permissions imports
  // sn-plugin-lib, and a static import here would drag the SDK into every
  // module that touches lanHttp -- which broke discover.test.ts, whose subject
  // is a pure string helper. See the import-free note in taskText.ts.
  await requirePermission();
  const isHttp = /^http:\/\//i.test(url);
  if (isHttp && (await isCleartextBlocked())) {
    const mod = (NativeModules as any)?.Ink2TaskNet;
    if (mod?.httpRequest) {
      const res = await mod.httpRequest(
        (init.method || 'GET').toUpperCase(),
        url,
        init.body ?? null,
        timeoutMs,
      );
      if (res?.error) throw new Error(res.error);
      return toResponse(res?.status ?? 0, res?.body ?? '');
    }
  }
  // https, or cleartext permitted, or no native module: the normal path.
  const res: any = await fetch(url, init as any);
  const body = await res.text();
  return toResponse(res.status, body);
}

/**
 * Tries ONE request to a known-good server by every transport we have, and logs
 * which of them work. A diagnostic, not part of any normal path.
 *
 * Written for this situation: on the plugin preview firmware, discovery sweeps
 * the right subnet and every probe times out connecting, while the same tablet
 * opens a TCP connection to that exact host and port from an adb shell. The adb
 * shell runs as a DIFFERENT user than the plugin host, so it proves the network
 * is fine and proves nothing about whether OUR process is allowed out. This
 * tells them apart: if the platform fetch succeeds where the raw socket fails,
 * the beta is restricting raw sockets; if neither works, the process itself is
 * being denied the network despite the permission reading as granted.
 */
export async function diagnoseTransports(host: string, port: number): Promise<void> {
  const url = `http://${host}:${port}/health`;
  const log = (m: string) => console.log(`[Ink2Task][transport] ${m}`);
  log(`testing ${url}`);

  try {
    const mod = (NativeModules as any)?.Ink2TaskNet;
    const p = await mod?.getCleartextPolicy?.();
    log(`cleartext policy: global=${p?.permittedGlobally} lan=${p?.permittedForPrivateLan}`);
  } catch (e: any) {
    log(`cleartext policy threw: ${e?.message || e}`);
  }

  try {
    const mod = (NativeModules as any)?.Ink2TaskNet;
    const res = await mod.httpRequest('GET', url, null, 4000);
    log(
      res?.error
        ? `native socket: FAILED ${res.error}`
        : `native socket: OK status=${res?.status} body=${String(res?.body).slice(0, 80)}`,
    );
  } catch (e: any) {
    log(`native socket: THREW ${e?.message || e}`);
  }

  try {
    const res: any = await fetch(url);
    const body = await res.text();
    log(`platform fetch: OK status=${res.status} body=${body.slice(0, 80)}`);
  } catch (e: any) {
    log(`platform fetch: FAILED ${e?.message || e}`);
  }
}
