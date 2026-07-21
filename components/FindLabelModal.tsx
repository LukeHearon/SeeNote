import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { findLabelModal as copy } from '../copy/ui';
import { Annotation } from '../types';
import { formatTime, buildLabelMatcher, LabelMatcher } from '../utils/helpers';
import { searchTrackForMatches, streamSearch, IdentMatches, LabelMatch } from '../utils/annotationRename';
import SettingsModalShell from './SettingsModalShell';

interface Props {
  annotations: Annotation[];
  allTracks: string[];
  trackPath: string | null;
  ident: string | null;
  getAnnotationPath: (trackFilePath: string) => string | null;
  getIdent: (trackFilePath: string) => string | null;
  // Both persisted in project preferences so the toggles stick across
  // sessions. `useRegex` wins when both are on.
  useRegex: boolean;
  onUseRegexChange: (useRegex: boolean) => void;
  partial: boolean;
  onPartialChange: (partial: boolean) => void;
  onClose: () => void;
  onGo: (ident: string, match: LabelMatch) => void;
}

interface Selected {
  ident: string;
  match: LabelMatch;
}

export default function FindLabelModal({
  annotations, allTracks, trackPath, ident, getAnnotationPath, getIdent,
  useRegex, onUseRegexChange, partial, onPartialChange, onClose, onGo,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IdentMatches[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Selected | null>(null);

  // Every track in the project, sorted alphabetically by ident once (not
  // re-sorted per search) so results stream in in a stable order and don't
  // reshuffle as later idents' matches arrive.
  const sortedTracks = useMemo(
    () => [...allTracks].sort((a, b) => (getIdent(a) ?? a).localeCompare(getIdent(b) ?? b)),
    [allTracks, getIdent],
  );

  useEffect(() => {
    const label = query.trim();
    if (!label) {
      setResults([]);
      setScanning(false);
      setError('');
      return;
    }
    const matcher: LabelMatcher | null = buildLabelMatcher(label, { useRegex, partial });
    if (!matcher) {
      setResults([]);
      setScanning(false);
      setError(copy.invalidRegexError);
      return;
    }
    setError('');
    setScanning(true);
    setResults([]);
    let cancelled = false;
    const timer = setTimeout(async () => {
      // The current track's annotations live in memory (may not be flushed to
      // disk yet), so read them directly instead of re-parsing its file.
      const searchOne = (t: string): Promise<IdentMatches | null> => {
        if (t === trackPath) {
          const matches: LabelMatch[] = annotations
            .filter(a => matcher(a.text))
            .map(a => ({ start: a.start, end: a.end, label: a.text }));
          return Promise.resolve(matches.length > 0 && ident ? { ident, matches } : null);
        }
        return searchTrackForMatches(t, getAnnotationPath, getIdent, matcher);
      };
      try {
        await streamSearch(
          sortedTracks,
          searchOne,
          (found) => { if (!cancelled) setResults(prev => [...prev, found]); },
          () => cancelled,
        );
      } catch (err) {
        if (!cancelled) setError(`Search failed: ${String(err)}`);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, useRegex, partial, sortedTracks, trackPath, annotations, ident, getAnnotationPath, getIdent]);

  // Regex/partial searches can match labels that differ from the typed query,
  // so show each match's own label; an exact search is redundant to repeat.
  const showLabel = useRegex || partial;

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleGo = () => {
    if (!selected) return;
    onGo(selected.ident, selected.match);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <SettingsModalShell
        title={copy.title}
        onClose={onClose}
        footer={
          <>
            <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm">
              {copy.cancelButton}
            </button>
            <button
              onClick={handleGo}
              disabled={!selected}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {copy.goButton}
            </button>
          </>
        }
      >
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-gray-400 text-sm">{copy.labelField}</label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-gray-400 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={partial}
                  onChange={e => { onPartialChange(e.target.checked); setSelected(null); }}
                  className="accent-blue-500"
                />
                {copy.partialCheckboxLabel}
              </label>
              <label className="flex items-center gap-1.5 text-gray-400 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useRegex}
                  onChange={e => { onUseRegexChange(e.target.checked); setSelected(null); }}
                  className="accent-blue-500"
                />
                {copy.regexCheckboxLabel}
              </label>
            </div>
          </div>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(null); }}
            placeholder={copy.labelPlaceholder}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>

        <div>
          {scanning && <p className="text-gray-500 text-sm">{copy.scanningLabel}</p>}
          {!scanning && query.trim() && results.length === 0 && (
            <p className="text-gray-500 text-sm">{copy.noMatchesLabel}</p>
          )}
          {results.length > 0 && (
            <div className="max-h-72 overflow-y-auto border border-gray-700 rounded-lg divide-y divide-gray-700">
              {results.map(r => {
                const isExpanded = expanded.has(r.ident);
                return (
                  <div key={r.ident}>
                    <button
                      onClick={() => toggleExpanded(r.ident)}
                      className="w-full flex items-start justify-between gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-800/60 transition-colors"
                    >
                      <span className="flex items-start gap-1 min-w-0">
                        {isExpanded ? (
                          <ChevronDown size={12} className="flex-none opacity-60 mt-1" />
                        ) : (
                          <ChevronRight size={12} className="flex-none opacity-60 mt-1" />
                        )}
                        <span className="text-gray-300 break-all">{r.ident}</span>
                      </span>
                      <span className="text-gray-500 flex-none">{r.matches.length}</span>
                    </button>
                    {isExpanded && (
                      <div className="pl-6 pb-1">
                        {r.matches.map((m, i) => {
                          const isSelected = selected?.ident === r.ident && selected.match.start === m.start && selected.match.end === m.end && selected.match.label === m.label;
                          return (
                            <button
                              key={i}
                              onClick={() => setSelected({ ident: r.ident, match: m })}
                              className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${
                                isSelected ? 'bg-blue-600/40 text-white' : 'text-gray-400 hover:bg-gray-800/60'
                              }`}
                            >
                              {showLabel ? `${m.label}: ${formatTime(m.start)} – ${formatTime(m.end)}` : `${formatTime(m.start)} – ${formatTime(m.end)}`}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </SettingsModalShell>
    </div>
  );
}
