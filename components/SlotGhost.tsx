import type { AnnotationTool } from '../types';
import ToolChip from './ToolChip';

// Drag preview for a hotkey slot: the greyed-out chip of the tool the drop
// would land in this slot, laid over the row's content. The row must be
// `relative`; `leftPx` skips past its digit badge.
export default function SlotGhost({ tool, leftPx, compact }: { tool: AnnotationTool; leftPx: number; compact?: boolean }) {
  return (
    // Opaque backing so the row underneath doesn't show through the greyed
    // chip: the sidebar's slate-900, or the settings modal's gray-900.
    <div className={`slot-ghost absolute inset-y-0 right-0 z-10 pointer-events-none flex ${compact ? 'bg-slate-900' : 'bg-gray-900'}`} style={{ left: leftPx }}>
      <ToolChip tool={tool} ghost compact={compact} className="flex-1" />
    </div>
  );
}
