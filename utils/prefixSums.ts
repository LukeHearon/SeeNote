// Prefix sums over per-frame buzzdetect series.
//
// The panel repeatedly needs aggregates over an index range: the mean
// activation in a polyline bucket, the fraction of a bucket's frames clearing a
// threshold, the average over the current selection, "does this pixel column
// contain an undetected frame". Scanning for each of those is O(range) and the
// ranges get large fast — a 10h recording at the native 0.96s hop is ~37.5k
// frames, and the buckets a wide bin-width override produces can span hours.
//
// Prefix sums make every one of those a subtraction. They're built once per
// data (or per threshold/enabled-set change, both rare user actions) and held
// in Float64Array so the per-frame cost is a typed-array read.
//
// Convention throughout: `prefix[k]` is the total over frames [0, k), so
// `prefix` has length `frameCount + 1` and an INCLUSIVE range [start, end]
// resolves to `prefix[end + 1] - prefix[start]`.

/**
 * Cumulative sums of `values`. Length is `values.length + 1`. A missing frame
 * (`NaN` — see `BuzzdetectData`) contributes 0 rather than poisoning every
 * later prefix entry with NaN; pair with `buildValidCountPrefix` so a range's
 * mean divides by how many frames actually had a value, not the range width.
 */
export function buildPrefixSum(values: readonly number[]): Float64Array {
  const out = new Float64Array(values.length + 1);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i])) acc += values[i];
    out[i + 1] = acc;
  }
  return out;
}

/** Cumulative count of non-missing (`!Number.isNaN`) entries. Length is
 *  `values.length + 1`. Pair with `buildPrefixSum` to average over only the
 *  frames that actually had a value. */
export function buildValidCountPrefix(values: readonly number[]): Float64Array {
  const out = new Float64Array(values.length + 1);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i])) acc++;
    out[i + 1] = acc;
  }
  return out;
}

/** Cumulative count of entries `>= threshold`. Length is `values.length + 1`. */
export function buildThresholdCountPrefix(
  values: readonly number[],
  threshold: number,
): Float64Array {
  const out = new Float64Array(values.length + 1);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= threshold) acc++;
    out[i + 1] = acc;
  }
  return out;
}

/**
 * Cumulative count of frames where AT LEAST ONE of `series` clears its own
 * threshold — the per-frame "detected" predicate the darken pass tests. This
 * can't be derived from the per-neuron counts (an OR isn't a sum), so it gets
 * its own prefix, rebuilt when thresholds or the enabled set change.
 */
export function buildAnyOverThresholdPrefix(
  series: readonly { values: readonly number[]; threshold: number }[],
  frameCount: number,
): Float64Array {
  const out = new Float64Array(frameCount + 1);
  let acc = 0;
  for (let i = 0; i < frameCount; i++) {
    let any = false;
    for (const s of series) {
      if (s.values[i] >= s.threshold) { any = true; break; }
    }
    if (any) acc++;
    out[i + 1] = acc;
  }
  return out;
}

/** Total over the INCLUSIVE index range [start, end]; 0 for an inverted range. */
export function rangeSum(prefix: Float64Array, start: number, end: number): number {
  if (end < start) return 0;
  return prefix[end + 1] - prefix[start];
}

/**
 * Mean over the INCLUSIVE index range [start, end]; 0 for an inverted range.
 * Pass `validCountPrefix` (from `buildValidCountPrefix` on the same source
 * values) to divide by how many frames in the range actually had a value
 * instead of the range's width, so missing frames don't drag the average
 * toward 0. A range whose frames are ALL missing then has nothing to average
 * and reads as `NaN` rather than 0 — a real 0 would misrepresent "no data" as
 * a measured value — which callers should treat the same as a missing single
 * frame (skip it rather than plotting it).
 */
export function rangeMean(
  prefix: Float64Array,
  start: number,
  end: number,
  validCountPrefix?: Float64Array,
): number {
  if (end < start) return 0;
  if (!validCountPrefix) return (prefix[end + 1] - prefix[start]) / (end - start + 1);
  const count = rangeSum(validCountPrefix, start, end);
  return count > 0 ? (prefix[end + 1] - prefix[start]) / count : NaN;
}
