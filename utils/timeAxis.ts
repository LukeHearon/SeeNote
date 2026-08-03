// Shared time-ruler helpers for spectrogram X-axes. Used by both the main
// scrolling Spectrogram and the static ExampleSpectrogram so tick spacing and
// label formatting stay identical (no duplicated cascade).

import type { Timeline } from './subsetTimeline';

// Candidate tick spacings (seconds), ascending. Extends well past an hour
// because labels now show hours (e.g. "35h36m00s") — a fixed viewSpan
// threshold cascade doesn't account for how much wider that makes each
// label, so ticks must be chosen by the actual pixel gap instead.
const NICE_TIME_STEPS = [
  0.25, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 14400, 21600, 28800, 43200,
  86400, 172800, 259200, 604800,
];

// Widest label we render is like "123h59m59s" in bold 12px sans-serif.
const MIN_LABEL_SPACING_PX = 85;

/**
 * Pick a "nice" tick spacing (seconds) such that consecutive tick labels
 * have enough pixel space between them not to overlap, given `pixelsPerSecond`.
 */
export function chooseTimeStep(pixelsPerSecond: number): number {
  for (const step of NICE_TIME_STEPS) {
    if (step * pixelsPerSecond >= MIN_LABEL_SPACING_PX) return step;
  }
  return NICE_TIME_STEPS[NICE_TIME_STEPS.length - 1];
}

/**
 * Format a ruler label for time `s` (seconds). `viewSpan` decides whether to
 * show hours; `timeStep` decides sub-second vs minute formatting.
 */
export function formatRulerTime(s: number, timeStep: number, viewSpan: number): string {
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
 * overprinting.
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
): RulerTick[] {
  const out: RulerTick[] = [];
  if (!(step > 0)) return out;

  if (timeline.identity) {
    for (let s = Math.floor(d0 / step) * step; s <= d1; s += step) {
      if (s > 0) out.push({ disp: s, src: s });
    }
    return out;
  }

  const minSpacing = pixelsPerSecond > 0 ? MIN_LABEL_SPACING_PX / pixelsPerSecond : 0;
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
