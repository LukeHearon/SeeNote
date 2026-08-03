// Deriving a subset timeline from buzzdetect results.
//
// Subset mode keeps whole BINS of the panel's pinned bin width — never
// individual frames — because that's the granularity the user is choosing
// when they set a bin width and a threshold: "keep the 2s stretches where
// [criterion] holds", not "keep whatever frames happen to clear it". What
// "holds" means follows the panel's current series mode, so the subset always
// means the same thing as what the panel is drawing:
//
//   activation      a bin is kept when ANY subset neuron's MEAN activation
//                    over the bin's frames clears its own threshold.
//   detectionRate   a bin is kept when the fraction of its frames where ANY
//                    subset neuron fires reaches `minDetectionRate`.
//
// Both are the same shape: aggregate each neuron over the bin, OR the neurons
// together. Multiple neurons are OR'd so "show me buzzes" means bee OR fly
// without running the subset twice.
//
// A kept bin's range is the bin's own nominal edges — `[b*binWidth,
// (b+1)*binWidth)` — not the extent of whatever frames happen to fall inside
// it. The bin is what was judged and what should be kept whole; frames merely
// happen to tile it (evenly if the width divides the frame spacing, with a
// remainder at each edge otherwise), and trimming to their extent would keep
// a bin-sized DECISION but a frame-sized SELECTION.
//
// Bins are anchored to absolute file time (bucketFrameRange), matching how the
// panel partitions frames when it groups them (utils/binIndex's
// sourceBucketPieces) — so the subset always keeps or drops exactly the bins
// the user was looking at. With no override, the bin width falls back to the
// file's own frame length, where a bin IS a frame and this degenerates to the
// old per-frame behaviour exactly.
//
// Contiguous kept bins are merged into one span by buildSubsetTimeline, so a
// run of detections reads (and can be selected) as a single stretch of audio
// rather than a chain of bin-sized pieces.

import { BuzzdetectData, BuzzdetectSeriesMode } from '../types';
import { DEFAULT_BUZZDETECT_THRESHOLD } from '../constants';
import { bucketFrameRange } from './binIndex';
import { buildAnyOverThresholdPrefix, buildPrefixSum, rangeMean, rangeSum } from './prefixSums';
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
   * Bin width (seconds) a bin is judged over, in EITHER mode. The panel's own
   * auto bin width changes with zoom, which would silently redefine the subset
   * every time the user zoomed — so this is the PINNED width only, falling
   * back to the file's frame length (where a bin is just one frame).
   */
  binWidth: number;
}

/** The panel/window state a subset is derived from. */
export interface SubsetInputs {
  /** The master toggle. False builds no criteria at all. */
  enabled: boolean;
  /** Neuron labels ticked to subset by (OR'd). Empty means "no subset". */
  neurons: readonly string[];
  mode: BuzzdetectSeriesMode;
  /** Per-neuron threshold overrides, as the panel stores them. */
  thresholds: Record<string, number>;
  minDetectionRate: number;
  /** User-pinned bin width (seconds), or null for auto. */
  binWidthOverride: number | null;
  /** The file's own frame length — what an unpinned width falls back to. */
  frameLength: number;
}

/**
 * The criteria a subset is keyed to, or null when it's off — null is what makes
 * every downstream path run the whole-file case unchanged.
 *
 * Shared by the annotation window and the guide's live example panel so the
 * demo subsets by exactly the rule the real thing does.
 */
export function subsetCriteriaFrom(inputs: SubsetInputs): SubsetCriteria | null {
  if (!inputs.enabled || inputs.neurons.length === 0) return null;
  return {
    neurons: inputs.neurons,
    mode: inputs.mode,
    thresholdOf: (n: string) => inputs.thresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD,
    minDetectionRate: inputs.minDetectionRate,
    // The panel's auto bin width follows the zoom, so subsetting by it would
    // redefine the subset every time the view moved. Only a pinned width
    // counts; without one the rate is measured per frame, where it's just the
    // frame's own 0 or 1 and detection-rate mode agrees with activation mode.
    binWidth: inputs.binWidthOverride ?? inputs.frameLength,
  };
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

  // Whole bins, of the pinned width (never narrower than the file's own frame
  // spacing — a mean or a rate over less than one frame means nothing).
  const bin = Math.max(criteria.binWidth, frameLength);

  // Per-neuron mean-activation prefix sums (activation mode), or one shared
  // "did any picked neuron fire this frame" prefix (detectionRate mode) — built
  // once up front rather than scanned per bin, same prefix-sum approach the
  // panel itself uses for these aggregates.
  const meanPrefixes = criteria.mode === 'activation'
    ? picked.map(i => buildPrefixSum(values[i]))
    : null;
  const anyFiredPrefix = criteria.mode === 'detectionRate'
    ? buildAnyOverThresholdPrefix(picked.map((i, k) => ({ values: values[i], threshold: thresholds[k] })), starts.length)
    : null;

  // One forward walk over the frames rather than a binary search per bin
  // (`bucketFrameRange`). Same partition — frames are ascending, so consecutive
  // frames below a bin's upper edge ARE that bin's frames — but linear in the
  // frames instead of B·log F in the bins, and it never visits an empty bin. On
  // a 50h file at the native frame length that's 187k bins, and the searches
  // were most of what the user waits through when engaging the subset.
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < starts.length) {
    // The bin edges are the MULTIPLIED ones (`b*bin`), matching how the panel
    // partitions the same grid (binIndex's frameStartRangeIn) — `starts[i]/bin`
    // is only the guess, corrected against the real edges. The two disagree by a
    // float ulp exactly at a boundary, which is the common case when the bin
    // width IS the frame length: every frame sits on one.
    let b = Math.floor(starts[i] / bin);
    if (starts[i] < b * bin) b--;
    else if (starts[i] >= (b + 1) * bin) b++;
    const binEnd = (b + 1) * bin;
    let end = i;
    while (end + 1 < starts.length && starts[end + 1] < binEnd) end++;
    const keep = meanPrefixes
      ? meanPrefixes.some((p, k) => rangeMean(p, i, end) >= thresholds[k])
      // `>=` so a minimum of 0 keeps every bin holding frames, and a minimum
      // of 1 keeps only bins where every frame fired.
      : rangeSum(anyFiredPrefix!, i, end) / (end - i + 1) >= criteria.minDetectionRate;
    if (keep) out.push({ start: b * bin, end: binEnd });
    i = end + 1;
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
