/**
 * One place where dates and times are turned into text.
 *
 * Everything here is pinned to day/month/year. The browser's own locale is
 * deliberately not consulted: `toLocaleDateString()` with no arguments prints
 * 08/12/2026 to a reader in London and to a reader in New York, and means two
 * different days to them. A table has people from several countries at it, and
 * a date that reads differently depending on who is looking is worse than a
 * date nobody can misread.
 *
 * 'en-GB' is used only as a shorthand for that ordering; the explicit `2-digit`
 * options are what actually fix the shape, so a locale data update can't
 * quietly move things around. Times are 24-hour for the same reason: no am/pm
 * to lose track of.
 *
 * Every function returns '' for a missing or unparseable value, so a blank
 * field reads as blank rather than as 1970.
 */

const LOCALE = 'en-GB';

const DATE = { day: '2-digit', month: '2-digit', year: 'numeric' };
const TIME = { hour: '2-digit', minute: '2-digit', hour12: false };

const parse = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "16/08/2026". */
export function formatDate(value) {
  const d = parse(value);
  return d ? d.toLocaleDateString(LOCALE, DATE) : '';
}

/** "14:32". */
export function formatTime(value) {
  const d = parse(value);
  return d ? d.toLocaleTimeString(LOCALE, TIME) : '';
}

/** "16/08/2026, 14:32" - the full moment, for tooltips and one-off lines. */
export function formatDateTime(value) {
  const d = parse(value);
  return d ? d.toLocaleString(LOCALE, { ...DATE, ...TIME }) : '';
}
