import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { MultiTierSpectrogramCache } from '../MultiTierSpectrogramCache';

/**
 * Re-renders the window when the chunk cache it holds in a ref has been
 * swapped, and not otherwise.
 *
 * The cache lives in a ref (it's mutable machinery, not state), so putting a
 * new one there tells React nothing; `Spectrogram` takes it as a prop and needs
 * a render to see it. `bumpCacheVersion` is that nudge, coalesced to at most one
 * React update per animation frame.
 *
 * It is also handed to the cache as its `onChunkLoaded`, which fires per
 * arriving chunk — hundreds of times while a viewport over a long file
 * resolves. Those calls must NOT re-render the window: the renderer subscribes
 * to the cache itself (MultiTierSpectrogramCache.subscribe) and marks its own
 * draw dirty, so an arrival costs one boolean write. They are told apart from a
 * swap by the cache identity: a nudge only schedules a render if the cache in
 * the ref differs from the one the last render handed down.
 *
 * Returns a stable `bumpCacheVersion` so it can be handed to the cache
 * constructor without re-creating the cache.
 */
export function useChunkCacheVersion(
  chunkCacheRef: MutableRefObject<MultiTierSpectrogramCache | null>,
): { bumpCacheVersion: () => void } {
  const [, setVersion] = useState(0);
  const frameRef = useRef<number | null>(null);
  // The cache as of the last render of the owning component.
  const renderedRef = useRef(chunkCacheRef.current);
  renderedRef.current = chunkCacheRef.current;

  const bumpCacheVersion = useCallback(() => {
    if (chunkCacheRef.current === renderedRef.current) return; // nothing new to hand down
    if (frameRef.current !== null) return; // already scheduled for this frame
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setVersion(v => v + 1);
    });
  }, [chunkCacheRef]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  return { bumpCacheVersion };
}
