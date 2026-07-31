# Ink2Task Todoist server

A small Node.js + TypeScript service that:

- Reads one **Todoist** project via the unified `/api/v1` REST API
- Serves it as JSON over a tiny local HTTP server (`GET /reminders`)
- Completes / reopens tasks on request (`POST /complete`, `POST /uncomplete`)
- Creates tasks from the plugin's handwriting/text-box capture (`POST /reminders`)

It speaks the **exact same HTTP contract as [`mac-server`](../mac-server/README.md)
and [`google-tasks-server`](../google-tasks-server/README.md)**, so the Supernote
plugin can't tell which backend it's talking to — point the plugin's Host/Port at
this service and everything works the same. It has **no runtime dependencies**
(plain `fetch` against Todoist) and **no macOS dependency**, so it runs anywhere
Node runs: a VPS, a Raspberry Pi, a spare laptop.

**Most people won't need this at all.** The plugin can talk to Todoist
*directly* from the tablet with just a personal API token pasted into Sync
Settings — no server, no host to keep running. This standalone service exists
for the alternative: if you'd rather keep the token off the tablet entirely
and have it live in a config file on a server instead. See the top-level
[README's "Choosing a backend"](../README.md#choosing-a-backend) for the
full comparison.

## Prerequisites

- **Node.js 18 or newer** (`node --version`) — needs the built-in global `fetch`.
- A **Todoist account** with a project you want to sync.

## 1. Get your Todoist API token

This is the only manual step, and it takes about a minute:

1. Open Todoist (the web app at [todoist.com](https://todoist.com/) or the
   desktop app) and go to **Settings**.
2. Open the **Integrations** tab, then the **Developer** section.
3. Find **API token** (also called your *personal* token) and **copy** it.

That token is like a password — it grants full access to your Todoist. Don't
share it or commit it anywhere.

## 2. Install & configure

```bash
cd todoist-server
npm install
npm start
```

The first `npm start` has no token yet, so it **writes a template config file**
and exits, telling you where:

```
~/.ink2task-todoist/config.json
```

Open that file and paste in your token (and set the project name you want to
sync):

```json
{
  "token": "0123456789abcdef0123456789abcdef01234567",
  "listName": "Supernote",
  "port": 8942
}
```

- `token` — your Todoist personal API token from step 1.
- `listName` — the **exact name** of the Todoist **project** to sync.
- `port` — leave at `8942` (matches the other backends) unless it clashes.

There is **no `authorize` step** for this backend — pasting the token is all the
setup there is.

## 3. Run the server

```bash
npm start
```

On startup it verifies the token, then prints the LAN address to point the
plugin at, e.g.:

```
Authorized. Syncing Todoist project: "Supernote"

Listening on http://192.168.1.42:8942
```

Keep the process running while you want the plugin to reach it. On an always-on
host, run it under a process manager so it survives logout and restarts (see
**Running it always-on** below).

## Point the plugin at this server

In Ink2Task's on-device settings (open a note → **Ink2Task** icon →
**Settings** → **Sync Settings**):

- **Server IP / host:** the address printed above (or tap **FIND SERVER ON
  WI-FI** if it's on the same LAN — it advertises the same `"app":"ink2task"`
  health marker the other backends do, so discovery finds it too).
- **Port:** `8942` (or whatever you set in the config file).
- **List name:** the **exact name** of the Todoist project to sync (Step 2 in
  the plugin can pick it from the list this server reports).

Then Fetch, check items off, and Sync exactly as with the other backends.

## Config file

`~/.ink2task-todoist/config.json`:

```json
{
  "token": "your-personal-api-token",
  "listName": "Supernote",
  "port": 8942
}
```

If you run this on the **same host** as another backend, change the `port` so
they don't both try to bind 8942.

## Running it always-on

Same options as the other backends — pick whichever fits your host. Both restart
on crash and at boot.

### Option A — pm2 (simplest; macOS / Linux / a Pi)

```bash
npm install -g pm2
cd todoist-server
pm2 start npm --name ink2task-todoist -- start
pm2 save
pm2 startup   # prints one command to run once so pm2 launches at boot
```

### Option B — systemd (Linux servers and Raspberry Pi)

Create `/etc/systemd/system/ink2task-todoist.service` (adjust `User`,
`WorkingDirectory`, and the `npm` path from `which npm`):

```ini
[Unit]
Description=Ink2Task Todoist server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Ink2Task/todoist-server
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ink2task-todoist
journalctl -u ink2task-todoist -f   # follow logs
```

## Endpoints

Identical shapes to the other backends:

- `GET /health` → `{"ok": true, "app": "ink2task", "listName": "Supernote"}`
- `GET /lists` → `{"lists": ["Inbox", "Work", "..."]}` (feeds the plugin's list picker)
- `GET /reminders?list=Supernote` →
  `{"reminders": [{"id": "...", "title": "...", "due": "2026-07-25"}]}`
  (`due` is omitted when the task has no date)
- `POST /reminders` with `{"title": "..."}` → `{"id": "...", "title": "..."}`
- `POST /complete` with `{"ids": ["..."]}` →
  `{"completed": ["..."], "failed": ["..."]}`
- `POST /uncomplete` with `{"ids": ["..."]}` →
  `{"uncompleted": ["..."], "failed": ["..."]}`

## Security note

Like the other backends, this has no authentication and no TLS between the
plugin and the server — it's built for a trusted network. Keep it on your LAN
and don't port-forward it to the internet. If you must run it on a public VPS,
put it behind a firewall / VPN / reverse proxy — the token in its config grants
full access to your Todoist, so treat the host as sensitive.
