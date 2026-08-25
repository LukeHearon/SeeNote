import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Derives how many priority levels of a container's content must collapse
 * for it to fit its own box, by comparing scrollWidth (content's natural
 * extent, however it's currently rendered) against clientWidth (available
 * space) after every render. The caller collapses one more thing per level —
 * least important first — so a higher level means "more collapsed".
 *
 * Whenever the container's own width changes, the level is reset to 0 and
 * re-climbed from scratch, so it tracks actual fit rather than fixed
 * breakpoints and never stays over-collapsed after a widening.
 *
 * The reset carries an `epoch` counter alongside the level. Without it,
 * resetting to 0 while already at 0 is a no-op state update: React bails out
 * without re-rendering, the measuring effect below never re-runs, and
 * narrowing from an uncollapsed toolbar silently does nothing. Widening from
 * a collapsed one always worked because 0 differed from the current level —
 * that was the whole widen/narrow asymmetry. Bumping the epoch makes every
 * re-measure request a genuine state change.
 */
export function useOverflowCollapseLevel<T extends HTMLElement>(maxLevel: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [state, setState] = useState({ level: 0, epoch: 0 });
  const lastWidthRef = useRef(-1);

  // No deps: re-checks after every render, including the one a level bump
  // itself causes, so it climbs to the minimum collapse the current width
  // needs within the same commit — no flash of overflowed content.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: scrollWidth/clientWidth are integer-rounded, so a
    // subpixel layout can report a pixel of phantom overflow.
    if (el.scrollWidth - el.clientWidth > 1 && state.level < maxLevel) {
      setState(s => ({ level: s.level + 1, epoch: s.epoch }));
    }
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Only react to width changes. A level change can alter the row's height
    // (a control collapsing to a narrower/taller shape), which would otherwise
    // feed a reset back into the climb and oscillate — and, since a resize
    // callback that resizes the observed box again gets its later
    // notifications silently dropped, could stall the observer outright.
    const remeasure = () => {
      const width = el.clientWidth;
      if (width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      setState(s => ({ level: 0, epoch: s.epoch + 1 }));
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
