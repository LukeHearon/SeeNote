import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { RotateCcw, Save, Crosshair } from 'lucide-react';
import { buildRegistry } from '../copy/registry';
import {
  setOverride, clearOverrides, getAllOverrides, getAccessedKeys,
  useCopyRerenderOnChange, copyChannel,
} from '../copy/overrideStore';
import { applyCopyOverrides } from '../utils/tauriCommands';

export function CopyEditor() {
  useCopyRerenderOnChange();
  const base = useMemo(() => buildRegistry(), []);

  const viewKeys = useMemo(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('copy:accessedKeys') : null;
      if (raw) return new Set<string>(JSON.parse(raw) as string[]);
    } catch { /* */ }
    return new Set<string>(getAccessedKeys());
  }, []);

  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [pickActive, setPickActive] = useState(false);
  const [commitOutput, setCommitOutput] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!copyChannel) return;
    const handler = (e: MessageEvent) => {
      const { type, key, active } = (e.data ?? {}) as Record<string, unknown>;
      if (type === 'pick' && typeof key === 'string') {
        setSearch(key);
        if (!viewKeys.has(key)) setShowAll(true);
      } else if (type === 'toggleShowAll') {
        setShowAll(p => !p);
      } else if (type === 'pickModeChanged') {
        setPickActive(!!active);
      }
    };
    copyChannel.addEventListener('message', handler);
    return () => copyChannel.removeEventListener('message', handler);
  }, [viewKeys]);

  const entries = useMemo(() => {
    const q = search.toLowerCase();
    return Object.entries(base).filter(([k, v]) => {
      if (!showAll && !viewKeys.has(k)) return false;
      return !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q);
    });
  }, [base, search, showAll, viewKeys]);

  const handleChange = useCallback((key: string, value: string) => {
    setOverride(key, value);
    setTick(t => t + 1);
    setCommitOutput(null);
  }, []);

  const overrides = getAllOverrides();
  const dirty = Object.fromEntries(Object.entries(overrides).filter(([k, v]) => v !== base[k]));
  const dirtyCount = Object.keys(dirty).length;

  const handleReset = () => {
    clearOverrides();
    setTick(t => t + 1);
    setCommitOutput(null);
  };

  const handleCommit = async () => {
    if (!dirtyCount) return;
    setCommitting(true);
    setCommitOutput(null);
    try {
      const out = await applyCopyOverrides(dirty);
      setCommitOutput(out);
    } catch (e) {
      setCommitOutput(`Error: ${e}`);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 flex-none">
        <div className="flex items-center gap-2">
          <span className="text-white font-semibold text-sm">Copy Editor</span>
          <button
            onClick={() => setShowAll(s => !s)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${showAll ? 'bg-slate-600 text-slate-200' : 'bg-slate-700 text-slate-400 hover:text-slate-200'}`}
          >
            {showAll ? 'All strings' : 'Current view'}
          </button>
          <button
            onClick={() => copyChannel?.postMessage({ type: 'togglePick' })}
            title="Toggle pick mode in the main window (⌘⇧E)"
            className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors ${pickActive ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-400 hover:text-slate-200'}`}
          >
            <Crosshair size={12} />
            {pickActive ? 'Picking…' : 'Pick'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {dirtyCount > 0 && (
            <button
              onClick={handleReset}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-slate-700 transition-colors"
            >
              <RotateCcw size={12} /> Reset
            </button>
          )}
          {dirtyCount > 0 && (
            <button
              onClick={handleCommit}
              disabled={committing}
              className="flex items-center gap-1 text-xs bg-[#e65161] hover:bg-[#d04050] text-white px-3 py-1 rounded transition-colors disabled:opacity-50"
            >
              <Save size={12} /> {committing ? 'Applying…' : `Apply ${dirtyCount} change${dirtyCount > 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-2 border-b border-slate-700 flex-none">
        <input
          type="text"
          placeholder="Search keys or values…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-slate-400"
          autoFocus
        />
      </div>

      {commitOutput && (
        <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 text-xs text-slate-300 font-mono whitespace-pre-wrap flex-none max-h-32 overflow-y-auto">
          {commitOutput}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-900 border-b border-slate-700">
            <tr>
              <th className="text-left px-4 py-2 text-slate-500 font-medium w-[40%]">Key</th>
              <th className="text-left px-4 py-2 text-slate-500 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, baseVal]) => {
              const current = getAllOverrides()[key] ?? baseVal;
              const isDirty = current !== baseVal;
              return (
                <tr key={key} className={`border-b border-slate-800 ${isDirty ? 'bg-amber-950/20' : ''}`}>
                  <td className="px-4 py-2 font-mono text-slate-400 align-top">{key}</td>
                  <td className="px-4 py-1.5">
                    <textarea
                      value={current}
                      onChange={e => handleChange(key, e.target.value)}
                      rows={1}
                      className="w-full bg-transparent border border-transparent hover:border-slate-600 focus:border-slate-500 rounded px-2 py-1 text-slate-200 resize-none focus:outline-none focus:bg-slate-800 transition-colors"
                      style={{ minHeight: '2rem', fieldSizing: 'content' } as React.CSSProperties}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 border-t border-slate-700 text-xs text-slate-500 flex-none">
        {entries.length} entries{search ? ` matching "${search}"` : ''}
        {dirtyCount > 0 ? ` · ${dirtyCount} modified` : ''}
      </div>
    </div>
  );
}
