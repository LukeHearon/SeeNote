import { useEffect, useLayoutEffect, RefObject } from 'react';

/**
 * Runs `sync` whenever the container scrolls (at most once per animation
 * frame), resizes, or `syncKey` changes. For small children (a custom
 * scrollbar, a pinned breadcrumb) that mirror a scroller's state, so the
 * scroller's owner doesn't re-render per scroll tick.
 */
export function useScrollSync(
  containerRef: RefObject<HTMLElement | null>,
  sync: (el: HTMLElement) => void,
  syncKey: unknown,
): void {
  useLayoutEffect(() => {
    if (containerRef.current) sync(containerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, syncKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; sync(el); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => sync(el));
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [containerRef, sync]);
}
