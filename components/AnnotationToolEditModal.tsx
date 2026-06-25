import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { annotationToolEditModal } from '../copy/ui';
import { HexColorPicker } from 'react-colorful';
import { AnnotationTool, Annotation } from '../types';
import { HOTKEY_COLORS, SUPPORTED_AUDIO_EXTS } from '../constants';
import { openFilesDialog } from '../utils/tauriCommands';

// Rainbow gradient shared by the custom-color swatch fill and its active ring.
const RAINBOW_GRADIENT = 'linear-gradient(to right, #ef4444, #f97316, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7)';

interface Props {
  tool: AnnotationTool;
  toolIndex: number;
  annotations: Annotation[];
  onClose: () => void;
  onSave: (toolIndex: number, newText: string, newColor: string, newDescription: string) => void;
  // Live (transient) color preview while the user is changing the color.
  onPreviewColor: (toolIndex: number, color: string) => void;
  // Import example clips (files or folders) into this tool. Absent → no import
  // UI (e.g. for the synthetic Custom tool, which has no folder).
  onImportExamples?: (toolIndex: number, paths: string[]) => void | Promise<void>;
  // Open the read-only example library for this tool. Absent → no button.
  onShowExamples?: (toolIndex: number) => void;
}

export default function AnnotationToolEditModal({ tool, toolIndex, annotations, onClose, onSave, onPreviewColor, onImportExamples, onShowExamples }: Props) {
  const [text, setText] = useState(tool.text);
  const [description, setDescription] = useState(tool.description ?? '');
  const [color, setColor] = useState(tool.color);
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const willRenameAnnotations = text.trim() !== tool.text;
  const customMatchCount = annotations.filter(a => a.toolKey === '0' && a.text === text.trim()).length;

  const swatchColors = HOTKEY_COLORS.slice(1).filter(c => c !== '#64748b');

  // Explicit custom-color mode. Initialized active if the tool's current color
  // isn't one of the fixed swatches, so editing an existing custom color shows
  // the rainbow swatch as selected on open.
  const [customActive, setCustomActive] = useState(!swatchColors.includes(tool.color));

  // The original color, used to revert the live preview if the user cancels.
  const originalColorRef = useRef(tool.color);

  // Live-preview the color as it changes. Skip the initial mount so it doesn't
  // fire with the unchanged color.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    onPreviewColor(toolIndex, color);
  }, [color]);

  // Cancel/X path: revert the live preview to the original color, then close.
  const handleCancel = () => {
    onPreviewColor(toolIndex, originalColorRef.current);
    onClose();
  };

  // The Custom tool (key '0') is synthetic and has no folder, so no import UI.
  const canImport = onImportExamples != null && tool.key !== '0';
  const hasExamples = (tool.exampleFiles?.length ?? 0) > 0;

  const handleImport = async () => {
    const paths = await openFilesDialog(null, [
      { name: 'Audio', extensions: [...SUPPORTED_AUDIO_EXTS] },
    ]);
    if (paths && paths.length > 0) await onImportExamples!(toolIndex, paths);
  };

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
            <label className="text-xs text-slate-400">{annotationToolEditModal.labelField}</label>
            <button onClick={handleCancel} className="p-0.5 rounded text-slate-400 hover:text-white transition-colors">
              <X size={16} />
            </button>
          </div>
          <input
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs text-slate-400 mb-1 block">{annotationToolEditModal.descriptionField}</label>
          <textarea
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500 resize-none"
            rows={3}
            placeholder={annotationToolEditModal.descriptionPlaceholder}
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>

        {willRenameAnnotations && (
          <p className="text-xs text-amber-400">{annotationToolEditModal.renameWarning}</p>
        )}
        {customMatchCount > 0 && (
          <p className="text-xs text-blue-400">{annotationToolEditModal.reassociateWarning(customMatchCount)}</p>
        )}

        <div>
          <label className="text-xs text-slate-400 mb-2 block">{annotationToolEditModal.colorField}</label>
          <div className="flex gap-1">
            {swatchColors.map(c => (
              <button
                key={c}
                onClick={() => { setCustomActive(false); setColor(c); }}
                className={`w-6 h-6 rounded cursor-pointer transition-all border-2 ${!customActive && color === c ? 'border-white scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <div ref={pickerRef} className="relative">
              {customActive ? (
                // Active: solid selected color inside a rainbow ring (the gradient
                // background shows through the padding around the inner swatch).
                <button
                  onClick={() => { setCustomActive(true); setShowPicker(v => !v); }}
                  className="w-6 h-6 rounded cursor-pointer transition-all scale-110 p-[2px]"
                  style={{ background: RAINBOW_GRADIENT }}
                  title={annotationToolEditModal.customColorTitle}
                >
                  <span className="block w-full h-full rounded-sm" style={{ backgroundColor: color }} />
                </button>
              ) : (
                // Inactive: plain rainbow fill, no outline.
                <button
                  onClick={() => { setCustomActive(true); setShowPicker(v => !v); }}
                  className="w-6 h-6 rounded cursor-pointer transition-all border-2 border-transparent"
                  style={{ background: RAINBOW_GRADIENT }}
                  title={annotationToolEditModal.customColorTitle}
                />
              )}
              {showPicker && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-10 border border-white/50 rounded-lg overflow-hidden">
                  <HexColorPicker color={color} onChange={setColor} />
                </div>
              )}
            </div>
          </div>
        </div>

        {canImport && (
          <div>
            <label className="text-xs text-slate-400 mb-2 block">{annotationToolEditModal.exampleClipsField}</label>
            <div className="flex gap-2">
              <button
                onClick={handleImport}
                className="flex-1 px-2 py-1.5 text-xs text-slate-200 bg-slate-700 hover:bg-slate-600 rounded transition-colors"
              >
                {annotationToolEditModal.importButton}
              </button>
              {hasExamples && onShowExamples && (
                <button
                  onClick={() => onShowExamples(toolIndex)}
                  className="flex-1 px-2 py-1.5 text-xs text-slate-200 bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                >
                  {annotationToolEditModal.viewButton}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
          >
            {annotationToolEditModal.cancelButton}
          </button>
          <button
            onClick={() => { onSave(toolIndex, text.trim(), color, description.trim()); onClose(); }}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
          >
            {annotationToolEditModal.saveButton}
          </button>
        </div>
      </div>
    </div>
  );
}
