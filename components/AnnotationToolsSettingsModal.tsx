import React, { useEffect, useRef, useState } from 'react';
import { annotationToolsSettingsModal as copy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { X, GripVertical, Settings, Plus, Trash2, FolderDown, Play, Square } from 'lucide-react';
import { AnnotationTool, Annotation } from '../types';
import { pickNextToolColor } from '../constants';
import { isMac } from '../utils/platform';
import AnnotationToolEditModal from './AnnotationToolEditModal';
import DeleteToolConfirmDialog from './DeleteToolConfirmDialog';

interface Props {
  annotationTools: AnnotationTool[];
  annotations: Annotation[];
  onClose: () => void;
  onReorderTools: (newTools: AnnotationTool[]) => void;
  onRenameTool: (toolIndex: number, newText: string, newColor: string, newDescription?: string) => void;
  // mode 'unlink' reassigns linked annotations to Custom; 'delete' removes them.
  onDeleteTool: (toolIndex: number, mode: 'unlink' | 'delete') => void;
  // Transient live preview of a tool's color while it's being edited (no history).
  onPreviewColor: (toolIndex: number, color: string) => void;
  onCreateTool: (text: string, color: string, key?: string | null) => void;
  // Restore both tools and their linked annotations atomically — used by the
  // modal-local undo/redo so an "undelete" puts back the reassigned annotations
  // too. Wired in AnnotationWindow to commit through the shared annotation
  // history path so global undo stays consistent.
  onRestoreToolsState: (tools: AnnotationTool[], annotations: Annotation[]) => void;
  // Pick a directory of {label}/ folders of audio clips and import them as
  // example clips, creating tool dirs for unknown labels.
  onImportExamples: () => Promise<void>;
  // Per-tool example import (files or folders) for the tool-edit modal.
  onImportExamplesToTool: (toolIndex: number, paths: string[]) => void | Promise<void>;
  // Example-clip playback shared with the palette: id of the tool currently
  // auditioning (null = none) and a toggle to play/stop a tool's next example.
  playingExampleToolId: string | null;
  onPlayExample: (tool: AnnotationTool) => void;
  // Open the read-only example library for one tool (from the edit modal).
  onShowExamples: (toolIndex: number) => void;
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

function ToolItem({ tool, toolIndex, onDragStart, onDragEnd, onGearClick, onDeleteClick, dim, isPlaying, onPlayExample }: {
  tool: AnnotationTool;
  toolIndex: number;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onGearClick: () => void;
  onDeleteClick: () => void;
  dim?: boolean;
  isPlaying?: boolean;
  onPlayExample?: () => void;
}) {
  const canDelete = toolIndex !== 0 && tool.key !== '0';
  const hasExamples = (tool.exampleFiles?.length ?? 0) > 0;
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0" style={{ opacity: dim ? 0.35 : 1 }}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex items-center gap-2 bg-slate-800 rounded px-2 flex-1 min-w-0 select-none h-8"
        style={{ borderLeft: `3px solid ${tool.color}`, cursor: 'grab' }}
      >
        <GripVertical size={12} className="text-slate-500 flex-none" />
        <span className="text-xs text-white truncate flex-1" data-tooltip={tool.text} data-tooltip-delay="80">{tool.text}</span>
      </div>
      {hasExamples && onPlayExample && (
        <button
          onClick={e => { e.stopPropagation(); onPlayExample(); }}
          className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 flex-none transition-colors"
          data-tooltip={isPlaying ? tooltips.stopExample : tooltips.playExample}
        >
          {isPlaying ? <Square size={12} /> : <Play size={12} />}
        </button>
      )}
      <button
        onClick={e => { e.stopPropagation(); onGearClick(); }}
        className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700 flex-none transition-colors"
        data-tooltip={tooltips.editTool}
      >
        <Settings size={12} />
      </button>
      {canDelete ? (
        <button
          onClick={e => { e.stopPropagation(); onDeleteClick(); }}
          className="p-1 rounded text-slate-500 hover:text-red-400 hover:bg-slate-700 flex-none transition-colors"
          data-tooltip={tooltips.deleteTool}
        >
          <Trash2 size={12} />
        </button>
      ) : (
        <div className="w-[28px] flex-none" />
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
      placeholder={copy.toolNamePlaceholder}
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
  onPreviewColor,
  onCreateTool,
  onRestoreToolsState,
  onImportExamples,
  onImportExamplesToTool,
  playingExampleToolId,
  onPlayExample,
  onShowExamples,
}: Props) {
  const [isImporting, setIsImporting] = useState(false);
  const [editingToolIndex, setEditingToolIndex] = useState<number | null>(null);
  // Tool whose trash icon was clicked and that has linked annotations: drives
  // the delete-confirmation overlay. null = no dialog open.
  const [deletingToolIndex, setDeletingToolIndex] = useState<number | null>(null);
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

  // Pre-edit snapshot captured the moment the edit modal opens. Because color
  // changes are live-previewed (mutating state before Save), snapshotting at
  // Save time would capture the already-previewed color — wrong for undo. So we
  // capture {tools, annotations} here, before any preview, and push that on Save.
  const editSnapshotRef = useRef<ToolsSnapshot>(currentRef.current);
  useEffect(() => {
    if (editingToolIndex !== null) editSnapshotRef.current = currentRef.current;
  }, [editingToolIndex]);

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

  // Trash-icon click: if the tool has linked annotations, open the confirmation
  // dialog (which offers Delete vs Unlink); otherwise delete it outright.
  const requestDeleteTool = (toolIndex: number) => {
    setDeletingToolIndex(toolIndex);
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

  const hasUnassigned = annotationTools.some((t, i) => i !== 0 && t.key === null);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className={`bg-gray-900 border border-gray-700 rounded-xl h-[600px] flex flex-col relative ${hasUnassigned ? 'w-[800px]' : 'w-[640px]'}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
          <span className="text-sm font-semibold text-white">{copy.settingsTitle}</span>
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                if (isImporting) return;
                setIsImporting(true);
                try { await onImportExamples(); } finally { setIsImporting(false); }
              }}
              disabled={isImporting}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 disabled:opacity-50 transition-colors text-xs"
              data-tooltip={tooltips.importToolsDir}
            >
              <FolderDown size={12} />
              {isImporting ? 'Importing…' : 'Import tools'}
            </button>
            <button onClick={onClose} className="p-0.5 rounded text-slate-400 hover:text-white transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        <div
          className="flex flex-row gap-6 p-6 flex-1 min-h-0"
          onDragOver={e => e.preventDefault()}
          onDrop={commitDrag}
        >
          <div className="flex-1 flex flex-col min-w-0">
            <h3 className="text-xs text-slate-400 uppercase tracking-wider font-medium mb-3">{copy.hotkeysHeading}</h3>
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
                      className="flex-1 flex rounded min-w-0"
                      style={isSlotHighlighted(k) ? { outline: '2px solid #3b82f6' } : undefined}
                    >
                      <ToolItem
                        tool={tool}
                        toolIndex={toolIndex}
                        onDragStart={() => beginDrag(toolIndex)}
                        onDragEnd={cancelDrag}
                        onGearClick={() => setEditingToolIndex(toolIndex)}
                        onDeleteClick={() => requestDeleteTool(toolIndex)}
                        dim={drag?.sourceIndex === toolIndex}
                        isPlaying={playingExampleToolId === tool.id}
                        onPlayExample={() => onPlayExample(tool)}
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
                          {copy.newTool}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div
            className="flex-1 min-w-0 rounded-lg border-2 border-dashed p-3 flex flex-col min-h-0 transition-colors"
            style={{ borderColor: isUnassignedHighlighted ? '#3b82f6' : '#334155' }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (drag) updateTarget({ type: 'unassigned' }); }}
          >
            <h3 className="text-xs text-slate-400 uppercase tracking-wider font-medium mb-3 flex-none">{copy.unassignedHeading}</h3>
            <div className="overflow-y-auto flex-1 min-h-0">
              {annotationTools
                .map((t, i) => ({ tool: t, toolIndex: i }))
                .filter(({ tool, toolIndex }) => toolIndex !== 0 && tool.key === null)
                .map(({ tool, toolIndex }) => (
                  <div key={toolIndex} className="mb-2 flex h-8">
                    <ToolItem
                      tool={tool}
                      toolIndex={toolIndex}
                      onDragStart={() => beginDrag(toolIndex)}
                      onDragEnd={cancelDrag}
                      onGearClick={() => setEditingToolIndex(toolIndex)}
                      onDeleteClick={() => requestDeleteTool(toolIndex)}
                      dim={drag?.sourceIndex === toolIndex}
                      isPlaying={playingExampleToolId === tool.id}
                      onPlayExample={() => onPlayExample(tool)}
                    />
                  </div>
                ))}
            </div>
            {addingTo === 'unassigned' ? (
              <div className="mt-2 flex-none">
                <NewToolInput
                  onCommit={text => commitNewTool(text)}
                  onCancel={() => setAddingTo(null)}
                />
              </div>
            ) : (
              <button
                onClick={() => setAddingTo('unassigned')}
                className="mt-2 flex-none w-full flex items-center justify-center py-1 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-400 transition-all text-xs gap-1"
              >
                <Plus size={10} />
                {copy.newTool}
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
          onPreviewColor={onPreviewColor}
          onImportExamples={onImportExamplesToTool}
          onShowExamples={(idx) => { setEditingToolIndex(null); onShowExamples(idx); }}
          // Push the pre-edit snapshot (captured on open, before any live color
          // preview) so undo restores the original text AND color, then apply
          // the final values.
          onSave={(idx, text, color, description) => {
            undoStack.current.push(editSnapshotRef.current);
            redoStack.current = [];
            onRenameTool(idx, text, color, description);
            setEditingToolIndex(null);
          }}
        />
      )}

      {deletingToolIndex !== null && (() => {
        const idx = deletingToolIndex;
        const tool = annotationTools[idx];
        const close = () => setDeletingToolIndex(null);
        return tool ? (
          <DeleteToolConfirmDialog
            tool={tool}
            onClose={close}
            onDelete={() => { withSnapshot(() => onDeleteTool(idx, 'delete')); close(); }}
            onUnlink={() => { withSnapshot(() => onDeleteTool(idx, 'unlink')); close(); }}
          />
        ) : null;
      })()}
    </div>
  );
}
