import React from 'react';
import { Selection } from '../../types';
import type { ScrollSyncHub } from '../../utils/scrollSyncHub';
import { useScrollTransformLayer } from '../../hooks/useScrollTransformLayer';

interface SelectionHandlesProps {
  selection: Selection | null;
  creatingSelection: { start: number; current: number } | null;
  // Live scroll (pixels) — read once for the first paint; per-frame movement
  // comes from the hub, so the handles track the canvas selection exactly.
  scrollLeftRef: React.MutableRefObject<number>;
  scrollSync: ScrollSyncHub;
  pixelsPerSecond: number;
  onBeginResize: (side: 'start' | 'end') => void;
}

// Render selection region handles (draggable). Render-only — interaction logic
// (the drag itself) lives in Spectrogram.tsx; this calls back via onBeginResize.
//
// Positioned in content pixels inside a transform layer (see
// `utils/scrollSyncHub.ts`), so scrolling moves them on the rAF clock rather
// than on a React commit. Off-screen handles are clipped by the spectrogram
// container's own overflow rather than culled here — the previous
// `0 <= x <= containerWidth` test was itself a scroll dependency.
const SelectionHandles: React.FC<SelectionHandlesProps> = ({
  selection,
  creatingSelection,
  scrollLeftRef,
  scrollSync,
  pixelsPerSecond,
  onBeginResize,
}) => {
  const layer = useScrollTransformLayer(scrollSync, scrollLeftRef);
  const activeSelection = creatingSelection ? null : selection;

  return (
    <div ref={layer.ref} className="absolute top-0 left-0 w-full h-full pointer-events-none" style={{ ...layer.style, zIndex: 15 }}>
      {activeSelection && [
        { side: 'start' as const, x: activeSelection.start * pixelsPerSecond },
        { side: 'end' as const, x: activeSelection.end * pixelsPerSecond },
      ].map(({ side, x }) => (
        // 1px white line with a slightly wider invisible hit area
        <div
          key={side}
          className="absolute top-0 bottom-0 cursor-ew-resize pointer-events-auto"
          style={{ left: `${x - 4}px`, width: '9px' }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onBeginResize(side);
          }}
        >
          <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: '4px' }} />
        </div>
      ))}
    </div>
  );
};

export default React.memo(SelectionHandles);
