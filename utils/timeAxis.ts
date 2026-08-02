// Shared time-ruler helpers for spectrogram X-axes. Used by both the main
// scrolling Spectrogram and the static ExampleSpectrogram so tick spacing and
// label formatting stay identical (no duplicated cascade).

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
