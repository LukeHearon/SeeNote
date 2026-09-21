import { ANNOTATION_FILE_EXT } from '../constants';
import { DirScan, ScanSpec, scanTree } from './tauriCommands';

export const MEDIA_SCAN: ScanSpec = { kind: 'media' };
export const ANNOTATION_SCAN: ScanSpec = { kind: 'suffixes', suffixes: [`.${ANNOTATION_FILE_EXT}`] };
/** buzzdetect writes `_buzzpart.csv` while a run is in progress and renames it
 *  to `_buzzdetect.csv` when done; the reader accepts either. */
export const BUZZDETECT_SUFFIXES = ['_buzzdetect.csv', '_buzzpart.csv'];
export const BUZZDETECT_SCAN: ScanSpec = { kind: 'suffixes', suffixes: BUZZDETECT_SUFFIXES };

/** How long to wait between partial-result updates, given how many files have
 *  been found. Applying a partial list is O(files) downstream (tree rebuild,
 *  presence mapping), so the gap grows with the list: ~1s when small, ~3s
 *  around 200k files. */
export function partialUpdateDelayMs(fileCount: number): number {
  return 1000 + fileCount / 100;
}

/**
 * Scan a directory, reporting throttled partial results while it runs.
 * Resolves with the final lists, or null if a newer scan superseded this one.
 * Partial lists arrive in discovery (breadth-first) order, not sorted.
 */
export async function scanDirectory(
  root: string,
  spec: ScanSpec,
  onPartial: (partial: DirScan) => void,
): Promise<DirScan | null> {
  const acc: DirScan = { files: [], others: [] };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;

  const emit = () => {
    timer = null;
    lastEmit = Date.now();
    onPartial({ files: acc.files.slice(), others: acc.others.slice() });
  };

  try {
    return await scanTree(root, spec, batch => {
      // Loop rather than push(...batch): a huge flat folder makes one huge batch.
      for (const f of batch.files) acc.files.push(f);
      for (const f of batch.others) acc.others.push(f);
      if (timer === null) {
        const wait = lastEmit + partialUpdateDelayMs(acc.files.length) - Date.now();
        timer = setTimeout(emit, Math.max(0, wait));
      }
    });
  } catch (err) {
    if (String(err) === 'superseded') return null;
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
