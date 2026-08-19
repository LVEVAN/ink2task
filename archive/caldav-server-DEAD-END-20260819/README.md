# Ink2Task CalDAV server

Apple Reminders backend for the Ink2Task Supernote plugin, synced directly via
CalDAV -- no local Mac or EventKit required, unlike `mac-server`. Speaks the
same HTTP contract as `google-tasks-server` and `mac-server`, so the plugin
can't tell which backend it's talking to.

Because it has no OS dependency, this can run anywhere always-on: a spare
laptop, a Raspberry Pi, a small VPS, or (with light adaptation of the
`http.createServer` wiring in `src/server.ts`) a serverless platform like
Cloudflare Workers or Google Cloud Run.

## Opening a terminal

**Mac**: press `Cmd+Space`, type `Terminal`, hit Enter.
**Windows**: press the Windows key, type `bash` (Git Bash) or `wsl`, hit Enter.

## Setup

```bash
cd caldav-server
npm install
npm run setup
```

`npm run setup` will ask for:

1. Your Apple ID email
2. An **app-specific password** -- not your real Apple ID password. Generate
   one at [appleid.apple.com](https://appleid.apple.com): sign in, go to
   **Sign-In and Security > App-Specific Passwords**, and create one (any
   label works, e.g. "Ink2Task").

It then connects to iCloud, lists your Reminders lists, and lets you pick
which one to sync. Nothing is saved until the credential has actually been
verified against Apple's servers.

## Running

```bash
npm start
```

Prints the address to put into Ink2Task's settings on your Supernote (same as
`google-tasks-server` and `mac-server`).

## If the password stops working

Apple can revoke an app-specific password (e.g. if you change your Apple ID
password). The server will report a clear "rejected" error to the plugin --
run `npm run setup` again here to reconnect.

## Config file

Settings (Apple ID, app-specific password, chosen list, and the cached CalDAV
discovery info) are saved to `caldav-server/config.json`, gitignored so the
credential never gets committed.
