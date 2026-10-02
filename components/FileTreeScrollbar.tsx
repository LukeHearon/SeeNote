import React, { useCallback, useRef, useState, RefObject } from 'react';
import { useScrollSync } from '../hooks/useScrollSync';

const SNAP_THRESHOLD = 50;

/**
 * The file panel's custom scrollbar: a track with a thumb, plus a red hash
 * marking the active file's position (the thumb snaps to it when dragged
 * near). Owns its own scroll state so the panel doesn't re-render per scroll
 * tick; `syncKey` changes when the content may have changed size.
 */
export default function FileTreeScrollbar({
  containerRef,
  syncKey,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  syncKey: unknown;
}) {
  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 1, clientHeight: 1 });
  const [activeFraction, setActiveFraction] = useState<number | null>(null);
  const activeFractionRef = useRef<number | null>(null);

  const sync = useCallback((el: HTMLElement) => {
    const { scrollTop, scrollHeight, clientHeight } = el;
    setMetrics(prev => (prev.scrollTop === scrollTop && prev.scrollHeight === scrollHeight && prev.clientHeight === clientHeight
      ? prev : { scrollTop, scrollHeight, clientHeight }));
    const activeEl = el.querySelector('[data-active-file]') as HTMLElement | null;
    let frac: number | null = null;
    if (activeEl && scrollHeight > 0) {
      const relTop = activeEl.getBoundingClientRect().top - el.getBoundingClientRect().top + scrollTop;
      frac = Math.max(0, Math.min(1, (relTop + activeEl.offsetHeight / 2) / scrollHeight));
    }
    activeFractionRef.current = frac;
    setActiveFraction(frac);
  }, []);
  useScrollSync(containerRef, sync, syncKey);

  const { scrollTop, scrollHeight, clientHeight } = metrics;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const showScrollbar = scrollHeight > clientHeight + 2;
  const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * clientHeight);
  const thumbTop = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * (clientHeight - thumbHeight) : 0;

  const handleThumbMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startScrollTop = containerRef.current?.scrollTop ?? 0;

    const onMouseMove = (ev: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const { scrollHeight: sh, clientHeight: ch } = container;
      const maxST = Math.max(0, sh - ch);
      const thumbH = Math.max(20, (ch / sh) * ch);
      const trackH = ch - thumbH;
      if (trackH <= 0) return;
      let next = startScrollTop + ((ev.clientY - startY) / trackH) * maxST;
      const frac = activeFractionRef.current;
      if (frac !== null) {
        const snap = Math.max(0, Math.min(frac * sh - ch / 2, maxST));
        if (Math.abs(next - snap) < SNAP_THRESHOLD) next = snap;
      }
      container.scrollTop = Math.max(0, Math.min(next, maxST));
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleTrackMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const track = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientY - track.top) / track.height;
    container.scrollTop = frac * (container.scrollHeight - container.clientHeight);
  };

  return (
    // Always present so content is always bounded by it
    <div className="w-2 flex-none bg-[#1F2937] relative cursor-ns-resize" onMouseDown={handleTrackMouseDown}>
      {showScrollbar && (
        <>
          {activeFraction !== null && (
            <div
              className="absolute inset-x-0 pointer-events-none rounded-sm"
              style={{ top: `${activeFraction * 100}%`, height: '3px', background: '#e65161', transform: 'translateY(-50%)' }}
            />
          )}
          {/* Thumb on top, semi-transparent so the hash shows through */}
          <div
            className="absolute inset-x-0 rounded-full bg-slate-600/60 hover:bg-slate-500/70 transition-colors cursor-ns-resize"
            style={{ top: `${thumbTop}px`, height: `${thumbHeight}px` }}
            onMouseDown={handleThumbMouseDown}
          />
        </>
      )}
    </div>
  );
}
