# Ink2Task TickTick server

> **TickTick backend, fully wired.** The OAuth layer, the full API client
> (create/read/update/move/complete/delete), the plugin-side two-way sync
> engine (`plugin/src/utils/ticktickSync.ts`) with conflict handling and an
> offline outbox, and the Settings UI (profile, Wi-Fi discovery, connection
> instructions, last-sync status) are all in place. Everything in this file
> has been exercised against a real TickTick account, not just unit-tested
> (see "Device-verified" below).

A small Node.js + TypeScript service that:

- Authenticates to TickTick via OAuth2 -- **entirely on this computer**, never
  on the Supernote itself (see "Why the device never sees your TickTick
  tokens" below)
- Reads your TickTick projects and (once connected) the incomplete tasks in
  one of them, in the same shape the other backends already report

It's built to speak the same HTTP contract as
[`mac-server`](../mac-server/README.md),
[`google-tasks-server`](../google-tasks-server/README.md), and
[`todoist-server`](../todoist-server/README.md), so the plugin eventually
won't be able to tell them apart. No SDK dependency -- TickTick doesn't
publish one -- just plain `fetch`, the same approach `todoist-server` uses.

## Why the device never sees your TickTick tokens

TickTick's OAuth requires a **confidential client**: exchanging an
authorization code for a token needs your app's `client_secret`, and TickTick
documents no PKCE / public-client alternative. Shipping that secret inside
the Supernote plugin would mean shipping it inside the `.snplg` file --
trivially unzippable, so effectively public. That's the same reason
`google-tasks-server` exists instead of doing Google OAuth on the tablet.

So the design here goes one step further than that precedent: **this server
holds the access token (and a refresh token, if TickTick ever issues one --
see below), and neither ever leaves it.** You authorize once, on your
computer, with `npm run authorize` (identical in spirit to
`google-tasks-server`'s own `authorize` script) -- the Supernote never
participates in the OAuth flow at all. It just talks to this server over
your LAN, the same as it already does for the other three backends.

**Device-confirmed (2026-08-11):** TickTick's token response did not include
a `refresh_token` on a real authorization -- the access token itself is
simply long-lived (180 days in that run). There's no indication anywhere
that a shorter-lived token or refresh flow exists; treat `npm run authorize`
as the renewal step when the token nears expiry, not as a one-time setup you
should never need again.

## Prerequisites

- **Node.js 18 or newer** (`node --version`) -- needs the built-in global `fetch`.
- A **TickTick account**.
- A few minutes to register an app in the TickTick Developer Center.

## 1. Register an app

1. Go to the [TickTick Developer Center](https://developer.ticktick.com/manage)
   and sign in.
2. Create a new app. You'll get a **Client ID** and **Client Secret**.
3. Add an **OAuth redirect URL**. This must match, character-for-character,
   what this server sends -- by default that's
   `http://127.0.0.1:4577/oauth/callback`. If you change the port (see step
   2 below), update the registered URL to match.

## 2. Install & configure

```bash
cd ticktick-server
npm install
cp credentials.example.env credentials.env
```

Open `credentials.env` and fill in the `Client ID` / `Client Secret` from
step 1. Leave `OAUTH_REDIRECT_PORT` alone unless 4577 is already taken on
your machine.

## 3. Authorize once

```bash
npm run authorize
```

This opens your browser to TickTick's consent screen. Approve it, and the
token is saved to `~/.ink2task-ticktick/config.json`. Since TickTick's access
token is long-lived (see above) rather than refreshable, you generally only
need to do this once every few months -- if a request ever fails with "run
authorize again," that's this step.

## 4. Run the server

```bash
npm start
```

Prints the LAN address to put into Ink2Task's on-device settings: pick
TickTick as the backend on the Supernote, then enter this host and port
(default `8955`), same as the other Wi-Fi backends.

## Config file

`~/.ink2task-ticktick/config.json` -- **treat this like a password vault**,
not like the other backends' config files. Unlike `mac-server`'s or
`google-tasks-server`'s config, this one holds a live access token, because
token custody is deliberately kept server-side (see above).

```json
{
  "accessToken": "...",
  "accessTokenExpiresAt": 1802042513317,
  "projectId": "...",
  "projectName": "Inbox",
  "port": 8955
}
```

`refreshToken` may be absent entirely (the normal case, per above) or
present if a future authorization ever does return one -- the client handles
both.

## Endpoints

All of these are device-verified against a real account (2026-08-11): full
create → get → update → complete → uncomplete → move → delete round-trip.

- `GET /health` → `{"ok": true, "app": "ink2task", "backend": "ticktick", "connected": true, "listName": "Inbox"}`
- `GET /lists` → `{"lists": ["Inbox", "Work", "..."]}`
- `GET /reminders?list=Inbox` →
  `{"reminders": [{"id", "title", "notes"?, "due"?, "priority"?, "etag"?}]}`
- `GET /reminders/:id?list=Inbox` → one task, same shape, always with `etag`
  if the task has one -- used by the plugin's conflict check
- `POST /reminders` `{"title", "list"?, "notes"?, "due"?, "priority"?}` →
  `{"id", "title"}`
- `POST /reminders/:id` `{"list", "title"?, "notes"?, "due"?, "priority"?}` →
  the updated task. `list` is required but does NOT move the task -- see next
- `POST /reminders/:id/move` `{"fromList", "toList"}` → `{"ok": true}`
- `POST /complete` `{"ids": [...], "list"?}` → `{"completed", "failed"}`
- `POST /uncomplete` `{"ids": [...], "list"?}` → `{"uncompleted", "failed"}`
  -- undocumented by TickTick, implemented as a fallback (set `status: 0` via
  the update endpoint) and confirmed working live, not just theorized
- `DELETE /reminders/:id?list=Inbox` → `{"ok": true}`

## What was uncertain, and how it was resolved

The official docs at developer.ticktick.com couldn't be fetched directly
while building this, so it started from several independent third-party
transcriptions and confirmed everything genuinely uncertain against a real
account rather than shipping on a guess:

- **Token exchange auth method** -- sources disagreed between HTTP Basic
  (implemented) and `client_secret_post`. **Resolved: Basic auth is
  correct** -- `npm run authorize` completed end to end.
- **The `content` vs. `desc` task field** -- unclear which held
  notes/description. **Resolved: `content` is correct** -- written via
  update, read back correctly via GET.
- **Whether TickTick supports un-completing a task at all** -- not
  documented anywhere consulted. **Resolved: the `status: 0` fallback
  works** -- verified a real completed task reopened and reappeared in its
  project's incomplete list.
- **Whether updating a task's `projectId` via `POST /task/{id}` moves it**,
  vs. requiring `POST /task/move` -- genuinely never tested either way,
  because the dedicated endpoint (confirmed working) is always used instead.
  Untested by design, not an oversight.
- **Exact access token lifetime rule** -- confirmed long-lived (180 days on
  the one real token issued so far), but whether that's a fixed constant or
  varies by app/account is still unknown. The client refreshes proactively
  whenever it doesn't know for certain the token is still valid, plus
  reactively on an actual 401, so this doesn't need to be known precisely.

## Security note

Like the other backends, this has no authentication between the plugin and
the server and no TLS -- it's built for a trusted home network. Keep it on
your LAN and don't port-forward it to the internet. Given this server also
holds your TickTick tokens, that advice matters more here than for the
others.
