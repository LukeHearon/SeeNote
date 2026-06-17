import React from 'react';
import { X } from 'lucide-react';

export interface ModalTab {
  label: string;
  active: boolean;
  onClick: () => void;
}

interface Props {
  title: string;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
  tabs?: ModalTab[];
}

export default function SettingsModalShell({ title, onClose, footer, children, tabs }: Props) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
        <h2 className="text-white text-lg font-semibold">{title}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
          <X size={20} />
        </button>
      </div>
      {tabs && tabs.length > 0 && (
        <div className="flex px-6 border-b border-gray-700 flex-none">
          {tabs.map(t => (
            <button
              key={t.label}
              onClick={t.onClick}
              className={`px-4 py-2.5 text-sm border-b-2 transition-colors -mb-px ${
                t.active
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-4 px-6 py-4 overflow-y-auto flex-1 min-h-0">
        {children}
      </div>
      <div className="flex gap-3 px-6 py-4 justify-end border-t border-gray-700 flex-none">
        {footer}
      </div>
    </div>
  );
}
