/**
 * buzzdetect writes `buzzdetect_manifest.json` at the root of every results
 * folder. Among the settings that lock that folder's schema, it records the
 * model's suggested per-class detection thresholds (`thresholds`, keyed by class
 * name, absent when the model suggests none). Those are what prefill the
 * palette's **Detection at** boxes.
 */

export const BUZZDETECT_MANIFEST = 'buzzdetect_manifest.json';

/**
 * The manifest's thresholds, keyed by neuron label as the panel shows it: the
 * bare class name, or `activation_<class>` when the project keeps that prefix.
 * Anything unreadable — bad JSON, no `thresholds`, a non-numeric value — is
 * left out rather than guessed at.
 */
export function manifestThresholds(text: string, trimActivationPrefix: boolean): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const raw = (parsed as { thresholds?: unknown } | null)?.thresholds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [cls, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[trimActivationPrefix ? cls : `activation_${cls}`] = value;
  }
  return out;
}

/**
 * Fill in a threshold for every neuron the user hasn't touched. An entry that
 * exists — a value, or null for a deliberately cleared one — is the user's and
 * stays. Returns `current` itself when there's nothing to add, so a state setter
 * given it doesn't re-render, and the names it filled.
 */
export function prefillThresholds(
  current: Record<string, number | null>,
  suggested: Record<string, number>,
): { thresholds: Record<string, number | null>; filled: string[] } {
  const filled = Object.keys(suggested).filter(n => !(n in current));
  if (filled.length === 0) return { thresholds: current, filled };
  const thresholds = { ...current };
  for (const n of filled) thresholds[n] = suggested[n];
  return { thresholds, filled };
}
