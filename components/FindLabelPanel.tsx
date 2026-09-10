import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Search, X } from 'lucide-react';
import { findLabelPanel as copy } from '../copy/ui';
import { Annotation, AnnotationTool } from '../types';
import { formatTime, buildLabelMatcher, colorForLabel, LabelMatcher } from '../utils/helpers';
import { loadProjectLabels, LabelMatch } from '../utils/annotationRename';
import ToolCell from './ToolCell';
import CollapsibleSection from './CollapsibleSection';

export type RenameScope = 'track' | 'project';

/** One match, with the track it belongs to — the unit the panel navigates over. */
interface FlatMatch {
  trackFilePath: string;
  ident: string;
  match: LabelMatch;
}

interface Props {
  annotations: Annotation[];
  /** Label colors come from the tools, the same lookup the spectrogram uses. */
  annotationTools: AnnotationTool[];
  allTracks: string[];
  trackPath: string | null;
  /**
   * Whether `annotations` is the open track's real list rather than the empty
   * placeholder a track switch leaves behind. False means "don't believe it" —
   * without this the result list would empty itself for a moment every time the
   * user stepped to a match on another track, which is the one thing a docked
   * panel must not do.
   */
  annotationsLoaded: boolean;
  getAnnotationPath: (trackFilePath: string) => string | null;
  getIdent: (trackFilePath: string) => string | null;
  // Both persisted in project preferences so the toggles stick across
  // sessions. `useRegex` wins when both are on. They apply to both the
  // navigate-to-match search and the rename-all-matches action below.
  useRegex: boolean;
  onUseRegexChange: (useRegex: boolean) => void;
  partial: boolean;
  onPartialChange: (partial: boolean) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (caseSensitive: boolean) => void;
  // Query and scope are lifted to the caller (rather than local state) so they,
  // and the results they produce, survive the panel being closed and reopened
  // within the same session.
  query: string;
  onQueryChange: (query: string) => void;
  scope: RenameScope;
  onScopeChange: (scope: RenameScope) => void;
  /**
   * Bumped by the caller when {mod}+F is pressed while the panel is already
   * open: focus the query field and select what's in it, the way a browser's
   * find bar does, instead of doing nothing.
   */
  focusNonce: number;
  /** Bumped after a git pull, so the on-disk label index is re-read. */
  reloadNonce: number;
  onClose: () => void;
  /** Opens the match's track if needed, then scrolls to and selects it. */
  onGo: (ident: string, match: LabelMatch) => void;
  // Renames every annotation currently matching the search query: current-
  // track annotations in memory, and — when scope is 'project' — every other
  // track's annotation file on disk. Resolves with the total renamed count.
  onRename: (matcher: LabelMatcher, newText: string, scope: RenameScope) => Promise<number>;
}

const sameMatch = (a: FlatMatch, b: FlatMatch): boolean =>
  a.trackFilePath === b.trackFilePath
  && a.match.start === b.match.start
  && a.match.end === b.match.end
  && a.match.label === b.match.label;

/** One of the three matching toggles, as a compact pill. */
function ModeToggle({ active, caption, tooltip, onClick }: {
  active: boolean;
  caption: string;
  tooltip: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      data-tooltip={tooltip}
      className={`px-1.5 py-0.5 rounded font-mono text-[10px] leading-none border transition-colors ${
        active
          ? 'bg-blue-600/30 border-blue-500/60 text-blue-200'
          : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600'
      }`}
    >
      {caption}
    </button>
  );
}

/**
 * The Find & Rename dock: a right-hand panel that searches annotations by label
 * text (exact, partial, or regex) across the open track or the whole project,
 * walks the playhead through the matches, and bulk-renames them.
 *
 * It is a panel rather than a dialog because the match list is the point: it
 * stays on screen, with the current match highlighted, while the user opens one
 * recording after another and edits what they find. Nothing here closes itself.
 */
export default function FindLabelPanel({
  annotations, annotationTools, allTracks, trackPath, annotationsLoaded,
  getAnnotationPath, getIdent,
  useRegex, onUseRegexChange, partial, onPartialChange,
  caseSensitive, onCaseSensitiveChange,
  query, onQueryChange, scope, onScopeChange,
  focusNonce, reloadNonce, onClose, onGo, onRename,
}: Props) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<FlatMatch | null>(null);
  // Narrows the list to one of the matched labels. A partial or regex query can
  // hit several different labels at once, so the chips above the list say which,
  // and clicking one isolates it.
  const [labelFilter, setLabelFilter] = useState<string | null>(null);

  const [newLabel, setNewLabel] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameResult, setRenameResult] = useState<{ count: number; identCount: number } | null>(null);

  const queryRef = useRef<HTMLInputElement>(null);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  // Every track in the project, sorted alphabetically by ident once (not
  // re-sorted per search) so results stream in in a stable order and don't
  // reshuffle as later idents' matches arrive.
  const sortedTracks = useMemo(
    () => [...allTracks].sort((a, b) => (getIdent(a) ?? a).localeCompare(getIdent(b) ?? b)),
    [allTracks, getIdent],
  );

  const matcher: LabelMatcher | null = useMemo(() => {
    const label = query.trim();
    if (!label) return null;
    return buildLabelMatcher(label, { useRegex, partial, caseSensitive });
  }, [query, useRegex, partial, caseSensitive]);

  // Whole-project labels read from disk, held in memory and filtered locally
  // (below) so editing the query or flipping partial/regex never touches disk.
  // Kept in a ref with a version counter rather than in state: the index streams
  // in one batch at a time and rebuilding a Map per entry would be quadratic.
  const projectLabelsRef = useRef<Map<string, LabelMatch[]>>(new Map());
  // Labels we have actually held in memory — the open track's now, and every
  // track visited since the panel opened. These win over the disk index, which
  // predates any edit made since it was read, and they're what makes stepping
  // between matches on different tracks show the user's own edits rather than
  // the file as it was when the scan ran.
  const memoryLabelsRef = useRef<Map<string, LabelMatch[]>>(new Map());
  const [labelsVersion, setLabelsVersion] = useState(0);
  // Bumped to force a rebuild after a rename has rewritten files on disk.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (scope !== 'project') return;
    let cancelled = false;
    projectLabelsRef.current = new Map();
    setLabelsVersion(v => v + 1);
    setScanning(true);
    loadProjectLabels(
      sortedTracks,
      getAnnotationPath,
      getIdent,
      (entry) => {
        if (cancelled) return;
        projectLabelsRef.current.set(entry.trackFilePath, entry.labels);
        setLabelsVersion(v => v + 1);
      },
      () => cancelled,
    )
      .catch(err => { if (!cancelled) setError(`Search failed: ${String(err)}`); })
      .finally(() => { if (!cancelled) setScanning(false); });
    return () => { cancelled = true; };
  }, [scope, sortedTracks, getAnnotationPath, getIdent, reloadKey, reloadNonce]);

  // Disk changed out from under us (a rename we just made, or a git pull), so
  // what we remember of other tracks is no longer trustworthy either.
  useEffect(() => {
    memoryLabelsRef.current = new Map();
    setLabelsVersion(v => v + 1);
  }, [reloadKey, reloadNonce]);

  // Mirror the open track's in-memory annotations into the overlay above, but
  // only once they're really loaded (see `annotationsLoaded`).
  useEffect(() => {
    if (!trackPath || !annotationsLoaded) return;
    memoryLabelsRef.current.set(trackPath, annotations
      .map(a => ({ start: a.start, end: a.end, label: a.text }))
      .sort((a, b) => a.start - b.start));
    setLabelsVersion(v => v + 1);
  }, [trackPath, annotations, annotationsLoaded]);

  const labelsFor = useCallback((t: string): LabelMatch[] => (
    memoryLabelsRef.current.get(t) ?? projectLabelsRef.current.get(t) ?? []
  ), []);

  // Every match in the search's scope, flat and in track-then-time order — the
  // order the prev/next buttons walk.
  const results: FlatMatch[] = useMemo(() => {
    if (!matcher) return [];
    const tracks = scope === 'track' ? (trackPath ? [trackPath] : []) : sortedTracks;
    const out: FlatMatch[] = [];
    for (const t of tracks) {
      const trackIdent = getIdent(t);
      if (!trackIdent) continue;
      for (const m of labelsFor(t)) {
        if (matcher(m.label)) out.push({ trackFilePath: t, ident: trackIdent, match: m });
      }
    }
    return out;
    // labelsVersion is the dep that tracks the two label maps' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matcher, scope, sortedTracks, trackPath, getIdent, labelsFor, labelsVersion]);

  // The distinct labels the query matched, most-hit first. Worth showing as soon
  // as there's more than one, since that's exactly when the query is looser than
  // the user may have realised.
  const labelGroups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of results) counts.set(r.match.label, (counts.get(r.match.label) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }));
  }, [results]);

  // Drop a label filter the query no longer matches, rather than showing an
  // empty list under a chip that isn't there any more.
  useEffect(() => {
    if (labelFilter !== null && !labelGroups.some(g => g.label === labelFilter)) setLabelFilter(null);
  }, [labelGroups, labelFilter]);

  const shown = useMemo(
    () => (labelFilter === null ? results : results.filter(r => r.match.label === labelFilter)),
    [results, labelFilter],
  );

  const selectedIndex = useMemo(
    () => (selected ? shown.findIndex(r => sameMatch(r, selected)) : -1),
    [shown, selected],
  );

  const go = useCallback((index: number) => {
    const target = shown[index];
    if (!target) return;
    setSelected(target);
    onGo(target.ident, target.match);
  }, [shown, onGo]);

  // Step to the next/previous match, wrapping — the list is a loop you walk, so
  // running off the end comes back round rather than stopping dead.
  const step = useCallback((delta: number) => {
    if (shown.length === 0) return;
    if (selectedIndex === -1) {
      go(delta > 0 ? 0 : shown.length - 1);
      return;
    }
    go((selectedIndex + delta + shown.length) % shown.length);
  }, [shown, selectedIndex, go]);

  // Keep the current match visible as the user walks past the edge of the list.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    setError(query.trim() && !matcher ? copy.invalidRegexError : '');
  }, [query, matcher]);

  const totalCount = results.length;
  const identCount = useMemo(() => new Set(results.map(r => r.ident)).size, [results]);
  const canRename = !!matcher && totalCount > 0 && newLabel.trim().length > 0 && !renaming && !scanning;

  const handleRename = async () => {
    if (!matcher) return;
    setRenaming(true);
    setError('');
    try {
      const count = await onRename(matcher, newLabel.trim(), scope);
      // renameLabelAcrossTracks has already dropped the label index (it just
      // rewrote the files it described); re-read so the results below reflect
      // the new labels.
      setReloadKey(k => k + 1);
      setRenameResult({ count, identCount });
      onQueryChange('');
      setNewLabel('');
      setSelected(null);
    } catch (err) {
      setError(`Rename failed: ${String(err)}`);
    } finally {
      setRenaming(false);
    }
  };

  // A fresh query invalidates the current position in the old result list (as do
  // the matching toggles and the scope switch), but never the panel itself.
  const handleQueryChange = (value: string) => {
    onQueryChange(value);
    setSelected(null);
    setRenameResult(null);
  };

  const onQueryKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  // Esc closes the dock from anywhere inside it. Stopping propagation keeps it
  // from also reaching the window-level Esc handler, which would unwind a
  // selection or readied tool at the same time.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    onClose();
  };

  // Ident subheaders are emitted inline as the flat list is walked, so the list
  // says which recording each run of matches belongs to without the rows
  // becoming something you have to open first.
  let lastIdent: string | null = null;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" onKeyDown={onPanelKeyDown}>
      <div className="flex items-center gap-1 pl-2 pr-1 py-1.5 bg-slate-800 border-b border-slate-700 flex-none">
        <span className="flex-1 min-w-0 text-[10px] text-slate-400 uppercase tracking-wider font-medium truncate">
          {copy.title}
        </span>
        <button
          onClick={onClose}
          data-tooltip={copy.closeTooltip}
          className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors flex-none"
        >
          <X size={13} />
        </button>
      </div>

      {/* Search field, matching toggles, scope */}
      <div className="flex-none p-1.5 space-y-1.5 border-b border-slate-800">
        <div className="flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 focus-within:border-blue-500 transition-colors">
          <Search size={11} className="text-slate-500 flex-none" />
          <input
            ref={queryRef}
            type="text"
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={onQueryKeyDown}
            placeholder={copy.labelPlaceholder}
            className="flex-1 min-w-0 bg-transparent text-xs text-white placeholder:text-slate-500 outline-none"
          />
          <ModeToggle
            active={caseSensitive}
            caption={copy.caseToggleCaption}
            tooltip={copy.caseCheckboxLabel}
            onClick={() => { onCaseSensitiveChange(!caseSensitive); setSelected(null); }}
          />
          <ModeToggle
            active={partial}
            caption={copy.partialToggleCaption}
            tooltip={copy.partialCheckboxLabel}
            onClick={() => { onPartialChange(!partial); setSelected(null); }}
          />
          <ModeToggle
            active={useRegex}
            caption={copy.regexToggleCaption}
            tooltip={copy.regexCheckboxLabel}
            onClick={() => { onUseRegexChange(!useRegex); setSelected(null); }}
          />
        </div>

        <div className="flex items-center gap-1">
          <div className="flex rounded border border-slate-700 overflow-hidden flex-none">
            {([
              ['project', copy.scopeWholeProjectLabel, copy.scopeWholeProjectTooltip],
              ['track', copy.scopeCurrentTrackLabel, copy.scopeCurrentTrackTooltip],
            ] as [RenameScope, string, string][]).map(([s, label, tooltip]) => (
              <button
                key={s}
                onClick={() => { onScopeChange(s); setSelected(null); setRenameResult(null); }}
                data-tooltip={tooltip}
                className={`px-2 py-0.5 text-[10px] transition-colors ${
                  scope === s ? 'bg-slate-700 text-slate-100' : 'bg-slate-900 text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {/* Walk the matches without taking your hand off the panel. */}
          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
            {shown.length > 0 ? copy.matchPositionLabel(selectedIndex + 1, shown.length) : ''}
          </span>
          <button
            onClick={() => step(-1)}
            disabled={shown.length === 0}
            data-tooltip={copy.prevMatchTooltip}
            className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => step(1)}
            disabled={shown.length === 0}
            data-tooltip={copy.nextMatchTooltip}
            className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronDown size={13} />
          </button>
        </div>
      </div>

      {/* Which labels the query hit — only interesting once it hit more than one */}
      {labelGroups.length > 1 && (
        <div className="flex-none max-h-24 overflow-y-auto p-1.5 space-y-1 border-b border-slate-800">
          {labelGroups.map(g => (
            <ToolCell
              key={g.label}
              isActive={labelFilter === g.label}
              color={colorForLabel(g.label, annotationTools)}
              dotColor={colorForLabel(g.label, annotationTools)}
              label={g.label}
              hotkey={String(g.count)}
              tooltip={labelFilter === g.label ? copy.labelFilterClearTooltip : copy.labelFilterTooltip}
              onClick={() => setLabelFilter(f => (f === g.label ? null : g.label))}
            />
          ))}
        </div>
      )}

      {/* The matches themselves */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
        {!query.trim() && <p className="text-slate-500 text-xs px-0.5">{copy.emptyQueryHint}</p>}
        {query.trim() && shown.length === 0 && (
          <p className="text-slate-500 text-xs px-0.5">{scanning ? copy.scanningLabel : copy.noMatchesLabel}</p>
        )}
        {shown.map((r, i) => {
          const isSelected = i === selectedIndex;
          const color = colorForLabel(r.match.label, annotationTools);
          const header = r.ident !== lastIdent ? r.ident : null;
          lastIdent = r.ident;
          return (
            <React.Fragment key={`${r.trackFilePath}:${r.match.start}:${r.match.end}:${r.match.label}:${i}`}>
              {header !== null && (
                <div className="pt-1 first:pt-0 px-0.5 text-[10px] text-slate-500 break-all leading-tight">
                  {header}
                </div>
              )}
              <div ref={isSelected ? selectedRowRef : undefined}>
                <ToolCell
                  isActive={isSelected}
                  color={color}
                  dotColor={color}
                  label={r.match.label}
                  tooltip={`${formatTime(r.match.start)} – ${formatTime(r.match.end)}\n${copy.matchRowTooltip}`}
                  trailing={(
                    <span className="font-mono text-slate-400 text-[10px] flex-none tabular-nums">
                      {formatTime(r.match.start)}
                    </span>
                  )}
                  onClick={() => go(i)}
                />
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Rename, tucked away — finding is the common case, renaming the rare one */}
      <div className="flex-none px-2 pb-2 bg-slate-900">
        <CollapsibleSection title={copy.renameHeading}>
          <div className="space-y-2">
            <input
              type="text"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={newLabel}
              onChange={e => { setNewLabel(e.target.value); setRenameResult(null); }}
              placeholder={copy.newLabelPlaceholder}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-slate-500 text-[10px] leading-tight">
                {query.trim() && !scanning ? copy.matchCountLabel(totalCount, identCount) : ''}
              </span>
              <button
                onClick={handleRename}
                disabled={!canRename}
                className="flex-none px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white rounded text-xs transition-colors"
              >
                {renaming ? copy.renamingButton : copy.renameButton}
              </button>
            </div>
            {renameResult && (
              <p className="text-green-400 text-[10px]">
                {copy.renameConfirmation(renameResult.count, renameResult.identCount)}
              </p>
            )}
          </div>
        </CollapsibleSection>
        {error && <p className="text-red-400 text-[10px] mt-2">{error}</p>}
      </div>
    </div>
  );
}
