import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { AnnotationTool, Annotation } from '../types';
import { HOTKEY_COLORS } from '../constants';

interface Props {
  tool: AnnotationTool;
  toolIndex: number;
  annotations: Annotation[];
  onClose: () => void;
  onSave: (toolIndex: number, newText: string, newColor: string) => void;
  onDelete: (toolIndex: number) => void;
}

export default function AnnotationToolEditModal({ tool, toolIndex, annotations, onClose, onSave, onDelete }: Props) {
  const [text, setText] = useState(tool.text);
  const [color, setColor] = useState(tool.color);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const linkedCount = annotations.filter(a => a.toolKey === tool.key).length;
  const willRenameAnnotations = text.trim() !== tool.text && linkedCount > 0;
  const customMatchCount = annotations.filter(a => a.toolKey === '0' && a.text === text.trim()).length;

  const swatchColors = HOTKEY_COLORS.slice(1).filter(c => c !== '#64748b');

  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-72 p-5 shadow-2xl flex flex-col gap-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-slate-400">Tool Name</label>
            <button onClick={onClose} className="p-0.5 rounded text-slate-400 hover:text-white transition-colors">
              <X size={16} />
            </button>
          </div>
          <input
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </div>

        {willRenameAnnotations && (
          <p className="text-xs text-amber-400">Will rename {linkedCount} annotation(s)</p>
        )}
        {customMatchCount > 0 && (
          <p className="text-xs text-blue-400">Will reassociate {customMatchCount} Custom annotation(s) to this tool</p>
        )}

        <div>
          <label className="text-xs text-slate-400 mb-2 block">Color</label>
          <div className="flex gap-1">
            {swatchColors.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-6 h-6 rounded cursor-pointer transition-all border-2 ${color === c ? 'border-white scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <div ref={pickerRef} className="relative">
              <button
                onClick={() => setShowPicker(v => !v)}
                className={`w-6 h-6 rounded cursor-pointer transition-all border-2 ${!swatchColors.includes(color) ? 'border-white scale-110' : 'border-transparent'}`}
                style={{ background: 'linear-gradient(to right, #ef4444, #f97316, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7)' }}
                title="Custom color"
              />
              {showPicker && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-10 border border-white/50 rounded-lg overflow-hidden">
                  <HexColorPicker color={color} onChange={setColor} />
                </div>
              )}
            </div>
          </div>
        </div>

        {showDeleteConfirm ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-red-400">
              {linkedCount} {linkedCount > 1 ? 'annotations' : 'annotation'} reference '{tool.text}'. Deleting this Annotation Tool will convert existing annotations to Custom Annotations. If you make a new tool with the same label, the existing annotations will be reconnected.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(toolIndex); onClose(); }}
                className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
              >
                Delete Tool
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                if (linkedCount === 0) {
                  onDelete(toolIndex);
                  onClose();
                } else {
                  setShowDeleteConfirm(true);
                }
              }}
              className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition-colors"
            >
              Delete
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onSave(toolIndex, text.trim(), color); onClose(); }}
                className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
