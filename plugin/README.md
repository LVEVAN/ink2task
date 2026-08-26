# Ink2Task (Supernote plugin half)

The Supernote-side React Native plugin. See the [top-level README](../README.md)
for the full feature set, backend choices, and install steps -- this file
covers plugin-specific build/setup details.

## What it does

1. Fetches the current items from whichever backend + list the current page
   is bound to (Apple Reminders, Google Tasks, or Todoist).
2. Writes them onto the page as checkbox + label + DUE box rows.
3. You check items off, write new ones, or write due dates directly on the
   page with the pen.
4. Tap the on-page **SYNC** button (or **Sync tasks** in the plugin) --
   checked rows complete on the backend, written rows become new tasks, due
   dates get set, and the page redraws with the fresh list.
5. A lasso selection on ANY note, plus **Add to Ink2Task** in the lasso
   toolbar, captures that handwriting as a new task with a link back to its
   source page.

## Permissions (plugin preview firmware)

On the plugin preview build the host gates file and network access, and a
plugin that doesn't request permission gets neither -- the failure looks like
"Plugin [ink2task001] has no WRITE permission on sdcard" in logcat, and like
nothing working at all from the outside.

`PluginConfig.json` declares them:

```json
"uses-permissions": [
  "plugin.permission.INTERNET",
  "plugin.permission.FILE:READ",
  "plugin.permission.FILE:WRITE",
  "plugin.permission.FILE:DELETE"
]
```

Declaring is not granting. `src/utils/permissions.ts` requests them at the
point of first use -- reading when the config is first read, writing when
something is first saved -- rather than all at once on launch. Two things there
are deliberate and worth keeping:

- **Only grants are cached.** Caching a refusal meant that after the user
  granted the permission in the tablet's own settings, syncing still failed
  from memory, with no way out but restarting the plugin.
- **Only an explicit refusal blocks.** A missing method, an error, or an
  unrecognised permission all mean "carry on", so the same build keeps working
  on firmware with no permission system.

`FILE:DELETE` is requested but never required: element and page deletion are
checked against `FILE:WRITE`, and the only real file deletion is one leftover
from the pre-rename days.

## Setup

1. Set up a backend first (see the [top-level README](../README.md#choosing-a-backend))
   and note its host/port, or get a Todoist personal API token.
2. Build the plugin:
   ```bash
   cd plugin
   export JAVA_HOME=/opt/homebrew/opt/openjdk@21
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   bash buildPlugin.sh
   ```
   Requires Node.js >= 18, JDK 21, Android SDK Platform 35 + Build-Tools
   35.0.0. Output: `build/outputs/Ink2Task.snplg` -- **install exactly this
   file**, unrenamed; the host verifies the filename against the package and
   rejects a renamed copy even if the bytes are identical.
3. Copy it to the Supernote's `MyStyle/` folder (USB, or Settings -> Browse
   and Access), then on-device: **Settings > Apps > Plugins > Install**.
4. Open a note, tap the **Ink2Task** icon in the sidebar toolbar, open
   **Settings**, and connect it to your backend (host/port, or a Todoist
   token) and choose the list to sync.

## Direct Todoist mode -- getting a long token onto the tablet

The Todoist profile talks straight to Todoist's cloud (no companion server),
so you need a **personal API token** in its settings field (Todoist ->
Settings -> Integrations -> Developer). That token is ~40 characters, and
typing it on an e-ink keyboard is miserable.

> **Copy/paste does not work in this field, and neither does the Partner
> app's keyboard sharing.** Both device-reported 2026-08-23. The field lives
> inside the Supernote plugin host, which the system paste action and the
> shared-keyboard input never reach. Only a **real keyboard the tablet is
> paired with** types into it, or skip the field entirely (option 1).

Two things actually work:

1. **Edit the config file directly -- no typing at all. Most reliable.** The
   plugin keeps its settings in `MyStyle/Ink2Task/config.json` on the tablet.
   Open the plugin once (so the file exists), then get that file onto a
   computer -- via the Supernote's **Browse and Access** web page (Settings ->
   Browse and Access, open the shown `http://...` URL in a browser) or over
   USB -- and edit it there, where copy/paste is easy. Find the profile whose
   `"backend"` is `"todoist"` and put your token in:

   ```json
   { "label": "Todoist", "backend": "todoist", "host": "", "port": 8944,
     "listName": "Inbox", "token": "YOUR-TOKEN-HERE" }
   ```

   Save it back to `MyStyle/Ink2Task/config.json` and reopen the plugin. Edit
   it while the plugin view is **closed**, or it will overwrite your change.

2. **Pair a Bluetooth keyboard** (or plug in a USB-C one) and type the token
   into the field. A text-expander macro that emits the stored token makes it
   one keystroke. Typing it by hand on the on-screen keyboard also works, it is
   just slow and easy to get wrong -- check the end of it especially.

Things that do NOT work, so you don't lose time on them: pasting into the
field, the Partner app's keyboard sharing, and copying the token out of a PDF
to paste in. Reading the token off a large-font PDF while you type is still a
reasonable trick.

## Notes on the implementation

- Layout is computed as a fraction of the page size
  (`PluginFileAPI.getPageSize`), not hardcoded pixel values, so it adapts
  across A5X / A6X2 / A5X2 screens without a rebuild.
- Detecting a checked box, or handwriting in a blank row, is done by reading
  every stroke on the page's main layer via `PluginFileAPI.getElements` and
  testing whether it falls inside a known box's region -- deliberately
  simpler than full-page OCR, since it only needs to know *where*, not *what*,
  except for the handful of boxes that actually contain new writing (those
  get OCR'd via `PluginCommAPI.recognizeElements`).
- Each row's checkbox-to-task mapping lives in
  `MyStyle/Ink2Task/checklist-registry.json`; which backend/list each page
  syncs, and lasso-capture defaults, live in `MyStyle/Ink2Task/config.json` --
  both via `react-native-fs`, since the SDK's own `FileUtils` doesn't expose
  arbitrary text read/write. These are the source of truth Sync reads from --
  task identity is never re-derived from the drawing itself.
- Config, the registry, and page bindings all live outside the plugin
  package, so they survive a plugin reinstall.
