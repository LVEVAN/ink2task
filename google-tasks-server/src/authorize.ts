/**
 * One-time OAuth2 authorization (`npm run authorize`).
 *
 * Desktop-app loopback flow:
 *   1. Build the Google consent URL and open it in the browser.
 *   2. Run a tiny local HTTP listener on the loopback redirect URI.
 *   3. Google redirects back to it with a `code`; exchange that for tokens.
 *   4. Persist the refresh token to ~/.ink2task-google/config.json.
 *
 * Run once (or again if you revoke access or lose the token). The ongoing
 * server never needs the browser -- it refreshes access tokens from the stored
 * refresh token on its own.
 */
import './env.js';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {URL} from 'node:url';
import {oauthClient, redirectPort, redirectUri, TASKS_SCOPE} from './google.js';
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
  const auth = oauthClient();
  const url = auth.generateAuthUrl({
    access_type: 'offline', // ask for a refresh token
    prompt: 'consent', // force a refresh token even on re-authorization
    scope: [TASKS_SCOPE],
  });

  // Wait for Google to redirect back to our loopback listener with the code.
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
      console.log('Ink2Task -- authorize Google Tasks access');
      console.log('');
      console.log('Opening your browser to the Google consent screen…');
      console.log('If it does not open, paste this URL into a browser:');
      console.log('');
      console.log('  ' + url);
      console.log('');
      console.log(`Waiting for the redirect on ${redirectUri()} …`);
      openInBrowser(url);
    });
  });

  const {tokens} = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and run authorize again ' +
        '(the flow already requests prompt=consent to force one).',
    );
  }

  const config = loadConfig();
  config.refreshToken = tokens.refresh_token;
  saveConfig(config);

  console.log('');
  console.log('Success. Refresh token saved to ' + CONFIG_FILE);
  console.log(`List to sync: "${config.listName}" (edit ${CONFIG_FILE} to change)`);
  console.log('Now run `npm start` to launch the server.');
}

main().catch(err => {
  console.error('Authorization failed:', err?.message ?? err);
  process.exit(1);
});
