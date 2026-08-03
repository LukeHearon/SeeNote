// Wall-clock (datetime) rendering of track times.
//
// When a track's filename yields a start time (see utils/filenameTime.ts), every
// time readout can be shown as a real datetime instead of an offset. All of
// this works in the machine's local timezone, and assumes the UTC offset in
// force at the file's start applies for its whole length — a recording that
// spans a DST boundary will read an hour off after the transition.

/** User-facing datetime style: ISO-ish ("2026-07-31 16:56:04") or a plain-English
 *  one ("July 31, 4:56:04p"), both year-free in ruler labels since a recording's
 *  year rarely matters at a glance. Set in the project's Preferences tab. */
export type DateTimeFormat = 'iso' | 'friendly';

const pad = (v: number, width = 2): string => String(v).padStart(width, '0');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Split `seconds` past `start` into a local Date for the whole-second part and
 * a string for the fractional part (empty when `decimals` is 0). Keeping the
 * fraction out of the Date avoids millisecond rounding artifacts in the
 * printed digits.
 */
function at(start: Date, seconds: number, decimals: number): { date: Date; frac: string } {
  const scale = 10 ** decimals;
  const snapped = Math.round(seconds * scale) / scale;
  const whole = Math.floor(snapped);
  const date = new Date(start.getTime() + whole * 1000);
  if (decimals <= 0) return { date, frac: '' };
  const frac = Math.min(scale - 1, Math.round((snapped - whole) * scale));
  return { date, frac: `.${pad(frac, decimals)}` };
}

/** "2026-01-01" (iso) or "January 1" (friendly, no year). */
const dateStr = (d: Date, format: DateTimeFormat): string => format === 'friendly'
  ? `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
  : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "01-02" (iso) or "January 2" (friendly) — used when a ruler label crosses
 *  midnight. No year in either case: at that granularity the year never adds
 *  information a reader doesn't already have from the first label. */
const monthDayStr = (d: Date, format: DateTimeFormat): string => format === 'friendly'
  ? `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`
  : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "16:56:04.25" (iso, 24h) or "4:56:04.25p" (friendly, 12h no leading zero). */
function clockStr(d: Date, frac: string, format: DateTimeFormat, showSeconds: boolean): string {
  if (format === 'friendly') {
    const h24 = d.getHours();
    const h12 = h24 % 12 || 12;
    const ampm = h24 < 12 ? 'a' : 'p';
    const mm = pad(d.getMinutes());
    return showSeconds ? `${h12}:${mm}:${pad(d.getSeconds())}${frac}${ampm}` : `${h12}:${mm}${ampm}`;
  }
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return showSeconds ? `${hh}:${mm}:${pad(d.getSeconds())}${frac}` : `${hh}:${mm}`;
}

const joinDateClock = (date: string, clock: string, format: DateTimeFormat): string =>
  format === 'friendly' ? `${date}, ${clock}` : `${date} ${clock}`;

/** Time of day: "16:56:04.25" (iso) or "4:56:04.25p" (friendly). */
export function formatTimeOfDay(start: Date, seconds: number, decimals = 2, format: DateTimeFormat = 'iso'): string {
  const { date, frac } = at(start, seconds, decimals);
  return clockStr(date, frac, format, true);
}

/** Full datetime: "2026-07-31 16:56:04.25" (iso) or "July 31, 4:56:04.25p" (friendly). */
export function formatDateTime(start: Date, seconds: number, decimals = 2, format: DateTimeFormat = 'iso'): string {
  const { date, frac } = at(start, seconds, decimals);
  return joinDateClock(dateStr(date, format), clockStr(date, frac, format, true), format);
}

/**
 * Render `sample` in `format` for a settings-panel preview — e.g.
 * "July 31, 4:56p" (friendly) or "2026-07-31 16:56" (iso). Minute resolution,
 * no seconds, matching how a ruler label at that granularity would read.
 */
export function previewDateTimeFormat(format: DateTimeFormat, sample: Date): string {
  return joinDateClock(dateStr(sample, format), clockStr(sample, '', format, false), format);
}

/**
 * Longest string formatDateTime can ever produce at `decimals` digits of
 * sub-second precision, for sizing a fixed-width field so no month/day/hour
 * combination it might actually show ever wraps onto a second line. Iso's
 * fields are all fixed-width zero-padded digits, so any date has the same
 * length; friendly's month name and day-of-month vary, so the sample pins
 * both to their widest (longest month name, a 2-digit day, a 2-digit 12-hour
 * hour).
 */
export function maxDateTimeLength(format: DateTimeFormat, decimals = 2): number {
  const longestMonth = MONTH_NAMES.reduce((a, b) => (b.length > a.length ? b : a));
  const sample = new Date(2026, MONTH_NAMES.indexOf(longestMonth), 20, 22, 58, 58);
  return formatDateTime(sample, 0, decimals, format).length;
}

/**
 * Seconds since local midnight for `date`. Used only to align ticks to the wall
 * clock, so the UTC epoch's own alignment doesn't leak in for non-hour-offset
 * timezones.
 */
const localSeconds = (date: Date): number => date.getTime() / 1000 - date.getTimezoneOffset() * 60;

/** Cap on ticks per frame — a runaway step/range combination can't hang the draw. */
const MAX_TICKS = 500;

/**
 * Track-relative times (seconds) of the ruler ticks in `[viewStart, viewEnd]`,
 * placed on wall-clock multiples of `step` rather than on multiples of `step`
 * from the file's start. That is what makes hour ticks land on the hour.
 */
export function datetimeTicks(start: Date, viewStart: number, viewEnd: number, step: number): number[] {
  if (!(step > 0) || !(viewEnd >= viewStart)) return [];
  const L = localSeconds(start);
  // Ticks are the s where (L + s) is a whole multiple of step.
  const phase = ((-L % step) + step) % step;
  const firstK = Math.ceil((viewStart - phase) / step);
  const ticks: number[] = [];
  for (let k = firstK; ticks.length < MAX_TICKS; k++) {
    const s = phase + k * step;
    if (s > viewEnd) break;
    ticks.push(s);
  }
  return ticks;
}

/** Decimal places a ruler label should carry at tick spacing `step`. */
const rulerDecimals = (step: number): number => (step < 1 ? 2 : 0);

/**
 * Label for a datetime ruler tick. Only the parts that changed since the
 * previous label are spelled out: the first label of the view carries the full
 * date, a label that crosses midnight carries month-day, and the rest are bare
 * clock times. `prev` is the previous tick's track-relative time, or null for
 * the first tick drawn.
 */
export function formatDatetimeRulerLabel(
  start: Date,
  seconds: number,
  prev: number | null,
  step: number,
  format: DateTimeFormat = 'iso',
): string {
  const decimals = rulerDecimals(step);
  const { date, frac } = at(start, seconds, decimals);
  const clock = clockStr(date, frac, format, step < 60);

  if (prev === null) return joinDateClock(dateStr(date, format), clock, format);
  const prevDate = at(start, prev, decimals).date;
  const sameDay = prevDate.getFullYear() === date.getFullYear()
    && prevDate.getMonth() === date.getMonth()
    && prevDate.getDate() === date.getDate();
  return sameDay ? clock : joinDateClock(monthDayStr(date, format), clock, format);
}

const MONTH_INDEX = new Map<string, number>();
MONTH_NAMES.forEach((name, i) => {
  MONTH_INDEX.set(name.toLowerCase(), i);
  MONTH_INDEX.set(name.slice(0, 3).toLowerCase(), i);
});

const to24Hour = (h12: number, ampm: string): number => {
  const h = h12 % 12;
  return ampm.toLowerCase().startsWith('p') ? h + 12 : h;
};

/**
 * Resolve a yearless month/day/time-of-day to an offset from `start`, picking
 * whichever of {start's year - 1, start's year, start's year + 1} lands the
 * result inside [0, duration] — mirroring the day-walk bare clock times get,
 * but at year granularity since the typed value carries no year at all.
 */
function resolveYearlessOffset(month: number, day: number, secondsOfDay: number, start: Date, duration: number): number {
  const startEpoch = start.getTime() / 1000;
  const forYear = (y: number): number => new Date(y, month, day, 0, 0, 0, 0).getTime() / 1000 + secondsOfDay - startEpoch;
  let offset = forYear(start.getFullYear());
  if (offset < 0) {
    const bumped = forYear(start.getFullYear() + 1);
    if (bumped <= duration) offset = bumped;
  } else if (offset > duration) {
    const bumped = forYear(start.getFullYear() - 1);
    if (bumped >= 0) offset = bumped;
  }
  return offset;
}

/** Walk a bare clock time forward a day at a time to the first occurrence that
 *  lands in [0, duration] — a day-granularity analogue of resolveYearlessOffset. */
function resolveClockOffset(h24: number, mi: number, sec: number, start: Date, duration: number): number {
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const base = startDay.getTime() / 1000 + h24 * 3600 + mi * 60 + sec;
  const offset = base - start.getTime() / 1000;
  const DAY = 86400;
  let best = offset;
  while (best < 0) best += DAY;
  while (best > duration && best - DAY >= 0) best -= DAY;
  return best;
}

/**
 * Parse a datetime the user typed into a time field, returning its offset in
 * seconds from `start`. Accepts either display style regardless of the
 * project's configured format — a full datetime ("2026-07-31 16:56:04.25" with
 * "/" or "T" separators, or "July 31, 4:56:04.25p"), or a bare clock time
 * ("16:56", "16:56:04", "4:56p"), which is resolved to whichever day puts it
 * inside [0, duration] — so on a 50-hour file, typing a clock time lands on
 * the occurrence that exists. The am/pm marker accepts either the short form
 * shown in friendly mode ("a"/"p") or the full word. Returns null if `raw`
 * isn't a datetime at all; callers then fall back to their elapsed-time parsers.
 */
export function parseDatetimeInput(raw: string, start: Date, duration: number): number | null {
  const s = raw.trim();

  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  if (full) {
    const [, y, mo, d, h, mi, sec] = full;
    const target = new Date(+y, +mo - 1, +d, +h, +mi, 0, 0).getTime() / 1000 + (sec ? parseFloat(sec) : 0);
    return target - start.getTime() / 1000;
  }

  const friendlyFull = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(am?|pm?)$/i);
  if (friendlyFull) {
    const [, monthName, d, h, mi, sec, ampm] = friendlyFull;
    const month = MONTH_INDEX.get(monthName.toLowerCase());
    if (month === undefined) return null;
    const h24 = to24Hour(+h, ampm);
    const secondsOfDay = h24 * 3600 + +mi * 60 + (sec ? parseFloat(sec) : 0);
    return resolveYearlessOffset(month, +d, secondsOfDay, start, duration);
  }

  const friendlyClock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(am?|pm?)$/i);
  if (friendlyClock) {
    const [, h, mi, sec, ampm] = friendlyClock;
    const h24 = to24Hour(+h, ampm);
    return resolveClockOffset(h24, +mi, sec ? parseFloat(sec) : 0, start, duration);
  }

  const clock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  if (!clock) return null;
  const [, h, mi, sec] = clock;
  return resolveClockOffset(+h, +mi, sec ? parseFloat(sec) : 0, start, duration);
}
