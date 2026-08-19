/**
 * Interactive OAuth consent flow -- the actual "open a browser, wait for the
 * redirect, exchange the code" mechanics, factored out so both consumers
 * share one implementation instead of drifting:
 *   - authorize.ts: the one-time `npm run authorize` CLI command.
 *   - server.ts: on-demand auto-reauthorization when a running server hits
 *     an invalid_grant error (the stored token expired or was revoked) --
 *     triggered by a real Supernote sync attempt, not a background timer.
 *
 * Does NOT persist the resulting token -- callers decide when/how to save
 * it, since authorize.ts and server.ts have different config-loading needs.
 */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {URL} from 'node:url';
import {oauthClient, redirectPort, redirectUri, TASKS_SCOPE} from './google.js';

/** Opens a URL in the default browser cross-platform; no-op if it can't. */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, {stdio: 'ignore', detached: true}).unref();
  } catch {
    // Non-fatal: the URL is also printed for the user to open manually. This
    // is also the ONLY thing that happens on a headless machine (e.g. a Pi
    // over SSH with no browser to open) -- there's no way to detect "no GUI"
    // in advance, so we always try openInBrowser and always print the URL
    // too, rather than picking one.
  }
}

function htmlResponse(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ink2Task</title></head>
<body style="font-family: system-ui, sans-serif; padding: 3rem; text-align: center;">
<h2>${message}</h2><p>You can close this tab now.</p></body></html>`;
}

/**
 * Runs the consent flow once: builds the URL, opens/prints it, waits for
 * Google's redirect on a loopback listener, exchanges the code, and returns
 * the refresh token. Rejects if the user denies access, no refresh token
 * comes back, or the loopback listener itself fails to start (e.g. the port
 * is already in use -- see redirectPort()'s OAUTH_REDIRECT_PORT override).
 */
export async function runInteractiveAuthorization(
  opts: {announce?: (message: string) => void} = {},
): Promise<string> {
  const log = opts.announce ?? ((m: string) => console.log(m));
  const auth = oauthClient();
  const url = auth.generateAuthUrl({
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // force a refresh token even on re-authorization
    scope: [TASKS_SCOPE],
  });

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', redirectUri());
        if (reqUrl.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get('error');
        const returnedCode = reqUrl.searchParams.get('code');
        if (error) {
          res.writeHead(200, {'Content-Type': 'text/html'});
          res.end(htmlResponse('Authorization was denied.'));
          server.close();
          reject(new Error(`Authorization denied: ${error}`));
          return;
        }
        if (!returnedCode) {
          res.writeHead(400, {'Content-Type': 'text/html'});
          res.end(htmlResponse('No authorization code received.'));
          return;
        }
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(htmlResponse('Ink2Task is now connected to Google Tasks.'));
        server.close();
        resolve(returnedCode);
      } catch (e) {
        server.close();
        reject(e as Error);
      }
    });

    server.on('error', reject);
    server.listen(redirectPort(), '127.0.0.1', () => {
      log('Opening your browser to the Google consent screen…');
      log('If it does not open, paste this URL into a browser:');
      log('  ' + url);
      log(`Waiting for the redirect on ${redirectUri()} …`);
      openInBrowser(url);
    });
  });

  const {tokens} = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and try again ' +
        '(this flow already requests prompt=consent to force one).',
    );
  }
  return tokens.refresh_token;
}
