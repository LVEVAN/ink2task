# Ink2Task Google Tasks server

A small Node.js + TypeScript service that:

- Reads one **Google Tasks** list via the official Tasks API
- Serves it as JSON over a tiny local HTTP server (`GET /reminders`)
- Completes / un-completes tasks on request (`POST /complete`, `POST /uncomplete`)
- Creates tasks from the plugin's handwriting-capture feature (`POST /reminders`)

It speaks the **exact same HTTP contract as [`mac-server`](../mac-server/README.md)**,
so the Supernote plugin can't tell which backend it's talking to — you point the
plugin's Host/Port at this service instead of the Mac, and everything else works
the same. Unlike `mac-server`, this has no macOS/EventKit dependency, so it runs
anywhere Node runs: a VPS, a Raspberry Pi, a spare laptop, a home server.

See the top-level [README's "Choosing a backend"](../README.md#choosing-a-backend)
for the trade-offs between this and the Mac server.

## Prerequisites

- **Node.js 18 or newer** (`node --version`).
- A **Google account** with some tasks in it (tasks live in Google Tasks,
  reachable from Gmail's side panel, Google Calendar, or the Tasks mobile app).
- About 5 minutes for the one-time Google Cloud Console setup below.

## One-time Google Cloud Console setup

This part can't be scripted — Google requires you to create the OAuth
credentials yourself. Do it once; the values never change afterward.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and sign
   in with the Google account whose tasks you want to sync.
2. **Create a project** (or reuse one): click **Select a project** in the top
   bar, then **New Project** in the pop-up → give it a name like `Ink2Task`
   → **Create**, then make sure it's selected in that same picker.
3. **Enable the Tasks API:** open the **navigation menu** (☰, top-left) →
   **APIs & Services → Library**
   ([direct link](https://console.cloud.google.com/apis/library)), search for
   **Google Tasks API**, click it, and click **Enable**.
4. **Configure the consent screen** (Google's newer **Google Auth Platform**
   UI — reachable from the ☰ menu → **APIs & Services → OAuth consent screen**,
   or [direct link](https://console.cloud.google.com/apis/credentials/consent)).
   If it says *"Google Auth Platform not configured yet,"* click **Get started**
   and follow the wizard:
   - **App Information:** App name `Ink2Task`, your email as the support
     email → **Next**.
   - **Audience:** choose **External** → **Next**. (This is what older guides
     call the "User type." There's no separate dropdown anymore.)
   - **Contact Information:** your email → **Next**, agree to the policy →
     **Create**.
   - Then open **Audience** in the left menu → under **Test users** →
     **Add users** → add **your own Google account's email** → **Save**.
   - Leave the app in **Testing** status. You do **not** need to publish it or
     pass Google verification — Testing mode works indefinitely for the test
     users you listed. (Test-mode refresh tokens can expire after ~7 days of
     non-use; if the server ever reports an auth error, just run
     `npm run authorize` again.)
5. **Create the OAuth client ID:** in the Google Auth Platform, open **Clients**
   in the left menu → **Create client** (older UI: **APIs & Services →
   Credentials → Create Credentials → OAuth client ID**).
   - **Application type: Desktop app.** (This is important — Desktop apps are
     allowed to use the loopback redirect this server relies on, with no
     redirect URIs to register.)
   - Give it a name and click **Create**.
   - Copy the **Client ID** and **Client secret** from the dialog.

## Install & configure

```bash
cd google-tasks-server
npm install
cp credentials.example.env credentials.env
```

This creates a plain (non-hidden) file named **`credentials.env`** inside the
`google-tasks-server/` folder (the same directory as this README and
`package.json`) — full path:

```
Ink2Task/google-tasks-server/credentials.env
```

Open **that** `credentials.env` file in any text editor and paste in the two
values from step 5:

```
GOOGLE_CLIENT_ID=your-desktop-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Notes:
- It's a regular visible file (no leading dot). It is **not** the same as
  `credentials.example.env` (the template you copied it from) and **not**
  `~/.ink2task-google/config.json` (which holds the refresh token, written
  later by `authorize`).
- These are the *application's* credentials. They stay in `credentials.env`
  and are never written to the config file. (A dot-prefixed `.env` still works
  as a fallback, and you can also export the values as environment variables
  instead, if you prefer.)

## Authorize once

```bash
npm run authorize
```

This opens your browser to Google's consent screen. Sign in with the account
you added as a test user, and grant access to your tasks. The script runs a
tiny loopback listener to catch the redirect, exchanges the code for tokens,
and writes your **refresh token** to `~/.ink2task-google/config.json`.

You only do this once. The running server refreshes short-lived access tokens
from that stored refresh token on its own — no browser needed again.

If your browser doesn't open automatically, the script prints the URL to paste
in manually. If port 4571 is already in use, set `OAUTH_REDIRECT_PORT` in `credentials.env`
to a free port and re-run.

## Run the server

```bash
npm start
```

On startup it verifies the stored token, then prints the LAN address to point
the plugin at, e.g.:

```
Authorized. Syncing Google Tasks list: "Supernote"

Listening on http://192.168.1.42:8942
```

Keep the process running while you want the plugin to reach it. `npm start` is
fine for a quick try, but it stops when you close the terminal — for real use,
run it always-on with one of the options below.

## Running it always-on

Pick whichever fits your host. Both restart the server on crash and on reboot,
so you set it up once and forget it.

### Option A — pm2 (simplest, works on macOS / Linux / a Pi -- Windows users see Option C)

```bash
npm install -g pm2
cd google-tasks-server
pm2 start npm --name ink2task-google -- start
pm2 save            # remember it across reboots
pm2 startup         # prints one command to run (once) so pm2 launches at boot
```

Useful later: `pm2 logs ink2task-google`, `pm2 restart ink2task-google`,
`pm2 stop ink2task-google`.

### Option B — systemd (Linux servers and Raspberry Pi)

Create `/etc/systemd/system/ink2task-google.service` (adjust `User`,
`WorkingDirectory`, and the `npm` path from `which npm`):

```ini
[Unit]
Description=Ink2Task Google Tasks server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Ink2Task/google-tasks-server
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ink2task-google
systemctl status ink2task-google          # check it's running
journalctl -u ink2task-google -f           # follow its logs
```

Either way, do the `npm run authorize` step **once as the same user** before
starting the service, so the refresh token exists in that user's
`~/.ink2task-google/config.json`.

### Option C — Windows

`pm2` itself works fine on Windows, but its `pm2 startup` command (used above)
only knows how to register with systemd/launchd, not Windows' Task Scheduler --
use the `pm2-windows-startup` package instead to get the same "survives a
reboot" behavior:

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd google-tasks-server
pm2 start npm --name ink2task-google -- start
pm2 save
```

Without that extra step, plain `pm2 start` still restarts the server if it
crashes, but won't bring it back after a reboot -- you'd need to run
`pm2 resurrect` (or the two commands above) yourself after restarting the PC.
Same `npm run authorize` step first, same `pm2 logs` / `pm2 restart` commands
to manage it afterward.

## Point the plugin at this server

In Ink2Task's on-device settings (open a note → **Ink2Task** icon →
**Settings** → **Mac connection**):

- **Mac IP address / host:** the address printed above (or tap **Find server on
  Wi-Fi** if this server is on the same LAN — it advertises the same
  `"app":"ink2task"` health marker the Mac server does, so discovery finds
  it too).
- **Port:** `8942` (or whatever you set in the config file).
- **Reminders list name:** the **exact title** of the Google Tasks list to sync
  (e.g. `Supernote`). This must match a list title in your Google Tasks.

Then Fetch, check items off, and Sync exactly as with the Mac server.

## Troubleshooting: server runs fine, but the plugin can't connect

The server printing "Listening on..." only proves it's up -- it doesn't prove
the Supernote can reach it. If Fetch/Find server keeps failing, work through
these in order:

1. **Test from another device, not the host itself.** `curl http://<ip>:<port>/health`
   run *on the Pi/PC that's running the server* will succeed even if nothing
   else on the network can reach it (it's hitting itself over loopback). Run
   that same `curl` (or open the URL in a browser) from your phone or laptop
   while it's on the same Wi-Fi as the Supernote -- that's the real test.
2. **Make sure the printed IP is actually your LAN address.** A Pi or PC with
   Docker, Tailscale, a VPN client, WSL, or VirtualBox installed often has
   several virtual network adapters, and the "first" one the OS reports isn't
   always the Wi-Fi/Ethernet one. The server now lists every address it found
   at startup -- if the Supernote can't reach the top one, try the others in
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
   `sudo ufw allow 8942/tcp`. On Windows, the first time `node`/`npm` binds a
   port, Windows Defender Firewall normally prompts to allow it on
   Private/Public networks -- if that prompt was dismissed or blocked, add a
   rule manually: **Windows Defender Firewall → Advanced settings → Inbound
   Rules → New Rule → Port → TCP → 8942 (or your port) → Allow the
   connection**.
5. **Re-check host/port on the plugin side.** Typos are easy with an on-device
   keyboard -- compare digit-by-digit against what the server printed, or use
   **Find server on Wi-Fi** instead of typing it.

## Config file

`~/.ink2task-google/config.json` (created by `npm run authorize`):

```json
{
  "refreshToken": "1//0g...",
  "listName": "Supernote",
  "port": 8942
}
```

- `listName` — the Google Tasks list title to sync. Edit and restart to change.
- `port` — the HTTP port. **If you run this on the same host as `mac-server`,
  change one of them** so they don't both try to bind 8942.
- `refreshToken` — written by `authorize`; treat it like a password.

## Endpoints

Identical shapes to `mac-server`:

- `GET /health` → `{"ok": true, "app": "ink2task", "listName": "Supernote"}`
- `GET /lists` → `{"lists": ["My Tasks", "..."]}` (feeds the plugin's list picker)
- `GET /reminders?list=Supernote` →
  `{"reminders": [{"id": "...", "title": "...", "due": "2026-07-25"}]}`
  (`due` is date-only and omitted when the task has no date)
- `POST /reminders` with `{"title": "..."}` → `{"id": "...", "title": "..."}`
- `POST /complete` with `{"ids": ["..."]}` →
  `{"completed": ["..."], "failed": ["..."]}`
- `POST /uncomplete` with `{"ids": ["..."]}` →
  `{"uncompleted": ["..."], "failed": ["..."]}`

## Security note

Like `mac-server`, this has no authentication and no TLS — it's built for a
trusted network. If you run it on a Raspberry Pi or home server on your LAN,
keep it on the LAN and don't port-forward it to the internet. If you must run
it on a public VPS, put it behind a firewall / VPN / reverse proxy with
authentication — the refresh token in its config grants access to your Google
Tasks, so treat the host as sensitive.
