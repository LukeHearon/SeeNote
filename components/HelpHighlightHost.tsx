import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { onHelpMessage } from '../utils/helpChannel';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Renders the ghost highlight over a real control when the help guide window
 * asks for it (HelpAnchor hover). Mount once per window that owns highlightable
 * controls — AnnotationWindow and SingleFileWindow.
 *
 * The rect is re-measured every frame while lit, so the highlight tracks
 * controls that move (panel resize, toolbar reflow, playback-driven layout).
 */
export function HelpHighlightHost() {
  const [target, setTarget] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => onHelpMessage(msg => {
    if (msg.type === 'highlight') setTarget(msg.target);
  }), []);

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
