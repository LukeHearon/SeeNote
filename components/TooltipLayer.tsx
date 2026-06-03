import React, { useEffect, useRef, useState } from 'react';

const TOOLTIP_DELAY = 400;

function findTooltipText(el: Element | null): string | null {
  while (el && el !== document.body) {
    const t = el.getAttribute('data-tooltip');
    if (t) return t;
    el = el.parentElement;
  }
  return null;
}

function findTooltipDelay(el: Element | null): number {
  while (el && el !== document.body) {
    const d = el.getAttribute('data-tooltip-delay');
    if (d) return parseInt(d, 10);
    el = el.parentElement;
  }
  return TOOLTIP_DELAY;
}

export default function TooltipLayer() {
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const instantRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const currentTextRef = useRef<string | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const showTooltip = (text: string) => {
      setTooltip({ text, x: mouseRef.current.x, y: mouseRef.current.y });
    };

    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      const el = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
      const text = findTooltipText(el);

      if (text !== currentTextRef.current) {
        clearTimer();
        currentTextRef.current = text;
        if (text) {
          if (instantRef.current) {
            showTooltip(text);
          } else {
            setTooltip(null);
            const delay = findTooltipDelay(el);
            timerRef.current = setTimeout(() => showTooltip(text), delay);
          }
        } else {
          setTooltip(null);
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && !instantRef.current) {
        instantRef.current = true;
        if (currentTextRef.current) {
          clearTimer();
          showTooltip(currentTextRef.current);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === '/') {
        instantRef.current = false;
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearTimer();
    };
  }, []);

  if (!tooltip) return null;

  const padding = 8;
  const x = Math.min(tooltip.x + 12, window.innerWidth - 200 - padding);
  const y = tooltip.y + 20;

  const lines = tooltip.text.split('\n');
  const hasMultiline = lines.length > 1;

  return (
    <div
      className="fixed z-[9999] pointer-events-none px-2 py-1 text-xs text-white bg-slate-900 border border-slate-700 rounded shadow-lg"
      style={{ left: x, top: y, maxWidth: 300 }}
    >
      {hasMultiline ? (
        <>
          <div className="font-semibold">{lines[0]}</div>
          <div className="text-slate-300 mt-0.5">{lines.slice(1).join('\n')}</div>
        </>
      ) : tooltip.text}
    </div>
  );
}
