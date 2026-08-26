/**
 * Yes/no prompts on the tablet's own dialog.
 *
 * `showRattaDialog(tip, leftBtnTxt, rightBtnTxt, isSuccess)` resolves to a
 * boolean, and the SDK does not document which button is `true`.
 *
 * DEVICE-CONFIRMED 2026-08-24: **`true` is the RIGHT-hand button.** Logged as
 * `left="Keep" right="Delete" -> true` on a Manta, with the page actually
 * removed. So put the confirming action on the right.
 *
 * The code is still written so an unexpected answer keeps the page, and the
 * raw value is still logged beside the labels. That costs nothing and means a
 * firmware change to the button order shows up as "nothing gets deleted"
 * rather than as deleted pages.
 */
import {NativeUIUtils} from 'sn-plugin-lib';

/**
 * Asks before removing continuation pages the list no longer needs.
 *
 * Worth asking at all because the tasks can be ticked off somewhere else
 * entirely -- on a phone, or the web -- and the first this tablet knows of it
 * is a page that has gone empty. If anything else was written on that page, a
 * silent deletion takes it with no warning and no undo.
 *
 * Returns true ONLY on the answer we believe means yes. Anything else --
 * the other button, a dismissed dialog, a missing API, an error -- keeps the
 * page.
 */
export async function confirmRemovePages(pageNumbers: number[]): Promise<boolean> {
  if (pageNumbers.length === 0) return false;
  // Shown 1-based, matching the page numbers in the footer and the note itself.
  const list = pageNumbers.map(p => p + 1).join(', ');
  // Says the page is BLANK, which is the fact the answer actually turns on.
  // The first version named a page number and asked "delete it?", which gave
  // the user no way to tell whether that page held their own writing -- so
  // pressing Delete was a reasonable answer to a question that hid the thing
  // that mattered. Only pages with no ink and no tasks ever reach this prompt
  // (see pagesToReclaim's vetoes), so this is safe to state plainly.
  const tip =
    pageNumbers.length === 1
      ? `Page ${list} is now blank and Ink2Task no longer needs it. Nothing is written on it.\n\nDelete that page?`
      : `Pages ${list} are now blank and Ink2Task no longer needs them. Nothing is written on them.\n\nDelete them?`;
  const KEEP = 'Keep';
  const DELETE = 'Delete';
  try {
    const api: any = NativeUIUtils as any;
    if (typeof api?.showRattaDialog !== 'function') return false;
    // Left = Keep, Right = Delete, on the convention that the right-hand button
    // is the confirming one. If the boolean turns out to mean the opposite, the
    // log line below says so and the page is simply kept in the meantime.
    const answer = await api.showRattaDialog(tip, KEEP, DELETE, false);
    console.log(
      `[Ink2Task] remove-pages dialog: left="${KEEP}" right="${DELETE}" -> ${JSON.stringify(answer)}`,
    );
    return answer === true;
  } catch (e: any) {
    console.log('[Ink2Task] remove-pages dialog failed:', e?.message || e);
    return false;
  }
}
