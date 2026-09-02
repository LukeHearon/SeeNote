import React from 'react';
import { ToolMatch } from '../utils/annotationTools';

// The scrolling list of matching tools shown under a type-a-name field. Chip
// styling (color bar + label) is shared by NewToolEntry and the inline
// annotation-label editor via this component; the popover framing around it is
// each caller's own.
export default function ToolMatchDropdown({
  matches, activeIndex, setActiveIndex, itemRefs, onPick, maxVisibleRows = 6, rowHeight = 32,
}: {
  matches: ToolMatch[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  itemRefs: React.MutableRefObject<(HTMLElement | null)[]>;
  onPick: (toolIndex: number) => void;
  maxVisibleRows?: number;
  rowHeight?: number;
}) {
  return (
    <div
      className="overflow-y-auto flex flex-col gap-1"
      style={{ maxHeight: maxVisibleRows * rowHeight }}
    >
      {matches.map(({ tool, toolIndex }, i) => (
        <button
          key={toolIndex}
          ref={el => { itemRefs.current[i] = el; }}
          onMouseDown={e => { e.preventDefault(); onPick(toolIndex); }}
          onMouseEnter={() => setActiveIndex(i)}
          className={`w-full flex items-center gap-2 h-8 px-2 rounded transition-colors ${i === activeIndex ? 'bg-slate-700' : 'bg-slate-800 hover:bg-slate-700'}`}
          style={{ borderLeft: `3px solid ${tool.color}` }}
        >
          <span className="text-xs text-white truncate">{tool.text}</span>
        </button>
      ))}
    </div>
  );
}
