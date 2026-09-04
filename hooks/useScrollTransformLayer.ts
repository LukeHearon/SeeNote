import { useCallback, useLayoutEffect, useRef } from 'react';
import type React from 'react';
import type { ScrollSyncHub } from '../utils/scrollSyncHub';

/**
 * The zoom a layer's children are currently laid out at, versus the live zoom
 * the canvases are drawing at.
 *
 * A zoom action writes `pixelsPerSecondRef` and the scroll ref synchronously,
 * so the canvas is at the new zoom on the very next frame; the layers' own
 * `pixelsPerSecond` prop only arrives on the next React commit. A single mouse
 * notch commits before the frame paints, so nothing shows — but a trackpad
 * pinch fires wheel events faster than React commits, and for those frames the
 * children sat at the OLD pixels-per-second while the layer was already
 * translated by the NEW scroll. Every box is then off by
 * `time * (livePps - layoutPps)`, snapping back when the commit lands: the
 * annotations jiggling back and forth during a pinch.
 *
 * Giving the wrapper a matching `scaleX` maps the stale layout onto the live
 * one exactly, so the layer stays with the canvas until React catches up. The
 * factor is 1 (no scale written) in every steady state.
 */
export interface ContentScale {
  /** Live pixels-per-second — written synchronously by the zoom actions. */
  livePpsRef: React.MutableRefObject<number>;
  /** The pixels-per-second this layer's children were laid out at. */
  layoutPps: number;
}

const scaleOf = (contentScale?: ContentScale): number => {
  if (!contentScale) return 1;
  const live = contentScale.livePpsRef.current;
  if (!live || !(contentScale.layoutPps > 0)) return 1;
  return live / contentScale.layoutPps;
};

// scaleX about the content origin, so a child at content x lands at x*scale.
const transformFor = (scrollLeft: number, scale: number): string =>
  `translate3d(${-scrollLeft}px, 0, 0)` + (scale === 1 ? '' : ` scaleX(${scale})`);

/**
 * Makes one HTML overlay layer scroll on the rAF clock instead of on React
 * commits (see `utils/scrollSyncHub.ts` for why).
 *
 * The layer lays its children out in content pixels — `time * pixelsPerSecond`,
 * no scroll term — attaches the returned `ref`/`style` to its wrapper element,
 * and this hook translates that wrapper once per frame from Spectrogram's rAF
 * loop. `onSync` is for the leftovers that genuinely depend on the scroll
 * position (edge pinning, cull windows); it runs in the same frame, and takes
 * the frame's content scale so pinned children can undo it (see ContentScale).
 *
 * The registration effect deliberately has no dep array: it re-runs after every
 * render so a fresh commit is re-synced immediately rather than a frame later.
 */
export function useScrollTransformLayer(
  hub: ScrollSyncHub,
  scrollLeftRef: React.MutableRefObject<number>,
  onSync?: (scrollLeft: number, scale: number) => void,
  contentScale?: ContentScale,
): { ref: React.RefObject<HTMLDivElement>; style: React.CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  const lastRef = useRef({ scrollLeft: NaN, scale: NaN });
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const contentScaleRef = useRef(contentScale);
  contentScaleRef.current = contentScale;

  const sync = useCallback((scrollLeft: number, force = false) => {
    const scale = scaleOf(contentScaleRef.current);
    const last = lastRef.current;
    if (!force && scrollLeft === last.scrollLeft && scale === last.scale) return;
    last.scrollLeft = scrollLeft;
    last.scale = scale;
    const el = ref.current;
    if (el) el.style.transform = transformFor(scrollLeft, scale);
    onSyncRef.current?.(scrollLeft, scale);
  }, []);

  useLayoutEffect(() => {
    const unregister = hub.register(sync);
    sync(scrollLeftRef.current, true);
    return unregister;
  });

  return {
    ref,
    // First paint (before the layout effect runs) already sits in the right place.
    style: {
      transform: transformFor(scrollLeftRef.current, scaleOf(contentScale)),
      transformOrigin: '0 0',
      willChange: 'transform',
    },
  };
}
