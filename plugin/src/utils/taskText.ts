/**
 * Text measurement, ellipsizing, and subtask-depth logic for the checklist page.
 *
 * Deliberately has NO imports. checklistPage.ts imports sn-plugin-lib, which is
 * a native ESM module Jest cannot transform, so anything living there is
 * untestable. These are the pure parts, pulled out so they can be unit tested
 * (see __tests__/taskText.test.ts). Same reason api/serverFeatures.ts exists.
 */

/** Deepest nesting the page will render or parse. Todoist allows ~5; beyond a
 * few levels the prefix eats the row, and the markers stop being readable. */
export const MAX_SUBTASK_DEPTH = 4;

/**
 * Per-glyph advance widths as a fraction of font size, for the device's
 * sans-serif UI font.
 *
 * WHY NOT A SINGLE AVERAGE: this used to be one constant (CHAR_W = 0.485) and
 * its tuning history is recorded in git -- 0.6 truncated titles that visibly
 * still had room, 0.5 cut about five characters early, 0.47 went too far the
 * other way and overflowed. No single number can be right, because a flat
 * average charges 'i' and 'm' the same. A title full of narrow letters gets
 * ellipsized with a third of the row empty, which is exactly the complaint
 * this replaces.
 *
 * These are approximations, not the real font metrics (the SDK exposes no text
 * measurement API, so there is nothing to query). They lean slightly WIDE on
 * purpose: overestimating means an early ellipsis, while underestimating means
 * the renderer wraps to a line that gets clipped by the text rect and the tail
 * vanishes silently. An early ellipsis is the safer failure.
 */
const NARROW = 'ilj.,\'`!|:;()[]{}/\\ ' + '’‘';
const SEMI_NARROW = 'ftrI"-';
const WIDE = 'mwMW@%';

function glyphWidth(ch: string): number {
  if (NARROW.includes(ch)) return 0.28;
  if (SEMI_NARROW.includes(ch)) return 0.36;
  if (WIDE.includes(ch)) return 0.82;
  const code = ch.charCodeAt(0);
  // Digits and uppercase are wider than lowercase in this family.
  if (code >= 48 && code <= 57) return 0.57; // 0-9
  if (code >= 65 && code <= 90) return 0.63; // A-Z
  if (code >= 97 && code <= 122) return 0.53; // a-z
  // Anything else (punctuation, CJK, emoji) -- assume roughly one em so a
  // wide glyph can never silently overflow. CJK really is about square.
  return code > 0x2e80 ? 1.0 : 0.5;
}

/** Estimated rendered width of `text` in pixels at `fontSizePx`. */
export function measureText(text: string, fontSizePx: number): number {
  let em = 0;
  for (const ch of text) em += glyphWidth(ch);
  return em * fontSizePx;
}

/**
 * Greedy word wrap, matching what the host renderer does closely enough to
 * predict it. `lastLineWidth` narrows only the final permitted line, which is
 * how room is reserved for an ellipsis.
 *
 * Returns the lines produced and how many characters of `text` they consumed,
 * so the caller can tell whether anything was left over.
 */
function wrap(
  text: string,
  widthPx: number,
  fontSizePx: number,
  maxLines: number,
  lastLineWidth = widthPx,
): {lines: string[]; consumed: number} {
  const lines: string[] = [];
  let rest = text;
  let consumed = 0;

  while (rest.length > 0 && lines.length < maxLines) {
    const limit = lines.length === maxLines - 1 ? lastLineWidth : widthPx;
    // Longest prefix of whole words that fits.
    let take = 0;
    let lastBreak = -1;
    let w = 0;
    for (let i = 0; i < rest.length; i++) {
      w += glyphWidth(rest[i]) * fontSizePx;
      if (w > limit) break;
      take = i + 1;
      if (rest[i] === ' ') lastBreak = i;
    }
    if (take === 0) break; // nothing fits at all (limit smaller than one glyph)

    let line: string;
    if (take >= rest.length) {
      line = rest;
      rest = '';
    } else if (rest[take] === ' ') {
      // Break landed exactly at a space: clean split, no word cut.
      line = rest.slice(0, take);
      rest = rest.slice(take + 1);
    } else if (lastBreak > 0) {
      line = rest.slice(0, lastBreak);
      rest = rest.slice(lastBreak + 1);
    } else {
      // A single word longer than the line: hard-break it rather than loop.
      line = rest.slice(0, take);
      rest = rest.slice(take);
    }
    consumed += line.length + (rest.length > 0 ? 1 : 0);
    lines.push(line);
  }

  return {lines, consumed};
}

/** How many lines `text` needs, capped at `maxLines`. */
/**
 * Fraction of a row's real width this module will actually fill.
 *
 * The glyph widths here are estimates of a font we cannot measure, and they run
 * slightly NARROW. That only matters for a title sitting on the boundary, and
 * then it matters a lot: a title measured at 2624px against 2648px of room for
 * two lines was drawn by the device as THREE lines, and the third spilled down
 * into the next task's row and collided with its text (device-reported
 * 2026-08-26). We were wrong by under 1%.
 *
 * The two ways to be wrong are not equal. Underestimating overflows the row and
 * makes two tasks unreadable; overestimating ellipsizes a title a few
 * characters early. So this leaves a margin comfortably wider than the error
 * observed, and accepts the occasional early "...".
 *
 * Not a fix for the estimates themselves -- there is no way to ask the device
 * how wide its font renders. This is the honest way to be wrong.
 */
const WIDTH_SAFETY = 0.96;

/** The width this module will wrap within, given a row's real width. */
function usableWidth(widthPx: number): number {
  return Math.floor(widthPx * WIDTH_SAFETY);
}

export function lineCount(text: string, widthPx: number, fontSizePx: number, maxLines = 2): number {
  // Same safety margin as fitTitle, so the line count used to position the text
  // vertically agrees with the wrap that produced it.
  return Math.max(1, wrap(text, usableWidth(widthPx), fontSizePx, maxLines).lines.length);
}

/**
 * Trims a title that would overflow `maxLines` at `widthPx`, adding "...".
 *
 * Measures actual glyph widths and simulates the wrap, rather than multiplying
 * a character count by an average width, so a title only gets ellipsized when
 * it genuinely runs out of room.
 */
export function fitTitle(
  title: string,
  widthPx: number,
  fontSizePx: number,
  maxLines = 2,
): string {
  const t = title.trim();
  if (!t || widthPx <= 0) return t;
  // Wrap within slightly less than the real width -- see WIDTH_SAFETY.
  const w = usableWidth(widthPx);

  // Pass 1: does it fit as-is?
  const full = wrap(t, w, fontSizePx, maxLines);
  if (full.consumed >= t.length) return t;

  // Pass 2: it must be cut, so reserve room for the ellipsis on the last line
  // and re-wrap. Reserving up front (in pass 1) would ellipsize titles that
  // actually fit, which is the bug this function exists to avoid.
  const ell = '...';
  const ellW = measureText(ell, fontSizePx);
  const trimmed = wrap(t, w, fontSizePx, maxLines, Math.max(0, w - ellW));
  const kept = trimmed.lines.join(' ').replace(/\s+$/, '');
  // A width so small that not even one glyph plus the ellipsis fits.
  if (!kept) return ell;
  return kept + ell;
}

/**
 * Reads a handwritten subtask marker off the front of a captured line.
 *
 * The page draws subtasks with ">" / ">>" prefixes, so writing the same thing
 * by hand is the natural way to create one. Accepts a few OCR-plausible
 * stand-ins for ">": the recognizer frequently returns the typographic
 * variants, and "»" is a single glyph that reads as two levels.
 *
 * Returns how many chevrons were written and the remaining text. The COUNT no
 * longer selects a nesting level: markers now number siblings (see
 * subtaskMarker), and you cannot ask to be the 2nd child of something. Capture
 * treats any count > 0 as simply "make this a subtask of the task above".
 */
export function parseSubtaskPrefix(text: string): {depth: number; rest: string} {
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '>' || ch === '›') {
      // ASCII ">" and single right-angle quote
      depth += 1;
      i++;
      continue;
    }
    if (ch === '»') {
      // "»" renders as two chevrons, so treat it as two levels
      depth += 2;
      i++;
      continue;
    }
    break;
  }
  if (depth === 0) return {depth: 0, rest: text.trim()};
  const rest = text.slice(i).trim();
  // A line of nothing but markers is not a task. Give the marker back so the
  // caller treats it as ordinary text rather than creating an empty subtask.
  if (!rest) return {depth: 0, rest: text.trim()};
  return {depth: Math.min(depth, MAX_SUBTASK_DEPTH), rest};
}

/**
 * The marker drawn ahead of a subtask title: one ">" per sibling position, so
 * the first subtask of a parent gets ">", the second ">>", the third ">>>".
 *
 * NOTE this counts SIBLING POSITION, not nesting depth (user's call,
 * 2026-08-22). Three subtasks of the same parent are all at depth 1, so a
 * depth-based marker gave all three a single ">" and there was no way to tell
 * them apart at a glance. Capped so a long run of siblings cannot eat the row.
 */
export function subtaskMarker(siblingIndex: number): string {
  if (siblingIndex <= 0) return '';
  return '>'.repeat(Math.min(siblingIndex, MAX_SUBTASK_DEPTH));
}

/**
 * 1-based position of each subtask among the children of ITS OWN parent, and 0
 * for top-level tasks. Drives the ">" / ">>" marker (see subtaskMarker).
 *
 * Counted in the order the backend returned, which is the order the rows are
 * drawn in, so the numbering reads top to bottom on the page.
 */
export function subtaskSiblingIndex(
  tasks: {id: string; parentId?: string}[],
): Map<string, number> {
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const t of tasks) {
    if (!t.parentId) {
      out.set(t.id, 0);
      continue;
    }
    const n = (seen.get(t.parentId) ?? 0) + 1;
    seen.set(t.parentId, n);
    out.set(t.id, n);
  }
  return out;
}

/**
 * Finds the task a handwritten subtask should attach to: the nearest row ABOVE
 * `index` that is already synced and sits shallower than `wantDepth`.
 *
 * Deliberately forgiving about depth. Requiring an exact `wantDepth - 1` match
 * would make ">>" fail whenever the row above is top-level, which is a very
 * easy thing to write by accident and gives no useful feedback. Instead the
 * first shallower row wins and the real depth becomes its depth plus one, so
 * ">>" under a top-level task simply behaves like ">".
 *
 * Returns the parent's id and the effective depth, or undefined when there is
 * no candidate above (for example a marker written on the first row).
 */
export function findParent(
  rows: {reminderId?: string; depth?: number}[],
  index: number,
  wantDepth: number,
): {id: string; depth: number} | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || !row.reminderId) continue;
    const rowDepth = row.depth ?? 0;
    if (rowDepth < wantDepth) {
      return {id: row.reminderId, depth: Math.min(rowDepth + 1, MAX_SUBTASK_DEPTH)};
    }
  }
  return undefined;
}

/**
 * Nesting depth for every task in a flat list, from its parent chain.
 *
 * Every backend returns parents and children intermixed in one flat array with
 * only a parentId link, so depth has to be derived. A parent that is not in the
 * list (completed, or on another page) still means "this is a subtask", so it
 * counts as one level rather than zero -- otherwise completing a parent would
 * silently un-indent its children.
 */
export function subtaskDepths(tasks: {id: string; parentId?: string}[]): Map<string, number> {
  const parentOf = new Map<string, string | undefined>();
  for (const t of tasks) parentOf.set(t.id, t.parentId);

  const depths = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const parent = parentOf.get(id);
    let d: number;
    if (!parent) {
      d = 0;
    } else if (!parentOf.has(parent)) {
      d = 1; // parent exists but isn't in this list
    } else if (seen.has(parent)) {
      d = 1; // cycle guard: malformed data, don't recurse forever
    } else {
      seen.add(id);
      d = Math.min(resolve(parent, seen) + 1, MAX_SUBTASK_DEPTH);
    }
    depths.set(id, d);
    return d;
  };

  for (const t of tasks) resolve(t.id, new Set());
  return depths;
}

/**
 * Reorders a flat task list so every child sits immediately after its parent.
 *
 * Backends do NOT return them that way. Each backend's position field is scoped
 * to a parent's own children, so sorting the flat list by it puts children
 * anywhere: on device 2026-08-22 a Google subtask sorted to row 1 while its
 * parent sat at row 6, and Todoist returned all three of a task's children
 * ABOVE it. Google Tasks' own docs comment in google-tasks-server claimed
 * "position already sorts children under their parent" -- it does not.
 *
 * Done in the plugin rather than per server so all four backends get it, and so
 * it can be tested. Two things depend on this order being right:
 *   - the ">" markers only make sense directly under their parent row
 *   - blocksOf() in ./pagination groups a parent with the rows that FOLLOW it,
 *     so a child arriving before its parent would be packed as its own block
 *
 * Relative order is otherwise preserved, so each backend's own manual ordering
 * still shows through. A task whose parent is not in the list (completed, or on
 * another page) is treated as top-level and keeps its place.
 */
export function orderByHierarchy<T extends {id: string; parentId?: string}>(tasks: T[]): T[] {
  const byParent = new Map<string, T[]>();
  const present = new Set(tasks.map(t => t.id));
  const roots: T[] = [];
  for (const t of tasks) {
    const parent = t.parentId && present.has(t.parentId) ? t.parentId : undefined;
    if (!parent) {
      roots.push(t);
      continue;
    }
    const kids = byParent.get(parent);
    if (kids) kids.push(t);
    else byParent.set(parent, [t]);
  }
  const out: T[] = [];
  const emit = (t: T, seen: Set<string>) => {
    if (seen.has(t.id)) return; // cycle guard: malformed data must not hang a sync
    seen.add(t.id);
    out.push(t);
    for (const kid of byParent.get(t.id) ?? []) emit(kid, seen);
  };
  const seen = new Set<string>();
  for (const r of roots) emit(r, seen);
  // Anything unreachable (only possible via a parent cycle) still has to appear.
  for (const t of tasks) if (!seen.has(t.id)) out.push(t);
  return out;
}
