// Loudness normalization for example-clip previews. Example clips vary wildly
// in level (some near-silent, some hot); previewing them at a comparable
// loudness avoids blowing out the listener's ears. Shared by the chip preview
// player and the example-library modal so both normalize identically.

/** Target peak amplitude (≈ -3 dBFS). Normalized clips peak here. */
export const NORMALIZE_TARGET_PEAK = 0.7;

/** Cap on the boost applied, so a near-silent clip doesn't amplify its noise
 *  floor into a roar. */
export const MAX_NORMALIZE_GAIN = 8;

/**
 * Gain to multiply playback by so a clip with the given peak amplitude reaches
 * NORMALIZE_TARGET_PEAK, clamped to [0, MAX_NORMALIZE_GAIN]. Returns 1 for an
 * unusable peak (non-finite, ≤0, or so tiny it's effectively silence).
 */
export function normalizationGain(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 1e-4) return 1;
  return Math.min(MAX_NORMALIZE_GAIN, NORMALIZE_TARGET_PEAK / peak);
}
