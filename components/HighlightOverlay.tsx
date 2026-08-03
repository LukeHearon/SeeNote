import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Ghosts the element carrying `data-help-target={target}` in this document,
 * re-measuring every frame while lit so the highlight tracks controls that
 * move (panel resize, toolbar reflow, playback-driven layout).
 *
 * Shared by HelpHighlightHost (ghosts the real control in the main window,
 * driven by a cross-window broadcast) and HelpWindow (ghosts the guide's own
 * embedded live-control chip, driven by local hover state).
 */
export function HighlightOverlay({ target }: { target: string | null }) {
  const [rect, setRect] = useState<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(`[data-help-target="${target}"]`) as HTMLElement | null;
      if (!el) {
        setRect(null);
      } else {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
      rafRef.current = requestAnimationFrame(measure);
    };
    measure();
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [target]);

  if (!rect) return null;
  return createPortal(
    <div
      className="help-highlight-overlay"
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    />,
    document.body,
  );
}
