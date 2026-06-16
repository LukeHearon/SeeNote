import React from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}

export default function SettingsModalShell({ title, onClose, footer, children }: Props) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
        <h2 className="text-white text-lg font-semibold">{title}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
          <X size={20} />
        </button>
      </div>
      <div className="space-y-4 px-6 py-4 overflow-y-auto flex-1 min-h-0">
        {children}
      </div>
      <div className="flex gap-3 px-6 py-4 justify-end border-t border-gray-700 flex-none">
        {footer}
      </div>
    </div>
  );
}
