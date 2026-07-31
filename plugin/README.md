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
so you paste a **personal API token** into its settings field (Todoist ->
Settings -> Integrations -> Developer). That token is ~40 characters, and
typing it on an e-ink keyboard is miserable. Better ways:

1. **Keyboard Sharing via the Supernote Partner app (recommended).** The
   desktop Supernote Partner app can pair your computer's keyboard with the
   tablet -- click the **keyboard icon** in the app (it opens **"Supernote
   Linking"**). Once linked you can type into the token field with your
   computer keyboard, and it also **bridges copy/paste** between the two: copy
   the token on your computer, tap the token field on the tablet, and paste.
   No third-party tools needed.

2. **Copy it from a PDF or document.** Current Supernote firmware supports
   selecting and copying text (the text-selection pen) in **PDF, EPUB, CBZ,
   FB2, and XPS** files. Put the token in one, open it on the tablet, select
   and copy it, then paste it into the token field. (Older firmware without
   text selection can't do this -- update first, or use another option.)

3. **Edit the config file directly -- no typing at all.** The plugin keeps its
   settings in `MyStyle/Ink2Task/config.json` on the tablet. Open the plugin
   once (so the file exists), then get that file onto a computer -- via the
   Supernote's **Browse and Access** web page (Settings -> Browse and Access,
   open the shown `http://...` URL in a browser) or over USB -- and edit it
   where copy/paste is easy. Find the profile whose `"backend"` is
   `"todoist"` and add your token:

   ```json
   { "label": "Todoist", "backend": "todoist", "host": "", "port": 8944,
     "listName": "Inbox", "token": "PASTE-YOUR-TOKEN-HERE" }
   ```

   Save it back to `MyStyle/Ink2Task/config.json` and reopen the plugin. Edit
   it while the plugin view is **closed** so it doesn't overwrite your change.

4. **Plug in a USB-C keyboard** and type the token into the field (a
   text-expander macro that emits the stored token makes it one keystroke).

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
