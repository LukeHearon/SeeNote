// Deriving a subset timeline from buzzdetect results.
//
// Subset mode keeps only the time where the neurons the user picked actually
// fired. What counts as "fired" follows the panel's current series mode, so the
// subset always means the same thing as what the panel is drawing:
//
//   activation      a frame is kept when ANY subset neuron's activation clears
//                   its own threshold. The unit is one frame.
//   detectionRate   frames are grouped into bins of the panel's pinned bin
//                   width, and a whole bin is kept when the fraction of its
//                   frames that fired reaches `minDetectionRate`. The unit is
//                   one bin.
//
// Multiple neurons are OR'd: a frame fires if any of them does. That's what lets
// "show me buzzes" mean bee OR fly without running the subset twice.
//
// Contiguous kept frames are merged into one span by buildSubsetTimeline, so a
// run of detections reads (and can be selected) as a single stretch of audio
// rather than a chain of frame-sized pieces.

import { BuzzdetectData, BuzzdetectSeriesMode } from '../types';
import { bucketFrameRange } from './binIndex';
import { Timeline, buildSubsetTimeline, identityTimeline } from './subsetTimeline';

export interface SubsetCriteria {
  /** Neuron labels the subset is keyed to. Empty means "no subset". */
  neurons: readonly string[];
  mode: BuzzdetectSeriesMode;
  /** Per-neuron threshold lookup, same one the panel plots against. */
  thresholdOf: (neuron: string) => number;
  /** Minimum fraction of a bin's frames that must fire. detectionRate mode only. */
  minDetectionRate: number;
  /**
   * Bin width (seconds) the detection rate is measured over. The panel's own
   * auto bin width changes with zoom, which would silently redefine the subset
   * every time the user zoomed — so this is the PINNED width only, falling back
   * to the file's frame length (where a rate is just the frame's own 0 or 1).
   */
  binWidth: number;
}

/**
 * Source-time ranges to keep, in ascending order. Adjacent ranges are left
 * adjacent — merging them into spans is buildSubsetTimeline's job.
 */
export function detectionRanges(
  data: BuzzdetectData,
  criteria: SubsetCriteria,
): { start: number; end: number }[] {
  const { starts, binWidth: frameLength, neurons, values } = data;
  const picked = criteria.neurons
    .map(n => neurons.indexOf(n))
    .filter(i => i >= 0);
  if (picked.length === 0 || starts.length === 0) return [];

  const thresholds = picked.map(i => criteria.thresholdOf(neurons[i]));
  const fires = (frame: number): boolean => {
    for (let k = 0; k < picked.length; k++) {
      if (values[picked[k]][frame] >= thresholds[k]) return true;
    }
    return false;
  };

  const out: { start: number; end: number }[] = [];

  if (criteria.mode === 'activation') {
    for (let i = 0; i < starts.length; i++) {
      if (fires(i)) out.push({ start: starts[i], end: starts[i] + frameLength });
    }
    return out;
  }

  // detectionRate: whole bins, kept on the rate of their own frames. Bins are
  // anchored to absolute time (bucketFrameRange), matching how the panel
  // partitions frames when it groups them — so the bins the subset keeps are the
  // bins the user was looking at.
  const bin = Math.max(criteria.binWidth, frameLength);
  const minRate = criteria.minDetectionRate;
  const firstBin = Math.floor(starts[0] / bin);
  const lastBin = Math.floor(starts[starts.length - 1] / bin);
  for (let b = firstBin; b <= lastBin; b++) {
    const r = bucketFrameRange(starts, bin, b);
    if (!r) continue;
    let hits = 0;
    for (let i = r.start; i <= r.end; i++) if (fires(i)) hits++;
    const rate = hits / (r.end - r.start + 1);
    // `>=` so a minimum of 0 keeps every bin holding frames, and a minimum of 1
    // keeps only bins where every frame fired.
    if (rate >= minRate) {
      // The frames' own extent, not the bin's: a bin can reach past the last
      // frame that starts inside it, and that tail is time no frame covers.
      out.push({ start: starts[r.start], end: starts[r.end] + frameLength });
    }
  }
  return out;
}

/**
 * The timeline for the current subset criteria, or the identity timeline when
 * subsetting is off / nothing is selected / there's no data to subset by.
 */
export function subsetTimelineFor(
  data: BuzzdetectData | null,
  criteria: SubsetCriteria | null,
  sourceDuration: number,
): Timeline {
  if (!data || !criteria || criteria.neurons.length === 0) return identityTimeline(sourceDuration);
  return buildSubsetTimeline(detectionRanges(data, criteria), sourceDuration);
}

/**
 * The activations re-expressed on the display axis: only frames the timeline
 * keeps, with their starts moved to where they now sit on screen. Feeding this
 * to the panel is what makes it draw the subset — it needs no knowledge of
 * subsetting at all, because from its point of view this simply IS the data.
 *
 * Returns `data` unchanged for the identity timeline (no copy, no allocation on
 * the common path).
 */
export function subsetBuzzdetectData(
  data: BuzzdetectData | null,
  timeline: Timeline,
): BuzzdetectData | null {
  if (!data || timeline.identity) return data;
  const keptIdx: number[] = [];
  for (let i = 0; i < data.starts.length; i++) {
    if (timeline.isKept(data.starts[i])) keptIdx.push(i);
  }
  return {
    binWidth: data.binWidth,
    neurons: data.neurons,
    starts: keptIdx.map(i => timeline.toDisplay(data.starts[i])),
    values: data.values.map(v => keptIdx.map(i => v[i])),
  };
}
