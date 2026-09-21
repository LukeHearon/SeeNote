import { stripExt } from './helpers';

const stripTrailingSep = (p: string) => p.replace(/[\\/]+$/, '');

/** Path of `file` under `root`, '/'-separated, or null if it isn't under it. */
function relUnder(root: string, file: string): string | null {
  const r = stripTrailingSep(root);
  if (!file.startsWith(r) || (file[r.length] !== '/' && file[r.length] !== '\\')) return null;
  return file.substring(r.length + 1).replace(/\\/g, '/');
}

/** A track's ident: its path under the media root without extension, '/'-separated. */
export function trackIdent(trackPath: string, mediaRoot: string): string | null {
  const rel = relUnder(mediaRoot, trackPath);
  return rel === null ? null : stripExt(rel);
}

/**
 * Which tracks have a result file (an annotation file, a buzzdetect CSV, ...)
 * in `resultFiles`. A result file belongs to the track whose ident equals its
 * path under `resultRoot` minus one of `suffixes` — the same rule the readers
 * use to go the other way (`{resultRoot}/{ident}{suffix}`).
 */
export function tracksWithResults(
  tracks: string[],
  mediaRoot: string,
  resultRoot: string,
  resultFiles: string[],
  suffixes: string[],
): Set<string> {
  const byIdent = new Map<string, string>();
  for (const t of tracks) {
    const id = trackIdent(t, mediaRoot);
    if (id !== null) byIdent.set(id, t);
  }
  const found = new Set<string>();
  for (const f of resultFiles) {
    const rel = relUnder(resultRoot, f);
    if (rel === null) continue;
    const suffix = suffixes.find(s => rel.endsWith(s));
    if (!suffix) continue;
    const track = byIdent.get(rel.slice(0, rel.length - suffix.length));
    if (track) found.add(track);
  }
  return found;
}
