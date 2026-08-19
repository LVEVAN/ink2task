/**
 * One-time OAuth2 authorization (`npm run authorize`).
 *
 * Thin CLI wrapper around reauth.ts's runInteractiveAuthorization(), which
 * does the actual "open a browser, wait for the redirect, exchange the
 * code" work -- shared with server.ts's own on-demand auto-reauthorization,
 * so both stay in sync instead of drifting apart.
 *
 * Run this once (or again if you revoke access or lose the token). Past
 * that, the running server auto-reconnects on its own the moment a sync
 * attempt hits an expired/revoked token -- see server.ts's isInvalidGrant
 * handling -- so re-running this manually is a fallback, not a requirement.
 */
import './env.js';
import {runInteractiveAuthorization} from './reauth.js';
import {CONFIG_FILE, loadConfig, saveConfig} from './config.js';

async function main(): Promise<void> {
  console.log('Ink2Task -- authorize Google Tasks access');
  console.log('');

  const refreshToken = await runInteractiveAuthorization();

  const config = loadConfig();
  config.refreshToken = refreshToken;
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
