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
//                    over the bin's frames clears that neuron's SUBSET
//                    threshold.
//   detectionRate   a bin is kept when the fraction of its frames where ANY
//                    subset neuron fires reaches `minDetectionRate`, where
//                    "fires" is the neuron's own DETECTION threshold.
//
// A neuron is part of the subset when it has an entry in `subsetThresholds` —
// the palette's "Subset at" box. In activation mode the value there is the
// threshold the cut is judged at, deliberately separate from the neuron's
// DETECTION threshold (which stays a statement about the graph: which dots draw
// filled, where the dashed line sits). Keeping the two apart is the point: a
// liberal cut keeps the audio around a detection in view while the graph still
// marks detections strictly, so the context of a call is audible without
// restating what counts as a call.
//
// In detectionRate mode there is no second threshold to set. The measurement is
// already "what fraction of this bin's frames were detections", so the only
// threshold in play is the one that decides what a detection IS, and the knob
// for how liberal the cut should be is `minDetectionRate`. An entry in
// `subsetThresholds` there records only the PICK; its value is ignored.
//
// Both are the same shape: aggregate each neuron over the bin, OR the neurons
// together. Multiple neurons are OR'd so "show me buzzes" means bee OR fly
// without running the subset twice.
//
// A kept bin's range is the bin's own nominal edges — `[b*binWidth,
// (b+1)*binWidth)` — not the extent of whatever frames happen to fall inside
// it. The bin is what was judged and what should be kept whole; frames merely
// happen to tile it (evenly if the width divides the frame hop, with a
// remainder at each edge otherwise), and trimming to their extent would keep
// a bin-sized DECISION but a frame-sized SELECTION.
//
// Those edges are then extended by the frame OVERHANG — how far `frameLength`
// exceeds `frameHop`, i.e. how far the bin's last frames reach past the bin.
// Overlapping frames (buzzdetect's `framelength 3, framehop 0.96`) are the
// only case where that's non-zero, and there it's the whole point: a frame at
// 2.88 speaks for audio out to 5.88, so keeping only to the bin's edge would
// cut away most of what the kept frame was reporting on. It also makes the
// frame length behave the way a user setting it expects — raising it widens
// every kept region, monotonically — where routing it into the bin width
// instead SHRANK the subset, by averaging each detection against the quiet
// frames it had just been grouped with.
//
// Bins are anchored to absolute file time (bucketFrameRange), matching how the
// panel partitions frames when it groups them (utils/binIndex's
// sourceBucketPieces) — so the subset always keeps or drops exactly the bins
// the user was looking at. With no override, the bin width falls back to the
// file's own frame HOP — never its frame length — so that a bin holds exactly
// one frame and this degenerates to per-frame behaviour, whatever the frame
// length happens to be.
//
// Finally, a BUFFER (seconds, zero by default) is added to each side of every
// kept bin — context around the detection, so what's kept is audible as the
// thing it is rather than as a clipped fragment. It widens the cut without
// changing what counted as a detection.
//
// Contiguous kept bins are merged into one span by buildSubsetTimeline, so a
// run of detections reads (and can be selected) as a single stretch of audio
// rather than a chain of bin-sized pieces — and so buffers that overlap their
// neighbours produce one span rather than a chain of padded ones.

import { BuzzdetectData, BuzzdetectSeriesMode } from '../types';
import { DEFAULT_BUZZDETECT_THRESHOLD } from '../constants';
import { bucketFrameRange } from './binIndex';
import { buildAnyOverThresholdPrefix, buildPrefixSum, rangeMean, rangeSum } from './prefixSums';
import { Timeline, buildSubsetTimeline, identityTimeline } from './subsetTimeline';

export interface SubsetCriteria {
  /** Neuron labels the subset is keyed to. Empty means "no subset". */
  neurons: readonly string[];
  mode: BuzzdetectSeriesMode;
  /**
   * The threshold a bin is judged against, per neuron: its "Subset at" value in
   * activation mode, its detection threshold in detectionRate mode (where the
   * rate, not a second threshold, is what loosens the cut).
   */
  thresholdOf: (neuron: string) => number;
  /** Minimum fraction of a bin's frames that must fire. detectionRate mode only. */
  minDetectionRate: number;
  /**
   * Bin width (seconds) a bin is judged over, in EITHER mode. The panel's own
   * auto bin width changes with zoom, which would silently redefine the subset
   * every time the user zoomed — so this is the PINNED width only, falling
   * back to the file's frame hop (where a bin is just one frame).
   */
  binWidth: number;
  /**
   * Seconds of context added to EACH side of every kept bin. Zero by default,
   * and always zero outside activation mode — see subsetCriteriaFrom.
   * A detection is rarely the whole of the thing that produced it, and the
   * moments either side are what make it identifiable by ear — so this widens
   * what the cut keeps without touching what counts as a detection. Overlapping
   * buffers merge into one span (buildSubsetTimeline), so a run of near-misses
   * reads as one stretch rather than a chain of padded pieces.
   */
  buffer: number;
}

/** The panel/window state a subset is derived from. */
export interface SubsetInputs {
  /** The master toggle. False builds no criteria at all. */
  enabled: boolean;
  /**
   * Per-neuron subset thresholds — the "Subset at" box in the palette. A
   * neuron with an entry here is a neuron the subset is keyed to; the map's
   * keys ARE the picked neurons, so there is no separate list that could
   * disagree with the thresholds. Empty means "no subset". Picks are OR'd.
   */
  subsetThresholds: Record<string, number>;
  /** Per-neuron detection thresholds — what the cut is judged at in detectionRate mode. */
  thresholds: Record<string, number>;
  /**
   * The neuron labels THIS file's results actually contain, or null when no
   * results are loaded. Picks are saved per project and keyed by label, so a
   * track scored by a different model carries picks naming columns it doesn't
   * have — and a cut keyed only to those would match nothing and blank the
   * track. Picks not in this list are ignored (never deleted: the same project
   * may hold tracks from both models, and going back should restore them).
   */
  availableNeurons: readonly string[] | null;
  mode: BuzzdetectSeriesMode;
  minDetectionRate: number;
  /** User-pinned bin width (seconds), or null for auto. */
  binWidthOverride: number | null;
  /** The file's own frame hop — what an unpinned bin width falls back to. */
  frameHop: number;
  /** Seconds of context kept either side of each kept bin. */
  buffer: number;
}

/**
 * The picked neurons that this file's results actually have a column for, in
 * the order the picks were made. Exported so the palette can mark the picks
 * that aren't cutting here — nothing should silently ignore a setting the user
 * can see without saying so.
 *
 * `available === null` means no results are loaded, so nothing is cutting.
 */
export function pickedNeuronsIn(
  subsetThresholds: Record<string, number>,
  available: readonly string[] | null,
): string[] {
  if (!available) return [];
  const have = new Set(available);
  return Object.keys(subsetThresholds).filter(n => have.has(n));
}

/**
 * The criteria a subset is keyed to, or null when it's off — null is what makes
 * every downstream path run the whole-file case unchanged.
 *
 * Shared by the annotation window and the guide's live example panel so the
 * demo subsets by exactly the rule the real thing does.
 */
export function subsetCriteriaFrom(inputs: SubsetInputs): SubsetCriteria | null {
  const neurons = pickedNeuronsIn(inputs.subsetThresholds, inputs.availableNeurons);
  if (!inputs.enabled || neurons.length === 0) return null;
  return {
    neurons,
    mode: inputs.mode,
    // Activation mode judges the cut at the Subset at value — the whole reason
    // it's a separate number from the detection threshold. A detection RATE
    // already counts frames that ARE detections, so there the only threshold
    // that means anything is the one defining a detection, and the pick's
    // stored value is ignored.
    thresholdOf: (n: string) => (
      inputs.mode === 'activation'
        ? inputs.subsetThresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD
        : inputs.thresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD
    ),
    minDetectionRate: inputs.minDetectionRate,
    // Padding a kept region is a statement about a frame's surroundings, and
    // that only reads straight when the thing kept is the frame — activation
    // mode with its per-frame bins. A detection rate is deliberately a summary
    // over a whole bin the user sized themselves; widening it by some other
    // amount would blur the boundary they set.
    buffer: inputs.mode === 'activation' ? Math.max(0, inputs.buffer) : 0,
    // The panel's auto bin width follows the zoom, so subsetting by it would
    // redefine the subset every time the view moved. Only a pinned width
    // counts; without one the rate is measured per frame, where it's just the
    // frame's own 0 or 1 and detection-rate mode agrees with activation mode.
    // The fallback is the HOP: frame length is about how much audio a frame
    // covers, not about how the frames get grouped for judging.
    binWidth: inputs.binWidthOverride ?? inputs.frameHop,
  };
}

/**
 * Source-time ranges to keep, ascending by start. Adjacent ranges are left
 * adjacent, and overlapping ones (which frame overhang can produce) are left
 * overlapping — merging them into spans is buildSubsetTimeline's job.
 */
export function detectionRanges(
  data: BuzzdetectData,
  criteria: SubsetCriteria,
): { start: number; end: number }[] {
  const { starts, frameLength, frameHop, neurons, values } = data;
  const picked = criteria.neurons
    .map(n => neurons.indexOf(n))
    .filter(i => i >= 0);
  if (picked.length === 0 || starts.length === 0) return [];

  const thresholds = picked.map(i => criteria.thresholdOf(neurons[i]));

  // Whole bins, of the pinned width (never narrower than the file's own frame
  // spacing — a mean or a rate over less than one frame means nothing).
  const bin = Math.max(criteria.binWidth, frameHop);
  // How far the last frames in a bin reach past its far edge. Zero unless the
  // frames overlap; see the header note.
  const overhang = Math.max(0, frameLength - frameHop);
  // Context either side of a kept bin. Ranges may run negative or past EOF
  // here; buildSubsetTimeline clamps them to the file and merges the overlaps
  // this creates between neighbouring detections.
  const buffer = Math.max(0, criteria.buffer);

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
    if (keep) out.push({ start: b * bin - buffer, end: binEnd + overhang + buffer });
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
    frameLength: data.frameLength,
    frameHop: data.frameHop,
    neurons: data.neurons,
    starts: keptIdx.map(i => timeline.toDisplay(data.starts[i])),
    values: data.values.map(v => keptIdx.map(i => v[i])),
  };
}
