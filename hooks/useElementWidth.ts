import { useEffect, useRef, useState } from 'react';

/**
 * Tracks an element's content-box width via ResizeObserver. Starts at 0 before
 * the first measurement, so callers gating on a width threshold should treat 0
 * as "not yet known" rather than "narrow".
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
