import type { Project, ProjectPreferences } from '../types';

/** Signature of the project store's preference writer: callers pass only the keys they own. */
export type UpdateProjectPreferences = (id: string, patch: Partial<ProjectPreferences>) => Promise<Project | undefined>;

/**
 * Apply a preferences patch to the LATEST stored preferences. Callers pass only
 * the keys they own: every writer used to spread its own (possibly stale)
 * `project.preferences`, so two debounced writers racing each other restored
 * each other's old values.
 *
 * `uiSettings` merges one level deep, so a writer that owns only some UI fields
 * doesn't wipe the rest. A key set to `undefined` is dropped on serialisation,
 * which is how a caller clears an optional preference.
 */
export function applyPreferencesPatch(
  latest: ProjectPreferences,
  patch: Partial<ProjectPreferences>,
): ProjectPreferences {
  const merged: ProjectPreferences = { ...latest, ...patch };
  if (patch.uiSettings) merged.uiSettings = { ...latest.uiSettings, ...patch.uiSettings };
  return merged;
}

/**
 * The keys of `after` whose value differs from `before` (structural compare).
 * For callers that edit a whole preferences object (the settings modal) but
 * must not overwrite keys the user never touched there.
 */
export function preferencesPatch(
  before: ProjectPreferences,
  after: ProjectPreferences,
): Partial<ProjectPreferences> {
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = (before as Record<string, unknown>)[k];
    const a = (after as Record<string, unknown>)[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    // uiSettings is patched one level deep (see applyPreferencesPatch), so send
    // only its changed fields: the rest of the caller's copy may be stale.
    patch[k] = k === 'uiSettings' && a && b
      ? preferencesPatch(b as ProjectPreferences, a as ProjectPreferences)
      : a;
  }
  return patch as Partial<ProjectPreferences>;
}
