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
that a shorter-lived token or refresh flow exists.

You don't need to watch the calendar for that, though: this server
auto-detects an expired or revoked token the moment a real sync from the
Supernote fails, and relaunches the same browser consent flow on its own
(a browser tab opens on whichever computer is running the server -- sign in
there and the next sync picks up the new token automatically). Running
`npm run authorize` by hand is a fallback for when that can't reach a
browser (a headless server -- it prints the URL to open elsewhere instead),
not a routine chore.

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
token is saved to `ticktick-server/config.json`. Once this is done, the
running server reconnects automatically if the token ever expires or is
revoked (see above) -- you shouldn't need to run this again unless the
server can't open a browser on its own (e.g. a headless machine).

## 4. Run the server

```bash
npm start
```

Prints the LAN address to put into Ink2Task's on-device settings: pick
TickTick as the backend on the Supernote, then enter this host and port
(default `8955`), same as the other Wi-Fi backends.

Keep the process running while you want the plugin to reach it. `npm start` is
fine for a quick try, but it stops when you close the terminal — for real use,
run it always-on with one of the options below.

## Running it always-on

Pick whichever fits your host. Both restart the server on crash and on reboot,
so you set it up once and forget it.

### Option A — pm2 (simplest, works on macOS / Linux / a Pi -- Windows users see Option C)

```bash
npm install -g pm2
cd ticktick-server
pm2 start npm --name ink2task-ticktick -- start
pm2 save            # remember it across reboots
pm2 startup         # prints one command to run (once) so pm2 launches at boot
```

Useful later: `pm2 logs ink2task-ticktick`, `pm2 restart ink2task-ticktick`,
`pm2 stop ink2task-ticktick`.

### Option B — systemd (Linux servers and Raspberry Pi)

Create `/etc/systemd/system/ink2task-ticktick.service` (adjust `User`,
`WorkingDirectory`, and the `npm` path from `which npm`):

```ini
[Unit]
Description=Ink2Task TickTick server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Ink2Task/ticktick-server
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ink2task-ticktick
systemctl status ink2task-ticktick          # check it's running
journalctl -u ink2task-ticktick -f           # follow its logs
```

Either way, do the `npm run authorize` step **once as the same user** before
starting the service, so the access token exists in
`ticktick-server/config.json`. After that, the service reconnects itself the
next time a sync hits an expired/revoked token (see above) -- on a headless
host, watch its logs for the printed consent URL when that happens, since
there's no desktop for a browser tab to open on.

### Option C — Windows

`pm2` itself works fine on Windows, but its `pm2 startup` command (used above)
only knows how to register with systemd/launchd, not Windows' Task Scheduler --
use the `pm2-windows-startup` package instead to get the same "survives a
reboot" behavior:

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd ticktick-server
pm2 start npm --name ink2task-ticktick -- start
pm2 save
```

Without that extra step, plain `pm2 start` still restarts the server if it
crashes, but won't bring it back after a reboot -- you'd need to run
`pm2 resurrect` (or the two commands above) yourself after restarting the PC.
Same `npm run authorize` step first, same `pm2 logs` / `pm2 restart` commands
to manage it afterward.

## Troubleshooting: server runs fine, but the plugin can't connect

The server printing "Listening on..." only proves it's up -- it doesn't prove
the Supernote can reach it. If Fetch/Find server keeps failing, work through
these in order:

1. **Test from another device, not the host itself.** `curl http://<ip>:<port>/health`
   run *on the machine running the server* will succeed even if nothing else
   on the network can reach it (it's hitting itself over loopback). Run that
   same `curl` (or open the URL in a browser) from your phone or laptop while
   it's on the same Wi-Fi as the Supernote -- that's the real test.
2. **Make sure the printed IP is actually your LAN address.** A Pi or PC with
   Docker, Tailscale, a VPN client, WSL, or VirtualBox installed often has
   several virtual network adapters, and the "first" one the OS reports isn't
   always the Wi-Fi/Ethernet one. The server lists every address it found at
   startup -- if the Supernote can't reach the top one, try the others in
   that list. You can cross-check against the real LAN IP with `ip addr` (Pi
   / Linux) or `ipconfig` (Windows, look for "Wireless LAN adapter Wi-Fi" or
   "Ethernet adapter").
3. **Confirm the Pi/PC and Supernote are on the same network.** Guest Wi-Fi
   networks and some mesh routers isolate wireless clients from each other
   (and from wired devices) by default -- if they're on different SSIDs, or
   your router has "AP/client isolation" or a "guest network" toggle enabled,
   they'll never see each other regardless of IP/port.
4. **Check the host's firewall.** Raspberry Pi OS usually has no firewall
   enabled by default, but if you've turned on `ufw`, allow the port:
   `sudo ufw allow <port>/tcp`. On Windows, the first time `node`/`npm` binds
   a port, Windows Defender Firewall normally prompts to allow it on
   Private/Public networks -- if that prompt was dismissed or blocked, add a
   rule manually: **Windows Defender Firewall → Advanced settings → Inbound
   Rules → New Rule → Port → TCP → your port → Allow the connection**.
5. **Re-check host/port on the plugin side.** Typos are easy with an on-device
   keyboard -- compare digit-by-digit against what the server printed, or use
   **Find server on Wi-Fi** instead of typing it.

## Config file

`ticktick-server/config.json` (gitignored) -- **treat this like a password
vault**, more so than the other backends' config files: unlike
`mac-server`'s, this one holds a live access token, because token custody is
deliberately kept server-side (see above). If you're upgrading from an
older version of this server, any existing config at
`~/.ink2task-ticktick/config.json` is moved here automatically the first
time you run it -- nothing to do by hand.

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
