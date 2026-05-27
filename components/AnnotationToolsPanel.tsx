import React, { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { AnnotationTool } from '../types';
import ToolCell from './ToolCell';

interface ContextMenuState {
  toolIndex: number;
  x: number;
  y: number;
  canDelete: boolean;
}

interface AnnotationToolsPanelProps {
  annotationTools: AnnotationTool[];
  activeToolKey: string | null;
  onToolActivate: (key: string) => void;
  onSelectModeActivate: () => void;
  onOpenSettings: () => void;
  onEditTool: (toolIndex: number) => void;
  onRequestDeleteTool: (toolIndex: number) => void;
}

export default function AnnotationToolsPanel({
  annotationTools,
  activeToolKey,
  onToolActivate,
  onSelectModeActivate,
  onOpenSettings,
  onEditTool,
  onRequestDeleteTool,
}: AnnotationToolsPanelProps) {
  const custom = annotationTools[0];
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [contextMenu]);

  const openContextMenu = (e: React.MouseEvent, toolIndex: number, canDelete: boolean) => {
    e.preventDefault();
    setContextMenu({ toolIndex, x: e.clientX, y: e.clientY, canDelete });
  };

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
          <div
            className="flex-1 min-w-0"
            onContextMenu={e => openContextMenu(e, 0, false)}
          >
            <ToolCell
              isActive={custom.key === activeToolKey}
              color={custom.color}
              dotColor="#94a3b8"
              label="Custom"
              hotkey={custom.key!}
              onClick={() => onToolActivate(custom.key!)}
              tooltip={custom.description || undefined}
            />
          </div>
        </div>

        {/* Defined labels — single scrollable column */}
        <div className="flex flex-col gap-1">
          {annotationTools.slice(1).filter(t => t.key !== null).sort((a, b) => Number(a.key) - Number(b.key)).map((tool) => {
            const toolIndex = annotationTools.indexOf(tool);
            return (
              <div
                key={tool.key}
                onContextMenu={e => openContextMenu(e, toolIndex, true)}
              >
                <ToolCell
                  isActive={tool.key === activeToolKey}
                  color={tool.color}
                  dotColor={tool.color}
                  label={tool.text}
                  hotkey={tool.key!}
                  onClick={() => onToolActivate(tool.key!)}
                  tooltip={tool.description || undefined}
                />
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] bg-slate-800 border border-slate-600 rounded shadow-xl py-1 min-w-[110px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
            onClick={() => { onEditTool(contextMenu.toolIndex); setContextMenu(null); }}
          >
            Edit
          </button>
          {contextMenu.canDelete && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-slate-700 transition-colors"
              onClick={() => { onRequestDeleteTool(contextMenu.toolIndex); setContextMenu(null); }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
