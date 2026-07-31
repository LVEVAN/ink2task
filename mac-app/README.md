# Ink2Task Mac app — design vision (not built yet)

> **Status:** starting idea only. No code here yet. This doc captures the
> direction so we build the right thing, not the first thing.

## The one-line idea

A Mac companion that talks to the plugin's **structured checklist data via
Supernote Cloud** — keeping stable task IDs for reliable **two-way** sync —
instead of OCRing freeform handwriting pages. More work than the OCR route, but
it's the only path that gets us **both** "no LAN server" **and** dependable
two-way sync.

## Why this, and why now

Everything built so far works, but two pain points keep recurring:

1. **The LAN server tax.** `mac-server` (and the Node backends) must be running,
   and the Supernote must be on the **same Wi-Fi**. Switching networks breaks
   the IP; the Mac has to stay awake and reachable. (Direct-Todoist removed this
   for one backend, but only because Todoist has a trivial token + REST API.)
2. **OCR is fragile, and the device can't delete user ink.** Freeform
   handwriting recognition is unreliable, and we learned the SDK can't delete
   individual user strokes — which is why the plugin now *wipes the whole page
   and redraws clean* each sync. That works, but it means the page is a
   render target, not a source of truth.

The insight that makes two-way sync tractable is **stable identity**: the
plugin already maps every checkbox to a real task ID in
`MyStyle/Ink2Task/checklist-registry.json`. Reconciling changes both
directions is only hard when identity is fuzzy (freeform OCR → "duplicate
chaos," which is exactly why Kioku Relay went one-way). With stable IDs, it's a
normal sync problem.

## The hybrid, sketched

```
Supernote (plugin)                 Supernote Cloud                 Mac app
------------------                 ---------------                 -------
writes structured state  ───────►  syncs the files   ◄──────────  reads structured state
(registry + completions)                                          reconciles two-way
reads back desired state ◄───────  syncs the files   ──────────►  writes desired state
                                                                   talks to task backend
                                                                   (Apple / Google / Todoist)
```

- The **plugin stays the on-device half**, but its job narrows to: draw the
  checklist, detect checkmarks, and **write structured results** (which task IDs
  got checked, what's on the page) to a file under `MyStyle/Ink2Task/` — no
  freeform OCR involved.
- **Supernote Cloud** is the transport. The Mac app authenticates with the
  user's own Supernote account (the model Relay uses) and reads/writes those
  structured files — so **no LAN server, no same-Wi-Fi requirement**, works
  from anywhere both sides have internet.
- The **Mac app** owns reconciliation and talks to the task backend directly
  (EventKit for Apple, or the REST APIs for Google/Todoist). Because it works
  from stable IDs, it can push completions *and* pull remote changes without
  duplicating or losing anything.

## Shape of the app (UX)

**Menu-bar-first, with a setup window.**

- **Menu bar is the primary surface.** A status-bar item (SwiftUI
  `MenuBarExtra`) that lives up top, always running quietly. Its dropdown shows
  **sync status at a glance** (last synced, up-to-date / syncing / error) and a
  few quick actions — **Sync now**, open the setup window, pause/resume. Day to
  day, the user never opens a real window; they glance at the menu bar and maybe
  hit "Sync now."
- **A setup window, opened from the menu, makes *getting started* easy.** This
  is where the one-time and occasional configuration lives so it isn't crammed
  into a tiny dropdown: sign in to **Supernote Cloud**, pick the **task backend**
  (Apple / Google / Todoist) and enter its credentials, **map** a Supernote
  checklist to a task list/project, and set sync cadence. Think "first-run
  wizard + preferences," not a window you keep open.

This split is the point of the whole app: the *hard part* (connecting the
plugin's data, the cloud account, and the task backend) gets a real window with
room to breathe, so sync is easy to set up — and once it's set up, it's just a
quiet menu-bar icon doing two-way sync in the background.

Stack implication: **SwiftUI macOS menu-bar app** (`MenuBarExtra`) is the
natural fit — it gives the menu-bar item and the setup window in one native app,
with EventKit right there for the Apple backend and HTTPS for the rest.

## What it is NOT

- **Not** an OCR-of-freeform-pages app (that's SuperTask / Kioku Relay's model,
  and it's why they're one-way or fuzzy).
- **Not** another LAN server. The whole point is to drop the "server on your
  Wi-Fi" requirement.
- **Not** a replacement for the plugin — the plugin remains the pen-and-paper
  surface; the Mac app is the sync brain.

## Key unknowns to validate FIRST (before writing app code)

This whole idea rests on one assumption that must be checked before committing:

1. **Does Supernote Cloud expose the plugin's files to a program?**
   - Does Cloud even sync `MyStyle/` (where the plugin's registry lives), or
     only `Note/` / `Document/`? If not, the plugin may need to write its
     structured state somewhere Cloud *does* sync.
   - Is there a usable (even unofficial) Cloud API to list/read/write a user's
     files with their own account? Relay reads notes from "users' own Supernote
     cloud accounts," so *some* access exists — confirm its shape and stability.
2. **How does completion state cross the boundary?** The registry maps
   checkbox→ID, but "checked" lives in pen strokes. Plan: the plugin detects
   checks on-device (it already does) and writes an explicit
   `completed: [ids]` / `open: [ids]` structured file — the Mac app should never
   have to parse `.note` strokes or do OCR.
3. **Latency / polling model.** Cloud sync isn't instant. Is the Mac app a
   background poller? Push? How fresh does "two-way" need to feel?

If #1 turns out to be a dead end, the fallback is honest: keep a lightweight
LAN/cloud relay (one of the existing servers) rather than force a bad cloud
integration.

## Spike findings — Supernote Cloud access (verdict: feasible, with caveats)

First look at the make-or-break unknown. Short version: **a program can reach a
Supernote Cloud account, including read _and_ write — so the hybrid isn't a dead
end.** It's an *unofficial* path, which is the main risk.

- **It exists, unofficially.** Several community libraries drive Supernote Cloud
  by replaying the web app's network calls:
  [`supernote-cloud-api`](https://github.com/adrianba/supernote-cloud-api) (JS/TS
  — `login`, `fileList`, `fileUrl`/download, `syncFiles`),
  [`sncloud`](https://github.com/julianprester/sncloud) (Python — list,
  **download, and upload**), and others.
- **Read: yes** (list folders + download files). **Write: yes** — `sncloud`
  documents upload, so the two-way direction (Mac writes desired state back for
  the plugin to read) is supported by the underlying API, not just reads.
- **Auth = the user's Supernote email + password → an access token.** So the app
  needs the user's Supernote login. That's a real design point: handle it like
  any password (Keychain, never logged), and it's their own account.
- **The catch: it's reverse-engineered.** All of these "may stop working if
  Supernote modifies the cloud API." Mitigations: the surface is just a handful
  of plain HTTPS calls (easy to re-patch), and we keep the existing LAN/cloud
  servers as a fallback transport.

### Live-account verification (2026-07-27) — the make-or-break check PASSED

Ran the spike against a real account. Two concrete results:

- **CSRF handshake is now required.** Since these libraries were written,
  Supernote put the cloud API behind CSRF protection. A bare request 403s with
  `{"code":"CSRF_TOKEN_EXPIRED"}`. The fix (reverse-engineered here): **`GET
  /api/csrf`** sets an `XSRF-TOKEN` cookie, then echo that value in an
  **`X-XSRF-TOKEN`** header on every subsequent POST (keep cookies across the
  session). With that, `/official/user/query/random/code` → `login/new` →
  `file/list/query` all return `success:true`. The stale `sncloud`/JS libs 403
  today purely because they skip this step.
- **`MyStyle/` DOES sync to Cloud, and so does the registry.** Root listing
  returned `Note, Document, Export, Inbox, Screenshot, Mystyle` (note the API
  casing `Mystyle`). Drilling in:
  `Mystyle/Ink2Task/` contained **`checklist-registry.json` (2,490 B)**,
  **`config.json` (141 B)**, and `Ink2Task.snplg` (the plugin build). So the
  plugin's structured hand-off files are cloud-reachable and downloadable — the
  hybrid's core assumption holds. (Separately, the `.note` itself lives at
  `Note/Ink2Task/Reminders.note` and also syncs.)

  **Auth = emailed verification code, then a 30-day token.** Login on this
  account requires a code emailed each login. Decoding the returned JWT:
  `exp - createTime = 2,592,000 s = 30 days`. So: interactive code-login **once**
  at setup, store the token in Keychain, reuse for ~a month, re-login when it
  nears expiry. Quiet background sync is fine.

### Write path CONFIRMED (2026-07-27) + the full working recipe

Uploaded a test file to `Mystyle/Ink2Task/` on the live account — landed in
**~707 ms**, alongside the real `checklist-registry.json`/`config.json`. Both
directions now proven. The complete, reverse-engineered recipe (see
`cloud-roundtrip.py`, the reference impl for the Swift port):

- **Login is CODE-ONLY (no password needed)** — the web "Login with code" flow:
  1. `GET /api/csrf` → `XSRF-TOKEN` cookie (echo as `X-XSRF-TOKEN` on every POST).
  2. `POST /api/official/user/query/random/code` `{countryCode,account}` → `timestamp`.
  3. `POST /api/user/validcode/pre-auth` `{account}` → `generateToken`.
     `realKey = generateToken.split('-')[int(generateToken[-1])]`;
     `sign = sha256(account + realKey)` (anti-bot gate).
  4. `POST /api/user/mail/validcode/send` `{email,timestamp,token:generateToken,sign}`
     → **emails the code**, returns `validCodeKey`. (Phone accounts use
     `/api/user/sms/validcode/send` instead.)
  5. `POST /api/official/user/sms/login`
     `{email,validCode,validCodeKey,timestamp,browser,equipment:"4"}` → JWT token.
- **CSRF tokens expire fast.** They outlive a few quick calls but NOT the human
  delay while the user reads email + types the code — so **re-`GET /api/csrf`
  right before `sms/login`**. (This bit us: `pre-auth`/`send` passed, then
  `sms/login` 403'd `CSRF_TOKEN_EXPIRED` purely from the wait.)
- **Upload = 3 steps:** `POST /api/file/upload/apply` (needs extra headers
  `timestamp`, `nonce = 10 random digits + ms`, `equipmentNo:"WEB"`) → `PUT` to
  the returned S3 URL (`Authorization`, `x-amz-date`, `x-amz-content-sha256:
  UNSIGNED-PAYLOAD`) → `POST /api/file/upload/finish`.
- **⚠️ Upload file-type whitelist (server-provided, cached in
  `localStorage.FILE_TYPE`).** Allowed: `spd, snbak, snstk, dfont, note, read,
  epub, otf, cbz, mark, fb2, xps, woff/ttf/…, webp, jpg, chm, rtf, pptx, doc,
  docx, xlsx, zip, apk, pdf, xls, **txt**, gif, rar, bmp, jpeg, psd, tga, tif,
  ppt, gz, png, tar.gz, zz`. **`json` is NOT allowed** — a `.json` upload is
  rejected with *"This file cannot be uploaded"*, even though `.json` files DO
  live in Cloud (they arrive via the *device's* sync-up, which bypasses this
  whitelist). **Design consequence:** the Mac→device hand-off file must use an
  allowed extension — plan is a **`.txt`** holding JSON text (e.g.
  `mac-outbox.txt`), which the plugin reads. The device→Mac direction can stay
  `.json` (the registry), since the plugin writes it locally and the device
  syncs it up.

### ⚠️ The catch (2026-07-27): cloud→device push of `MyStyle/` looks ONE-WAY

First device-side test result is **negative**, and it hits the exact leg the
two-way design needs most:

- Uploaded `mac-app-roundtrip-test.txt` to Cloud `Mystyle/Ink2Task/` (landed,
  confirmed still in Cloud at 17:26).
- Synced the tablet, then inspected on-device `MyStyle/Ink2Task/` via Browse
  and Access: the `.txt` is **NOT there** — even though the device wrote its own
  `checklist-registry.json` at **17:36, ten minutes later**. The device and
  cloud copies **diverge both ways**: device has `Ink2Task_Template.png` /
  `.version` that Cloud lacks; Cloud has the `.txt` the device lacks.
- Read side still fine: device→cloud upload works (the registry/config ARE in
  Cloud), so the **Mac can READ device state** from Cloud. It's the **write-back
  (Mac→Cloud→device) that appears blocked** — Cloud looks like a device→cloud
  backup that does not pull cloud-only files down to the tablet.

**Caveat — not yet conclusive.** Today's sync was messy (hung at 0%, Wi-Fi
toggled mid-sync, plus an unrelated plugin dialog-spam bug). A half-completed
sync could produce the same symptom. **Decider = one clean, fully-completed sync
then re-check** `MyStyle/Ink2Task/` on-device for the `.txt`.

**If confirmed one-way (likely), the design consequence is real:** the "two-way
sync with NO LAN server" premise breaks on the *down* direction. Options then:
1. **Hybrid transport:** Mac→device write-back keeps a lightweight relay (reuse
   an existing server / a tiny cloud endpoint the plugin polls), while the
   Mac→cloud *read* of device state stays serverless. Half the win (no server to
   READ device checks), not the whole win.
2. **Find a folder/type that DOES sync down.** Unknown whether *any* cloud-only
   file reaches the device (e.g. a `.note` edited in the web app). Test a
   `Note/`-side file too before concluding `MyStyle/` specifically is the problem.
3. **Reframe the app** as one-way-rich: device→cloud→Mac→backend (push checks &
   captures out) is fully serverless and already proven; only *pulling remote
   task changes back onto the tablet* needs a transport. Many users may accept
   that asymmetry.

**Still to confirm:**

1. ~~Does Cloud sync `MyStyle/`?~~ **Yes** (device→cloud).
2. ~~Write path (upload to Cloud)?~~ **Yes** (~707 ms).
3. **Does ANY cloud-only file sync DOWN to the device?** First test says no for
   `MyStyle/` — **re-test with a clean completed sync**, and also test a `Note/`
   file, before locking in option 1/2/3 above.

**Stack note:** the cloud libraries are JS/Python but the app is SwiftUI, so
plan to **reimplement the ~4 calls (login, list, download, upload) natively in
Swift** — they're just HTTPS + a bearer token — rather than embedding a Node or
Python runtime. Read the JS/Python libs as the spec for the endpoints.

## Rough next steps

1. **Spike the Supernote Cloud access** (the make-or-break unknown) — can a Mac
   program read a file the plugin wrote, using the user's Supernote login?
2. Define the **structured hand-off file** the plugin writes and the Mac reads
   (IDs, completions, page contents, a version/etag for conflict detection).
3. **Stack: SwiftUI macOS menu-bar app** (`MenuBarExtra`) — menu-bar item for
   status + quick actions, plus a setup window for configuration; native
   EventKit for Apple, HTTPS for Google/Todoist and Supernote Cloud. (See
   "Shape of the app" above.)
4. Define the **reconciliation rules** (completed-here vs edited-there, deletes,
   loop prevention) — the part that actually makes two-way safe.

## How this fits the repo

```
plugin/               the on-device half (unchanged in spirit)
mac-server/           LAN backend, Apple Reminders (the thing this could replace)
google-tasks-server/  LAN/cloud backend, Google Tasks
todoist-server/       LAN/cloud backend (or direct-from-plugin)
mac-app/              ← this: the cloud-based, two-way sync brain (design only)
```

The existing backends don't go away — the Mac app can reuse their task-backend
logic (EventKit/Google/Todoist clients). What changes is the **transport**:
Supernote Cloud instead of a LAN HTTP server.
