import React, { useState } from 'react';
import { Bug, Copy, Check, X } from 'lucide-react';

interface DebugLog { time: string; msg: string; type: 'info' | 'error'; }

export interface DebugControls {
  /** Replace the Tauri asset URL with a blob:// URL when loading the <video>
   *  element. Tests whether Tauri's custom protocol is the source of stalls
   *  (cause #1). Toggle on, reload the file, and compare. */
  blobUrl: boolean;
  /** Draw the <video> element to a 2D canvas each RAF frame instead of letting
   *  WKWebView composite the native video layer. Tests whether the freeze is a
   *  GPU compositing failure (cause #2): if the canvas shows frames while the
   *  native element is dark, cause #2 is confirmed. */
  canvasMirror: boolean;
  /** Preroll timeout for the WebCodecs frame-decode step that gates AudioEngine
   *  starting in Mixed+selection / Accurate modes. 'skip' starts audio
   *  immediately; '2s' races preroll against a 2-second timer. Tests cause #3
   *  (WebCodecs too slow to preroll on the machine). */
  prerollTimeout: 'normal' | '2s' | 'skip';
}

export const DEFAULT_DEBUG_CONTROLS: DebugControls = {
  blobUrl: false,
  canvasMirror: false,
  prerollTimeout: 'normal',
};

interface DebugConsoleProps {
  open: boolean;
  onClose: () => void;
  logs: DebugLog[];
  controls: DebugControls;
  onControlsChange: (c: DebugControls) => void;
}

export default function DebugConsole({ open, onClose, logs, controls, onControlsChange }: DebugConsoleProps) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;

  const set = <K extends keyof DebugControls>(key: K, value: DebugControls[K]) =>
    onControlsChange({ ...controls, [key]: value });

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-2xl w-full h-[680px] flex flex-col p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2"><Bug size={20} className="text-[#e65161]" /> Debug Console</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const text = logs.map(l => `[${l.time}] ${l.msg}`).join('\n');
                navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
              data-tooltip="Copy logs"
              disabled={logs.length === 0}
            >
              {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20}/></button>
          </div>
        </div>

        {/* ── Debug toggles ──────────────────────────────────────────────── */}
        <div className="mb-4 bg-slate-900/60 border border-slate-700 rounded-md p-3 space-y-3">
          <p className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase">Debug Controls</p>

          {/* Blob URL */}
          <label className="flex items-start gap-3 cursor-pointer select-none group">
            <input
              type="checkbox"
              className="mt-0.5 accent-[#e65161] shrink-0"
              checked={controls.blobUrl}
              onChange={e => set('blobUrl', e.target.checked)}
            />
            <span>
              <span className="text-sm font-medium text-slate-200">Blob URL mode</span>
              <span className="block text-xs text-slate-500 mt-0.5">
                Fetches the file in full and feeds it to the &lt;video&gt; element as a
                <code className="mx-1 text-slate-400">blob://</code>URL, bypassing the Tauri
                asset protocol. If video plays correctly with this on, the Tauri protocol is
                the cause (range-request issue).
              </span>
            </span>
          </label>

          {/* Canvas mirror */}
          <label className="flex items-start gap-3 cursor-pointer select-none group">
            <input
              type="checkbox"
              className="mt-0.5 accent-[#e65161] shrink-0"
              checked={controls.canvasMirror}
              onChange={e => set('canvasMirror', e.target.checked)}
            />
            <span>
              <span className="text-sm font-medium text-slate-200">Canvas mirror <span className="text-[10px] font-normal text-slate-500">(Fast / Mixed-no-selection only)</span></span>
              <span className="block text-xs text-slate-500 mt-0.5">
                Draws the &lt;video&gt; element to a 2D canvas each frame via
                <code className="mx-1 text-slate-400">ctx.drawImage</code>
                instead of relying on WKWebView's native video layer. If the canvas
                shows frames while the native element is dark, GPU compositing is the cause.
              </span>
            </span>
          </label>

          {/* Preroll timeout */}
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-4 shrink-0" />
            <span className="flex-1">
              <span className="text-sm font-medium text-slate-200">Preroll timeout <span className="text-[10px] font-normal text-slate-500">(Mixed+selection / Accurate only)</span></span>
              <span className="block text-xs text-slate-500 mt-0.5 mb-2">
                Controls how long the app waits for WebCodecs to decode the first frame
                before starting AudioEngine. If audio plays when set to Skip but not
                on Normal, preroll is the bottleneck.
              </span>
              <div className="flex gap-2">
                {(['normal', '2s', 'skip'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => set('prerollTimeout', opt)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      controls.prerollTimeout === opt
                        ? 'bg-[#e65161] text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {opt === 'normal' ? 'Normal (wait fully)' : opt === '2s' ? '2s timeout' : 'Skip'}
                  </button>
                ))}
              </div>
            </span>
          </div>
        </div>

        {/* ── Log output ─────────────────────────────────────────────────── */}
        <div className="flex-1 bg-slate-900 rounded p-4 overflow-y-auto font-mono text-sm border border-slate-700">
          {logs.length === 0 ? <span className="text-slate-500 italic">No logs yet...</span> : (
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
