# Ink2Task Mac server

A small command-line Swift program that:

- Reads one Apple Reminders list via EventKit
- Serves it as JSON over a tiny local HTTP server (`GET /reminders`)
- Completes reminders on request (`POST /complete`)

No external dependencies -- just the system `EventKit` and `Network`
frameworks, so `swift build` works fully offline once Xcode's command
line tools are installed.

## Setup (recommended)

```bash
cd mac-server
./setup.sh
```

This builds the server, installs it to a stable location outside any cloud
folder, sets it up as a login-time LaunchAgent (auto-starts, restarts on
crash), writes a default config, and prints the LAN address to put into
Ink2Task's on-device settings. Safe to re-run any time -- it just refreshes
everything. macOS will prompt for Reminders access the first time it runs --
approve it (or grant it manually later in **System Settings > Privacy &
Security > Reminders** and re-run `./setup.sh`).

To change which list it syncs, edit `~/.ink2task/config.json` (see below) and
restart it: `launchctl kickstart -k gui/$(id -u)/com.ink2task.server`.

After rebuilding from source, refresh the running copy the same way setup.sh
does:

```bash
swift build -c release
cp .build/release/Ink2TaskServer ~/.ink2task/
launchctl kickstart -k gui/$(id -u)/com.ink2task.server
```

## Manual run (without the LaunchAgent)

```bash
cd mac-server
swift build -c release
.build/release/Ink2TaskServer
```

Useful for development/debugging. Logs go to stdout instead of
`~/.ink2task/server.log`.

## Updating

This server and the tablet plugin update **separately**, and neither notices
when the other is out of date. When a release changes both, update both.

Open the **Terminal** app (Spotlight search, or Applications > Utilities >
Terminal), `cd` into the folder you cloned, then:

```bash
git pull
```

```bash
cd mac-server && ./setup.sh
```

`setup.sh` rebuilds the binary, refreshes the copy the LaunchAgent runs from,
and restarts the service. Running it again on an existing install is safe.

Rebuilding alone is **not** enough: the LaunchAgent runs a copy at
`~/.ink2task/Ink2TaskServer`, not the binary in `.build/release`, so a fresh
build that is never copied across changes nothing. If you build by hand instead
of using `setup.sh`, copy it over and restart:

```bash
cp .build/release/Ink2TaskServer ~/.ink2task/ && launchctl kickstart -k gui/$(id -u)/com.ink2task.server
```

Note that subtask markers are **not available on Apple Reminders** at any
version. EventKit exposes no subtask API, so this is a permanent limitation of
the backend rather than something a server update fixes. The plugin knows this
and will not tell you to update your server over it.

## Config file

`~/.ink2task/config.json`:

```json
{
  "listName": "Supernote",
  "port": 8942
}
```

## Endpoints

- `GET /health` → `{"ok": true, "app": "ink2task", "backend": "apple", "listName": "Supernote"}`
- `GET /lists` → `{"lists": ["Inbox", "Family", "..."]}` (feeds the plugin's list picker)
- `GET /reminders?list=Supernote` →
  `{"reminders": [{"id": "...", "title": "...", "due": "2026-07-25T14:30", "priority": 1}]}`
  (`due`/`priority` omitted when not set; `priority` is 1-3, mapped from
  EKReminder's High/Medium/Low flag tiers)
- `POST /reminders` with `{"title": "...", "due": "2026-07-25"}` (`due`
  optional) → `{"id": "...", "title": "..."}`
- `POST /complete` with `{"ids": ["..."]}` →
  `{"completed": ["..."], "failed": ["..."]}`
- `POST /uncomplete` with `{"ids": ["..."]}` →
  `{"uncompleted": ["..."], "failed": ["..."]}`

## Security note

This server has no authentication and no TLS -- it's built for a single
trusted device on your home wifi, deliberately, to keep things simple. Don't
expose the port outside your LAN (e.g. via router port-forwarding).
