/**
 * Ink2Task home screen -- the entire v1 workflow lives here on purpose.
 * One list, one note page, a manual "Sync completed tasks" button. No
 * background sync, no per-stroke reactivity, no multi-page planner. See
 * the top-level README for why this scope was chosen deliberately.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import {PluginManager, PluginCommAPI} from 'sn-plugin-lib';
import {
  loadConfig,
  saveConfig,
  loadRegistry,
  saveRegistryEntries,
  registryKey,
  setActiveConnection,
  setActiveToken,
  switchProfile,
  bindPage,
  withLastViewedPage,
  withLassoTargetOverride,
  activeProfileOf,
  loadTaskSources,
  loadErasedInk,
  saveErasedInk,
  loadTicktickSyncMeta,
  saveTicktickSyncMeta,
  type PageBinding,
  type Ink2TaskConfig,
  type TickTickSyncMeta,
} from '../utils/config';
import {runTicktickPreSync, runTicktickPostSync} from '../utils/ticktickSync';
import {taskCallWithAutoRecover} from '../utils/autoRecover';
import {
  fetchLists,
  fetchReminders,
  completeReminders,
} from '../api/macServer';
import {displayName, toAbsolute} from '../utils/notePicker';
import {resolveTarget, reloadIfOpen, openNote} from '../utils/target';
import {
  writeChecklist,
  scanMainLayer,
  takeRedrawWarning,
  dropGhostStrokes,
  inkPrintsOf,
  verifyEraseAndRetry,
  recycleScan,
} from '../utils/checklistPage';
import {ensureNote, noteHasBakedInCheckboxes} from '../utils/ensureNote';
import {captureAndCreate} from '../utils/capture';
import {syncCompleted, formatSyncSummary, reconcileBackLinks} from '../actions';
import {discoverServer} from '../utils/discover';
import {unwrap, withTimeout} from '../utils/sdk';
import pluginConfig from '../../PluginConfig.json';

// A curated set of readable device fonts (from /system/fonts). Not the full
// system list -- most of those are non-Latin script fonts. '' = default.
const FONTS: {name: string; path: string}[] = [
  {name: 'Default', path: ''},
  {name: 'Sans', path: '/system/fonts/DroidSans.ttf'},
  {name: 'Mono', path: '/system/fonts/DroidSansMono.ttf'},
  {name: 'Typewriter', path: '/system/fonts/CutiveMono.ttf'},
  {name: 'Casual', path: '/system/fonts/ComingSoon.ttf'},
  {name: 'Rounded', path: '/system/fonts/CarroisGothicSC-Regular.ttf'},
  {name: 'Script', path: '/system/fonts/DancingScript-Regular.ttf'},
];

type Status = {kind: 'idle' | 'busy' | 'ok' | 'error'; message: string};

export default function Home() {
  const [config, setConfig] = useState<Ink2TaskConfig | null>(null);
  const [status, setStatus] = useState<Status>({kind: 'idle', message: ''});
  const [lastCount, setLastCount] = useState<number | null>(null);
  // Step 2 list picker: names loaded from the server, and whether it's open.
  const [listOptions, setListOptions] = useState<string[] | null>(null);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  // Whether the (large) Sync Settings section is expanded.
  const [syncOpen, setSyncOpen] = useState(true);
  // Lasso Capture Target picker: collapsed by default, like the list picker above.
  const [lassoPickerOpen, setLassoPickerOpen] = useState(false);
  // Last-sync status for the TickTick profile -- see TickTickSyncMeta. Only
  // this backend has a persisted status surface; the other three show a
  // transient message that resets when you leave the screen.
  const [ticktickMeta, setTicktickMeta] = useState<TickTickSyncMeta>({});

  // The X button closes this screen even mid-sync -- runFetchAndWrite's promise
  // chain keeps running in the background (so the sync still completes and gets
  // saved), it just stops touching React state once we're gone. Without this
  // guard, closing during "Reading the page…" etc. would log a harmless but
  // noisy "state update on an unmounted component" warning on every await
  // after the close.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    loadConfig().then(c => {
      setConfig(c);
      setLoaded(true);
    });
    loadTicktickSyncMeta().then(setTicktickMeta);
  }, []);

  // Whether a note is actually open right now, so Sync can be disabled instead
  // of failing. Opened via Settings > Apps > Plugins > Ink2Task > Settings,
  // there's no note context at all.
  //
  // ⚠ Defaults to FALSE (disabled), fail-safe -- NOT true. It was true in
  // 0.2.89 "so the button doesn't flash disabled before the first check
  // completes", which was actively dangerous: device-confirmed, getCurrentFilePath
  // doesn't reject quickly from this context, it just HANGS (never resolves).
  // With an optimistic true default, a hung check left the button looking
  // enabled forever, so a tap ran straight into the same hang -- "Reading the
  // page…" stuck with no way out but reinstalling the plugin. Every await here
  // is timeout-wrapped so a hang resolves the check (to false) instead of
  // leaving it stuck.
  const [canSyncHere, setCanSyncHere] = useState(false);
  // Read inside the interval below instead of depending on `status` directly
  // -- this poll only needs to SKIP a tick while a sync is running, not tear
  // down and rebuild the whole interval on every status change.
  const statusKindRef = useRef(status.kind);
  useEffect(() => {
    statusKindRef.current = status.kind;
  }, [status.kind]);
  useEffect(() => {
    if (!loaded) return;
    const check = async () => {
      // Skip while a sync is actively running: this poll's getCurrentFilePath
      // call otherwise keeps firing every 1.5s throughout AND after a sync
      // (adb logcat-confirmed 2026-08-12 -- 8 extra native round-trips
      // logged spanning the tail of a real sync), competing for the same
      // native bridge the sync's own calls use. Each round-trip alone is
      // cheap, but there's no reason to spend any of them while we already
      // know a sync is in flight -- canSyncHere only gates whether the
      // button CAN be tapped, and it's already correctly disabled/busy then.
      if (statusKindRef.current === 'busy') return;
      try {
        const path = await withTimeout(
          unwrap<string>(PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath'),
          2000,
          'getCurrentFilePath',
        );
        setCanSyncHere(/\.note$/i.test(path || ''));
      } catch {
        setCanSyncHere(false);
      }
    };
    check();
    const id = setInterval(check, 1500);
    return () => clearInterval(id);
  }, [loaded]);

  // Auto-save: persist whenever settings change, so there's no "Save" button to
  // remember. Skips the initial load (nothing to write yet).
  useEffect(() => {
    if (loaded && config) saveConfig(config);
  }, [config, loaded]);

  // NOTE: lasso capture no longer runs here. It happens entirely in the
  // background button listener in index.js, so the user stays on the note they
  // lassoed from instead of being pulled into this screen.

  const handleClose = () => PluginManager.closePluginView();

  // Guarded setters for the long-running sync below -- closing this screen
  // (the X button) doesn't cancel it, it just stops it from touching state
  // that no longer has anywhere to render. See mountedRef above.
  const safeSetStatus = useCallback((s: Status) => {
    if (mountedRef.current) setStatus(s);
  }, []);
  const safeSetConfig = useCallback((c: Ink2TaskConfig) => {
    if (mountedRef.current) setConfig(c);
  }, []);
  const safeSetLastCount = useCallback((n: number) => {
    if (mountedRef.current) setLastCount(n);
  }, []);
  const safeSetTicktickMeta = useCallback((m: TickTickSyncMeta) => {
    if (mountedRef.current) setTicktickMeta(m);
  }, []);

  const runFetchAndWrite = useCallback(async () => {
    if (!config) return;
    // Per-phase progress text. A sync can take 15-30s+ (mostly the SDK's own
    // element-write latency -- confirmed inherent to it, not something we can
    // optimize away, see [[ink2task-sdk-gotchas]]), and a single static message
    // the whole time reads as "frozen". This is pure React state -- no note/file
    // API calls -- so unlike everything tried on the on-page button, it carries
    // NONE of the save-timing risk that broke the erase fix there. It only
    // covers this in-plugin-view Sync button; the on-page button has no screen
    // to render progress into, and every native alternative checked (dialogs,
    // setButtonState) was either unsafe, too intrusive, or the wrong UI element.
    safeSetStatus({kind: 'busy', message: 'Reading the page…'});
    try {
      // Timeout-wrapped: resolveTarget calls getCurrentFilePath/getCurrentPageNum,
      // which have been observed to HANG (never resolve or reject) rather than
      // error when there's no active note editor -- e.g. this screen opened via
      // Settings > Apps > Plugins. Without this, that leaves the UI stuck on
      // "Reading the page…" forever with no way out but reinstalling the plugin
      // (0.2.89). canSyncHere is meant to stop that tap before it happens, but
      // this is the real backstop -- a UI gate can race, this can't hang.
      // Resolved ONCE and threaded into every step below -- each resolve costs
      // several native round-trips, and they all act on the same page anyway.
      const target = await withTimeout(resolveTarget(config), 8000, 'resolveTarget');
      const {notePath, page, isTemplatePage} = target;
      const noteJustCreated = await ensureNote(notePath);
      // Bind this page to the selected profile+list, so its on-page SYNC
      // re-syncs the same backend/list and other pages can hold different
      // ones. Also record it as the last-VIEWED page (before the sync below
      // even runs), so a lasso capture made from some OTHER note defaults
      // here -- see resolveLassoTarget.
      let eff = withLastViewedPage(
        bindPage(config, notePath, page, config.activeProfile, config.listName),
        notePath,
        page,
      );
      safeSetConfig(eff);
      // TickTick only: retry anything queued while offline BEFORE reading
      // fresh remote state below -- draining after the fetch could let a
      // just-applied edit get immediately overwritten by a stale read from
      // the same sync. Best-effort: draining must never block or fail a sync.
      if (activeProfileOf(eff).backend === 'ticktick') {
        try {
          await runTicktickPreSync(eff);
        } catch (e: any) {
          console.log('Ink2Task: TickTick outbox drain failed', e?.message);
        }
      }
      // Read the page ONCE and share it across capture + completion detection,
      // instead of each re-reading and re-bounding every stroke.
      const rawScan = await scanMainLayer(notePath, page);
      const inkKey = registryKey(notePath, page);
      // Installing the plugin can make the host revert page edits, bringing
      // back ink a PREVIOUS sync already erased -- the per-stroke ghost
      // filter is what catches that (and everything else already-erased),
      // by fingerprint, on every sync, not just the first one after an
      // install.
      const scan = dropGhostStrokes(rawScan, (await loadErasedInk())[inkKey] || []);
      // Whether there was any user ink to erase at all -- gates the two
      // post-redraw verification reads below (the common repeat-sync has none).
      const hadInk = (rawScan.strokes?.length ?? 0) > 0;
      safeSetStatus({kind: 'busy', message: 'Reading your handwriting…'});
      // Capture handwritten tasks AND complete checked ones CONCURRENTLY --
      // matching actions.ts's syncThenFetch (the on-page button's path),
      // which already does this ("shaves a network round-trip off every
      // sync"). This screen's version ran them one-after-another instead,
      // a real gap found 2026-08-12 via adb logcat timing on a real sync --
      // the native element-write phase was already fast/optimized, but this
      // screen paid for capture's backend round-trip and completion's
      // separately instead of overlapping them like the on-page path does.
      // Both only READ (from the shared scan) and hit independent requests,
      // so nothing about running them together changes what either does.
      const [cap, completedResult] = await Promise.all([
        captureAndCreate(eff, scan, target).catch((e: any) => {
          console.log('Ink2Task: capture failed', e?.message);
          return {
            created: [] as string[],
            duesSet: [] as string[],
            warnings: [`Capture failed: ${e?.message || 'unknown error'}`],
          };
        }),
        syncCompleted(eff, {skipReload: true, scan, target}).catch((e: any) => {
          console.log('Ink2Task: sync-completed failed', e?.message);
          return {completedTitles: [] as string[]};
        }),
      ]);
      const captured = cap.created;
      let warnings = cap.warnings;
      const duesSet = cap.duesSet;
      const completedTitles = completedResult.completedTitles;
      safeSetStatus({kind: 'busy', message: 'Fetching the latest list…'});
      // Handwriting/text has been read into reminders; the writeChecklist redraw
      // below wipes all user ink on the page (via replaceElements) in the same op.
      // Wrapped in taskCallWithAutoRecover: a connectivity failure (stale host,
      // e.g. the Mac's LAN IP changed) gets ONE auto-rediscover-and-retry
      // before throwing -- see autoRecover.ts. Reassigns `eff` so anything
      // else in this sync (TickTick prune below, the redraw's header label)
      // uses the corrected address too. Ported from Ink2Day.
      const fetchResult = await taskCallWithAutoRecover(eff, fetchReminders);
      eff = fetchResult.config;
      const reminders = fetchResult.result;
      // TickTick only: drop sync-state for anything no longer in this fetch
      // (completed, deleted, or moved out of the synced project remotely) --
      // best-effort, mirrors reconcileBackLinks' cleanup below for task-sources.
      if (activeProfileOf(eff).backend === 'ticktick') {
        try {
          await runTicktickPostSync(reminders.map(r => r.id));
        } catch (e: any) {
          console.log('Ink2Task: TickTick sync-state prune failed', e?.message);
        }
      }
      // On a recognized note the checklist shares the main layer with your
      // handwriting, so redrawing needs to know exactly what it drew last time.
      const key = registryKey(notePath, page);
      const previous = (await loadRegistry())[key] || [];
      safeSetStatus({kind: 'busy', message: 'Redrawing the checklist…'});
      const sources = await loadTaskSources();
      const entries = await writeChecklist(notePath, page, reminders, previous, {
        fontPath: config.fontPath,
        scale: config.listScale,
        header: {platform: activeProfileOf(eff).label, list: eff.listName},
        sources,
        // The template page has the background baked in (ensureNote). Any
        // other page was added afterward with the device's own note tools (a
        // second list) and starts blank, so it needs the SYNC/DUE/divider/
        // lines drawn as elements. isTemplatePage (from resolveTarget) is
        // more reliable than a raw page-index comparison -- see target.ts.
        drawChrome: !isTemplatePage,
        // Google Tasks/Todoist have a real manual-order field and already
        // return reminders sorted by it. Apple Reminders has none, so it
        // stays slot-stable. TickTick ALSO stays slot-stable (device-confirmed
        // 2026-08-14): its API doesn't return a reliable manual order -- newly
        // created tasks came back first, so a lassoed capture appeared at the
        // TOP of the list instead of the bottom.
        honorBackendOrder: ['google', 'todoist'].includes(activeProfileOf(eff).backend),
        use24HourTime: config.use24HourTime,
        checkboxesBaked: await noteHasBakedInCheckboxes(),
      });
      // If the redraw couldn't erase the handwriting, say so -- otherwise the
      // page looks fine (the checklist covers the ink) until the plugin is removed.
      const redrawWarning = takeRedrawWarning();
      if (redrawWarning) warnings = [...warnings, redrawWarning];
      await saveRegistryEntries(key, entries);
      // Remember the ink this sync erased, so a reinstall-restored copy of it
      // can be told apart from genuinely new marks next time.
      await saveErasedInk(inkKey, inkPrintsOf(rawScan));
      // Clean up back-links for tasks that are gone, and forget their sources.
      await reconcileBackLinks(reminders.map(r => r.id), notePath);
      safeSetStatus({kind: 'busy', message: 'Saving…'});
      await reloadIfOpen(notePath);
      // Verify the erase AFTER the save/reload -- saveCurrentNote writes the
      // editor's in-memory buffer, which can put the ink straight back. Only
      // worth the round-trip when there was ink to erase in the first place.
      if (hadInk) {
        const {leftover, retried} = await verifyEraseAndRetry(notePath, page);
        // A retry rewrote the page after the reload, so repaint to show it.
        if (retried && leftover === 0) await reloadIfOpen(notePath);
        if (leftover > 0) {
          warnings = [
            ...warnings,
            `Handwriting not erased -- ${leftover} stroke(s) came back after saving. ` +
              'The page save appears to be restoring them.',
          ];
        }
      }
      // Everything that needed the scanned page handles (capture/OCR,
      // completion detection, the erase checks) is done -- hand them back.
      // Recycling the raw scan covers the ghost-filtered one too; same objects.
      recycleScan(rawScan);
      safeSetLastCount(entries.length);
      safeSetStatus({
        kind: warnings.length > 0 ? 'error' : 'ok',
        message: formatSyncSummary(captured, completedTitles, warnings, duesSet),
      });
      // TickTick only: persist what Settings shows as "last sync" -- the one
      // persisted status surface this backend has that the other three don't.
      // Recorded even when there were warnings (a sync that ran and reported
      // problems still ran), just with lastError set instead of cleared.
      if (activeProfileOf(eff).backend === 'ticktick') {
        const meta: TickTickSyncMeta = {
          lastSyncAt: Date.now(),
          lastError: warnings.length > 0 ? warnings.join('; ') : undefined,
        };
        safeSetTicktickMeta(meta);
        await saveTicktickSyncMeta(meta);
      }
      // Land the user on the checklist note ONLY the very first time, right
      // after it's created -- so a brand-new user sees where their list lives.
      // On every later sync we stay put. The status message confirms the sync.
      if (noteJustCreated) {
        await openNote(notePath);
      }
    } catch (e: any) {
      safeSetStatus({kind: 'error', message: e?.message || 'Fetch failed.'});
      // Best-effort: `eff` may not exist yet if the crash happened before it
      // was computed, so fall back to the pre-resolution active profile --
      // an approximation, but better than losing the failure entirely for a
      // TickTick user.
      if (activeProfileOf(config).backend === 'ticktick') {
        const meta: TickTickSyncMeta = {
          lastSyncAt: Date.now(),
          lastError: e?.message || 'Sync failed.',
        };
        safeSetTicktickMeta(meta);
        await saveTicktickSyncMeta(meta);
      }
    }
  }, [config]);

  const runDiscover = useCallback(async () => {
    if (!config) return;
    const backend = config.profiles[config.activeProfile]?.backend;
    setStatus({kind: 'busy', message: 'Searching this Wi-Fi for the server…'});
    try {
      const found = await discoverServer(config.port, backend);
      if (!found) {
        setStatus({
          kind: 'error',
          message:
            'No matching server found on this Wi-Fi. Check the server for this profile is running on the same network, or enter its IP and port manually.',
        });
        return;
      }
      const next = setActiveConnection(config, {host: found.host, port: found.port});
      setConfig(next);
      await saveConfig(next);
      setStatus({kind: 'ok', message: `Found the server at ${found.host}:${found.port}. Saved.`});
    } catch (e: any) {
      setStatus({kind: 'error', message: e?.message || 'Search failed.'});
    }
  }, [config]);

  const runSwitchProfile = useCallback(
    async (index: number) => {
      if (!config) return;
      const next = switchProfile(config, index);
      setConfig(next);
      await saveConfig(next);
      setListOptions(null); // lists belong to the previous server
      setListPickerOpen(false);
      const p = next.profiles[next.activeProfile];
      // Todoist talks straight to the cloud -- it has no host/IP to set, so
      // point at the thing it DOES need (a token) rather than an IP field that
      // isn't even shown for this backend.
      const hint =
        p.backend === 'todoist'
          ? p.token
            ? ''
            : ' — set its API token below'
          : p.host
            ? ` (${p.host})`
            : ' — set its IP below';
      setStatus({kind: 'ok', message: `Switched to "${p.label}"${hint}.`});
    },
    [config],
  );

  // Step 2: load the lists from the connected server and open the picker.
  const runChooseList = useCallback(async () => {
    if (!config) return;
    if (listPickerOpen) {
      setListPickerOpen(false);
      return;
    }
    setStatus({kind: 'busy', message: 'Loading lists from the server…'});
    try {
      const lists = await fetchLists(config);
      if (lists.length === 0) {
        setStatus({kind: 'error', message: 'The server returned no lists.'});
        return;
      }
      setListOptions(lists);
      setListPickerOpen(true);
      setStatus({kind: 'ok', message: 'Pick the list to sync below.'});
    } catch (e: any) {
      setStatus({
        kind: 'error',
        message:
          (e?.message || 'Could not load lists.') +
          ' Finish Step 1 (connect to the server) first.',
      });
    }
  }, [config, listPickerOpen]);

  const selectList = useCallback(
    async (name: string) => {
      if (!config) return;
      const next = setActiveConnection(config, {listName: name});
      setConfig(next);
      await saveConfig(next);
      setListPickerOpen(false);
      setStatus({kind: 'ok', message: `List set to "${name}". Now tap SYNC TASKS.`});
    },
    [config],
  );

  if (!config) {
    return (
      <View style={styles.container}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable style={styles.closeButton} onPress={handleClose}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>

      {/*
        keyboardShouldPersistTaps is essential here, not cosmetic. The default
        ("never") makes the ScrollView swallow the first tap on any child while
        a TextInput is focused, spending it on dismissing the keyboard instead.
        With the settings fields on this same screen, that silently kills every
        button below them -- including Sync and Fetch -- until the field blurs.
      */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Ink2Task Settings</Text>
        <Text style={styles.subtitle}>
          List: {config.listName} → {displayName(config.notePath)}
        </Text>

        <Pressable
          style={[styles.primaryButton, !canSyncHere && styles.primaryButtonDisabled]}
          disabled={!canSyncHere}
          onPress={runFetchAndWrite}>
          <Text
            style={[styles.primaryButtonText, !canSyncHere && styles.primaryButtonTextDisabled]}>
            Sync tasks
          </Text>
        </Pressable>
        {!canSyncHere && (
          <Text style={styles.hint}>
            Open a note first -- syncing isn't available from here. Settings below still work.{'\n'}
            The first sync creates the checklist note at{' '}
            {config.notePath.slice(0, config.notePath.lastIndexOf('/')) || '/'}.
          </Text>
        )}

        {status.kind !== 'idle' && (
          <View style={styles.statusBox}>
            {status.kind === 'busy' && <ActivityIndicator style={{marginBottom: 6}} />}
            <Text style={styles.statusText}>{status.message}</Text>
          </View>
        )}

        {lastCount !== null && (
          <Text style={styles.hint}>
            Draw a check inside a box, then tap "Sync tasks" to complete it.
          </Text>
        )}

        <View style={styles.settingsBox}>
            <Pressable style={styles.sectionHeaderRow} onPress={() => setSyncOpen(o => !o)}>
              <Text style={styles.sectionLabel}>Sync Settings</Text>
              <Text style={styles.collapseChevron}>{syncOpen ? '▾' : '▸'}</Text>
            </Pressable>
            {syncOpen && (
            <View>
              <Text style={styles.fieldLabel}>Which backend are you using?</Text>
              <Text style={styles.toggleHint}>
                Tap one to select it. The highlighted button is active — the
                settings below apply to it, and the on-page SYNC uses it.
              </Text>
              <View style={[styles.fontRow, {marginTop: 8, marginBottom: 4}]}>
                {config.profiles.map((p, i) => {
                  const selected = config.activeProfile === i;
                  return (
                    <Pressable
                      key={i}
                      style={[styles.fontChip, selected && styles.fontChipOn]}
                      onPress={() => runSwitchProfile(i)}>
                      <Text style={[styles.fontChipText, selected && styles.fontChipTextOn]}>
                        {selected ? '✓ ' : ''}{p.label || `Server ${i + 1}`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.activeProfileNote}>
                Active: {config.profiles[config.activeProfile]?.label}
              </Text>

              {config.profiles[config.activeProfile]?.backend === 'todoist' ? (
                <>
                  <Text style={styles.stepLabel}>Step 1 · Enter your Todoist API token</Text>
                  <Field
                    label="Todoist API token"
                    value={config.profiles[config.activeProfile]?.token || ''}
                    onChangeText={v => setConfig(setActiveToken(config, v))}
                  />
                  <Text style={styles.toggleHint}>
                    Get it in Todoist: Settings → Integrations → Developer. The
                    plugin talks to Todoist directly — no server to run. This field
                    can't paste, so for a long token it's easier to set "token" in
                    MyStyle/Ink2Task/config.json on a computer (see the plugin
                    README).
                  </Text>
                </>
              ) : (
                <>
                  <Pressable style={styles.wideButton} onPress={runDiscover}>
                    <Text style={styles.wideButtonText}>FIND SERVER ON WI-FI</Text>
                  </Pressable>
                  <Text style={styles.stepLabel}>Step 1 · Connect to the server</Text>
                  {config.profiles[config.activeProfile]?.backend === 'ticktick' &&
                    // Only shown before a server address is set -- once FIND SERVER
                    // ON WI-FI (or typing one in below) succeeds, these setup
                    // instructions have served their purpose and just add clutter.
                    (!config.host || config.host === '192.168.1.0') && (
                      <Text style={styles.toggleHint}>
                        First time? TickTick needs a small helper program running on
                        your computer to handle the sign-in -- your Supernote can't do
                        that part itself. Open a terminal in the project's{' '}
                        ticktick-server folder and run{'\n'}
                        `npm run authorize`{'\n'}
                        to sign in with your TickTick account (see that folder's
                        README for step-by-step help). Once it's running, tap FIND
                        SERVER ON WI-FI above, or type its address in below. To switch
                        accounts later, just run authorize again.
                      </Text>
                    )}
                  <Field
                    label="Server IP / host"
                    value={config.host}
                    onChangeText={v => setConfig(setActiveConnection(config, {host: v}))}
                  />
                  <Field
                    label="Port"
                    value={String(config.port)}
                    onChangeText={v =>
                      setConfig(setActiveConnection(config, {port: parseInt(v, 10) || config.port}))
                    }
                  />
                </>
              )}

              <Text style={styles.stepLabel}>Step 2 · Choose the list to sync the current note page</Text>
              <Pressable style={styles.pickerButton} onPress={runChooseList}>
                <Text style={styles.pickerButtonText}>
                  {config.listName ? config.listName : 'No list selected'}
                </Text>
                <Text style={styles.pickerButtonHint}>
                  {listPickerOpen ? 'Tap a list below…' : 'Tap to choose from the server…'}
                </Text>
              </Pressable>
              {listPickerOpen && listOptions && (
                <View style={styles.listPicker}>
                  {listOptions.map(name => {
                    const selected = name === config.listName;
                    return (
                      <Pressable
                        key={name}
                        style={[styles.listOption, selected && styles.listOptionOn]}
                        onPress={() => selectList(name)}>
                        <Text style={[styles.listOptionText, selected && styles.listOptionTextOn]}>
                          {selected ? '✓ ' : ''}{name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {config.profiles[config.activeProfile]?.backend === 'ticktick' && (
                <>
                  <Text style={styles.stepLabel}>Status</Text>
                  <Text style={styles.toggleHint}>
                    {ticktickMeta.lastSyncAt
                      ? `Last synced ${new Date(ticktickMeta.lastSyncAt).toLocaleString()}`
                      : 'Not synced yet -- tap "Sync tasks" above.'}
                    {ticktickMeta.lastError ? `\n⚠ ${ticktickMeta.lastError}` : ''}
                  </Text>
                </>
              )}
            </View>
            )}

            <Text style={styles.sectionLabel}>Lasso Capture Target</Text>
            <Text style={styles.toggleHint}>
              "Add to Ink2Task" (the lasso button on OTHER notes) files the
              captured text into ONE of your Ink2Task pages. By default:
              whichever page you synced most recently -- so to switch where
              captures go, just sync the page you want first, same as any
              other sync. Pin it below to always use one specific page/list
              instead, ignoring whatever you synced last.
            </Text>
            {(() => {
              const boundPages = Object.entries(config.pageBindings || {})
                .map(([key, binding]) => {
                  const idx = key.lastIndexOf('#');
                  return {
                    notePath: key.slice(0, idx),
                    page: parseInt(key.slice(idx + 1), 10),
                    binding,
                  };
                })
                .filter(p => p.notePath === toAbsolute(config.notePath))
                .sort((a, b) => a.page - b.page);
              const pageLabel = (p: {page: number; binding: PageBinding}) =>
                `Page ${p.page} — ${config.profiles[p.binding.profileIndex]?.label || 'Unknown'} - ${
                  p.binding.listName
                }`;
              const current = config.lassoTargetOverride
                ? boundPages.find(
                    p =>
                      p.notePath === config.lassoTargetOverride!.notePath &&
                      p.page === config.lassoTargetOverride!.page,
                  )
                : undefined;
              const currentLabel = config.lassoTargetOverride
                ? current
                  ? pageLabel(current)
                  : `Page ${config.lassoTargetOverride.page} (pinned)`
                : 'Use last-synced page (default)';
              return (
                <>
                  <Pressable
                    style={styles.pickerButton}
                    onPress={() => setLassoPickerOpen(o => !o)}>
                    <Text style={styles.pickerButtonText}>{currentLabel}</Text>
                    <Text style={styles.pickerButtonHint}>
                      {lassoPickerOpen ? 'Tap to choose below…' : 'Tap to change…'}
                    </Text>
                  </Pressable>
                  {lassoPickerOpen && (
                    <View style={styles.listPicker}>
                      <Pressable
                        style={[styles.listOption, !config.lassoTargetOverride && styles.listOptionOn]}
                        onPress={() => {
                          setConfig(withLassoTargetOverride(config, null));
                          setLassoPickerOpen(false);
                        }}>
                        <Text
                          style={[
                            styles.listOptionText,
                            !config.lassoTargetOverride && styles.listOptionTextOn,
                          ]}>
                          {!config.lassoTargetOverride ? '✓ ' : ''}Use last-synced page (default)
                        </Text>
                      </Pressable>
                      {boundPages.length === 0 && (
                        <Text style={[styles.listOptionText, {padding: 14}]}>
                          Nothing else to pick yet -- sync a page at least once and it'll appear here.
                        </Text>
                      )}
                      {boundPages.map(p => {
                        const selected =
                          !!config.lassoTargetOverride &&
                          config.lassoTargetOverride.notePath === p.notePath &&
                          config.lassoTargetOverride.page === p.page;
                        return (
                          <Pressable
                            key={`${p.notePath}#${p.page}`}
                            style={[styles.listOption, selected && styles.listOptionOn]}
                            onPress={() => {
                              setConfig(
                                withLassoTargetOverride(config, {notePath: p.notePath, page: p.page}),
                              );
                              setLassoPickerOpen(false);
                            }}>
                            <Text style={[styles.listOptionText, selected && styles.listOptionTextOn]}>
                              {selected ? '✓ ' : ''}
                              {pageLabel(p)}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </>
              );
            })()}

            <Text style={styles.sectionLabel}>Text appearance</Text>
            <View style={styles.appearanceRow}>
              {FONTS.map(f => {
                const selected = (config.fontPath || '') === f.path;
                return (
                  <Pressable
                    key={f.name}
                    style={[styles.fontChip, selected && styles.fontChipOn]}
                    onPress={() => setConfig({...config, fontPath: f.path})}>
                    <Text style={[styles.fontChipText, selected && styles.fontChipTextOn]}>
                      {f.name}
                    </Text>
                  </Pressable>
                );
              })}
              <View style={styles.sizeControl}>
                <Pressable
                  style={styles.stepperButton}
                  onPress={() =>
                    setConfig({
                      ...config,
                      listScale: Math.max(0.6, Math.round((config.listScale - 0.1) * 10) / 10),
                    })
                  }>
                  <Text style={styles.stepperText}>−</Text>
                </Pressable>
                <Text style={styles.sizeValue}>{Math.round(config.listScale * 100)}%</Text>
                <Pressable
                  style={styles.stepperButton}
                  onPress={() =>
                    setConfig({
                      ...config,
                      listScale: Math.min(2, Math.round((config.listScale + 0.1) * 10) / 10),
                    })
                  }>
                  <Text style={styles.stepperText}>+</Text>
                </Pressable>
              </View>
            </View>

            <Text style={styles.sectionLabel}>Time format</Text>
            <View style={[styles.fontRow, {marginTop: 4}]}>
              <Pressable
                style={[styles.fontChip, !config.use24HourTime && styles.fontChipOn]}
                onPress={() => setConfig({...config, use24HourTime: false})}>
                <Text style={[styles.fontChipText, !config.use24HourTime && styles.fontChipTextOn]}>
                  12-hour (2:45 PM)
                </Text>
              </Pressable>
              <Pressable
                style={[styles.fontChip, !!config.use24HourTime && styles.fontChipOn]}
                onPress={() => setConfig({...config, use24HourTime: true})}>
                <Text style={[styles.fontChipText, !!config.use24HourTime && styles.fontChipTextOn]}>
                  24-hour (14:45)
                </Text>
              </Pressable>
            </View>
            <Text style={styles.toggleHint}>
              Applies to DUE times and LAST UPDATED on the checklist page --
              takes effect on the next sync.
            </Text>

            <Text style={styles.sectionLabel}>On-page SYNC button</Text>
            <View style={[styles.fontRow, {marginTop: 4}]}>
              <Pressable
                style={[styles.fontChip, config.onPageSyncEnabled !== false && styles.fontChipOn]}
                onPress={() => setConfig({...config, onPageSyncEnabled: true})}>
                <Text
                  style={[
                    styles.fontChipText,
                    config.onPageSyncEnabled !== false && styles.fontChipTextOn,
                  ]}>
                  On
                </Text>
              </Pressable>
              <Pressable
                style={[styles.fontChip, config.onPageSyncEnabled === false && styles.fontChipOn]}
                onPress={() => setConfig({...config, onPageSyncEnabled: false})}>
                <Text
                  style={[
                    styles.fontChipText,
                    config.onPageSyncEnabled === false && styles.fontChipTextOn,
                  ]}>
                  Off
                </Text>
              </Pressable>
            </View>
            <Text style={styles.toggleHint}>
              The SYNC button drawn on the checklist page itself. Rarely, a
              tap in that same corner spot while leaving the note (e.g. to
              the note picker) can trigger a sync -- a known Supernote SDK
              limitation with no reliable fix. Turn this off to rely only on
              the "Sync tasks" button above, which has none of that risk.
            </Text>

            <Text style={styles.versionText}>
              Settings save automatically · Ink2Task v{pluginConfig.versionName}
            </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

// E-ink friendly: high contrast, no gradients, no animation beyond the
// built-in ActivityIndicator spinner used only while a network call is in flight.
const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#ffffff'},
  scroll: {padding: 24, paddingTop: 48},
  closeButton: {position: 'absolute', top: 12, right: 12, padding: 10, zIndex: 10},
  closeText: {fontSize: 20, fontWeight: '600', color: '#000000'},
  title: {fontSize: 28, fontWeight: '700', color: '#000000', marginBottom: 4},
  subtitle: {fontSize: 16, color: '#333333', marginBottom: 24},
  primaryButton: {
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryButtonDisabled: {borderColor: '#aaaaaa'},
  primaryButtonText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  primaryButtonTextDisabled: {color: '#aaaaaa'},
  secondaryButton: {paddingVertical: 10, alignItems: 'center', marginTop: 4},
  secondaryButtonText: {fontSize: 17, color: '#000000', textDecorationLine: 'underline'},
  // Prominent all-caps button (e.g. FIND SERVER ON WI-FI).
  wideButton: {
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  wideButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  activeProfileNote: {fontSize: 16, fontWeight: '700', color: '#000000', marginTop: 2, marginBottom: 2},
  // "Step 1 / Step 2" sub-headings inside the Sync Settings box.
  stepLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: '#000000',
    marginTop: 20,
    marginBottom: 6,
  },
  // Step-2 list picker options.
  listPicker: {
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 6,
    marginTop: 6,
    overflow: 'hidden',
  },
  listOption: {paddingVertical: 12, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: '#dddddd'},
  listOptionOn: {backgroundColor: '#eeeeee'},
  listOptionText: {fontSize: 18, color: '#000000'},
  listOptionTextOn: {fontWeight: '700'},
  versionText: {fontSize: 12, color: '#8a8a8a', textAlign: 'center', marginTop: 18},
  statusBox: {
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 6,
    padding: 12,
    marginTop: 8,
    marginBottom: 8,
  },
  statusText: {fontSize: 17, color: '#000000'},
  hint: {fontSize: 15, color: '#555555', marginBottom: 16},
  settingsHeading: {
    marginTop: 28,
    marginBottom: 4,
    fontSize: 18,
    fontWeight: '700',
    color: '#000000',
    borderTopWidth: 1,
    borderTopColor: '#cccccc',
    paddingTop: 20,
  },
  settingsBox: {marginTop: 0},
  sectionLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000000',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 22,
    marginBottom: 10,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#dddddd',
    flexShrink: 1,
  },
  // Row that makes a section heading tappable to collapse/expand.
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  collapseChevron: {fontSize: 18, fontWeight: '700', color: '#000000', marginLeft: 8, marginTop: 22},
  fontRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  // Font chips and the List-size stepper share one row.
  appearanceRow: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4},
  sizeControl: {flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto'},
  sizeValue: {fontSize: 16, fontWeight: '700', color: '#000000', minWidth: 48, textAlign: 'center'},
  fontChip: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  fontChipOn: {backgroundColor: '#000000'},
  fontChipText: {fontSize: 17, color: '#000000'},
  fontChipTextOn: {color: '#ffffff'},
  stepperRow: {flexDirection: 'row', gap: 12, marginTop: 6},
  stepperButton: {
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 8,
    width: 64,
    paddingVertical: 8,
    alignItems: 'center',
  },
  stepperText: {fontSize: 24, fontWeight: '700', color: '#000000'},
  field: {marginBottom: 14},
  fieldLabel: {fontSize: 16, color: '#444444', marginBottom: 4},
  pickerButton: {
    borderWidth: 1,
    borderColor: '#000000',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pickerButtonText: {fontSize: 18, color: '#000000', fontWeight: '600', flexShrink: 1},
  pickerButtonHint: {fontSize: 15, color: '#555555', marginLeft: 8},
  toggleHint: {fontSize: 15, color: '#555555', marginTop: 2},
  fieldInput: {
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 18,
    color: '#000000',
  },
});
