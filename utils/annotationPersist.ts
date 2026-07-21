import { Annotation } from '../types';
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
