/**
 * Ink2Task - Apple Reminders checklist plugin for Supernote
 *
 * Entry points:
 *   Button 100 (toolbar, NOTE/DOC): "Ink2Task" - open the plugin
 *   Button 101 (lasso toolbar, NOTE): "Add to Ink2Task" - captures the lassoed
 *     handwriting and syncs it, entirely in the background (showType 0, so no
 *     plugin view opens and you stay on your note). See lassoCapture.ts.
 *   Config button:                    same screen, has its own settings toggle
 *
 * @format
 */

import {AppRegistry, Image} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {PluginManager, NativeUIUtils, PluginCommAPI} from 'sn-plugin-lib';
import {loadConfig} from './src/utils/config';
import {toAbsolute} from './src/utils/notePicker';
import {overlayShow, overlayUpdate, overlayHide} from './src/utils/overlay';
import {syncThenFetch, formatSyncSummary} from './src/actions';
import {addLassoedTaskToInk2Task} from './src/utils/lassoCapture';
import {unwrap, withTimeout, friendlyErrorMessage} from './src/utils/sdk';
import {acquireBusy, releaseBusy} from './src/utils/busy';

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

// ---------------------------------------------------------------------------
// On-page SYNC button.
//
// The "Ink2Task List" template draws a SYNC icon + label centered in the top
// row (moved here from the top-left corner 2026-08-13, swapped with the
// platform:list title -- see template.svg). A background motion listener
// watches for a tap there (finger or pen) and runs Sync-then-Fetch, so you
// never have to open the plugin view.
//
// Coordinates are screen pixels (the same space getPageSize reports), scaled
// from the template's 1404x1872 design so the zone tracks the drawn button on
// any page size. The zone covers the icon AND the word "SYNC".
//
// ⚠ This MUST stay in sync with the pill's actual position in template.svg --
// a stale zone here is a button that looks right and simply never responds
// to taps (device-confirmed historically when the pill moved and this
// didn't). If you move the pill again, update this the SAME commit.
// ---------------------------------------------------------------------------
const TPL_W = 1404;
const TPL_H = 1872;
// Button pill x 556..848 (icon + "SYNC" label), y 100..184 -- padded a little.
const ZONE = {left: 537 / TPL_W, top: 82 / TPL_H, right: 867 / TPL_W, bottom: 204 / TPL_H};

let tapStart = null; // where a candidate tap went down
let lastFire = 0; // debounce repeated taps
// The single-flight "an operation is in flight" guard used to be a plain
// `busy` boolean here -- see acquireBusy/releaseBusy (utils/busy.ts) for
// why it's now a self-healing wall-clock check instead.

// Capitalize the first letter, so a message reads "Ink2Task: Added ..."
// rather than "Ink2Task: added ...".
const capFirst = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function inZone(x, y, w, h) {
  return (
    x >= ZONE.left * w &&
    x <= ZONE.right * w &&
    y >= ZONE.top * h &&
    y <= ZONE.bottom * h
  );
}

// The motion listener has no note path, so it can't call getPageSize -- but
// hardcoding the A5X's 1404x1872 broke down on other panel sizes: the checklist
// itself (checklistPage.ts) already scales the drawn button to the REAL page
// size, so on a device with a different resolution the button renders in the
// correct (scaled) spot while this hit-zone stayed pinned to A5X's absolute
// pixels -- the button would look right and simply never respond to taps.
// FIX: PluginManager.getDeviceType() needs no note path either, so resolve the
// real panel size ONCE at startup (cheap, cached) instead of per-stroke -- the
// DOWN-event zone check below fires on every pen-down anywhere on the page, so
// it must stay a synchronous read, not an async per-tap lookup.
// Device type -> portrait pixel dimensions (per docs.supernote.com). Nomad
// shares the A5X's exact panel; Manta is the "A5X2" model name in the market.
const DEVICE_PAGE_SIZE = {
  3: [1404, 1872], // A5X
  4: [1404, 1872], // Nomad
  5: [1920, 2560], // Manta / A5X2
};
let PAGE_W = TPL_W; // safe default until getDeviceType resolves (matches A5X/Nomad)
let PAGE_H = TPL_H;
PluginManager.getDeviceType()
  .then(type => {
    const size = DEVICE_PAGE_SIZE[type];
    if (size) {
      PAGE_W = size[0];
      PAGE_H = size[1];
    }
  })
  .catch(() => {
    // Unknown/unsupported device type: keep the A5X/Nomad-matching default.
  });

// LIVE MOTION EVENTS report page-pixel coords for BOTH tools -- finger
// (toolType 1) AND pen (toolType 2). This was verified on an A5X from the tap
// log: a pen tap on the SYNC button came in at ~(180,135), the same page-space
// spot the finger hit. (Don't confuse this with stroke ELEMENT points returned
// by getElements, which ARE in EMR digitizer space and need emrToScreen -- that
// conversion is only for reading back drawn strokes, never for motion events.)
// So: use the raw event coords directly; no conversion.
function toPage(e) {
  return {x: e.x, y: e.y};
}

PluginManager.registerMotionListener(1, {
  onMsg: async e => {
    try {
      if (!e || typeof e.action !== 'number') return;
      const p = toPage(e); // page-pixel coords (both finger and pen)
      if (e.action === 0) {
        // DOWN: remember it only if it started on the button.
        tapStart = inZone(p.x, p.y, PAGE_W, PAGE_H) ? {x: p.x, y: p.y} : null;
        return;
      }
      if (e.action !== 1) return; // only act on UP; ignore MOVE/CANCEL
      const start = tapStart;
      tapStart = null;
      if (!start) return;
      if (!inZone(p.x, p.y, PAGE_W, PAGE_H)) return;
      // Reject drags/strokes -- a tap barely moves.
      if (Math.hypot(p.x - start.x, p.y - start.y) > 50) return;

      // Settings toggle: lets a user who's hit the "fires while exiting to
      // the note picker" issue turn this listener off entirely, rather than
      // live with a false positive that (see the big comment below) has no
      // real fix. Checked before touching busy/lastFire or any native call,
      // so "off" costs nothing beyond the one config read. Loaded here (not
      // re-loaded below) so the rest of this handler reuses the same object.
      let config;
      try {
        config = await loadConfig();
      } catch (_) {
        return; // can't confirm the toggle -- fail safe, do nothing
      }
      if (config.onPageSyncEnabled === false) return;

      const now = Date.now();
      if (now - lastFire < 2000) return;
      if (!acquireBusy()) return;
      lastFire = now;
      try {
        // Only fire when an actual .note is open. The SYNC button is drawn on
        // checklist pages, so a top-left tap in file view or a PDF must NOT kick
        // off a sync -- otherwise a stray corner tap runs a network fetch that,
        // offline, fails and (on repeated taps) spams error dialogs. In file
        // view getCurrentFilePath isn't a .note, so we skip silently.
        //
        // ⚠ TRIED AND REVERTED TWICE -- see [[ink2task-sdk-gotchas]] before
        // attempting a third native-signal fix here:
        //  (1) 2026-08-11: re-reading getCurrentFilePath() a second time
        //      ~250ms later. Broke the common case -- legitimate on-page taps
        //      stopped firing at all.
        //  (2) 2026-08-13: cross-checking against a timeout-bounded
        //      getCurrentPageNum(), on the theory it hangs with no active
        //      editor. Didn't block a confirmed wrong-context tap either --
        //      it also resolved quickly outside a note.
        // CONCLUSION: getCurrentFilePath()/getCurrentPageNum() appear to
        // report "the last note THIS PLUGIN touched", not "what's genuinely
        // on screen" -- since Ink2Task only ever touches its own note, this
        // will read as a match almost regardless of true context. No other
        // signal exists in this SDK (checked PluginManager's full surface,
        // 2026-08-13: only onStart/onStop lifecycle, nothing screen-scoped).
        // This is a confirmed, accepted SDK limitation, not something a
        // cleverer check can fix -- the impact is limited (a sync only ever
        // writes to the Ink2Task note itself, never whatever's genuinely on
        // screen; see below), so the check below stays as a best-effort
        // filter for the common cases (file browser, other notes with no
        // history) rather than a real guarantee.
        let openPath = '';
        try {
          openPath = (await unwrap(PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath')) || '';
        } catch (_) {
          openPath = '';
        }
        if (!/\.note$/i.test(openPath)) return; // not on a note -- ignore

        // ...and only when that note is OUR checklist. Every note passes the
        // .note test above, so without this a corner tap on any note at all
        // started a sync. syncThenFetch re-checks this itself (requireOpenNote
        // below); this just avoids the wasted work of getting that far.
        if (toAbsolute(openPath) !== toAbsolute(config.notePath)) return;
        // No "Syncing…" popup: the plugin view can only open FULLSCREEN (the JS
        // SDK never exposes the regionType/showData field the native docs
        // describe, and showPluginView takes no arguments), which was more
        // disruptive than the wait it was covering.
        // requireOpenNote: this listener is global and fires on coordinates
        // alone, so the sync itself must confirm we're on the checklist note.
        //
        // onPhase drives the floating progress bubble. This is the ONLY sync
        // path that needs it -- the Settings screen has its own status text --
        // and it's why the native overlay exists at all: an on-page sync runs
        // ~18s with nothing on screen, so the device looks frozen. Every
        // overlay call is best-effort and returns false rather than throwing
        // when the module or permission is missing, so a sync behaves
        // identically with or without a bubble.
        overlayShow('Ink2Task: syncing…');
        // Timeout-wrapped: device-reported (2026-08-13) that a hung native
        // call somewhere inside this chain (this SDK has documented cases of
        // calls that never resolve OR reject, see sdk.ts's withTimeout doc)
        // left `busy` stuck true forever, since the `finally` below -- the
        // ONLY place that resets it -- never ran. Every tap after that one
        // was silently swallowed by the busy-check with zero visible symptom,
        // indistinguishable from the tap zone itself being broken; only a
        // full device reboot (which restarts this JS process) cleared it.
        // 60s is generous against a real sync's ~5-9s (device-measured) so
        // this never fires on a legitimately slow one, but guarantees the
        // button recovers on its own instead of needing a reboot.
        const r = await withTimeout(
          syncThenFetch(config, {
            requireOpenNote: true,
            onPhase: msg => overlayUpdate('Ink2Task: ' + msg),
          }),
          60000,
          'On-page sync',
        );
        // The tap landed on a note the plugin doesn't manage (a stray corner
        // stroke on some OTHER note): syncThenFetch did nothing. Stay silent --
        // no dialog, and above all nothing was drawn over the user's page.
        if (r && r.skipped) return;
        const summary = formatSyncSummary(
          r.captured || [],
          r.completedTitles || [],
          r.warnings || [],
          r.duesSet || [],
          r.checkboxDiagnostic,
        );
        try {
          NativeUIUtils.showRattaDialog(
            'Ink2Task\n\n' + summary,
            'OK',
            '',
            !(r.warnings && r.warnings.length),
          );
        } catch (_) {}
      } catch (err) {
        const raw = err && err.message ? err.message : 'sync failed';
        const msg = friendlyErrorMessage(raw);
        try {
          NativeUIUtils.showRattaDialog('Ink2Task: ' + capFirst(msg), 'OK', '', false);
        } catch (_) {}
      } finally {
        // MUST be in finally: if the sync throws partway, an orphaned bubble
        // stays painted over the note with nothing left to remove it.
        overlayHide();
        releaseBusy();
        // Re-arm the debounce from when work *finished*, so a slow (e.g. offline,
        // timing-out) sync can't be immediately re-triggered by another tap.
        lastFire = Date.now();
      }
    } catch (_) {
      // Never let a listener error bubble into the host's event pump.
    }
  },
});

const icon = Image.resolveAssetSource(require('./assets/icon.png')).uri;

// Toolbar in NOTE and DOC. The checklist itself always lives in a .note --
// the SDK cannot draw into a PDF -- but registering for DOC means you can
// pull up Fetch/Sync without leaving whatever PDF you're reading.
PluginManager.registerButton(1, ['NOTE', 'DOC'], {
  id: 100,
  name: 'Ink2Task',
  icon,
  showType: 1,
});

// "Add to Ink2Task" lasso button (type 2 = lasso toolbar; distinct from type 1
// above). Appears in the native toolbar that pops up after the user lassos
// content on ANY note -- not just the Ink2Task page -- letting them pull a
// task written elsewhere straight into the checklist. NOTE only: lassoing
// isn't a DOC/PDF concept here, and this plugin never writes into PDFs anyway.
//
// editDataTypes is REQUIRED for a type-2 (lasso) button -- omitting it (0.2.68)
// crashed the host and kicked the user out of the note entirely, confirmed
// against a working reference (SuperTask's lasso button always sets this).
// 0 = handwritten strokes, 3 = typed text -- the two content types our capture
// pipeline (lassoCapture.ts) actually reads; leaving out title/image/link/geo
// (1/2/4/5), which we don't handle.
// showType 0 = "no UI display needed": the button fires this plugin's listener
// WITHOUT opening the plugin view, so a lasso capture happens in the background
// and you stay on the note you're writing on.
const LASSO_BUTTON_ID = 101;
PluginManager.registerButton(2, ['NOTE'], {
  id: LASSO_BUTTON_ID,
  name: 'Add to Ink2Task',
  icon,
  editDataTypes: [0, 3],
  showType: 0,
});

// Config button reuses the same single screen (it has its own
// Settings toggle) rather than adding a second entry point for v1.
PluginManager.registerConfigButton();

PluginManager.registerButtonListener({
  onButtonPress: async event => {
    // The main Ink2Task toolbar button (id 100): single-screen plugin, nothing
    // to branch on -- opening the view is handled by the host.
    if (!event || event.id !== LASSO_BUTTON_ID) return;

    // Lasso capture runs entirely HERE, in the background, so the user stays on
    // the note they're writing on -- no plugin view, no screen change. (It used
    // to defer to a mounted Home screen because doing the work here crashed in
    // 0.2.68; that crash was the missing editDataTypes above, which is now set.)
    // Shares the on-page SYNC button's busy/debounce state so the two can't run
    // at once.
    const now = Date.now();
    if (now - lastFire < 2000) return;
    if (!acquireBusy()) return;
    lastFire = now;
    try {
      // Timeout-wrapped for the same reason as the on-page SYNC button's
      // syncThenFetch call above -- this shares the SAME busy/lastFire state,
      // so a hang here would silently disable SYNC too (and vice versa).
      const captured = await withTimeout(addLassoedTaskToInk2Task(), 60000, 'Lasso capture');
      if (!captured) {
        NativeUIUtils.showRattaDialog(
          "Ink2Task: Couldn't read any text from that selection.",
          'OK',
          '',
          false,
        );
        return;
      }
      const {title, target} = captured;
      // Draw it onto the checklist right away. The checklist note isn't the one
      // on screen, so this writes in the background -- reloadIfOpen knows to
      // skip saving/repainting a note that isn't open.
      const config = await loadConfig();
      let summary = `Added:\n"${title}"`;
      try {
        // MUST pass the SAME target the capture just resolved -- see
        // syncThenFetch's doc. Letting this re-resolve independently
        // (device-confirmed 2026-08-14) can silently redraw a different page
        // than the one the task was actually just created on.
        const r = await withTimeout(syncThenFetch(config, {target}), 60000, 'Lasso redraw');
        summary = formatSyncSummary(
          [title, ...(r.captured || [])],
          r.completedTitles || [],
          r.warnings || [],
          r.duesSet || [],
          r.checkboxDiagnostic,
        );
      } catch (e) {
        summary += '\n\n⚠ Added, but the checklist redraw failed: ' + (e && e.message ? e.message : 'unknown error');
      }
      NativeUIUtils.showRattaDialog('Ink2Task\n\n' + summary, 'OK', '', true);
    } catch (err) {
      const raw = err && err.message ? err.message : 'could not add that selection';
      const msg = friendlyErrorMessage(raw);
      try {
        NativeUIUtils.showRattaDialog('Ink2Task: ' + capFirst(msg), 'OK', '', false);
      } catch (_) {}
    } finally {
      releaseBusy();
      lastFire = Date.now();
    }
  },
});

// Settings > Apps > Plugins > Ink2Task > Settings routes here. The host
// hands control over and waits for the plugin to present something, so this
// has to actually open the view -- leaving it empty hangs that screen.
PluginManager.registerConfigButtonListener({
  onClick: () => {
    PluginManager.showPluginView();
  },
});
