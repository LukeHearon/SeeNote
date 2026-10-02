import { useCallback, useLayoutEffect, useRef, useState } from 'react';
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

// A child laid out at content x (minus the anchor) lands at x*scale; the anchor
// goes back in through the translate, so it cancels: screen = t*livePps - scroll.
const transformFor = (scrollLeft: number, scale: number, anchor: number): string =>
  `translate3d(${scale * anchor - scrollLeft}px, 0, 0)` + (scale === 1 ? '' : ` scaleX(${scale})`);

/**
 * Makes one HTML overlay layer scroll on the rAF clock instead of on React
 * commits (see `utils/scrollSyncHub.ts` for why).
 *
 * The layer lays its children out at `time * pixelsPerSecond - anchor`, attaches
 * the returned `ref`/`style` to its wrapper element, and this hook translates
 * that wrapper once per frame from Spectrogram's rAF loop. `onSync` is for the
 * leftovers that genuinely depend on the scroll position (edge pinning); it runs
 * in the same frame, and takes the frame's content scale so pinned children can
 * undo it (see ContentScale).
 *
 * The anchor is why the layout values stay small. Laid out at plain
 * `time * pps`, a 10 hour file at 1s zoom puts children at ~3.6e7 px, past
 * where WebKit's layout (fixed-point, ~3.3e7 px) stops being exact: boxes and
 * handles drift off the canvas. The anchor is a scroll position near the
 * viewport, folded into the wrapper's transform, so children sit within a
 * couple of viewports of the origin at any zoom. It is React state: crossing
 * `reanchorPx` of scroll (or a zoom change) re-renders the layer once with the
 * new anchor, exactly like the annotation overlay's cull window used to. Lay
 * children out with `x - layer.anchor`.
 *
 * The registration effect deliberately has no dep array: it re-runs after every
 * render so a fresh commit is re-synced immediately rather than a frame later.
 */
export function useScrollTransformLayer(
  hub: ScrollSyncHub,
  scrollLeftRef: React.MutableRefObject<number>,
  onSync?: (scrollLeft: number, scale: number) => void,
  contentScale?: ContentScale,
  /** Scroll distance from the anchor that triggers a re-anchor. */
  reanchorPx = 2000,
): { ref: React.RefObject<HTMLDivElement>; style: React.CSSProperties; anchor: number } {
  const ref = useRef<HTMLDivElement>(null);
  const lastRef = useRef({ scrollLeft: NaN, scale: NaN });
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const contentScaleRef = useRef(contentScale);
  contentScaleRef.current = contentScale;
  const reanchorRef = useRef(reanchorPx);
  reanchorRef.current = reanchorPx;

  // The anchor, and the layout zoom it was chosen at: a scroll offset means
  // something else at another zoom, so a zoom change picks a fresh one.
  const layoutPps = contentScale?.layoutPps ?? 0;
  const [anchorState, setAnchorState] = useState(() => ({ anchor: scrollLeftRef.current, pps: layoutPps }));
  let anchor = anchorState.anchor;
  if (anchorState.pps !== layoutPps) {
    anchor = scrollLeftRef.current;
    setAnchorState({ anchor, pps: layoutPps });
  }
  // Read by the per-frame sync, assigned during render so it always names the
  // anchor the children in the DOM were laid out against.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const sync = useCallback((scrollLeft: number, force = false) => {
    const scale = scaleOf(contentScaleRef.current);
    const last = lastRef.current;
    if (!force && scrollLeft === last.scrollLeft && scale === last.scale) return;
    last.scrollLeft = scrollLeft;
    last.scale = scale;
    const el = ref.current;
    if (el) el.style.transform = transformFor(scrollLeft, scale, anchorRef.current);
    onSyncRef.current?.(scrollLeft, scale);
    if (Math.abs(scrollLeft - anchorRef.current) > reanchorRef.current) {
      // Not written to anchorRef here: until the render lands, the children in
      // the DOM are still laid out against the old anchor, and the transform
      // must keep agreeing with them.
      setAnchorState(prev => ({ anchor: scrollLeft, pps: prev.pps }));
    }
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
      transform: transformFor(scrollLeftRef.current, scaleOf(contentScale), anchor),
      transformOrigin: '0 0',
      willChange: 'transform',
    },
    anchor,
  };
}
