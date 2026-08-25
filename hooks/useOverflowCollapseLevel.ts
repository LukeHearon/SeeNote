import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Derives how many priority levels of a container's content must collapse
 * for it to fit its own box, by comparing scrollWidth (content's natural
 * extent, however it's currently rendered) against clientWidth (available
 * space) after every render. The caller collapses one more thing per level —
 * least important first — so a higher level means "more collapsed".
 *
 * A ResizeObserver on the container resets the level to 0 whenever its own
 * box changes size, so a widening never stays over-collapsed: the level is
 * re-derived from scratch rather than tracked against fixed breakpoints.
 */
export function useOverflowCollapseLevel<T extends HTMLElement>(maxLevel: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [level, setLevel] = useState(0);

  // No deps: re-checks after every render, including the one a level bump
  // itself causes, so it climbs to the minimum collapse the current width
  // needs within the same commit — no flash of overflowed content.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollWidth > el.clientWidth && level < maxLevel) {
      setLevel(l => l + 1);
    }
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setLevel(0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, level];
}
