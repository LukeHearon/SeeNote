import { useState, useRef, useEffect, useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Annotation, AnnotationTool, Project, Selection } from '../types';
import type { RenameScope } from '../components/FindLabelPanel';
import type { SpectrogramHandle } from '../components/Spectrogram';
import { colorForLabel, type LabelMatcher } from '../utils/helpers';
import { renameLabelAcrossTracks, renameOneLabelInTrack, type LabelMatch } from '../utils/annotationRename';
import { isInsideDir } from '../utils/projectPaths';
import type { UpdateProjectPreferences } from '../utils/projectPreferences';
import type { Timeline } from '../utils/subsetTimeline';

interface FindLabelParams {
  project: Project;
  updateProjectPreferences: UpdateProjectPreferences;
  annotations: Annotation[];
  setAnnotations: Dispatch<SetStateAction<Annotation[]>>;
  /** Track whose real list `annotations` is (null while a load is pending). */
  annotationsLoadedTrack: string | null;
  annotationTools: AnnotationTool[];
  allTracks: string[];
  annotatedTracks: ReadonlySet<string>;
  trackPath: string | null;
  ident: string | null;
  isProcessing: boolean;
  getIdent: (trackPath: string) => string | null;
  getAnnotationPath: (trackPath: string) => string | null;
  timeline: Timeline;
  seek: (time: number, scroll?: boolean) => void;
  handleSelectionChange: (s: Selection | null) => void;
  setSelectedAnnotationId: (id: string | null) => void;
  setBoundAnnotationId: (id: string | null) => void;
  spectrogramRef: RefObject<SpectrogramHandle | null>;
  handleEnteredFolderChange: (path: string | null) => void;
  handleOpenTrack: (path: string) => void;
  reloadNonce: number;
}

/**
 * The Find & Rename dock: its open state and last search, the rename
 * handlers, and "Go" to a match (opening its track first when it's elsewhere).
 * Returns the props for FindLabelPanel.
 */
export function useFindLabel({
  project, updateProjectPreferences, annotations, setAnnotations, annotationsLoadedTrack, annotationTools,
  allTracks, annotatedTracks, trackPath, ident, isProcessing, getIdent, getAnnotationPath,
  timeline, seek, handleSelectionChange, setSelectedAnnotationId, setBoundAnnotationId, spectrogramRef,
  handleEnteredFolderChange, handleOpenTrack, reloadNonce,
}: FindLabelParams) {
  // The "Find Label" entry points ({mod}+F and the magnifying glass in the
  // Labels palette) open the find-and-rename dock on the right. Query/scope live
  // here (not inside the panel) so the last search is still there — and its
  // results reappear — the next time it's opened this session. Open state is
  // deliberately NOT persisted: the dock is summoned, and closing it is the end
  // of it. `findLabelFocusNonce` re-focuses the query field when {mod}+F is
  // pressed while the dock is already open.
  const [showFindLabel, setShowFindLabel] = useState(false);
  const [findLabelFocusNonce, setFindLabelFocusNonce] = useState(0);
  const [findLabelQuery, setFindLabelQuery] = useState('');
  const [findLabelScope, setFindLabelScope] = useState<RenameScope>('project');
  const openFindLabel = useCallback(() => {
    setShowFindLabel(true);
    setFindLabelFocusNonce(n => n + 1);
  }, []);

  // Tracks Find & Rename has anything to read from: those with an annotation
  // file on disk, plus the open track (whose annotations may be unsaved). The
  // panel used to try every track and swallow the "no such file" errors, which
  // on a large project is one failed read per unannotated track.
  const annotatedSearchTracks = useMemo(
    () => allTracks.filter(t => annotatedTracks.has(t) || t === trackPath),
    [allTracks, annotatedTracks, trackPath],
  );

  // Find & Rename: renames every annotation whose text satisfies `matcher`
  // (exact, partial, or regex) to `newText`, independent of any tool
  // identity. Current track updates in memory (autosave picks it up); when
  // scope is 'folder' or 'project', every other in-scope track's annotation
  // file is also rewritten on disk via the shared util also used by
  // handleRenameTool. Folder scope skips the open track if it lies outside the
  // entered folder, just as the panel leaves it out of the results.
  const handleFindLabelRename = useCallback(async (matcher: LabelMatcher, newText: string, scope: RenameScope): Promise<number> => {
    const folder = project.preferences.enteredFolderPath;
    const inScope = (t: string) => scope !== 'folder' || !folder || isInsideDir(folder, t);
    const renameCurrent = scope !== 'folder' || (trackPath !== null && inScope(trackPath));
    const currentCount = renameCurrent ? annotations.filter(a => matcher(a.text)).length : 0;
    if (currentCount > 0) {
      // newText may not belong to any tool (a one-off rename), so re-resolve
      // its color rather than keeping the old cached one — otherwise a label
      // renamed away from its tool would keep that tool's color instead of
      // reverting to white.
      const newColor = colorForLabel(newText, annotationTools);
      setAnnotations(prev => prev.map(a => matcher(a.text) ? { ...a, text: newText, color: newColor } : a));
    }
    if (scope === 'track') return currentCount;
    const otherTracks = annotatedSearchTracks.filter(t => t !== trackPath && inScope(t));
    const diskCount = await renameLabelAcrossTracks(otherTracks, getAnnotationPath, matcher, newText);
    return currentCount + diskCount;
  }, [annotations, annotationTools, annotatedSearchTracks, trackPath, getAnnotationPath,
      project.preferences.enteredFolderPath]);

  // Find & Rename: "Rename selected" — renames just the one match currently
  // selected in the panel, identified by its track, start, end, and current
  // label rather than by matching text. The open track's copy is renamed in
  // memory (autosave picks it up); any other track is rewritten on disk via
  // the single-match twin of renameLabelAcrossTracks. Returns whether a match
  // was actually renamed.
  const handleFindLabelRenameSelected = useCallback(async (
    targetTrackFilePath: string, match: LabelMatch, newText: string,
  ): Promise<boolean> => {
    if (targetTrackFilePath === trackPath) {
      let renamed = false;
      const newColor = colorForLabel(newText, annotationTools);
      setAnnotations(prev => {
        const i = prev.findIndex(a => a.text === match.label && a.start === match.start && a.end === match.end);
        if (i === -1) return prev;
        renamed = true;
        const next = [...prev];
        next[i] = { ...next[i], text: newText, color: newColor };
        return next;
      });
      return renamed;
    }
    return renameOneLabelInTrack(targetTrackFilePath, getAnnotationPath, match, newText);
  }, [trackPath, annotationTools, getAnnotationPath]);

  // Find Label "Go": target ident + the match (start/end/label) on a track
  // that isn't currently open. Set right before handleOpenTrack fires;
  // consumed by the effect below once that track's annotations finish loading.
  const pendingGoToLabelRef = useRef<{ trackPath: string; ident: string } & LabelMatch | null>(null);

  // Select + scroll to an annotation matching `match` on the current track.
  // Shared by the same-track and cross-track ("Go") paths so the two don't
  // diverge on how a match is highlighted. Matches on label too (not just
  // start/end) since a regex/partial search can return several different
  // labels at the same or coincidentally-equal times. Binds the match the
  // same way clicking an annotation box does — bound + selected, with an
  // active selection around it — so it lands ready to edit or delete.
  const goToAnnotationMatch = useCallback((match: LabelMatch) => {
    const found = annotations.find(a => a.start === match.start && a.end === match.end && a.text === match.label);
    if (!found) return;
    setSelectedAnnotationId(found.id);
    setBoundAnnotationId(found.id);
    // The match carries source times; the view, the playhead, and the
    // selection are all on the display axis.
    const dStart = timeline.toDisplay(match.start);
    const dEnd = timeline.toDisplay(match.end);
    handleSelectionChange({ start: dStart, end: dEnd });
    seek(dStart);
    // Centre the match at whatever zoom the user is already working at — walking
    // a find result list must not keep rescaling the time axis under them.
    spectrogramRef.current?.scrollToTime((dStart + dEnd) / 2);
  }, [annotations, seek, timeline, handleSelectionChange]);

  // Find Label "Go" handler: same-track matches select + scroll immediately;
  // matches on another track open it first, and the effect below finishes
  // the job once its annotations have loaded.
  const handleGoToLabelMatch = useCallback((matchIdent: string, match: LabelMatch) => {
    if (matchIdent === ident) {
      goToAnnotationMatch(match);
      return;
    }
    const targetPath = allTracks.find(t => getIdent(t) === matchIdent);
    if (!targetPath) return;
    // A match outside the folder the file panel has been entered into is outside
    // displayQueue too, which would leave {mod}+↑/↓ with no place in the list. So
    // step the panel back out to the media root — but no further in than that. The
    // find panel is already saying where the match lives; following it down into
    // its folder would narrow the file browser to a subtree the user never chose.
    const entered = project.preferences.enteredFolderPath;
    if (entered && !isInsideDir(entered, targetPath)) handleEnteredFolderChange(null);
    pendingGoToLabelRef.current = { trackPath: targetPath, ident: matchIdent, ...match };
    handleOpenTrack(targetPath);
  }, [ident, goToAnnotationMatch, allTracks, getIdent, handleOpenTrack,
      project.preferences.enteredFolderPath, handleEnteredFolderChange]);

  const handleFindLabelUseRegexChange = useCallback((useRegex: boolean) => {
    updateProjectPreferences(project.id, { findLabelUseRegex: useRegex });
  }, [project, updateProjectPreferences]);

  const handleFindLabelPartialChange = useCallback((partial: boolean) => {
    updateProjectPreferences(project.id, { findLabelPartialMatch: partial });
  }, [project, updateProjectPreferences]);

  const handleFindLabelCaseSensitiveChange = useCallback((caseSensitive: boolean) => {
    updateProjectPreferences(project.id, { findLabelCaseSensitive: caseSensitive });
  }, [project, updateProjectPreferences]);

  // Finish a cross-track Find & Rename "Go": select + scroll once the target
  // track has finished loading and its annotations are in memory.
  //
  // Declared *after* useTimelineSwap's effect on purpose (the window calls
  // this hook after that one). A track load ends
  // with a fresh timeline, and that effect clears the selection unconditionally
  // — so applying the Go any earlier (the moment annotations arrive, which is
  // well before the engine reports the new file's duration) left the match
  // bound and glowing with its selection wiped out a beat later. Waiting for
  // `isProcessing` to fall also means the seek and zoom below run against the
  // new file's duration rather than the outgoing track's.
  useEffect(() => {
    const pending = pendingGoToLabelRef.current;
    if (!pending || isProcessing) return;
    if (trackPath !== pending.trackPath || ident !== pending.ident) return;
    // Hold the pending Go (rather than consuming it) until the annotation
    // actually shows up — the load is async and may land after this effect.
    const found = annotations.some(a => a.start === pending.start && a.end === pending.end && a.text === pending.label);
    if (!found) return;
    pendingGoToLabelRef.current = null;
    goToAnnotationMatch(pending);
  }, [annotations, ident, trackPath, isProcessing, goToAnnotationMatch]);

  return {
    showFindLabel,
    openFindLabel,
    panelProps: {
      annotations,
      annotationTools,
      allTracks: annotatedSearchTracks,
      trackPath,
      folderPath: project.preferences.enteredFolderPath ?? null,
      annotationsLoaded: trackPath !== null && annotationsLoadedTrack === trackPath,
      getAnnotationPath,
      getIdent,
      useRegex: project.preferences.findLabelUseRegex ?? false,
      onUseRegexChange: handleFindLabelUseRegexChange,
      partial: project.preferences.findLabelPartialMatch ?? false,
      onPartialChange: handleFindLabelPartialChange,
      caseSensitive: project.preferences.findLabelCaseSensitive ?? false,
      onCaseSensitiveChange: handleFindLabelCaseSensitiveChange,
      query: findLabelQuery,
      onQueryChange: setFindLabelQuery,
      scope: findLabelScope,
      onScopeChange: setFindLabelScope,
      focusNonce: findLabelFocusNonce,
      reloadNonce,
      onClose: () => setShowFindLabel(false),
      onGo: handleGoToLabelMatch,
      onRename: handleFindLabelRename,
      onRenameSelected: handleFindLabelRenameSelected,
    },
  };
}
