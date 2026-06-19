import React from 'react';
import { Selection } from '../../types';
import { timeToX } from '../../utils/viewportTransform';

interface SelectionHandlesProps {
  selection: Selection | null;
  creatingSelection: { start: number; current: number } | null;
  scrollLeft: number;
  pixelsPerSecond: number;
  containerWidth: number;
  onBeginResize: (side: 'start' | 'end') => void;
}

// Render selection region handles (draggable). Render-only — interaction logic
// (the drag itself) lives in Spectrogram.tsx; this calls back via onBeginResize.
const SelectionHandles: React.FC<SelectionHandlesProps> = ({
  selection,
  creatingSelection,
  scrollLeft,
  pixelsPerSecond,
  containerWidth,
  onBeginResize,
}) => {
  const activeSelection = selection;
  if (!activeSelection || creatingSelection) return null;

  const leftX = timeToX(activeSelection.start, scrollLeft, pixelsPerSecond);
  const rightX = timeToX(activeSelection.end, scrollLeft, pixelsPerSecond);

  return (
    <>
      {/* Left handle — 1px white line with slightly wider invisible hit area */}
      {leftX >= 0 && leftX <= containerWidth && (
        <div
          className="absolute top-0 bottom-0 cursor-ew-resize"
          style={{ left: `${leftX - 4}px`, width: '9px', zIndex: 15 }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onBeginResize('start');
          }}
        >
          <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: '4px' }} />
        </div>
      )}
      {/* Right handle — 1px white line with slightly wider invisible hit area */}
      {rightX >= 0 && rightX <= containerWidth && (
        <div
          className="absolute top-0 bottom-0 cursor-ew-resize"
          style={{ left: `${rightX - 4}px`, width: '9px', zIndex: 15 }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onBeginResize('end');
          }}
        >
          <div className="absolute top-0 bottom-0 w-px bg-white" style={{ left: '4px' }} />
        </div>
      )}
    </>
  );
};

export default SelectionHandles;
