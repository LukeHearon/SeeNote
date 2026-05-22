import React, { useEffect, useRef, useState } from 'react';
import { X, GripVertical, Settings, Plus, Trash2 } from 'lucide-react';
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
  onCreateTool: (text: string, color: string, key?: string | null) => void;
  // Restore both tools and their linked annotations atomically — used by the
  // modal-local undo/redo so an "undelete" puts back the reassigned annotations
  // too. Wired in AnnotationWindow to commit through the shared annotation
  // history path so global undo stays consistent.
  onRestoreToolsState: (tools: AnnotationTool[], annotations: Annotation[]) => void;
}

// Snapshot of the two arrays a tool mutation can touch. Deleting a tool also
// reassigns its linked annotations to Custom, so a correct undo must restore
// both together.
type ToolsSnapshot = { tools: AnnotationTool[]; annotations: Annotation[] };

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

function ToolItem({ tool, toolIndex, annotations, onDragStart, onDragEnd, onGearClick, onDeleteClick, dim }: {
  tool: AnnotationTool;
  toolIndex: number;
  annotations: Annotation[];
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onGearClick: () => void;
  onDeleteClick: () => void;
  dim?: boolean;
}) {
  const linkedCount = annotations.filter(a => a.toolKey === tool.key).length;
  // The Custom tool (index 0 / key "0") is reserved and can never be deleted.
  const canDelete = toolIndex !== 0 && tool.key !== '0';
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
      {canDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDeleteClick(); }}
          className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-slate-500 hover:text-red-400 flex-none"
          title="Delete tool"
        >
          <Trash2 size={10} />
        </button>
      )}
    </div>
  );
}

// Shared inline "new tool" input used by both the Unassigned bin and empty
// hotkey slots. Centralising it keeps the create UX identical everywhere and
// avoids duplicating the input markup/keyboard handling.
function NewToolInput({ onCommit, onCancel }: {
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed) onCommit(trimmed);
    else onCancel();
  };
  return (
    <input
      autoFocus
      className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white outline-none"
      placeholder="Tool name…"
      value={text}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={commit}
    />
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
  onRestoreToolsState,
}: Props) {
  const [editingToolIndex, setEditingToolIndex] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  // Which bin is currently showing the inline create input: the Unassigned bin
  // or a specific empty hotkey slot (its digit). null = none.
  const [addingTo, setAddingTo] = useState<'unassigned' | Slot | null>(null);
  // Which empty hotkey slot the pointer is over (drives the in-place affordance).
  const [hoveredSlot, setHoveredSlot] = useState<Slot | null>(null);

  // Undo/redo stacks of {tools, annotations} snapshots, taken immediately
  // before each mutating action. Refs (not state) so the keydown listener reads
  // the latest without re-subscribing. Reset fresh whenever the modal mounts.
  const undoStack = useRef<ToolsSnapshot[]>([]);
  const redoStack = useRef<ToolsSnapshot[]>([]);
  // Latest props mirrored into refs so the snapshot captured at mutation time —
  // and the "current state" pushed onto the opposite stack during undo/redo —
  // always reflect what's on screen right now.
  const currentRef = useRef<ToolsSnapshot>({ tools: annotationTools, annotations });
  currentRef.current = { tools: annotationTools, annotations };
  const onRestoreRef = useRef(onRestoreToolsState);
  onRestoreRef.current = onRestoreToolsState;

  // Record the pre-mutation snapshot, then run the mutating action. Any new
  // user action clears the redo stack (standard linear-history semantics).
  const withSnapshot = (mutate: () => void) => {
    undoStack.current.push(currentRef.current);
    redoStack.current = [];
    mutate();
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    // Close any open editor first: restoring can change tool indices (e.g.
    // undoing a create removes the tool editingToolIndex points at), which would
    // otherwise dereference an out-of-bounds tool.
    setEditingToolIndex(null);
    redoStack.current.push(currentRef.current);
    onRestoreRef.current(prev.tools, prev.annotations);
  };

  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    setEditingToolIndex(null);
    undoStack.current.push(currentRef.current);
    onRestoreRef.current(next.tools, next.annotations);
  };

  const beginDrag = (sourceIndex: number) => setDrag({ sourceIndex, target: null });
  const cancelDrag = () => setDrag(null);

  const updateTarget = (target: DragTarget) =>
    setDrag(d => d ? { ...d, target } : d);

  const commitDrag = () => {
    if (!drag?.target) { cancelDrag(); return; }
    const newTools = applySwap(annotationTools, drag.sourceIndex, drag.target);
    withSnapshot(() => onReorderTools(newTools));
    setDrag(null);
  };

  // Commit a new tool from either the Unassigned bin (key undefined → null) or
  // an empty hotkey slot (key = that slot's digit).
  const commitNewTool = (text: string, key?: string | null) => {
    withSnapshot(() => onCreateTool(text, pickNextToolColor(annotationTools), key));
    setAddingTo(null);
  };

  const isSlotHighlighted = (k: Slot) =>
    drag?.target?.type === 'slot' && drag.target.key === k;

  const isUnassignedHighlighted =
    drag?.target?.type === 'unassigned';

  // Modal-local undo/redo. Registered in the CAPTURE phase on window so it runs
  // BEFORE the app's bubble-phase global hotkey listener (useHotkeys attaches
  // in the bubble phase). preventDefault + stopPropagation ensure the global
  // mod+z annotation-undo never also fires while this modal is open.
  useEffect(() => {
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      // Let the inline "new tool" input keep native text undo while it's focused.
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo(); else undo();
      } else if (e.key.toLowerCase() === 'y' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        redo();
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);

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
                        onDeleteClick={() => withSnapshot(() => onDeleteTool(toolIndex))}
                        dim={drag?.sourceIndex === toolIndex}
                      />
                    </div>
                  ) : addingTo === k ? (
                    // Inline create targeting this slot — new tool takes its digit.
                    <div className="flex-1">
                      <NewToolInput
                        onCommit={text => commitNewTool(text, k)}
                        onCancel={() => setAddingTo(null)}
                      />
                    </div>
                  ) : (
                    // Empty slot: dashed box, becomes a "+ New tool" affordance on
                    // hover. Creating from here assigns the new tool to this digit.
                    <div
                      className="flex-1 h-8 rounded border-2 border-dashed"
                      style={{ borderColor: isSlotHighlighted(k) ? '#3b82f6' : '#334155' }}
                      onMouseEnter={() => setHoveredSlot(k)}
                      onMouseLeave={() => setHoveredSlot(s => (s === k ? null : s))}
                    >
                      {hoveredSlot === k && !drag && (
                        <button
                          onClick={() => setAddingTo(k)}
                          className="w-full h-full flex items-center justify-center rounded text-slate-500 hover:text-slate-300 transition-colors text-xs gap-1"
                        >
                          <Plus size={10} />
                          New tool
                        </button>
                      )}
                    </div>
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
                    onDeleteClick={() => withSnapshot(() => onDeleteTool(toolIndex))}
                    dim={drag?.sourceIndex === toolIndex}
                  />
                </div>
              ))}
            {addingTo === 'unassigned' ? (
              <div className="mt-2">
                <NewToolInput
                  onCommit={text => commitNewTool(text)}
                  onCancel={() => setAddingTo(null)}
                />
              </div>
            ) : (
              <button
                onClick={() => setAddingTo('unassigned')}
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
          onSave={(idx, text, color) => { withSnapshot(() => onRenameTool(idx, text, color)); setEditingToolIndex(null); }}
        />
      )}
    </div>
  );
}
