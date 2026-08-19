import { Annotation, LoadedAnnotations } from '../types';
import { writeTextFile } from './tauriCommands';
import { generateAudacityContent } from './helpers';

/**
 * The single write decision for an annotation file. Both the debounced autosave
 * and the pre-sync flush go through here so the two paths cannot disagree.
 *
 * A track with no annotations is written as an EMPTY FILE — it is never deleted.
 * The three on-disk states each mean one thing, and the app only ever produces
 * the first two:
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
 */
export async function persistAnnotations(
  annotPath: string,
  annotations: Annotation[],
  decimals: number,
): Promise<'written' | 'cleared'> {
  if (annotations.length === 0) {
    await writeTextFile(annotPath, '');
    return 'cleared';
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
