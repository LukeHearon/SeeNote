import { ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface HelpAnchorProps {
  target: string;
  children: ReactNode;
  as?: 'span' | 'strong' | 'h4';
  className?: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function HelpAnchor({ target, children, as: Tag = 'span', className = '' }: HelpAnchorProps) {
  const [rect, setRect] = useState<Rect | null>(null);
  const rafRef = useRef<number | null>(null);

  const measure = () => {
    const el = document.querySelector(`[data-help-target="${target}"]`) as HTMLElement | null;
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  };

  useEffect(() => {
    if (!rect) return;
    const tick = () => {
      measure();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect !== null]);

  const show = () => measure();
  const hide = () => setRect(null);

  return (
    <>
      <Tag
        className={`cursor-pointer underline decoration-dotted decoration-sky-400 hover:text-sky-300 transition-colors ${className}`}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {children}
      </Tag>
      {rect && createPortal(
        <div
          className="help-highlight-overlay"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
        />,
        document.body,
      )}
    </>
  );
}
