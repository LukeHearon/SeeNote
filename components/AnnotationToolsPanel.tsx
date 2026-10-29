import React, { useMemo, useState } from 'react';
import { Settings, Trash2, Play, Square, Search, Images, Loader2 } from 'lucide-react';
import UnassignHotkeyIcon from './icons/UnassignHotkeyIcon';
import { AnnotationTool } from '../types';
import { HOTKEY_SLOTS } from '../constants';
import EmptyHotkeySlot from './EmptyHotkeySlot';
import ToolCell from './ToolCell';
import SidebarSection from './SidebarSection';
import { refreshMenuItem, useRefreshMenu } from '../hooks/useRefreshMenu';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import { tooltips } from '../copy/tooltips';
import { annotationToolsPanel as copy } from '../copy/ui';
import SlotInsertIndicator from './SlotInsertIndicator';
import SlotGhost from './SlotGhost';
import ToolChip from './ToolChip';
import { useHotkeySlotDrag } from '../hooks/useHotkeySlotDrag';

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
  // Middle-click a keyed tool chip to free its hotkey (tool kept, key -> null).
  // Optional: the live guide copy has no project to mutate.
  onUnassignTool?: (toolIndex: number) => void;
  // Each empty hotkey slot is an add-tool entry for that key: assign an
  // existing tool to it, or open the editor to create one from the typed name.
  onAssignToolHotkey?: (toolIndex: number, key: string) => void;
  onCreateToolForHotkey?: (text: string, key: string) => void;
  // Drag a tool onto another slot (place / swap / insert-and-bump — the same
  // rules as Annotation Tool Settings). Absent → the rows aren't draggable.
  onReorderTools?: (newTools: AnnotationTool[]) => void;
  // Example-clip playback: id of the tool currently auditioning (null = none),
  // a toggle to play/stop a tool's next example, and the "Show examples" library.
  playingExampleToolId: string | null;
  onPlayExample: (tool: AnnotationTool) => void;
  onShowExamples: (toolIndex: number) => void;
  /** Re-read annotations, the tool set and the find index from disk. Absent in the guide's live copy. */
  onRefreshAnnotations?: () => void;
  /** The project's tools are still being read from disk: a spinner stands in for the labels. */
  loading?: boolean;
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
  onUnassignTool,
  onAssignToolHotkey,
  onCreateToolForHotkey,
  onReorderTools,
  playingExampleToolId,
  onPlayExample,
  onShowExamples,
  onRefreshAnnotations,
  loading = false,
  collapsed,
  onToggleCollapsed,
}: AnnotationToolsPanelProps) {
  const refreshMenu = useRefreshMenu(copy.refresh, onRefreshAnnotations);
  const custom = annotationTools[0];
  // Defined (non-custom, keyed) tools sorted by key — memoized so this doesn't
  // re-run on every render.
  const definedTools = useMemo(
    () => annotationTools.slice(1).filter(t => t.key !== null).sort((a, b) => Number(a.key) - Number(b.key)),
    [annotationTools],
  );
  const slotDrag = useHotkeySlotDrag(annotationTools, newTools => onReorderTools?.(newTools));
  const { drag } = slotDrag;
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
    if (onRefreshAnnotations) items.push(refreshMenuItem(copy.refresh, onRefreshAnnotations, true));
    return items;
  };

  return (
    <SidebarSection
      helpTarget="tool-palette"
      onHeaderContextMenu={refreshMenu.onContextMenu}
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

        {loading && (
          <div className="flex justify-center py-2 text-slate-500" role="status" aria-label={copy.loading}>
            <Loader2 size={14} className="animate-spin" />
          </div>
        )}

        {/* Hotkey slots 1–9, laid out like Annotation Tool Settings: always all
            nine, each an add-tool entry for its key while empty. Drag a tool to
            place / swap / insert between, with the same rules as the modal. */}
        {!loading && (
        // py strips above slot 1 / below 9 are the edge bump zones.
        <div
          className="flex flex-col gap-1 py-1"
          onDragOver={slotDrag.onSlotsDragOver}
          onDrop={e => { e.preventDefault(); slotDrag.commit(); }}
        >
          {HOTKEY_SLOTS.map((k, slotIdx) => {
            const tool = definedTools.find(t => t.key === k);
            const insertTarget = drag?.target?.type === 'insert' ? drag.target : null;
              const insert = insertTarget && (insertTarget.gap === slotIdx || (insertTarget.gap === -1 && slotIdx === 0)) ? insertTarget : null;
            const highlighted = drag?.target?.type === 'slot' && drag.target.key === k;
            // Badge (w-4) + gap-1 = 20px.
            const ghost = slotDrag.ghosts.has(k) ? <SlotGhost tool={slotDrag.ghosts.get(k)!} leftPx={20} compact /> : null;
            const badge = (
              <div className="w-4 h-4 bg-slate-700 rounded text-[10px] font-mono flex items-center justify-center text-slate-300 flex-none">
                {k}
              </div>
            );
            if (!tool) {
              return (
                <div key={k} ref={slotDrag.rowRef(slotIdx)} className="relative flex items-center gap-1 h-[25px]">
                  {insert && <SlotInsertIndicator direction={insert.direction} gapPx={4} above={insert.gap === -1} />}
                  {badge}
                  {ghost}
                  <EmptyHotkeySlot
                    annotationTools={annotationTools}
                    highlighted={highlighted}
                    onAssignExisting={toolIndex => onAssignToolHotkey?.(toolIndex, k)}
                    onCreateNew={text => onCreateToolForHotkey?.(text, k)}
                    // Lower rows open their matches upward, away from the list's bottom edge.
                    dropUp={slotIdx >= HOTKEY_SLOTS.length / 2}
                    className="h-full border"
                  />
                </div>
              );
            }
            const toolIndex = annotationTools.indexOf(tool);
            const hasExamples = (tool.exampleFiles?.length ?? 0) > 0;
            const isPlaying = playingExampleToolId === tool.id;
            const showOverlay = !drag && (hoveredToolKey === tool.key || isPlaying);
            return (
              <div key={k} ref={slotDrag.rowRef(slotIdx)} className="relative flex items-center gap-1 h-[25px]">
              {insert && <SlotInsertIndicator direction={insert.direction} gapPx={4} above={insert.gap === -1} />}
              {badge}
              {ghost}
              <div
                className="relative rounded flex-1 min-w-0 self-stretch"
                style={{
                  opacity: drag?.sourceIndex === toolIndex ? 0.35 : 1,
                  outline: highlighted && drag?.sourceIndex !== toolIndex ? '2px solid #3b82f6' : undefined,
                }}
                draggable={!!onReorderTools}
                onDragStart={() => slotDrag.begin(toolIndex)}
                onDragEnd={slotDrag.cancel}
                onContextMenu={e => openContextMenu(e, toolIndex, true)}
                onMouseDown={e => { if (e.button === 1) { e.preventDefault(); onUnassignTool?.(toolIndex); } }}
                onMouseEnter={() => setHoveredToolKey(tool.key!)}
                onMouseLeave={() => setHoveredToolKey(null)}
              >
                {/* Same chip as Annotation Tool Settings; click readies the tool. */}
                <ToolChip
                  tool={tool}
                  compact
                  active={tool.key === activeToolKey}
                  onClick={() => onToolActivate(tool.key!)}
                  tooltip={tool.description ? `${tool.text}\n${tool.description}` : undefined}
                  style={{ cursor: onReorderTools ? 'grab' : 'pointer' }}
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
                      className="pointer-events-auto p-0.5 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-600/60 transition-colors"
                      onClick={e => { e.stopPropagation(); onUnassignTool?.(toolIndex); }}
                      data-tooltip={tooltips.unassignTool}
                    >
                      <UnassignHotkeyIcon size={10} />
                    </button>
                  </div>
                )}
              </div>
              </div>
            );
          })}
        </div>
        )}
      </div>

      {refreshMenu.menu}
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
