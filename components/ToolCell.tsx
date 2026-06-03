import React from 'react';

// Compact tool button used in the annotation tools panel.
// Always renders w-full — callers are responsible for constraining the container width.
function ToolCell({
  isActive, color, dotColor, label, hotkey, onClick, dotted, tooltip,
}: {
  isActive: boolean; color: string; dotColor: string; label: string;
  hotkey: string; onClick: () => void; dotted?: boolean; tooltip?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs transition-all border
        ${isActive ? 'opacity-100' : 'opacity-60 hover:opacity-100'}

        ${dotted ? 'border-dashed' : 'border-transparent hover:border-slate-600'}`}
      style={{
        backgroundColor: isActive ? color + '40' : color + '18',
        // dotted: brighten border when active instead of adding a ring
        borderColor: dotted
          ? (isActive ? 'rgba(255,255,255,0.6)' : '#6b7280')
          : (isActive ? color : undefined),
      }}
      data-tooltip={tooltip ? `${label}\n${tooltip}` : label}
    >
      <span className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: dotColor }} />
      <span className="flex-1 min-w-0 truncate text-left text-slate-100 leading-tight">{label}</span>
      <span className="font-mono text-slate-500 text-[10px] flex-none">{hotkey}</span>
    </button>
  );
}

export default ToolCell;
