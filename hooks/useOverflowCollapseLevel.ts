import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Derives how many priority levels of a container's content must collapse for
 * it to fit its own box, by comparing scrollWidth (the content's natural
 * extent, however it's currently rendered) against clientWidth (the space
 * available) after every render. The caller collapses one more thing per
 * level — least important first — so a higher level means "more collapsed".
 *
 * The level moves in BOTH directions. Climbing is driven by measured overflow.
 * Descending is driven by a remembered required width per level: the moment
 * level L is found not to fit, the width its content wanted (clientWidth +
 * overflow) is recorded, and once the container is wider than that again, L is
 * handed back. That hysteresis is what stops the level being a one-way
 * ratchet. An earlier version could only ever be released by a change in the
 * container's own width, so any overflow that happened at a fixed width — a
 * track loading and widening the time readouts, a switch to wall-clock units,
 * the first layout after mount — latched the collapse permanently.
 *
 * `deps` are the inputs that change how wide the content wants to be without
 * changing how wide the container is. When they change the remembered widths
 * are dropped and the level is re-derived from scratch, since a measurement
 * taken under the old content says nothing about the new.
 *
 * The epoch counter alongside the level exists so a re-measure request is
 * always a genuine state change: without it, asking to re-measure while the
 * level happens to be unchanged is a no-op update, React bails out of the
 * re-render, and the measuring effect never re-runs.
 */
export function useOverflowCollapseLevel<T extends HTMLElement>(
  maxLevel: number,
  deps: React.DependencyList = [],
): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState({ level: 0, epoch: 0 });
  const lastWidthRef = useRef(-1);
  // requiredRef[L] = the container width level L's content needs in order to
  // fit, learned the moment L was measured overflowing. Sparse: a level that
  // has never overflowed has no entry, and isn't descended into blind.
  const requiredRef = useRef<number[]>([]);

  // Absolute, never `l => l + 1`: a level is only ever set from a measurement
  // of one specific render's DOM, so it must not compound with another update
  // queued against a different one. Returning `s` unchanged lets React bail.
  const setLevel = (level: number) => setState(s => (s.level === level ? s : { ...s, level }));

  // No deps: re-checks after every render, including the ones its own level
  // changes cause, so it settles on the minimum collapse the current width
  // needs within the same commit — no flash of overflowed content.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const level = state.level;
    // 1px of slack throughout: scrollWidth/clientWidth are integer-rounded, so
    // a subpixel layout can report a pixel of phantom overflow.
    const overflow = el.scrollWidth - el.clientWidth;

    if (overflow > 1) {
      requiredRef.current[level] = el.clientWidth + overflow;
      if (level < maxLevel) setLevel(level + 1);
      return;
    }

    // It fits. Give back the level below if the container has since grown past
    // what that level was measured to need. If the estimate turns out to be
    // stale-low the descent overflows, which re-records it above and climbs
    // straight back — so this can't oscillate, and settles before paint.
    const required = requiredRef.current[level - 1];
    if (level > 0 && required !== undefined && el.clientWidth > required + 1) {
      setLevel(level - 1);
    }
  });

  // Declared after the measuring effect so that on a commit where both run,
  // this reset is queued last and wins: a bump measured against the outgoing
  // content must not survive into the new one.
  useLayoutEffect(() => {
    requiredRef.current = [];
    setState(s => ({ level: 0, epoch: s.epoch + 1 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Width only. A level change can alter the row's height (a control
    // collapsing to a narrower/taller shape), which would otherwise feed back
    // into a re-measure and oscillate — and, since a resize callback that
    // resizes the observed box again gets its later notifications silently
    // dropped, could stall the observer outright.
    const remeasure = () => {
      const width = el.clientWidth;
      if (width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      // Only ask for a re-measure. The effect above moves the level in
      // whichever direction the new width calls for, so a widening no longer
      // depends on being reset to 0 and re-climbing from scratch.
      setState(s => ({ ...s, epoch: s.epoch + 1 }));
    };

    lastWidthRef.current = el.clientWidth;
    const observer = new ResizeObserver(remeasure);
    observer.observe(el);
    // Belt and braces: a native window drag-resize under WKWebView is not a
    // DOM-driven layout change, and ResizeObserver delivery during one is
    // coalesced. The window resize event fires regardless, and remeasure is
    // idempotent per width, so a doubled signal costs nothing.
    window.addEventListener('resize', remeasure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', remeasure);
    };
  }, []);

  return [ref, state.level];
}
