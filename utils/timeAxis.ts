// Shared time-ruler helpers for spectrogram X-axes. Used by both the main
// scrolling Spectrogram and the static ExampleSpectrogram so tick spacing and
// label formatting stay identical (no duplicated cascade).

import type { Timeline } from './subsetTimeline';

// Candidate tick spacings (seconds), ascending. Extends well past an hour
// because labels now show hours (e.g. "35h36m00s") — a fixed viewSpan
// threshold cascade doesn't account for how much wider that makes each
// label, so ticks must be chosen by the actual pixel gap instead.
import { parseDatetimeInput } from './datetimeDisplay';
import { formatGrouped } from './numberFormat';

const NICE_TIME_STEPS = [
  0.25, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 14400, 21600, 28800, 43200,
  86400, 172800, 259200, 604800,
];

// Widest label we render is like "123h59m59s" in bold 12px sans-serif.
const MIN_LABEL_SPACING_PX = 85;

// Datetime labels are wider — the leftmost one spells out a full date
// ("2026-01-01 23:00"), so ticks have to be spread further apart.
export const DATETIME_LABEL_SPACING_PX = 145;

/**
 * Pick a "nice" tick spacing (seconds) such that consecutive tick labels
 * have enough pixel space between them not to overlap, given `pixelsPerSecond`.
 * `minSpacingPx` sizes that gap to how wide the labels actually are.
 */
export function chooseTimeStep(pixelsPerSecond: number, minSpacingPx: number = MIN_LABEL_SPACING_PX): number {
  for (const step of NICE_TIME_STEPS) {
    if (step * pixelsPerSecond >= minSpacingPx) return step;
  }
  return NICE_TIME_STEPS[NICE_TIME_STEPS.length - 1];
}

/**
 * Format a ruler label for time `s` (seconds). `viewSpan` decides whether to
 * show hours; `timeStep` decides sub-second vs minute formatting. `plain`
 * (set when the project's time-display unit is "Seconds") skips the h/m/s
 * cascade entirely and reads as a bare second count, matching the running
 * time readout's Seconds mode instead of switching formats between the two.
 */
export function formatRulerTime(s: number, timeStep: number, viewSpan: number, plain: boolean = false): string {
  if (plain) {
    // Cached formatter: this runs once per visible tick inside the spectrogram's
    // rAF loop, where toLocaleString's per-call Intl construction dominates.
    return `${formatGrouped(Math.round(s))}s`;
  }
  if (timeStep < 1) {
    return `${s.toFixed(2)}s`;
  }
  const totalSec = Math.round(s);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;

  const showHours = viewSpan >= 3600 || totalSec >= 3600;

  if (showHours) {
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  } else if (totalSec >= 60 || timeStep >= 60) {
    return `${m}m${String(sec).padStart(2, '0')}s`;
  } else {
    return `${sec}s`;
  }
}

/** One ruler tick: where it sits on screen, and the time it is labelled with. */
export interface RulerTick {
  /** Display time (seconds) — where the tick is drawn. */
  disp: number;
  /** Source time (seconds) — what the label reads. */
  src: number;
}

/**
 * The ticks for the display range [d0, d1], labelled in SOURCE time.
 *
 * A ruler exists to answer "where in the file am I?", and under a subset the
 * display axis can't answer that — its 0 is wherever the first kept run happens
 * to start, and every later position is short by however much was cut out. So
 * under a subset there is exactly one tick per kept span, at its start: a nice
 * mid-span tick would sit centered over a stretch of screen it doesn't actually
 * label the START of (see `rulerTickAlign`), which is what made it easy to
 * misread as spanning into the next segment. A span-start tick has no such
 * ambiguity — everything to its right, up to the next cut, is that span's time.
 *
 * Ticks closer together than a label is wide are dropped, keeping the earlier
 * one, so a stretch of very short spans labels as many as fit rather than
 * overprinting. `minSpacingPx` is how wide "a label" is — wall-clock labels are
 * wider than elapsed-time ones, so the ruler passes its own value.
 *
 * For the identity timeline (no subset) this is just nice ticks across the
 * range, labelled with themselves — the pre-subset behaviour exactly.
 */
export function rulerTicks(
  timeline: Timeline,
  d0: number,
  d1: number,
  step: number,
  pixelsPerSecond: number,
  minSpacingPx: number = MIN_LABEL_SPACING_PX,
): RulerTick[] {
  const out: RulerTick[] = [];
  if (!(step > 0)) return out;

  if (timeline.identity) {
    for (let s = Math.floor(d0 / step) * step; s <= d1; s += step) {
      if (s > 0) out.push({ disp: s, src: s });
    }
    return out;
  }

  const minSpacing = pixelsPerSecond > 0 ? minSpacingPx / pixelsPerSecond : 0;
  let last = -Infinity;
  for (const span of timeline.spansForDisplayRange(d0, d1)) {
    if (span.dispStart <= 0 || span.dispStart - last < minSpacing) continue;
    out.push({ disp: span.dispStart, src: span.srcStart });
    last = span.dispStart;
  }
  return out;
}

/**
 * Whether ruler labels at `disp` positions should be left-aligned (the start of
 * the region they describe) rather than centered on the tick. Subset ticks each
 * mark where a segment BEGINS — not a point straddled on both sides by that
 * segment's own time — so centering would read as if the label applied to the
 * segment on both sides of the tick, when only the segment to its right does.
 */
export function rulerLabelAlign(timeline: Timeline): 'left' | 'center' {
  return timeline.identity ? 'center' : 'left';
}

/**
 * Inverse of formatRulerTime's "1h15m00s" style labels. Accepts any subset of
 * the h/m/s components ("1h10m", "1h10s", "0h3m01s", "45s"), each optional but
 * at least one required, with an optional leading "-" (for selDur, which can
 * be negative). Returns null if `raw` isn't in this form — callers fall back
 * to plain-seconds/colon parsing for those.
 */
export function parseHMS(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^(-)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!m) return null;
  const [, neg, h, mi, sec] = m;
  if (h === undefined && mi === undefined && sec === undefined) return null;
  const total = parseFloat(h ?? '0') * 3600 + parseFloat(mi ?? '0') * 60 + parseFloat(sec ?? '0');
  return neg ? -total : total;
}

/**
 * Parse a timestamp a user typed into a time field, in seconds.
 *
 * Accepts, in this order: `hh:mm:ss(.ff)`, `mm:ss(.ff)`, h/m/s shorthand
 * (see parseHMS), and plain seconds. Returns null for anything else, and for
 * negatives — the one field that allows a negative value (selection duration)
 * parses with parseHMS directly rather than going through here.
 *
 * Shared by every time field so the accepted formats can't drift between the
 * toolbar and the copy of it embedded in the help guide.
 *
 * `datetime` puts the field in wall-clock mode: a datetime or bare clock time
 * is tried first and returned as an offset from the track's start, so "1:23"
 * means twenty-three past one rather than 83 seconds in. Everything above
 * still parses, so elapsed-time input keeps working in datetime mode.
 */
export function parseTimestamp(
  raw: string,
  datetime?: { start: Date; duration: number } | null,
): number | null {
  const s = raw.trim();
  if (datetime) {
    const asDatetime = parseDatetimeInput(s, datetime.start, datetime.duration);
    if (asDatetime !== null) return asDatetime;
  }
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (hms) return parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseFloat(hms[3]);
  const ms = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (ms) return parseInt(ms[1]) * 60 + parseFloat(ms[2]);
  const shorthand = parseHMS(s);
  if (shorthand !== null && shorthand >= 0) return shorthand;
  // Anchored, so a string that merely *starts* with a number is rejected rather
  // than silently truncated — bare parseFloat turns "1:2:3:4" into 1, which used
  // to seek to one second instead of refusing a malformed timestamp.
  if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);
  return null;
}
