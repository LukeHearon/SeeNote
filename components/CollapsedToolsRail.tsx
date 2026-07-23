import React, { useMemo } from 'react';
import { Hammer, Settings } from 'lucide-react';
import { AnnotationTool } from '../types';
import { tooltips } from '../copy/tooltips';

interface CollapsedToolsRailProps {
  annotationTools: AnnotationTool[];
  activeToolKey: string | null;
  onToolActivate: (key: string) => void;
  onOpenSettings: () => void;
}

// Colored swatch strip shown in place of the full tools panel when the left
// panel is collapsed — same slots/order as the Hotkeys pane in Annotation
// Tool Settings, but rendered as a color swatch instead of a plain number.
function CollapsedToolsRail({ annotationTools, activeToolKey, onToolActivate, onOpenSettings }: CollapsedToolsRailProps) {
  const keyedTools = useMemo(
    () => annotationTools.filter(t => t.key !== null).sort((a, b) => Number(a.key) - Number(b.key)),
    [annotationTools],
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-end gap-1.5 py-1.5">
      <Hammer size={13} className="text-slate-500 flex-none mb-0.5" />
      {keyedTools.map(tool => {
        const isActive = tool.key === activeToolKey;
        const label = tool.text || 'Custom';
        return (
          <button
            key={tool.key}
            onClick={() => onToolActivate(tool.key!)}
            className={`relative w-6 h-6 rounded flex-none flex items-center justify-center transition-all
              ${isActive ? 'ring-2 ring-white/70' : 'opacity-80 hover:opacity-100'}`}
            style={{ backgroundColor: tool.color }}
            data-tooltip={label}
          >
            <span className="text-[10px] font-mono text-white/90 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
              {tool.key}
            </span>
          </button>
        );
      })}
      <button
        onClick={onOpenSettings}
        className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors flex-none mt-0.5"
        data-tooltip={tooltips.annotationToolSettings}
      >
        <Settings size={13} />
      </button>
    </div>
  );
}

export default React.memo(CollapsedToolsRail);
