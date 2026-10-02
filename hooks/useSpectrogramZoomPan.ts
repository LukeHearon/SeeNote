import { useCallback } from 'react';
import type React from 'react';
import { MIN_ZOOM_SEC } from '../constants';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import { clamp } from '../utils/helpers';
import { maxScroll as computeMaxScroll, centerScrollLeft } from '../utils/viewportTransform';
import { wheelZoomFactor, isGestureContinuation } from '../utils/zoomGesture';
import { useNonPassiveWheel } from './useNonPassiveWheel';
import { DIAG_SCROLL, diag } from '../utils/scrollDiag';

// How close a keyboard-walked edge may get to the frame before the view pans
// to keep it in sight.
const REVEAL_MARGIN_PX = 48;

interface ZoomPanParams {
  containerRef: React.RefObject<HTMLDivElement>;
  /** The ResizeObserver's fractional content-box width (see Spectrogram). */
  containerWidth: number;
  duration: number;
  zoomSec: number;
  zoomSecRef: React.MutableRefObject<number>;
  scrollLeftRef: React.MutableRefObject<number>;
  pixelsPerSecondRef: React.MutableRefObject<number>;
  lastZoomEventRef: React.MutableRefObject<number>;
  pendingZoomPublishRef: React.MutableRefObject<boolean>;
  lastManualScrollRef: React.MutableRefObject<number>;
  publishZoom: (zoomSec: number) => void;
  setScroll: (v: number, source?: string) => void;
  playheadLocked: boolean;
  isPlaying: boolean;
  currentTimeStore: CurrentTimeStore;
}

/**
 * The spectrogram's zoom and pan actions — wheel/pinch, zoom to a range, zoom
 * steps, and the scroll-to/reveal/recenter moves — over the live zoom and
 * scroll refs Spectrogram's draw loop reads.
 */
export function useSpectrogramZoomPan({
  containerRef, containerWidth, duration, zoomSec, zoomSecRef, scrollLeftRef, pixelsPerSecondRef,
  lastZoomEventRef, pendingZoomPublishRef, lastManualScrollRef, publishZoom, setScroll,
  playheadLocked, isPlaying, currentTimeStore,
}: ZoomPanParams) {
  // Live pps throughout: during a zoom commit the prop lags the ref, and a
  // scroll computed from the stale one lands on the wrong time.
  const scrollToTime = useCallback((time: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    setScroll(centerScrollLeft(time, pixelsPerSecondRef.current, containerWidth, duration), 'scrollToTime');
  }, [duration, setScroll]);

  // Minimal pan: bring `time` inside the window, keeping a margin so the edge
  // being walked never sits flush against the frame. Does nothing while it's
  // already comfortably in view — this follows a keyboard-driven edge the way
  // auto-pan follows a dragged one, and a centering scroll on every step would
  // make the whole spectrogram slide under a still cursor.
  const revealTime = useCallback((time: number) => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const pps = pixelsPerSecondRef.current;
    const margin = Math.min(REVEAL_MARGIN_PX, containerWidth / 4);
    const x = time * pps - scrollLeftRef.current;
    let target = scrollLeftRef.current;
    if (x < margin) target = time * pps - margin;
    else if (x > containerWidth - margin) target = time * pps - (containerWidth - margin);
    else return;
    const clamped = clamp(target, 0, computeMaxScroll(duration, pps, containerWidth));
    if (Math.abs(clamped - scrollLeftRef.current) > 0.01) setScroll(clamped, 'revealTime');
  }, [duration, setScroll]);

  // Recenter the playhead in the visible window without changing zoom.
  const recenterPlayhead = useCallback(() => {
    scrollToTime(currentTimeStore.get());
  }, [scrollToTime, currentTimeStore]);

  const applyWheel = useCallback((deltaX: number, deltaY: number, ctrlKey: boolean, metaKey: boolean, clientX: number) => {
    if (DIAG_SCROLL) diag(`wheel  dx=${deltaX} dy=${deltaY} ctrl=${ctrlKey} meta=${metaKey} clientX=${clientX} zoomProp=${zoomSec} zoomRef=${zoomSecRef.current} scrollRef=${scrollLeftRef.current.toFixed(2)} clientWidth=${containerRef.current?.clientWidth} stateWidth=${containerWidth}`);
    if (ctrlKey || metaKey) {
      if (!containerRef.current) return;
      // Trackpad inertia tails deliver horizontal-only events (deltaY === 0).
      // `deltaY > 0 ? 1 : -1` would treat every one of those as a zoom-in step,
      // making the view zoom by itself while Ctrl is held after a pan gesture.
      if (deltaY === 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      // Zoom off the LIVE zoom (ref), not the `zoomSec` prop. A pinch fires a
      // dense burst of wheel events — dozens before React commits the new prop —
      // so every event in the burst would read the same stale base zoom while
      // `scrollLeftRef` is already at the newly written scroll. The anchor time
      // derived from that mismatched pair is garbage, which is what made pinch
      // zoom jump around at random. A mouse wheel never showed it: its notches
      // are far enough apart that the prop has always caught up.
      const liveZoomSec = zoomSecRef.current || zoomSec;
      // `containerWidth` (the ResizeObserver's fractional content-box width),
      // NOT clientWidth: this is where pixelsPerSecondRef gets written, and it
      // has to agree exactly with the pps the resize handler derives, or the
      // two disagree by the integer rounding for as long as the zoom lasts.
      const currentPps = containerWidth / liveZoomSec;
      // One timestamp decides both how big this event's step is and whether the
      // parent hears about it now or on the next frame — an event that follows
      // its predecessor within the gap is part of a pinch either way. Sizing
      // lives in utils/zoomGesture.ts (a mid-pinch event and a WebKit mouse
      // notch are the same magnitude, so continuity is what separates them).
      const nowMs = performance.now();
      const inGesture = isGestureContinuation(nowMs, lastZoomEventRef.current);
      lastZoomEventRef.current = nowMs;
      const zoomFactor = wheelZoomFactor(deltaY, inGesture);
      const direction = deltaY > 0 ? 1 : -1;
      let newZoomSec = liveZoomSec * (direction > 0 ? zoomFactor : 1 / zoomFactor);
      newZoomSec = Math.max(MIN_ZOOM_SEC, Math.min(newZoomSec, duration ? duration * 1.4 : 86400));
      const newPixelsPerSecond = containerWidth / newZoomSec;
      // Locked to the playhead: the playhead is the anchor, and it stays
      // centred — matching where the auto-scroll effect parks it — regardless
      // of where the pointer is. Otherwise anchor the time under the pointer.
      let newScrollLeft: number;
      if (playheadLocked) {
        newScrollLeft = currentTimeStore.get() * newPixelsPerSecond - containerWidth / 2;
      } else {
        const timeAtMouse = (scrollLeftRef.current + mouseX) / currentPps;
        newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX;
      }
      const maxScroll = computeMaxScroll(duration, newPixelsPerSecond, containerWidth);
      newScrollLeft = clamp(newScrollLeft, 0, maxScroll);
      // Write zoom and scroll together: the rAF draw reads both live, and a pair
      // from different zoom levels resolves to the wrong region for that frame.
      // onZoomChange only reaches us as a prop on a later commit.
      pixelsPerSecondRef.current = newPixelsPerSecond;
      zoomSecRef.current = newZoomSec;
      setScroll(newScrollLeft, 'zoom');
      // Publishing to the parent is a render of the whole spectrogram subtree.
      // A mouse notch stands alone, so it publishes here and React commits
      // before the frame paints — no lag, no overlay compensation, exactly as
      // before. A pinch fires 4-5 events per frame, and publishing each one
      // both re-rendered that many times and let the prop fall a whole pile of
      // steps behind the refs, which is what drove the overlay's scale
      // compensation up to a visible stretch. Inside a burst the publish is
      // deferred to the rAF flush, so the prop is at most one frame and one
      // step behind.
      if (inGesture) {
        pendingZoomPublishRef.current = true;
      } else {
        pendingZoomPublishRef.current = false;
        publishZoom(newZoomSec);
      }
    } else {
      // While locked-to-playhead and playing, the auto-scroll effect below
      // recenters on every playback tick and would immediately undo a manual
      // pan anyway. Applying it regardless still publishes the transient
      // scroll through the viewport store, which the buzzdetect panel's
      // independent rAF loop can catch and draw before auto-scroll corrects
      // it — a visible jiggle there even though the spectrogram itself never
      // appears to move. Skip the pan outright so nothing transient publishes.
      if (playheadLocked && isPlaying) return;
      const panAmount = deltaY + deltaX;
      const maxScroll = computeMaxScroll(duration, pixelsPerSecondRef.current, containerWidth);
      lastManualScrollRef.current = Date.now();
      setScroll(clamp(scrollLeftRef.current + panAmount, 0, maxScroll), 'wheel');
    }
  }, [zoomSec, duration, containerWidth, publishZoom, playheadLocked, isPlaying, currentTimeStore, setScroll]);

  // Native and non-passive: React's own wheel listener is passive, so an
  // `onWheel` prop cannot preventDefault the webview's ctrl+wheel page zoom.
  // See hooks/useNonPassiveWheel.
  useNonPassiveWheel(containerRef, (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
    applyWheel(e.deltaX, e.deltaY, e.ctrlKey, e.metaKey, e.clientX);
  });

  const zoomToRange = useCallback((startTime: number, endTime: number) => {
    if (!containerRef.current) return;
    // Same width source as applyWheel and the resize handler — see containerWidth.
    const newZoomSec = Math.max(MIN_ZOOM_SEC, endTime - startTime);
    const newPps = containerWidth / newZoomSec;
    const maxScroll = computeMaxScroll(duration, newPps, containerWidth);
    // See applyWheel: zoom and scroll must reach the live refs together.
    pixelsPerSecondRef.current = newPps;
    zoomSecRef.current = newZoomSec;
    setScroll(clamp(startTime * newPps, 0, maxScroll), 'zoomToRange');
    publishZoom(newZoomSec);
  }, [duration, containerWidth, publishZoom, setScroll]);

  // Button/hotkey zoom is a discrete notch by definition — clear the gesture
  // clock so a held-down mod+= (key repeat can be faster than the gesture gap)
  // isn't mistaken for a pinch and priced at a fraction of a step.
  const zoomStep = useCallback((deltaY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    lastZoomEventRef.current = 0;
    applyWheel(0, deltaY, true, false, rect.left + rect.width / 2);
  }, [applyWheel]);

  const zoomIn = useCallback(() => zoomStep(-100), [zoomStep]);
  const zoomOut = useCallback(() => zoomStep(100), [zoomStep]);

  return { scrollToTime, revealTime, recenterPlayhead, applyWheel, zoomToRange, zoomIn, zoomOut };
}
