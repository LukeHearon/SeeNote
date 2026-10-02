import { Annotation, LoadedAnnotations } from '../types';
import { writeTextFile, checkFileExists, readTextFile } from './tauriCommands';
import { setMergeAnnotations } from './projectCommands';
import { generateAudacityContent, isPersistableAnnotation, parseAudacityContent } from './helpers';

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
export function persistAnnotations(
  annotPath: string,
  annotations: Annotation[],
  decimals: number,
): Promise<'written' | 'cleared'> {
  return enqueueWrite(async () => {
    // Unnamed (blank-label) boxes never reach disk — see isPersistableAnnotation.
    // Filtering here as well as in generateAudacityContent is what keeps a list of
    // nothing but unnamed boxes from taking the 'written' path and creating an
    // empty file, which on disk would read as "the user cleared this track".
    const content = annotationFileContent(annotations, decimals);
    try {
      if (content === '') {
        if (await checkFileExists(annotPath)) await writeTextFile(annotPath, '');
        noteWritten(annotPath, content);
        return 'cleared' as const;
      }
      await writeTextFile(annotPath, content);
      noteWritten(annotPath, content);
      return 'written' as const;
    } catch (err) {
      // Unknown what is on disk now; forget what we thought it was.
      knownDiskContent.delete(annotPath);
      throw err;
    }
  });
}

/** The file content a list persists as: '' when nothing in it is persistable. */
export function annotationFileContent(annotations: Annotation[], decimals: number): string {
  const persistable = annotations.filter(isPersistableAnnotation);
  return persistable.length === 0 ? '' : generateAudacityContent(persistable, decimals);
}

// Every disk write goes through one queue, in call order. The autosave, the
// pre-sync flush, the post-pull merge write-back and the unmount flush can
// overlap; with independent awaits their IPC calls could land out of order and
// leave an older list on disk.
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(fn);
  writeChain = result.catch(() => {});
  return result;
}

/** Resolves once every write queued so far has landed (or failed). */
export function whenWritesSettled(): Promise<void> {
  return writeChain.then(() => {});
}

// What each loaded track's file is known to hold, as `annotationFileContent`
// would write it. Seeded when a track is read (rememberDiskContent) and kept
// current by every write through persistAnnotations. Only seeded paths are
// tracked, and few of them: it exists to answer "is this write a no-op?" and
// "what did this file hold when we last synced with it?" for the open track.
const knownDiskContent = new Map<string, string>();
const KNOWN_CAP = 8;

export function rememberDiskContent(annotPath: string, content: string): void {
  knownDiskContent.delete(annotPath);
  knownDiskContent.set(annotPath, content);
  if (knownDiskContent.size > KNOWN_CAP) {
    const oldest = knownDiskContent.keys().next().value;
    if (oldest !== undefined) knownDiskContent.delete(oldest);
  }
}

export function recallDiskContent(annotPath: string): string | undefined {
  return knownDiskContent.get(annotPath);
}

function noteWritten(annotPath: string, content: string): void {
  if (knownDiskContent.has(annotPath)) knownDiskContent.set(annotPath, content);
}

/**
 * persistAnnotations, skipped when the list serialises to what the file is
 * already known to hold. Replaces a time-based "don't save for 500ms after a
 * load" guard, which also swallowed real edits made inside that window: this
 * only ever skips a write that would change nothing.
 */
export async function persistAnnotationsIfChanged(
  annotPath: string,
  annotations: Annotation[],
  decimals: number,
): Promise<'written' | 'cleared' | 'unchanged'> {
  if (knownDiskContent.get(annotPath) === annotationFileContent(annotations, decimals)) return 'unchanged';
  return persistAnnotations(annotPath, annotations, decimals);
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

/**
 * Persist a list the user is leaving behind (unmount, window close) when the
 * file may have changed since we last wrote or read it — a pull finished, but
 * the reload that would have merged it never will. Three-way-merges against
 * the last known content instead of overwriting, the same way the reload does.
 */
export async function persistMergedWithDisk(
  annotPath: string,
  annotations: Annotation[],
  decimals: number,
): Promise<void> {
  const ancestor = recallDiskContent(annotPath);
  const disk = (await readTextFile(annotPath)) ?? '';
  if (ancestor === undefined || disk === ancestor) {
    await persistAnnotations(annotPath, annotations, decimals);
    return;
  }
  const merged = await setMergeAnnotations(ancestor, annotationFileContent(annotations, decimals), disk);
  await persistAnnotations(annotPath, merged ? parseAudacityContent(merged, []) : [], decimals);
}
