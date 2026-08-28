/**
 * Draws the reminders checklist onto a Supernote page, and later reads the
 * page back to figure out which checkboxes got a pen mark.
 *
 * Layout: checkboxes + labels live on a dedicated custom layer (layer 1,
 * "Ink2Task") so redrawing the list never touches anything else you've
 * written on that page. The check marks themselves are ordinary handwriting
 * on the main layer (layer 0) -- that's where the pen lands by default --
 * so detection has to go looking for strokes there and test them against
 * the checkbox boxes we remembered in the registry.
 *
 * The layout is aligned to the "Ink2Task List" page template: constants are
 * fractions of the template's 1404x1872 design, resolved against the live
 * PluginFileAPI.getPageSize() so the checklist lands on the template's ruled
 * rows and columns even at other resolutions (the template image scales too).
 */
import {PluginFileAPI, PluginCommAPI, PluginManager, Element, Geometry, PointUtils} from 'sn-plugin-lib';
import type {RemoteReminder} from '../api/macServer';
import type {ChecklistEntry, TaskSource, TaskSources} from './config';
import {unwrap, recycleElements, withTimeout} from './sdk';
import {
  measureText,
  fitTitle,
  lineCount,
  subtaskMarker,
  subtaskDepths,
  subtaskSiblingIndex,
} from './taskText';
import {HEADER_Y_FRAC, rowHeightFrac, rowScale as rowScaleFor} from './rowDensity';

/**
 * Elements are native-backed objects, not plain data: createElement allocates
 * one on the Android side and hands back a uuid plus the ElementDataAccessor
 * handles the insert path expects. A hand-built object literal carries none of
 * that, and insertElements rejects it with a bare "Invalid API parameters"
 * (106) that names no field -- so always allocate through the SDK, then fill
 * in the geometry/textBox.
 */
async function newElement(
  type: number,
  page: number,
  layer: number,
): Promise<any> {
  const el = await unwrap<any>(
    PluginCommAPI.createElement(type),
    'createElement',
  );
  el.pageNum = page;
  el.layerNum = layer;
  return el;
}

/**
 * The old dedicated "Ink2Task" layer. Nothing is drawn there anymore (see
 * checklistLayer) -- kept only so the redraw can clear stale checklists left on
 * it by earlier builds.
 */
const LAYER_ID = 1;
/** Where handwriting goes, and where the checklist is drawn, on every note. */
const MAIN_LAYER = 0;

// Layout is expressed as fractions of the "Ink2Task List" template, which
// was designed at 1404x1872. Storing them as fractions (rather than absolute
// px) keeps the checklist aligned to the template's ruled rows and columns
// even if the page renders at a different resolution -- the template image
// scales to fill the page, and so do these.
const TPL_W = 1404;
const TPL_H = 1872;

// Content is inset from both side edges by SIDE_MARGIN so the Supernote's
// side toolbar (which can sit on the left or right) never covers it.
// The table band's top (205/1872) and the per-density row height both live in
// ./rowDensity (import-free so they're testable): HEADER_Y_FRAC and
// rowHeightFrac(rows). At the default 14 rows they reproduce the historical
// 205 / 112px layout exactly -- see rowDensity.test.ts.
export const N_ROWS = 14; // rows of the v1 ruled template, and the default
const DIVIDER_X = 1164 / TPL_W; // vertical divider between task and due columns

const BOX_LEFT = 100 / TPL_W;
const BOX_SIZE = 66 / TPL_W;
const BOX_TOP_IN_ROW = 23 / TPL_H; // box inset from the top of its row cell (14-row layout only)

// Typed titles start just right of the checkbox (which ends at 166) rather than
// well clear of it. The SDK's text renderer adds its own internal padding
// inside textRect -- device capture (2026-08-21, A5X) showed glyphs landing
// ~17px right of the rect's left edge -- so the rect at 172 puts the first
// glyph near 189, roughly level with where the blank rows' capture box begins
// (182). That keeps typed and handwritten rows visually aligned while closing
// the dead gap the old 196 left between box and text. Also buys ~24px of extra
// title width, so slightly fewer titles hit the two-line ellipsis.
const TASK_TEXT_LEFT = 172 / TPL_W;
const TASK_TEXT_RIGHT = 1140 / TPL_W; // stop before the divider (1164)
const DUE_TEXT_LEFT = 1184 / TPL_W; // start after the divider (1164)
const DUE_TEXT_RIGHT = 1304 / TPL_W; // right margin unchanged

// The handwriting CAPTURE boxes are deliberately wider than the text bounds
// above. Typed titles want breathing room from the checkbox and the divider,
// but a capture rect that's inset for looks throws away writing space: capture
// only reads strokes whose center falls inside the rect, so anything written
// past the edge is silently dropped. Device feedback (2026-08-21, Manta) was
// that dates in particular kept getting lost unless written small and centered.
// So these run to within a few px of the template's own lines: the checkbox
// (ends 166), the column divider (1164), and the right ruled margin (1320).
// Left edge keeps a slightly bigger gap than the others: it's the one that
// borders the checkbox, and a tick that overshoots its box shouldn't land a
// stroke center inside the task's capture zone.
const TASK_BOX_LEFT = 182 / TPL_W;
const TASK_BOX_RIGHT = 1156 / TPL_W;
const DUE_BOX_LEFT = 1172 / TPL_W;
const DUE_BOX_RIGHT = 1314 / TPL_W;
const FONT_SIZE = 40 / TPL_H; // base; scaled by the user's list-size setting

// Subtask markers are ">" per level (">", ">>", ...) drawn BOLD, from
// subtaskMarker() in ./taskText. This replaced a single thin "↳" which did
// render on an A5X but read as faint and could not show nesting depth (device
// feedback 2026-08-21). The same ">" is what capture parses back out of
// handwriting, so the drawn form and the written form match deliberately.

// The header label ("<platform> · <list>") drawn in the ruled-line margin
// (x85), the SYNC button's old spot before the two swapped (2026-08-13,
// device request): SYNC is now centered (x556..848, see template.svg), so
// the title moved here to make room. RIGHT runs almost up to the pill's
// left edge (556), just a 6px gap -- widened from an initial 530 after
// device feedback: "TODOIST - INBOX" was JUST missing the one-line-fit
// threshold at that width (445px; needed ~452px) and fell back to the
// stacked two-line layout unnecessarily. 465px clears it with margin.
const HEADER_LABEL_LEFT = 85 / TPL_W;
const HEADER_LABEL_RIGHT = 550 / TPL_W;
const HEADER_LABEL_TOP = 104 / TPL_H;
const HEADER_LABEL_BOTTOM = 188 / TPL_H;
const HEADER_FONT = 46 / TPL_H; // match the template's "DUE" header size
// The platform:list title gets its OWN size, separate from HEADER_FONT --
// bumping HEADER_FONT itself would also grow SYNC and DUE, which weren't asked
// for. drawHeading recenters on the shared heading line for any font size, so
// this doesn't need any other layout change.
const TITLE_FONT = 52 / TPL_H;
// Compact-header variant (style.compactHeader, v17+ template pages): the v17
// template's SYNC pill and DUE header are drawn ~2/3 the old size (device
// feedback 2026-08-26: "headers and the sync button are pretty gigantic"), so
// the drawn platform:list title shrinks in step or it towers over them. Legacy
// pages keep TITLE_FONT -- a small title next to their big baked DUE looks
// just as mismatched the other way.
const TITLE_FONT_COMPACT = 36 / TPL_H;
// Used only when the platform+list label doesn't fit HEADER_LABEL_LEFT..RIGHT
// on one line at TITLE_FONT (a long list name) -- then platform and list are
// stacked as two lines instead, sized to both fit within the HEADER_LABEL_TOP
// ..BOTTOM band (84px at the template's native scale) rather than running
// into the DUE column or the first task row.
const TITLE_FONT_2LINE = 30 / TPL_H;
const TITLE_FONT_2LINE_COMPACT = 24 / TPL_H;

// Template "chrome" positions (from icon-drafts/template.svg), drawn as elements
// on notes that lack the baked-in template background. Coordinates are fractions
// of the 1404x1872 design so they scale to any page.
// SYNC button pill: template rect x85..377, y100..184 (rx42 rounded -> drawn as a
// plain rectangle outline; the tap ZONE in index.js covers this same area). Device
// testing (0.2.58) showed the label renders TOP-aligned in its rect, so the text
// band's top is pushed DOWN to ~(pill_top + (pill_height - font)/2) to vertically
// center "SYNC" inside the box: box 100..184 (h84), font 54 -> top ~115.
const SYNC_PILL_LEFT = 85 / TPL_W;
const SYNC_PILL_RIGHT = 345 / TPL_W; // narrowed (was 377)
const SYNC_PILL_TOP = 100 / TPL_H;
const SYNC_PILL_BOTTOM = 184 / TPL_H;
const SYNC_FONT = 54 / TPL_H; // template "SYNC" label is 56px
// Shared vertical center for all three heading words (SYNC, "<platform>: <list>",
// DUE) so they sit on one line. The SYNC label renders higher than font metrics
// predict, so this is nudged below the pill's geometric center (142) to bring
// "SYNC" down into the middle of its box. Tunable.
const HEADING_CENTER = 134 / TPL_H;
// "DUE" header, centered over the due column (divider 1164 .. right margin 1320).
const DUE_HEADER_LEFT = 1164 / TPL_W;
const DUE_HEADER_RIGHT = 1320 / TPL_W;
// Vertical divider between the task and due columns (template y205..1773).
const DIVIDER_TOP = 205 / TPL_H;
const DIVIDER_BOTTOM = 1773 / TPL_H;
// Ruled row lines: template draws them x85..1320 at each row boundary
// (y = headerY + i*rowHeight, for i = 0..rows).
const RULE_LEFT = 85 / TPL_W;
const RULE_RIGHT = 1320 / TPL_W;
// The 15 ruled-line elements are ~24% of a redraw's ~62 elements -- the single
// biggest homogeneous chunk. Since replaceElements resends the WHOLE page every
// sync (nothing can be cached across syncs), this is real weight. Kept ON by
// default (drawn per an explicit request); flip to false to trade that visual
// for a lighter/faster redraw on notes that draw chrome, as a speed experiment.
const DRAW_RULED_LINES = true;
// Pen widths for the drawn chrome. The SDK rejects geometry penWidth < 100
// ("penWidth must be >= 100"), so 100 is the floor -- used for the ruled lines and
// divider. The SYNC pill outline is drawn heavier so the button reads as a bold,
// tappable control rather than a thin box.
const CHROME_WIDTH = 600;
const DIVIDER_WIDTH = 100;
// Element pen colors: 0x00 black, 0x9D dark gray, 0xC9 light gray. Light gray was
// too faint to see on e-ink, so use dark gray -- visible on every row, but softer
// than the black checkboxes/text so it still reads as a ruling.
const RULE_COLOR = 0x9d;

// "+N more" note in the bottom margin, shown when the list is longer than the
// page's N_ROWS. They surface as you complete tasks above (the list compacts).
// Shrunk slightly from the original 1790..1858/font 34 to make room for
// LAST_UPDATED below it -- the blank margin below the ruled table (1773..1872,
// 99px) has to fit both.
const FOOTER_LEFT = 100 / TPL_W;
const FOOTER_RIGHT = 1304 / TPL_W;
const FOOTER_TOP = 1778 / TPL_H;
const FOOTER_BOTTOM = 1808 / TPL_H;
const FOOTER_FONT = 26 / TPL_H;

// "UPDATED: <date/time>" -- small, BOLD, centered across the FULL page
// width (both columns), in the blank strip below the footer. Drawn fresh on
// every redraw, so it's simply "now" at the moment writeChecklist runs --
// ported from Ink2Day's dailyPage.ts, which draws the same thing the same way
// (native page element, not a Settings-screen overlay, so it survives closing
// Settings and shows up right on the note itself). Nudged up twice from the
// original 1834..1866 per device feedback (2026-08-11), to line up with the
// device's own "<note name> / page N" footer row -- the footer above it
// (shrunk slightly) moved up in step to keep clearance.
const LAST_UPDATED_TOP = 1812 / TPL_H;
const LAST_UPDATED_BOTTOM = 1844 / TPL_H;
const LAST_UPDATED_FONT = 22 / TPL_H;
/** Start of the stamp's text, used to find it again in refreshTimestampOnly. */
export const LAST_UPDATED_PREFIX = 'UPDATED: ';
/**
 * Width to reserve for the chain-link glyph the device draws inside a link's
 * rect, in ems of the link's own font. Measured off the device screenshot that
 * reported the overlap; slightly generous, because too much only shifts the
 * text a few pixels while too little puts the glyph back over the text.
 */
const LINK_ICON_EM = 1.5;

type PageSize = {width: number; height: number};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * "UPDATED: AUG 11, 2:45 PM" (or "AUG 11, 14:45" with use24h) for the
 * given moment, local wall-clock time.
 */
function formatLastUpdated(d: Date, use24h?: boolean): string {
  const month = MONTHS[d.getMonth()].toUpperCase();
  const day = d.getDate();
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  if (use24h) {
    return `UPDATED: ${month} ${day}, ${String(h).padStart(2, '0')}:${min}`;
  }
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `UPDATED: ${month} ${day}, ${h12}:${min} ${ampm}`;
}

/**
 * Splits a due value into a date line and an (optional) time line, so the
 * "DUE DATE" column can stack them -- date on top, time below -- rather than
 * run one long string past the divider.
 *   "2026-07-25"       -> {date: "Jul 25", time: ""}
 *   "2026-07-25T14:30" -> {date: "Jul 25", time: "2:30 PM"}
 * The year is added only when it isn't the current one. Parsed by parts (not
 * through Date) so a date-only value can't shift across a day due to timezone.
 */
function formatDueParts(due: string, use24h?: boolean): {date: string; time: string} {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(due);
  if (!m) return {date: due, time: ''};
  const year = Number(m[1]);
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  const day = Number(m[3]);
  let date = `${month} ${day}`;
  if (year !== new Date().getFullYear()) date += `, ${year}`;
  let time = '';
  if (m[4] != null && m[5] != null) {
    const h = Number(m[4]);
    const min = Number(m[5]);
    if (use24h) {
      time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    } else {
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const mm = min === 0 ? '' : `:${String(min).padStart(2, '0')}`;
      time = `${h12}${mm} ${ampm}`;
    }
  }
  return {date, time};
}

// Task titles are measured per glyph by ../utils/taskText (measureText /
// fitTitle / lineCount). The flat CHAR_W average that used to live here is
// gone: no single number worked, because it charged 'i' and 'm' the same, so
// titles full of narrow letters were ellipsized with a third of the row still
// empty (device report 2026-08-21). Its tuning history is in that module.
//
// The HEADING below still uses a flat average, deliberately: it is one short
// bold string with its own tuning history and a one-line-fits decision, and a
// regression there means a clipped heading. Left alone on purpose.
//
// The platform/list heading is drawn BOLD (drawHeading passes bold=1), unlike
// task titles -- bold glyphs run wider, so reusing CHAR_W there under-counted
// width and let borderline labels ("Google Tasks - To Do List") pass the
// one-line-fits check, overflow, and get clipped by the host's renderer
// instead of falling back to the two-line layout. Wider estimate = stricter
// (smaller) charsPerLine = triggers two-line mode sooner.
const HEADER_CHAR_W = 0.58;

/** Estimated characters per line, for the bold heading's one-line-fits check. */
function charsPerLine(widthPx: number, fontSizePx: number, charW: number = HEADER_CHAR_W): number {
  return Math.max(1, Math.floor(widthPx / (fontSizePx * charW)));
}

/**
 * The checklist always lives on the MAIN layer, for every note type.
 *
 * It used to get a dedicated "Ink2Task" layer on normal notes, on the theory
 * that redrawing could then wipe our layer without touching the user's writing.
 * That turned out to be exactly backwards: erasing the handwriting is the whole
 * point of the redraw, and the page ops appear to be LAYER-SCOPED -- so
 * replaceElements only ever cleared layer 1 and never the ink on layer 0. The
 * ink survived every "erase", invisible because the checklist covered it, and
 * reappeared the moment the plugin (and its layer) was removed.
 *
 * The proof was sitting in the one case that always worked: recognition notes
 * reject layer ops (804) so they already drew on the main layer -- and their
 * handwriting erased cleanly every time. Same layer for everything now.
 */
export async function checklistLayer(_notePath: string, _page: number): Promise<number> {
  return MAIN_LAYER;
}


/**
 * Clears any previous checklist drawing and lays out the given reminders
 * as checkbox + label pairs. Returns the registry entries the caller
 * should persist -- this is what Sync later reads to know which reminder
 * each checkbox belongs to.
 *
 * Only the first N_ROWS reminders are drawn (the template's row count); a
 * fuller multi-page layout is a "harder addition" left for later.
 */
export type ChecklistStyle = {
  /** Absolute font file path, or '' for the system default. */
  fontPath?: string;
  /** Multiplier on text/checkbox/row sizes. 1 = default. */
  scale?: number;
  /**
   * Task rows on this page (default N_ROWS = 14). Rows subdivide the fixed
   * table band, so more rows = shorter rows; text, checkboxes, and capture
   * boxes shrink by the same factor (rowScale in ./rowDensity). The caller
   * resolves this per run via rowsForRun -- a page whose baked background
   * carries the v1 ruling must stay at 14.
   */
  rows?: number;
  /**
   * Draw the interior row-separator lines as elements. For v17+ template
   * pages: their background bakes only the density-independent chrome (frame
   * lines, divider, SYNC pill, DUE header), so the per-density row lines must
   * be drawn here. Ignored when drawChrome is set -- that path already draws
   * the full ruling including top/bottom frame lines and the divider.
   */
  drawInteriorRules?: boolean;
  /**
   * Smaller drawn platform:list title, matching the v17 template's compact
   * SYNC/DUE header art. Off for legacy pages, whose baked header is the old
   * larger size.
   */
  compactHeader?: boolean;
  /** Shown in the header between the SYNC button and "DUE": which backend + list. */
  header?: {platform: string; list: string};
  /**
   * Draw the template "chrome" -- the SYNC button, the "DUE" header, and the
   * column divider -- as elements. Needed on notes that were NOT created from our
   * template (e.g. "Use current note" pages), which have no baked-in background.
   * Left off for our own template note so the drawn chrome can't double up on the
   * baked-in version.
   */
  drawChrome?: boolean;
  /**
   * Where lasso-captured tasks came from, keyed by reminder id. Tasks found
   * here get their title drawn as a link back to that note page.
   */
  sources?: TaskSources;
  /**
   * Follow the backend's own manual ordering (Google Tasks' `position`,
   * Todoist's `order`) instead of slot-stability. Only meaningful for
   * backends that actually have a reliable manual-order field -- Apple
   * Reminders has none, so it always stays slot-stable regardless of this.
   * See the `ordered` sort below.
   */
  honorBackendOrder?: boolean;
  /**
   * Exact text for the bottom-margin footer, from footerFor() in ./pagination.
   * Empty string draws nothing. Undefined means "work it out yourself", which
   * reproduces the pre-continuation behaviour of showing "+N MORE NOT SHOWN"
   * when the list is longer than one page: only the caller knows how many pages
   * this list spans, so only the caller can word it correctly.
   */
  footerText?: string;
  /**
   * 24-hour ("military") time instead of 12-hour AM/PM, for every time this
   * module draws on the page: due times in the DUE column and the LAST
   * UPDATED footer. Off (12-hour) by default, matching how the checklist
   * has always looked.
   */
  use24HourTime?: boolean;
  /**
   * Whether THIS note's background already has the checkbox outlines baked
   * in (see ensureNote.ts's noteHasBakedInCheckboxes) -- when true AND this
   * is the template page (drawChrome is false), drawCheckbox skips creating
   * the outline as an element, since the background already shows it. Real
   * per-sync saving found via adb logcat timing (2026-08-12): ~14 fewer
   * native element writes, each measured at roughly 50-100ms. Defaults to
   * false (draw them) when omitted -- the always-correct fallback for any
   * note whose background doesn't actually have them.
   */
  checkboxesBaked?: boolean;
  /**
   * Cap on how many blank writable rows to draw after the last task. Undefined
   * means "fill every remaining row", which is what a single page or the LAST
   * page of a list should do: the more blank rows, the more tasks the user can
   * add in one sync.
   *
   * The caller sets this to 1 for a page that continues onto the next one.
   * Those pages are normally full, but planPages keeps a parent and its
   * subtasks together, so moving a block of 4 out of 3 remaining rows leaves a
   * GAP -- and every slot in the gap used to become its own writable row. A
   * page reading "CONTINUED ON PAGE 2" with three empty write boxes above the
   * footer looks broken (device-reported 2026-08-23), and the extra rows buy
   * nothing, since the list continues elsewhere anyway.
   *
   * Slots past the cap get nothing drawn and no registry entry, so they are
   * plain empty rows. Note the row's checkbox outline may still be visible on
   * our own template, where the outlines are part of the baked background and
   * are not ours to hide -- see checkboxesBaked.
   */
  maxBlankRows?: number;
  /**
   * Makes the footer a tappable link to this page, instead of plain text.
   * Set by writePaginated on continuation pages only, pointing at the anchor,
   * so "TOP OF LIST" actually goes there -- flipping back by hand
   * was the only way before, and on a three-page list that is a real nuisance.
   *
   * Uses the same inline TYPE_LINK element as the task back-links (see mkLink),
   * NOT PluginNoteAPI.insertTextLink, so it survives the next redraw.
   */
  footerLinkTo?: {destPath: string; destPage: number};
};

// Rectangle outline pen width for checkboxes and blank writable boxes.
const RECT_WIDTH = 100;

export async function writeChecklist(
  notePath: string,
  page: number,
  reminders: RemoteReminder[],
  previous: ChecklistEntry[] = [],
  style: ChecklistStyle = {},
): Promise<ChecklistEntry[]> {
  _redrawWarning = ''; // fresh per redraw; read via takeRedrawWarning()
  const layer = await checklistLayer(notePath, page);
  const nRows = style.rows && style.rows > 0 ? Math.round(style.rows) : N_ROWS;
  // Everything drawn INSIDE a row shrinks with the rows themselves, and the
  // user's list-size % multiplies on top of that.
  const rScale = rowScaleFor(nRows);
  const scale = (style.scale && style.scale > 0 ? style.scale : 1) * rScale;
  const fontPath = style.fontPath || '';
  const use24h = !!style.use24HourTime;
  // Only skip drawing checkbox elements when BOTH this note's background
  // actually has them baked in AND we're drawing the TEMPLATE page itself
  // (drawChrome false) -- any other page (added by hand, no baked-in
  // background at all) still needs them drawn regardless of this flag.
  const skipCheckboxElement = !!style.checkboxesBaked && !style.drawChrome;

  // EVERY note type is now wiped-and-redrawn in ONE call by replaceElements at the
  // end (that also erases the user's handwriting), so no separate clear is needed
  // here -- for recognition notes either. Dropping the old per-note removeDrawn-
  // Elements pass also saves a pile of native round-trips on every sync.

  const size = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  // Resolve the template's fractional layout to whole pixels on this page.
  // insertElements rejects fractional coordinates ("must be an integer", 107),
  // so everything is rounded once here.
  const px = (f: number) => Math.round(size.width * f);
  const py = (f: number) => Math.round(size.height * f);

  const headerY = py(HEADER_Y_FRAC);
  const rowHeight = py(rowHeightFrac(nRows));
  const boxLeft = px(BOX_LEFT);
  const boxSize = Math.round(size.width * BOX_SIZE * rScale);
  // At 14 rows this must stay the historical fixed inset -- the v1 template's
  // BAKED checkbox outlines sit exactly there, and the computed box coords are
  // what capture tests checkmark strokes against. At other densities the boxes
  // are always drawn by us, so centering in the (shorter) row is correct.
  // (Centering at 14 rows gives the same 23px on the 1872 design, but rounds
  // differently at other page heights -- so the legacy branch is kept exact.)
  const boxTopInRow =
    nRows === N_ROWS ? py(BOX_TOP_IN_ROW) : Math.round((rowHeight - boxSize) / 2);
  const taskLeft = px(TASK_TEXT_LEFT);
  // Title text, the blank writable box, and the priority flag all share this
  // same right edge -- the flag is drawn overlapping the row's right end
  // rather than in a reserved cut-out, so it doesn't narrow/truncate rows
  // that don't have one (and rows that do just overlap it there).
  const taskRight = px(TASK_TEXT_RIGHT);
  const dueLeft = px(DUE_TEXT_LEFT);
  const dueRight = px(DUE_TEXT_RIGHT);
  const dividerX = px(DIVIDER_X);
  // Capture-box edges, wider than the text bounds above -- see TASK_BOX_LEFT.
  const taskBoxLeft = px(TASK_BOX_LEFT);
  const taskBoxRight = px(TASK_BOX_RIGHT);
  const dueBoxLeft = px(DUE_BOX_LEFT);
  const dueBoxRight = px(DUE_BOX_RIGHT);
  // Font scales with the user's list-size setting (and the row density, folded
  // into `scale` above), capped so it stays in the row. The cap's headroom
  // shrinks with the row too -- a fixed 24px would swallow most of a dense row.
  const fontSize = Math.min(
    Math.round(size.height * FONT_SIZE * scale),
    rowHeight - Math.max(8, Math.round(24 * rScale)),
  );

  const entries: ChecklistEntry[] = [];
  // Element creation (createElement) is a native round-trip EACH, and ~66 of them
  // done sequentially was the sync bottleneck (~17-20s). Collect the build
  // promises here and resolve them all in parallel at the end so the round-trips
  // pipeline instead of blocking one another.
  const elementPromises: Promise<any>[] = [];

  // Due date/time uses a smaller font so a stacked date + time fits the column.
  const dueFontSize = Math.max(18, Math.round(fontSize * 0.68));
  // Vertical inset of a capture box inside its ruled row. Kept small (a few px
  // at the template's scale) for the same reason the boxes are wide: strokes
  // whose center lands outside are dropped, and tall handwriting overshoots a
  // short box. Just enough to keep the outline off the ruled lines.
  const rectInset = Math.max(3, Math.round(rowHeight * 0.06));
  const rowTopOf = (slot: number) => headerY + slot * rowHeight;
  const slotOf = (boxTop: number) => Math.round((boxTop - boxTopInRow - headerY) / rowHeight);

  const mkText = async (
    text: string,
    left: number,
    right: number,
    top: number,
    bottom: number,
    fs: number = fontSize,
    align: number = 0, // 0=left, 1=center, 2=right
    bold: number = 0,
  ) => {
    const textEl = await newElement(Element.TYPE_TEXT, page, layer);
    textEl.textBox = {
      fontSize: fs,
      ...(fontPath ? {fontPath} : {}),
      // textContentFull rejects "" AND whitespace-only (code 107), which fails
      // the WHOLE replaceElements batch -- one blank title/label anywhere kills
      // the entire redraw, not just that element. Guarded HERE, once, for every
      // caller (title, due date, heading, flag digit, etc.) rather than at each
      // call site, since any of them could end up blank from real-world data
      // (an empty-titled reminder is the likely cause this time).
      textContentFull: text && text.trim() ? text : '—',
      textRect: {left, top, right, bottom},
      textAlign: align,
      textBold: bold,
      textItalics: 0,
      textFrameWidthType: 0,
    };
    return textEl;
  };

  /**
   * A tappable text link back to the note page a task was captured from
   * (lasso capture records this -- see TaskSources). Drawn as a normal element
   * so it goes into the same replaceElements batch and survives every redraw,
   * unlike PluginNoteAPI.insertTextLink which would be wiped by the next sync.
   * style 0 = solid underline, linkType 0 = jump to a note page.
   *
   * MUST be on the MAIN layer: a link on our dedicated Ink2Task layer is
   * rejected with code 203 ("This stroke type cannot be operated on a
   * non-main layer!"), which fails the whole redraw batch. Living on layer 0
   * is harmless here -- the scans that read that layer only look at strokes
   * (type 0) and text boxes (type 500), so a link is never mistaken for the
   * user's handwriting, and replaceElements still redraws it every sync.
   */
  const mkLink = async (
    text: string,
    left: number,
    right: number,
    top: number,
    bottom: number,
    destPath: string,
    destPage: number,
    fs: number = fontSize,
  ) => {
    const el = await newElement(Element.TYPE_LINK, page, MAIN_LAYER);
    el.link = {
      category: 0, // text link
      X: left,
      Y: top,
      width: right - left,
      height: bottom - top,
      page,
      style: 0, // solid underline -- reads as a hyperlink
      linkType: 0, // jump to note page
      destPath,
      destPage,
      fontSize: fs,
      fullText: text,
      showText: text,
      italic: 0,
      controlTrailNums: [],
    };
    return el;
  };

  // A rectangle outline as a closed 5-point GEO_polygon (checkbox + blank box).
  const mkRect = async (l: number, t: number, r: number, b: number, width: number = RECT_WIDTH) => {
    const el = await newElement(Element.TYPE_GEO, page, layer);
    el.geometry = {
      penColor: 0x00,
      penType: 10,
      penWidth: width,
      type: Geometry.TYPE_POLYGON,
      points: [
        {x: l, y: t},
        {x: r, y: t},
        {x: r, y: b},
        {x: l, y: b},
        {x: l, y: t},
      ],
    };
    return el;
  };

  // A straight line between two points (ruled rows + column divider).
  const mkLine = async (
    x1: number, y1: number, x2: number, y2: number,
    width: number, color: number = 0x00,
  ) => {
    const el = await newElement(Element.TYPE_GEO, page, layer);
    el.geometry = {
      penColor: color,
      penType: 10,
      penWidth: width,
      type: Geometry.TYPE_STRAIGHT_LINE,
      points: [
        {x: x1, y: y1},
        {x: x2, y: y2},
      ],
    };
    return el;
  };

  // Small pennant flag overlapping the row's right end, carrying the priority
  // number itself (1-4) -- not just a boolean marker, so every tier is
  // visible, not only the top one.
  const drawPriorityFlag = (rowTop: number, priority: number) => {
    const flagH = Math.round(rowHeight * 0.46);
    const top = rowTop + Math.round((rowHeight - flagH) / 2);
    const bottom = top + flagH;
    const flagW = Math.round(flagH * 0.62);
    const poleX = taskRight - flagW;
    // Pole.
    elementPromises.push(mkLine(poleX, top, poleX, bottom, 100, 0x00));
    // Pennant: a 3-point triangle off the top of the pole, closed back to its
    // start (GEO_polygon auto-closes, same technique as the checkbox rect).
    elementPromises.push(
      (async () => {
        const el = await newElement(Element.TYPE_GEO, page, MAIN_LAYER);
        el.geometry = {
          penColor: 0x00,
          penType: 10,
          penWidth: 100, // SDK floor
          type: Geometry.TYPE_POLYGON,
          points: [
            {x: poleX, y: top},
            {x: poleX + flagW, y: top + Math.round(flagH * 0.26)},
            {x: poleX, y: top + Math.round(flagH * 0.52)},
            {x: poleX, y: top},
          ],
        };
        return el;
      })(),
    );
    // The number, at the bottom of the flag (below the pennant, by the foot
    // of the pole) rather than centered on the pennant itself.
    const fs = Math.max(14, Math.round(flagH * 0.46));
    const numTop = bottom - fs;
    elementPromises.push(
      mkText(String(priority), poleX, poleX + flagW, numTop, numTop + Math.round(fs * 1.4), fs, 1),
    );
  };

  const drawCheckbox = async (rowTop: number) => {
    const bTop = rowTop + boxTopInRow;
    const box = {left: boxLeft, top: bTop, right: boxLeft + boxSize, bottom: bTop + boxSize};
    // The box's COORDINATES are always computed and returned regardless --
    // capture.ts needs them to know where to look for a checkmark stroke,
    // whether or not the outline itself is drawn as an element here.
    if (!skipCheckboxElement) {
      elementPromises.push(mkRect(box.left, box.top, box.right, box.bottom));
    }
    return box;
  };

  // Wrapped, ellipsized, vertically-centered title. Returns the strike span.
  // When `source` is given (the task was lasso-captured from another note), the
  // title is drawn as an underlined LINK that jumps back to that note page.
  const drawTitle = async (
    rowTop: number,
    title: string,
    source?: TaskSource,
    /** Sibling position among its parent's children; 0 for a top-level task. */
    markerCount = 0,
  ) => {
    // The marker is drawn INLINE, as part of the title string.
    //
    // It was a separate bold element (textBold is per-element, so that is the
    // only way to bold just the marker). On device that rendered as a tiny
    // clipped tick sitting above the title's baseline: the marker element was
    // top-aligned at rowTop while the title is vertically centred, and its rect
    // was measured too tight. Inline is what the original "↳" did, and that DID
    // render correctly, so correctness wins over bold here.
    //
    // Prefixing before fitTitle also means the marker counts against the
    // available width, so a long subtask ellipsizes instead of overflowing.
    const marker = subtaskMarker(markerCount);
    const bodyLeft = taskLeft;
    const titleText = marker ? `${marker} ${title}` : title;
    const taskW = taskRight - bodyLeft;
    const displayTitle = fitTitle(titleText, taskW, fontSize);
    const lineH = Math.round(fontSize * 1.3);
    const blockH = lineCount(displayTitle, taskW, fontSize) * lineH;
    const tTop = rowTop + Math.max(2, Math.round((rowHeight - blockH) / 2));
    // Text is top-aligned and the SDK clips at the rect bottom, so run the rect all
    // the way to the row's bottom -- maximum descender room for g/y/p/j on the last
    // line -- while the text stays put at tTop.
    const tBottom = rowTop + rowHeight - 2;
    elementPromises.push(
      source
        ? mkLink(displayTitle, bodyLeft, taskRight, tTop, tBottom, source.notePath, source.page)
        : mkText(displayTitle, bodyLeft, taskRight, tTop, tBottom),
    );
    const textInset = Math.round(fontSize * 0.35);
    const textStart = bodyLeft + textInset;
    const estWidth = Math.round(measureText(displayTitle, fontSize));
    const textEnd = textStart + Math.min(estWidth, taskRight - textStart - textInset);
    return {textStart, textEnd};
  };

  const drawDue = async (rowTop: number, due?: string | null) => {
    if (!due) return;
    const {date, time} = formatDueParts(due, use24h);
    const lineH = dueFontSize + Math.round(dueFontSize * 0.35);
    const groupH = time ? lineH * 2 : lineH;
    const gTop = rowTop + Math.round((rowHeight - groupH) / 2);
    // Descender room below each line (top-aligned text clips at the rect bottom),
    // capped inside the row so it can't spill past the ruling.
    const descPad = Math.round(dueFontSize * 0.3);
    const maxB = rowTop + rowHeight - 2;
    elementPromises.push(
      mkText(date, dueLeft, dueRight, gTop, Math.min(gTop + lineH + descPad, maxB), dueFontSize, 1),
    );
    if (time) {
      elementPromises.push(
        mkText(time, dueLeft, dueRight, gTop + lineH, Math.min(gTop + lineH * 2 + descPad, maxB), dueFontSize, 1),
      );
    }
  };

  // A writable box in the DUE column, for rows with no due date yet -- so it's
  // obvious where to handwrite one. Capture scans this rect, parses a date, and
  // sets it on the task. Sits between the divider and the right margin.
  const drawDueBox = async (rowTop: number) => {
    const rect = {
      left: dueBoxLeft,
      top: rowTop + rectInset,
      right: dueBoxRight,
      bottom: rowTop + rowHeight - rectInset,
    };
    elementPromises.push(mkRect(rect.left, rect.top, rect.right, rect.bottom));
    return rect;
  };

  // Since the whole page is redrawn clean each time (the caller wipes the main
  // layer first), all tasks are just typed rows packed from the top -- no gaps.
  // Order: existing tasks keep their relative order (by the slot they held last
  // time), and newly-created ones (handwritten/typed captures) go to the end.
  // So completing a task shifts the rest UP, and new tasks land at the bottom.
  // Template "chrome" -- SYNC button, "DUE" header, column divider -- drawn as
  // elements for notes that have no baked-in template background (e.g. "Use
  // current note" pages). Skipped on our own template note, where these are
  // already part of the page image, so they never double up.
  // All three heading words -- SYNC, "<platform>: <list>", DUE -- share ONE
  // vertical center (the SYNC box's midline) so they sit on the same line no
  // matter their font size, and SYNC lands centered inside its box.
  const headingMid = py(HEADING_CENTER);
  // Only ever called for the platform:list title (its one call site, below) --
  // left-aligned (align=0) so it starts flush at the left ruled-line margin
  // (device request, 2026-08-14) rather than floating centered within its
  // now-wide box, which read as oddly indented once that box was widened.
  const drawHeading = async (text: string, leftF: number, rightF: number, fontFrac: number) => {
    const fs = Math.round(size.height * fontFrac);
    const top = headingMid - Math.round(fs / 2);
    // Text is top-aligned and clips at the rect bottom, so add descender room.
    const bottom = top + fs + Math.round(fs * 0.4);
    elementPromises.push(mkText(text, px(leftF), px(rightF), top, bottom, fs, 0, 1));
  };

  if (style.drawChrome) {
    // Ruled row lines (toggle above -- ~24% of a redraw's element count) +
    // column divider (light gray, like the template).
    if (DRAW_RULED_LINES) {
      for (let i = 0; i <= nRows; i++) {
        const y = headerY + i * rowHeight;
        elementPromises.push(mkLine(px(RULE_LEFT), y, px(RULE_RIGHT), y, DIVIDER_WIDTH, RULE_COLOR));
      }
    }
    elementPromises.push(
      mkLine(dividerX, py(DIVIDER_TOP), dividerX, py(DIVIDER_BOTTOM), DIVIDER_WIDTH, RULE_COLOR),
    );
  } else if (style.drawInteriorRules && DRAW_RULED_LINES) {
    // v17+ template page: the background bakes the table frame (top/bottom
    // lines) and the divider, but the row separators depend on the density,
    // so they are drawn here. Interior lines only -- i=0 and i=nRows would
    // double up on the baked frame.
    for (let i = 1; i < nRows; i++) {
      const y = headerY + i * rowHeight;
      elementPromises.push(mkLine(px(RULE_LEFT), y, px(RULE_RIGHT), y, DIVIDER_WIDTH, RULE_COLOR));
    }
  }
  // SYNC button box/label and the "DUE" column header are baked into the
  // template PNG itself (see ensureNote.ts) -- NEVER draw them as elements,
  // even on non-template pages, or they double up on top of the image. The
  // on-page SYNC tap zone in index.js is defined by its own coordinates, not
  // by this drawing, so removing the drawn box doesn't affect tapping it.

  // Platform + list label ("TODOIST - INBOX"), drawn on EVERY note (redrawn
  // each sync so it always reflects the current profile/list). A dash
  // separator rather than a bare join -- the earlier plain-space join made a
  // multi-word list name (e.g. "To Do") read as part of the platform name.
  const header = style.header;
  const titleFont = style.compactHeader ? TITLE_FONT_COMPACT : TITLE_FONT;
  if (header && header.platform) {
    const labelW = px(HEADER_LABEL_RIGHT) - px(HEADER_LABEL_LEFT);
    const oneLine = header.list ? `${header.platform} - ${header.list}` : header.platform;
    const oneLineFs = Math.round(size.height * titleFont);
    const fitsOneLine = charsPerLine(labelW, oneLineFs, HEADER_CHAR_W) >= oneLine.length;
    if (!header.list || fitsOneLine) {
      await drawHeading(oneLine.toUpperCase(), HEADER_LABEL_LEFT, HEADER_LABEL_RIGHT, titleFont);
    } else {
      // A long list name doesn't fit alongside the platform on one line --
      // stack them instead of letting it run into the DUE column or clip.
      // Sized to fit both lines within HEADER_LABEL_TOP..BOTTOM.
      const fs2 = Math.round(
        size.height * (style.compactHeader ? TITLE_FONT_2LINE_COMPACT : TITLE_FONT_2LINE),
      );
      const lineH2 = Math.round(fs2 * 1.3);
      const line1Top = py(HEADER_LABEL_TOP);
      const line2Top = line1Top + lineH2;
      elementPromises.push(
        mkText(
          header.platform.toUpperCase(), px(HEADER_LABEL_LEFT), px(HEADER_LABEL_RIGHT),
          line1Top, line1Top + lineH2, fs2, 0, 1,
        ),
      );
      elementPromises.push(
        mkText(
          header.list.toUpperCase(), px(HEADER_LABEL_LEFT), px(HEADER_LABEL_RIGHT),
          line2Top, line2Top + lineH2, fs2, 0, 1,
        ),
      );
    }
  }

  // A task's priority never reorders the list either way -- priority-sort-to-top
  // was tried (0.2.85) and rejected; `priority` drives ONLY the flag below.
  //
  // Two ordering modes:
  //  - honorBackendOrder (Google Tasks, Todoist -- both have a reliable manual
  //    order field): `reminders` arrives already sorted by that field (see
  //    fetchReminders/todoistReminders), so just use it as-is. Reordering a
  //    task in the app moves it here too, on the next sync.
  //  - slot-stability (Apple Reminders, which has no such field): a task keeps
  //    the row it held last sync; new ones append at the end. Otherwise a
  //    completed task's row disappearing would shuffle everything below it
  //    for no reason a user caused.
  const ordered = style.honorBackendOrder
    ? reminders
    : (() => {
        const prevSlot = new Map<string, number>();
        for (const e of previous) {
          if (e.reminderId) prevSlot.set(e.reminderId, slotOf(e.box.top));
        }
        const END = Number.MAX_SAFE_INTEGER;
        return [...reminders].sort(
          (a, b) => (prevSlot.get(a.id) ?? END) - (prevSlot.get(b.id) ?? END),
        );
      })();

  // Nesting depth per task, derived from the parentId chain across the WHOLE
  // list rather than just the drawn rows -- a parent can sit off-page (beyond
  // N_ROWS) and its children still need to render as children.
  const depths = subtaskDepths(reminders);
  // The marker counts SIBLING POSITION, not depth: three subtasks of one parent
  // read ">", ">>", ">>>". Depth is still what groups a parent with its children
  // for page packing, so both are needed.
  const siblingIndex = subtaskSiblingIndex(reminders);

  let slot = 0;
  for (const reminder of ordered) {
    if (slot >= nRows) break;
    const rowTop = rowTopOf(slot);
    const box = await drawCheckbox(rowTop);
    if (reminder.priority) drawPriorityFlag(rowTop, reminder.priority);
    const depth = depths.get(reminder.id) ?? 0;
    const {textStart, textEnd} = await drawTitle(
      rowTop,
      reminder.title,
      style.sources?.[reminder.id],
      siblingIndex.get(reminder.id) ?? 0,
    );
    const entry: ChecklistEntry = {
      kind: 'synced', reminderId: reminder.id, title: reminder.title, box, textStart, textEnd,
      // Persisted so handwriting capture can resolve "> foo" to a parent: it
      // needs the depth of the rows ABOVE the one being captured, and the only
      // record of the drawn page is this registry.
      ...(depth > 0 ? {depth} : {}),
    };
    // Show the date if it has one; otherwise give it a box to write one into.
    if (reminder.due) await drawDue(rowTop, reminder.due);
    else entry.dueRect = await drawDueBox(rowTop);
    entries.push(entry);
    slot++;
  }

  // Remaining slots become blank writable rows so every empty row is ready --
  // a task box on the left and a DUE box on the right. Continuation pages get
  // these too: harvestPages captures from every drawn page, so a task written
  // on page 2 or 3 is read back like any other.
  //
  // style.maxBlankRows caps how many, for a page whose list continues on the
  // next one; see the comment on that field.
  const blankLimit = style.maxBlankRows === undefined
    ? nRows
    : Math.max(0, Math.min(nRows, style.maxBlankRows));
  const lastBlankSlot = Math.min(nRows, slot + blankLimit);
  for (; slot < lastBlankSlot; slot++) {
    const rowTop = rowTopOf(slot);
    const box = await drawCheckbox(rowTop);
    const rect = {
      left: taskBoxLeft,
      top: rowTop + rectInset,
      right: taskBoxRight,
      bottom: rowTop + rowHeight - rectInset,
    };
    elementPromises.push(mkRect(rect.left, rect.top, rect.right, rect.bottom));
    const dueRect = await drawDueBox(rowTop);
    entries.push({kind: 'blank', title: '', box, rect, dueRect});
  }

  // Footer line. The caller decides the wording, because only it knows whether
  // this page is one of several (see planPages / footerFor in ./pagination):
  // a middle page points at the next one, the last page reports what still did
  // not fit, and a lone page keeps the original "+N MORE NOT SHOWN" behaviour.
  // Falls back to computing the single-page case itself so a caller that passes
  // no footer (or an older call site) still behaves as it always did.
  const hiddenCount = ordered.length - nRows;
  const footerText =
    style.footerText !== undefined
      ? style.footerText
      : hiddenCount > 0
        ? `+ ${hiddenCount} MORE NOT SHOWN`
        : '';
  if (footerText) {
    const footerFont = Math.round(size.height * FOOTER_FONT);
    if (style.footerLinkTo) {
      // A link element has no text alignment of its own -- it draws from the
      // left of its rect and underlines the whole width. Handing it the full
      // footer span would put the text hard left under a page-wide underline,
      // so measure the string and centre a rect that hugs it. measureText is
      // the same per-glyph estimator the task rows use.
      //
      // LINK_ICON_EM is why this is not just the text width: the device draws
      // its own chain-link glyph at the RIGHT EDGE of the link's rect, inside
      // it. A rect measured to fit the text exactly leaves the glyph nowhere to
      // go, so it lands on top of the final characters -- device-reported
      // 2026-08-24, where "PAGE 3 OF 3" had its 3 covered. Reserving the space
      // and centring text-plus-glyph keeps the line balanced.
      const w = Math.round(measureText(footerText, footerFont) + footerFont * LINK_ICON_EM);
      const mid = Math.round(size.width / 2);
      const half = Math.round(Math.min(w, px(FOOTER_RIGHT) - px(FOOTER_LEFT)) / 2);
      elementPromises.push(
        mkLink(
          footerText,
          Math.max(px(FOOTER_LEFT), mid - half),
          Math.min(px(FOOTER_RIGHT), mid + half),
          py(FOOTER_TOP),
          py(FOOTER_BOTTOM),
          style.footerLinkTo.destPath,
          style.footerLinkTo.destPage,
          footerFont,
        ),
      );
    } else {
      elementPromises.push(
        mkText(
          footerText,
          px(FOOTER_LEFT),
          px(FOOTER_RIGHT),
          py(FOOTER_TOP),
          py(FOOTER_BOTTOM),
          footerFont,
          1, // center
        ),
      );
    }
  }

  // "UPDATED: <date/time>" -- bottom center of the FULL page (both
  // columns), small and out of the way. Drawn every redraw, so it's simply
  // whatever "now" is at the moment this sync writes the page.
  elementPromises.push(
    mkText(
      formatLastUpdated(new Date(), use24h),
      0,
      size.width,
      py(LAST_UPDATED_TOP),
      py(LAST_UPDATED_BOTTOM),
      Math.round(size.height * LAST_UPDATED_FONT),
      1, // center
      1, // bold
    ),
  );

  // Resolve every createElement round-trip AT ONCE (they were queued above but
  // not awaited), so ~66 native calls pipeline instead of running serially.
  const elements = await Promise.all(elementPromises);

  // ⚠ DELETE the legacy "Ink2Task" layer (1), don't just clear it -- this is
  // what finally makes the erase work on notes from older builds.
  //
  // Those builds drew the checklist on layer 1, and the layer sticks around
  // (and stays the note's ACTIVE layer) even now that we draw on layer 0. The
  // page ops appear to act on that active layer, which explains every symptom
  // at once: getElements reported 0 strokes (true -- of layer 1), so the erase
  // check never warned; replaceElements redrew the checklist happily; the
  // handwriting on layer 0 was never seen or touched; and deleting the plugin
  // took the covering layer with it, "revealing" ink that had been there all
  // along. clearLayerElements empties that layer but leaves it in place and
  // still active, so it didn't help.
  //
  // Best-effort: absent on notes made since 0.2.80, and recognition notes
  // reject layer ops outright (804).
  try {
    await unwrap(
      PluginFileAPI.deleteLayers(notePath, page, [LAYER_ID]),
      'deleteLayers',
    );
  } catch {
    // no such layer (the normal case now), or a note type that rejects layer ops
  }

  if (elements.length > 0) {
    // replaceElements swaps the page's elements in ONE op: it wipes the user's
    // handwriting (which clearLayerElements/deleteElements could not) along with
    // the old checklist, then draws the fresh one. This only erases the ink
    // because our elements are on the MAIN layer -- see checklistLayer.
    try {
      await unwrap(
        PluginFileAPI.replaceElements(notePath, page, elements),
        'replaceElements',
      );
    } catch (e: any) {
      // IMPORTANT: this fallback draws the checklist but CANNOT erase the user's
      // handwriting. Silently swallowing it is why "the ink is still there after
      // deleting the plugin" was so hard to pin down -- the page looked right
      // because the checklist covered the ink. Record it so the sync reports it.
      _redrawWarning = `Handwriting not erased -- replaceElements failed: ${e?.message || 'unknown error'}`;
      await unwrap(PluginFileAPI.insertElements(notePath, page, elements), 'insertElements');
    }

    // Remember what we drew so verifyEraseAndRetry() can re-apply it later
    // WITHOUT rebuilding every element (~66 native round-trips). The PREVIOUS
    // generation is dead once this one replaces it -- release it here, or every
    // sync strands another ~66 native handles for the life of the process.
    // (Can't recycle THIS generation yet: verifyEraseAndRetry may still re-send
    // it after the save/reload.)
    const stale = _lastDrawn?.elements;
    _lastDrawn = {notePath, page, elements};
    if (stale && stale !== elements) recycleElements(stale);
  }

  return entries;
}

/**
 * Set when the last writeChecklist could not erase the user's handwriting --
 * either replaceElements outright failed (we fell back to a draw-only path) or
 * strokes survived it. Surfaced in the sync summary, because this failure is
 * otherwise invisible: the fresh checklist covers the leftover ink, so the page
 * looks correct until the plugin is removed and the ink reappears.
 * Read + cleared by takeRedrawWarning().
 */
let _redrawWarning = '';

/** Returns the pending redraw warning (if any) and clears it. */
export function takeRedrawWarning(): string {
  const w = _redrawWarning;
  _redrawWarning = '';
  return w;
}

/**
 * The elements the last writeChecklist drew, so the erase check below can
 * re-apply them without rebuilding all ~66 of them from scratch.
 */
let _lastDrawn: {notePath: string; page: number; elements: any[]} | null = null;

/**
 * How many handwriting strokes are on the page right now.
 *
 * Meant to be called AFTER the save/reload round-trip, not just after
 * replaceElements. The in-page check inside writeChecklist reads the state the
 * redraw just produced, so it always saw 0 -- but saveCurrentNote afterwards
 * writes the editor's in-memory buffer, which may still hold the ink and put it
 * straight back. Checking here is the only way to see the ink the user sees.
 */
export async function countInk(notePath: string, page: number): Promise<number> {
  try {
    const els = await unwrap<any[]>(PluginFileAPI.getElements(page, notePath), 'getElements');
    const n = (els || []).filter((el: any) => el.type === 0).length;
    // Nothing here outlives the count, so every handle can go back immediately.
    recycleElements(els);
    return n;
  } catch {
    return 0; // can't tell -- don't cry wolf
  }
}

/**
 * Confirms the redraw actually erased the user's handwriting, and re-applies
 * the checklist once if it didn't.
 *
 * Call this AFTER the save/reload, never before. An identical check used to sit
 * inside writeChecklist, immediately after replaceElements -- but at that point
 * the editor still holds the just-written strokes in its unsaved buffer, so the
 * check saw ink that the save/reload was about to discard anyway and fired a
 * second full-page replaceElements essentially every time handwriting was
 * captured. That retry was a third e-ink repaint on every capture sync, doing
 * no real work. Checking here instead means the retry only costs a paint when
 * ink genuinely survived, which is rare.
 *
 * Returns the leftover stroke count (0 = clean) and whether a retry was made,
 * so the caller can repaint only in that rare case.
 */
/**
 * Rewrites ONLY the "UPDATED: ..." stamp on a page, leaving its drawing alone.
 *
 * This is what makes skipping a redraw possible. The stamp changes every sync,
 * so without a way to touch just that line, no page could ever be considered
 * unchanged and every page would keep being erased and repainted -- four full
 * e-ink refreshes on a three-page list.
 *
 * Uses PluginFileAPI.modifyElements, device-proven 2026-08-24: the element
 * count was unchanged, the target changed, and every other element survived.
 *
 * MUTATES THE HANDLE THE DEVICE GAVE US rather than building a fresh element.
 * These objects are references into a native-side cache keyed by uuid, and the
 * docs are explicit that a write naming an element that is not cached is
 * skipped SILENTLY -- a hand-built object has no uuid and would vanish with no
 * error, looking exactly like "modifyElements does not work".
 *
 * Returns false if the stamp could not be found or the write failed, so the
 * caller can fall back to a full redraw rather than quietly leaving a stale
 * time on the page.
 */
export async function refreshTimestampOnly(
  notePath: string,
  page: number,
  use24h: boolean,
): Promise<boolean> {
  let elements: any[] = [];
  try {
    elements = (await unwrap<any[]>(PluginFileAPI.getElements(page, notePath), 'getElements')) || [];
    const stamp = elements.find(
      (el: any) =>
        typeof el?.textBox?.textContentFull === 'string' &&
        el.textBox.textContentFull.startsWith(LAST_UPDATED_PREFIX),
    );
    if (!stamp) return false;
    stamp.textBox.textContentFull = formatLastUpdated(new Date(), use24h);
    const res: any = await PluginFileAPI.modifyElements(notePath, page, [stamp]);
    if (!res?.success) {
      console.log(`[Ink2Task] timestamp refresh failed on p${page}: ${res?.error?.message || 'unknown'}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.log(`[Ink2Task] timestamp refresh threw on p${page}: ${e?.message || e}`);
    return false;
  } finally {
    // Only after the write: recycling first would invalidate the very handle
    // modifyElements needs, and that failure is silent.
    try {
      recycleElements(elements);
    } catch {
      // best effort
    }
  }
}

/**
 * Reads the "<PLATFORM> - <LIST>" heading already drawn on a page.
 *
 * Exists because of a real data loss on 2026-08-24. config.pageBindings records
 * which backend and list each page belongs to, and every destructive step
 * checks it -- but it lives in the settings file, and when that file was reset,
 * pages holding an Apple Reminders checklist looked unclaimed. The next Todoist
 * sync treated them as its own spare continuation pages, cleared them, and
 * removed them. The lists were gone.
 *
 * The page itself carries the answer: we draw the list's name across the top of
 * every page we own. That heading survives a settings reset, because it lives
 * in the note. Reading it back is the one check that cannot be undone by losing
 * a config file.
 *
 * Returns '' when the page has no heading (an older page, or one drawn before
 * headings existed) -- callers must treat that as "unknown", not "mine".
 */
export async function readPageHeading(notePath: string, page: number): Promise<string> {
  let elements: any[] = [];
  try {
    elements = (await unwrap<any[]>(PluginFileAPI.getElements(page, notePath), 'getElements')) || [];
    // The heading is the topmost text on the page, above the first row.
    const firstRowTop = 0.14; // fraction of page height; HEADER_LABEL_BOTTOM is above this
    const size: any = await unwrap(PluginFileAPI.getPageSize(notePath, page), 'getPageSize');
    const cutoff = Math.round((size?.height ?? 0) * firstRowTop);
    const texts = elements
      .filter(
        (el: any) =>
          typeof el?.textBox?.textContentFull === 'string' &&
          typeof el?.textBox?.textRect?.top === 'number' &&
          el.textBox.textRect.top < cutoff,
      )
      .sort((a: any, b: any) => a.textBox.textRect.top - b.textBox.textRect.top);
    // "DUE" is drawn up there too on notes that carry our chrome; it is not the
    // list name, so skip it.
    const heading = texts
      .map((el: any) => String(el.textBox.textContentFull).trim())
      .find((s: string) => s && s.toUpperCase() !== 'DUE');
    return heading || '';
  } catch (e: any) {
    console.log(`[Ink2Task] readPageHeading p${page} failed:`, e?.message || e);
    return '';
  } finally {
    try {
      recycleElements(elements);
    } catch {
      // best effort
    }
  }
}

export async function verifyEraseAndRetry(
  notePath: string,
  page: number,
): Promise<{leftover: number; retried: boolean}> {
  const ink = await countInk(notePath, page);
  if (ink === 0) return {leftover: 0, retried: false};
  const drawn = _lastDrawn;
  if (!drawn || drawn.notePath !== notePath || drawn.page !== page) {
    return {leftover: ink, retried: false};
  }
  // replaceElements is proven able to erase ink (it's what wipes the page in
  // the first place), so one more attempt is worth it before reporting failure.
  try {
    await unwrap(PluginFileAPI.replaceElements(notePath, page, drawn.elements), 'replaceElements');
  } catch {
    return {leftover: ink, retried: false};
  }
  return {leftover: await countInk(notePath, page), retried: true};
}


type BoundingBox = {left: number; top: number; right: number; bottom: number};

/**
 * Bounding box of a stroke, in screen coordinates.
 *
 * Stroke sample points come back in EMR (digitizer) space -- a rotated, ~8.5x
 * scaled system -- while the checkboxes were placed in screen space. They can
 * never overlap until the strokes are converted, which is what emrPoint2Android
 * does (it also undoes the 90-degree axis swap between the two systems).
 */
/**
 * EMR (digitizer) point -> screen point.
 *
 * Each Supernote device family has a different digitizer orientation and
 * scaling relationship. Determined empirically from on-device diagnostic
 * data (stroke center vs. checkbox bounding box).
 *
 *   A5X  (dev 3): 90-degree rotation, isotropic scale using maxX.
 *   Nomad (dev 4): no rotation, separate scales (maxX for x, maxY for y).
 *   Manta (dev 5): 90-degree rotation, separate scales (maxY for x, maxX for y).
 */
export function emrToScreen(
  p: {x: number; y: number},
  pageSize: PageSize,
  deviceType: number,
): {x: number; y: number} {
  const w = pageSize.width - 1;
  const h = pageSize.height - 1;
  const maxX = PointUtils.getRealMaxX(pageSize);
  const maxY = PointUtils.getRealMaxY(pageSize);

  if (deviceType === 4 || deviceType === 5) {
    // Nomad + Manta: 90-degree rotation, separate scales
    return {x: w - p.y * w / maxY, y: p.x * h / maxX};
  }
  // A5X (default): 90-degree rotation, isotropic scale
  const scale = maxX / w;
  return {x: w - p.y / scale, y: p.x / scale};
}

async function strokeBoundingBox(
  element: any,
  pageSize: PageSize,
  deviceType: number,
): Promise<BoundingBox | null> {
  const points = element?.stroke?.points;
  if (!points) return null;
  const size: number = await points.size();
  if (!size) return null;
  const pts = await points.getRange(0, size);
  if (!pts || pts.length === 0) return null;

  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of pts) {
    const s = emrToScreen(p, pageSize, deviceType);
    if (s.x < left) left = s.x;
    if (s.x > right) right = s.x;
    if (s.y < top) top = s.y;
    if (s.y > bottom) bottom = s.y;
  }
  return {left, top, right, bottom};
}

// A checkmark drawn "in" a box rarely stays perfectly inside it -- pen strokes
// overshoot. Pad the checkbox by ~60% of its own size and require the stroke's
// center point to land inside that padded region, rather than full containment.
function centerInPaddedBox(cx: number, cy: number, b: BoundingBox): boolean {
  const padX = (b.right - b.left) * 0.6;
  const padY = (b.bottom - b.top) * 0.6;
  return (
    cx >= b.left - padX &&
    cx <= b.right + padX &&
    cy >= b.top - padY &&
    cy <= b.bottom + padY
  );
}

function boxesOverlapEnough(a: BoundingBox, b: BoundingBox): boolean {
  return centerInPaddedBox((a.left + a.right) / 2, (a.top + a.bottom) / 2, b);
}

export type DetectedCheck = {
  entry: ChecklistEntry;
  /** The synced reminder this row maps to (detection only yields synced rows). */
  reminderId: string;
  /** numInPage values of the stroke elements that mark this box, for cleanup. */
  strokeNums: number[];
};

/**
 * Reads back the strokes drawn on the page since the checklist was written,
 * and matches them against the registry entries by position.
 */
export async function detectCheckedBoxes(
  notePath: string,
  page: number,
  entries: ChecklistEntry[],
  scan?: MainLayerScan,
): Promise<DetectedCheck[]> {
  // Reuse the Sync's shared page scan when given (its centers are already
  // computed); otherwise read the page ourselves for standalone callers.
  const s = scan ?? (await scanMainLayer(notePath, page));

  const results: DetectedCheck[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'synced') continue; // blank rows map to no reminder
    if (entry.completed) continue; // already done and struck through
    const strokeNums: number[] = [];
    for (const c of s.centers) {
      if (centerInPaddedBox(c.cx, c.cy, entry.box)) {
        strokeNums.push(c.stroke.numInPage);
      }
    }
    if (strokeNums.length > 0) {
      results.push({entry, reminderId: entry.reminderId!, strokeNums});
    }
  }
  return results;
}

/** numInPage of the strike line(s) crossing this entry's row (2-point geometry). */
function strikeNumsFor(elements: any[], layer: number, entry: ChecklistEntry): number[] {
  const BAND = 25;
  const nums: number[] = [];
  for (const el of elements || []) {
    if (el.layerNum !== layer || el.type !== 700) continue;
    if ((el.geometry?.points?.length ?? 0) !== 2) continue;
    const cy = elementCenterY(el);
    if (cy != null && cy >= entry.box.top - BAND && cy <= entry.box.bottom + BAND) {
      nums.push(el.numInPage);
    }
  }
  return nums;
}

/**
 * Finds completed tasks the user wants un-checked. A finished task carries both
 * a checkmark and a strike line; removing *either* one (erase it, or the system
 * undo) signals "undo this". Returns each such entry with the leftover elements
 * -- remaining checkmark strokes and strike line -- so the row can be reset to
 * a clean unchecked state once the Mac reverses the completion.
 */
export async function detectUncompleted(
  notePath: string,
  page: number,
  entries: ChecklistEntry[],
): Promise<DetectedCheck[]> {
  const completedEntries = entries.filter(e => e.completed);
  if (completedEntries.length === 0) return [];

  const pageSize = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const layer = await checklistLayer(notePath, page);
  const strokes = (elements || []).filter(
    (el: any) => el.type === 0 && el.layerNum === 0,
  );
  let deviceType = 3;
  try { deviceType = await PluginManager.getDeviceType(); } catch {}
  const bboxes = await Promise.all(
    strokes.map(s => strokeBoundingBox(s, pageSize, deviceType)),
  );

  const results: DetectedCheck[] = [];
  for (const entry of completedEntries) {
    const checkNums: number[] = [];
    for (let i = 0; i < strokes.length; i++) {
      const bbox = bboxes[i];
      if (bbox && boxesOverlapEnough(bbox, entry.box)) {
        checkNums.push(strokes[i].numInPage);
      }
    }
    const strikes = strikeNumsFor(elements, layer, entry);

    // Both still there = still done. Otherwise the user removed one → un-check,
    // and clear whatever is left so the row goes back to plain unchecked.
    if (checkNums.length > 0 && strikes.length > 0) continue;
    results.push({entry, reminderId: entry.reminderId!, strokeNums: [...checkNums, ...strikes]});
  }
  return results;
}

/** Clears leftover checkmark + strike after a task is un-completed. Box + label stay. */
export async function uncompleteItem(
  notePath: string,
  page: number,
  detected: DetectedCheck,
): Promise<void> {
  if (detected.strokeNums.length === 0) return;
  await unwrap(
    PluginFileAPI.deleteElements(notePath, page, detected.strokeNums),
    'deleteElements',
  );
}

export type StrokeCenter = {stroke: any; cx: number; cy: number};
type Rect = {left: number; top: number; right: number; bottom: number};

/**
 * Reads every main-layer handwriting stroke once and precomputes each one's
 * screen-space center. Testing many rectangles (e.g. scanning all writable
 * rows) then costs a single page read + conversion instead of one per rectangle
 * -- the difference between ~14 full-page scans per Sync and one.
 */
export async function collectStrokeCenters(
  notePath: string,
  page: number,
): Promise<StrokeCenter[]> {
  const size = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const strokes = (elements || []).filter(
    (el: any) => el.type === 0 && el.layerNum === 0,
  );
  let deviceType = 3;
  try { deviceType = await PluginManager.getDeviceType(); } catch {}
  const bboxes = await Promise.all(
    strokes.map(s => strokeBoundingBox(s, size, deviceType)),
  );
  const out: StrokeCenter[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const bbox = bboxes[i];
    if (!bbox) continue;
    out.push({stroke: strokes[i], cx: (bbox.left + bbox.right) / 2, cy: (bbox.top + bbox.bottom) / 2});
  }
  return out;
}

/** In-memory: strokes from a precomputed set whose center lands in a screen rect. */
export function strokesInRect(centers: StrokeCenter[], rect: Rect): any[] {
  return centers
    .filter(c => c.cx >= rect.left && c.cx <= rect.right && c.cy >= rect.top && c.cy <= rect.bottom)
    .map(c => c.stroke);
}

export type TextElement = {el: any; text: string; cx: number; cy: number};

/**
 * Native text-box elements (Supernote's [T] tool) on the main layer, with their
 * text and center. Lets capture read typed boxes directly -- no OCR -- and, being
 * ordinary text elements, they delete cleanly afterward (unlike raw strokes).
 * The plugin's own labels live on the Ink2Task layer, so filtering layer 0
 * returns only what the user typed.
 */
export async function collectTextElements(
  notePath: string,
  page: number,
): Promise<TextElement[]> {
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const out: TextElement[] = [];
  for (const el of elements || []) {
    if (el.type !== Element.TYPE_TEXT || el.layerNum !== MAIN_LAYER) continue;
    const r = el.textBox?.textRect;
    const text = (el.textBox?.textContentFull ?? '').trim();
    if (!r || !text) continue;
    out.push({el, text, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2});
  }
  return out;
}

/** In-memory: text elements whose center lands in a screen rect. */
export function textElementsInRect(texts: TextElement[], rect: Rect): TextElement[] {
  return texts.filter(
    t => t.cx >= rect.left && t.cx <= rect.right && t.cy >= rect.top && t.cy <= rect.bottom,
  );
}

/**
 * Everything a Sync's read pass needs from the page, gathered in ONE getElements
 * and ONE stroke-geometry pass: the page size, every main-layer stroke's screen
 * center, its raw strokes (for numInPage), and native text boxes.
 */
export type MainLayerScan = {
  pageSize: PageSize;
  centers: StrokeCenter[];
  strokes: any[];
  texts: TextElement[];
};

/** A stroke's rounded screen center -- the fingerprint used to spot ghosts. */
export type InkPrint = {x: number; y: number};

/** Fingerprints for every stroke in a scan, to remember what a sync erased. */
export function inkPrintsOf(scan: MainLayerScan): InkPrint[] {
  return scan.centers.map(c => ({x: Math.round(c.cx), y: Math.round(c.cy)}));
}

/**
 * Drops "ghost" strokes -- ink that a previous sync already erased, which the
 * host restored when the plugin was uninstalled/reinstalled (it reverts plugin
 * edits to the page).
 *
 * This matters because a restored CHECKMARK is indistinguishable from a fresh
 * one to the completion detector, and the list has repacked since it was drawn
 * -- so those stale marks would silently complete whatever tasks now sit in
 * those rows. Restored strokes are the very same stroke data, so their centers
 * match to the pixel; a newly hand-drawn mark realistically never lands within
 * TOLERANCE of an old one, even re-checking the same box.
 */
const GHOST_TOLERANCE = 2;

export function dropGhostStrokes(scan: MainLayerScan, ghosts: InkPrint[]): MainLayerScan {
  if (ghosts.length === 0 || scan.centers.length === 0) return scan;
  const isGhost = (cx: number, cy: number) =>
    ghosts.some(
      g => Math.abs(g.x - cx) <= GHOST_TOLERANCE && Math.abs(g.y - cy) <= GHOST_TOLERANCE,
    );
  const centers = scan.centers.filter(c => !isGhost(c.cx, c.cy));
  if (centers.length === scan.centers.length) return scan; // nothing restored
  const kept = new Set(centers.map(c => c.stroke));
  return {...scan, centers, strokes: scan.strokes.filter(s => kept.has(s))};
}

/**
 * Reads the page a SINGLE time and precomputes both stroke centers and native
 * text boxes for the main layer. Sharing one scan across all the row scans that
 * a Sync does (blank-row capture, due-date capture, checkmark detection) turns
 * what was ~5 full-page getElements -- each re-running two native round-trips per
 * stroke to bound it -- into one read and one geometry pass. This is the main
 * sync-speed lever, so callers should build it once and thread it through.
 */
export async function scanMainLayer(notePath: string, page: number): Promise<MainLayerScan> {
  const pageSize = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  let deviceType = 3; // default A5X
  try { deviceType = await PluginManager.getDeviceType(); } catch {}
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const strokes: any[] = [];
  const texts: TextElement[] = [];
  const dropped: any[] = [];
  for (const el of elements || []) {
    if (el.layerNum !== MAIN_LAYER) {
      dropped.push(el);
      continue;
    }
    if (el.type === 0) {
      strokes.push(el);
    } else if (el.type === Element.TYPE_TEXT) {
      const r = el.textBox?.textRect;
      const text = (el.textBox?.textContentFull ?? '').trim();
      if (r && text) {
        texts.push({el, text, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2});
      } else {
        dropped.push(el);
      }
    } else {
      dropped.push(el);
    }
  }
  recycleElements(dropped);
  const bboxes = await Promise.all(
    strokes.map(el => strokeBoundingBox(el, pageSize, deviceType)),
  );
  const centers: StrokeCenter[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const bbox = bboxes[i];
    if (bbox) {
      centers.push({stroke: strokes[i], cx: (bbox.left + bbox.right) / 2, cy: (bbox.top + bbox.bottom) / 2});
    }
  }
  return {pageSize, centers, strokes, texts};
}

/**
 * Releases the element handles a scan held on to (strokes + text boxes).
 *
 * Call ONCE at the very end of a sync, after capture/OCR and completion
 * detection have finished with them -- those read stroke points off these
 * handles, so recycling earlier would pull the data out from under them.
 * A ghost-filtered scan (dropGhostStrokes) shares the same element objects as
 * the raw scan, so recycling the raw one covers both.
 */
export function recycleScan(scan: MainLayerScan | null | undefined): void {
  if (!scan) return;
  recycleElements(scan.strokes);
  recycleElements(scan.texts.map(t => t.el));
}

/**
 * Convenience for single-rectangle callers (e.g. the button-zone eraser): reads
 * the page and returns strokes inside the rect. For multiple rectangles, prefer
 * collectStrokeCenters + strokesInRect to avoid re-reading the page each time.
 */
export async function strokesInScreenRect(
  notePath: string,
  page: number,
  rect: Rect,
): Promise<any[]> {
  return strokesInRect(await collectStrokeCenters(notePath, page), rect);
}

/**
 * Erases handwriting strokes whose center falls in a screen-pixel rectangle.
 * Used by 'convert' capture mode to remove the ink after it's been redrawn as
 * typed text. Re-erasing an already-empty box is a harmless no-op.
 */
export async function eraseStrokesInRect(
  notePath: string,
  page: number,
  rect: {left: number; top: number; right: number; bottom: number},
): Promise<void> {
  const strokes = await strokesInScreenRect(notePath, page, rect);
  const nums = strokes.map((s: any) => s.numInPage);
  if (nums.length > 0) {
    await unwrap(
      PluginFileAPI.deleteElements(notePath, page, nums),
      'deleteElements',
    );
  }
}

/**
 * Erases handwriting strokes whose center falls in a screen-space zone, given
 * as fractions of the page. Used to wipe the ink dot a pen tap leaves on the
 * on-page SYNC button (that corner is the button, not a place to write).
 */
export async function eraseStrokesInZone(
  notePath: string,
  page: number,
  zoneFrac: {left: number; top: number; right: number; bottom: number},
): Promise<void> {
  const size = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  const zone = {
    left: zoneFrac.left * size.width,
    top: zoneFrac.top * size.height,
    right: zoneFrac.right * size.width,
    bottom: zoneFrac.bottom * size.height,
  };
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const strokes = (elements || []).filter(
    (el: any) => el.type === 0 && el.layerNum === 0,
  );
  let deviceType = 3;
  try { deviceType = await PluginManager.getDeviceType(); } catch {}
  const bboxes = await Promise.all(
    strokes.map(s => strokeBoundingBox(s, size, deviceType)),
  );
  const nums: number[] = [];
  for (let i = 0; i < strokes.length; i++) {
    const bbox = bboxes[i];
    if (!bbox) continue;
    const cx = (bbox.left + bbox.right) / 2;
    const cy = (bbox.top + bbox.bottom) / 2;
    if (cx >= zone.left && cx <= zone.right && cy >= zone.top && cy <= zone.bottom) {
      nums.push(strokes[i].numInPage);
    }
  }
  if (nums.length > 0) {
    await unwrap(
      PluginFileAPI.deleteElements(notePath, page, nums),
      'deleteElements',
    );
  }
}

/** Vertical center of an element we drew (checkbox polygon, label, or strike). */
function elementCenterY(el: any): number | null {
  if (el.type === 700 && el.geometry?.points?.length) {
    const ys = el.geometry.points.map((p: any) => p.y);
    return (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  if (el.type === 500 && el.textBox?.textRect) {
    const r = el.textBox.textRect;
    return (r.top + r.bottom) / 2;
  }
  return null;
}

/**
 * Finds every element this plugin drew for the given entries -- checkbox,
 * label, and (if present) the strike line -- by row position.
 *
 * Matching is by the element's vertical center falling within the entry's row
 * band, not by title text: the label now carries a due-date suffix, and the
 * strike line has no text at all, so position is the one stable key. Handwriting
 * is type 0 (stroke) and never type 500/700, so this stays safe on the shared
 * main layer of a recognized note.
 */
function drawnElementNums(
  elements: any[],
  layer: number,
  entries: ChecklistEntry[],
): number[] {
  const BAND = 25; // < half the ~58px gap between rows, so bands never overlap
  const nums: number[] = [];
  for (const el of elements || []) {
    if (el.layerNum !== layer) continue;
    if (el.type !== 500 && el.type !== 700) continue;
    const cy = elementCenterY(el);
    if (cy == null) continue;
    for (const entry of entries) {
      if (cy >= entry.box.top - BAND && cy <= entry.box.bottom + BAND) {
        nums.push(el.numInPage);
        break;
      }
    }
  }
  return nums;
}

/** Erases a previous checklist without disturbing anything else on the layer. */
async function removeDrawnElements(
  notePath: string,
  page: number,
  layer: number,
  entries: ChecklistEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const nums = drawnElementNums(elements, layer, entries);
  if (nums.length > 0) {
    await unwrap(
      PluginFileAPI.deleteElements(notePath, page, nums),
      'deleteElements',
    );
  }
}

/** Removes a completed item's checkbox, label, and check-mark strokes. */
export async function removeChecklistItem(
  notePath: string,
  page: number,
  detected: DetectedCheck,
): Promise<void> {
  const layer = await checklistLayer(notePath, page);
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const toDelete = [
    ...detected.strokeNums,
    ...drawnElementNums(elements, layer, [detected.entry]),
  ];

  if (toDelete.length > 0) {
    await unwrap(
      PluginFileAPI.deleteElements(notePath, page, toDelete),
      'deleteElements',
    );
  }
}

/**
 * Keep-completed mode: draw a line through the task's text. The checkbox,
 * label, and the user's hand-drawn check all stay -- the strike just marks it
 * done -- until "Clear completed" removes them. Caller marks the entry
 * completed.
 */
export async function strikeThroughItem(
  notePath: string,
  page: number,
  detected: DetectedCheck,
): Promise<void> {
  const layer = await checklistLayer(notePath, page);
  const box = detected.entry.box;
  const yc = Math.round((box.top + box.bottom) / 2);

  // Span the label text: from where the text starts to where it ends. Older
  // registry entries predate those fields, so fall back to the checkbox row.
  const startX = detected.entry.textStart ?? box.left;
  const endX =
    detected.entry.textEnd ??
    box.left + Math.round((box.bottom - box.top) * 8);

  const strike = await newElement(Element.TYPE_GEO, page, layer);
  strike.geometry = {
    penColor: 0x00,
    penType: 10,
    penWidth: 400, // thicker than the 100 used for the checkbox outline
    type: Geometry.TYPE_POLYGON,
    points: [
      {x: startX, y: yc},
      {x: endX, y: yc},
    ],
  };
  await unwrap(
    PluginFileAPI.insertElements(notePath, page, [strike]),
    'insertElements',
  );
}

/**
 * Removes every element (checkbox, label, strike) for the given completed
 * entries. Used by the "Clear completed" button; the caller drops the same
 * entries from the registry.
 */
export async function clearCompletedItems(
  notePath: string,
  page: number,
  entries: ChecklistEntry[],
): Promise<void> {
  const done = entries.filter(e => e.completed);
  if (done.length === 0) return;
  const layer = await checklistLayer(notePath, page);
  const pageSize = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const strokes = (elements || []).filter(
    (el: any) => el.type === 0 && el.layerNum === 0,
  );

  // The checkbox/label/strike we drew (type 500/700)...
  const nums = new Set<number>(drawnElementNums(elements, layer, done));

  // ...plus the user's own ink (type 0): the checkmark inside the box, and, for
  // a captured row, the handwriting in the task area. removeDrawnElements alone
  // leaves these behind as orphan strokes.
  let deviceType = 3;
  try { deviceType = await PluginManager.getDeviceType(); } catch {}
  const bboxes = await Promise.all(
    strokes.map(s => strokeBoundingBox(s, pageSize, deviceType)),
  );
  for (const entry of done) {
    for (let i = 0; i < strokes.length; i++) {
      const bbox = bboxes[i];
      if (!bbox) continue;
      if (boxesOverlapEnough(bbox, entry.box)) {
        nums.add(strokes[i].numInPage);
        continue;
      }
      if (entry.rect) {
        const cx = (bbox.left + bbox.right) / 2;
        const cy = (bbox.top + bbox.bottom) / 2;
        const r = entry.rect;
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          nums.add(strokes[i].numInPage);
        }
      }
    }
  }

  if (nums.size > 0) {
    await unwrap(
      PluginFileAPI.deleteElements(notePath, page, [...nums]),
      'deleteElements',
    );
  }
}
