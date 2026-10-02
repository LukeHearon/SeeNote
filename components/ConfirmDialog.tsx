import React from 'react';
import ModalBackdrop from './ModalBackdrop';

export interface DialogAction {
  label: string;
  onClick: () => void;
  /** 'primary' (blue), 'danger' (red), or the default quiet button. */
  tone?: 'primary' | 'danger';
  disabled?: boolean;
}

const BUTTON_TONE = {
  primary: 'bg-blue-600 hover:bg-blue-500 text-white',
  danger: 'bg-red-600 hover:bg-red-500 text-white',
  quiet: 'bg-slate-700 hover:bg-slate-600 text-slate-200',
};

/**
 * A titled dialog with a message, optional extra content, and a row of
 * actions — confirmations, warnings and error reports alike. Escape and a
 * click outside call `onDismiss`.
 */
export default function ConfirmDialog({ title, message, icon, actions, onDismiss, children }: {
  title: string;
  message?: React.ReactNode;
  icon?: React.ReactNode;
  actions: DialogAction[];
  onDismiss: () => void;
  children?: React.ReactNode;
}) {
  return (
    <ModalBackdrop onDismiss={onDismiss} dismissOnBackdrop layer="dialog">
      <div className="bg-gray-800 rounded-xl border border-gray-700 shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-start gap-3">
          {icon && <span className="flex-none mt-0.5">{icon}</span>}
          <div className="min-w-0">
            <h3 className="text-white font-semibold text-base">{title}</h3>
            {message && <div className="text-gray-400 text-sm mt-1 whitespace-pre-wrap">{message}</div>}
          </div>
        </div>
        {children}
        <div className="flex gap-3 justify-end pt-2">
          {actions.map(a => (
            <button
              key={a.label}
              disabled={a.disabled}
              onClick={a.onClick}
              className={`px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${BUTTON_TONE[a.tone ?? 'quiet']}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </ModalBackdrop>
  );
}
