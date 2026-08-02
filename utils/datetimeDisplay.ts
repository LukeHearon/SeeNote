// Wall-clock (datetime) rendering of track times.
//
// When a track's filename yields a start time (see utils/filenameTime.ts), every
// time readout can be shown as a real datetime instead of an offset. All of
// this works in the machine's local timezone, and assumes the UTC offset in
// force at the file's start applies for its whole length — a recording that
// spans a DST boundary will read an hour off after the transition.

const pad = (v: number, width = 2): string => String(v).padStart(width, '0');

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

const dateStr = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthDayStr = (d: Date): string => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Time of day, 24-hour: "16:56:04.25". */
export function formatTimeOfDay(start: Date, seconds: number, decimals = 2): string {
  const { date, frac } = at(start, seconds, decimals);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${frac}`;
}

/** Full datetime: "2026-07-31 16:56:04.25". */
export function formatDateTime(start: Date, seconds: number, decimals = 2): string {
  const { date, frac } = at(start, seconds, decimals);
  return `${dateStr(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${frac}`;
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
): string {
  const decimals = rulerDecimals(step);
  const { date, frac } = at(start, seconds, decimals);
  const clock = step >= 60
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${frac}`;

  if (prev === null) return `${dateStr(date)} ${clock}`;
  const prevDate = at(start, prev, decimals).date;
  const sameDay = prevDate.getFullYear() === date.getFullYear()
    && prevDate.getMonth() === date.getMonth()
    && prevDate.getDate() === date.getDate();
  return sameDay ? clock : `${monthDayStr(date)} ${clock}`;
}

/**
 * Parse a datetime the user typed into a time field, returning its offset in
 * seconds from `start`. Accepts a full datetime ("2026-07-31 16:56:04.25",
 * with "/" or "T" separators too) or a bare clock time ("16:56", "16:56:04"),
 * which is resolved to whichever day puts it inside [0, duration] — so on a
 * 50-hour file, typing a clock time lands on the occurrence that exists.
 * Returns null if `raw` isn't a datetime at all; callers then fall back to
 * their elapsed-time parsers.
 */
export function parseDatetimeInput(raw: string, start: Date, duration: number): number | null {
  const s = raw.trim();

  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  if (full) {
    const [, y, mo, d, h, mi, sec] = full;
    const target = new Date(+y, +mo - 1, +d, +h, +mi, 0, 0).getTime() / 1000 + (sec ? parseFloat(sec) : 0);
    return target - start.getTime() / 1000;
  }

  const clock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/);
  if (!clock) return null;
  const [, h, mi, sec] = clock;
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const base = startDay.getTime() / 1000 + +h * 3600 + +mi * 60 + (sec ? parseFloat(sec) : 0);
  const offset = base - start.getTime() / 1000;
  // Walk forward a day at a time to the first occurrence that lands in the file.
  const DAY = 86400;
  let best = offset;
  while (best < 0) best += DAY;
  while (best > duration && best - DAY >= 0) best -= DAY;
  return best;
}
