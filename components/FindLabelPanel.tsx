import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Search, X } from 'lucide-react';
import { findLabelPanel as copy } from '../copy/ui';
import { Annotation, AnnotationTool } from '../types';
import { formatTime, buildLabelMatcher, colorForLabel, LabelMatcher } from '../utils/helpers';
import { loadProjectLabels, LabelMatch } from '../utils/annotationRename';
import { basename, isInsideDir } from '../utils/projectPaths';
import { useHotkeys } from '../hooks/useHotkeys';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import ToolCell from './ToolCell';
import CollapsibleSection from './CollapsibleSection';

export type RenameScope = 'track' | 'folder' | 'project';

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
   * The folder the file panel has been entered into, or null at the media root.
   * Folder scope searches every track beneath it; at the root it would be the
   * same as Project, so the option is disabled there.
   */
  folderPath: string | null;
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
  // Scope, and the query as last settled, are lifted to the caller (rather than
  // local state) so they — and the results they produce — survive the panel being
  // closed and reopened within the same session. `query` seeds the field on mount;
  // `onQueryChange` is called with the settled value, not per keystroke (see
  // QUERY_DEBOUNCE_MS).
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
  // track annotations in memory, and — when scope is 'folder' or 'project' —
  // every other in-scope track's annotation file on disk. Resolves with the
  // total renamed count.
  onRename: (matcher: LabelMatcher, newText: string, scope: RenameScope) => Promise<number>;
}

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// How long the query must hold still before anything acts on it. Two costs hang
// off a keystroke, and the debounce is what keeps both off the typing path:
// rebuilding the result list (the first characters of a partial or regex query
// match the most and are the least likely to be what the user meant), and the
// push up to the orchestrator, which re-renders the spectrogram and every panel
// alongside it. The field itself is local state and stays live throughout.
const QUERY_DEBOUNCE_MS = 200;

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
  annotations, annotationTools, allTracks, trackPath, folderPath, annotationsLoaded,
  getAnnotationPath, getIdent,
  useRegex, onUseRegexChange, partial, onPartialChange,
  caseSensitive, onCaseSensitiveChange,
  query, onQueryChange, scope, onScopeChange,
  focusNonce, reloadNonce, onClose, onGo, onRename,
}: Props) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<FlatMatch | null>(null);

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

  // Folder scope with no folder entered (the user stepped back out to the root)
  // searches the project, which is what the folder has become.
  const effectiveScope: RenameScope = scope === 'folder' && !folderPath ? 'project' : scope;
  // Both wider scopes read the whole-project index, and Folder filters it
  // afterwards: the index is cached per track list, so reading only the folder's
  // tracks would throw away the project index on every switch between the two.
  const needsIndex = effectiveScope !== 'track';

  // The live field value. Local, so typing costs this component a render and
  // nothing else; `query` only seeds it.
  const [draftQuery, setDraftQuery] = useState(query);
  // Everything downstream of the search — the matcher, the results, the counts,
  // what the rename applies to — keys off the settled query, never the raw field.
  const settledQuery = useDebouncedValue(draftQuery, QUERY_DEBOUNCE_MS);
  const searching = settledQuery.trim() !== '';

  // Hand the settled query up so it survives a close/reopen. The unmount pass
  // sends the raw draft instead, since closing the dock mid-debounce would
  // otherwise lose the last characters typed.
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  const draftQueryRef = useRef(draftQuery);
  draftQueryRef.current = draftQuery;
  useEffect(() => { onQueryChangeRef.current(settledQuery); }, [settledQuery]);
  useEffect(() => () => { onQueryChangeRef.current(draftQueryRef.current); }, []);

  const matcher: LabelMatcher | null = useMemo(() => {
    const label = settledQuery.trim();
    if (!label) return null;
    return buildLabelMatcher(label, { useRegex, partial, caseSensitive });
  }, [settledQuery, useRegex, partial, caseSensitive]);

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
    if (!needsIndex) return;
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
  }, [needsIndex, sortedTracks, getAnnotationPath, getIdent, reloadKey, reloadNonce]);

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
    const tracks = effectiveScope === 'track' ? (trackPath ? [trackPath] : [])
      : effectiveScope === 'folder' ? sortedTracks.filter(t => isInsideDir(folderPath!, t))
      : sortedTracks;
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
  }, [matcher, effectiveScope, folderPath, sortedTracks, trackPath, getIdent, labelsFor, labelsVersion]);

  const selectedIndex = useMemo(
    () => (selected ? results.findIndex(r => sameMatch(r, selected)) : -1),
    [results, selected],
  );

  const go = useCallback((index: number) => {
    const target = results[index];
    if (!target) return;
    setSelected(target);
    onGo(target.ident, target.match);
  }, [results, onGo]);

  // Step to the next/previous match, wrapping — the list is a loop you walk, so
  // running off the end comes back round rather than stopping dead.
  const step = useCallback((delta: number) => {
    if (results.length === 0) return;
    if (selectedIndex === -1) {
      go(delta > 0 ? 0 : results.length - 1);
      return;
    }
    go((selectedIndex + delta + results.length) % results.length);
  }, [results, selectedIndex, go]);

  // Option+↑/↓ walks the match list from anywhere in the window while the dock is
  // open — the keyboard twin of the chevrons, and registered here so the binding
  // exists exactly as long as the dock does. allowInInput so it works straight
  // from the search field, without reaching for the mouse to start walking.
  useHotkeys([
    { key: 'ArrowUp', mods: ['alt'], allowInInput: true, handler: () => step(-1) },
    { key: 'ArrowDown', mods: ['alt'], allowInInput: true, handler: () => step(1) },
  ]);

  // Keep the current match visible as the user walks past the edge of the list.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    setError(searching && !matcher ? copy.invalidRegexError : '');
  }, [searching, matcher]);

  const totalCount = results.length;
  const identCount = useMemo(() => new Set(results.map(r => r.ident)).size, [results]);
  const canRename = !!matcher && totalCount > 0 && newLabel.trim().length > 0 && !renaming && !scanning;

  const handleRename = async () => {
    if (!matcher) return;
    setRenaming(true);
    setError('');
    try {
      const count = await onRename(matcher, newLabel.trim(), effectiveScope);
      // renameLabelAcrossTracks has already dropped the label index (it just
      // rewrote the files it described); re-read so the results below reflect
      // the new labels.
      setReloadKey(k => k + 1);
      setRenameResult({ count, identCount });
      setDraftQuery('');
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
    setDraftQuery(value);
    setSelected(null);
    setRenameResult(null);
  };

  const onQueryKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    // Esc closes the dock from anywhere inside it. Stopping propagation keeps it
    // from also reaching the window-level Esc handler, which would unwind a
    // selection or readied tool at the same time.
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      onClose();
      return;
    }
    // Arrows mean nothing in here. Left to themselves they'd scrub the playhead
    // or scroll the list out from under the match you just clicked, because
    // clicking a chip leaves focus on a button rather than in a text field. The
    // exceptions: Option+arrow is the match walk above, and a caret inside one of
    // the panel's own text fields keeps its arrow keys.
    if (!ARROW_KEYS.has(e.key)) return;
    if (e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Ident subheaders are emitted inline as the flat list is walked, so the list
  // says which recording each run of matches belongs to without the rows
  // becoming something you have to open first. Track scope has only the open
  // recording to show, so there the header says nothing the window doesn't
  // already say.
  const showIdents = effectiveScope !== 'track';
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
            value={draftQuery}
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
              ['project', copy.scopeWholeProjectLabel, copy.scopeWholeProjectTooltip, true],
              ['folder', copy.scopeFolderLabel,
                folderPath ? copy.scopeFolderTooltip(basename(folderPath)) : copy.scopeFolderDisabledTooltip,
                !!folderPath],
              ['track', copy.scopeCurrentTrackLabel, copy.scopeCurrentTrackTooltip, true],
            ] as [RenameScope, string, string, boolean][]).map(([s, label, tooltip, enabled]) => (
              // aria-disabled rather than disabled, so the tooltip explaining why
              // still shows on hover.
              <button
                key={s}
                aria-disabled={!enabled}
                onClick={() => {
                  if (!enabled) return;
                  onScopeChange(s); setSelected(null); setRenameResult(null);
                }}
                data-tooltip={tooltip}
                className={`px-2 py-0.5 text-[10px] transition-colors ${
                  !enabled ? 'bg-slate-900 text-slate-600 cursor-default'
                  : effectiveScope === s ? 'bg-slate-700 text-slate-100'
                  : 'bg-slate-900 text-slate-500 hover:text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {/* Walk the matches without taking your hand off the panel. */}
          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
            {results.length > 0 ? copy.matchPositionLabel(selectedIndex + 1, results.length) : ''}
          </span>
          <button
            onClick={() => step(-1)}
            disabled={results.length === 0}
            data-tooltip={copy.prevMatchTooltip}
            className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => step(1)}
            disabled={results.length === 0}
            data-tooltip={copy.nextMatchTooltip}
            className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ChevronDown size={13} />
          </button>
        </div>
      </div>

      {/* The matches themselves */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {!searching && <p className="text-slate-500 text-xs px-0.5">{copy.emptyQueryHint}</p>}
        {searching && results.length === 0 && (
          <p className="text-slate-500 text-xs px-0.5">{scanning ? copy.scanningLabel : copy.noMatchesLabel}</p>
        )}
        {results.map((r, i) => {
          const isSelected = i === selectedIndex;
          const color = colorForLabel(r.match.label, annotationTools);
          const header = showIdents && r.ident !== lastIdent ? r.ident : null;
          lastIdent = r.ident;
          return (
            <React.Fragment key={`${r.trackFilePath}:${r.match.start}:${r.match.end}:${r.match.label}:${i}`}>
              {header !== null && (
                <div className={`px-0.5 pb-0.5 text-[10px] text-slate-500 break-all leading-tight ${i === 0 ? '' : 'mt-4'}`}>
                  {header}
                </div>
              )}
              <div ref={isSelected ? selectedRowRef : undefined} className={header === null ? 'mt-1' : ''}>
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
                {searching && !scanning
                  ? (effectiveScope !== 'track' ? copy.matchCountLabel(totalCount, identCount) : copy.matchCountTrackLabel(totalCount))
                  : ''}
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
