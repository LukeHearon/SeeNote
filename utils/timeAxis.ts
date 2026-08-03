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
 * ticks are chosen per kept span, at nice values of the span's own source time,
 * and placed at the display position that source time maps to. What the user
 * reads off the ruler is a position in the file they can go back to.
 *
 * Each span also gets a tick at its start, whatever value that is: a span can be
 * shorter than one tick step (a single detection often is) and would otherwise
 * carry no label at all, and the run's own start time in the file is the most
 * useful thing to label it with anyway.
 *
 * Ticks closer together than a label is wide are dropped, keeping the earlier
 * one — so a span start always wins over a nice tick beside it, and a stretch of
 * very short spans labels as many as fit rather than overprinting. Interior
 * ticks also keep clear of their span's END, where the next span's start label
 * will sit.
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
  const push = (disp: number, src: number) => {
    if (disp <= 0 || disp - last < minSpacing) return;
    out.push({ disp, src });
    last = disp;
  };

  for (const span of timeline.spansForDisplayRange(d0, d1)) {
    const len = span.srcEnd - span.srcStart;
    const dispEnd = span.dispStart + len;
    push(span.dispStart, span.srcStart);
    for (let s = Math.ceil(span.srcStart / step) * step; s < span.srcEnd; s += step) {
      const disp = span.dispStart + (s - span.srcStart);
      if (dispEnd - disp < minSpacing) break;
      push(disp, s);
    }
  }
  return out;
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
