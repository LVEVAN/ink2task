/**
 * One-time setup (`npm run setup`) -- the CalDAV backend's equivalent of
 * google-tasks-server's `npm run authorize`, adapted for a password credential
 * instead of an OAuth redirect: prompts for the Apple ID and an app-specific
 * password, verifies both by actually running CalDAV discovery (never saves
 * an unverified credential), lists the account's Apple Reminders lists, and
 * saves the chosen one to config.json.
 *
 * Run this once (or again to switch Apple ID, reset a changed password, or
 * pick a different list). Unlike the Google backend there's no background
 * auto-reconnect flow: a rejected app-specific password has no consent
 * screen to relaunch, so server.ts just tells the plugin to point the user
 * back here.
 */
import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {discover, listVtodoCollections, CalDavError} from './caldav.js';
import {loadConfig, saveConfig, CONFIG_FILE} from './config.js';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({input: stdin, output: stdout});
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  console.log('Ink2Task -- connect Apple Reminders via CalDAV');
  console.log('');
  console.log('You need an app-specific password, not your real Apple ID password:');
  console.log('  1. Go to appleid.apple.com and sign in');
  console.log('  2. Under Sign-In and Security, choose App-Specific Passwords');
  console.log('  3. Generate one (any label works, e.g. "Ink2Task") and copy it');
  console.log('');

  const config = loadConfig();
  const appleId = (await prompt(`Apple ID email${config.appleId ? ` [${config.appleId}]` : ''}: `)) || config.appleId;
  if (!appleId) {
    console.error('An Apple ID is required.');
    process.exit(1);
  }
  const appPassword = await prompt('App-specific password (xxxx-xxxx-xxxx-xxxx): ');
  if (!appPassword) {
    console.error('An app-specific password is required.');
    process.exit(1);
  }

  console.log('');
  console.log('Connecting to iCloud…');
  let discovery;
  try {
    discovery = await discover(appleId, appPassword);
  } catch (err) {
    if (err instanceof CalDavError && (err.status === 401 || err.status === 403)) {
      console.error('Apple rejected that Apple ID / app-specific password combination.');
    } else {
      console.error('Could not connect: ' + (err as Error).message);
    }
    process.exit(1);
  }
  console.log('Connected. Looking up your Reminders lists…');

  const collections = await listVtodoCollections(appleId, appPassword, discovery);
  if (collections.length === 0) {
    console.error('No Reminders lists were found on this Apple ID.');
    process.exit(1);
  }

  console.log('');
  collections.forEach((c, i) => console.log(`  ${i + 1}. ${c.displayName}`));
  console.log('');
  const defaultIndex = Math.max(
    0,
    collections.findIndex(c => c.displayName === config.listName),
  );
  const answer = await prompt(`Which list should sync with the Supernote? [${defaultIndex + 1}]: `);
  const chosenIndex = answer ? Number(answer) - 1 : defaultIndex;
  const chosen = collections[chosenIndex];
  if (!chosen) {
    console.error('Not a valid choice.');
    process.exit(1);
  }

  config.appleId = appleId;
  config.appPassword = appPassword;
  config.listName = chosen.displayName;
  config.discovery = discovery;
  config.selectedList = {displayName: chosen.displayName, url: chosen.url};
  saveConfig(config);

  console.log('');
  console.log(`Success. Syncing list "${chosen.displayName}". Saved to ${CONFIG_FILE}`);
  console.log('Now run `npm start` to launch the server.');
}

main().catch(err => {
  console.error('Setup failed:', err?.message ?? err);
  process.exit(1);
});
