/**
 * Parses a short, handwritten-style date into an ISO date string "YYYY-MM-DD",
 * or null if it can't make sense of it. Date-only on purpose: Google Tasks has
 * no time-of-day, so keeping all three backends date-only keeps them consistent.
 *
 * Handles the formats people actually scribble in a narrow DUE cell:
 *   12/25   7/4/26   2026-01-03   Dec 25   25 Dec   Jan 3 2027
 *   today   tomorrow   mon / monday / next fri
 *
 * A date with no year picks the nearest sensible one: this year, or next year if
 * that day has already passed. Everything is computed from parts (never via
 * Date parsing of the raw string) so nothing shifts a day across a timezone.
 */
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3,
  weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5,
  friday: 5, sat: 6, saturday: 6,
};

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate(); // m is 1-based

/** Builds an ISO date only if month/day are in range (rejects e.g. 13/40, Feb 30). */
function makeIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
}

export function parseDueDate(raw: string, now: Date = new Date()): string | null {
  // Normalize: lowercase, drop ordinal suffixes (25th -> 25), commas/periods to
  // spaces, collapse whitespace.
  const s = (raw || '')
    .toLowerCase()
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, '$1')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  const todayIso = isoOf(now);
  const thisYear = now.getFullYear();

  if (s === 'today') return todayIso;
  if (s === 'tomorrow' || s === 'tmrw' || s === 'tmr' || s === 'tom') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return isoOf(d);
  }

  // Weekday, optionally "next <weekday>". Bare weekday = the next occurrence,
  // counting today as day 0 (so writing today's weekday means today); "next"
  // always pushes a full week when it lands on today.
  const wd = /^(next\s+)?([a-z]+)$/.exec(s);
  if (wd && WEEKDAYS[wd[2]] != null) {
    let delta = (WEEKDAYS[wd[2]] - now.getDay() + 7) % 7;
    if (wd[1] && delta === 0) delta = 7;
    const d = new Date(now);
    d.setDate(d.getDate() + delta);
    return isoOf(d);
  }

  // Numeric: M/D, M/D/YY, M/D/YYYY, or an ISO-ish Y-M-D. Accepts / or - .
  const isoLike = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (isoLike) return makeIso(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]));

  const md = /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/.exec(s);
  if (md) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    const y = md[3] != null ? expandYear(md[3]) : thisYear;
    const iso = makeIso(y, m, d);
    if (!iso) return null;
    if (md[3] == null && iso < todayIso) return makeIso(y + 1, m, d); // passed -> next year
    return iso;
  }

  // Bare digits, no separator -- handwriting OCR routinely drops the "/", so
  // "8/19" comes back as "819" and "12/25" as "1225". Split into month/day:
  //   3 digits = M DD, 4 = MM DD, 6 = MM DD YY, 8 = YYYY MM DD.
  const digits = s.replace(/\s+/g, '');
  if (/^\d{3,8}$/.test(digits)) {
    let mo: number | undefined;
    let da: number | undefined;
    let y: number | undefined;
    if (digits.length === 8) {
      y = Number(digits.slice(0, 4)); mo = Number(digits.slice(4, 6)); da = Number(digits.slice(6, 8));
    } else if (digits.length === 6) {
      mo = Number(digits.slice(0, 2)); da = Number(digits.slice(2, 4)); y = 2000 + Number(digits.slice(4, 6));
    } else if (digits.length === 4) {
      mo = Number(digits.slice(0, 2)); da = Number(digits.slice(2, 4));
    } else {
      mo = Number(digits.slice(0, 1)); da = Number(digits.slice(1, 3)); // 3 digits: M DD
    }
    const iso = makeIso(y ?? thisYear, mo, da);
    if (iso) {
      if (y == null && iso < todayIso) return makeIso(thisYear + 1, mo, da);
      return iso;
    }
    return null;
  }

  // Month name + day, in either order: "dec 25", "25 dec", "jan 3 2027".
  const mn1 = /^([a-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?$/.exec(s);
  const mn2 = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{2,4}))?$/.exec(s);
  let mon: number | undefined;
  let day: number | undefined;
  let yr: string | undefined;
  if (mn1 && MONTHS[mn1[1]] != null) {
    mon = MONTHS[mn1[1]];
    day = Number(mn1[2]);
    yr = mn1[3];
  } else if (mn2 && MONTHS[mn2[2]] != null) {
    mon = MONTHS[mn2[2]];
    day = Number(mn2[1]);
    yr = mn2[3];
  }
  if (mon != null && day != null) {
    const y = yr != null ? expandYear(yr) : thisYear;
    const iso = makeIso(y, mon, day);
    if (!iso) return null;
    if (yr == null && iso < todayIso) return makeIso(y + 1, mon, day);
    return iso;
  }

  return null;
}
