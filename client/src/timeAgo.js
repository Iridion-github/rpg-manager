/**
 * "3 minutes ago", "yesterday", "last month".
 *
 * Through Intl.RelativeTimeFormat rather than a table of English strings, so
 * the wording follows the reader's own locale - and so "1 days ago" can't
 * happen. The unit is chosen by size: the useful thing about a timestamp from
 * four months back is not how many hours it was.
 *
 * `numeric: 'auto'` is what turns "1 day ago" into "yesterday" where the
 * language has a word for it.
 */

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

// Largest first, so the first one that fits is the one worth saying. Seconds
// are deliberately absent: nothing here is precise to the second, and "42
// seconds ago" reads as a stopwatch rather than a memory.
const STEPS = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/**
 * How long ago that was, in words. Returns '' for anything unparseable, so a
 * missing timestamp reads as nothing rather than as 1970.
 */
export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const elapsed = Date.now() - then.getTime();
  // Under a minute - and, for a clock that's a little fast, anything in the
  // near future - is simply now. A negative "in 3 seconds" would be a report
  // about the reader's own clock rather than about the person.
  if (elapsed < 60 * 1000) return 'just now';

  for (const [unit, ms] of STEPS) {
    if (elapsed >= ms) return relative.format(-Math.round(elapsed / ms), unit);
  }
  return 'just now';
}

/** The same moment written out in full, for a tooltip beside the short form. */
export function exactTime(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  return Number.isNaN(then.getTime()) ? '' : then.toLocaleString();
}
