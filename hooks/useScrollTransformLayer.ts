import { useCallback, useLayoutEffect, useRef } from 'react';
import type React from 'react';
import type { ScrollSyncHub } from '../utils/scrollSyncHub';

/**
 * Makes one HTML overlay layer scroll on the rAF clock instead of on React
 * commits (see `utils/scrollSyncHub.ts` for why).
 *
 * The layer lays its children out in content pixels — `time * pixelsPerSecond`,
 * no scroll term — attaches the returned `ref`/`style` to its wrapper element,
 * and this hook translates that wrapper once per frame from Spectrogram's rAF
 * loop. `onSync` is for the leftovers that genuinely depend on the scroll
 * position (edge pinning, cull windows); it runs in the same frame.
 *
 * The registration effect deliberately has no dep array: it re-runs after every
 * render so a fresh commit is re-synced immediately rather than a frame later.
 */
export function useScrollTransformLayer(
  hub: ScrollSyncHub,
  scrollLeftRef: React.MutableRefObject<number>,
  onSync?: (scrollLeft: number) => void,
): { ref: React.RefObject<HTMLDivElement>; style: React.CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  const lastScrollRef = useRef(NaN);
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  const sync = useCallback((scrollLeft: number, force = false) => {
    if (!force && scrollLeft === lastScrollRef.current) return;
    lastScrollRef.current = scrollLeft;
    const el = ref.current;
    if (el) el.style.transform = `translate3d(${-scrollLeft}px, 0, 0)`;
    onSyncRef.current?.(scrollLeft);
  }, []);

  useLayoutEffect(() => {
    const unregister = hub.register(sync);
    sync(scrollLeftRef.current, true);
    return unregister;
  });

  return {
    ref,
    // First paint (before the layout effect runs) already sits in the right place.
    style: { transform: `translate3d(${-scrollLeftRef.current}px, 0, 0)`, willChange: 'transform' },
  };
}
