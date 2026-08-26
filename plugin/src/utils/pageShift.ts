/**
 * Renumbering the page-indexed records when a page is inserted mid-note.
 *
 * Inserting a page anywhere but the end shifts every later page up by one, and
 * SIX separate stores key their data by absolute page index: the checklist
 * registry, page bindings, page signatures, erased-ink prints, the
 * created-pages count, and the last-viewed / lasso-target page refs. Miss one
 * and its records point at the wrong page, which is exactly the failure that
 * destroyed a set of Apple Reminders pages on 2026-08-24 -- records that
 * disagreed with the note.
 *
 * So the shifting lives here: import-free, exhaustively tested, and applied in
 * one go rather than scattered across the call site.
 *
 * Keys look like "<notePath>#<page>" (see registryKey). Only keys for the note
 * being changed move; other notes are untouched.
 */

/** Splits "<notePath>#<page>" back into its parts, or null if it is not one. */
export function parsePageKey(key: string): {notePath: string; page: number} | null {
  const hash = key.lastIndexOf('#');
  if (hash <= 0) return null;
  const suffix = key.slice(hash + 1);
  // Digits only, and at least one. Number('') is 0, so a key ending in a bare
  // '#' used to parse as PAGE 0 -- and would then be shifted on top of the real
  // page 0's records. Caught by the test that feeds this deliberate junk.
  if (!/^\d+$/.test(suffix)) return null;
  const page = Number(suffix);
  if (!Number.isSafeInteger(page)) return null;
  return {notePath: key.slice(0, hash), page};
}

/**
 * Shifts every key for `notePath` at or after `insertedAt` up by one.
 *
 * Iterates HIGHEST PAGE FIRST. Going upwards would overwrite page N+1 with
 * page N before N+1 itself had moved, silently merging two pages' records.
 */
export function shiftPageKeys<T>(
  store: {[key: string]: T},
  notePath: string,
  insertedAt: number,
): {[key: string]: T} {
  const out: {[key: string]: T} = {};
  const moving: {page: number; value: T}[] = [];
  for (const [key, value] of Object.entries(store)) {
    const parsed = parsePageKey(key);
    if (!parsed || parsed.notePath !== notePath || parsed.page < insertedAt) {
      out[key] = value;
      continue;
    }
    moving.push({page: parsed.page, value});
  }
  moving.sort((a, b) => b.page - a.page);
  for (const m of moving) out[`${notePath}#${m.page + 1}`] = m.value;
  return out;
}

/** Shifts a single page reference, when it points into the affected note. */
export function shiftPageRef(
  ref: {notePath: string; page: number} | null | undefined,
  notePath: string,
  insertedAt: number,
): {notePath: string; page: number} | null | undefined {
  if (!ref || ref.notePath !== notePath) return ref;
  return ref.page >= insertedAt ? {...ref, page: ref.page + 1} : ref;
}

/**
 * New created-pages count after an insert.
 *
 * The count is "how many leading pages of this note are ours", so inserting
 * INSIDE that run grows it by one and inserting beyond it changes nothing.
 */
export function shiftTemplatedCount(count: number, insertedAt: number): number {
  return insertedAt < count ? count + 1 : count;
}

/**
 * Shifts every key for `notePath` ABOVE `removedAt` down by one, and drops the
 * removed page's own key.
 *
 * The mirror of shiftPageKeys, for when a page is deleted. Removing page N
 * slides N+1 down into its place, so records left describing N+1 now point at
 * the wrong page -- the same misalignment that let a Todoist sync draw over a
 * page of Apple Reminders (2026-08-25), just arrived at from the other
 * direction.
 *
 * Iterates LOWEST PAGE FIRST here, the opposite of the insert case: going
 * downwards, page N+1 must move into N before N+2 moves into N+1, or one
 * overwrites the other.
 */
export function unshiftPageKeys<T>(
  store: {[key: string]: T},
  notePath: string,
  removedAt: number,
): {[key: string]: T} {
  const out: {[key: string]: T} = {};
  const moving: {page: number; value: T}[] = [];
  for (const [key, value] of Object.entries(store)) {
    const parsed = parsePageKey(key);
    if (!parsed || parsed.notePath !== notePath || parsed.page < removedAt) {
      out[key] = value;
      continue;
    }
    // The removed page's own records go; nothing above it has moved into it yet.
    if (parsed.page === removedAt) continue;
    moving.push({page: parsed.page, value});
  }
  moving.sort((a, b) => a.page - b.page);
  for (const m of moving) out[`${notePath}#${m.page - 1}`] = m.value;
  return out;
}

/** A page reference after a page below it was removed. */
export function unshiftPageRef(
  ref: {notePath: string; page: number} | null | undefined,
  notePath: string,
  removedAt: number,
): {notePath: string; page: number} | null | undefined {
  if (!ref || ref.notePath !== notePath) return ref;
  if (ref.page < removedAt) return ref;
  // The page it pointed at is gone; the nearest sensible target is the page
  // that took its place, which is the same index.
  return ref.page === removedAt ? ref : {...ref, page: ref.page - 1};
}
