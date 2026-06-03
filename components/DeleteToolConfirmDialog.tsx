import React from 'react';
import { AnnotationTool } from '../types';

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
          <p className="text-sm text-white">Delete "{tool.text}"?</p>
          <p className="text-xs text-slate-400">
            <span className="text-slate-200">Unlink</span> — removes the tool and reassigns its annotations to Custom across all files.
            <br />
            <span className="text-slate-200">Delete</span> — removes the tool and permanently deletes all its annotations across all files.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onUnlink}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
          >
            Unlink
          </button>
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
