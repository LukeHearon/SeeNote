import { MediaScan, scanMediaTree } from './tauriCommands';

/** How long to wait between partial-result updates, given how many media files
 *  have been found. Rebuilding the file tree is O(files), so the gap grows with
 *  the list: ~1s when small, ~3s around 200k files. */
export function partialUpdateDelayMs(mediaCount: number): number {
  return 1000 + mediaCount / 100;
}

/**
 * Scan a media directory, reporting throttled partial results while it runs.
 * Resolves with the final lists, or null if a newer scan superseded this one.
 * Partial lists arrive in discovery (breadth-first) order, not sorted.
 */
export async function scanMediaDirectory(
  root: string,
  onPartial: (partial: MediaScan) => void,
): Promise<MediaScan | null> {
  const acc: MediaScan = { media: [], nonMedia: [] };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastEmit = 0;

  const emit = () => {
    timer = null;
    lastEmit = Date.now();
    onPartial({ media: acc.media.slice(), nonMedia: acc.nonMedia.slice() });
  };

  try {
    return await scanMediaTree(root, batch => {
      // push in a loop: spreading a 5000+ element batch into push() is fine,
      // but the loop avoids any argument-count limits on huge flat folders.
      for (const f of batch.media) acc.media.push(f);
      for (const f of batch.nonMedia) acc.nonMedia.push(f);
      if (timer === null) {
        const wait = lastEmit + partialUpdateDelayMs(acc.media.length) - Date.now();
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
