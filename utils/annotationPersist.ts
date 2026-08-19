import { Annotation, LoadedAnnotations } from '../types';
import { writeTextFile, removeFile } from './tauriCommands';
import { generateAudacityContent } from './helpers';

// The single write-or-delete decision for an annotation file: a non-empty list
// is written, an empty list removes the file — a 0-byte annotation file is
// never a valid on-disk state. Both the debounced autosave and the pre-sync
// flush must go through here so the two paths cannot disagree (a flush that
// wrote "" where the autosave would have deleted is how truncated annotation
// files ended up committed and pushed).
export async function persistAnnotations(
  annotPath: string,
  annotations: Annotation[],
  decimals: number,
): Promise<'written' | 'removed'> {
  if (annotations.length === 0) {
    await removeFile(annotPath);
    return 'removed';
  }
  await writeTextFile(annotPath, generateAudacityContent(annotations, decimals));
  return 'written';
}

/**
 * Decide what — if anything — a flush is allowed to write to disk, from ONE
 * read of the persistence snapshot.
 *
 * `loaded` pairs a track with that track's annotations (see LoadedAnnotations).
 * Taking the path and the list from the same value is the whole point: when
 * they came from two separately-updated refs, a flush landing between "track
 * armed" and "list mirrored" paired a real track with the empty placeholder
 * left by a track switch — and because an empty list *removes* the file, that
 * silently deleted annotated recordings and pushed the deletion to the team.
 *
 * Returns null (write nothing) when:
 *  - no track is hydrated yet (mid-load, or right after a track switch), or
 *  - the hydrated track is no longer the open one — the user has moved on and
 *    this list is not what is on screen, or
 *  - the track has no resolvable annotation path.
 *
 * An empty `annotations` on a returned target is a genuine, user-authored empty
 * state, so `persistAnnotations` deleting the file for it is correct.
 */
export function resolveFlushTarget(
  loaded: LoadedAnnotations | null,
  openTrackPath: string | null,
  getAnnotationPath: (trackFilePath: string) => string | null,
): { annotPath: string; annotations: Annotation[] } | null {
  if (!loaded) return null;
  if (!openTrackPath || loaded.trackPath !== openTrackPath) return null;
  const annotPath = getAnnotationPath(loaded.trackPath);
  if (!annotPath) return null;
  return { annotPath, annotations: loaded.annotations };
}
