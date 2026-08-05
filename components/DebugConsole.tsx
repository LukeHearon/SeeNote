import React, { useEffect, useState } from 'react';
import { Bug, Copy, Check, X } from 'lucide-react';
import { tooltips } from '../copy/tooltips';
import { debugConsole } from '../copy/ui';
import { getDiagnosticInfo } from '../utils/tauriCommands';

interface DebugLog { time: string; msg: string; type: 'info' | 'error'; }

interface DebugConsoleProps {
  open: boolean;
  onClose: () => void;
  logs: DebugLog[];
}

export default function DebugConsole({ open, onClose, logs }: DebugConsoleProps) {
  const [copied, setCopied] = useState(false);
  const [diagLine, setDiagLine] = useState<string | null>(null);

  useEffect(() => {
    if (!open || diagLine) return;
    getDiagnosticInfo()
      .then((d) => setDiagLine(`SeeNote v${d.app_version} · ${d.os} ${d.arch} · ${d.build}`))
      .catch(() => {});
  }, [open, diagLine]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-2xl w-full h-[600px] flex flex-col p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2"><Bug size={20} className="text-[#e65161]" /> {debugConsole.title}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const text = [diagLine, ...logs.map(l => `[${l.time}] ${l.msg}`)]
                  .filter((line): line is string => line !== null)
                  .join('\n');
                navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
              data-tooltip={tooltips.copyLogs}
              disabled={logs.length === 0 && !diagLine}
            >
              {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20}/></button>
          </div>
        </div>
        <div className="flex-1 bg-slate-900 rounded p-4 overflow-y-auto font-mono text-sm border border-slate-700">
          {diagLine && (
            <div className="mb-2 pb-2 border-b border-slate-700 text-slate-400">{diagLine}</div>
          )}
          {logs.length === 0 ? <span className="text-slate-500 italic">{debugConsole.noLogs}</span> : (
            logs.map((log, i) => (
              <div key={i} className={`mb-1 ${log.type === 'error' ? 'text-red-400' : 'text-slate-300'}`}>
                <span className="text-slate-500 mr-2">[{log.time}]</span>
                {log.msg}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
