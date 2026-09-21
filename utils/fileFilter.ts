/**
 * The file panel's per-column filter: 'all' shows every track, 'annotated'
 * keeps tracks that HAVE the thing (annotations, or buzzdetect results), and
 * 'unannotated' keeps tracks that DON'T. The literals predate the buzzdetect
 * filter and stay as they are so saved project preferences keep working.
 */
export type FileFilter = 'all' | 'annotated' | 'unannotated';

/** Click order: neutral → has → doesn't have → neutral. */
export function nextFileFilter(f: FileFilter): FileFilter {
  return f === 'all' ? 'annotated' : f === 'annotated' ? 'unannotated' : 'all';
}

export function passesFileFilter(has: boolean, f: FileFilter): boolean {
  return f === 'all' ? true : f === 'annotated' ? has : !has;
}
