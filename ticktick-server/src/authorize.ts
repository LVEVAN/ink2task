/**
 * One-time OAuth2 authorization (`npm run authorize`).
 *
 * Desktop loopback flow, same shape as google-tasks-server's:
 *   1. Build the TickTick consent URL and open it in the browser.
 *   2. Run a tiny local HTTP listener on the loopback redirect URI.
 *   3. TickTick redirects back to it with a `code`; exchange that for tokens.
 *   4. Persist BOTH tokens to ~/.ink2task-ticktick/config.json.
 *
 * Run once (or again if you revoke access or lose the token). The ongoing
 * server never needs the browser -- it refreshes access tokens from the
 * stored refresh token on its own (see ticktick.ts's ticktickFetch).
 *
 * The Supernote device is NEVER involved in this flow -- by design, so the
 * plugin never has to handle an OAuth redirect on Android at all. See the
 * top-level README's "Choosing a backend" for why.
 */
import './env.js';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {URL} from 'node:url';
import {authorizeUrl, exchangeCode, redirectPort, redirectUri} from './ticktick.js';
import {CONFIG_FILE, loadConfig, saveConfig} from './config.js';

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
    // Non-fatal: the URL is also printed for the user to open manually.
  }
}

function htmlResponse(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Ink2Task</title></head>
<body style="font-family: system-ui, sans-serif; padding: 3rem; text-align: center;">
<h2>${message}</h2><p>You can close this tab and return to the terminal.</p></body></html>`;
}

async function main(): Promise<void> {
  // CSRF guard: TickTick echoes `state` back verbatim, so a redirect that
  // doesn't carry the value we generated didn't come from the request we made.
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
      console.log('Ink2Task -- authorize TickTick access');
      console.log('');
      console.log('Opening your browser to the TickTick consent screen…');
      console.log('If it does not open, paste this URL into a browser:');
      console.log('');
      console.log('  ' + url);
      console.log('');
      console.log(`Waiting for the redirect on ${redirectUri()} …`);
      openInBrowser(url);
    });
  });

  const tokens = await exchangeCode(code);

  const config = loadConfig();
  config.accessToken = tokens.accessToken;
  if (tokens.refreshToken) config.refreshToken = tokens.refreshToken;
  config.accessTokenExpiresAt = tokens.expiresAt;
  saveConfig(config);

  console.log('');
  console.log('Success. Tokens saved to ' + CONFIG_FILE);
  if (!tokens.refreshToken) {
    console.log(
      'Note: TickTick did not return a refresh token in this response -- if ' +
        'the access token later expires and no refresh token is on file, ' +
        'you will need to run authorize again.',
    );
  }
  console.log('Next: run `npm start`, then choose a project from the plugin\'s Settings.');
}

main().catch(err => {
  console.error('Authorization failed:', err?.message ?? err);
  process.exit(1);
});
