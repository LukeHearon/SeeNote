import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { annotationToolEditModal } from '../copy/ui';
import { AnnotationTool, Annotation } from '../types';
import { HOTKEY_COLORS, SUPPORTED_AUDIO_EXTS } from '../constants';
import { openFilesDialog } from '../utils/tauriCommands';
import ColorSwatchPicker from './ColorSwatchPicker';

interface Props {
  tool: AnnotationTool;
  toolIndex: number;
  annotations: Annotation[];
  // All existing tools, used to block creating/renaming to a duplicate label.
  annotationTools: AnnotationTool[];
  // Create mode: the modal doubles as the "New tool" dialog. Suppresses the
  // rename warning and live color preview (there's no on-spectrogram tool yet),
  // and relabels the title/submit button.
  isCreate?: boolean;
  onClose: () => void;
  onSave: (newText: string, newColor: string, newDescription: string) => void;
  // Live (transient) color preview while the user is changing the color.
  // Omitted in create mode.
  onPreviewColor?: (toolIndex: number, color: string) => void;
  // Import example clips (files or folders) into this tool. Absent → no import
  // UI (e.g. for the synthetic Custom tool, which has no folder).
  onImportExamples?: (toolIndex: number, paths: string[]) => void | Promise<void>;
  // Open the read-only example library for this tool. Absent → no button.
  onShowExamples?: (toolIndex: number) => void;
}

export default function AnnotationToolEditModal({ tool, toolIndex, annotations, annotationTools, isCreate = false, onClose, onSave, onPreviewColor, onImportExamples, onShowExamples }: Props) {
  const [text, setText] = useState(tool.text);
  const [description, setDescription] = useState(tool.description ?? '');
  const [color, setColor] = useState(tool.color);

  const willRenameAnnotations = !isCreate && text.trim() !== tool.text;
  // Annotations already carrying this label that are Custom (white) will be
  // adopted by this tool once saved. Association is by label, so this covers
  // both create and rename-to-an-existing-label.
  const customMatchCount = annotations.filter(a => a.text === text.trim() && (a.color === undefined || a.color === '#ffffff')).length;

  // On create, block an exact (case-sensitive) label collision outright, and
  // warn (without blocking) on a case-insensitive-only collision.
  const trimmedText = text.trim();
  const otherTools = annotationTools.filter((_, i) => i !== toolIndex);
  const isExactDuplicate = isCreate && otherTools.some(t => t.text === trimmedText);
  const similarTools = isCreate && trimmedText !== ''
    ? otherTools.filter(t => t.text !== trimmedText && t.text.toLowerCase() === trimmedText.toLowerCase())
    : [];

  const swatchColors = HOTKEY_COLORS.slice(1).filter(c => c !== '#64748b');

  // The original color, used to revert the live preview if the user cancels.
  const originalColorRef = useRef(tool.color);

  // Live-preview the color as it changes. Skip the initial mount so it doesn't
  // fire with the unchanged color.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    onPreviewColor?.(toolIndex, color);
  }, [color]);

  // Cancel/X path: revert the live preview to the original color, then close.
  const handleCancel = () => {
    onPreviewColor?.(toolIndex, originalColorRef.current);
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
          {isExactDuplicate && (
            <p className="text-xs text-red-400 mt-1">{annotationToolEditModal.duplicateLabelError}</p>
          )}
          {!isExactDuplicate && similarTools.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">{annotationToolEditModal.similarLabelWarning(similarTools.map(t => t.text))}</p>
          )}
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
          <ColorSwatchPicker
            value={color}
            swatchColors={swatchColors}
            onChange={setColor}
            customColorTitle={annotationToolEditModal.customColorTitle}
          />
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
            onClick={() => { onSave(text.trim(), color, description.trim()); onClose(); }}
            disabled={isCreate && (text.trim() === '' || isExactDuplicate)}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded transition-colors"
          >
            {isCreate ? annotationToolEditModal.createButton : annotationToolEditModal.saveButton}
          </button>
        </div>
      </div>
    </div>
  );
}
