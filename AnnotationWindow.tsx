import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Settings, Keyboard, HelpCircle, Bug, ArrowLeft, RefreshCw } from 'lucide-react';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import GradientProjectName from './components/GradientProjectName';
import { HelpHighlightHost } from './components/HelpHighlightHost';
import { Annotation, LoadedAnnotations, SpectrogramSettings, Project, ProjectSettings, ProjectPreferences, Selection, VideoMode } from './types';
import { DEFAULT_ZOOM_SEC, DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_UI_SETTINGS, DEFAULT_LEFT_PANEL_WIDTH, DEFAULT_FIND_PANEL_WIDTH, DEFAULT_SPLIT_RATIO, DEFAULT_DATE_TIME_FORMAT, SIDEBAR_SECTION_FILES, SIDEBAR_SECTION_LABELS, SIDEBAR_SECTION_NEURONS, sidebarSectionsFromUiSettings, isSupportedMediaFile, isVideoFile, migrateVideoMode, nextAvailableHotkey, pickNextToolColor } from './constants';
import { makeAnnotationFromTool, makeAnnotationFromLabel, stripExt, shuffleArray, basename, effectiveTimeUnit, colorForLabel, LabelMatcher } from './utils/helpers';
import { parseFilenameTime } from './utils/filenameTime';
import { renameLabelAcrossTracks, renameOneLabelInTrack, invalidateProjectLabelIndex, LabelMatch } from './utils/annotationRename';
import { resolveLabelColor } from './utils/annotationTools';
import { toolColorsByLabel } from './utils/neuronColors';
import { bindAnnotationToHotkey, annotationMatchingTool } from './utils/bindAnnotationHotkey';
import { nextFileFilter, passesFileFilter } from './utils/fileFilter';
import { isInsideDir } from './utils/projectPaths';
import { showHelpPage } from './utils/helpChannel';
import { preferencesPatch, type UpdateProjectPreferences } from './utils/projectPreferences';
import { AnnotationIoGate } from './utils/annotationIoGate';
import { resolveVideoElementUrl } from './utils/videoUrl';
import { createViewportStore } from './utils/viewportStore';
import { useHotkeys, digitFromEvent } from './hooks/useHotkeys';
import { useChunkCacheVersion } from './hooks/useChunkCacheVersion';
import { useExamplePlayer } from './hooks/useExamplePlayer';
import { useActivationStack, escapeUnwindBinding } from './hooks/useActivationStack';
import { useSelectionControl } from './hooks/useSelectionControl';
import { useExportSelection } from './hooks/useExportSelection';
import { useTrackLoader } from './hooks/useTrackLoader';
import { useWindowLiveHost } from './hooks/useWindowLiveHost';
import { useAnnotationHistory } from './hooks/useAnnotationHistory';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useBandPassFilter } from './hooks/useBandPassFilter';
import { useBuzzdetect } from './hooks/useBuzzdetect';
import { useSubsetTimeline } from './hooks/useSubsetTimeline';
import { useSubsetChunkCache, useTimelineSwap, useSourceFrameTime } from './hooks/useSubsetSync';
import { projectAnnotations, reconcileAnnotations } from './utils/annotationProjection';
import { useProjectPersistence } from './hooks/useProjectPersistence';
import { useSyncManagement } from './hooks/useSyncManagement';
import { useAnnotationTools } from './hooks/useAnnotationTools';
import { useImportAnnotations } from './hooks/useImportAnnotations';
import { useFileNavigation } from './hooks/useFileNavigation';
import { useVideoFrameSource } from './hooks/useVideoFrameSource';
import { usePlaybackTransport } from './hooks/usePlaybackTransport';
import { useArrowKeys } from './hooks/useArrowKeys';
import { useShiftSweep } from './hooks/useShiftSweep';
import { useSpectrogramZoomHotkeys } from './hooks/useSpectrogramZoomHotkeys';
import { useAnnotationLoad } from './hooks/useAnnotationLoad';
import { useProjectScans } from './hooks/useProjectScans';
import { MultiTierSpectrogramCache, swapChunkCache } from './MultiTierSpectrogramCache';
import { revealInFileManager } from './utils/projectCommands';
import TooltipLayer from './components/TooltipLayer';
import DebugConsole from './components/DebugConsole';
import AnnotationToolsPanel from './components/AnnotationToolsPanel';
import SidebarStack from './components/SidebarStack';
import CollapsedToolsRail from './components/CollapsedToolsRail';
import AnnotationToolsSettingsModal from './components/AnnotationToolsSettingsModal';
import FindLabelPanel, { RenameScope } from './components/FindLabelPanel';
import AnnotationToolEditModal from './components/AnnotationToolEditModal';
import AnnotationToolLibrary from './components/AnnotationToolLibrary';
import DeleteToolConfirmDialog from './components/DeleteToolConfirmDialog';
import Toolbar from './components/Toolbar';
import { SpectrogramSettingsPanel } from './components/controls/SpectrogramSettingsPanel';
import VideoSection from './components/VideoSection';
import { BuzzdetectNeuronPalette, BuzzdetectTrackPanel } from './components/buzzdetect/BuzzdetectViews';
import MessageDialog from './components/MessageDialog';
import SyncControls from './components/SyncControls';
import SyncToast from './components/SyncToast';
import { tooltips } from './copy/tooltips';
import { annotationWindow, debugConsole } from './copy/ui';

export interface AnnotationWindowProps {
  project: Project;
  onClose: () => void;
  updateProjectSettings: (id: string, settings: ProjectSettings) => Promise<Project | undefined>;
  updateProjectPreferences: UpdateProjectPreferences;
}

export default function AnnotationWindow({ project, onClose, updateProjectSettings, updateProjectPreferences }: AnnotationWindowProps) {
  // Ref that stays in sync with project prop — avoids stale-closure bugs in
  // persist effects and the navigation/shuffle handlers below.
  const projectRef = useRef<Project>(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  // Track / loaded-file model (path, name, src, directory, audio-vs-video,
  // sample rate, duration, the media list, shuffle, processing flag) plus its
  // stale-closure mirror refs live in useFileNavigation. Instantiated below.
  const {
    videoSrc, setVideoSrc,
    setTrackName,
    trackPath, setTrackPath,
    currentDirectory, setCurrentDirectory,
    isAudioTrack, setIsAudioTrack,
    sampleRate, setSampleRate,
    duration, setDuration,
    isProcessing, setIsProcessing,
    allTracks, setAllMediaFiles,
    shuffleMode, setShuffleMode,
    shuffledFiles, setShuffledFiles,
    durationRef,
    videoSrcRef,
    isAudioTrackRef,
    trackPathRef,
    startShuffle,
    stopShuffle,
  } = useFileNavigation({ projectRef, updateProjectPreferences });

  // Project settings modal
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showToolSettings, setShowToolSettings] = useState(false);
  // Add-tool entry in the Labels palette: when the typed name matches no tool,
  // this holds it and opens the create modal, pre-targeted at the next free
  // hotkey. null = modal closed.
  const [panelCreatingToolText, setPanelCreatingToolText] = useState<string | null>(null);
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

  // Pending-save timer for the annotation autosave. Declared here (rather than
  // alongside useSyncManagement below) so handleOpenTrack and the other
  // track-switch resets, which run earlier, can flush it before wiping
  // annotation state — otherwise an in-flight debounced write for the track
  // being left is silently dropped instead of persisted.
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest flushPendingAutosave from useSyncManagement (defined further down,
  // after annotations/getAnnotationPath exist); kept in a ref so the
  // earlier-declared track-switch callbacks can call the current version.
  const flushPendingAutosaveRef = useRef<() => Promise<void>>(async () => {});
  // The single source of truth for annotation persistence: which track is
  // hydrated AND that track's annotations, as one atomic value (see
  // LoadedAnnotations in types.ts). Null means "nothing may be written".
  // Every disk writer — the debounced autosave and useSyncManagement's flush —
  // reads the track and the list from here together, so
  // none of them can pair a real track with a stale or placeholder list.
  const loadedAnnotationsRef = useRef<LoadedAnnotations | null>(null);
  // Sync/reload work a track switch must wait for before it flushes the old
  // track. Shared by useSyncManagement, useAnnotationLoad and handleOpenTrack.
  const [ioGate] = useState(() => new AnnotationIoGate());

  // Git sync state, the manual sync handler, and the sync-status effects live in
  // useSyncManagement (set up below, once its dependencies are declared).
  // Annotation-tool palette state, refs, and CRUD handlers live in
  // useAnnotationTools (instantiated below, after its dependencies exist).

  // Derived from project prop
  const annotationDirectory = project.annotationDirectoryAbs ?? null;

  // Chunk cache ref — not state, to avoid re-renders on every chunk load
  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const { bumpCacheVersion } = useChunkCacheVersion(chunkCacheRef);

  // Playback transport state (isPlaying/isBuffering/speed/volume/mute), the
  // playback-clock refs, engine refs, and the play/seek surface live in
  // usePlaybackTransport. Instantiated below, after the frame source + track
  // mirrors it reads exist.

  // Band-pass filter state machine — filter tool readiness, the band itself
  // (persisted), and strength. See hooks/useBandPassFilter.ts. The hook is
  // instantiated below, after engineRef / projectRef / prevProjectIdRef exist.

  // Layer activation stack — single source of truth for Esc unwinding order
  // and cursor-mode selection. See hooks/useActivationStack.ts.
  const activationStack = useActivationStack();

  // Annotation State
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // Which track `annotations` actually belongs to — a state mirror of
  // loadedAnnotationsRef's track, written by the effect further down. See there.
  const [annotationsLoadedTrack, setAnnotationsLoadedTrack] = useState<string | null>(null);
  // Undo/redo history for annotations. The two refs are reset directly by the
  // track-open / annotation-load / project-change paths below. The hook also
  // registers its own mod+z/mod+shift+z/mod+y hotkeys.
  const {
    annotationsHistoryRef,
    historyIndexRef,
    handleAnnotationsCommit,
  } = useAnnotationHistory(setAnnotations);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  // Label + span (source seconds) yanked by Mod+C, replayed by Mod+V at the
  // playhead. Persists across track switches (AnnotationWindow stays mounted).
  const annotationClipboardRef = useRef<{ text: string; color?: string; duration: number } | null>(null);
  // null = Selection Mode (no annotation tool active); string key of the active tool otherwise.
  const [activeToolKey, setActiveToolKey] = useState<string | null>(null);

  // Selection region for Selection Mode playback and UI
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);

  // Annotation currently bound to the selection region (null = free selection or no selection)
  const [boundAnnotationId, setBoundAnnotationId] = useState<string | null>(null);

  // Per-session text buffer for annotation tool reassignment, keyed by hotkey
  // digit ('0' = Custom): saves the label held under each tool while an
  // annotation is bound, so switching back to a prior tool restores the
  // previously-entered text. Cleared when the bound annotation is deselected.
  const reassignBufferRef = useRef<Record<string, string>>({});

  // Ref to Spectrogram imperative handle (prev/next annotation navigation)
  const spectrogramRef = useRef<SpectrogramHandle>(null);

  // Panel sizing + drag handling (video/spectrogram split, left-panel height &
  // width) plus the H-held hide-labels toggle. See hooks/usePanelLayout.ts.
  const {
    splitRatio,
    sidebarSections,
    leftPanelWidth, setLeftPanelWidth,
    findPanelWidth,
    filePanelCollapsed, setFilePanelCollapsed,
    videoCollapsed, setVideoCollapsed,
    hideLabels,
    VIDEO_COLLAPSED_BAR_PX,
    handleSplitDrag,
    handleLeftPanelWidthDrag,
    handleFindPanelWidthDrag,
  } = usePanelLayout({
    splitRatio: project.preferences.uiSettings?.splitRatio ?? DEFAULT_SPLIT_RATIO,
    sidebarSections: sidebarSectionsFromUiSettings(
      project.preferences.uiSettings?.sidebarSections,
      project.preferences.uiSettings?.leftPanelRatio,
    ),
    leftPanelWidth: project.preferences.uiSettings?.leftPanelWidthRatio != null
      ? project.preferences.uiSettings.leftPanelWidthRatio * window.innerWidth
      : DEFAULT_LEFT_PANEL_WIDTH,
    findPanelWidth: project.preferences.uiSettings?.findPanelWidthRatio != null
      ? project.preferences.uiSettings.findPanelWidthRatio * window.innerWidth
      : DEFAULT_FIND_PANEL_WIDTH,
    filePanelCollapsed: project.preferences.uiSettings?.filePanelCollapsed,
    videoCollapsed: project.preferences.uiSettings?.videoCollapsed,
  });
  // playheadLocked / setPlayheadLocked now come from usePlaybackTransport
  // (below), which also owns the 'c' hotkey that toggles it.

  const [showSettings, setShowSettings] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);

  const [zoomSec, setZoomSec] = useState(project.preferences.uiSettings?.zoomSec ?? DEFAULT_UI_SETTINGS.zoomSec);
  // Visible-window width in seconds, for the arrow-key ±10%-of-window scrub
  // (usePlaybackTransport) and the mod+0 zoom-to-fit toggle
  // (useSpectrogramZoomHotkeys) — both need it as a ref to avoid re-binding
  // their hotkeys on every zoom change.
  const zoomSecRef = useRef(DEFAULT_ZOOM_SEC);
  useEffect(() => { zoomSecRef.current = zoomSec; }, [zoomSec]);

  // Video-rendering mode (off / fast / mixed / accurate). Drives which player
  // VideoPane mounts and whether handleOpenTrack opens / warms a frame source.
  // Refs let async closures (engine onTimeUpdate, selection commit) read the
  // current mode without being recreated on every render.
  const [videoMode, setVideoMode] = useState<VideoMode>(
    migrateVideoMode(project.preferences.uiSettings?.videoMode),
  );
  const videoModeRef = useRef(videoMode);
  useEffect(() => { videoModeRef.current = videoMode; }, [videoMode]);

  // Display-only video brightness/contrast (CSS filter, 100 = neutral).
  // Persisted per-project like videoMode, not reset per-track.
  const [videoBrightness, setVideoBrightness] = useState(
    project.preferences.uiSettings?.videoBrightness ?? DEFAULT_UI_SETTINGS.videoBrightness,
  );
  const [videoContrast, setVideoContrast] = useState(
    project.preferences.uiSettings?.videoContrast ?? DEFAULT_UI_SETTINGS.videoContrast,
  );

  // buzzdetect activations panel — UI state + load effect live in the hook.
  // Instantiated below, after `ident` and `addLog` exist.
  // The spectrogram's live time→pixel transform, the single source the panel
  // consumes for pixel-exact x-alignment. Held in a ref-based store, NOT React
  // state: panning updates it every frame, and going through state would
  // re-render the whole window per frame (the cause of the pan stutter). The
  // spectrogram writes it; the panel subscribes and redraws its canvas directly.
  const viewportStoreRef = useRef(createViewportStore());
  const publishViewport = useCallback(
    (v: { scrollLeft: number; pixelsPerSecond: number; containerWidth: number }) => viewportStoreRef.current.set(v),
    [],
  );
  const [settings, setSettings] = useState<SpectrogramSettings>({
      ...DEFAULT_SPECTROGRAM_SETTINGS,
      ...project.preferences.spectrogramSettings,
  });

  // Bumped by "Refresh annotations" to make the open track re-read its labels.
  const [annotationReloadNonce, setAnnotationReloadNonce] = useState(0);

  // Memoized so children whose effects depend on it (e.g. CanvasVideoPlayer's
  // rAF loop) don't tear down on every parent re-render.
  const addLog = useCallback((msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  }, []);

  // Logged separately from the load-time "Video mode: X" line so the debug
  // console shows exactly when the user (vs. a project load/migration) changed it.
  const handleVideoModeChange = useCallback((mode: VideoMode) => {
    addLog(`Video mode changed: ${videoModeRef.current} -> ${mode}`);
    setVideoMode(mode);
  }, [addLog]);

  // Shared example-clip player for the tool-chip play buttons (palette + tool
  // settings). Independent of the main track's AudioEngine.
  const examplePlayer = useExamplePlayer(addLog);

  // The media, annotation and buzzdetect directory scans, and which tracks
  // have results. See hooks/useProjectScans.ts.
  const {
    scanning, annotatedTracks, setAnnotatedFiles, buzzdetectTracks,
    allNonMediaFiles, setAllNonMediaFiles,
    runMediaScan, runAnnotationScan, runBuzzdetectScan,
    handleRefreshFiles, refreshFileTree, rescanAnnotations, rescanBuzzdetect,
  } = useProjectScans({ project, allTracks, setAllMediaFiles, addLog });

  // Shared project-switch guard for the debounced persistence effects
  // (tool reconcile, band-pass, project settings). Owned here, not in any one hook.
  const prevProjectIdRef = useRef<string | null>(null);

  // Compute annotation file path: mirrors audio dir structure into annotation dir
  const getAnnotationPath = useCallback((trackFilePath: string): string | null => {
    if (!annotationDirectory || !currentDirectory) return null;
    const rel = trackFilePath.substring(currentDirectory.length);
    const withoutExt = stripExt(rel);
    return annotationDirectory + withoutExt + '.txt';
  }, [annotationDirectory, currentDirectory]);

  // Ident: relative path from audio root to track, without extension
  const getIdent = useCallback((trackFilePath: string): string | null => {
    if (!currentDirectory) return null;
    const rel = trackFilePath.substring(currentDirectory.length + 1);
    return stripExt(rel);
  }, [currentDirectory]);

  // Ident of the open track — the key linking it to its annotation and
  // buzzdetect files.
  const ident = useMemo(() => (trackPath ? getIdent(trackPath) : null), [trackPath, getIdent]);

  // Bumped by the header's manual refresh button to force useBuzzdetect's load
  // effect to re-read the current track's activations from disk even when
  // ident/dir/frameLength haven't changed. Declared here, ahead of
  // useSyncManagement's own reloadNonce (which drives the file-tree/label
  // refresh below), because useBuzzdetect is instantiated before that hook.
  const [buzzdetectReloadNonce, setBuzzdetectReloadNonce] = useState(0);

  // buzzdetect activations panel UI state + load-by-ident effect. Instantiated
  // here, well before the hooks that consume it, because the subset timeline
  // derived from it (below) decides the DISPLAY duration and the effective
  // video mode — both of which the frame source and the transport need.
  const buzzdetect = useBuzzdetect({
    initialUi: project.preferences.uiSettings,
    dir: project.buzzdetectDirectoryAbs,
    ident,
    file: null,
    frameLength: project.settings.buzzdetectFrameLength,
    trimActivationPrefix: project.settings.buzzdetectTrimActivationPrefix,
    reloadNonce: buzzdetectReloadNonce,
    addLog,
  });
  // The persisted settings (useProjectPersistence) and the Shift+S hotkey; the
  // views take the whole hook.
  const {
    buzzdetectEnabled, buzzdetectThresholds, buzzdetectSubsetThresholds, buzzdetectHiddenNeurons,
    buzzdetectNeuronColors, buzzdetectSeriesMode, buzzdetectBinWidthOverride, buzzdetectSubsetEnabled,
    buzzdetectMinDetectionRate, buzzdetectSubsetBuffer, buzzdetectPinnedNeurons,
    toggleBuzzdetectSubset,
  } = buzzdetect;

  // ── Subset mode ─────────────────────────────────────────────────────────────
  // The timeline the palette's subset cuts, and everything read off it. Identity
  // (the whole file) whenever the subset is off. See hooks/useSubsetTimeline.ts.
  const subset = useSubsetTimeline(buzzdetect, duration, videoMode);
  const {
    timeline, displayDuration,
    subsetGrainSec, subsetSourceRanges,
    effectiveVideoMode, effectiveVideoModeRef, timelineRef, displayDurationRef,
    subsetGrainRef, subsetSourceRangesRef, selectionToSource, selectAllSpanAt,
  } = subset;

  // ── Subset seam ────────────────────────────────────────────────────────────
  // Annotations are stored in source time (they name audio in the file, and
  // must keep naming it whatever the view is showing) but drawn and dragged in
  // display time. See utils/annotationProjection.ts for why the return trip
  // isn't simply the inverse.
  const { shown: displayAnnotations, hidden: hiddenAnnotations } = useMemo(
    () => projectAnnotations(annotations, timeline),
    [annotations, timeline],
  );
  const toSourceAnnotations = useCallback(
    (displayed: Annotation[]) => reconcileAnnotations(displayed, annotations, hiddenAnnotations, timeline),
    [annotations, hiddenAnnotations, timeline],
  );
  const handleDisplayAnnotationsChange = useCallback(
    (displayed: Annotation[]) => setAnnotations(toSourceAnnotations(displayed)),
    [toSourceAnnotations, setAnnotations],
  );
  const handleDisplayAnnotationsCommit = useCallback(
    (displayed: Annotation[]) => handleAnnotationsCommit(toSourceAnnotations(displayed)),
    [toSourceAnnotations, handleAnnotationsCommit],
  );


  // Annotation-tool palette: tool array + mirror ref, the folder-reconcile
  // persistence effect, and every tool CRUD/import handler. See
  // hooks/useAnnotationTools.ts. Instantiated here (before useVideoFrameSource/
  // usePlaybackTransport below) specifically so `libraryToolIndex` exists in
  // time to gate those hooks' own hotkey registrations — see the `enabled`
  // args passed to usePlaybackTransport/useBandPassFilter further down.
  const {
    annotationTools,
    annotationToolsRef,
    panelEditingToolIndex,
    setPanelEditingToolIndex,
    panelDeletingToolIndex,
    setPanelDeletingToolIndex,
    libraryToolIndex,
    setLibraryToolIndex,
    libraryPlaying,
    setLibraryPlaying,
    handleShowExamples,
    loadAnnotationTools,
    handleCreateTool,
    handleRenameTool,
    handleDeleteTool,
    handlePreviewToolColor,
    handleBindHotkey,
    handleReorderTools,
    handleImportExamples,
    handleImportExamplesToTool,
    handleRestoreToolsState,
  } = useAnnotationTools({
    project,
    projectRef,
    prevProjectIdRef,
    updateProjectPreferences,
    addLog,
    examplePlayer,
    setAnnotations,
    handleAnnotationsCommit,
    activeToolKey,
    setActiveToolKey,
    allTracks,
    trackPath,
    getAnnotationPath,
  });

  // Neurons named like a tool draw in that tool's color and follow it.
  const toolColors = useMemo(() => toolColorsByLabel(annotationTools), [annotationTools]);

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

  // Toggle the example-clip preview for a tool by id — shared by the `E`
  // hotkey path, the tools-panel chips (via liveBridge), and the annotation
  // label's "Listen to example" context action.
  const handleListenExample = useCallback((toolId: string) => {
    const tool = annotationTools.find(t => t.id === toolId);
    if (tool) examplePlayer.toggle(tool);
  }, [annotationTools, examplePlayer]);

  // An example clip is sounding via either path (chip preview or the modal).
  // While true the main track's audio is parked so the two never overlap, and
  // the spectrogram shows a dimmed "example audio is playing" veil.
  const exampleAudioActive = examplePlayer.playingToolId !== null || libraryPlaying;

  // VideoFrameSource lifecycle (frame-perfect MP4/MOV): the source handle ref,
  // its rolling-prefetch bookkeeping, the version counter, prerollVideo, and the
  // unmount + videoMode-change effects. Also owns preZoomExtentRef.
  const {
    frameSourceRef,
    videoPrefetchEndRef,
    videoPrefetchBusyRef,
    preZoomExtentRef,
    frameSourceVersion,
    setFrameSourceVersion,
    frameSourceDecodeError,
    prerollVideo,
  } = useVideoFrameSource({
    trackPath,
    trackPathRef,
    isAudioTrack,
    // Effective, not preferred: a subset closes the frame source outright.
    videoMode: effectiveVideoMode,
    durationRef,
    selectionRef,
    // Warming the selection on open decodes by position in the file, so the
    // hook needs the map from the display-time selection back to source time.
    timelineRef,
    addLog,
  });

  // Dual-transport (AudioEngine / VideoElementEngine) abstraction: playback
  // state, the playback-clock refs, the play-token guard, engine refs, and the
  // togglePlay/seek/getMediaTime surface. Reads the frame source + track mirrors.
  const transport = usePlaybackTransport({
    project,
    isAudioTrack,
    isAudioTrackRef,
    // The transport runs on the DISPLAY axis (see AudioEngine's time model), so
    // it gets the display duration and the effective video mode — under a subset
    // that's 'off', which routes playback through AudioEngine for video tracks
    // too, exactly as for audio.
    videoMode: effectiveVideoMode,
    videoModeRef: effectiveVideoModeRef,
    videoSrc,
    videoSrcRef,
    duration: displayDuration,
    durationRef: displayDurationRef,
    selection,
    selectionRef,
    frameSourceRef,
    videoPrefetchEndRef,
    videoPrefetchBusyRef,
    prerollVideo,
    // The frame source, unlike the transport, works in SOURCE time — it decodes
    // by position in the file — so the transport needs the map to convert every
    // playhead it hands over.
    timelineRef,
    spectrogramRef,
    examplePlayer,
    addLog,
    // The example-library modal owns the keyboard while open — see its own
    // key handler's comment ("the host disables its own hotkeys"). Without
    // this, its Space binding would double-fire against this hook's Space.
    enabled: libraryToolIndex === null,
  });
  const {
    isPlaying, setIsPlaying,
    setIsBuffering, isBuffering,
    playbackSpeed, setPlaybackSpeed,
    lastDefinedSpeed, setLastDefinedSpeed,
    volume, setVolume,
    muted, setMuted,
    playheadLocked, togglePlayheadLock,
    timeDisplayUnit, fallbackTimeDisplayUnit, chooseTimeDisplayUnit,
    engineRef,
    videoEngineRef,
    currentTimeRef,
    currentTimeStoreRef,
    togglePlay,
    seek,
    clearSelectionEnd,
    getMediaTime,
    attachVideoElement,
  } = transport;

  const getFrameTime = useSourceFrameTime(timelineRef, getMediaTime);

  // Spectrogram zoom-in/out/fit-to-track hotkeys (mod+=/mod+-/mod+shift+plus/
  // mod+0), shared verbatim with SingleFileWindow. mod+0's "remember where I
  // was" snapshot reads the live scroll position from the viewport store (the
  // same store the buzzdetect panel subscribes to for x-alignment).
  useSpectrogramZoomHotkeys({
    spectrogramRef,
    durationRef: displayDurationRef,
    zoomSecRef,
    preZoomExtentRef,
    selectionRef,
    getViewportStartTime: () => {
      const { scrollLeft, pixelsPerSecond } = viewportStoreRef.current.get();
      return pixelsPerSecond > 0 ? scrollLeft / pixelsPerSecond : 0;
    },
    enabled: libraryToolIndex === null,
  });

  // Keep selectionRef in sync with state (for use in rAF loop without stale closure)
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  // Pre-decode PCM for the selection so repeat plays are instant. AudioEngine
  // skips the call if the range is already covered by its cache. Debounced like
  // the video warm-up below: a drag changes the selection on every mouse move,
  // and each uncached call opens (and cancels) a decode stream.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !selection) return;
    const timer = setTimeout(() => {
      engine.preloadRange(selection.start, selection.end).catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [selection]);

  // Pre-decode video frames for the selection so the FIRST play is snappy too,
  // not just replays. Keyed on `selection` (not the commit callback) so it
  // covers every way a selection is set — drag-create, annotation click,
  // toolbar edit. Debounced because a drag updates `selection` on every mouse
  // move and each ensureRange re-decodes its GOP from the keyframe; we warm
  // once the selection settles. ensureRange fast-paths if already cached, so a
  // play that beats the timer just decodes in preroll as before.
  //
  // The selection is display time and ensureRange is source time, so it goes
  // through the timeline — same conversion the preroll and the pin make.
  useEffect(() => {
    if (isAudioTrack || !selection) return;
    const source = frameSourceRef.current;
    if (!source) return;
    const sel = selectionToSource(selection);
    const timer = setTimeout(() => {
      source.ensureRange(sel.start, sel.end, 'selectionWarm').catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [selection, isAudioTrack, selectionToSource, frameSourceRef]);

  // Clear the reassign buffer whenever the bound annotation changes (released or switched to another)
  useEffect(() => { reassignBufferRef.current = {}; }, [boundAnnotationId]);

  // If the bound annotation was deleted by an external path (e.g. empty-text
  // auto-delete on blur), clean up the tool state so handleToolActivate doesn't
  // get stuck in the bound-annotation branch with a missing target.
  useEffect(() => {
    if (boundAnnotationId !== null && !annotations.some(a => a.id === boundAnnotationId)) {
      setBoundAnnotationId(null);
      setActiveToolKey(null);
      activationStack.remove('annotationTool');
    }
  }, [annotations, boundAnnotationId, activationStack]);

  // Clear the saved pre-zoom extent on every track change. trackPathRef mirroring
  // lives in useFileNavigation; preZoomExtentRef is owned by useVideoFrameSource,
  // so the reset stays here in the orchestrator where both are in scope.
  useEffect(() => { preZoomExtentRef.current = null; }, [trackPath]);

  // Import-annotations flow: parse-error toast, overwrite/merge confirmation,
  // and the disk/live write path. See hooks/useImportAnnotations.ts.
  const {
    importError,
    setImportError,
    pendingImport,
    setPendingImport,
    handleImportAnnotations,
    resolveImport,
  } = useImportAnnotations({
    annotationDirectory,
    currentDirectory,
    projectRef,
    trackPathRef,
    annotationToolsRef,
    getAnnotationPath,
    handleAnnotationsCommit,
    setAnnotatedFiles,
    addLog,
  });

  // Builds the spectrogram chunk cache (opening a track, changing the FFT size,
  // engaging or re-graining a subset) and keeps it in step with the subset.
  const installChunkCache = useSubsetChunkCache({
    chunkCacheRef, bumpCacheVersion, fftSize: settings.fftSize,
    trackPath, sampleRate, duration, displayDuration, zoomSec,
    subsetGrainSec, subsetSourceRanges, subsetGrainRef, subsetSourceRangesRef, timelineRef,
  });

  const loadTrack = useTrackLoader({
    engineRef, zoomSecRef, setSampleRate, setDuration, setSettings, setZoomSec, installChunkCache, addLog,
  });

  // Open a track by absolute path (called from button or file panel)
  const openGenRef = useRef(0);
  const handleOpenTrack = useCallback(async (absolutePath: string) => {
    // Guard: never attempt to open a file whose extension we can't decode.
    // Both the tree and nav paths already filter these out; this is a belt-and-suspenders
    // check so a stray caller can't put us into a half-loaded state.
    if (!isSupportedMediaFile(absolutePath)) {
      addLog(`Skipped unsupported file: ${basename(absolutePath)}`, 'error');
      return;
    }

    // Re-opening the open track (a click on its row) must be a no-op: the wipe
    // below nulls the persistence snapshot, and setTrackPath(same) never
    // re-triggers the load effect that would re-arm it.
    if (absolutePath === trackPathRef.current) return;
    // A newer open supersedes this one at every await below.
    const gen = ++openGenRef.current;
    const superseded = () => gen !== openGenRef.current;

    // Tear down any prior frame source — VideoFrame handles hold GPU memory.
    if (frameSourceRef.current) {
      frameSourceRef.current.close();
      frameSourceRef.current = null;
      setFrameSourceVersion(v => v + 1);
    }
    videoPrefetchEndRef.current = 0;
    videoPrefetchBusyRef.current = false;

    // Flush any pending debounced autosave for the track being left — otherwise
    // an edit made just before switching tracks (e.g. a tool rename cascade
    // updating annotation text/color) never reaches disk.
    await flushPendingAutosaveRef.current();
    if (superseded()) return;
    // The track being left may have just been rewritten by that flush, so the
    // cached whole-project label index (Find & Rename) no longer matches disk.
    invalidateProjectLabelIndex();

    // Disarm persistence before the state wipe below, synchronously and in the
    // same tick: from here until useAnnotationLoad has actually read the new
    // track's file, nothing is allowed to write to disk.
    loadedAnnotationsRef.current = null;
    setAnnotations([]);
    setIsPlaying(false);
    setIsBuffering(false);
    setSelectedAnnotationId(null);
    setSelection(null);
    activationStack.remove('selection');
    setBoundAnnotationId(null);
    setDebugLogs([]);
    setTrackPath(absolutePath);
    // Reset playhead to beginning of track
    currentTimeRef.current = 0;
    currentTimeStoreRef.current.set(0);
    // Reset undo/redo history for new track
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;

    const fileName = basename(absolutePath);
    // Only known video extensions carry a picture; everything else (audio, or
    // unknown/unsupported) is treated as audio-only. Extension-based so it holds
    // even when a video's frames can't be decoded (the pane still shows).
    const isAudio = !isVideoFile(absolutePath);
    setIsAudioTrack(isAudio);
    setTrackName(fileName);

    const videoElementUrl = await resolveVideoElementUrl(absolutePath);
    if (superseded()) return;
    setVideoSrc(videoElementUrl);

    addLog(`Opening: ${fileName}`);
    // Only meaningful for a video track — the mode selects how frames are
    // decoded, and an audio-only track never mounts the video pane.
    if (!isAudio) addLog(`Video mode: ${videoModeRef.current}`);
    // Drop the outgoing track's spectrogram now, not when the new one finishes
    // decoding. Held any longer, the canvas keeps drawing the previous file's
    // chunks for the whole (potentially multi-second) load, so two different
    // files appear to have identical content. Batched with setIsProcessing so
    // the null cache renders as the loading state, not "Spectrogram Unavailable".
    swapChunkCache(chunkCacheRef, null);
    bumpCacheVersion();
    setIsProcessing(true);

    try {
        await loadTrack(absolutePath, superseded);
        // The frame-perfect video path (WebCodecs VideoFrameSource, MP4/MOV
        // only) is NOT opened here. useVideoFrameSource's own effect is keyed on
        // trackPath + the EFFECTIVE video mode, so `setTrackPath` above is what
        // opens it — with the subset override applied (a subset closes the frame
        // source outright), with the track-identity guard that discards a source
        // whose file has already been switched away from, and with the
        // onDecoderUnsupported callback. Opening a second one from here raced
        // that effect and orphaned whichever source lost, leaking its VideoFrame
        // handles; SingleFileWindow has always relied on the effect alone.
    } catch (err) {
        if (superseded()) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog(`Error opening file: ${errMsg}`, 'error');
        // Fully clear state so stale audio/spectrogram/video from the previous
        // file don't remain on screen while the user thinks they're seeing the
        // new one. Without this, a failed decode leaves the engine bound to the
        // previous PcmStream and the spectrogram canvas bound to the previous cache.
        setVideoSrc(null);
        setTrackPath(null);
        setDuration(0);
        setSampleRate(44100);
        setIsAudioTrack(false);
        swapChunkCache(chunkCacheRef, null);
        bumpCacheVersion();
        if (frameSourceRef.current) {
            frameSourceRef.current.close();
            frameSourceRef.current = null;
            setFrameSourceVersion(v => v + 1);
        }
    } finally {
        if (!superseded()) setIsProcessing(false);
    }
  }, [loadTrack]);

  // Mutual exclusion: whenever an example clip starts sounding, park the main
  // transport so the two files never play at once. The main play button shows
  // the existing buffering spinner (a "waiting" state) for the duration. This
  // is a coordination edge between the example player and the transport, so it
  // stays in the orchestrator.
  useEffect(() => {
    if (!exampleAudioActive) return;
    // Pause BOTH transports, not just the one activeTransport() names — same
    // reason togglePlay does: usesVideoTransport() reads frameSourceRef, which
    // is filled in asynchronously, so the engine actually sounding can differ
    // from the one named here, and pausing only that one leaves the track
    // playing underneath the example clip. pause() is idempotent on both.
    engineRef.current?.pause();
    videoEngineRef.current?.pause();
    setIsPlaying(false);
  }, [exampleAudioActive, engineRef, videoEngineRef]);

  // The ordered list used for navigation. Mirrors what the file tree actually
  // shows: shuffle order, the active fileFilter, and the entered-folder subtree —
  // so {mod}+↑/↓ can never land on a track that isn't visible in the panel.
  const displayQueue = useMemo(() => {
    const base = shuffleMode ? shuffledFiles : allTracks;
    const filter = project?.preferences.fileFilter ?? 'all';
    const buzzFilter = project?.buzzdetectDirectoryAbs ? (project?.preferences.buzzdetectFileFilter ?? 'all') : 'all';
    let list = base;
    if (filter !== 'all') list = list.filter(f => passesFileFilter(annotatedTracks.has(f), filter));
    if (buzzFilter !== 'all') list = list.filter(f => passesFileFilter(buzzdetectTracks.has(f), buzzFilter));
    const entered = project?.preferences.enteredFolderPath;
    if (entered && !shuffleMode) list = list.filter(f => isInsideDir(entered, f));
    return list;
  }, [shuffleMode, shuffledFiles, allTracks, project?.preferences.fileFilter, project?.preferences.buzzdetectFileFilter,
      project?.buzzdetectDirectoryAbs, project?.preferences.enteredFolderPath, annotatedTracks, buzzdetectTracks]);

  // Index lookup map for O(1) navigation
  const displayQueueIndex = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < displayQueue.length; i++) map.set(displayQueue[i], i);
    return map;
  }, [displayQueue]);

  const currentFileIndex = useMemo(() => {
    if (!trackPath) return -1;
    return displayQueueIndex.get(trackPath) ?? -1;
  }, [trackPath, displayQueueIndex]);

  const navigateFile = useCallback((direction: 'prev' | 'next') => {
    if (displayQueue.length === 0) return;
    const step = direction === 'prev' ? -1 : 1;
    let idx = currentFileIndex + step;
    // Skip over unsupported files so prev/next lands on a file we can actually open.
    while (idx >= 0 && idx < displayQueue.length && !isSupportedMediaFile(displayQueue[idx])) {
        idx += step;
    }
    if (idx >= 0 && idx < displayQueue.length && displayQueue[idx] !== trackPath) {
        handleOpenTrack(displayQueue[idx]);
    }
  }, [displayQueue, currentFileIndex, trackPath, handleOpenTrack]);

  // Feed subsequent edits into the persistence snapshot, but ONLY while it
  // already names this track. useAnnotationLoad seeds it (track + freshly read
  // list, in one assignment) when the read completes; this effect just keeps
  // the list current as the user edits. The trackPath check is what makes the
  // lag harmless: before the load completes the snapshot is null and this
  // writes nothing, so the placeholder [] from a track switch can never be
  // paired with a real track and persisted as a deletion.
  useEffect(() => {
    const loaded = loadedAnnotationsRef.current;
    if (loaded && loaded.trackPath === trackPath) {
      loadedAnnotationsRef.current = { trackPath: loaded.trackPath, annotations };
    }
    // Same question the line above asks, mirrored into state for the find dock:
    // is `annotations` this track's real list, or the placeholder [] a track
    // switch leaves behind until the read lands? The dock must not read the
    // placeholder as "this recording has no labels" and drop its match list
    // mid-walk. The ref itself is deliberately not state (it's on the
    // persistence path), hence the mirror.
    setAnnotationsLoadedTrack(loadedAnnotationsRef.current?.trackPath ?? null);
  }, [annotations, trackPath]);
  // Earliest and latest annotation start on the display axis, for the
  // prev/next-annotation enablement below: that's a question about what the
  // user can navigate to on screen, and the playhead it's compared against is a
  // display position. One linear pass per edit; the per-tick check is O(1).
  const displayStartExtent = useMemo(() => {
    if (displayAnnotations.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const a of displayAnnotations) {
      if (a.start < min) min = a.start;
      if (a.start > max) max = a.start;
    }
    return { min, max };
  }, [displayAnnotations]);
  const displayStartExtentRef = useRef(displayStartExtent);
  useEffect(() => { displayStartExtentRef.current = displayStartExtent; }, [displayStartExtent]);

  // Prev/next-annotation button enablement. These depend on playback time, which
  // updates ~50/sec via the currentTime store. Recomputing them through a memo
  // keyed on a per-tick state value would re-render the whole window every tick;
  // instead we hold them as state and update only when the boolean actually
  // flips (i.e. when the playhead crosses an annotation boundary), driven by a
  // store subscription. The values are derived from the same store the playhead
  // reads, so they stay in lockstep with playback (cornerstone).
  const [canGoPrevAnnotation, setCanGoPrevAnnotation] = useState(false);
  const [canGoNextAnnotation, setCanGoNextAnnotation] = useState(false);
  const canGoPrevRef = useRef(false);
  const canGoNextRef = useRef(false);
  const recomputeCanGo = useCallback(() => {
    const t = currentTimeStoreRef.current.get();
    // This runs on every playback tick, so it reads the precomputed extent
    // rather than scanning the annotations.
    const ext = displayStartExtentRef.current;
    const prev = ext !== null && ext.min < t - 0.05;
    const next = ext !== null && ext.max > t + 0.05;
    if (prev !== canGoPrevRef.current) { canGoPrevRef.current = prev; setCanGoPrevAnnotation(prev); }
    if (next !== canGoNextRef.current) { canGoNextRef.current = next; setCanGoNextAnnotation(next); }
  }, []);
  // Subscribe once on mount: recompute on every playback tick (cheap, only sets
  // state on an actual boundary crossing).
  useEffect(() => currentTimeStoreRef.current.subscribe(recomputeCanGo), [recomputeCanGo]);
  // Also recompute when the annotation set changes (a new/removed annotation can
  // flip enablement without the playhead moving).
  useEffect(() => { recomputeCanGo(); }, [displayStartExtent, recomputeCanGo]);

  // Toggle shuffle: randomise current allTracks order

  // Wall-clock start of the open track, read out of its filename with the
  // project's timestamp pattern. Null (so time readouts stay elapsed) when the
  // project defines no pattern or this particular name doesn't match it.
  const trackStartDate = useMemo(() => {
    const pattern = project.settings.filenameTimeFormat;
    if (!pattern || !trackPath) return null;
    return parseFilenameTime(basename(trackPath), pattern, project.settings.filenameTimeOffsetSeparator);
  }, [project.settings.filenameTimeFormat, project.settings.filenameTimeOffsetSeparator, trackPath]);

  // 'datetime' only applies where a start time is known; elsewhere readouts
  // fall back to the last elapsed unit the user chose.
  const shownTimeUnit = effectiveTimeUnit(timeDisplayUnit, trackStartDate, fallbackTimeDisplayUnit);

  // Style for wall-clock datetime readouts, set in the Preferences tab.
  const dateTimeFormat = project.preferences.dateTimeFormat ?? DEFAULT_DATE_TIME_FORMAT;

  // Find Label "Go": target ident + the match (start/end/label) on a track
  // that isn't currently open. Set right before handleOpenTrack fires;
  // consumed by the effect below once that track's annotations finish loading.
  const pendingGoToLabelRef = useRef<{ trackPath: string; ident: string } & LabelMatch | null>(null);

  const handleSelectionChange = useSelectionControl({
    setSelection, selectionRef, activationStack, frameSourceRef, clearSelectionEnd, selectionToSource,
  });

  // Entering or leaving a folder ends a shuffle: the queue was scoped to the
  // folder it started in. (startShuffle sets the entered folder itself, so it
  // doesn't come through here.)
  const handleEnteredFolderChange = useCallback((path: string | null) => {
    updateProjectPreferences(project.id, {
      enteredFolderPath: path ?? undefined,
      ...(shuffleMode ? { shuffleMode: false } : {}),
    });
    if (shuffleMode) setShuffleMode(false);
  }, [project, updateProjectPreferences, shuffleMode, setShuffleMode]);

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

  // Band-pass filter state machine (filter tool / band / strength + engine-push
  // and persistence effects, plus its own F / Shift+F hotkeys). Needs engineRef,
  // the activation stack, and the project plumbing for debounced persistence.
  // See hooks/useBandPassFilter.ts.
  const filter = useBandPassFilter({
    project,
    engineRef,
    activationStack,
    prevProjectIdRef,
    updateProjectPreferences,
    isAudioTrack,
    videoMode: effectiveVideoMode,
    enabled: libraryToolIndex === null,
  });
  const {
    filterToolActive, setFilterToolActive,
    bandPassFilter, setBandPassFilter,
    filterStrength, setFilterStrength,
    handleToggleFilterTool,
    handleDisableBandPassFilter,
    handleEnableBandPassFilter,
    handleBandPassFilterDrawn,
  } = filter;

  // Debounced persistence of spectrogram settings + consolidated UI fields to
  // the project file. See hooks/useProjectPersistence.ts.
  useProjectPersistence({
    project,
    projectRef,
    prevProjectIdRef,
    trackPathRef,
    updateProjectPreferences,
    settings,
    volume,
    playbackSpeed,
    lastDefinedSpeed,
    zoomSec,
    trackPath,
    buzzdetectEnabled,
    buzzdetectThresholds,
    buzzdetectSubsetThresholds,
    buzzdetectHiddenNeurons,
    buzzdetectNeuronColors,
    buzzdetectSeriesMode,
    buzzdetectBinWidthOverride,
    buzzdetectSubsetEnabled,
    buzzdetectMinDetectionRate,
    buzzdetectSubsetBuffer,
    buzzdetectPinnedNeurons,
    videoMode,
    videoBrightness,
    videoContrast,
    playheadLocked,
    timeDisplayUnit,
    fallbackTimeDisplayUnit,
    filePanelCollapsed,
    videoCollapsed,
    splitRatio,
    sidebarSections: sidebarSections.states,
    leftPanelWidth,
    findPanelWidth,
  });

  // Git sync — owns sync state, the manual handler, and status effects.
  // `setHasLocalChanges` is consumed by the autosave effect below; `reloadNonce`
  // by the annotation auto-load effect. `autoSaveTimeoutRef` is declared above
  // (with useFileNavigation) so earlier track-switch callbacks can share it.
  const {
    syncing,
    syncingRef,
    syncSummary,
    setSyncSummary,
    syncIsAutoPull,
    syncError,
    setSyncError,
    hasLocalChanges,
    setHasLocalChanges,
    hasRemoteChanges,
    reloadNonce,
    handleSync,
    confirmPendingClears,
    flushPendingAutosave,
  } = useSyncManagement({
    project,
    projectRef,
    getAnnotationPath,
    autoSaveTimeoutRef,
    trackPathRef,
    loadedAnnotationsRef,
    ioGate,
    addLog,
  });
  useEffect(() => { flushPendingAutosaveRef.current = flushPendingAutosave; }, [flushPendingAutosave]);

  // Annotation disk I/O for the active track: the debounced auto-save effect and
  // the auto-load effect. getAnnotationPath stays in the orchestrator (shared
  // with tools/import/sync); the hook drives both effects off it. Placed here so
  // its effects keep running after useSyncManagement's, exactly as before.
  useAnnotationLoad({
    projectRef,
    getAnnotationPath,
    annotationDirectory,
    currentDirectory,
    trackPath,
    trackPathRef,
    annotations,
    setAnnotations,
    annotationToolsRef,
    annotationsHistoryRef,
    historyIndexRef,
    setAnnotatedFiles,
    setHasLocalChanges,
    autoSaveTimeoutRef,
    loadedAnnotationsRef,
    syncingRef,
    reloadNonce: reloadNonce + annotationReloadNonce,
    ioGate,
    addLog,
  });

  // Load the project's tools and files on mount. Everything else starts from
  // its useState initialiser: App keys this window on the project id, so a
  // different project always gets a fresh instance.
  useEffect(() => {
    loadAnnotationTools(project);

    const openInitialTrack = (files: string[]) => {
      let firstFile = files[0];
      if (project.preferences.shuffleMode && files.length > 0) {
        // Shuffle within the folder the panel was left in, as startShuffle does.
        const entered = project.preferences.enteredFolderPath;
        const shuffled = shuffleArray(entered ? files.filter(f => isInsideDir(entered, f)) : files);
        setShuffledFiles(shuffled);
        firstFile = shuffled[0];
      }
      // Prefer the project's saved active track (resolved relative to the
      // current audio root, so it survives the project root being renamed
      // or moved). Falls through to the first file if the saved track no
      // longer exists.
      const savedRel = project.preferences.uiSettings?.activeTrackPath;
      if (savedRel) {
        const savedAbs = `${project.mediaDirectoryAbs}/${savedRel}`;
        if (files.includes(savedAbs)) firstFile = savedAbs;
      }
      if (firstFile) handleOpenTrack(firstFile);
    };
    let openedFromCache = false;
    runAnnotationScan().catch(err => addLog(`Error scanning annotations: ${err}`, 'error'));
    const mediaScan = runMediaScan(project.mediaDirectoryAbs, {
      useCache: true,
      onCached: cached => {
        openedFromCache = true;
        openInitialTrack(cached.files);
      },
    });
    // The cached buzzdetect list shows right away; the walk waits for the media scan.
    runBuzzdetectScan({ useCache: true, after: mediaScan.catch(() => null) })
      .catch(err => addLog(`Error scanning buzzdetect directory: ${err}`, 'error'));
    mediaScan
      .then(final => {
        if (!final) return;
        if (!openedFromCache) {
          openInitialTrack(final.files);
        } else if (project.preferences.shuffleMode) {
          // The queue was shuffled from the cached list; keep its order and
          // fold in whatever the real scan added or dropped.
          setShuffledFiles(prev => {
            const present = new Set(final.files);
            const kept = prev.filter(f => present.has(f));
            const known = new Set(kept);
            return [...kept, ...shuffleArray(final.files.filter(f => !known.has(f)))];
          });
        }
      })
      .catch(err => {
        setAllMediaFiles([]);
        setAllNonMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Annotations: the tool set, the find index, the open track's labels, and
  // which tracks have annotation files.
  const refreshAnnotations = useCallback(async () => {
    invalidateProjectLabelIndex();
    loadAnnotationTools(project);
    ioGate.requestReload();
    setAnnotationReloadNonce(n => n + 1);
    await rescanAnnotations().catch(err => addLog(`Error refreshing annotations: ${err}`, 'error'));
  }, [project, loadAnnotationTools, rescanAnnotations, ioGate, addLog]);

  const refreshBuzzdetect = useCallback(async () => {
    setBuzzdetectReloadNonce(n => n + 1);
    await rescanBuzzdetect().catch(err => addLog(`Error refreshing buzzdetect results: ${err}`, 'error'));
  }, [rescanBuzzdetect, addLog]);

  // After a git sync pulls new data, refresh the file tree so freshly-arrived
  // annotation files show as annotated (and any new media files appear), and
  // reload annotation tools in case the project's tool set changed on disk too.
  // reloadNonce only bumps on a successful pull; skip the initial 0.
  useEffect(() => {
    if (reloadNonce === 0) return;
    // A pull rewrites files behind the app's back, so anything the Find &
    // Rename index holds for other tracks is now stale.
    invalidateProjectLabelIndex();
    handleRefreshFiles();
    loadAnnotationTools(project);
  }, [reloadNonce, handleRefreshFiles, loadAnnotationTools]); // eslint-disable-line react-hooks/exhaustive-deps

  // The header's refresh button: everything at once.
  const handleRefreshAll = useCallback(() => {
    refreshFileTree().then(() => refreshBuzzdetect());
    refreshAnnotations();
  }, [refreshFileTree, refreshAnnotations, refreshBuzzdetect]);

  const handleProjectSettingsSaved = useCallback(async (updatedSettings: ProjectSettings, updatedPreferences: ProjectPreferences) => {
    const prev = project.settings.mediaDirectory;
    const next = updatedSettings.mediaDirectory;
    const mediaDirChanged = prev.kind !== next.kind || prev.path !== next.path;
    const updated = await updateProjectSettings(project.id, updatedSettings);
    if (!updated) {
      setShowProjectSettings(false);
      return;
    }
    // Only what the modal actually changed: it holds a copy of the preferences from
    // when it opened, and writing all of it back would revert anything the debounced
    // persisters (UI layout, filter, tool hotkeys) saved in the meantime.
    await updateProjectPreferences(project.id, preferencesPatch(project.preferences, updatedPreferences));
    loadAnnotationTools(updated);
    setVideoMode(migrateVideoMode(updated.preferences.uiSettings?.videoMode));
    if (mediaDirChanged) {
      await flushPendingAutosaveRef.current();
      setCurrentDirectory(updated.mediaDirectoryAbs);
      loadedAnnotationsRef.current = null;
      setTrackPath(null);
      setVideoSrc(null);
      setAnnotations([]);
      // Drop the old directory's list so a scan of the new one starts from empty.
      setAllMediaFiles([]);
      setAllNonMediaFiles([]);
      let openedFirst = false;
      const openFirst = (files: string[]) => {
        if (files.length > 0) { openedFirst = true; handleOpenTrack(files[0]); }
      };
      try {
        const final = await runMediaScan(updated.mediaDirectoryAbs, {
          useCache: true,
          onCached: cached => openFirst(cached.files),
        });
        if (final && !openedFirst) openFirst(final.files);
      } catch (err) {
        setAllMediaFiles([]);
        setAllNonMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      }
    }
    setShowProjectSettings(false);
  }, [project, updateProjectSettings, updateProjectPreferences, handleOpenTrack, loadAnnotationTools, runMediaScan]);

  const handleToggleFileFilter = useCallback(() => {
    updateProjectPreferences(project.id, {
      fileFilter: nextFileFilter(project.preferences.fileFilter ?? 'all'),
    });
  }, [project, updateProjectPreferences]);

  const handleToggleBuzzdetectFilter = useCallback(() => {
    updateProjectPreferences(project.id, {
      buzzdetectFileFilter: nextFileFilter(project.preferences.buzzdetectFileFilter ?? 'all'),
    });
  }, [project, updateProjectPreferences]);

  // The file panel's expand/collapse state lives inside FileTree; it reports it
  // up so the help guide's live copy of the header buttons can show and drive it.
  const fileTreeHeaderRef = useRef<{ toggleExpandCollapse: () => void } | null>(null);
  const [fileTreeAnyExpanded, setFileTreeAnyExpanded] = useState(false);
  const handleFileTreeHeaderState = useCallback((state: { anyExpanded: boolean; toggleExpandCollapse: () => void }) => {
    fileTreeHeaderRef.current = state;
    setFileTreeAnyExpanded(state.anyExpanded);
  }, []);

  const handleFindLabelUseRegexChange = useCallback((useRegex: boolean) => {
    updateProjectPreferences(project.id, { findLabelUseRegex: useRegex });
  }, [project, updateProjectPreferences]);

  const handleFindLabelPartialChange = useCallback((partial: boolean) => {
    updateProjectPreferences(project.id, { findLabelPartialMatch: partial });
  }, [project, updateProjectPreferences]);

  const handleFindLabelCaseSensitiveChange = useCallback((caseSensitive: boolean) => {
    updateProjectPreferences(project.id, { findLabelCaseSensitive: caseSensitive });
  }, [project, updateProjectPreferences]);

  const handleRevealInFinder = useCallback((path: string) => {
    revealInFileManager(path).catch(err => addLog(`reveal_in_file_manager error: ${err}`, 'error'));
  }, []);

  const handleRevealAnnotations = useCallback((audioFilePath: string) => {
    if (!allTracks.includes(audioFilePath)) {
      if (annotationDirectory && currentDirectory && audioFilePath.startsWith(currentDirectory)) {
        const relSubdir = audioFilePath.substring(currentDirectory.length);
        revealInFileManager(annotationDirectory + relSubdir).catch(() => {
          if (annotationDirectory) revealInFileManager(annotationDirectory).catch(() => {});
        });
      } else if (annotationDirectory) {
        revealInFileManager(annotationDirectory).catch(() => {});
      }
      return;
    }
    const annotPath = getAnnotationPath(audioFilePath);
    if (annotPath) {
      revealInFileManager(annotPath).catch(() => {
        if (annotationDirectory) revealInFileManager(annotationDirectory).catch(() => {});
      });
    } else if (annotationDirectory) {
      revealInFileManager(annotationDirectory).catch(() => {});
    }
  }, [allTracks, getAnnotationPath, annotationDirectory, currentDirectory]);

  // Enter the annotation-tool layer: push its activation-stack entry and drop
  // the filter tool. The three side effects that always accompany readying a
  // tool, in one place.
  const enterAnnotationToolLayer = useCallback(() => {
      activationStack.pushIfAbsent('annotationTool');
      setFilterToolActive(false);
      activationStack.remove('filterTool');
  }, [activationStack]);

  // Ready a tool by key, unconditionally (no toggle-off, no selection/bound
  // side effects). Used when a tool has just been added from the palette.
  const readyTool = useCallback((key: string) => {
      setActiveToolKey(key);
      enterAnnotationToolLayer();
  }, [enterAnnotationToolLayer]);

  // Shared handler for activating an annotation tool by key — used by both
  // number hotkeys and palette clicks. Also manages the `annotationTool` entry
  // in the activation stack: pushIfAbsent on activate, remove when this
  // call toggles the tool off (same key pressed twice).
  const handleToolActivate = useCallback((key: string) => {
      const tool = annotationTools.find(t => t.key === key);
      if (!tool) return;
      const isCustom = tool.key === '0';
      if (boundAnnotationId !== null) {
          const currentAnnotation = annotations.find(a => a.id === boundAnnotationId);
          if (currentAnnotation) {
              // The annotation's current owner is whichever defined tool shares
              // its label; if none, it's a Custom label (bucket '0'). Stash its
              // text under that owner so toggling back restores what was typed.
              const currentOwner = annotationTools.find(t => t.key !== '0' && t.text === currentAnnotation.text);
              reassignBufferRef.current = {
                  ...reassignBufferRef.current,
                  [currentOwner?.key ?? '0']: currentAnnotation.text,
              };
              const savedText = reassignBufferRef.current[tool.key ?? ''];
              // Custom has no canonical text to reassign to, so with nothing
              // buffered yet, keep the annotation's current text — pressing 0
              // should hand the existing label to Custom for editing, not blank it.
              const newText = savedText !== undefined ? savedText : (isCustom ? currentAnnotation.text : tool.text);
              // A restored Custom text can coincidentally match a defined tool's
              // label; resolveLabelColor adopts that tool's color instead of the
              // generic Custom color (falls back to `tool.color` either way).
              const updated = annotations.map(a => a.id === boundAnnotationId
                  ? { ...a, text: newText, color: resolveLabelColor(newText, annotationTools, tool.color) }
                  : a
              );
              handleAnnotationsCommit(updated);
              setActiveToolKey(key);
              enterAnnotationToolLayer();
              if (isCustom) {
                  setTimeout(() => spectrogramRef.current?.focusAnnotationInput(boundAnnotationId), 0);
              }
          }
      } else if (activeToolKey === null && selection !== null) {
          const src = selectionToSource(selection);
          const newAnnotation = makeAnnotationFromTool(tool, src.start, src.end);
          handleAnnotationsCommit([...annotations, newAnnotation]);
          setSelectedAnnotationId(newAnnotation.id);
          setBoundAnnotationId(newAnnotation.id);
          setActiveToolKey(key);
          enterAnnotationToolLayer();
      } else if (activeToolKey === key) {
          setActiveToolKey(null);
          activationStack.remove('annotationTool');
      } else {
          readyTool(key);
      }
  }, [annotationTools, boundAnnotationId, annotations, activeToolKey, selection, handleAnnotationsCommit, reassignBufferRef, activationStack, selectionToSource, enterAnnotationToolLayer, readyTool]);

  // Global Hotkeys — see hooks/useHotkeys.ts. Handlers close over the latest
  // render's state (the bindings array is read from a ref refreshed each render),
  // so we don't need to manage a dep list here.
  const selectAllOrAnnotateFullTrack = () => {
      if (displayDuration <= 0) return;
      const span = selectAllSpanAt(currentTimeRef.current);
      if (activeToolKey !== null) {
          const tool = annotationTools.find(t => t.key === activeToolKey);
          if (tool) {
              const src = selectionToSource(span);
              const newAnnotation = makeAnnotationFromTool(tool, src.start, src.end);
              handleAnnotationsCommit([...annotations, newAnnotation]);
              setSelectedAnnotationId(newAnnotation.id);
              setBoundAnnotationId(newAnnotation.id);
              handleSelectionChange(span);
          }
      } else {
          handleSelectionChange(span);
      }
  };
  // Enter — deselect the current annotation, dropping the audio selection
  // region that selecting it created. No-op when nothing is selected.
  const deselectAnnotation = () => {
      if (selectedAnnotationId === null) return;
      setSelectedAnnotationId(null);
      setBoundAnnotationId(null);
      handleSelectionChange(null);
  };
  const deleteSelectedAnnotation = () => {
      if (!selectedAnnotationId) return;
      handleAnnotationsCommit(annotations.filter(a => a.id !== selectedAnnotationId));
      const wasBound = selectedAnnotationId === boundAnnotationId;
      setSelectedAnnotationId(null);
      if (wasBound) {
          handleSelectionChange(null);
          setBoundAnnotationId(null);
      }
  };
  // Mod+C — yank the selected annotation's label and span. Mod+V then recreates
  // that annotation starting at the playhead, its end trimmed to the track (or,
  // under a subset, to the segment the playhead sits in).
  const copyActiveAnnotation = () => {
      const ann = annotations.find(a => a.id === selectedAnnotationId)
          ?? annotations.find(a => a.id === boundAnnotationId);
      if (!ann) return;
      annotationClipboardRef.current = { text: ann.text, color: ann.color, duration: ann.end - ann.start };
  };
  // Mod+B — bind the selected annotation's label to the next free hotkey,
  // creating a tool for it if none carries that label yet. If the label already
  // sits on a hotkey, just ready that tool instead. Same bind action as the
  // annotation context menu's "Bind to hotkey".
  const bindSelectedAnnotationToHotkey = () => {
      const ann = annotations.find(a => a.id === selectedAnnotationId);
      if (!ann) return;
      const existing = annotationMatchingTool(ann, annotationTools);
      if (existing?.key != null) {
          readyTool(existing.key);
          return;
      }
      const key = bindAnnotationToHotkey(ann, annotationTools, {
          onBindHotkey: handleBindHotkey,
          onCreateTool: handleCreateTool,
      });
      // Ready the freshly bound tool so it's immediately usable.
      if (key) readyTool(key);
  };
  const pasteAnnotationAtPlayhead = () => {
      const clip = annotationClipboardRef.current;
      if (!clip || displayDuration <= 0) return;
      const startD = Math.max(0, Math.min(currentTimeRef.current, displayDuration));
      const endD = Math.min(timeline.clampToSpanOfDisplay(startD, startD + clip.duration), displayDuration);
      if (endD <= startD) return;
      const src = selectionToSource({ start: startD, end: endD });
      const color = resolveLabelColor(clip.text, annotationTools, clip.color ?? '#ffffff');
      const newAnnotation = makeAnnotationFromLabel(clip.text, color, src.start, src.end);
      handleAnnotationsCommit([...annotations, newAnnotation]);
      // Select and bind it, with the selection region on the pasted span —
      // the same end state as creating an annotation from a drag or a tool key.
      setSelectedAnnotationId(newAnnotation.id);
      setBoundAnnotationId(newAnnotation.id);
      handleSelectionChange({ start: startD, end: endD });
  };

  // Export the current selection's audio (spectrogram's right-click menu and
  // Mod+Shift+E), named after the project's filename-timestamp scheme.
  const handleExportSelection = useExportSelection({
    selection, trackPath, selectionToSource, addLog,
    filenameTimeFormat: project.settings.filenameTimeFormat,
    filenameTimeOffsetSeparator: project.settings.filenameTimeOffsetSeparator,
  });

  useHotkeys([
      // Help guide — also fires inside text inputs, since help is universal.
      { key: 'F1', allowInInput: true, handler: () => showHelpPage() },

      // Mod+key bindings. Undo/redo (useAnnotationHistory), band-pass filter
      // toggle (useBandPassFilter), spectrogram zoom (useSpectrogramZoomHotkeys),
      // and playback transport (space/,/./r/m/c, usePlaybackTransport; the
      // arrow keys are useArrowKeys, registered further down)
      // now register their own hotkeys where their state/handlers live — see
      // those hooks' instantiations above. What's left here is annotation- and
      // file-navigation-specific glue that only this window has.
      { key: 'a', mods: ['mod'], handler: selectAllOrAnnotateFullTrack },
      { key: 'f', mods: ['mod'], handler: openFindLabel },
      { key: 'ArrowLeft', mods: ['mod'], handler: () => spectrogramRef.current?.goToTrackStart() },
      { key: 'ArrowRight', mods: ['mod'], handler: () => spectrogramRef.current?.goToTrackEnd() },
      { key: 'ArrowLeft', mods: ['alt'], handler: () => spectrogramRef.current?.goToPrevAnnotation() },
      { key: 'ArrowRight', mods: ['alt'], handler: () => spectrogramRef.current?.goToNextAnnotation() },
      { key: 'ArrowUp', mods: ['mod'], handler: () => navigateFile('prev') },
      { key: 'ArrowDown', mods: ['mod'], handler: () => navigateFile('next') },
      { key: 'e', mods: ['mod', 'shift'], handler: () => handleExportSelection() },
      { key: 'c', mods: ['mod'], handler: copyActiveAnnotation },
      { key: 'v', mods: ['mod'], handler: pasteAnnotationAtPlayhead },
      { key: 'b', mods: ['mod'], handler: bindSelectedAnnotationToHotkey },
      { key: 'b', mods: ['mod', 'shift'], handler: () => {
          handleReorderTools(annotationTools.map((t, i) => (i !== 0 && t.key !== null ? { ...t, key: null } : t)));
      }},

      // `S`: select tool (no annotation tool readied). Stack-equivalent to
      // removing the `annotationTool` entry — does not touch selection, filter
      // tool, or band.
      { key: 's', handler: () => {
          setActiveToolKey(null);
          activationStack.remove('annotationTool');
      }},
      // `Shift+S`: subset the track to the ticked neurons' detections, and
      // back. No-op until a neuron is ticked in the buzzdetect panel — there'd
      // be nothing to subset by.
      { key: 's', mods: ['shift'], handler: toggleBuzzdetectSubset },
      { key: 'Enter', handler: deselectAnnotation },
      { key: 'e', handler: () => {
          if (activeToolKey === null) return;
          const tool = annotationTools.find(t => t.key === activeToolKey);
          if (tool) examplePlayer.toggle(tool);
      }},
      // Escape — universal undo of the most-recently-activated layer. (The
      // guide's own Esc-to-close lives in its own window, so the two never contend.)
      escapeUnwindBinding(activationStack, {
        annotationTool: () => setActiveToolKey(null),
        selection: () => { handleSelectionChange(null); setBoundAnnotationId(null); },
        filterTool: () => setFilterToolActive(false),
        filterBand: () => setBandPassFilter(null),
      }),
      { key: 'Delete', handler: deleteSelectedAnnotation, preventDefault: false },
      { key: 'Backspace', handler: deleteSelectedAnnotation, preventDefault: false },

      // 0-9: activate annotation tool by key, if defined. Stack management
      // (pushIfAbsent on activate; remove on toggle-off) lives in
      // handleToolActivate so palette clicks and hotkeys agree. Also allowed
      // while Alt is held, since Alt+Digit isn't bound to anything else here.
      { key: 'Digit', handler: (e) => {
          const digit = digitFromEvent(e);
          const tool = annotationTools.find(t => t.key === digit);
          if (tool) handleToolActivate(digit);
      }},
      { key: 'Digit', mods: ['alt'], handler: (e) => {
          const digit = digitFromEvent(e);
          const tool = annotationTools.find(t => t.key === digit);
          if (tool) handleToolActivate(digit);
      }},
  ], libraryToolIndex === null);  // disabled while the example library modal owns the keyboard


  // A bound selection carries its annotation with it, exactly as dragging the
  // selection's edges does (useSpectrogramInteraction). Keyboard extends stream
  // through `setAnnotations` and land in undo history once, when the burst
  // settles — otherwise every keypress in a held run would be its own undo step.
  // The draft ref carries the run: `annotations` is a render-old snapshot, and a
  // ramp takes many steps per render.
  const [sweepStart, setSweepStart] = useState<number | null>(null);

  // Keyed to its track: a draft still settling when the track switches must
  // not be committed onto the next track's annotations.
  const boundResizeDraftRef = useRef<{ trackPath: string | null; list: Annotation[] } | null>(null);
  const resizeBoundAnnotationTo = useCallback((sel: Selection | null) => {
    if (!boundAnnotationId || !sel) return;
    const src = selectionToSource(sel);
    const draft = boundResizeDraftRef.current;
    const base = draft && draft.trackPath === trackPathRef.current ? draft.list : annotations;
    const next = base.map(a =>
      a.id === boundAnnotationId ? { ...a, start: src.start, end: src.end } : a
    );
    boundResizeDraftRef.current = { trackPath: trackPathRef.current, list: next };
    setAnnotations(next);
  }, [boundAnnotationId, annotations, selectionToSource, setAnnotations]);
  const commitBoundAnnotationResize = useCallback(() => {
    const draft = boundResizeDraftRef.current;
    boundResizeDraftRef.current = null;
    if (draft && draft.trackPath === trackPathRef.current) handleAnnotationsCommit(draft.list);
  }, [handleAnnotationsCommit]);

  // A Shift+Arrow extend that builds a selection from scratch (nothing bound
  // yet) has no annotation to resize, so resizeBoundAnnotationTo is a no-op
  // through the whole gesture — mirroring a mouse drag, which stays a bare
  // selection until release. On settle, if a tool is readied, promote the
  // finished span into a new annotation from that tool, exactly as releasing
  // the mouse with a tool readied would (useSpectrogramInteraction's
  // commitNewAnnotation). An already-bound annotation just gets its resize
  // committed, as before.
  const handleExtendSettled = useCallback(() => {
    if (boundAnnotationId === null && activeToolKey !== null && selectionRef.current) {
      const tool = annotationTools.find(t => t.key === activeToolKey);
      if (tool) {
        const src = selectionToSource(selectionRef.current);
        const newAnnotation = makeAnnotationFromTool(tool, src.start, src.end);
        handleAnnotationsCommit([...annotations, newAnnotation]);
        setSelectedAnnotationId(newAnnotation.id);
        setBoundAnnotationId(newAnnotation.id);
        return;
      }
    }
    commitBoundAnnotationResize();
  }, [boundAnnotationId, activeToolKey, annotationTools, selectionRef, selectionToSource, annotations, handleAnnotationsCommit, commitBoundAnnotationResize]);

  // All arrow-key playhead movement (coarse scrub, fine ramp, Shift extend).
  // Lives here rather than in usePlaybackTransport because it needs the
  // selection wrapper above, which is defined after that hook runs.
  useArrowKeys({
    selectionRef,
    currentTimeRef,
    durationRef: displayDurationRef,
    zoomSecRef,
    getPixelsPerSecond: () => viewportStoreRef.current.get().pixelsPerSecond,
    seek,
    revealTime: t => spectrogramRef.current?.revealTime(t),
    centerOnPlayhead: t => spectrogramRef.current?.scrollToTime(t),
    playheadLocked,
    isPlaying,
    onSelectionChange: s => { handleSelectionChange(s); resizeBoundAnnotationTo(s); },
    onExtendSettled: handleExtendSettled,
    enabled: libraryToolIndex === null,
  });

  // Hold Shift while listening to mark out what you're hearing. Only the
  // in-progress span lives here; the selection itself arrives on release.
  useShiftSweep({
    isPlaying,
    pause: () => { if (isPlaying) togglePlay(); },
    selectionRef,
    currentTimeRef,
    onCommitSpan: (anchor, edge, quiet) => spectrogramRef.current?.commitSpan(anchor, edge, quiet),
    onSweepStartChange: setSweepStart,
    enabled: libraryToolIndex === null,
  });

  // Hand the engine the subset's axis and bring the view onto it — see
  // hooks/useSubsetSync.ts. Ordering against the Find & Rename "Go" below matters.
  useTimelineSwap({
    timeline, displayDuration, engineRef, handleSelectionChange, seek, currentTimeRef,
    spectrogramRef, zoomSecRef, setZoomSec,
  });

  // Finish a cross-track Find & Rename "Go": select + scroll once the target
  // track has finished loading and its annotations are in memory.
  //
  // Declared *after* the timeline effect above on purpose. A track load ends
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

  // Called by Toolbar time-field edits to sync the bound annotation's bounds.
  const handleToolbarAnnotationBoundsChange = useCallback((start: number, end: number) => {
    if (!boundAnnotationId) return;
    const old = annotations.find(a => a.id === boundAnnotationId);
    // Both times here are display; `old.start` is source, so the comparison is
    // made on the display axis the playhead is also on.
    if (old && Math.abs(currentTimeRef.current - timeline.toDisplay(old.start)) <= 0.5) {
      seek(start, false);
    }
    // Same resize the keyboard extend makes, committed immediately — a typed
    // edit is a single deliberate change, not a run of them.
    resizeBoundAnnotationTo({ start, end });
    commitBoundAnnotationResize();
  }, [boundAnnotationId, annotations, seek, timeline, resizeBoundAnnotationTo, commitBoundAnnotationResize]);

  useWindowLiveHost({
    transport, filter, buzzdetect, subset,
    hasTrack: !!videoSrc, duration, sampleRate, isAudioTrack, videoMode,
    selection, handleSelectionChange, setBoundAnnotationId,
    onSelectionSet: d => handleToolbarAnnotationBoundsChange(d.start, d.end),
    settings, setSettings, showSettings, setShowSettings, debugLogs, spectrogramRef,
    snapshot: {
      isBuffering: isBuffering || exampleAudioActive,
      timeDisplayUnit: shownTimeUnit,
      selectedTimeDisplayUnit: timeDisplayUnit,
      trackStartMs: trackStartDate?.getTime() ?? null,
      dateTimeFormat,
      canGoPrevAnnotation,
      canGoNextAnnotation,
      buzzdetectAvailable: project.buzzdetectDirectoryAbs !== null,
      filePanel: {
        fileFilter: project.preferences.fileFilter ?? 'all',
        buzzdetectFilter: project.preferences.buzzdetectFileFilter ?? 'all',
        hasBuzzdetect: project.buzzdetectDirectoryAbs !== null,
        shuffleMode,
        anyExpanded: fileTreeAnyExpanded,
      },
      toolPalette: {
        tools: annotationTools,
        activeToolKey,
        playingExampleToolId: examplePlayer.playingToolId,
      },
    },
    handlers: {
      toggleFileExpandCollapse: () => fileTreeHeaderRef.current?.toggleExpandCollapse(),
      toggleFileFilter: handleToggleFileFilter,
      toggleBuzzdetectFilter: handleToggleBuzzdetectFilter,
      activateTool: handleToolActivate,
      activateSelectMode: () => { setActiveToolKey(null); activationStack.remove('annotationTool'); },
      openToolSettings: () => setShowToolSettings(true),
      openFindLabel,
      editTool: setPanelEditingToolIndex,
      requestDeleteTool: setPanelDeletingToolIndex,
      playExample: handleListenExample,
      showExamples: handleShowExamples,
    },
  });

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      {/* Header */}
      <header className="flex-none h-16 bg-slate-800 border-b border-slate-700 flex items-center px-4 justify-between select-none z-50 relative" data-help-target="toolbar">
        <div className="flex items-center space-x-4">
            <button
                onClick={onClose}
                className="flex items-center space-x-1 text-slate-400 hover:text-white hover:bg-slate-700 px-2 py-1.5 rounded transition-colors"
                data-tooltip={tooltips.backToProjects}
            >
                <ArrowLeft size={18} />
            </button>
            <button
                onClick={handleRefreshAll}
                className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                data-tooltip={tooltips.refreshAll}
                data-help-target="header-refresh-btn"
            >
                <RefreshCw size={18} />
            </button>
            <button
                onClick={() => setShowProjectSettings(true)}
                className="flex items-center space-x-2 px-2 py-1.5 rounded hover:bg-slate-700 transition-colors group"
                data-tooltip={tooltips.projectSettings}
                data-help-target="project-settings-btn"
            >
                <h1 className="text-xl font-bold">
                    <GradientProjectName name={project.settings.projectName} nameGradientColors={project.settings.nameGradientColors} />
                </h1>
                <Settings size={15} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0" />
            </button>
        </div>

        <div />

        <div className="flex items-center space-x-3">
             {project.settings.gitSync && (
               <SyncControls
                 remoteUrl={project.settings.gitSync.remoteUrl}
                 syncing={syncing}
                 hasLocalChanges={hasLocalChanges}
                 hasRemoteChanges={hasRemoteChanges}
                 onSync={handleSync}
               />
             )}
             <button
                onClick={() => setShowDebug(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                data-tooltip={debugConsole.title}
            >
                <Bug size={18} />
            </button>
             <button
                onClick={() => showHelpPage()}
                className="p-2 rounded hover:bg-slate-700 transition-colors text-slate-400 hover:text-white"
                data-tooltip={tooltips.helpGuide}
            >
                <HelpCircle size={18} />
            </button>
             <button
                onClick={() => showHelpPage('shortcuts')}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                data-tooltip={tooltips.keyboardShortcuts}
            >
                <Keyboard size={18} />
            </button>
        </div>
      </header>

      <SyncToast
        summary={syncSummary}
        error={syncError}
        isAutoPull={syncIsAutoPull}
        onClose={() => { setSyncSummary(null); setSyncError(null); }}
        onCommitClears={confirmPendingClears}
      />

      <DebugConsole open={showDebug} onClose={() => setShowDebug(false)} logs={debugLogs} />

      <HelpHighlightHost />

      {/* Import-annotations conflict confirmation */}
      {pendingImport && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-5 max-w-md mx-4">
            <h3 className="text-sm font-semibold text-slate-100 mb-2">{annotationWindow.importConflictTitle}</h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              This track already has {pendingImport.existing.length} annotation{pendingImport.existing.length !== 1 ? 's' : ''}.
              Importing {pendingImport.incoming.length} from <span className="text-slate-100">{pendingImport.sourceName}</span> —
              overwrite the existing ones, or merge (append) the new ones onto them?
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs rounded text-slate-300 hover:bg-slate-700"
                onClick={() => setPendingImport(null)}
              >
                {annotationWindow.importCancel}
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded bg-slate-700 text-slate-100 hover:bg-slate-600"
                onClick={() => resolveImport('overwrite')}
              >
                {annotationWindow.importOverwrite}
              </button>
              <button
                className="px-3 py-1.5 text-xs rounded bg-[#e65161] text-white hover:bg-[#e65161]/80"
                onClick={() => resolveImport('merge')}
              >
                {annotationWindow.importMerge}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import parse error */}
      {importError && (
        <MessageDialog
          title={annotationWindow.importErrorTitle}
          message={importError}
          okLabel={annotationWindow.importOk}
          onClose={() => setImportError(null)}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex relative overflow-hidden select-none">
        {/* Left Panel: File Tree (top) + Labels Panel (bottom) */}
        {currentDirectory && (() => {
          const fileTreeProps = {
            rootDirectory: currentDirectory,
            isScanning: scanning.size > 0,
            isScanningMedia: scanning.has('media'),
            allFiles: displayQueue,
            allFilesUnfiltered: shuffleMode ? shuffledFiles : allTracks,
            currentTrack: trackPath,
            onFileSelect: handleOpenTrack,
            onToggleCollapse: () => setFilePanelCollapsed(c => {
              if (c) setLeftPanelWidth(180);
              return !c;
            }),
            shuffleMode,
            onStartShuffle: (folder: string) => startShuffle(folder === currentDirectory ? null : folder),
            onStopShuffle: stopShuffle,
            annotatedTracks,
            buzzdetectTracks,
            showBuzzdetect: project.buzzdetectDirectoryAbs !== null,
            fileFilter: project?.preferences.fileFilter ?? 'all',
            onToggleFileFilter: handleToggleFileFilter,
            buzzdetectFilter: project?.preferences.buzzdetectFileFilter ?? 'all',
            onToggleBuzzdetectFilter: handleToggleBuzzdetectFilter,
            onClearFileFilter: () => updateProjectPreferences(project.id, { fileFilter: 'all' }),
            onClearBuzzdetectFilter: () => updateProjectPreferences(project.id, { buzzdetectFileFilter: 'all' }),
            onRefreshFileTree: refreshFileTree,
            onRevealInFinder: handleRevealInFinder,
            onRevealAnnotations: handleRevealAnnotations,
            onRevealAnnotationsRoot: annotationDirectory
              ? () => revealInFileManager(annotationDirectory).catch(() => {})
              : undefined,
            onImportAnnotations: handleImportAnnotations,
            nonMediaFiles: allNonMediaFiles,
            filenameTimeInfo: {
              pattern: project.settings.filenameTimeFormat ?? '',
              offsetSeparator: project.settings.filenameTimeOffsetSeparator,
              dateTimeFormat,
            },
            enteredFolderPath: project?.preferences.enteredFolderPath ?? null,
            onEnteredFolderChange: handleEnteredFolderChange,
            onHeaderState: handleFileTreeHeaderState,
          };

          if (filePanelCollapsed) {
            return (
              <div className="flex-none w-10 bg-slate-900 border-r border-slate-700 flex flex-col h-full relative">
                <FileTree {...fileTreeProps} collapsed={true} sectionCollapsed={false} onToggleSectionCollapsed={() => {}} />
                <CollapsedToolsRail
                  annotationTools={annotationTools}
                  activeToolKey={activeToolKey}
                  onToolActivate={handleToolActivate}
                  onOpenSettings={() => setShowToolSettings(true)}
                />
                <div
                  className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
                  style={{ right: '-6px', width: '6px' }}
                  onMouseDown={handleLeftPanelWidthDrag}
                />
              </div>
            );
          }

          // The sidebar's stack, top to bottom. The neuron palette is only in
          // it when the project names a buzzdetect directory — that's what
          // decides whether this project has neurons at all — and the two
          // remaining sections reflow into the space by themselves when it's
          // absent (see SidebarStack). Deliberately NOT gated on the graph
          // being open: the palette's thresholds drive the subset, which is a
          // thing you can want without the graph taking up the window.
          const stackItems = [
            {
              id: SIDEBAR_SECTION_FILES,
              node: (
                <FileTree
                  {...fileTreeProps}
                  collapsed={false}
                  sectionCollapsed={sidebarSections.isCollapsed(SIDEBAR_SECTION_FILES)}
                  onToggleSectionCollapsed={() => sidebarSections.toggleCollapsed(SIDEBAR_SECTION_FILES)}
                />
              ),
            },
            {
              id: SIDEBAR_SECTION_LABELS,
              node: (
                <AnnotationToolsPanel
                  annotationTools={annotationTools}
                  activeToolKey={activeToolKey}
                  onToolActivate={handleToolActivate}
                  onSelectModeActivate={() => { setActiveToolKey(null); activationStack.remove('annotationTool'); }}
                  onOpenSettings={() => setShowToolSettings(true)}
                  onOpenFindLabel={openFindLabel}
                  onEditTool={setPanelEditingToolIndex}
                  onRequestDeleteTool={setPanelDeletingToolIndex}
                  onUnassignTool={(toolIndex) => handleReorderTools(annotationTools.map((t, i) => i === toolIndex ? { ...t, key: null } : t))}
                  onAssignToolHotkey={(toolIndex) => {
                    const key = nextAvailableHotkey(annotationTools);
                    if (!key) return;
                    handleReorderTools(annotationTools.map((t, i) => i === toolIndex ? { ...t, key } : t));
                    readyTool(key);
                  }}
                  onCreateToolForHotkey={(text) => setPanelCreatingToolText(text)}
                  playingExampleToolId={examplePlayer.playingToolId}
                  onPlayExample={examplePlayer.toggle}
                  onShowExamples={handleShowExamples}
                  onRefreshAnnotations={refreshAnnotations}
                  collapsed={sidebarSections.isCollapsed(SIDEBAR_SECTION_LABELS)}
                  onToggleCollapsed={() => sidebarSections.toggleCollapsed(SIDEBAR_SECTION_LABELS)}
                />
              ),
            },
          ];
          if (project.buzzdetectDirectoryAbs !== null) {
            stackItems.push({
              id: SIDEBAR_SECTION_NEURONS,
              node: (
                <BuzzdetectNeuronPalette
                  buzzdetect={buzzdetect}
                  subset={subset}
                  toolColors={toolColors}
                  collapsed={sidebarSections.isCollapsed(SIDEBAR_SECTION_NEURONS)}
                  onToggleCollapsed={() => sidebarSections.toggleCollapsed(SIDEBAR_SECTION_NEURONS)}
                  onRefresh={refreshBuzzdetect}
                />
              ),
            });
          }

          return (
            <div
              className="flex-none bg-slate-900 border-r border-slate-700 flex flex-col h-full relative"
              style={{ width: leftPanelWidth }}
              data-help-target="file-panel"
            >
              <SidebarStack items={stackItems} sections={sidebarSections} />

              {/* Right-edge width resize handle — sits on the outer face of the border */}
              <div
                className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
                style={{ right: '-6px', width: '6px' }}
                onMouseDown={handleLeftPanelWidthDrag}
              />
            </div>
          );
        })()}

        {/* Right: video + spectrogram stacked */}
        <div className="flex-1 flex flex-col relative overflow-hidden">

        {/* Video Pane — only created for video tracks; audio-only tracks route
            playback through AudioEngine and never use the <video> element. */}
        {!isAudioTrack && (
          <VideoSection
            collapsed={videoCollapsed}
            splitRatio={splitRatio}
            collapsedBarPx={VIDEO_COLLAPSED_BAR_PX}
            onExpand={() => setVideoCollapsed(false)}
            onSplitDrag={handleSplitDrag}
            helpTarget="video-panel"
            pane={{
              frameSource: frameSourceRef.current,
              frameSourceVersion,
              frameSourceDecodeError,
              isAudioTrack,
              videoSrc,
              isProcessing,
              isBuffering,
              getFrameTime,
              onDebugLog: addLog,
              onDurationChange: setDuration,
              videoMode,
              hasSelection: selection !== null,
              onVideoModeChange: handleVideoModeChange,
              onVideoElement: attachVideoElement,
              brightness: videoBrightness,
              contrast: videoContrast,
              onBrightnessChange: setVideoBrightness,
              onContrastChange: setVideoContrast,
            }}
          />
        )}

        {/* Spectrogram Pane */}
        <div className="relative flex-1 min-h-0 bg-slate-900 border-t border-slate-700 flex flex-col" data-help-target="spectrogram-canvas">

             {/* Settings Panel (Absolute, relative to spectrogram pane) */}
             {showSettings && (
                <div className="absolute top-10 right-4 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                    <SpectrogramSettingsPanel settings={settings} onChange={patch => setSettings(s => ({ ...s, ...patch }))} />
                </div>
             )}

             <Toolbar
               isPlaying={isPlaying}
               isBuffering={isBuffering || exampleAudioActive}
               videoSrc={videoSrc}
               currentTimeStore={currentTimeStoreRef.current}
               duration={displayDuration}
               selection={selection}
               volume={volume}
               muted={muted}
               canGoPrevAnnotation={canGoPrevAnnotation}
               canGoNextAnnotation={canGoNextAnnotation}
               spectrogramRef={spectrogramRef}
               setVolume={setVolume}
               setMuted={setMuted}
               onPlay={togglePlay}
               onSeek={seek}
               onSelectionChange={handleSelectionChange}
               onAnnotationBoundsChange={handleToolbarAnnotationBoundsChange}
               onBoundAnnotationChange={setBoundAnnotationId}
               showSettings={showSettings}
               onToggleSettings={() => setShowSettings(s => !s)}
               playbackSpeed={playbackSpeed}
               setPlaybackSpeed={setPlaybackSpeed}
               lastDefinedSpeed={lastDefinedSpeed}
               setLastDefinedSpeed={setLastDefinedSpeed}
               filterToolActive={filterToolActive}
               onToggleFilterTool={handleToggleFilterTool}
               bandPassFilter={bandPassFilter}
               setBandPassFilter={setBandPassFilter}
               onDisableBandPassFilter={handleDisableBandPassFilter}
               onEnableBandPassFilter={handleEnableBandPassFilter}
               filterStrength={filterStrength}
               setFilterStrength={setFilterStrength}
               videoMode={effectiveVideoMode}
               isAudioTrack={isAudioTrack}
               onRestartAudio={() => { engineRef.current?.restart(); }}
               playheadLocked={playheadLocked}
               onTogglePlayheadLock={togglePlayheadLock}
               timeDisplayUnit={shownTimeUnit}
               selectedTimeDisplayUnit={timeDisplayUnit}
               onTimeDisplayUnitChange={chooseTimeDisplayUnit}
               trackStartDate={trackStartDate}
               dateTimeFormat={dateTimeFormat}
               timeline={timeline}
             />

             <div className="flex-1 relative overflow-hidden">
             <Spectrogram
                ref={spectrogramRef}
                chunkCache={chunkCacheRef.current}
                sampleRate={sampleRate}
                currentTimeStore={currentTimeStoreRef.current}
                duration={displayDuration}
                timeline={timeline}
                isPlaying={isPlaying}
                isProcessing={isProcessing}
                ident={ident}
                settings={settings}
                onSettingsChange={patch => setSettings(s => ({ ...s, ...patch }))}
                zoomSec={zoomSec}
                annotations={displayAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                activeAnnotationTool={activeToolKey !== null ? (annotationTools.find(t => t.key === activeToolKey) ?? null) : null}
                annotationTools={annotationTools}
                selection={selection}
                sweepStart={sweepStart}
                boundAnnotationId={boundAnnotationId}
                onSeek={seek}
                onAnnotationsChange={handleDisplayAnnotationsChange}
                onAnnotationsCommit={handleDisplayAnnotationsCommit}
                onSelectAnnotation={setSelectedAnnotationId}
                onSelectionChange={handleSelectionChange}
                onBoundAnnotationChange={setBoundAnnotationId}
                onZoomChange={setZoomSec}
                filterToolActive={filterToolActive}
                bandPassFilter={bandPassFilter}
                onBandPassFilterChange={setBandPassFilter}
                onBandPassFilterDrawn={handleBandPassFilterDrawn}
                topTool={activationStack.topOf(['annotationTool', 'filterTool']) as 'annotationTool' | 'filterTool' | null}
                onViewportChange={publishViewport}
                videoMode={effectiveVideoMode}
                isAudioTrack={isAudioTrack}
                playheadLocked={playheadLocked}
                hideLabels={hideLabels}
                trackStartDate={trackStartDate}
                timeDisplayUnit={shownTimeUnit}
                dateTimeFormat={dateTimeFormat}
                onExportSelection={handleExportSelection}
                onCreateTool={handleCreateTool}
                onBindHotkey={handleBindHotkey}
                onListenExample={handleListenExample}
             />
             {/* Veil while a tool-chip example preview is sounding: the main
                 track is parked, so dim the spectrogram and say why. Not shown
                 for the "Show examples" modal, which has its own spectrogram. */}
             {examplePlayer.playingToolId !== null && (
               <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/55 pointer-events-none">
                 <span className="text-xs font-medium text-slate-200 bg-slate-900/80 border border-slate-700 rounded-full px-3 py-1">
                   {annotationWindow.exampleAudioPlaying}
                 </span>
               </div>
             )}
             </div>

             {/* Same gate as the Neurons palette (and its toggle button): the
                 project has to name a buzzdetect directory for there to be
                 results at all, whatever the persisted open/closed flag says. */}
             {project.buzzdetectDirectoryAbs !== null && buzzdetectEnabled && (
               <BuzzdetectTrackPanel
                 buzzdetect={buzzdetect}
                 subset={subset}
                 toolColors={toolColors}
                 viewportStore={viewportStoreRef.current}
                 currentTimeStore={currentTimeStoreRef.current}
                 selection={selection}
                 timeDisplayUnit={shownTimeUnit}
                 trackStartDate={trackStartDate}
                 dateTimeFormat={dateTimeFormat}
                 spectrogramRef={spectrogramRef}
                 onSelectionChange={handleSelectionChange}
                 onBoundAnnotationChange={setBoundAnnotationId}
                 onSeek={seek}
               />
             )}

             {!videoSrc && (
                 <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                     <div className="text-slate-600 text-center">
                         <p className="text-lg font-medium">{annotationWindow.noMediaTitle}</p>
                         <p className="text-sm">{annotationWindow.noMediaHint}</p>
                     </div>
                 </div>
             )}
        </div>
        </div>{/* end right column */}

        {/* Find & Rename dock. Summoned by {mod}+F or the Labels palette's
            magnifying glass, and gone the moment it's closed — nothing brings it
            back on its own. It lives in the layout row (rather than floating)
            because the user navigates between its matches with the spectrogram
            still in view. */}
        {showFindLabel && (
          <div
            className="flex-none bg-slate-900 border-l border-slate-700 flex flex-col h-full relative"
            style={{ width: findPanelWidth }}
          >
            {/* Left-edge width resize handle — on the outer face of the border */}
            <div
              className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
              style={{ left: '-6px', width: '6px' }}
              onMouseDown={handleFindPanelWidthDrag}
            />
            <FindLabelPanel
              annotations={annotations}
              annotationTools={annotationTools}
              allTracks={annotatedSearchTracks}
              trackPath={trackPath}
              folderPath={project.preferences.enteredFolderPath ?? null}
              annotationsLoaded={trackPath !== null && annotationsLoadedTrack === trackPath}
              getAnnotationPath={getAnnotationPath}
              getIdent={getIdent}
              useRegex={project.preferences.findLabelUseRegex ?? false}
              onUseRegexChange={handleFindLabelUseRegexChange}
              partial={project.preferences.findLabelPartialMatch ?? false}
              onPartialChange={handleFindLabelPartialChange}
              caseSensitive={project.preferences.findLabelCaseSensitive ?? false}
              onCaseSensitiveChange={handleFindLabelCaseSensitiveChange}
              query={findLabelQuery}
              onQueryChange={setFindLabelQuery}
              scope={findLabelScope}
              onScopeChange={setFindLabelScope}
              focusNonce={findLabelFocusNonce}
              reloadNonce={reloadNonce + annotationReloadNonce}
              onClose={() => setShowFindLabel(false)}
              onGo={handleGoToLabelMatch}
              onRename={handleFindLabelRename}
              onRenameSelected={handleFindLabelRenameSelected}
            />
          </div>
        )}
      </div>

      {showProjectSettings && (
        <ProjectSettingsModal
          project={project}
          onSave={handleProjectSettingsSaved}
          onClose={() => setShowProjectSettings(false)}
        />
      )}
      {showToolSettings && (
        <AnnotationToolsSettingsModal
          annotationTools={annotationTools}
          annotations={annotations}
          onClose={() => setShowToolSettings(false)}
          onReorderTools={handleReorderTools}
          onRenameTool={handleRenameTool}
          onDeleteTool={handleDeleteTool}
          onPreviewColor={handlePreviewToolColor}
          onCreateTool={handleCreateTool}
          onRestoreToolsState={handleRestoreToolsState}
          onImportExamples={handleImportExamples}
          onImportExamplesToTool={handleImportExamplesToTool}
          playingExampleToolId={examplePlayer.playingToolId}
          onPlayExample={examplePlayer.toggle}
          onShowExamples={handleShowExamples}
        />
      )}
      {panelEditingToolIndex !== null && (
        <AnnotationToolEditModal
          tool={annotationTools[panelEditingToolIndex]}
          toolIndex={panelEditingToolIndex}
          annotations={annotations}
          annotationTools={annotationTools}
          onClose={() => setPanelEditingToolIndex(null)}
          onPreviewColor={handlePreviewToolColor}
          onImportExamples={handleImportExamplesToTool}
          onShowExamples={(idx) => { setPanelEditingToolIndex(null); handleShowExamples(idx); }}
          onDelete={
            panelEditingToolIndex !== 0 && annotationTools[panelEditingToolIndex]?.key !== '0'
              ? () => { const idx = panelEditingToolIndex; setPanelEditingToolIndex(null); setPanelDeletingToolIndex(idx); }
              : undefined
          }
          onSave={(text, color, description) => {
            handleRenameTool(panelEditingToolIndex, text, color, description);
            setPanelEditingToolIndex(null);
          }}
        />
      )}
      {panelCreatingToolText !== null && (
        <AnnotationToolEditModal
          tool={{ id: '', key: nextAvailableHotkey(annotationTools), text: panelCreatingToolText, color: pickNextToolColor(annotationTools) }}
          toolIndex={-1}
          annotations={annotations}
          annotationTools={annotationTools}
          isCreate
          onClose={() => setPanelCreatingToolText(null)}
          onSave={(text, color, description) => {
            const key = nextAvailableHotkey(annotationTools);
            handleCreateTool(text, color, key, description);
            setPanelCreatingToolText(null);
            if (key) readyTool(key);
          }}
        />
      )}
      {libraryToolIndex !== null && annotationTools[libraryToolIndex] && (
        <AnnotationToolLibrary
          tool={annotationTools[libraryToolIndex]}
          initialSettings={settings}
          addLog={addLog}
          onPlayingChange={setLibraryPlaying}
          onClose={() => { setLibraryPlaying(false); setLibraryToolIndex(null); }}
        />
      )}
      {panelDeletingToolIndex !== null && (() => {
        const idx = panelDeletingToolIndex;
        const tool = annotationTools[idx];
        const close = () => setPanelDeletingToolIndex(null);
        return tool ? (
          <DeleteToolConfirmDialog
            tool={tool}
            onClose={close}
            onDelete={() => { handleDeleteTool(idx, 'delete'); close(); }}
            onUnlink={() => { handleDeleteTool(idx, 'unlink'); close(); }}
          />
        ) : null;
      })()}
      <TooltipLayer />
    </div>
  );
}
