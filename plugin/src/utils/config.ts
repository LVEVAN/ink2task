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

const CONFIG_DIR = '/storage/emulated/0/MyStyle/Ink2Task';
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const REGISTRY_FILE = `${CONFIG_DIR}/checklist-registry.json`;
// Where a lasso-captured task came from, so the checklist can draw a link back.
// Deliberately its OWN file rather than a config field: the Home screen
// auto-saves its in-memory config on every change, so a background write into
// config.json would get clobbered by the next setConfig.
const SOURCES_FILE = `${CONFIG_DIR}/task-sources.json`;
// Fingerprints of ink each page's last sync erased -- used to ignore strokes the
// host restores when the plugin is reinstalled. See loadErasedInk.
const ERASED_INK_FILE = `${CONFIG_DIR}/erased-ink.json`;
// The plugin version the last sync ran under, so a sync can tell it's the first
// one after an install. See loadSyncedVersion.
const INSTALL_FILE = `${CONFIG_DIR}/install-state.json`;

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
  backend: 'apple' | 'google' | 'todoist';
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
   * Which profile+list each PAGE of the note syncs, keyed by
   * `${notePath}#${page}` -- so adding a page (via the device's own note
   * tools) and syncing it gives that page its own backend/list, independent
   * of the others (e.g. one page synced to Todoist, another to Reminders).
   * Falls back to the active profile/list for pages that were never bound.
   */
  pageBindings?: {[key: string]: PageBinding};
  /**
   * The page most recently synced (on-page button or the Settings screen).
   * Lasso capture (from ANY other note) defaults new tasks here instead of
   * always page 0, so it follows whichever list you're actively using.
   */
  lastSyncedPage?: PageRef;
  /**
   * Pins lasso captures to a specific page/list, overriding lastSyncedPage.
   * Set from Settings; absent/null means "off" (use lastSyncedPage).
   */
  lassoTargetOverride?: PageRef | null;
};

/** A specific page of the (one) Ink2Task note. */
export type PageRef = {notePath: string; page: number};

export type PageBinding = {profileIndex: number; listName: string};

const DEFAULT_CONFIG: Ink2TaskConfig = {
  host: '192.168.1.0',
  port: 8942,
  listName: 'Inbox',
  profiles: [
    {label: 'Apple Reminders', backend: 'apple', host: '192.168.1.0', port: 8942, listName: 'Inbox'},
    {label: 'Google Tasks', backend: 'google', host: '', port: 8943, listName: 'Inbox'},
    {label: 'Todoist', backend: 'todoist', host: '', port: 8944, listName: 'Inbox'},
  ],
  activeProfile: 0,
  notePath: '/Note/Ink2Task/Ink2Task.note',
  fontPath: '',
  listScale: 1,
};

async function ensureDir(): Promise<void> {
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
  try {
    await migrateLegacy();
    const exists = await RNFS.exists(CONFIG_FILE);
    if (!exists) {
      const seeded = {...DEFAULT_CONFIG};
      await saveConfig(seeded);
      return seeded;
    }
    const raw = await RNFS.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = normalizeProfiles({...DEFAULT_CONFIG, ...parsed});
    // Repoint an old note path (the SuperRemind note, the earlier Ink2Task
    // "Reminders.note", or a note a since-removed picker pointed elsewhere) at
    // the one true Ink2Task.note, so it gets created with the current template
    // instead of trying to reuse a note that may no longer be appropriate.
    if (
      /\/SuperRemind\//.test(merged.notePath) ||
      /Reminders\.note$/i.test(merged.notePath) ||
      merged.notePath !== DEFAULT_CONFIG.notePath
    ) {
      merged.notePath = DEFAULT_CONFIG.notePath;
    }
    return merged;
  } catch (e) {
    console.log('Ink2Task: config load failed, using defaults', e);
    return {...DEFAULT_CONFIG};
  }
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

export async function saveConfig(config: Ink2TaskConfig): Promise<void> {
  await ensureDir();
  await RNFS.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
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

/** Records the page a sync just completed on -- see `lastSyncedPage`. */
export function withLastSyncedPage(
  config: Ink2TaskConfig,
  notePath: string,
  page: number,
): Ink2TaskConfig {
  return {...config, lastSyncedPage: {notePath, page}};
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
 * The plugin version that last completed a sync, or '' if none has.
 *
 * Installing the plugin makes the host revert its page edits, bringing back ink
 * a previous sync erased -- including old checkmarks. The fingerprint filter
 * (loadErasedInk) catches that, but not on a page whose fingerprints predate
 * this mechanism or were never recorded. Comparing this against the running
 * version identifies the FIRST sync after an install, which treats whatever ink
 * is on the page as stale: erase it, don't act on it.
 *
 * Deliberately a version string rather than a "have we run before" flag -- that
 * would also trip on an ordinary device restart, silently discarding real
 * handwriting the user hadn't synced yet.
 */
export async function loadSyncedVersion(): Promise<string> {
  try {
    if (!(await RNFS.exists(INSTALL_FILE))) return '';
    return JSON.parse(await RNFS.readFile(INSTALL_FILE, 'utf8'))?.version || '';
  } catch {
    return '';
  }
}

export async function saveSyncedVersion(version: string): Promise<void> {
  try {
    await ensureDir();
    await RNFS.writeFile(INSTALL_FILE, JSON.stringify({version}), 'utf8');
  } catch (e) {
    console.log('Ink2Task: install-state save failed', e);
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
