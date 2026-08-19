/**
 * The interactive browser-consent flow, factored out of authorize.ts so
 * server.ts can trigger the SAME flow on demand (a real sync hitting an
 * expired/revoked token) instead of only ever running it by hand via
 * `npm run authorize` -- same split as google-tasks-server's reauth.ts.
 *
 * The Supernote device is still never involved: this opens a browser on
 * whatever machine is running this server, exactly as `npm run authorize`
 * always has.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {URL} from 'node:url';
import {authorizeUrl, exchangeCode, redirectPort, redirectUri} from './ticktick.js';

export type ReauthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

/** Opens a URL in the default browser cross-platform; no-op if it can't. */
function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, {stdio: 'ignore', detached: true}).unref();
  } catch {
    // Non-fatal: the URL is also printed for the user to open manually.
  }
}

function htmlResponse(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ink2Task</title></head>
<body style="font-family: system-ui, sans-serif; padding: 3rem; text-align: center;">
<h2>${message}</h2><p>You can close this tab and return to the terminal.</p></body></html>`;
}

/**
 * Runs the full loopback OAuth dance and returns the resulting tokens.
 * `announce` receives the same progress lines `npm run authorize` prints,
 * so server.ts's on-demand trigger can surface them to its own console too.
 */
export async function runInteractiveAuthorization(
  opts: {announce?: (message: string) => void} = {},
): Promise<ReauthTokens> {
  const announce = opts.announce ?? console.log;

  const state = crypto.randomBytes(16).toString('hex');
  const url = authorizeUrl(state);
  const callbackPath = new URL(redirectUri()).pathname;

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', redirectUri());
        if (reqUrl.pathname !== callbackPath) {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get('error');
        const returnedState = reqUrl.searchParams.get('state');
        const returnedCode = reqUrl.searchParams.get('code');
        if (error) {
          res.writeHead(200, {'Content-Type': 'text/html'});
          res.end(htmlResponse('Authorization was denied.'));
          server.close();
          reject(new Error(`Authorization denied: ${error}`));
          return;
        }
        if (returnedState !== state) {
          res.writeHead(400, {'Content-Type': 'text/html'});
          res.end(htmlResponse('State mismatch -- possible CSRF, aborting.'));
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }
        if (!returnedCode) {
          res.writeHead(400, {'Content-Type': 'text/html'});
          res.end(htmlResponse('No authorization code received.'));
          return;
        }
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(htmlResponse('Ink2Task is now connected to TickTick.'));
        server.close();
        resolve(returnedCode);
      } catch (e) {
        server.close();
        reject(e as Error);
      }
    });

    server.on('error', reject);
    server.listen(redirectPort(), '127.0.0.1', () => {
      announce('Opening your browser to the TickTick consent screen…');
      announce('If it does not open, paste this URL into a browser:');
      announce('');
      announce('  ' + url);
      announce('');
      announce(`Waiting for the redirect on ${redirectUri()} …`);
      openInBrowser(url);
    });
  });

  const tokens = await exchangeCode(code);
  return {accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt};
}
