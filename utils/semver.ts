export type VersionBumpType = 'major' | 'minor' | 'patch';

/** Classifies how `newVersion` differs from `currentVersion` in major.minor.patch terms.
 * Falls back to 'patch' if either string isn't parseable as major.minor.patch. */
export function versionBumpType(currentVersion: string, newVersion: string): VersionBumpType {
  const current = currentVersion.split('.').map(Number);
  const next = newVersion.split('.').map(Number);
  if (current.length !== 3 || next.length !== 3 || current.some(Number.isNaN) || next.some(Number.isNaN)) {
    return 'patch';
  }
  if (next[0] !== current[0]) return 'major';
  if (next[1] !== current[1]) return 'minor';
  return 'patch';
}
