import { FrequencyScale } from '../types';

// Mel Scale helpers
export const toMel = (f: number) => 2595 * Math.log10(1 + f / 700);
export const fromMel = (m: number) => 700 * (Math.pow(10, m / 2595) - 1);

// Frequency ↔ Y-coordinate helpers.
// Convention: y=0 is TOP (maxFreq), y=canvasHeight is BOTTOM (minFreq).
// For 'log' scale, minFreq is clamped to 1 to avoid log(0).
export const yToFreq = (
  y: number,
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale
): number => {
  const normY = 1 - (y / canvasHeight);
  if (scale === 'linear') {
    return minFreq + (normY * (maxFreq - minFreq));
  } else if (scale === 'log') {
    const safeMinFreq = Math.max(minFreq, 1);
    return safeMinFreq * Math.pow(maxFreq / safeMinFreq, normY);
  } else {
    const minM = toMel(minFreq);
    const maxM = toMel(maxFreq);
    const targetM = minM + (normY * (maxM - minM));
    return fromMel(targetM);
  }
};

export const freqToY = (
  freq: number,
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale
): number => {
  let normY = 0;
  if (scale === 'linear') {
    normY = (freq - minFreq) / (maxFreq - minFreq);
  } else if (scale === 'log') {
    const safeMinFreq = Math.max(minFreq, 1);
    normY = Math.log(freq / safeMinFreq) / Math.log(maxFreq / safeMinFreq);
  } else {
    const minM = toMel(minFreq);
    const maxM = toMel(maxFreq);
    normY = (toMel(freq) - minM) / (maxM - minM);
  }
  return canvasHeight * (1 - normY);
};

/**
 * The band-pass band's top and bottom edges in canvas pixels. Shared by the
 * filter overlay (which draws the band) and the selection overlay (whose centre
 * mark sits inside the band when there is one).
 */
export const bandExtentY = (
  band: { low: number; high: number },
  canvasHeight: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale
): { yTop: number; yBottom: number } => ({
  yTop: freqToY(band.high, canvasHeight, minFreq, maxFreq, scale),
  yBottom: freqToY(band.low, canvasHeight, minFreq, maxFreq, scale),
});

/**
 * Frequency values (Hz) at which to draw Y-axis ticks for the given display
 * range and scale. Shared by the main Spectrogram and ExampleSpectrogram so
 * both axes pick the same ticks. Drawing/label-spacing is left to the caller.
 */
export const freqAxisTicks = (
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale,
): number[] => {
  const ticks: number[] = [];
  if (scale === 'log') {
    let mag = 10;
    while (mag < maxFreq) {
      for (const mult of [1, 2, 5]) {
        const freq = mag * mult;
        if (freq >= minFreq && freq <= maxFreq) ticks.push(freq);
      }
      mag *= 10;
    }
  } else {
    const range = maxFreq - minFreq;
    if (range > 0) {
      const roughStep = range / 8;
      const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
      let step = magnitude;
      if (roughStep / step > 5) step *= 5;
      else if (roughStep / step > 2) step *= 2;
      const firstTick = Math.ceil(minFreq / step) * step;
      for (let freq = firstTick; freq <= maxFreq; freq += step) ticks.push(freq);
    }
  }
  return ticks;
};

/** Smallest span (Hz) the display range is allowed to collapse to. */
export const MIN_FREQ_SPAN = 100;

/**
 * Clamp a proposed frequency display range to sane bounds: min ≥ 0, max ≤
 * nyquist, and at least MIN_FREQ_SPAN between them. `edited` says which edge
 * the user just changed, so the *other* edge is the one pushed to keep the
 * span. Shared by the axis-docked number boxes and the settings panel.
 */
export const clampFreqRange = (
  minFreq: number,
  maxFreq: number,
  nyquist: number,
  edited: 'min' | 'max',
): { minFreq: number; maxFreq: number } => {
  let lo = Number.isFinite(minFreq) ? Math.max(0, Math.round(minFreq)) : 0;
  let hi = Number.isFinite(maxFreq) ? Math.min(nyquist, Math.round(maxFreq)) : nyquist;
  if (edited === 'min') {
    lo = Math.min(lo, nyquist - MIN_FREQ_SPAN);
    if (hi - lo < MIN_FREQ_SPAN) hi = Math.min(nyquist, lo + MIN_FREQ_SPAN);
  } else {
    hi = Math.max(hi, MIN_FREQ_SPAN);
    if (hi - lo < MIN_FREQ_SPAN) lo = Math.max(0, hi - MIN_FREQ_SPAN);
  }
  return { minFreq: lo, maxFreq: hi };
};

/**
 * Frequency (Hz) → axis label: 6000 → "6k", 5500 → "5.5k", 800 → "800".
 * Shared by the Y-axis tick renderer and the axis-docked frequency boxes so
 * both read the same way.
 */
export const formatFreqHz = (hz: number): string =>
  hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : String(Math.round(hz));

/**
 * Parse a frequency the way it's written on the axis: a plain number ("8000")
 * or a k-suffixed one ("8k", "5.5k", "8 K"). Returns NaN for anything else.
 */
export const parseFreqHz = (text: string): number => {
  const m = text.trim().toLowerCase().match(/^(\d*\.?\d+)\s*(k)?$/);
  if (!m) return NaN;
  return parseFloat(m[1]) * (m[2] ? 1000 : 1);
};
