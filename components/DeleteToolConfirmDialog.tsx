import React from 'react';
import { AnnotationTool } from '../types';

interface Props {
  tool: AnnotationTool;
  linkedCount: number;
  onClose: () => void;
  onDelete: () => void;
  onUnlink: () => void;
}

export default function DeleteToolConfirmDialog({ tool, linkedCount, onClose, onDelete, onUnlink }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-80 p-5 shadow-2xl flex flex-col gap-4">
        <p className="text-sm text-white">
          Delete "{tool.text}"? It has {linkedCount} linked annotation(s).
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
          >
            Delete Annotations
          </button>
          <button
            onClick={onUnlink}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
          >
            Unlink Annotations
          </button>
        </div>
      </div>
    </div>
  );
}
