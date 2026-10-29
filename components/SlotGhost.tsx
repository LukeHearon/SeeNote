import type { AnnotationTool } from '../types';

// Drag preview for a hotkey slot: a translucent, dashed copy of the tool that
// the drop would land in this slot, laid over the row's content. The row must
// be `relative`; `leftPx` skips past its digit badge.
export default function SlotGhost({ tool, leftPx }: { tool: AnnotationTool; leftPx: number }) {
  return (
    <div
      className="slot-ghost absolute inset-y-0 right-0 z-10 pointer-events-none rounded border border-dashed flex items-center px-2 min-w-0"
      style={{ left: leftPx, borderColor: tool.color, backgroundColor: 'rgba(15,23,42,0.85)' }}
    >
      <span className="w-2 h-2 rounded-full flex-none mr-1.5 opacity-70" style={{ backgroundColor: tool.color }} />
      <span className="text-xs text-slate-300/80 italic truncate">{tool.text}</span>
    </div>
  );
}
