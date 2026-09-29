import React from 'react';

/**
 * A modal with a title, a message, and one dismiss button — for reporting an
 * error the user has to see rather than a line in the debug console.
 */
export default function MessageDialog({ title, message, okLabel, onClose }: {
  title: string;
  message: string;
  okLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-5 max-w-md mx-4">
        <h3 className="text-sm font-semibold text-slate-100 mb-2">{title}</h3>
        <p className="text-xs text-slate-300 leading-relaxed mb-4">{message}</p>
        <div className="flex justify-end">
          <button
            className="px-3 py-1.5 text-xs rounded bg-slate-700 text-slate-100 hover:bg-slate-600"
            onClick={onClose}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
