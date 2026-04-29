import React, { useState } from 'react';
import { Plus, Pencil, X } from 'lucide-react';
import { AnnotationTool } from '../types';
import { HOTKEY_COLORS } from '../constants';
import ToolCell from './ToolCell';

interface AnnotationToolsPanelProps {
  annotationTools: AnnotationTool[];
  activeToolKey: string | null;
  onToolActivate: (key: string) => void;
  onSelectModeActivate: () => void;
  onAddTool: (text: string) => void;
  onDeleteTool: (index: number, e: React.MouseEvent) => void;
  onSaveTool: (index: number, newText: string) => void;
}

export default function AnnotationToolsPanel({
  annotationTools,
  activeToolKey,
  onToolActivate,
  onSelectModeActivate,
  onAddTool,
  onDeleteTool,
  onSaveTool,
}: AnnotationToolsPanelProps) {
  const [editingToolIndex, setEditingToolIndex] = useState<number | null>(null);
  const [editingToolText, setEditingToolText] = useState('');
  const [isAddingTool, setIsAddingTool] = useState(false);
  const [newToolText, setNewToolText] = useState('');

  const startEditingTool = (idx: number) => {
    setEditingToolIndex(idx);
    setEditingToolText(annotationTools[idx].text);
  };

  const saveEditingTool = () => {
    if (editingToolIndex === null) return;
    onSaveTool(editingToolIndex, editingToolText.trim());
    setEditingToolIndex(null);
    setEditingToolText('');
  };

  const handleAddTool = () => {
    if (!newToolText.trim()) { setIsAddingTool(false); setNewToolText(''); return; }
    onAddTool(newToolText.trim());
    setIsAddingTool(false);
    setNewToolText('');
  };

  const canAddTool = annotationTools.length < 10 && !isAddingTool;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-help-target="tool-palette">
      {/* Header */}
      <div className="flex items-center px-2 py-1.5 bg-slate-800 border-b border-slate-700 flex-none">
        <span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium">Labels</span>
      </div>

      {/* Tool Grid */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">

        {/* Row 1: Select (top-left) + Custom (top-right) — always 50:50 */}
        <div className="flex gap-1">
          {/* Select — wrapper provides the flex-1 so ToolCell's w-full fills half */}
          <div className="flex-1 min-w-0">
            <ToolCell
              isActive={activeToolKey === null}
              color="#374151"
              dotColor="#94a3b8"
              label="Select"
              hotkey="Esc"
              dotted
              onClick={onSelectModeActivate}
            />
          </div>
          {/* Custom (annotationTools[0]) */}
          {(() => {
            const custom = annotationTools[0];
            const isActive = custom.key === activeToolKey;
            const isEditing = editingToolIndex === 0;
            if (isEditing) {
              return (
                <div className="flex-1 min-w-0 flex flex-col bg-slate-800 p-1 rounded border border-slate-600">
                  <input
                    autoFocus
                    className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded w-full outline-none border border-slate-600 focus:border-[#e65161]"
                    value={editingToolText}
                    onChange={e => setEditingToolText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEditingTool();
                      if (e.key === 'Escape') setEditingToolIndex(null);
                    }}
                    onBlur={saveEditingTool}
                  />
                  <span className="text-[8px] text-orange-400 mt-0.5">Updates all matching</span>
                </div>
              );
            }
            return (
              <div className="flex-1 min-w-0">
                <ToolCell
                  isActive={isActive}
                  color={custom.color}
                  dotColor="#94a3b8"
                  label="Custom"
                  hotkey={custom.key}
                  onClick={() => onToolActivate(custom.key)}
                />
              </div>
            );
          })()}
        </div>

        {/* Defined labels — single scrollable column */}
        <div className="flex flex-col gap-1">
          {annotationTools.slice(1).map((tool, i) => {
            const idx = i + 1;
            const isActive = tool.key === activeToolKey;
            const isEditing = editingToolIndex === idx;

            if (isEditing) {
              return (
                <div key={tool.key} className="flex flex-col bg-slate-800 p-1 rounded border border-slate-600">
                  <input
                    autoFocus
                    className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded w-full outline-none border border-slate-600 focus:border-[#e65161]"
                    value={editingToolText}
                    onChange={e => setEditingToolText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEditingTool();
                      if (e.key === 'Escape') setEditingToolIndex(null);
                    }}
                    onBlur={saveEditingTool}
                  />
                  <span className="text-[8px] text-orange-400 mt-0.5">Updates all matching</span>
                </div>
              );
            }

            return (
              <div key={tool.key} className="relative group/cell overflow-hidden">
                <ToolCell
                  isActive={isActive}
                  color={tool.color}
                  dotColor={tool.color}
                  label={tool.text}
                  hotkey={tool.key}
                  onClick={() => onToolActivate(tool.key)}
                />
                <div className="absolute top-0 right-0 flex opacity-0 group-hover/cell:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); startEditingTool(idx); }}
                    className="text-blue-400 hover:text-blue-300 bg-slate-900/90 p-0.5 rounded-bl"
                    data-tooltip="Rename"
                  >
                    <Pencil size={9} />
                  </button>
                  <button
                    onClick={(e) => onDeleteTool(idx, e)}
                    className="text-red-500 hover:text-red-400 bg-slate-900/90 p-0.5 rounded-tr"
                    data-tooltip="Delete"
                  >
                    <X size={9} />
                  </button>
                </div>
              </div>
            );
          })}

          {/* Add label */}
          {isAddingTool ? (
            <div className="flex items-center bg-slate-800 rounded border border-slate-600 px-1.5 py-1 gap-1">
              <div
                className="w-3 h-3 rounded-full flex-none flex items-center justify-center"
                style={{ backgroundColor: HOTKEY_COLORS[annotationTools.length] }}
              >
                <span className="text-white text-[8px] font-bold">{annotationTools.length}</span>
              </div>
              <input
                autoFocus
                type="text"
                className="bg-transparent text-white text-xs outline-none flex-1 min-w-0"
                placeholder="Name…"
                value={newToolText}
                onChange={(e) => setNewToolText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddTool();
                  if (e.key === 'Escape') setIsAddingTool(false);
                }}
                onBlur={handleAddTool}
              />
            </div>
          ) : canAddTool ? (
            <button
              onClick={() => setIsAddingTool(true)}
              className="w-full flex items-center justify-center py-1 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-400 transition-all opacity-50 hover:opacity-100"
              data-tooltip="Add Label"
            >
              <Plus size={11} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
