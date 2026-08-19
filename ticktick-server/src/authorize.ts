/**
 * One-time OAuth2 authorization (`npm run authorize`).
 *
 * Thin CLI wrapper around reauth.ts's runInteractiveAuthorization(), which
 * does the actual "open a browser, wait for the redirect, exchange the
 * code" work -- shared with server.ts's own on-demand auto-reauthorization,
 * so both stay in sync instead of drifting apart. Same split as
 * google-tasks-server's authorize.ts.
 *
 * Run this once (or again if you revoke access or lose the token). Past
 * that, the running server auto-reconnects on its own the moment a sync
 * attempt hits an expired/revoked token -- see server.ts's TickTickAuthError
 * handling -- so re-running this manually is a fallback, not a requirement.
 */
import './env.js';
import {runInteractiveAuthorization} from './reauth.js';
import {CONFIG_FILE, loadConfig, saveConfig} from './config.js';

async function main(): Promise<void> {
  console.log('Ink2Task -- authorize TickTick access');
  console.log('');

  const tokens = await runInteractiveAuthorization();

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
