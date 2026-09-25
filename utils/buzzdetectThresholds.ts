import { defaultBuzzdetectThreshold } from '../constants';

/**
 * What a neuron's detection threshold comes to, as a number every comparison
 * in the graph and the subset can be written against.
 *
 * Three states live in one map (`buzzdetectThresholds`), and they're distinct:
 *
 *   absent  — never set, so the default applies (see defaultBuzzdetectThreshold).
 *   number  — set to that value.
 *   null    — deliberately cleared: this neuron never registers a detection.
 *
 * The cleared case is Infinity, which is exactly "no activation ever reaches
 * it" in the units the comparisons already use, so no call site needs a branch.
 * Drawing code that puts the threshold somewhere on screen (the dashed line,
 * the auto Y-range) does need one — check `isFinite` there.
 */
export function detectionThreshold(value: number | null | undefined, neuron: string): number {
  if (value === undefined) return defaultBuzzdetectThreshold(neuron);
  return value ?? Infinity;
}

/**
 * How far a neuron's line is shifted down when the graph is adjusted to
 * baseline: by its own detection threshold, so every neuron's threshold lands
 * on 0 and lines from models that run hotter or colder than each other sit
 * against one another. A neuron with no threshold has nothing to align to and
 * stays where it is.
 */
export function baselineOffset(threshold: number, adjusted: boolean): number {
  return adjusted && isFinite(threshold) ? threshold : 0;
}
