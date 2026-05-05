import React, { useState } from 'react';
import { X, GripVertical, Settings, Plus } from 'lucide-react';
import { AnnotationTool, Annotation } from '../types';
import { pickNextToolColor } from '../constants';
import AnnotationToolEditModal from './AnnotationToolEditModal';

interface Props {
  annotationTools: AnnotationTool[];
  annotations: Annotation[];
  onClose: () => void;
  onReorderTools: (newTools: AnnotationTool[]) => void;
  onRenameTool: (toolIndex: number, newText: string, newColor: string) => void;
  onDeleteTool: (toolIndex: number) => void;
  onCreateTool: (text: string, color: string) => void;
}

const SLOTS = ['1','2','3','4','5','6','7','8','9'] as const;
type Slot = typeof SLOTS[number];

type DragTarget =
  | { type: 'slot'; key: Slot }
  | { type: 'unassigned' }
  | null;

type DragState = { sourceIndex: number; target: DragTarget } | null;

function applySwap(tools: AnnotationTool[], sourceIndex: number, target: DragTarget): AnnotationTool[] {
  if (!target) return tools;

  if (target.type === 'unassigned') {
    return tools.map((t, i) => i === sourceIndex ? { ...t, key: null } : t);
  }

  const targetKey = target.key;
  const sourceKey = tools[sourceIndex].key;
  const occupantIndex = tools.findIndex((t, i) => i !== sourceIndex && t.key === targetKey);

  return tools.map((t, i) => {
    if (i === sourceIndex) return { ...t, key: targetKey };
    if (i === occupantIndex) return { ...t, key: sourceKey ?? null };
    return t;
  });
}

function ToolItem({ tool, toolIndex, annotations, onDragStart, onDragEnd, onGearClick, dim }: {
  tool: AnnotationTool;
  toolIndex: number;
  annotations: Annotation[];
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onGearClick: () => void;
  dim?: boolean;
}) {
  const linkedCount = annotations.filter(a => a.toolKey === tool.key).length;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="flex items-center gap-2 bg-slate-800 rounded px-2 group/item flex-1 min-w-0 select-none h-8"
      style={{ borderLeft: `3px solid ${tool.color}`, cursor: 'grab', opacity: dim ? 0.35 : 1 }}
    >
      <GripVertical size={12} className="text-slate-500 flex-none" />
      <span className="text-xs text-white truncate flex-1">{tool.text}</span>
      {linkedCount > 0 && <span className="text-[10px] text-slate-500 flex-none">{linkedCount}</span>}
      <button
        onClick={e => { e.stopPropagation(); onGearClick(); }}
        className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-slate-500 hover:text-slate-300 flex-none"
      >
        <Settings size={10} />
      </button>
    </div>
  );
}

export default function AnnotationToolsSettingsModal({
  annotationTools,
  annotations,
  onClose,
  onReorderTools,
  onRenameTool,
  onDeleteTool,
  onCreateTool,
}: Props) {
  const [editingToolIndex, setEditingToolIndex] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [isAddingTool, setIsAddingTool] = useState(false);
  const [newToolText, setNewToolText] = useState('');

  const beginDrag = (sourceIndex: number) => setDrag({ sourceIndex, target: null });
  const cancelDrag = () => setDrag(null);

  const updateTarget = (target: DragTarget) =>
    setDrag(d => d ? { ...d, target } : d);

  const commitDrag = () => {
    if (!drag?.target) { cancelDrag(); return; }
    onReorderTools(applySwap(annotationTools, drag.sourceIndex, drag.target));
    setDrag(null);
  };

  const commitNewTool = () => {
    const trimmed = newToolText.trim();
    if (trimmed) onCreateTool(trimmed, pickNextToolColor(annotationTools));
    setIsAddingTool(false);
    setNewToolText('');
  };

  const isSlotHighlighted = (k: Slot) =>
    drag?.target?.type === 'slot' && drag.target.key === k;

  const isUnassignedHighlighted =
    drag?.target?.type === 'unassigned';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-[640px] h-[600px] flex flex-col relative">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
          <span className="text-sm font-semibold text-white">Annotation Tool Settings</span>
          <button onClick={onClose} className="p-0.5 rounded text-slate-400 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div
          className="flex flex-row gap-6 p-6 overflow-y-auto flex-1 min-h-0"
          onDragOver={e => e.preventDefault()}
          onDrop={commitDrag}
        >
          <div className="flex-1">
            <h3 className="text-xs text-slate-400 uppercase tracking-wider font-medium mb-3">Hotkeys</h3>
            {SLOTS.map(k => {
              const tool = annotationTools.find(t => t.key === k);
              const toolIndex = tool ? annotationTools.indexOf(tool) : -1;
              return (
                <div
                  key={k}
                  className="flex items-center gap-2 mb-2 h-8"
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (drag) updateTarget({ type: 'slot', key: k }); }}
                >
                  <div className="w-6 h-6 bg-slate-700 rounded text-xs font-mono flex items-center justify-center text-slate-300 flex-none">
                    {k}
                  </div>
                  {tool && toolIndex !== -1 ? (
                    <div
                      className="flex-1 flex rounded"
                      style={isSlotHighlighted(k) ? { outline: '2px solid #3b82f6' } : undefined}
                    >
                      <ToolItem
                        tool={tool}
                        toolIndex={toolIndex}
                        annotations={annotations}
                        onDragStart={() => beginDrag(toolIndex)}
                        onDragEnd={cancelDrag}
                        onGearClick={() => setEditingToolIndex(toolIndex)}
                        dim={drag?.sourceIndex === toolIndex}
                      />
                    </div>
                  ) : (
                    <div
                      className="flex-1 h-8 rounded border-2 border-dashed"
                      style={{ borderColor: isSlotHighlighted(k) ? '#3b82f6' : '#334155' }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div
            className="w-52 rounded-lg border-2 border-dashed p-3 flex flex-col transition-colors"
            style={{ borderColor: isUnassignedHighlighted ? '#3b82f6' : '#334155' }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (drag) updateTarget({ type: 'unassigned' }); }}
          >
            <h3 className="text-xs text-slate-400 uppercase tracking-wider font-medium mb-3">Unassigned</h3>
            {annotationTools
              .map((t, i) => ({ tool: t, toolIndex: i }))
              .filter(({ tool, toolIndex }) => toolIndex !== 0 && tool.key === null)
              .map(({ tool, toolIndex }) => (
                <div key={toolIndex} className="mb-2 flex h-8">
                  <ToolItem
                    tool={tool}
                    toolIndex={toolIndex}
                    annotations={annotations}
                    onDragStart={() => beginDrag(toolIndex)}
                    onDragEnd={cancelDrag}
                    onGearClick={() => setEditingToolIndex(toolIndex)}
                    dim={drag?.sourceIndex === toolIndex}
                  />
                </div>
              ))}
            {isAddingTool ? (
              <input
                autoFocus
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white outline-none mt-2"
                placeholder="Tool name…"
                value={newToolText}
                onChange={e => setNewToolText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitNewTool();
                  if (e.key === 'Escape') { setIsAddingTool(false); setNewToolText(''); }
                }}
                onBlur={commitNewTool}
              />
            ) : (
              <button
                onClick={() => setIsAddingTool(true)}
                className="mt-2 w-full flex items-center justify-center py-1 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-400 transition-all text-xs gap-1"
              >
                <Plus size={10} />
                New tool
              </button>
            )}
          </div>
        </div>
      </div>

      {editingToolIndex !== null && (
        <AnnotationToolEditModal
          tool={annotationTools[editingToolIndex]}
          toolIndex={editingToolIndex}
          annotations={annotations}
          onClose={() => setEditingToolIndex(null)}
          onSave={(idx, text, color) => { onRenameTool(idx, text, color); setEditingToolIndex(null); }}
          onDelete={(idx) => { onDeleteTool(idx); setEditingToolIndex(null); }}
        />
      )}
    </div>
  );
}
