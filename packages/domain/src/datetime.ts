/**
 * Dates and times as a person reads them — the one formatter for the web portal, the field
 * app and newly rendered reports (R-39(d), as amended by the owner on 2026-10-03: proposed
 * R-45(b)).
 *
 *   formatDateTime → "30 Sept 2026, 2:05 PM"   (12-hour, to the minute, no seconds)
 *   formatDate     → "30 Sept 2026"
 *   formatDayMonth → "30 Sept"                 (tiles and tight columns)
 *   formatTime     → "2:05 PM"
 *   formatWeekdayDate → "Wed, 30 Sept 2026"   (a day heading)
 *
 * **Always India Standard Time**, whatever zone the viewer's machine or the render host is
 * in: the plants are in India, and a report rendered on a UTC server must print the day the
 * plant lived through. IST is a fixed UTC+05:30 with no daylight saving, so the conversion
 * is arithmetic rather than `Intl`. That keeps the output identical in Node, a browser and
 * Hermes on Android, whose `Intl` locale data differ (the reason "Sept" vs "Sep" used to
 * depend on the platform). No zone suffix is printed: every time shown is IST.
 *
 * The day is two digits ("01 Oct 2026"), as the field app and the reports already print it,
 * so a column of dates lines up; the hour is not padded ("9:05 AM"), as a clock reads.
 * Month abbreviations follow en-IN: three letters, except "Sept".
 *
 * `null`, `undefined` and an unparseable value read "—": a missing date is shown as
 * missing, never as 1 Jan 1970.
 */
export type DateInput = string | number | Date | null | undefined;

/** The em dash every screen prints for "no date". */
export const NO_DATE = '—';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'] as const;

interface IstParts {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number; // 0–23
  minute: number;
  weekday: number; // 0 = Sunday
}

function toMillis(value: DateInput): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The wall clock in India at that instant: shift by +05:30, then read the UTC fields. */
function istParts(value: DateInput): IstParts | null {
  const ms = toMillis(value);
  if (ms === null) return null;
  const shifted = new Date(ms + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

function dayMonth(parts: IstParts): string {
  return `${pad2(parts.day)} ${MONTHS[parts.month]}`;
}

function clock(parts: IstParts): string {
  const hour12 = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${hour12}:${pad2(parts.minute)} ${parts.hour < 12 ? 'AM' : 'PM'}`;
}

/** "30 Sept 2026, 2:05 PM" */
export function formatDateTime(value: DateInput): string {
  const parts = istParts(value);
  return parts ? `${dayMonth(parts)} ${parts.year}, ${clock(parts)}` : NO_DATE;
}

/** "30 Sept 2026" */
export function formatDate(value: DateInput): string {
  const parts = istParts(value);
  return parts ? `${dayMonth(parts)} ${parts.year}` : NO_DATE;
}

/** "30 Sept" — where the year is obvious from the screen (a tile, a chart axis). */
export function formatDayMonth(value: DateInput): string {
  const parts = istParts(value);
  return parts ? dayMonth(parts) : NO_DATE;
}

/** "2:05 PM" */
export function formatTime(value: DateInput): string {
  const parts = istParts(value);
  return parts ? clock(parts) : NO_DATE;
}

/** "Wed, 30 Sept 2026" — the heading above one day's rows. */
export function formatWeekdayDate(value: DateInput): string {
  const parts = istParts(value);
  return parts ? `${WEEKDAYS[parts.weekday]}, ${dayMonth(parts)} ${parts.year}` : NO_DATE;
}

/**
 * "2026-09-30": the IST calendar day, as a key to group rows by day. `null` when missing.
 * Turn a key back into words with `formatWeekdayDate(\`${key}T12:00:00+05:30\`)`.
 */
export function istDateKey(value: DateInput): string | null {
  const parts = istParts(value);
  return parts ? `${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)}` : null;
}

/**
 * Whole IST calendar days from `from` to `to` (default: now). Calendar days, not 24-hour
 * blocks: something raised at 11 PM yesterday is one day old this morning, as a plant
 * counts it. `null` when either end is missing; never negative.
 */
export function daysBetween(from: DateInput, to: DateInput = Date.now()): number | null {
  const start = toMillis(from);
  const end = toMillis(to);
  if (start === null || end === null) return null;
  const startDay = Math.floor((start + IST_OFFSET_MS) / DAY_MS);
  const endDay = Math.floor((end + IST_OFFSET_MS) / DAY_MS);
  return Math.max(0, endDay - startDay);
}

/** "today", "1 day", "9 days" — how long ago `from` was, in IST calendar days. */
export function formatAge(from: DateInput, now: DateInput = Date.now()): string {
  const days = daysBetween(from, now);
  if (days === null) return NO_DATE;
  if (days === 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}
