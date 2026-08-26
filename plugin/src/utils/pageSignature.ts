/**
 * A fingerprint of everything that decides what a checklist page LOOKS like.
 *
 * Used to skip redrawing a page whose content has not changed. Every page of
 * the list is currently erased and repainted on every sync, and each repaint is
 * a full e-ink refresh -- a three-page list flashes the screen four times (three
 * pages plus the final reload) even when a single task changed on page one.
 *
 * The awkward part is the "UPDATED: 4:42 PM" stamp at the bottom of every page,
 * which changes every sync and would make every page look dirty. It is
 * deliberately NOT in this signature: an unchanged page keeps its drawing and
 * gets only that one line rewritten in place, which is what modifyElements is
 * for (proven on device 2026-08-24: targeted, nothing else disturbed).
 *
 * Import-free so it stays unit testable.
 */

/** Separator that cannot appear in an id, a title, or a footer. */
const SEP = String.fromCharCode(31);

/** The fields of a task that actually reach the page. */
type Drawable = {
  id: string;
  title: string;
  due?: string | null;
  priority?: number;
  parentId?: string;
};

export type SignatureInput = {
  tasks: Drawable[];
  /** Footer line, minus the timestamp -- it carries page N of M and overflow. */
  footer: string;
  /** Blank writable rows drawn after the last task. Changes the page. */
  blankRows: number;
  /** Header text, which names the backend and list. */
  header?: string;
  /** Anything else that changes the drawing: scale, 12/24h, chrome, links. */
  flags?: (string | number | boolean | undefined)[];
};

/**
 * Order matters, so this joins rather than sorts: two identical tasks swapped
 * between rows IS a visible change.
 *
 * Keeps the raw strings rather than hashing. They are short, the comparison is
 * a string equality either way, and a readable signature is far easier to
 * debug from a log than a hash when a page mysteriously refuses to redraw.
 */
export function signatureOf(input: SignatureInput): string {
  const rows = input.tasks.map(t =>
    [t.id, t.title, t.due ?? '', t.priority ?? '', t.parentId ?? ''].join(SEP),
  );
  return [
    'v1',
    `rows=${rows.length}`,
    `blank=${input.blankRows}`,
    `header=${input.header ?? ''}`,
    `footer=${input.footer}`,
    `flags=${(input.flags ?? []).map(f => String(f ?? '')).join(',')}`,
    ...rows,
  ].join(SEP);
}

/**
 * Whether a page can keep its current drawing.
 *
 * Ink is a veto, not a detail: if the user has written on the page, the redraw
 * is the ONLY thing that erases it (replaceElements wipes the page, which is
 * exactly why it is used). Skipping a page with ink on it would leave a
 * captured task's handwriting sitting there forever -- the worst failure this
 * optimisation could cause, so it is checked first. An UNKNOWN ink count is
 * treated the same as ink present: never guess in the direction that loses.
 */
export function canSkipRedraw(params: {
  previous: string | undefined;
  next: string;
  inkStrokes: number | undefined;
}): boolean {
  if (params.inkStrokes === undefined || params.inkStrokes > 0) return false;
  if (!params.previous) return false;
  return params.previous === params.next;
}
