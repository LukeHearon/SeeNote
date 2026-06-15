// Shared time-ruler helpers for spectrogram X-axes. Used by both the main
// scrolling Spectrogram and the static ExampleSpectrogram so tick spacing and
// label formatting stay identical (no duplicated cascade).

/**
 * Pick a "nice" tick spacing (seconds) for a visible span of `viewSpan`
 * seconds. Thresholds mirror the original inline cascade in Spectrogram.tsx.
 */
export function chooseTimeStep(viewSpan: number): number {
  if (viewSpan > 36000) return 3600;
  if (viewSpan > 7200) return 600;
  if (viewSpan > 1200) return 120;
  if (viewSpan > 300) return 60;
  if (viewSpan > 60) return 10;
  if (viewSpan > 30) return 5;
  if (viewSpan > 10) return 2;
  if (viewSpan > 2) return 1;
  return 0.25;
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

  const showHours = viewSpan >= 3600;

  if (showHours) {
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  } else if (totalSec >= 60 || timeStep >= 60) {
    return `${m}m${String(sec).padStart(2, '0')}s`;
  } else {
    return `${sec}s`;
  }
}
