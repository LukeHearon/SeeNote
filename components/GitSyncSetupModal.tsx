import React from 'react';
import { X, GitBranch, ShieldCheck } from 'lucide-react';
import { gitSyncSetupModal } from '../copy/ui';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';

interface Props {
  onClose: () => void;
  /** When true, renders as a full window instead of an in-app modal overlay. */
  standalone?: boolean;
}

/**
 * Informational step-by-step for setting up a git-tracked (synced) project.
 * Pure guidance — it performs no actions; the actual config is entered in
 * Project Settings → Sync (see ProjectSettingsModal). Instructions target a
 * normal personal GitHub account, not an org/bot setup.
 *
 * GitHub URLs are shown as plain text rather than links: the app runs in a
 * Tauri webview with no external-link opener, so a real <a href> would navigate
 * the app away. Users copy the paths into a browser.
 */
export default function GitSyncSetupModal({ onClose, standalone }: Props) {
  const monoRenderer = (text: string, key: number) => (
    <span key={key} className="font-mono text-xs text-blue-300 bg-gray-800 rounded px-1 py-0.5 break-all">
      {text}
    </span>
  );

  const md = (str: string) => renderInlineMarkdown(str, { codeRenderer: monoRenderer });

  const card = (
    <div
      className={standalone
        ? 'bg-gray-900 flex flex-col h-screen overflow-hidden'
        : 'bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl h-[680px] max-h-[88vh] flex flex-col shadow-2xl overflow-hidden'}
      onMouseDown={e => e.stopPropagation()}
    >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-blue-400" />
            <h2 className="text-white text-lg font-semibold">{gitSyncSetupModal.title}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0 text-sm text-gray-300 space-y-5">
          <p>{md(gitSyncSetupModal.introP)}</p>

          <Step n={1} title={gitSyncSetupModal.step1_title}>
            <p>{md(gitSyncSetupModal.step1_p1)}</p>
          </Step>

          <Step n={2} title={gitSyncSetupModal.step2_title}>
            <p>{md(gitSyncSetupModal.step2_p1)}</p>
          </Step>

          <Step n={3} title={gitSyncSetupModal.step3_title}>
            <p>{md(gitSyncSetupModal.step3_intro)}</p>
            <p className="mt-1">{md(gitSyncSetupModal.step3_path)}</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>{md(gitSyncSetupModal.step3_li1)}</li>
              <li>{md(gitSyncSetupModal.step3_li2)}</li>
              <li>{md(gitSyncSetupModal.step3_li3)}</li>
              <li>{md(gitSyncSetupModal.step3_li4)}</li>
            </ul>
          </Step>

          <Step n={4} title={gitSyncSetupModal.step4_title}>
            <p>{md(gitSyncSetupModal.step4_intro)}</p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>{md(gitSyncSetupModal.step4_li1)}</li>
              <li>{md(gitSyncSetupModal.step4_li2)}</li>
              <li>{md(gitSyncSetupModal.step4_li3)}</li>
            </ul>
            <p className="mt-2">{md(gitSyncSetupModal.step4_save)}</p>
          </Step>

          <Step n={5} title={gitSyncSetupModal.step5_title}>
            <p>{md(gitSyncSetupModal.step5_p1)}</p>
            <p className="mt-2">{md(gitSyncSetupModal.step5_p2)}</p>
          </Step>

          <Step n={6} title={gitSyncSetupModal.step6_title}>
            <p>{md(gitSyncSetupModal.step6_p1)}</p>
          </Step>

          <div className="flex items-start gap-2 bg-blue-950/40 border border-blue-900 rounded-lg px-4 py-3">
            <ShieldCheck size={16} className="text-blue-400 flex-none mt-0.5" />
            <p className="text-blue-200 text-xs leading-relaxed">
              {md(gitSyncSetupModal.securityNote)}
            </p>
          </div>
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-gray-700 flex-none">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm transition-colors"
          >
            {gitSyncSetupModal.gotItButton}
          </button>
        </div>
      </div>
  );

  if (standalone) return card;

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      {card}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-none w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="min-w-0">
        <h3 className="text-white font-medium mb-1">{title}</h3>
        {children}
      </div>
    </div>
  );
}
