/**
 * Config persistence for Ink2Task.
 *
 * Stored outside the plugin package (in MyStyle/Ink2Task/) so it survives
 * plugin reinstalls -- same pattern SuperTask uses for its Todoist token.
 * Uses react-native-fs directly against the absolute shared-storage path
 * rather than the SDK's FileUtils, which only exposes exists/copy/move/
 * delete/list -- no arbitrary text read/write.
 *
 * There's no secret in this config (a LAN host/port and a list name), so
 * unlike a Todoist token it's fine to leave as plain, USB-editable JSON.
 */
import RNFS from 'react-native-fs';
import {
  shiftPageKeys,
  shiftPageRef,
  shiftTemplatedCount,
  unshiftPageKeys,
  unshiftPageRef,
} from './pageShift';
import {requireFileRead, requireFileWrite} from './permissions';
import {PluginManager} from 'sn-plugin-lib';
import {Dimensions, PixelRatio} from 'react-native';
import {isMantaClass} from './deviceSize';
// Safe: notePicker.ts imports nothing, so this cannot create a cycle. Needed so
// the templated-page helpers below key on the SAME normalised path the SDK and
// resolveTarget use -- configs can hold the old short form ("/Note/x.note").
import {toAbsolute} from './notePicker';

const CONFIG_DIR = '/storage/emulated/0/MyStyle/Ink2Task';
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
/** Previous good copy, taken once per session before the first write. */
const CONFIG_BACKUP = `${CONFIG_DIR}/config.json.bak`;
const REGISTRY_FILE = `${CONFIG_DIR}/checklist-registry.json`;
// Where a lasso-captured task came from, so the checklist can draw a link back.
// Deliberately its OWN file rather than a config field: the Home screen
// auto-saves its in-memory config on every change, so a background write into
// config.json would get clobbered by the next setConfig.
const SOURCES_FILE = `${CONFIG_DIR}/task-sources.json`;
// Fingerprints of ink each page's last sync erased -- used to ignore strokes the
// host restores when the plugin is reinstalled. See loadErasedInk.
const ERASED_INK_FILE = `${CONFIG_DIR}/erased-ink.json`;
// TickTick-specific two-way sync bookkeeping -- see ticktickSync.ts. Kept as
// its OWN files rather than folded into the registry: they track per-task
// change-detection state (what we last synced) and a pending-mutation outbox,
// neither of which any other backend needs, so this stays purely additive.
const TICKTICK_SYNC_STATE_FILE = `${CONFIG_DIR}/ticktick-sync-state.json`;
const TICKTICK_OUTBOX_FILE = `${CONFIG_DIR}/ticktick-outbox.json`;
// Last-sync status shown in Settings -- see TickTickSyncMeta below.
const TICKTICK_META_FILE = `${CONFIG_DIR}/ticktick-sync-meta.json`;

// The plugin was formerly called "SuperRemind"; its settings + registry lived
// here. On first run under the new name we copy them across (see migrateLegacy),
// so an upgrade keeps the user's token, list, and per-page bindings.
const LEGACY_DIR = '/storage/emulated/0/MyStyle/SuperRemind';
const LEGACY_CONFIG_FILE = `${LEGACY_DIR}/config.json`;
const LEGACY_REGISTRY_FILE = `${LEGACY_DIR}/checklist-registry.json`;

/**
 * A saved server connection. The plugin keeps two of these (e.g. the Mac
 * Reminders server and a Google Tasks server) and switches between them; the
 * active one's host/port/listName are mirrored to the top-level fields below so
 * the rest of the code never has to know profiles exist.
 */
export type ConnectionProfile = {
  /** Short label shown on the switcher, e.g. "Apple Reminders" or "Google Tasks". */
  label: string;
  /** Which backend this profile expects, so Wi-Fi discovery finds the right server. */
  backend: 'apple' | 'google' | 'todoist' | 'ticktick';
  host: string;
  port: number;
  listName: string;
  /**
   * Todoist personal API token. When set on a Todoist profile, the plugin talks
   * DIRECTLY to Todoist's cloud API (no companion server) and host/port are
   * ignored -- SuperTask-style. Leave blank to use a todoist-server instead.
   */
  token?: string;
};

export type Ink2TaskConfig = {
  /** LAN IP or hostname of the active companion server. Mirrors profiles[active]. */
  host: string;
  port: number;
  /** Name of the list to sync, must match exactly. Mirrors profiles[active]. */
  listName: string;
  /** The two saved server connections. */
  profiles: ConnectionProfile[];
  /** Index into profiles of the one currently in use. */
  activeProfile: number;
  /** The one note the checklist lives in. Not user-configurable -- see ensureNote. */
  notePath: string;
  /** Absolute path to a font file for the checklist text; '' = system default. */
  fontPath: string;
  /** Scales the whole checklist (text, checkboxes, rows). 1 = default size. */
  listScale: number;
  /**
   * Task rows per page: 'standard' (14), 'compact' (18), or 'dense' (21) --
   * see utils/rowDensity.ts. Text, checkboxes, and capture boxes scale down to
   * match. Only applies where the plugin draws the ruling itself: notes created
   * from the v17+ (unruled) template and "use current note" pages. A note
   * created from the older ruled template keeps its printed 14 rows -- the
   * ruling is baked into its page background and cannot change (see
   * rowsForRun). Optional/undefined behaves as 'standard', so existing configs
   * need no migration.
   */
  rowDensity?: 'standard' | 'compact' | 'dense';
  /**
   * Whether a sync may add pages to the checklist note so a long list can
   * continue onto further pages, up to MAX_PAGES (see ./pagination).
   *
   * ON by default (user's call, 2026-08-22): a long list silently truncating to
   * one page is the more surprising behaviour of the two, and the pages are
   * reclaimed automatically when the list shrinks again. `undefined` therefore
   * reads as ON, which also switches the feature on for configs written before
   * this field existed. Set false to keep everything on one page.
   */
  autoAddPages?: boolean;
  /**
   * Where a newly created task is placed in the list: at the END (default) or
   * at the START. Applies to handwriting capture, lasso capture, and anything
   * else that creates a task.
   *
   * Support is per backend, verified 2026-08-22 against real accounts:
   *   Todoist      -- `order: 1` on create. (`child_order` is ignored on write.)
   *   Google Tasks -- omit `previous`, which inserts at the top.
   *   TickTick     -- `sortOrder`, a large negative value. UNVERIFIED on write.
   *   Apple        -- not possible; EventKit exposes no ordering at all.
   * On Apple the setting is simply inert rather than an error.
   */
  newTaskPosition?: 'start' | 'end';
  /**
   * How many leading pages of a note were created BY US from the Ink2Task
   * template, keyed by absolute note path. ensureNote makes page 0, so 1 is the
   * baseline; each continuation page this plugin adds bumps it.
   *
   * Exists because `isTemplatePage` (which decides whether to draw the chrome
   * or trust a baked-in background) was inferred from `getNoteTotalPageNum()
   * === 1`. That heuristic is a safety net for `getCurrentPageNum()`'s
   * undocumented 0- vs 1-based indexing, and it silently stops working the
   * moment a note has more than one page: on a 3-page note it would report the
   * templated first page as un-templated and draw a SECOND SYNC button and DUE
   * header on top of the baked ones (a bug already seen on-device once).
   *
   * Recording what we actually created removes the guess for our own pages.
   * Pages the USER added with the device's note tools are still blank and still
   * need their chrome drawn, which is why this is a count of leading pages
   * rather than a flag on the note.
   */
  templatedPages?: {[notePath: string]: number};
  /**
   * Fingerprint of what is currently drawn on each page, keyed by
   * registryKey(notePath, page). Lets a sync skip repainting a page whose
   * content has not changed -- see utils/pageSignature.ts. Missing or stale
   * entries simply cause a redraw, which is the old behaviour, so this needs
   * no migration and is safe to clear at any time.
   */
  pageSignatures?: {[key: string]: string};
  /**
   * 24-hour ("military") time instead of 12-hour AM/PM for every time drawn
   * on the checklist page (DUE times, LAST UPDATED). Off (12-hour) by
   * default. Optional/undefined behaves as false, so existing configs from
   * before this setting existed don't need migrating.
   */
  use24HourTime?: boolean;
  /**
   * Whether the on-page SYNC button (index.js's global motion listener) is
   * active. On (undefined behaves as true) by default. Off lets a user who's
   * hit the "fires a sync while exiting to the note picker" issue eliminate
   * it entirely -- the underlying cause is a confirmed Supernote SDK gap
   * (no signal exists to tell "genuinely on this note" from "coordinates
   * happen to match", see [[ink2task-sdk-gotchas]]), so this is the only
   * complete fix; a smaller/stricter zone only reduces the odds. Disabling
   * it leaves the Settings screen's "Sync tasks" button as the only way to
   * sync, which has none of this ambiguity (it only runs while that screen
   * is genuinely open).
   */
  onPageSyncEnabled?: boolean;
  /**
   * Which profile+list each PAGE of the note syncs, keyed by
   * `${notePath}#${page}` -- so adding a page (via the device's own note
   * tools) and syncing it gives that page its own backend/list, independent
   * of the others (e.g. one page synced to Todoist, another to Reminders).
   * Falls back to the active profile/list for pages that were never bound.
   */
  pageBindings?: {[key: string]: PageBinding};
  /**
   * The page most recently VIEWED (on-page button tap or the Settings
   * screen's Sync button -- the only moments this plugin can confirm which
   * page you're on, see resolveTarget). Lasso capture (from ANY other note)
   * defaults new tasks here instead of always page 0, so it follows
   * whichever list you're actively using. Deliberately not tied to a sync
   * actually completing -- it's set as soon as the page is confirmed, even
   * if the sync that follows fails or is skipped.
   */
  lastViewedPage?: PageRef;
  /**
   * Pins lasso captures to a specific page/list, overriding lastViewedPage.
   * Set from Settings; absent/null means "off" (use lastViewedPage).
   */
  lassoTargetOverride?: PageRef | null;
};

/** A specific page of the (one) Ink2Task note. */
export type PageRef = {notePath: string; page: number};

export type PageBinding = {profileIndex: number; listName: string};

const DEFAULT_NOTE_PATH = '/Note/Ink2Task/Ink2Task.note';
const MANTA_NOTE_PATH = '/Note/Ink2Task/Ink2Task Manta.note';

async function defaultNotePathForDevice(): Promise<string> {
  // Same two-signal check the template uses (see isMantaClass): a real Manta
  // was seen reporting itself as a Nomad, and the two must agree or the note
  // and its baked template would be mismatched.
  let deviceType: number | undefined;
  try {
    deviceType = await PluginManager.getDeviceType();
  } catch {}
  const screen = Dimensions.get('screen');
  return isMantaClass({deviceType, screen, pixelRatio: PixelRatio.get()})
    ? MANTA_NOTE_PATH
    : DEFAULT_NOTE_PATH;
}

// Hosts start EMPTY, not at a placeholder address.
//
// The old default was '192.168.1.0', which can never work: .0 is a network
// address, not a host. Worse, it made a fresh install look configured, so the
// first sync failed with "can't reach the server" as though something were
// broken rather than simply unset -- and an empty host is what lets
// taskCallWithAutoRecover know to go and FIND the server instead (2026-08-23).
const DEFAULT_CONFIG: Ink2TaskConfig = {
  host: '',
  port: 8942,
  listName: 'Inbox',
  profiles: [
    {label: 'Apple Reminders', backend: 'apple', host: '', port: 8942, listName: 'Inbox'},
    {label: 'Google Tasks', backend: 'google', host: '', port: 8943, listName: 'Inbox'},
    {label: 'Todoist', backend: 'todoist', host: '', port: 8944, listName: 'Inbox'},
    {label: 'TickTick', backend: 'ticktick', host: '', port: 8955, listName: 'Inbox'},
  ],
  activeProfile: 0,
  notePath: DEFAULT_NOTE_PATH,
  fontPath: '',
  listScale: 1,
  autoAddPages: true,
  newTaskPosition: 'end',
};

async function ensureDir(): Promise<void> {
  // The single choke point for WRITING to shared storage: this creates the
  // directory. Declaring FILE:WRITE in PluginConfig.json is not granting it,
  // and without this the preview firmware refuses the write outright ("Plugin
  // [ink2task001] has no WRITE permission on sdcard") and everything
  // downstream fails quietly. See utils/permissions.ts.
  await requireFileWrite();
  const dirExists = await RNFS.exists(CONFIG_DIR);
  if (!dirExists) {
    await RNFS.mkdir(CONFIG_DIR);
  }
}

/**
 * One-time migration from the old "SuperRemind" folder. If we have no config yet
 * but the old one exists, copy the config and registry into the new Ink2Task
 * folder so the rename is seamless (token, lists, per-page bindings all carry
 * over). Best-effort: any failure just falls through to a fresh default config.
 */
async function migrateLegacy(): Promise<void> {
  try {
    if (await RNFS.exists(CONFIG_FILE)) return; // already migrated / already set up
    if (!(await RNFS.exists(LEGACY_CONFIG_FILE))) return; // nothing to migrate
    await ensureDir();
    await RNFS.copyFile(LEGACY_CONFIG_FILE, CONFIG_FILE);
    if ((await RNFS.exists(LEGACY_REGISTRY_FILE)) && !(await RNFS.exists(REGISTRY_FILE))) {
      await RNFS.copyFile(LEGACY_REGISTRY_FILE, REGISTRY_FILE);
    }
    console.log('Ink2Task: migrated settings from the old SuperRemind folder');
  } catch (e) {
    console.log('Ink2Task: legacy migration skipped', e);
  }
}

export async function loadConfig(): Promise<Ink2TaskConfig> {
  // READ only. Opening Settings just reads this file, and asking to modify
  // files at the same time put a second dialog in front of someone who had not
  // yet seen the screen. The write permission is asked for when something is
  // actually saved -- see writeConfigFile.
  await requireFileRead();
  try {
    await migrateLegacy();
    const devicePath = await defaultNotePathForDevice();
    const exists = await RNFS.exists(CONFIG_FILE);
    if (!exists) {
      const seeded = {...DEFAULT_CONFIG, notePath: devicePath};
      await saveConfig(seeded);
      return seeded;
    }
    const raw = await readConfigOrBackup();
    const parsed = JSON.parse(raw);
    const merged = normalizeProfiles({...DEFAULT_CONFIG, ...parsed});
    // Each device gets its own note at native resolution (A5X/Nomad share
    // 1404x1872; Manta gets 1920x2560) so cloud-synced devices don't fight
    // over a single page size. Always resolve to the current device's path.
    if (merged.notePath !== devicePath) {
      merged.notePath = devicePath;
    }
    return merged;
  } catch (e: any) {
    // DO NOT fall back to defaults here. That is what destroyed a real config:
    // the read was refused (no file permission on the preview firmware), this
    // returned pristine defaults, the screen marked itself loaded, and the
    // auto-save effect then wrote those defaults straight over the user's
    // settings -- every host blanked and the Todoist token gone (device
    // 2026-08-24). A read we cannot trust must stop the screen, not seed it.
    //
    // The genuinely-missing-file case is handled above and still seeds
    // defaults, and readConfigOrBackup below handles a corrupt file, so this
    // path means something unexpected went wrong and losing data is the worse
    // outcome.
    console.log('[Ink2Task] config load failed:', e?.message || e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * Reads the config, falling back to the backup copy if the main file will not
 * parse, and setting the bad file aside rather than deleting it.
 *
 * Exists because the config is the only record of a hand-typed 40-character
 * Todoist token, on a device where that field cannot paste. Re-typing it
 * because a file got truncated is a genuinely bad half-hour.
 */
async function readConfigOrBackup(): Promise<string> {
  const raw = await RNFS.readFile(CONFIG_FILE, 'utf8');
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // Main file is corrupt. Try the backup before doing anything destructive.
  }
  try {
    if (await RNFS.exists(CONFIG_BACKUP)) {
      const backup = await RNFS.readFile(CONFIG_BACKUP, 'utf8');
      JSON.parse(backup);
      console.log('[Ink2Task] config was unreadable; recovered from the backup');
      await RNFS.writeFile(`${CONFIG_FILE}.corrupt`, raw, 'utf8').catch(() => {});
      return backup;
    }
  } catch {
    // Backup is no better; fall through.
  }
  // Keep the unreadable file for inspection rather than silently binning it,
  // then let the caller's JSON.parse throw so the screen reports a problem.
  await RNFS.writeFile(`${CONFIG_FILE}.corrupt`, raw, 'utf8').catch(() => {});
  return raw;
}

/**
 * Ensures the three-profile shape. An old flat config (pre-profiles) seeds
 * profile 0 from its saved Mac settings; profiles missing since then (Google,
 * Todoist) are appended without disturbing the ones already there. Keeps the
 * top-level host/port/listName in sync with whichever profile is active.
 */
const PROFILE_DEFAULTS: ConnectionProfile[] = [
  {label: 'Apple Reminders', backend: 'apple', host: '192.168.1.0', port: 8942, listName: 'Inbox'},
  {label: 'Google Tasks', backend: 'google', host: '', port: 8943, listName: 'Inbox'},
  {label: 'Todoist', backend: 'todoist', host: '', port: 8944, listName: 'Inbox'},
  {label: 'TickTick', backend: 'ticktick', host: '192.168.1.0', port: 8955, listName: 'Inbox'},
];

function normalizeProfiles(config: Ink2TaskConfig): Ink2TaskConfig {
  if (!Array.isArray(config.profiles) || config.profiles.length === 0) {
    // Pre-profiles flat config: seed profile 0 from the saved connection.
    config.profiles = [{...PROFILE_DEFAULTS[0], host: config.host, port: config.port, listName: config.listName}];
    config.activeProfile = 0;
  }
  // Append any profiles added in later versions (Google, then Todoist), keeping
  // the user's existing ones untouched.
  for (let i = config.profiles.length; i < PROFILE_DEFAULTS.length; i++) {
    config.profiles.push({...PROFILE_DEFAULTS[i]});
  }
  // Upgrade the original short labels, and backfill the backend id (by slot) for
  // profiles saved before it existed, so Wi-Fi discovery can target the right server.
  config.profiles = config.profiles.map((p, i) => ({
    ...p,
    label: p.label === 'Mac' ? 'Apple Reminders' : p.label === 'Google' ? 'Google Tasks' : p.label,
    backend: p.backend ?? (PROFILE_DEFAULTS[i]?.backend ?? 'apple'),
  }));
  const idx = config.activeProfile >= 0 && config.activeProfile < config.profiles.length
    ? config.activeProfile
    : 0;
  const active = config.profiles[idx];
  return {...config, activeProfile: idx, host: active.host, port: active.port, listName: active.listName};
}

/**
 * Applies a host/port/listName change to both the top-level fields and the
 * active profile, so edits stick to the profile you're on.
 */
export function setActiveConnection(
  config: Ink2TaskConfig,
  patch: Partial<Pick<Ink2TaskConfig, 'host' | 'port' | 'listName'>>,
): Ink2TaskConfig {
  const profiles = config.profiles.map((p, i) =>
    i === config.activeProfile ? {...p, ...patch} : p,
  );
  return {...config, ...patch, profiles};
}

/**
 * Switches to the other saved profile, loading its host/port/listName into the
 * active fields. The current edits are already mirrored into their profile via
 * setActiveConnection, so nothing is lost.
 */
export function switchProfile(config: Ink2TaskConfig, index: number): Ink2TaskConfig {
  if (index < 0 || index >= config.profiles.length || index === config.activeProfile) {
    return config;
  }
  const target = config.profiles[index];
  return {
    ...config,
    activeProfile: index,
    host: target.host,
    port: target.port,
    listName: target.listName,
  };
}

/**
 * Replaces a stale host:port (e.g. the Mac's LAN IP changed via DHCP) with a
 * freshly-discovered one, across every profile that shared the stale
 * address -- not just the active one, in case two profiles pointed at the
 * same machine (e.g. mac-server and google-tasks-server side by side).
 * Ported from Ink2Day's autoRecover.ts, which added this after a
 * device-reported sync hang/failure traced to exactly this: config.json
 * still pointing at an old address with no automatic way to notice.
 */
export function replaceStaleServerAddress(
  config: Ink2TaskConfig,
  staleHost: string,
  stalePort: number,
  freshHost: string,
  freshPort: number,
): Ink2TaskConfig {
  const matches = (h: string, p: number) => h === staleHost && p === stalePort;
  const profiles = config.profiles.map(p =>
    matches(p.host, p.port) ? {...p, host: freshHost, port: freshPort} : p,
  );
  const top = matches(config.host, config.port) ? {host: freshHost, port: freshPort} : {};
  return {...config, ...top, profiles};
}

/**
 * Serialised, coalescing config writer.
 *
 * Settings auto-save on every change (Home.tsx has no Save button), and the
 * token field fires one save PER KEYSTROKE. Unserialised, that launched ~40
 * overlapping RNFS.writeFile calls at the same path while a Todoist token was
 * typed in, and whichever finished last won -- which is not necessarily the one
 * carrying the most characters. That is why a token could look typed in and
 * simply not be there afterwards (device-reported 2026-08-24).
 *
 * `pending` also coalesces: while a write is in flight, only the LATEST
 * snapshot is kept, so 40 keystrokes cost two or three writes rather than 40.
 */
let writeChain: Promise<void> = Promise.resolve();
let pendingConfig: Ink2TaskConfig | null = null;
/**
 * One backup per plugin session, taken before the first write. Enough to undo a
 * same-session accident (the defaults-overwrite above), without doubling the
 * file writes on every keystroke.
 */
let backedUpThisSession = false;

async function backupOnce(): Promise<void> {
  if (backedUpThisSession) return;
  backedUpThisSession = true;
  try {
    if (await RNFS.exists(CONFIG_FILE)) {
      await RNFS.copyFile(CONFIG_FILE, CONFIG_BACKUP);
    }
  } catch {
    // A missing backup only costs us a recovery option; never block the save.
  }
}

async function writeConfigFile(config: Ink2TaskConfig): Promise<void> {
  await ensureDir();
  await backupOnce();
  const json = JSON.stringify(config, null, 2);
  // Write beside the real file and move it into place, so a write interrupted
  // half way (the plugin view being torn down, the host reclaiming us) cannot
  // leave a truncated config behind. Falls back to writing directly if the
  // platform will not overwrite on move -- a direct write is what we did before
  // and is still far better than not saving at all.
  const tmp = `${CONFIG_FILE}.tmp`;
  try {
    await RNFS.writeFile(tmp, json, 'utf8');
    await RNFS.moveFile(tmp, CONFIG_FILE);
  } catch {
    await RNFS.writeFile(CONFIG_FILE, json, 'utf8');
    try {
      if (await RNFS.exists(tmp)) await RNFS.unlink(tmp);
    } catch {
      // leftover temp file is harmless
    }
  }
}

export async function saveConfig(config: Ink2TaskConfig): Promise<void> {
  pendingConfig = config;
  writeChain = writeChain
    .then(async () => {
      const next = pendingConfig;
      if (!next) return; // a later call already wrote this snapshot
      pendingConfig = null;
      await writeConfigFile(next);
    })
    .catch(() => {
      // Never let one failed write poison the chain for every later save.
    });
  return writeChain;
}

/**
 * The registry links a drawn checkbox on a specific note page to the
 * Apple Reminders item it represents. Sync reads from this -- reminder
 * identity is never re-derived from handwriting or on-page text.
 */
export type ChecklistEntry = {
  /**
   * 'synced' rows map to an Apple reminder (existing behavior). 'blank' rows
   * are empty capture slots -- a checkbox + rectangle to handwrite a task into,
   * promoted to 'synced' once captured. Blank rows carry no reminderId.
   */
  kind: 'synced' | 'blank';
  /** Present only on synced rows. */
  reminderId?: string;
  /** Reminder title on synced rows; empty string on blank rows. */
  title: string;
  /**
   * True for rows captured from handwriting: they stay in place (the ink is
   * kept), get a typed caption, and are excluded from the fetched typed rows so
   * the same reminder isn't drawn twice.
   */
  captured?: boolean;
  /**
   * Subtask nesting depth of this row as drawn: absent or 0 for a top-level
   * task, 1 for a child, and so on. Derived from the backend's parentId chain
   * at draw time (see subtaskDepths) and persisted here because the capture
   * flow needs it: resolving a handwritten "> buy milk" to a parent means
   * looking at the depth of the rows above it, and this registry is the only
   * record of what the page currently shows.
   */
  depth?: number;
  /** Checkbox bounding box in screen coordinates. */
  box: {left: number; top: number; right: number; bottom: number};
  /**
   * The handwriting rectangle in the label column (blank rows). Stored so the
   * capture flow can tell which row a lasso selection falls in.
   */
  rect?: {left: number; top: number; right: number; bottom: number};
  /**
   * The DUE-column box for handwriting a date. Present on rows that don't already
   * show a due date (blank rows, and synced rows whose task has no due yet); the
   * capture flow scans it, parses a date, and sets it on the task.
   */
  dueRect?: {left: number; top: number; right: number; bottom: number};
  /** Where the label text starts/ends horizontally, so a strike matches it. */
  textStart?: number;
  textEnd?: number;
  /** Set once the task has been completed and struck through, in keep mode. */
  completed?: boolean;
};

export type ChecklistRegistry = {
  [notePathAndPage: string]: ChecklistEntry[];
};

export async function loadRegistry(): Promise<ChecklistRegistry> {
  try {
    const exists = await RNFS.exists(REGISTRY_FILE);
    if (!exists) return {};
    const raw = await RNFS.readFile(REGISTRY_FILE, 'utf8');
    const registry: ChecklistRegistry = JSON.parse(raw);
    // Legacy entries predate `kind`; infer it from whether they have a reminder.
    for (const key of Object.keys(registry)) {
      for (const entry of registry[key]) {
        if (!entry.kind) entry.kind = entry.reminderId ? 'synced' : 'blank';
      }
    }
    return registry;
  } catch (e) {
    console.log('Ink2Task: registry load failed', e);
    return {};
  }
}

export async function saveRegistryEntries(
  key: string,
  entries: ChecklistEntry[],
): Promise<void> {
  const registry = await loadRegistry();
  registry[key] = entries;
  await ensureDir();
  await RNFS.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * Renumbers every page-indexed record after a page is inserted mid-note.
 *
 * Call this IMMEDIATELY after a successful insertNotePage, before anything else
 * reads any of these stores. Inserting shifts the note's later pages up by one,
 * and until this runs, six stores describe the note as it was a moment ago.
 *
 * Returns the updated config for the caller to save; the registry and
 * erased-ink files are written here, since they have no in-memory owner.
 *
 * Ordering matters on failure: the files are written FIRST. If saving the
 * config then fails, the worst case is bindings and signatures one page out,
 * which the heading check on the page catches. If it were the other way round,
 * the registry could claim rows on a page that has moved -- which is how a set
 * of Apple Reminders pages was destroyed on 2026-08-24.
 */
export async function shiftRecordsForInsertedPage(
  config: Ink2TaskConfig,
  notePath: string,
  insertedAt: number,
): Promise<Ink2TaskConfig> {
  const abs = toAbsolute(notePath);
  try {
    const registry = await loadRegistry();
    const shifted = shiftPageKeys(registry, abs, insertedAt);
    await ensureDir();
    await RNFS.writeFile(REGISTRY_FILE, JSON.stringify(shifted, null, 2), 'utf8');

    const erased = await loadErasedInk();
    await RNFS.writeFile(
      ERASED_INK_FILE,
      JSON.stringify(shiftPageKeys(erased, abs, insertedAt)),
      'utf8',
    );
  } catch (e) {
    console.log('[Ink2Task] shifting page records failed', e);
    throw e; // the caller must not carry on as if the insert were clean
  }

  const templated = config.templatedPages?.[abs];
  return {
    ...config,
    pageBindings: shiftPageKeys(config.pageBindings ?? {}, abs, insertedAt),
    pageSignatures: shiftPageKeys(config.pageSignatures ?? {}, abs, insertedAt),
    ...(typeof templated === 'number'
      ? {
          templatedPages: {
            ...(config.templatedPages ?? {}),
            [abs]: shiftTemplatedCount(templated, insertedAt),
          },
        }
      : {}),
    lastViewedPage: shiftPageRef(config.lastViewedPage, abs, insertedAt) ?? undefined,
    lassoTargetOverride: shiftPageRef(config.lassoTargetOverride, abs, insertedAt),
  };
}

export function registryKey(notePath: string, page: number): string {
  return `${notePath}#${page}`;
}

/** The active connection profile (backend, host/port, token, list). */
export function activeProfileOf(config: Ink2TaskConfig): ConnectionProfile {
  return config.profiles[config.activeProfile] ?? config.profiles[0];
}

/** True when the active profile talks directly to Todoist's cloud (no server). */
export function isDirectTodoist(config: Ink2TaskConfig): boolean {
  const p = activeProfileOf(config);
  return p.backend === 'todoist' && !!p.token && p.token.trim().length > 0;
}

/**
 * A Todoist profile with no token at all.
 *
 * This is a dead end, not a configuration: isDirectTodoist goes false, so the
 * sync looks for a todoist-server instead, which almost nobody runs. With no
 * host set either, baseUrl builds "http://:8944/..." and the request dies on a
 * URL with no host in it -- and the generic failure path then advises starting
 * a server, which is the opposite of what this user needs to do (device-seen
 * 2026-08-24). Worth naming so the message can say "enter your token".
 */
export function isTodoistMissingToken(config: Ink2TaskConfig): boolean {
  const p = activeProfileOf(config);
  return p.backend === 'todoist' && !(p.token && p.token.trim().length > 0);
}

/** Sets the Todoist token on the active profile (for the token settings field). */
export function setActiveToken(config: Ink2TaskConfig, token: string): Ink2TaskConfig {
  const profiles = config.profiles.map((p, i) =>
    i === config.activeProfile ? {...p, token} : p,
  );
  return {...config, profiles};
}

/** The profile+list a given note page should sync: its bound one, else the active one. */
export function bindingForPage(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
): PageBinding {
  const saved = config.pageBindings?.[registryKey(notePath, page)];
  if (saved && config.profiles[saved.profileIndex]) return saved;
  return {profileIndex: config.activeProfile, listName: config.listName};
}

/**
 * Derives the config to actually sync a page WITH -- switches host/port/
 * activeProfile/listName to whatever that page is bound to (or the current
 * active profile, if it's never been synced before), without touching the
 * persisted "currently selected" profile. This is what makes each page
 * remember and use its own backend: syncing a Todoist page after a Reminders
 * page no longer sends the Reminders page's list name to Todoist (or vice
 * versa) just because that's whatever the Settings screen has selected.
 */
export function effectiveConfigForPage(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
): Ink2TaskConfig {
  const binding = bindingForPage(config, notePath, page);
  const profile = config.profiles[binding.profileIndex] ?? config.profiles[config.activeProfile];
  return {
    ...config,
    activeProfile: binding.profileIndex,
    host: profile.host,
    port: profile.port,
    listName: binding.listName,
  };
}

/** Returns a config with the given page bound to a profile+list (for persisting). */
export function bindPage(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
  profileIndex: number,
  listName: string,
): Ink2TaskConfig {
  return {
    ...config,
    pageBindings: {
      ...(config.pageBindings ?? {}),
      [registryKey(notePath, page)]: {profileIndex, listName},
    },
  };
}

/** Records the page just confirmed as viewed -- see `lastViewedPage`. */
export function withLastViewedPage(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
): Ink2TaskConfig {
  return {...config, lastViewedPage: {notePath, page}};
}

/** Pins (or, with `null`, un-pins) the lasso-capture target -- see `lassoTargetOverride`. */
export function withLassoTargetOverride(
  config: Ink2TaskConfig,
  target: PageRef | null,
): Ink2TaskConfig {
  return {...config, lassoTargetOverride: target};
}

/**
 * Where a task was captured from: the note page whose handwriting was lassoed
 * to create it. Keyed by the backend's reminder id, so the checklist can draw
 * a tappable link back to the original note even after the page is redrawn.
 */
export type TaskSource = {notePath: string; page: number};
export type TaskSources = {[reminderId: string]: TaskSource};

export async function loadTaskSources(): Promise<TaskSources> {
  try {
    if (!(await RNFS.exists(SOURCES_FILE))) return {};
    return JSON.parse(await RNFS.readFile(SOURCES_FILE, 'utf8'));
  } catch (e) {
    console.log('Ink2Task: task-sources load failed', e);
    return {};
  }
}

/** Records where a lasso-captured task came from. Best-effort: never throws. */
export async function saveTaskSource(reminderId: string, source: TaskSource): Promise<void> {
  try {
    const all = await loadTaskSources();
    all[reminderId] = source;
    await ensureDir();
    await RNFS.writeFile(SOURCES_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    // The task itself was created fine; losing the back-link isn't worth failing over.
    console.log('Ink2Task: task-source save failed', e);
  }
}

/**
 * Fingerprints of the handwriting each page's last sync erased, keyed by
 * `${notePath}#${page}`.
 *
 * Uninstalling the plugin makes the host revert its page edits, which brings
 * that erased ink BACK -- including old checkmarks. Those would then be read as
 * fresh check-offs and complete whatever tasks now occupy those rows. Keeping
 * the fingerprints lets the next sync recognise and ignore restored strokes.
 * Best-effort throughout: never throws, worst case the filter just doesn't fire.
 */
export type ErasedInk = {[notePathAndPage: string]: {x: number; y: number}[]};

export async function loadErasedInk(): Promise<ErasedInk> {
  try {
    if (!(await RNFS.exists(ERASED_INK_FILE))) return {};
    return JSON.parse(await RNFS.readFile(ERASED_INK_FILE, 'utf8'));
  } catch (e) {
    console.log('Ink2Task: erased-ink load failed', e);
    return {};
  }
}

export async function saveErasedInk(key: string, prints: {x: number; y: number}[]): Promise<void> {
  try {
    const all = await loadErasedInk();
    if (prints.length === 0) delete all[key];
    else all[key] = prints;
    await ensureDir();
    await RNFS.writeFile(ERASED_INK_FILE, JSON.stringify(all), 'utf8');
  } catch (e) {
    console.log('Ink2Task: erased-ink save failed', e);
  }
}

/**
 * Writes the whole source map back. Used by the back-link reconcile in
 * actions.ts, which has to remove the links from their notes BEFORE dropping
 * the records that say where those notes are. That reconcile deliberately does
 * NOT live here: it needs lassoCapture, which imports this module -- putting it
 * here would make the two files import each other.
 * Best-effort: never throws.
 */
export async function saveTaskSources(all: TaskSources): Promise<void> {
  try {
    await ensureDir();
    await RNFS.writeFile(SOURCES_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.log('Ink2Task: task-sources save failed', e);
  }
}

// -----------------------------------------------------------------------
// TickTick two-way sync bookkeeping. See src/utils/ticktickSync.ts for the
// decision logic that reads/writes these; this file only owns persistence,
// matching every other loadX/saveX pair above.
// -----------------------------------------------------------------------

/**
 * Per-task change-detection state, as of the last successful sync.
 *
 * `lastSyncedEtag` is what makes conflict detection possible at all: `etag`
 * changes on every mutation -- device-verified 2026-08-11 (an update visibly
 * changed a task's etag). Comparing the CURRENT remote etag against this
 * tells us "has this task changed on TickTick's side since we last looked,"
 * independent of what changed.
 *
 * Correction (2026-08-21): this comment used to justify the etag by claiming
 * TickTick tasks have no modified-time field. They do. A live probe of
 * GET /project/{id}/data returned `modifiedTime` on 7 of 7 tasks (it is
 * undocumented, not absent). The etag is still the right signal for the
 * question we actually ask here -- see the long note on TickTickTaskRaw.etag
 * in ticktick-server/src/ticktick.ts for why, and for what `modifiedTime`
 * would buy us if the conflict policy ever became last-write-wins instead
 * of remote-wins.
 *
 * `lastSyncedDue` is separate from the etag check: it's what lets the ONE
 * real local-edit path in this UI today (handwriting a new date into an
 * already-synced row's DUE box) tell "the user just wrote something new"
 * apart from "the box still shows what we drew last time." Etag comparison
 * alone can't do that -- it only speaks to the REMOTE side.
 */
export type TickTickSyncRecord = {
  reminderId: string;
  lastSyncedEtag?: string;
  /** Plugin date format ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"), or absent. */
  lastSyncedDue?: string;
};

export type TickTickSyncState = {[reminderId: string]: TickTickSyncRecord};

const TICKTICK_SYNC_STATE_DEFAULT: TickTickSyncState = {};

export async function loadTicktickSyncState(): Promise<TickTickSyncState> {
  try {
    if (!(await RNFS.exists(TICKTICK_SYNC_STATE_FILE))) return {...TICKTICK_SYNC_STATE_DEFAULT};
    return JSON.parse(await RNFS.readFile(TICKTICK_SYNC_STATE_FILE, 'utf8'));
  } catch (e) {
    console.log('Ink2Task: ticktick-sync-state load failed', e);
    return {...TICKTICK_SYNC_STATE_DEFAULT};
  }
}

export async function saveTicktickSyncState(state: TickTickSyncState): Promise<void> {
  try {
    await ensureDir();
    await RNFS.writeFile(TICKTICK_SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.log('Ink2Task: ticktick-sync-state save failed', e);
  }
}

/**
 * A mutation that couldn't reach ticktick-server (network error, not TickTick
 * rejecting the request -- see classifyTicktickError in ticktickSync.ts),
 * queued for the next sync to retry. See requirement: "handle offline use
 * gracefully" -- this is the durable half of that; ticktickSync.ts's
 * drainOutbox is the retry half.
 *
 * Deliberately covers only the actions this UI can actually trigger today
 * (complete/uncomplete via check-off, setDue via the handwritten DUE box,
 * delete for future use) plus a generic `update` for forward-compatibility
 * with a future title/notes/priority editing UI -- see the scoping note in
 * ticktickSync.ts for why those don't have a local trigger yet.
 *
 * No projectId: ticktick-server resolves by LIST NAME (config.listName), not
 * by id, so draining just needs whatever config is active at drain time --
 * same as every other call this plugin makes to a companion server.
 */
export type TickTickOutboxEntry = {
  /** Local id for de-duplication -- see enqueueTicktickOutbox. */
  id: string;
  kind: 'complete' | 'uncomplete' | 'setDue' | 'delete' | 'update';
  reminderId: string;
  payload?: {title?: string; notes?: string; due?: string | null; priority?: 1 | 2 | 3 | 4};
  queuedAt: number;
};

export type TickTickOutbox = TickTickOutboxEntry[];

export async function loadTicktickOutbox(): Promise<TickTickOutbox> {
  try {
    if (!(await RNFS.exists(TICKTICK_OUTBOX_FILE))) return [];
    return JSON.parse(await RNFS.readFile(TICKTICK_OUTBOX_FILE, 'utf8'));
  } catch (e) {
    console.log('Ink2Task: ticktick-outbox load failed', e);
    return [];
  }
}

export async function saveTicktickOutbox(outbox: TickTickOutbox): Promise<void> {
  try {
    await ensureDir();
    await RNFS.writeFile(TICKTICK_OUTBOX_FILE, JSON.stringify(outbox, null, 2), 'utf8');
  } catch (e) {
    console.log('Ink2Task: ticktick-outbox save failed', e);
  }
}

/**
 * "Last successful sync time and any useful error message" for the TickTick
 * Settings section -- the one persisted status surface none of the other
 * three backends have today (they only show a transient status line that
 * resets when you leave the screen). Written after every TickTick sync
 * attempt (success or not), read by Home.tsx to render it.
 */
export type TickTickSyncMeta = {
  /** Epoch ms of the last sync ATTEMPT that completed (didn't crash) --
   * updated even when lastError is set, since a sync that ran and reported
   * warnings still ran, and "when did this last try" is worth showing either way. */
  lastSyncAt?: number;
  /** Human-readable summary of the last sync's warnings, if any. Cleared
   * (undefined) on a sync that completed with nothing to report. */
  lastError?: string;
};

export async function loadTicktickSyncMeta(): Promise<TickTickSyncMeta> {
  try {
    if (!(await RNFS.exists(TICKTICK_META_FILE))) return {};
    return JSON.parse(await RNFS.readFile(TICKTICK_META_FILE, 'utf8'));
  } catch (e) {
    console.log('Ink2Task: ticktick-sync-meta load failed', e);
    return {};
  }
}

export async function saveTicktickSyncMeta(meta: TickTickSyncMeta): Promise<void> {
  try {
    await ensureDir();
    await RNFS.writeFile(TICKTICK_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    console.log('Ink2Task: ticktick-sync-meta save failed', e);
  }
}

/**
 * How many leading pages of `notePath` carry our baked-in template background.
 *
 * Defaults to 1 because ensureNote always creates page 0 from the template, so
 * a config written before this field existed still gets the right answer for
 * the only page it could have had.
 */
/**
 * Re-records a page binding from the list name drawn on the page itself.
 *
 * pageBindings is how every destructive step knows a page belongs to another
 * list, and it lives in the settings file. When that file was reset, pages
 * holding an Apple Reminders checklist looked unclaimed and a Todoist sync
 * cleared and removed them (2026-08-24). The heading on the page survives that,
 * so when it disagrees with the list being synced, put the binding back.
 *
 * Matches the profile by list name, case-insensitively, against the heading's
 * "<PLATFORM> - <LIST>" shape. If no profile matches, the config is returned
 * unchanged -- the caller still refuses to touch the page, which is the part
 * that matters; recording it is only so the rest of the plugin agrees.
 */
/**
 * Drops bindings and signatures for pages the note no longer has.
 *
 * A binding pointing past the end of the note is worse than useless: it makes
 * pageBudget stop short at a page that does not exist, so the list refuses to
 * use room it actually has. Seen on 2026-08-25, where a binding sat on page 2
 * of a two-page note (pages 0 and 1) after the page it described was gone.
 *
 * Only prunes ABOVE the real page count, never reinterprets what is left.
 */
/**
 * The remove-side counterpart of shiftRecordsForInsertedPage.
 *
 * Call immediately after a page is successfully removed. Removing page N slides
 * everything above it down one, so records still describing N+1 point at the
 * wrong page. Left unshifted, the next sync reads another list's page as
 * unclaimed and draws over it -- which is exactly how a page of Apple Reminders
 * was flattened on 2026-08-25, after a blank page below it was deleted.
 */
export async function shiftRecordsForRemovedPage(
  config: Ink2TaskConfig,
  notePath: string,
  removedAt: number,
): Promise<Ink2TaskConfig> {
  const abs = toAbsolute(notePath);
  try {
    const registry = await loadRegistry();
    await ensureDir();
    await RNFS.writeFile(
      REGISTRY_FILE,
      JSON.stringify(unshiftPageKeys(registry, abs, removedAt), null, 2),
      'utf8',
    );
    const erased = await loadErasedInk();
    await RNFS.writeFile(
      ERASED_INK_FILE,
      JSON.stringify(unshiftPageKeys(erased, abs, removedAt)),
      'utf8',
    );
  } catch (e) {
    console.log('[Ink2Task] shifting page records after a removal failed', e);
    throw e;
  }
  return {
    ...config,
    pageBindings: unshiftPageKeys(config.pageBindings ?? {}, abs, removedAt),
    pageSignatures: unshiftPageKeys(config.pageSignatures ?? {}, abs, removedAt),
    lastViewedPage: unshiftPageRef(config.lastViewedPage, abs, removedAt) ?? undefined,
    lassoTargetOverride: unshiftPageRef(config.lassoTargetOverride, abs, removedAt),
  };
}

export function pruneBindingsPastEnd(
  config: Ink2TaskConfig,
  notePath: string,
  pageCount: number,
): Ink2TaskConfig {
  if (pageCount <= 0) return config; // unknown count: never prune on a guess
  const abs = toAbsolute(notePath);
  const dropStale = <T>(store: {[k: string]: T} | undefined) => {
    const out: {[k: string]: T} = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(store ?? {})) {
      const hash = key.lastIndexOf('#');
      const page = hash > 0 ? Number(key.slice(hash + 1)) : NaN;
      if (key.slice(0, hash) === abs && Number.isInteger(page) && page >= pageCount) {
        dropped++;
        continue;
      }
      out[key] = value;
    }
    return {out, dropped};
  };
  const b = dropStale(config.pageBindings);
  const s = dropStale(config.pageSignatures);
  if (b.dropped === 0 && s.dropped === 0) return config;
  console.log(
    `[Ink2Task] pruned ${b.dropped} binding(s) and ${s.dropped} signature(s) past page ${pageCount - 1}`,
  );
  return {...config, pageBindings: b.out, pageSignatures: s.out};
}

export function bindPageToHeading(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
  heading: string,
): Ink2TaskConfig {
  const listPart = heading.includes(' - ') ? heading.split(' - ').slice(1).join(' - ') : '';
  if (!listPart) return config;
  const wanted = listPart.trim().toLowerCase();
  const idx = config.profiles.findIndex(p => (p.listName || '').trim().toLowerCase() === wanted);
  if (idx < 0) return config;
  const key = registryKey(notePath, page);
  if (config.pageBindings?.[key]) return config; // already claimed; leave it
  return {
    ...config,
    pageBindings: {
      ...(config.pageBindings ?? {}),
      [key]: {profileIndex: idx, listName: config.profiles[idx].listName},
    },
  };
}

export function templatedPageCount(config: Ink2TaskConfig, notePath: string): number {
  const n = config.templatedPages?.[toAbsolute(notePath)];
  return typeof n === 'number' && n > 0 ? n : 1;
}

/**
 * Returns a config recording that `notePath` now has `count` leading templated
 * pages.
 *
 * GROWS by default: silently lowering the count would mean forgetting that a
 * page we created has a baked background, and drawing its chrome a second time
 * on top of it. Pass `{shrink: true}` only after a page has actually been
 * REMOVED from the note, where lowering it is the correct bookkeeping.
 */
export function withTemplatedPages(
  config: Ink2TaskConfig,
  notePath: string,
  count: number,
  opts: {shrink?: boolean} = {},
): Ink2TaskConfig {
  const current = templatedPageCount(config, notePath);
  if (opts.shrink) {
    if (count >= current) return config;
    return {
      ...config,
      templatedPages: {
        ...(config.templatedPages ?? {}),
        [toAbsolute(notePath)]: Math.max(1, count),
      },
    };
  }
  if (count <= current) return config;
  return {
    ...config,
    templatedPages: {...(config.templatedPages ?? {}), [toAbsolute(notePath)]: count},
  };
}

/** True when a page can be trusted to already have the template drawn into it. */
export function isTemplatedPage(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
): boolean {
  return page < templatedPageCount(config, notePath);
}

/**
 * The FIRST page of the checklist run that `page` belongs to.
 *
 * Syncing while on a continuation page used to treat that page as the start of
 * the list. The list then got redrawn from there, its own continuations landed
 * further down the note, and the whole run walked toward the end of the note one
 * sync at a time -- which is what left a device with 8 pages of stale checklists
 * and a "PAGE 1 OF 3" sitting on page 4 (2026-08-22).
 *
 * A run starts at page 0, or at any page the user deliberately bound to its own
 * list (that binding is what makes a page a list in its own right rather than a
 * continuation of the one above). So: walk back to the nearest bound page, or 0.
 */
export function anchorPageFor(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
): number {
  const path = toAbsolute(notePath);
  for (let p = page; p > 0; p--) {
    if (config.pageBindings?.[registryKey(path, p)]) return p;
  }
  return 0;
}
