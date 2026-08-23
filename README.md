# Ink2Task

A handwritten checklist for Supernote e-ink tablets that syncs with Apple
Reminders, Google Tasks, Todoist, or TickTick. Write, check off, and capture
tasks with a pen, and have them show up as real tasks in whichever app you
already use.

Inspired by [SuperTask](https://github.com/apclark31/supernote-plugin-research/tree/main/plugins/SuperTask),
but scoped around one dedicated checklist note instead of a full in-plugin
task-manager UI: your tasks live where you actually write, and Ink2Task keeps
that page and your task list in sync.

Download the plugin directly here: https://github.com/LVEVAN/ink2task/releases

**EXAMPLE**




https://github.com/user-attachments/assets/f8f735c9-a9c2-4331-af06-d9e6e91994d2





## What you can do

- **Check off tasks by hand** -- draw a check in a box, tap the on-page SYNC
  button (or the Sync button in the plugin), and the task completes on the
  backend and disappears from the page.
- **Write a new task straight onto the page** -- fill in a blank row and it
  becomes a real task on the next sync, no typing on a keyboard required.
- **Handwrite due dates** -- write `12/25`, `Dec 25`, `tomorrow`, or a weekday
  into a row's DUE box and it's parsed and set on the task (Apple Reminders and
  Todoist support a time of day too, e.g. `2:30pm`).
- **Lasso capture from ANY note** -- select handwriting anywhere in your
  notebooks, tap **Add to Ink2Task**, and it's OCR'd into a new task with a
  tappable link back to the note page it came from.
- **Multiple lists, multiple backends, one note** -- each page of the note can
  sync a different list, and even a different backend entirely (e.g. one page
  for Todoist, another for Apple Reminders). Ink2Task remembers what each page
  is bound to.
- **Priority flags** -- a small flag + number shows each task's priority
  (Todoist's p1-p4, Apple Reminders' flag tiers). Visual only -- it never
  reorders the list out from under you.
- **Follows your app's own order** -- for Google Tasks, Todoist, and TickTick,
  dragging a task to a new spot in the app moves it here too on the next sync.
  (Apple Reminders doesn't expose a reliable manual order through its API, so
  it stays in creation-date order instead -- a new task, handwritten or
  lassoed, always lands at the bottom.)
- **See what a sync is doing** -- tapping the on-page SYNC button shows a small
  floating status bubble ("Reading the page…", "Saving…") so the device doesn't
  just look frozen while it works. It's non-interactive, so you can keep
  writing straight through it.
- **E-ink friendly by design** -- high contrast, no gradients, minimal
  redraws, and a template page with the SYNC button and layout baked into
  the background so nothing has to be drawn twice.

## Project layout

```
plugin/                React Native Supernote plugin (builds to a .snplg)
mac-server/            Swift HTTP server, Apple Reminders via EventKit
google-tasks-server/   Node/TypeScript HTTP server, Google Tasks
todoist-server/        Node/TypeScript HTTP server, Todoist (optional -- see below)
.claude/skills/        Supernote plugin-dev reference for Claude Code (see below)
```

Each has its own README with build/setup details:
[`plugin/README.md`](plugin/README.md),
[`mac-server/README.md`](mac-server/README.md),
[`google-tasks-server/README.md`](google-tasks-server/README.md),
[`todoist-server/README.md`](todoist-server/README.md).

## Choosing a backend

Ink2Task talks to a small HTTP server over your network -- pick **one**. They
share an identical API, so the plugin doesn't know or care which is running.

| | [`mac-server`](mac-server/README.md) | [`google-tasks-server`](google-tasks-server/README.md) | Todoist | [`ticktick-server`](ticktick-server/README.md) |
|---|---|---|---|---|
| Task source | Apple Reminders (EventKit) | Google Tasks | Todoist | TickTick |
| Runs on | a Mac (only), auto-starts at login | any always-on host -- VPS, Mac, PC, Pi, laptop | **nothing to run** -- see below | any always-on host -- VPS, Mac, PC, Pi, laptop |
| Setup | `./setup.sh`, one Reminders permission click | Google Cloud OAuth client + one `authorize` run | get a personal API token into the plugin | TickTick OAuth client + one `authorize` run |
| Availability | needs the Mac awake and on the same Wi-Fi | can be always-on, reachable from anywhere you allow | works anywhere with internet | can be always-on, reachable from anywhere you allow |

**Todoist is a special case: no server needed at all.** A personal API token
goes straight into the plugin's Sync Settings. Note that the settings fields
cannot paste, so see [the plugin README](plugin/README.md#direct-todoist-mode----getting-a-long-token-onto-the-tablet)
for the ways that actually get a 40-character token in. Ink2Task needs a Todoist API token to connect to your account. You can find your token at [todoist.com/app/settings/integrations/developer](https://app.todoist.com/app/settings/integrations/developer) (copy the "API token"). You don't need an always-on Mac or PC; instead, this talks to Todoist's cloud straight from the tablet. [`todoist-server`](todoist-server/README.md) still exists as an
optional standalone service if you'd rather keep the token off the tablet
entirely, but most people won't need it.

Data model differences worth knowing: Apple Reminders, Todoist, and TickTick
all support priority and a due **time**, not just a date; Google Tasks has no
priority concept and due dates are date-only. **Subtasks** (shown on the page
with a bold `>`, and creatable by writing `>` in front of a task) work on
Todoist, Google Tasks, and TickTick; Apple Reminders cannot do them at all,
because EventKit exposes no subtask API. Google Tasks allows exactly one level
of nesting, Todoist allows several.

### Deploying a server, per backend

Every server is deployed the same way: get its credentials, install, authorize
once, then leave it running. Pick your row and follow that README, which has
the full walkthrough including the always-on options (pm2, systemd, a macOS
LaunchAgent, or Windows).

Open a terminal first. On Mac that is the **Terminal** app (Spotlight search,
or Applications > Utilities > Terminal); on Windows press Start and type
**PowerShell**. Then `git clone` this repo and `cd` into it.

| Backend | What you need first | Then run | Default port |
|---|---|---|---|
| **Todoist** (easiest) | a personal API token | nothing, the token goes into the plugin | none |
| [Apple Reminders](mac-server/README.md) | a Mac, Xcode command line tools | `cd mac-server && ./setup.sh` | 8942 |
| [Google Tasks](google-tasks-server/README.md) | a Google Cloud OAuth client | `cd google-tasks-server && npm install && npm run authorize && npm start` | 8942 |
| [TickTick](ticktick-server/README.md) | a TickTick OAuth client | `cd ticktick-server && npm install && npm run authorize && npm start` | 8955 |
| [Todoist server](todoist-server/README.md) (optional) | a personal API token | `cd todoist-server && npm install && npm start` | 8942 |

`setup.sh` is Apple-only and does everything at once: builds, installs a
login-time service, asks which Reminders list to use, and prints the address to
type into the plugin.

Each server prints its own LAN address when it starts, for example
`Listening on http://10.0.0.3:8955`. Put that host and port into the plugin's
Sync Settings, then tap **Test my setup** to confirm the two halves agree
before syncing anything real.

**If you run more than one server, change the ports.** Apple, Google Tasks, and
the optional Todoist server all default to **8942**, so starting a second one
without editing its `config.json` will fail to bind, or worse, leave the plugin
talking to whichever grabbed the port first. Only TickTick differs out of the
box, at 8955. Set a distinct `port` in each server's `config.json` and restart
it. Running several is otherwise fine and is what makes
[Multiple lists on one note](#multiple-lists-on-one-note) work, with different
pages syncing to different backends.

## Install

**1. Set up a backend** (pick one from the table above -- for Todoist, skip
this step entirely, see above). Example for Apple Reminders: open the
**Terminal** app on your Mac (Spotlight search, or Applications > Utilities >
Terminal), then run:

```bash
git clone <this-repo>
cd Ink2Task/mac-server
./setup.sh
```

`setup.sh` builds the server, installs it as a login-time service (auto-starts,
restarts on crash), asks which Reminders list to sync, and prints your Mac's
LAN address. macOS will ask to allow Reminders access the first time -- click
**Allow**. 

**2. Install the plugin.** Grab `Ink2Task.snplg` from the
[latest release](../../releases), or build it yourself (see below). Copy it to
the Supernote's `MyStyle/` folder (USB, or Settings -> Browse and Access), then
on-device: **Settings > Apps > Plugins > Install**. The plugin writes its own
page template on first use -- nothing else to copy over.

**3. Connect it.** Open any note, tap the **Ink2Task** icon, open **Settings**,
and either enter the host/port your server printed, or (Todoist) enter your
token (the field cannot paste -- see the plugin README for the easy routes). Choose the list to sync. Tap **Sync tasks**.

### Good to know

- **Same Wi-Fi** for `mac-server`/`google-tasks-server` -- the Supernote and
  the server need to be on the same network (or the server needs to be
  reachable from wherever you are, for an always-on host). Todoist mode has no
  such requirement.
- **No authentication** between the plugin and a LAN server -- built for a
  trusted home network. Don't expose those ports to the internet.

## Updating

Ink2Task has two halves that update **separately**: the plugin on the tablet,
and the backend server on your computer. Neither updates itself, and neither
notices when the other is out of date, so a feature that needs both can look
broken when it is only half-installed. Update both when a release mentions
server changes.

**1. Update the plugin.** Download the new `Ink2Task.snplg` from the
[latest release](../../releases) and copy it to `MyStyle/` as during install.
Then on-device: **Settings > Apps > Plugins**, **remove Ink2Task first**, then
**Install**. The remove step is required every time -- the plugin host keeps an
unpacked copy, so installing over the top can leave the old code running. Your
settings, list bindings, and existing pages are kept.

**2. Update the server** (skip if you use Todoist without a server). Open a
terminal in the folder you cloned, then:

```bash
git pull
```

On Mac, open the **Terminal** app (Spotlight search, or Applications >
Utilities > Terminal). On Windows, press Start and type **PowerShell**. Then
`cd` into the folder you cloned before running the command above.

For the Node servers (Todoist, Google Tasks, TickTick), install any new
dependencies and restart:

```bash
npm install
```

Then stop the running server with **Ctrl+C** and start it again with
`npm start`. If you set it up as an always-on service, restart that instead:
`pm2 restart ink2task-<backend>`, or `sudo systemctl restart <service>` on
Linux, or for a macOS LaunchAgent
`launchctl kickstart -k gui/$(id -u)/com.ink2task.<backend>`.

For the Apple Reminders server, rebuild it and restart the service:

```bash
cd mac-server && ./setup.sh
```

**3. Check the two halves agree.** In the plugin, open **Settings** and tap
**Test my setup**. If your server is older than your plugin, the result says so
in plain language and names what is missing. Everything that worked before
keeps working either way -- an out-of-date server loses newer display details,
not syncing.

## Usage

### On-page sync

The template page draws a **SYNC** button in the corner. Tap it (finger or
pen) without even opening the plugin -- it reads the page, completes anything
checked off, creates anything newly written, and redraws the list.

### Handwritten capture

Write a task title into any blank row (and, optionally, a date into its DUE
box) and tap Sync. It becomes a real task on the backend and the row fills in
with the typed version.

### Lasso capture

On any note (not just the Ink2Task page), lasso some handwriting and tap **Add
to Ink2Task** in the lasso toolbar. It's recognized, split into a title + due
date if one's written, and created as a task -- with a link back to the note
it came from. By default it lands on whichever Ink2Task page you synced most
recently; pin it to a specific page/list instead in Settings under **Lasso
Capture Target**.

### Multiple lists on one note

Add a new note page to the Ink2Task note with the device's own note tools, sync it
(from the plugin's Settings, choosing whatever list/backend you want), and it
becomes its own independent checklist -- its own SYNC button, its own bound
list. Lasso captures and the on-page SYNC button both automatically use
whichever page/backend they belong to.

## How checkbox detection works

Ink2Task doesn't run OCR to know what you drew, just where. When it writes
the checklist it remembers each row's position in a small on-device registry.
On sync, it reads every pen stroke on the page and checks whether each one's
center falls inside a known checkbox or a blank writable row. Only what the
backend confirms completed or created gets erased/redrawn.

## Troubleshooting

- **After installing a new build, the on-page SYNC button doesn't respond at
  all, even though you removed the old plugin first.** A "remove then
  install" only replaces the plugin's files on disk -- the Supernote's
  note-taking app can keep an OLDER copy of the plugin's code running in
  memory from before the reinstall, so you end up with two versions racing
  each other in the background (device-confirmed via two duplicate tap
  listeners firing on every touch). **Reboot the Supernote after installing**
  -- that fully clears the old copy. Do this any time the on-page button
  seems dead right after a fresh install, even if you're sure you removed
  the old one correctly first.

- **The on-page SYNC button stops responding, but "Sync tasks" in the plugin
  still works.** Fixed as of v1.0.19: a hung native call could previously get
  the button stuck in a "busy" state forever, with no visible error --
  reinstalling the plugin didn't help, only a device reboot did. On-page
  syncs (and lasso capture, which shares the same state) now time out after
  60 seconds instead of hanging indefinitely, so the button recovers on its
  own. If you're on an older build and this happens, reboot the Supernote --
  that clears it. On a current build, if the button still won't respond
  after 60+ seconds, look for a "timed out" error dialog; that's now the
  starting point for diagnosing it rather than the timeout being silent.

- **A tap in the SYNC button's corner spot occasionally fires a sync even
  when you're not on the checklist note** (e.g. on the note picker screen).
  This is a confirmed Supernote SDK limitation, not an Ink2Task bug: the
  APIs the plugin uses to check "which note is open" appear to report the
  last note *this plugin* touched rather than what's genuinely on screen --
  since Ink2Task only ever touches its own note, that check can't reliably
  tell the two apart, and there's no other API available to do better. The
  impact is bounded -- a stray sync only ever writes to the Ink2Task note
  itself, never whatever you were actually looking at -- so the worst case
  is an unwanted redraw and a dialog to dismiss, not lost work elsewhere.

## Limitations

- **No offline queue for new tasks.** Creating a task -- handwritten or
  lassoed -- needs its backend reachable at sync time, for every backend
  including TickTick; if it isn't, that capture fails outright rather than
  queuing. (TickTick is the one exception for *edits* to a task that's
  already synced: completions, un-completions, and handwritten due-date
  changes queue in an offline outbox and retry on the next successful sync --
  see `ticktick-server`'s README. The other three backends have no such queue
  for anything.) A backend server also has to be reachable at all -- on your
  LAN for `mac-server`/`google-tasks-server`/`ticktick-server`, or just
  internet for Todoist, which talks to Todoist's cloud directly with no
  server of its own.
- **Apple Reminders can't follow manual (drag-to-reorder) order.** There's no
  public EventKit API for it, so that backend stays in creation-date order.
- **Google Tasks has no priority and no due time**, just a date -- a platform
  limitation, not a missing feature.
- **Renaming the Ink2Task note** breaks any lasso back-links pointing at it.
- **No background sync.** Sync only happens when you tap SYNC (on-page or in
  the plugin).

## Tested devices

- Supernote A5X (10.2" e-ink)

Should work on any Supernote that supports the plugin system (A5X, A6X2
Nomad, A5X2 Manta), since layout is computed from the page size rather than
hardcoded, but only the A5X has been tested.

## Building from source

```bash
cd plugin
export JAVA_HOME=/opt/homebrew/opt/openjdk@21   # or wherever your JDK 21 lives
export ANDROID_HOME="$HOME/Library/Android/sdk"
bash buildPlugin.sh
# Output: build/outputs/Ink2Task.snplg
```

Requires Node.js >= 18, JDK 21, Android SDK Platform 35 + Build-Tools 35.0.0.

## Architecture

Ink2Task's plugin half is a React Native app running inside Supernote's
PluginHost process, using the `sn-plugin-lib` SDK to read/write note pages and
`react-native-fs` for on-device config/registry storage (outside the plugin
package, so it survives reinstalls). The checklist is drawn as native SDK
elements -- checkbox rectangles, text, priority-flag geometry, and (for lasso
captures) links back to the source note -- all on the note's main layer.

Key pieces:
- **Checklist registry** (`checklist-registry.json`) -- maps each row's slot to
  a task id, per note page, so a redraw knows what it drew last time.
- **Page bindings** (`config.json`) -- which backend + list each page of the
  note syncs, and which page a lasso capture should default to.
- **Ghost-stroke protection** -- ink the host restores after an uninstall gets
  fingerprinted and ignored on the first sync after install, so it can't be
  misread as a real checkmark.
- **Backend abstraction** (`src/api/`) -- one HTTP contract
  (`/health`, `/lists`, `/reminders`, `/complete`, `/uncomplete`) implemented
  by three interchangeable servers, plus a direct-to-Todoist client that
  skips the server entirely.
- **Sync-progress overlay** (`android/.../Ink2TaskOverlayModule.kt`) -- a custom
  Android NativeModule that draws a floating status bubble with
  `TYPE_APPLICATION_OVERLAY`. The JS SDK can't do this: `showPluginView()` takes
  no arguments and only opens fullscreen, so an on-page sync used to run ~18s
  with nothing on screen. The bubble is deliberately `FLAG_NOT_TOUCHABLE` so pen
  and finger input pass straight through to the note underneath.

## Developing with Claude Code

This repo was built with [Claude Code](https://claude.com/claude-code), and
carries a skill at `.claude/skills/supernote-plugin-dev/` so future sessions
start with the SDK's API surface and constraints already to hand instead of
rediscovering them.

The skill is vendored from [AgP42/supernote-dashboard](https://github.com/AgP42/supernote-dashboard)
(see Credits). Its `SKILL.md` opens with an **Ink2Task local corrections**
block, because a few of its rules are wrong for this codebase -- most
importantly its advice to call `saveCurrentNote()` *before* `replaceElements`,
which on our redraw path silently leaves the user's handwriting behind. That
was a bug which took roughly ten build-and-test cycles on real hardware to
track down, so the correction is worth keeping in front of anyone (human or
model) reading the skill.

## Credits

- **[SuperTask](https://github.com/apclark31/supernote-plugin-research/tree/main/plugins/SuperTask)**
  by [@apclark31](https://github.com/apclark31) -- the plugin that inspired
  Ink2Task, and the reference for how a Supernote plugin is structured, built,
  and packaged. Ink2Task takes a deliberately different shape (one dedicated
  checklist note you write on, rather than a task-manager UI inside the
  plugin), but it exists because SuperTask showed it was possible.
- **[AgP42/supernote-dashboard](https://github.com/AgP42/supernote-dashboard)**
  (MIT) -- source of the vendored `supernote-plugin-dev` skill. Its notes on
  element recycling fixed a native memory leak here, and its floating-window
  pattern is the basis of the sync-progress overlay.
- **[Laumss/Inkling](https://github.com/Laumss/Inkling)** (MIT) -- the skill's
  original author, via supernote-dashboard.
- **[Ratta Supernote](https://supernote.com)** -- for the
  [`sn-plugin-lib` SDK](https://docs.supernote.com/en) and the plugin system
  that makes any of this possible.

Upstream licenses are preserved alongside the vendored files
(`.claude/skills/supernote-plugin-dev/LICENSE-upstream.txt`).
