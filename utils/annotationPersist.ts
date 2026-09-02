import { Annotation, LoadedAnnotations } from '../types';
import { writeTextFile, checkFileExists } from './tauriCommands';
import { generateAudacityContent, isPersistableAnnotation } from './helpers';

/**
 * The single write decision for an annotation file. Both the debounced autosave
 * and the pre-sync flush go through here so the two paths cannot disagree.
 *
 * Clearing a track's annotations writes an EMPTY FILE — the file is never
 * deleted. The three on-disk states each mean one thing:
 *   - has records  -> the track's annotations
 *   - exists, empty -> the user deliberately cleared the track
 *   - absent        -> unknown; the sync layer treats it as no information
 *
 * This app used to delete the file instead. That made "cleared by the user" and
 * "removed by a bug" the same thing on disk, so a bug that wrongly believed a
 * track was empty deleted real annotations and the sync propagated it to the
 * whole team. Never removing files means an accident can no longer be spelled
 * as an intent. (Committing the empty file is still gated on confirmation —
 * see stage_and_commit in git_sync/repo.rs.)
 *
 * The flip side of that: an empty list only *clears* when there is something to
 * clear. If no file exists, an empty list is the never-annotated state and this
 * writes nothing — creating the file would spell "the user cleared this track"
 * on disk for a track they only opened, and would commit a file per visited
 * track to everyone else's checkout.
 */
export async function persistAnnotations(
  annotPath: string,
  annotations: Annotation[],
  decimals: number,
): Promise<'written' | 'cleared'> {
  // Unnamed (blank-label) boxes never reach disk — see isPersistableAnnotation.
  // Filtering here as well as in generateAudacityContent is what keeps a list of
  // nothing but unnamed boxes from taking the 'written' path and creating an
  // empty file, which on disk would read as "the user cleared this track".
  const persistable = annotations.filter(isPersistableAnnotation);
  if (persistable.length === 0) {
    if (await checkFileExists(annotPath)) await writeTextFile(annotPath, '');
    return 'cleared';
  }
  await writeTextFile(annotPath, generateAudacityContent(persistable, decimals));
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
