import React, { useState } from 'react';
import { Bug, Copy, Check, X, Activity, Loader2 } from 'lucide-react';
import { tooltips } from '../copy/tooltips';
import { debugConsole } from '../copy/ui';
import { useDiagnosticInfo } from '../hooks/useDiagnosticInfo';
import { APP_VERSION } from '../utils/appVersion';
import { measureLoopbackLatency, formatLoopbackResult } from '../utils/audioLoopback';

export interface DebugLog { time: string; msg: string; type: 'info' | 'error'; }

/** True only under `npm run tauri dev`. Vite replaces this at build time, so
 *  the loopback test and everything it imports are dropped from a release. */
const DEV_MODE = import.meta.env.DEV;

interface DebugConsolePanelProps {
  logs: DebugLog[];
  /** When set, the header shows a close button. Omitted by the guide's copy. */
  onClose?: () => void;
}

/**
 * Dev-only microphone loopback test — see utils/audioLoopback.ts for what it
 * measures and why nothing else can. Self-contained (it opens its own context
 * and mic), so it works in both hosts of this panel without either of them
 * handing it engine access.
 *
 * Its strings are inline rather than in `copy/ui.ts` on purpose: the copy module
 * is always reachable, so keys added there survive into the release bundle and
 * show up in the copy editor for a feature that release builds don't contain.
 */
function LoopbackTest() {
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    setState('running');
    setFailed(false);
    setLines([]);
    const push = (m: string) => setLines(prev => [...prev, m]);
    try {
      const result = await measureLoopbackLatency({ onProgress: push });
      push(formatLoopbackResult(result));
      push(`per click: ${result.perClickSec.map(s => `${(s * 1000).toFixed(0)}ms`).join(', ')}`);
    } catch (err) {
      setFailed(true);
      push(String(err instanceof Error ? err.message : err));
    } finally {
      setState('idle');
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-700">
      <div className="flex items-center gap-2">
        <button
          onClick={run}
          disabled={state === 'running'}
          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-default text-slate-200 transition-colors"
        >
          {state === 'running'
            ? <Loader2 size={13} className="animate-spin" />
            : <Activity size={13} />}
          Measure audio latency
        </button>
        <span className="text-xs text-slate-500">dev only · needs the mic, speakers on</span>
      </div>
      {lines.length > 0 && (
        <div className={`mt-2 font-mono text-xs ${failed ? 'text-amber-400' : 'text-slate-300'}`}>
          {lines.map((l, i) => <div key={i} className="mb-0.5">{l}</div>)}
        </div>
      )}
    </div>
  );
}

/**
 * The console body — diagnostic line, log list, copy button. No backdrop, so it
 * embeds anywhere: the app wraps it in `DebugConsole`'s modal, the help guide
 * drops it straight onto the page.
 */
export function DebugConsolePanel({ logs, onClose }: DebugConsolePanelProps) {
  const [copied, setCopied] = useState(false);
  const { info, error: diagError } = useDiagnosticInfo(true);
  // The version comes from the build, not from `info`, so this line renders
  // even when the invoke fails — and says so when it does, rather than
  // quietly dropping to nothing.
  const diagLine = `SeeNote v${APP_VERSION} · ${
    info ? [
      `${info.os} ${info.arch}`,
      `webview ${info.webview}`,
      // Constant in anything a user is running, so it's noise unless it isn't.
      ...(info.build === 'release' ? [] : [info.build]),
    ].join(' · ')
    : diagError ? `system info unavailable: ${diagError}`
    : 'reading system info…'
  }`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xl font-bold flex items-center gap-2"><Bug size={20} className="text-[#e65161]" /> {debugConsole.title}</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const text = [diagLine, ...logs.map(l => `[${l.time}] ${l.msg}`)].join('\n');
              navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
            data-tooltip={tooltips.copyLogs}
          >
            {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
          </button>
          {onClose && <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20}/></button>}
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-slate-900 rounded p-4 overflow-y-auto font-mono text-sm border border-slate-700">
        <div className={`mb-2 pb-2 border-b border-slate-700 ${diagError ? 'text-amber-400' : 'text-slate-400'}`}>
          {diagLine}
        </div>
        {logs.length === 0 ? <span className="text-slate-500 italic">{debugConsole.noLogs}</span> : (
          logs.map((log, i) => (
            <div key={i} className={`mb-1 ${log.type === 'error' ? 'text-red-400' : 'text-slate-300'}`}>
              <span className="text-slate-500 mr-2">[{log.time}]</span>
              {log.msg}
            </div>
          ))
        )}
      </div>
      {DEV_MODE && <LoopbackTest />}
    </div>
  );
}

interface DebugConsoleProps {
  open: boolean;
  onClose: () => void;
  logs: DebugLog[];
}

export default function DebugConsole({ open, onClose, logs }: DebugConsoleProps) {
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
        <DebugConsolePanel logs={logs} onClose={onClose} />
      </div>
    </div>
  );
}
