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
import {PluginFileAPI, PluginCommAPI, Element, Geometry, PointUtils} from 'sn-plugin-lib';
import type {RemoteReminder} from '../api/macServer';
import type {ChecklistEntry, TaskSource, TaskSources} from './config';
import {unwrap} from './sdk';

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
const HEADER_Y = 205 / TPL_H; // top of the first row / header line
const ROW_H = 112 / TPL_H; // ruled row height
const N_ROWS = 14; // rows the template provides (all non-task rows are writable)
const DIVIDER_X = 1164 / TPL_W; // vertical divider between task and due columns

const BOX_LEFT = 100 / TPL_W;
const BOX_SIZE = 66 / TPL_W;
const BOX_TOP_IN_ROW = 23 / TPL_H; // box inset from the top of its row cell

const TASK_TEXT_LEFT = 196 / TPL_W;
const TASK_TEXT_RIGHT = 1140 / TPL_W; // stop before the divider (1164)
const DUE_TEXT_LEFT = 1184 / TPL_W; // start after the divider (1164)
const DUE_TEXT_RIGHT = 1304 / TPL_W; // right margin unchanged
const FONT_SIZE = 40 / TPL_H; // base; scaled by the user's list-size setting

// The header label ("<platform> · <list>") drawn in the empty band between the
// SYNC button (ends ~x418) and the "DUE" word (starts ~x1164), so you can see
// at a glance which backend + list this page syncs.
const HEADER_LABEL_LEFT = 370 / TPL_W;
const HEADER_LABEL_RIGHT = 990 / TPL_W;
const HEADER_LABEL_TOP = 104 / TPL_H;
const HEADER_LABEL_BOTTOM = 188 / TPL_H;
const HEADER_FONT = 46 / TPL_H; // match the template's "DUE" header size
// The platform:list title gets its OWN size, separate from HEADER_FONT --
// bumping HEADER_FONT itself would also grow SYNC and DUE, which weren't asked
// for. drawHeading recenters on the shared heading line for any font size, so
// this doesn't need any other layout change.
const TITLE_FONT = 52 / TPL_H;
// Used only when the platform+list label doesn't fit HEADER_LABEL_LEFT..RIGHT
// on one line at TITLE_FONT (a long list name) -- then platform and list are
// stacked as two lines instead, sized to both fit within the HEADER_LABEL_TOP
// ..BOTTOM band (84px at the template's native scale) rather than running
// into the DUE column or the first task row.
const TITLE_FONT_2LINE = 30 / TPL_H;

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
// (y = HEADER_Y + i*ROW_H, for i = 0..N_ROWS).
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
const FOOTER_LEFT = 100 / TPL_W;
const FOOTER_RIGHT = 1304 / TPL_W;
const FOOTER_TOP = 1790 / TPL_H;
const FOOTER_BOTTOM = 1858 / TPL_H;
const FOOTER_FONT = 34 / TPL_H;

type PageSize = {width: number; height: number};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Splits a due value into a date line and an (optional) time line, so the
 * "DUE DATE" column can stack them -- date on top, time below -- rather than
 * run one long string past the divider.
 *   "2026-07-25"       -> {date: "Jul 25", time: ""}
 *   "2026-07-25T14:30" -> {date: "Jul 25", time: "2:30 PM"}
 * The year is added only when it isn't the current one. Parsed by parts (not
 * through Date) so a date-only value can't shift across a day due to timezone.
 */
function formatDueParts(due: string): {date: string; time: string} {
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
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mm = min === 0 ? '' : `:${String(min).padStart(2, '0')}`;
    time = `${h12}${mm} ${ampm}`;
  }
  return {date, time};
}

// Average glyph width as a fraction of font size, used to estimate how much
// text fits per line. Tuned against real titles on an A5X: 0.6 was too wide
// (truncated titles that visibly still had room), 0.5 was STILL too wide
// (titles cut ~5 characters early), 0.47 nudged very slightly too far the
// other way. The renderer does the actual word-wrapping; this only decides
// when a title is long enough to need an ellipsis.
const CHAR_W = 0.485;
// The platform/list heading is drawn BOLD (drawHeading passes bold=1), unlike
// task titles -- bold glyphs run wider, so reusing CHAR_W there under-counted
// width and let borderline labels ("Google Tasks - To Do List") pass the
// one-line-fits check, overflow, and get clipped by the host's renderer
// instead of falling back to the two-line layout. Wider estimate = stricter
// (smaller) charsPerLine = triggers two-line mode sooner.
const HEADER_CHAR_W = 0.58;

/** Estimated characters per line for a given width and font size. */
function charsPerLine(widthPx: number, fontSizePx: number, charW: number = CHAR_W): number {
  return Math.max(1, Math.floor(widthPx / (fontSizePx * charW)));
}

/**
 * Trims a title that would overflow the wrap area, adding a "..." ellipsis. The
 * renderer wraps for us; this only estimates capacity (charsPerLine * maxLines).
 */
function fitTitle(
  title: string,
  widthPx: number,
  fontSizePx: number,
  maxLines = 2,
): string {
  const maxChars = charsPerLine(widthPx, fontSizePx) * maxLines;
  if (title.length <= maxChars) return title;
  return title.slice(0, Math.max(1, maxChars - 3)).replace(/\s+$/, '') + '...';
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
  const scale = style.scale && style.scale > 0 ? style.scale : 1;
  const fontPath = style.fontPath || '';

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

  const headerY = py(HEADER_Y);
  const rowHeight = py(ROW_H);
  const boxLeft = px(BOX_LEFT);
  const boxSize = px(BOX_SIZE);
  const boxTopInRow = py(BOX_TOP_IN_ROW);
  const taskLeft = px(TASK_TEXT_LEFT);
  // Title text, the blank writable box, and the priority flag all share this
  // same right edge -- the flag is drawn overlapping the row's right end
  // rather than in a reserved cut-out, so it doesn't narrow/truncate rows
  // that don't have one (and rows that do just overlap it there).
  const taskRight = px(TASK_TEXT_RIGHT);
  const dueLeft = px(DUE_TEXT_LEFT);
  const dueRight = px(DUE_TEXT_RIGHT);
  const dividerX = px(DIVIDER_X);
  // Font scales with the user's list-size setting, capped so it stays in the row.
  const fontSize = Math.min(Math.round(size.height * FONT_SIZE * scale), rowHeight - 24);

  const entries: ChecklistEntry[] = [];
  // Element creation (createElement) is a native round-trip EACH, and ~66 of them
  // done sequentially was the sync bottleneck (~17-20s). Collect the build
  // promises here and resolve them all in parallel at the end so the round-trips
  // pipeline instead of blocking one another.
  const elementPromises: Promise<any>[] = [];

  // Due date/time uses a smaller font so a stacked date + time fits the column.
  const dueFontSize = Math.max(18, Math.round(fontSize * 0.68));
  const rectInset = Math.round(rowHeight * 0.12);
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
    elementPromises.push(mkRect(box.left, box.top, box.right, box.bottom));
    return box;
  };

  // Wrapped, ellipsized, vertically-centered title. Returns the strike span.
  // When `source` is given (the task was lasso-captured from another note), the
  // title is drawn as an underlined LINK that jumps back to that note page.
  const drawTitle = async (rowTop: number, title: string, source?: TaskSource) => {
    const taskW = taskRight - taskLeft;
    const perLine = charsPerLine(taskW, fontSize);
    const displayTitle = fitTitle(title, taskW, fontSize);
    const lineH = Math.round(fontSize * 1.3);
    const blockH = (displayTitle.length > perLine ? 2 : 1) * lineH;
    const tTop = rowTop + Math.max(2, Math.round((rowHeight - blockH) / 2));
    // Text is top-aligned and the SDK clips at the rect bottom, so run the rect all
    // the way to the row's bottom -- maximum descender room for g/y/p/j on the last
    // line -- while the text stays put at tTop.
    const tBottom = rowTop + rowHeight - 2;
    elementPromises.push(
      source
        ? mkLink(displayTitle, taskLeft, taskRight, tTop, tBottom, source.notePath, source.page)
        : mkText(displayTitle, taskLeft, taskRight, tTop, tBottom),
    );
    const textInset = Math.round(fontSize * 0.35);
    const textStart = taskLeft + textInset;
    const estWidth = Math.round(displayTitle.length * fontSize * CHAR_W);
    const textEnd = textStart + Math.min(estWidth, taskW - textInset);
    return {textStart, textEnd};
  };

  const drawDue = async (rowTop: number, due?: string | null) => {
    if (!due) return;
    const {date, time} = formatDueParts(due);
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
      left: dividerX + Math.round(rowHeight * 0.12),
      top: rowTop + rectInset,
      right: dueRight,
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
  const drawHeading = async (text: string, leftF: number, rightF: number, fontFrac: number) => {
    const fs = Math.round(size.height * fontFrac);
    const top = headingMid - Math.round(fs / 2);
    // Text is top-aligned and clips at the rect bottom, so add descender room.
    const bottom = top + fs + Math.round(fs * 0.4);
    elementPromises.push(mkText(text, px(leftF), px(rightF), top, bottom, fs, 1, 1));
  };

  if (style.drawChrome) {
    // Ruled row lines (toggle above -- ~24% of a redraw's element count) +
    // column divider (light gray, like the template).
    if (DRAW_RULED_LINES) {
      for (let i = 0; i <= N_ROWS; i++) {
        const y = headerY + i * rowHeight;
        elementPromises.push(mkLine(px(RULE_LEFT), y, px(RULE_RIGHT), y, DIVIDER_WIDTH, RULE_COLOR));
      }
    }
    elementPromises.push(
      mkLine(dividerX, py(DIVIDER_TOP), dividerX, py(DIVIDER_BOTTOM), DIVIDER_WIDTH, RULE_COLOR),
    );
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
  if (header && header.platform) {
    const labelW = px(HEADER_LABEL_RIGHT) - px(HEADER_LABEL_LEFT);
    const oneLine = header.list ? `${header.platform} - ${header.list}` : header.platform;
    const oneLineFs = Math.round(size.height * TITLE_FONT);
    const fitsOneLine = charsPerLine(labelW, oneLineFs, HEADER_CHAR_W) >= oneLine.length;
    if (!header.list || fitsOneLine) {
      await drawHeading(oneLine.toUpperCase(), HEADER_LABEL_LEFT, HEADER_LABEL_RIGHT, TITLE_FONT);
    } else {
      // A long list name doesn't fit alongside the platform on one line --
      // stack them instead of letting it run into the DUE column or clip.
      // Sized to fit both lines within HEADER_LABEL_TOP..BOTTOM.
      const fs2 = Math.round(size.height * TITLE_FONT_2LINE);
      const lineH2 = Math.round(fs2 * 1.3);
      const line1Top = py(HEADER_LABEL_TOP);
      const line2Top = line1Top + lineH2;
      elementPromises.push(
        mkText(
          header.platform.toUpperCase(), px(HEADER_LABEL_LEFT), px(HEADER_LABEL_RIGHT),
          line1Top, line1Top + lineH2, fs2, 1, 1,
        ),
      );
      elementPromises.push(
        mkText(
          header.list.toUpperCase(), px(HEADER_LABEL_LEFT), px(HEADER_LABEL_RIGHT),
          line2Top, line2Top + lineH2, fs2, 1, 1,
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

  let slot = 0;
  for (const reminder of ordered) {
    if (slot >= N_ROWS) break;
    const rowTop = rowTopOf(slot);
    const box = await drawCheckbox(rowTop);
    if (reminder.priority) drawPriorityFlag(rowTop, reminder.priority);
    const {textStart, textEnd} = await drawTitle(
      rowTop,
      reminder.title,
      style.sources?.[reminder.id],
    );
    const entry: ChecklistEntry = {
      kind: 'synced', reminderId: reminder.id, title: reminder.title, box, textStart, textEnd,
    };
    // Show the date if it has one; otherwise give it a box to write one into.
    if (reminder.due) await drawDue(rowTop, reminder.due);
    else entry.dueRect = await drawDueBox(rowTop);
    entries.push(entry);
    slot++;
  }

  // Remaining slots become blank writable rows so every empty row is ready --
  // a task box on the left and a DUE box on the right.
  for (; slot < N_ROWS; slot++) {
    const rowTop = rowTopOf(slot);
    const box = await drawCheckbox(rowTop);
    const rect = {
      left: taskLeft,
      top: rowTop + rectInset,
      right: taskRight,
      bottom: rowTop + rowHeight - rectInset,
    };
    elementPromises.push(mkRect(rect.left, rect.top, rect.right, rect.bottom));
    const dueRect = await drawDueBox(rowTop);
    entries.push({kind: 'blank', title: '', box, rect, dueRect});
  }

  // If the list is longer than the page fits, note how many are hidden. They
  // surface as you complete tasks above and the list compacts on the next sync.
  const hiddenCount = ordered.length - N_ROWS;
  if (hiddenCount > 0) {
    elementPromises.push(
      mkText(
        `+ ${hiddenCount} MORE NOT SHOWN`,
        px(FOOTER_LEFT),
        px(FOOTER_RIGHT),
        py(FOOTER_TOP),
        py(FOOTER_BOTTOM),
        Math.round(size.height * FOOTER_FONT),
        1, // center
      ),
    );
  }

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
    // WITHOUT rebuilding every element (~66 native round-trips).
    _lastDrawn = {notePath, page, elements};
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
    return (els || []).filter((el: any) => el.type === 0).length;
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
 * The SDK's own emrPoint2Android is wrong for portrait notes: it maps the two
 * axes with different scales (maxX for one, maxY for the other), but the
 * digitizer grid is isotropic, and for a portrait page its maxY value is far
 * too small -- so converted X coordinates come out negative and nothing ever
 * matches a checkbox. Verified on an A5X: a single scale of maxX/(width-1)
 * applied to both axes lands strokes exactly on the boxes they were drawn in.
 *
 * The transform is still a 90-degree swap: screen X comes from EMR Y (flipped)
 * and screen Y from EMR X, which is why the axes can't share the SDK's
 * mismatched scale in the first place.
 */
export function emrToScreen(p: {x: number; y: number}, pageSize: PageSize): {x: number; y: number} {
  const scale = PointUtils.getRealMaxX(pageSize) / (pageSize.width - 1);
  return {
    x: pageSize.width - 1 - p.y / scale,
    y: p.x / scale,
  };
}

async function strokeBoundingBox(
  element: any,
  pageSize: PageSize,
): Promise<BoundingBox | null> {
  const points = element?.stroke?.points;
  if (!points) return null;
  const size: number = await points.size();
  if (!size) return null;
  // One read per stroke: the cost here is per-call round-trip latency, not the
  // point volume, so a single getRange is faster than any multi-read sampling.
  const pts = await points.getRange(0, size);
  if (!pts || pts.length === 0) return null;

  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of pts) {
    const s = emrToScreen(p, pageSize);
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

  const results: DetectedCheck[] = [];
  for (const entry of completedEntries) {
    const checkNums: number[] = [];
    for (const stroke of strokes) {
      const bbox = await strokeBoundingBox(stroke, pageSize);
      if (bbox && boxesOverlapEnough(bbox, entry.box)) {
        checkNums.push(stroke.numInPage);
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

/** Diagnostic: log every page stroke's screen bbox + layer, to compare vs boxes. */
export async function debugStrokes(notePath: string, page: number): Promise<void> {
  const size = await unwrap<PageSize>(
    PluginFileAPI.getPageSize(notePath, page),
    'getPageSize',
  );
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const all = elements || [];
  const typeCounts: Record<string, number> = {};
  for (const el of all) {
    const k = `type${el?.type}/layer${el?.layerNum}`;
    typeCounts[k] = (typeCounts[k] || 0) + 1;
  }
  console.log('[Ink2Task] DEBUG page elements:', JSON.stringify(typeCounts), 'size', JSON.stringify(size));
  const strokes = all.filter((el: any) => el.type === 0);
  for (const s of strokes.slice(0, 12)) {
    const bbox = await strokeBoundingBox(s, size);
    console.log('[Ink2Task] DEBUG stroke layer', s.layerNum, 'screenBBox', JSON.stringify(bbox));
  }
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
  const out: StrokeCenter[] = [];
  for (const stroke of strokes) {
    const bbox = await strokeBoundingBox(stroke, size);
    if (!bbox) continue;
    out.push({stroke, cx: (bbox.left + bbox.right) / 2, cy: (bbox.top + bbox.bottom) / 2});
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
  const elements = await unwrap<any[]>(
    PluginFileAPI.getElements(page, notePath),
    'getElements',
  );
  const centers: StrokeCenter[] = [];
  const strokes: any[] = [];
  const texts: TextElement[] = [];
  for (const el of elements || []) {
    if (el.layerNum !== MAIN_LAYER) continue;
    if (el.type === 0) {
      // TYPE_STROKE
      strokes.push(el);
      const bbox = await strokeBoundingBox(el, pageSize);
      if (bbox) {
        centers.push({stroke: el, cx: (bbox.left + bbox.right) / 2, cy: (bbox.top + bbox.bottom) / 2});
      }
    } else if (el.type === Element.TYPE_TEXT) {
      const r = el.textBox?.textRect;
      const text = (el.textBox?.textContentFull ?? '').trim();
      if (r && text) {
        texts.push({el, text, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2});
      }
    }
  }
  return {pageSize, centers, strokes, texts};
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
  const nums: number[] = [];
  for (const stroke of strokes) {
    const bbox = await strokeBoundingBox(stroke, size);
    if (!bbox) continue;
    const cx = (bbox.left + bbox.right) / 2;
    const cy = (bbox.top + bbox.bottom) / 2;
    if (cx >= zone.left && cx <= zone.right && cy >= zone.top && cy <= zone.bottom) {
      nums.push(stroke.numInPage);
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
  for (const entry of done) {
    for (const stroke of strokes) {
      const bbox = await strokeBoundingBox(stroke, pageSize);
      if (!bbox) continue;
      if (boxesOverlapEnough(bbox, entry.box)) {
        nums.add(stroke.numInPage);
        continue;
      }
      if (entry.rect) {
        const cx = (bbox.left + bbox.right) / 2;
        const cy = (bbox.top + bbox.bottom) / 2;
        const r = entry.rect;
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          nums.add(stroke.numInPage);
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
