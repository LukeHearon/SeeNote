import React, { useMemo, useState } from 'react';
import { Settings, Trash2, Play, Square, Search, Images } from 'lucide-react';
import { AnnotationTool } from '../types';
import ToolCell from './ToolCell';
import SidebarSection from './SidebarSection';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import { tooltips } from '../copy/tooltips';
import { annotationToolsPanel as copy } from '../copy/ui';

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
  onOpenFindLabel: () => void;
  onEditTool: (toolIndex: number) => void;
  onRequestDeleteTool: (toolIndex: number) => void;
  // Example-clip playback: id of the tool currently auditioning (null = none),
  // a toggle to play/stop a tool's next example, and the "Show examples" library.
  playingExampleToolId: string | null;
  onPlayExample: (tool: AnnotationTool) => void;
  onShowExamples: (toolIndex: number) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function AnnotationToolsPanel({
  annotationTools,
  activeToolKey,
  onToolActivate,
  onSelectModeActivate,
  onOpenSettings,
  onOpenFindLabel,
  onEditTool,
  onRequestDeleteTool,
  playingExampleToolId,
  onPlayExample,
  onShowExamples,
  collapsed,
  onToggleCollapsed,
}: AnnotationToolsPanelProps) {
  const custom = annotationTools[0];
  // Defined (non-custom, keyed) tools sorted by key — memoized so this doesn't
  // re-run on every render.
  const definedTools = useMemo(
    () => annotationTools.slice(1).filter(t => t.key !== null).sort((a, b) => Number(a.key) - Number(b.key)),
    [annotationTools],
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [hoveredToolKey, setHoveredToolKey] = useState<string | null>(null);
  const openContextMenu = (e: React.MouseEvent, toolIndex: number, canDelete: boolean) => {
    e.preventDefault();
    setContextMenu({ toolIndex, x: e.clientX, y: e.clientY, canDelete });
  };

  const menuItems = (state: ContextMenuState): ContextMenuItem[] => {
    const tool = annotationTools[state.toolIndex];
    const items: ContextMenuItem[] = [
      { label: copy.contextEdit, icon: <Settings size={12} />, onSelect: () => onEditTool(state.toolIndex) },
    ];
    if ((tool?.exampleFiles?.length ?? 0) > 0) {
      items.push({ label: copy.showExamples, icon: <Images size={12} />, onSelect: () => onShowExamples(state.toolIndex) });
    }
    if (state.canDelete) {
      items.push({
        label: copy.contextDelete,
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onSelect: () => onRequestDeleteTool(state.toolIndex),
      });
    }
    return items;
  };

  return (
    <SidebarSection
      helpTarget="tool-palette"
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      keepActionsWhenCollapsed
      title={<span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium">{copy.header}</span>}
      actions={(
        <div className="flex items-center gap-0.5 flex-none">
          <button
            onClick={onOpenFindLabel}
            className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors"
            data-tooltip={tooltips.findLabel}
          >
            <Search size={12} />
          </button>
          <button
            onClick={onOpenSettings}
            className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors"
            data-tooltip={tooltips.annotationToolSettings}
          >
            <Settings size={12} />
          </button>
        </div>
      )}
    >
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
            className="flex-1 min-w-0 relative"
            onContextMenu={e => openContextMenu(e, 0, false)}
            onMouseEnter={() => setHoveredToolKey(custom.key!)}
            onMouseLeave={() => setHoveredToolKey(null)}
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
            {hoveredToolKey === custom.key && (
              <div
                className="absolute right-0 inset-y-0 flex items-center gap-0.5 pr-1 pl-4 pointer-events-none"
                style={{ background: 'linear-gradient(to right, transparent, rgba(15,23,42,0.9) 35%)' }}
              >
                <button
                  className="pointer-events-auto p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-600/60 transition-colors"
                  onClick={e => { e.stopPropagation(); onEditTool(0); }}
                >
                  <Settings size={10} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Defined labels — single scrollable column */}
        <div className="flex flex-col gap-1">
          {definedTools.map((tool) => {
            const toolIndex = annotationTools.indexOf(tool);
            const hasExamples = (tool.exampleFiles?.length ?? 0) > 0;
            const isPlaying = playingExampleToolId === tool.id;
            const showOverlay = hoveredToolKey === tool.key || isPlaying;
            return (
              <div
                key={tool.key}
                className="relative"
                onContextMenu={e => openContextMenu(e, toolIndex, true)}
                onMouseEnter={() => setHoveredToolKey(tool.key!)}
                onMouseLeave={() => setHoveredToolKey(null)}
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
                {showOverlay && (
                  <div
                    className="absolute right-0 inset-y-0 flex items-center gap-0.5 pr-1 pl-4 pointer-events-none"
                    style={{ background: 'linear-gradient(to right, transparent, rgba(15,23,42,0.9) 35%)' }}
                  >
                    {hasExamples && (
                      <button
                        className="pointer-events-auto p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-600/60 transition-colors"
                        onClick={e => { e.stopPropagation(); onPlayExample(tool); }}
                        data-tooltip={isPlaying ? tooltips.stopExample : tooltips.playExample}
                      >
                        {isPlaying ? <Square size={10} /> : <Play size={10} />}
                      </button>
                    )}
                    <button
                      className="pointer-events-auto p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-600/60 transition-colors"
                      onClick={e => { e.stopPropagation(); onEditTool(toolIndex); }}
                      data-tooltip={tooltips.editTool}
                    >
                      <Settings size={10} />
                    </button>
                    <button
                      className="pointer-events-auto p-0.5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-600/60 transition-colors"
                      onClick={e => { e.stopPropagation(); onRequestDeleteTool(toolIndex); }}
                      data-tooltip={tooltips.deleteTool}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems(contextMenu)}
          onClose={() => setContextMenu(null)}
          minWidth={130}
        />
      )}
    </SidebarSection>
  );
}

export default React.memo(AnnotationToolsPanel);
