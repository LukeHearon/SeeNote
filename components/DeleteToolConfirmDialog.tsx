import React from 'react';
import { AnnotationTool } from '../types';
import { deleteToolConfirmDialog } from '../copy/ui';

interface Props {
  tool: AnnotationTool;
  onClose: () => void;
  onDelete: () => void;
  onUnlink: () => void;
}

export default function DeleteToolConfirmDialog({ tool, onClose, onDelete, onUnlink }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-96 p-5 shadow-2xl flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-white">{deleteToolConfirmDialog.title(tool.text)}</p>
          <p className="text-xs text-slate-400">
            {deleteToolConfirmDialog.unlinkExplanation}
            <br />
            {deleteToolConfirmDialog.deleteExplanation}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
          >
            {deleteToolConfirmDialog.cancelButton}
          </button>
          <button
            onClick={onUnlink}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
          >
            {deleteToolConfirmDialog.unlinkButton}
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
          >
            {deleteToolConfirmDialog.deleteButton}
          </button>
        </div>
      </div>
    </div>
  );
}
