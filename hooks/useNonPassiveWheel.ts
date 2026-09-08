import React, { useEffect, useRef } from 'react';

/** Either a ref to the element, or the element itself (for callers that hold it
 *  in state). */
export type WheelTarget = HTMLElement | null | React.RefObject<HTMLElement | null>;

const isRef = (t: WheelTarget): t is React.RefObject<HTMLElement | null> =>
  t !== null && 'current' in t;

const resolve = (target: WheelTarget): HTMLElement | null =>
  target === null ? null : isRef(target) ? target.current : target;

/**
 * Attach a wheel listener that can actually `preventDefault()`.
 *
 * React registers its own root-level `wheel` listener as PASSIVE (react-dom
 * hard-codes wheel/touchstart/touchmove that way), so `e.preventDefault()`
 * inside an `onWheel` prop is silently a no-op. That matters for ctrl+wheel:
 * on Chromium-backed webviews (WebView2 on Windows, WebKitGTK/Chromium on
 * Linux) an unprevented ctrl+wheel page-zooms the whole UI, which on the
 * spectrogram reads as the view jumping somewhere unrelated. Anything that
 * handles ctrl/pinch wheel itself must register natively and non-passively.
 *
 * The handler is read through a ref, so callers can pass an inline closure
 * without re-registering the listener every render.
 */
export function useNonPassiveWheel(target: WheelTarget, handler: (e: WheelEvent) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // Element-valued targets change identity when the element mounts, so they
  // belong in the deps; ref-valued targets are stable and are read live inside
  // the effect (which runs after the DOM node is attached).
  const el = isRef(target) ? null : target;
  useEffect(() => {
    const node = resolve(target);
    if (!node) return;
    const listener = (e: WheelEvent) => handlerRef.current(e);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, [target, el]);
}
