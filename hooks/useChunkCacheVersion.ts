import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Version counter for the spectrogram chunk cache, coalesced to at most one
 * React update per animation frame.
 *
 * MultiTierSpectrogramCache calls `onChunkLoaded` once per arriving chunk. A
 * single viewport over a long file resolves hundreds of chunks, and an
 * unbatched setState per chunk re-renders the whole annotation window (and
 * re-runs the renderer's per-column dirty scan) that many times — while the
 * chunk fetches it is competing with are what the user is actually waiting for.
 *
 * Nothing downstream reads the counter's *value*; the renderer only compares it
 * against the version its last dirty-fill ran at, to answer "did chunk data
 * arrive since?". Collapsing several arrivals in one frame into a single bump
 * therefore loses no information — the frame's scan sees all of them.
 *
 * Returns a stable `bump` so it can be handed to the cache constructor without
 * re-creating the cache.
 */
export function useChunkCacheVersion(): {
  cacheVersion: number;
  bumpCacheVersion: () => void;
} {
  const [cacheVersion, setCacheVersion] = useState(0);
  const frameRef = useRef<number | null>(null);

  const bumpCacheVersion = useCallback(() => {
    if (frameRef.current !== null) return; // already scheduled for this frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setCacheVersion(v => v + 1);
    });
  }, []);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  return { cacheVersion, bumpCacheVersion };
}
