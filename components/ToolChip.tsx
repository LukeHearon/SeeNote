import React from 'react';
import { GripVertical } from 'lucide-react';
import type { AnnotationTool } from '../types';

// A hotkey tool's chip: grip handle, the tool's color as a bar down the left
// edge, and its label. Shared by Annotation Tool Settings, the Labels palette
// and the drag ghosts (`ghost`: the same chip faded, for where a drop would
// land a tool). Extra props (drag / mouse handlers) go on the root.
export default function ToolChip({ tool, active = false, ghost = false, compact = false, tooltip, className, style, ...rest }: {
  tool: AnnotationTool;
  /** This tool is readied: tint the chip with its color. */
  active?: boolean;
  ghost?: boolean;
  /** Sidebar height rather than the settings modal's. */
  compact?: boolean;
  /** Tooltip for the label; defaults to the label itself. */
  tooltip?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex items-center gap-2 rounded px-2 min-w-0 select-none ${compact ? 'h-full gap-1.5' : 'h-8'} ${ghost ? 'pointer-events-none' : ''} ${className ?? ''}`}
      style={{
        borderLeft: `3px solid ${tool.color}`,
        backgroundColor: active ? tool.color + '40' : '#1e293b',
        boxShadow: active ? `inset 0 0 0 1px ${tool.color}` : undefined,
        cursor: ghost ? undefined : 'grab',
        ...(ghost ? { opacity: 0.35 } : null),
        ...style,
      }}
      {...rest}
    >
      <GripVertical size={12} className="text-slate-500 flex-none" />
      <span className="text-xs text-white truncate flex-1" data-tooltip={ghost ? undefined : (tooltip ?? tool.text)} data-tooltip-delay="80">{tool.text}</span>
    </div>
  );
}
