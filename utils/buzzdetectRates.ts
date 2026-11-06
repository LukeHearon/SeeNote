// Detection-rate extents for the buzzdetect panel's Y axis: how high each
// neuron's rate gets in a span at a given bin width, and a tidy axis ceiling
// over the plotted ones.

import type { Timeline } from './subsetTimeline';
import { forEachUnitInSpan, type FrameGrid } from './binIndex';
import { rangeMean } from './prefixSums';

/**
 * Each neuron's highest detection rate over the units of `unitWidth` touching
 * the display span [t0, t1) — the same units the panel draws (bins cut at
 * subset seams, or single frames when ungrouped). Only the neurons in
 * `neurons` are measured; every other entry, and any neuron with no valid
 * frame in the span, is 0.
 */
export function maxUnitRates(
  timeline: Timeline,
  grid: FrameGrid,
  unitWidth: number,
  t0: number,
  t1: number,
  neurons: readonly number[],
  detectionPrefix: readonly Float64Array[],
  validCountPrefix: readonly Float64Array[] | null,
): number[] {
  const out = detectionPrefix.map(() => 0);
  forEachUnitInSpan(timeline, grid, unitWidth, t0, t1, u => {
    // The walk pads a bucket either side of the span; only units actually
    // reaching into it count.
    if (u.tEnd <= t0 || u.tStart >= t1) return;
    for (const n of neurons) {
      const r = rangeMean(detectionPrefix[n], u.start, u.end, validCountPrefix?.[n]);
      if (r > out[n]) out[n] = r;
    }
  });
  return out;
}

// Mantissas an axis ceiling may land on. Each splits into four ticks that read
// cleanly as percentages (e.g. 0.1 → 2.5%, 5%, 7.5%, 10%).
const NICE_STEPS = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
// Room above the highest point, so the peak doesn't sit on the axis's top edge.
const HEADROOM = 1.05;

/**
 * A round Y-axis ceiling just above `maxRate` (a 0–1 fraction): 0.08 → 0.1,
 * 0.5 → 0.6. Never above 1 (a rate can't exceed it); 1 when there's nothing
 * above zero to fit.
 */
export function niceRateCeiling(maxRate: number): number {
  if (!(maxRate > 0)) return 1;
  const target = maxRate * HEADROOM;
  if (target >= 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const m = target / mag;
  const step = NICE_STEPS.find(s => s >= m - 1e-9) ?? 10;
  return Math.min(1, +(step * mag).toPrecision(6));
}

/** A rate as a percentage label, to as many places as it needs (2.5%, 10%). */
export function formatRatePercent(v: number): string {
  return `${+(v * 100).toFixed(2)}%`;
}
