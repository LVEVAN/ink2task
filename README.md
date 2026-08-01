# Ink2Task

A handwritten checklist for Supernote e-ink tablets that syncs with Apple
Reminders, Google Tasks, or Todoist. Write, check off, and capture tasks with
a pen, and have them show up as real tasks in whichever app you already use.

Inspired by [SuperTask](https://github.com/apclark31/supernote-plugin-research/tree/main/plugins/SuperTask),
but scoped around one dedicated checklist note instead of a full in-plugin
task-manager UI: your tasks live where you actually write, and Ink2Task keeps
that page and your task list in sync.

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
- **Follows your app's own order** -- for Google Tasks and Todoist, dragging a
  task to a new spot in the app moves it here too on the next sync. (Apple
  Reminders has no public API for its manual order, so that one stays in
  creation-date order instead.)
- **E-ink friendly by design** -- high contrast, no gradients, minimal
  redraws, and a template page with the SYNC button and layout baked into
  the background so nothing has to be drawn twice.

## Project layout

```
plugin/               React Native Supernote plugin (builds to a .snplg)
mac-server/            Swift HTTP server, Apple Reminders via EventKit
google-tasks-server/   Node/TypeScript HTTP server, Google Tasks
todoist-server/        Node/TypeScript HTTP server, Todoist (optional -- see below)
```

Each has its own README with build/setup details:
[`plugin/README.md`](plugin/README.md),
[`mac-server/README.md`](mac-server/README.md),
[`google-tasks-server/README.md`](google-tasks-server/README.md),
[`todoist-server/README.md`](todoist-server/README.md).

## Choosing a backend

Ink2Task talks to a small HTTP server over your network -- pick **one**. They
share an identical API, so the plugin doesn't know or care which is running.

| | [`mac-server`](mac-server/README.md) | [`google-tasks-server`](google-tasks-server/README.md) | Todoist |
|---|---|---|---|
| Task source | Apple Reminders (EventKit) | Google Tasks | Todoist |
| Runs on | a Mac (only), auto-starts at login | any always-on host -- VPS, Pi, laptop | **nothing to run** -- see below |
| Setup | `./setup.sh`, one Reminders permission click | Google Cloud OAuth client + one `authorize` run | paste a personal API token into the plugin |
| Availability | needs the Mac awake and on the same Wi-Fi | can be always-on, reachable from anywhere you allow | works anywhere with internet |

**Todoist is a special case: no server needed at all.** Paste a personal API
token directly into the plugin's Sync Settings. Ink2Task needs a Todoist API token to connect to your account. You can find your token at [todoist.com/app/settings/integrations/developer](https://app.todoist.com/app/settings/integrations/developer) (scroll to "API token"). You don't need an always-on Mac; instead, this talks to Todoist's cloud straight from the tablet. [`todoist-server`](todoist-server/README.md) still exists as an
optional standalone service if you'd rather keep the token off the tablet
entirely, but most people won't need it.

Data model differences worth knowing: Apple Reminders and Todoist both support
priority and a due **time**, not just a date; Google Tasks has no priority
concept and due dates are date-only.

## Install

**1. Set up a backend (For Todoist, skip this step entirely... see above). ** (pick one from the table above) -- e.g. for Apple
Reminders:

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
and either enter the host/port your server printed, or (Todoist) paste your
token. Choose the list to sync. Tap **Sync tasks**.

### Good to know

- **Same Wi-Fi** for `mac-server`/`google-tasks-server` -- the Supernote and
  the server need to be on the same network (or the server needs to be
  reachable from wherever you are, for an always-on host). Todoist mode has no
  such requirement.
- **No authentication** between the plugin and a LAN server -- built for a
  trusted home network. Don't expose those ports to the internet.

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

## Limitations

- **No offline queue.** A LAN backend has to be reachable (or you need
  internet, for Todoist) when you sync -- nothing is queued for later.
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
