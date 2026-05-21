import React from 'react';
import { Settings } from 'lucide-react';
import { AnnotationTool } from '../types';
import ToolCell from './ToolCell';

interface AnnotationToolsPanelProps {
  annotationTools: AnnotationTool[];
  activeToolKey: string | null;
  onToolActivate: (key: string) => void;
  onSelectModeActivate: () => void;
  onOpenSettings: () => void;
}

export default function AnnotationToolsPanel({
  annotationTools,
  activeToolKey,
  onToolActivate,
  onSelectModeActivate,
  onOpenSettings,
}: AnnotationToolsPanelProps) {
  const custom = annotationTools[0];

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-help-target="tool-palette">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-slate-800 border-b border-slate-700 flex-none">
        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium">Labels</span>
        <button
          onClick={onOpenSettings}
          className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors"
          data-tooltip="Annotation Tool Settings"
        >
          <Settings size={12} />
        </button>
      </div>

      {/* Tool Grid */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">

        {/* Row 1: Select (top-left) + Custom (top-right) — always 50:50 */}
        <div className="flex gap-1">
          {/* Select */}
          <div className="flex-1 min-w-0">
            <ToolCell
              isActive={activeToolKey === null}
              color="#374151"
              dotColor="#94a3b8"
              label="Select"
              hotkey="S"
              dotted
              onClick={onSelectModeActivate}
            />
          </div>
          {/* Custom (annotationTools[0]) */}
          <div className="flex-1 min-w-0">
            <ToolCell
              isActive={custom.key === activeToolKey}
              color={custom.color}
              dotColor="#94a3b8"
              label="Custom"
              hotkey={custom.key!}
              onClick={() => onToolActivate(custom.key!)}
            />
          </div>
        </div>

        {/* Defined labels — single scrollable column */}
        <div className="flex flex-col gap-1">
          {annotationTools.slice(1).filter(t => t.key !== null).sort((a, b) => Number(a.key) - Number(b.key)).map((tool) => (
            <div key={tool.key}>
              <ToolCell
                isActive={tool.key === activeToolKey}
                color={tool.color}
                dotColor={tool.color}
                label={tool.text}
                hotkey={tool.key!}
                onClick={() => onToolActivate(tool.key!)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
