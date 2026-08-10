import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Settings, Keyboard, HelpCircle, Bug, ArrowLeft, ChevronDown, RefreshCw, X } from 'lucide-react';
import VideoPane from './components/VideoPane';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import GradientProjectName from './components/GradientProjectName';
import { HelpHighlightHost } from './components/HelpHighlightHost';
import { Annotation, SpectrogramSettings, FrequencyScale, Project, ProjectSettings, ProjectPreferences, Selection, VideoMode } from './types';
import { DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_UI_SETTINGS, DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_BUZZDETECT_PANEL_HEIGHT, DEFAULT_LEFT_PANEL_WIDTH, DEFAULT_SPLIT_RATIO, DEFAULT_DATE_TIME_FORMAT, DEFAULT_BUZZDETECT_THRESHOLD, DEFAULT_BUZZDETECT_MIN_DETECTION_RATE, DEFAULT_BUZZDETECT_SUBSET_BUFFER, SIDEBAR_SECTION_FILES, SIDEBAR_SECTION_LABELS, SIDEBAR_SECTION_NEURONS, sidebarSectionsFromUiSettings, isSupportedMediaFile, isVideoFile, migrateVideoMode } from './constants';
import { exportToAudacity, makeAnnotationFromTool, stripExt, shuffleArray, basename, effectiveTimeUnit } from './utils/helpers';
import { parseFilenameTime } from './utils/filenameTime';
import { renameLabelAcrossTracks, LabelMatch } from './utils/annotationRename';
import { getFileInfo, listMediaFilesRecursive, listNonMediaFilesRecursive, toAssetUrl, toVideoServerUrl } from './utils/tauriCommands';
import { showHelpPage } from './utils/helpChannel';
import { useLiveHost } from './utils/liveBridge';
import { isFilterAvailable } from './utils/videoPlaybackMode';
import { isLinux } from './utils/platform';
import { createViewportStore } from './utils/viewportStore';
import { createCurrentTimeStore } from './utils/currentTimeStore';
import { useHotkeys, digitFromEvent } from './hooks/useHotkeys';
import { useChunkCacheVersion } from './hooks/useChunkCacheVersion';
import { useExamplePlayer } from './hooks/useExamplePlayer';
import { useActivationStack } from './hooks/useActivationStack';
import { useAnnotationHistory } from './hooks/useAnnotationHistory';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useBandPassFilter } from './hooks/useBandPassFilter';
import { useBuzzdetect } from './hooks/useBuzzdetect';
import { subsetTimelineFor, subsetBuzzdetectData, subsetCriteriaFrom, type SubsetCriteria } from './utils/buzzdetectSubset';
import { subsetStats } from './utils/buzzdetectStats';
import { sourceIntervalOf, displayOfNearestKept, projectIntervalToDisplay, sourceRangesForDisplayRange } from './utils/subsetTimeline';
import { projectAnnotations, reconcileAnnotations } from './utils/annotationProjection';
import { useProjectPersistence } from './hooks/useProjectPersistence';
import { useSyncManagement, type PreSyncSnapshot } from './hooks/useSyncManagement';
import { useAnnotationTools } from './hooks/useAnnotationTools';
import { useImportAnnotations } from './hooks/useImportAnnotations';
import { useFileNavigation } from './hooks/useFileNavigation';
import { useVideoFrameSource } from './hooks/useVideoFrameSource';
import { usePlaybackTransport } from './hooks/usePlaybackTransport';
import { useSpectrogramZoomHotkeys } from './hooks/useSpectrogramZoomHotkeys';
import { useAnnotationLoad } from './hooks/useAnnotationLoad';
import { MultiTierSpectrogramCache, swapChunkCache } from './MultiTierSpectrogramCache';
import { revealInFileManager, listAnnotationFiles } from './utils/projectCommands';
import { AudioEngine } from './utils/AudioEngine';
import { VideoElementEngine } from './utils/VideoElementEngine';
import { VideoFrameSource, canUseFrameSource } from './utils/VideoFrameSource';
import TooltipLayer from './components/TooltipLayer';
import DebugConsole from './components/DebugConsole';
import AnnotationToolsPanel from './components/AnnotationToolsPanel';
import NeuronPalette from './components/NeuronPalette';
import SidebarStack from './components/SidebarStack';
import CollapsedToolsRail from './components/CollapsedToolsRail';
import AnnotationToolsSettingsModal from './components/AnnotationToolsSettingsModal';
import MassRenameModal from './components/MassRenameModal';
import FindLabelModal from './components/FindLabelModal';
import AnnotationToolEditModal from './components/AnnotationToolEditModal';
import AnnotationToolLibrary from './components/AnnotationToolLibrary';
import DeleteToolConfirmDialog from './components/DeleteToolConfirmDialog';
import Toolbar, { speedRangeFor } from './components/Toolbar';
import { SpectrogramSettingsPanel } from './components/controls/SpectrogramSettingsPanel';
import BuzzdetectPanel from './components/BuzzdetectPanel';
import { tooltips } from './copy/tooltips';
import { annotationWindow, debugConsole } from './copy/ui';

export interface AnnotationWindowProps {
  project: Project;
  onClose: () => void;
  updateProjectSettings: (id: string, settings: ProjectSettings) => Promise<Project | undefined>;
  updateProjectPreferences: (id: string, preferences: ProjectPreferences) => Promise<Project | undefined>;
  touchLastOpened: (id: string) => void;
}

export default function AnnotationWindow({ project, onClose, updateProjectSettings, updateProjectPreferences, touchLastOpened }: AnnotationWindowProps) {
  // Ref that stays in sync with project prop — avoids stale-closure bugs in
  // persist effects and the navigation/shuffle handlers below.
  const projectRef = useRef<Project>(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  // Track / loaded-file model (path, name, src, directory, audio-vs-video,
  // sample rate, duration, the media list, shuffle, processing flag) plus its
  // stale-closure mirror refs live in useFileNavigation. Instantiated below.
  const {
    videoSrc, setVideoSrc,
    trackName, setTrackName,
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
    toggleShuffle,
  } = useFileNavigation({ projectRef, updateProjectPreferences });

  // Project settings modal
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showToolSettings, setShowToolSettings] = useState(false);
  const [showMassRename, setShowMassRename] = useState(false);
  const [showFindLabel, setShowFindLabel] = useState(false);

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
  // Which track's annotations have finished loading from disk. Set by the
  // auto-load effect in useAnnotationLoad; both persistence paths (debounced
  // autosave and useSyncManagement's flush) refuse to touch disk until it
  // matches the current track, so the transient empty state during a track
  // switch can never truncate or delete a real annotation file.
  const loadedAnnotationTrackRef = useRef<string | null>(null);
  // Merge ancestor for the post-pull reload: the exact annotation state flushed
  // at sync start. Written by useSyncManagement, consumed/cleared by
  // useAnnotationLoad's three-way merge. Owned here, shared by both.
  const preSyncSnapshotRef = useRef<PreSyncSnapshot | null>(null);

  // Git sync state, the manual sync handler, and the sync-status effects live in
  // useSyncManagement (set up below, once its dependencies are declared).
  // Annotation-tool palette state, refs, and CRUD handlers live in
  // useAnnotationTools (instantiated below, after its dependencies exist).

  // Derived from project prop
  const annotationDirectory = project.annotationDirectoryAbs ?? null;

  // Chunk cache ref — not state, to avoid re-renders on every chunk load
  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const { cacheVersion, bumpCacheVersion } = useChunkCacheVersion();

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
  // Undo/redo history for annotations. The two refs are reset directly by the
  // track-open / annotation-load / project-change paths below. The hook also
  // registers its own mod+z/mod+shift+z/mod+y hotkeys.
  const {
    annotationsHistoryRef,
    historyIndexRef,
    handleAnnotationsCommit,
  } = useAnnotationHistory(setAnnotations);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
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
    splitRatio, setSplitRatio,
    sidebarSections,
    leftPanelWidth, setLeftPanelWidth,
    filePanelCollapsed, setFilePanelCollapsed,
    videoCollapsed, setVideoCollapsed,
    hideLabels,
    VIDEO_COLLAPSED_BAR_PX,
    handleSplitDrag,
    handleLeftPanelWidthDrag,
  } = usePanelLayout({
    splitRatio: project.preferences.uiSettings?.splitRatio ?? DEFAULT_SPLIT_RATIO,
    sidebarSections: sidebarSectionsFromUiSettings(
      project.preferences.uiSettings?.sidebarSections,
      project.preferences.uiSettings?.leftPanelRatio,
    ),
    leftPanelWidth: project.preferences.uiSettings?.leftPanelWidthRatio != null
      ? project.preferences.uiSettings.leftPanelWidthRatio * window.innerWidth
      : DEFAULT_LEFT_PANEL_WIDTH,
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

  // Set of audio file paths that have an annotation file
  const [annotatedTracks, setAnnotatedFiles] = useState<Set<string>>(new Set());
  const [allNonMediaFiles, setAllNonMediaFiles] = useState<string[]>([]);

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

  // buzzdetect activations panel UI state + load-by-ident effect. Instantiated
  // here, well before the hooks that consume it, because the subset timeline
  // derived from it (below) decides the DISPLAY duration and the effective
  // video mode — both of which the frame source and the transport need.
  const {
    buzzdetectEnabled, setBuzzdetectEnabled,
    buzzdetectThresholds, setBuzzdetectThresholds,
    buzzdetectSubsetThresholds, setBuzzdetectSubsetThresholds,
    buzzdetectHiddenNeurons, setBuzzdetectHiddenNeurons,
    buzzdetectNeuronColors, setBuzzdetectNeuronColors,
    buzzdetectSeriesMode, setBuzzdetectSeriesMode,
    buzzdetectBinWidthOverride, setBuzzdetectBinWidthOverride,
    buzzdetectSubsetEnabled, setBuzzdetectSubsetEnabled,
    buzzdetectSubsetNeurons,
    buzzdetectMinDetectionRate, setBuzzdetectMinDetectionRate,
    buzzdetectSubsetBuffer, setBuzzdetectSubsetBuffer,
    buzzdetectPinnedNeurons, setBuzzdetectPinnedNeurons,
    buzzdetectPanelHeight, setBuzzdetectPanelHeight,
    buzzdetectData, setBuzzdetectData,
    buzzdetectSettingsOpen, setBuzzdetectSettingsOpen,
    buzzdetectYAxisOverride, setBuzzdetectYAxisOverride,
    buzzdetectAutoBinWidth, setBuzzdetectAutoBinWidth,
    buzzdetectAutoYRange, setBuzzdetectAutoYRange,
    handleBuzzdetectThresholdChange,
    handleBuzzdetectSubsetThresholdChange,
    handleBuzzdetectToggleNeuron,
    handleBuzzdetectNeuronColorChange,
    handleBuzzdetectTogglePinNeuron,
    handleBuzzdetectSoloNeuron,
    toggleBuzzdetectSubset,
    handleBuzzdetectSetAllNeuronsHidden,
  } = useBuzzdetect({ project, ident, addLog });

  // ── Subset mode ─────────────────────────────────────────────────────────────
  // The criteria the subset is keyed to, or null when it's off. Null here is
  // what makes every path below run the whole-file case unchanged.
  const subsetCriteria = useMemo<SubsetCriteria | null>(() => subsetCriteriaFrom({
    enabled: buzzdetectSubsetEnabled,
    subsetThresholds: buzzdetectSubsetThresholds,
    thresholds: buzzdetectThresholds,
    mode: buzzdetectSeriesMode,
    minDetectionRate: buzzdetectMinDetectionRate,
    binWidthOverride: buzzdetectBinWidthOverride,
    frameHop: buzzdetectData?.frameHop ?? 0,
    buffer: buzzdetectSubsetBuffer,
    availableNeurons: buzzdetectData?.neurons ?? null,
  }), [buzzdetectSubsetEnabled, buzzdetectSeriesMode, buzzdetectSubsetThresholds, buzzdetectThresholds,
      buzzdetectMinDetectionRate, buzzdetectBinWidthOverride, buzzdetectData, buzzdetectSubsetBuffer]);

  // The display axis. Identity (i.e. the whole file, unchanged) whenever the
  // subset is off. `duration` here is the file's own length; `displayDuration`
  // below is what the whole UI and the transport are measured in.
  const timeline = useMemo(
    () => subsetTimelineFor(buzzdetectData, subsetCriteria, duration),
    [buzzdetectData, subsetCriteria, duration],
  );
  const displayDuration = timeline.duration;
  // "The user has asked for a subset", as distinct from "the timeline differs
  // from the file": a subset that happens to keep everything still draws as a
  // subset, and one that keeps nothing is still engaged.
  const subsetActive = subsetCriteria !== null;

  // ── Subset ↔ spectrogram cache ─────────────────────────────────────────────
  // Two things the chunk cache needs from the subset, and they change on
  // different clocks:
  //
  //   grain   the bin width, which sizes the chunk grid (see buildTierLadder).
  //           Changing it invalidates every cached chunk, so the cache is
  //           rebuilt — but it only moves when the user changes bin width or
  //           turns the subset on/off, not when they drag a threshold.
  //   ranges  the kept spans, which cap each tier's LRU at the subset's own
  //           footprint. These move on every threshold nudge and are applied to
  //           the live cache without dropping anything.
  const subsetGrainSec = subsetCriteria && subsetCriteria.binWidth > 0
    ? subsetCriteria.binWidth
    : undefined;
  const subsetSourceRanges = useMemo(
    () => (timeline.identity ? null : timeline.spans.map(s => ({ start: s.srcStart, end: s.srcEnd }))),
    [timeline],
  );
  // How much audio the cut came to, for the palette's readout. Walks the frames
  // once per timeline — i.e. per threshold nudge, on the same clock the
  // timeline itself is rebuilt on, so it costs nothing the subset didn't.
  const buzzdetectSubsetStats = useMemo(
    () => subsetStats(buzzdetectData, timeline, duration),
    [buzzdetectData, timeline, duration],
  );
  // Read by installChunkCache, which runs from callbacks that must not re-bind
  // every time a threshold moves.
  const subsetGrainRef = useRef(subsetGrainSec);
  subsetGrainRef.current = subsetGrainSec;
  const subsetSourceRangesRef = useRef(subsetSourceRanges);
  subsetSourceRangesRef.current = subsetSourceRanges;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  // Video is turned off outright while a subset is on. The picture can't follow
  // a timeline that jumps between distant parts of the file without stalling on
  // every join, and the point of the subset is to hear the detections back to
  // back. The user's own videoMode preference is left untouched — this only
  // overrides what's in effect right now.
  const effectiveVideoMode: VideoMode = subsetActive ? 'off' : videoMode;
  const effectiveVideoModeRef = useRef(effectiveVideoMode);
  effectiveVideoModeRef.current = effectiveVideoMode;

  // A selection is display-time everywhere (view + playback bounds); an
  // annotation made from one has to be converted — the same conversion the
  // toolbar and panel readouts make (utils/subsetTimeline).
  const selectionToSource = useCallback(
    (sel: Selection): Selection => sourceIntervalOf(timeline, sel.start, sel.end),
    [timeline],
  );

  // Display duration mirror for the hooks that clamp seeks/pans against it.
  const displayDurationRef = useRef(displayDuration);
  displayDurationRef.current = displayDuration;

  // ── Subset seam ────────────────────────────────────────────────────────────
  // Annotations are stored in source time (they name audio in the file, and
  // must keep naming it whatever the view is showing) but drawn and dragged in
  // display time. See utils/annotationProjection.ts for why the return trip
  // isn't simply the inverse.
  const { shown: displayAnnotations, hidden: hiddenAnnotations } = useMemo(
    () => projectAnnotations(annotations, timeline),
    [annotations, timeline],
  );
  // The activations, re-expressed on the display axis. The panel is handed only
  // the frames the subset kept, so it plots the subset without knowing one
  // exists (see utils/buzzdetectSubset.ts).
  const displayBuzzdetectData = useMemo(
    () => subsetBuzzdetectData(buzzdetectData, timeline),
    [buzzdetectData, timeline],
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
    setAnnotationTools,
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

  // Mass Rename: renames every annotation whose text matches `oldText` to
  // `newText`, across the whole project — independent of any tool identity.
  // Current track updates in memory (autosave picks it up); every other
  // track's annotation file is rewritten on disk via the shared util also
  // used by handleRenameTool.
  const handleMassRename = useCallback(async (oldText: string, newText: string): Promise<number> => {
    const currentCount = annotations.filter(a => a.text === oldText).length;
    if (currentCount > 0) {
      setAnnotations(prev => prev.map(a => a.text === oldText ? { ...a, text: newText } : a));
    }
    const otherTracks = allTracks.filter(t => t !== trackPath);
    const diskCount = await renameLabelAcrossTracks(otherTracks, getAnnotationPath, oldText, newText);
    return currentCount + diskCount;
  }, [annotations, allTracks, trackPath, getAnnotationPath]);

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
    addLog,
  });

  // Dual-transport (AudioEngine / VideoElementEngine) abstraction: playback
  // state, the playback-clock refs, the play-token guard, engine refs, and the
  // togglePlay/seek/getMediaTime surface. Reads the frame source + track mirrors.
  const {
    isPlaying, setIsPlaying,
    isBuffering, setIsBuffering,
    playbackSpeed, setPlaybackSpeed,
    lastDefinedSpeed, setLastDefinedSpeed,
    volume, setVolume,
    muted, setMuted,
    playheadLocked, setPlayheadLocked,
    timeDisplayUnit, setTimeDisplayUnit, fallbackTimeDisplayUnit, setFallbackTimeDisplayUnit, chooseTimeDisplayUnit,
    engineRef,
    currentTimeRef,
    currentTimeStoreRef,
    togglePlay,
    seek,
    clearSelectionEnd,
    activeTransport,
    getMediaTime,
    attachVideoElement,
  } = usePlaybackTransport({
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
    spectrogramRef,
    examplePlayer,
    addLog,
    zoomSecRef,
    // The example-library modal owns the keyboard while open — see its own
    // key handler's comment ("the host disables its own hotkeys"). Without
    // this, its Space binding would double-fire against this hook's Space.
    enabled: libraryToolIndex === null,
  });

  // Spectrogram zoom-in/out/fit-to-track hotkeys (mod+=/mod+-/mod+shift+plus/
  // mod+0), shared verbatim with SingleFileWindow. mod+0's "remember where I
  // was" snapshot reads the live scroll position from the viewport store (the
  // same store the buzzdetect panel subscribes to for x-alignment).
  useSpectrogramZoomHotkeys({
    spectrogramRef,
    durationRef: displayDurationRef,
    zoomSecRef,
    preZoomExtentRef,
    getViewportStartTime: () => {
      const { scrollLeft, pixelsPerSecond } = viewportStoreRef.current.get();
      return pixelsPerSecond > 0 ? scrollLeft / pixelsPerSecond : 0;
    },
    enabled: libraryToolIndex === null,
  });

  // Keep selectionRef in sync with state (for use in rAF loop without stale closure)
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  // Pre-decode PCM for the selection so repeat plays are instant. AudioEngine
  // skips the call if the range is already covered by its cache.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !selection) return;
    engine.preloadRange(selection.start, selection.end).catch(() => {});
  }, [selection]);

  // Pre-decode video frames for the selection so the FIRST play is snappy too,
  // not just replays. Keyed on `selection` (not the commit callback) so it
  // covers every way a selection is set — drag-create, annotation click,
  // toolbar edit. Debounced because a drag updates `selection` on every mouse
  // move and each ensureRange re-decodes its GOP from the keyframe; we warm
  // once the selection settles. ensureRange fast-paths if already cached, so a
  // play that beats the timer just decodes in preroll as before.
  useEffect(() => {
    if (isAudioTrack || !selection) return;
    const source = frameSourceRef.current;
    if (!source) return;
    const sel = selection;
    const timer = setTimeout(() => {
      source.ensureRange(sel.start, sel.end, 'selectionWarm').catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [selection, isAudioTrack]);

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

  // Build the spectrogram chunk cache for a file and kick off its first
  // viewport. Shared by every path that has to (re)build one — opening a track,
  // changing the FFT size, and engaging or re-graining a subset — so the tier
  // grain and the subset footprint can't be wired up at one call site and
  // forgotten at another.
  const installChunkCache = useCallback((
    path: string, sr: number, dur: number, zoom: number,
  ) => {
    const cache = new MultiTierSpectrogramCache(
      path, settings.fftSize, sr, dur, bumpCacheVersion, subsetGrainRef.current,
    );
    cache.setSubsetRanges(subsetSourceRangesRef.current);
    swapChunkCache(chunkCacheRef, cache);
    bumpCacheVersion();
    // The warm-up viewport is the first `zoom` seconds of the DISPLAY axis,
    // which under a subset is several stretches scattered through the file, not
    // the file's first `zoom` seconds — those may not be on the axis at all.
    cache.prefetchRanges(
      sourceRangesForDisplayRange(timelineRef.current, 0, zoom),
      cache.selectTier(zoom, 1200).tier,
    );
    return cache;
  }, [settings.fftSize, bumpCacheVersion]);

  // Open a track by absolute path (called from button or file panel)
  const handleOpenTrack = useCallback(async (absolutePath: string) => {
    // Guard: never attempt to open a file whose extension we can't decode.
    // Both the tree and nav paths already filter these out; this is a belt-and-suspenders
    // check so a stray caller can't put us into a half-loaded state.
    if (!isSupportedMediaFile(absolutePath)) {
      addLog(`Skipped unsupported file: ${basename(absolutePath)}`, 'error');
      return;
    }

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

    const assetUrl = toAssetUrl(absolutePath);
    // On Linux, <video>/<audio> playback goes through WebKitGTK's GStreamer
    // pipeline, which can't resolve the `asset://` scheme (see toVideoServerUrl
    // doc comment) — serve over a local HTTP loopback there instead. macOS/Windows
    // keep using asset:// directly. fetch()-based paths (VideoFrameSource, below)
    // are unaffected and keep using assetUrl regardless of platform.
    const videoElementUrl = isLinux ? await toVideoServerUrl(absolutePath) : assetUrl;
    setVideoSrc(videoElementUrl);

    addLog(`Opening: ${fileName}`);
    addLog(`Video mode: ${videoModeRef.current}`);
    // Drop the outgoing track's spectrogram now, not when the new one finishes
    // decoding. Held any longer, the canvas keeps drawing the previous file's
    // chunks for the whole (potentially multi-second) load, so two different
    // files appear to have identical content. Batched with setIsProcessing so
    // the null cache renders as the loading state, not "Spectrogram Unavailable".
    swapChunkCache(chunkCacheRef, null);
    bumpCacheVersion();
    setIsProcessing(true);

    try {
        // Load into the engine for all file types. Engine calls getFileInfo internally.
        // For video files the engine handles audio; the <video> element shows frames only.
        let sr: number;
        let dur: number;
        if (engineRef.current) {
            const engineInfo = await engineRef.current.loadFile(absolutePath);
            sr = engineInfo.sampleRate;
            dur = engineInfo.durationSec;
            addLog(`File info: ${dur.toFixed(2)}s, ${sr}Hz, ${engineInfo.channels}ch`);
        } else {
            const info = await getFileInfo(absolutePath);
            sr = info.sample_rate;
            dur = info.duration_secs;
            addLog(`File info: ${dur.toFixed(2)}s, ${sr}Hz, ${info.channels}ch`);
        }

        setSampleRate(sr);
        if (dur > 0) setDuration(dur);
        // Clamp displayed max frequency to Nyquist of *this* file, but don't
        // clobber a lower user-defined ceiling. If the user has chosen a max
        // ≤ this file's Nyquist, keep it; otherwise pull it down.
        setSettings(s => s.maxFreq > sr / 2 ? { ...s, maxFreq: sr / 2 } : s);

        // Fit zoom to file if the file is shorter than the current zoom window.
        const effectiveZoom = (dur > 0 && dur < zoomSecRef.current) ? Math.max(MIN_ZOOM_SEC, dur) : zoomSecRef.current;
        if (effectiveZoom !== zoomSecRef.current) setZoomSec(effectiveZoom);

        // Create new multi-tier chunk cache for this file, and kick off its
        // first viewport prefetch immediately.
        installChunkCache(absolutePath, sr, dur, effectiveZoom);
        addLog('Spectrogram loading...');

        // Frame-perfect video path: MP4/MOV only. WebCodecs + mp4box.js
        // demuxes the file and feeds a VideoDecoder; frames are cached by
        // timestamp for instant replay at sample boundaries. Other containers
        // fall back to the <video> element below.
        //
        // Gated by videoMode:
        //   off, fast → don't open a frame source at all (the file load + demux
        //               is itself non-trivial on old hardware).
        //   mixed     → open it so the canvas can light up the moment the user
        //               commits a selection, but skip the t=0 warm decode.
        //   accurate  → open + warm (canvas drives playback from the start).
        const mode = videoModeRef.current;
        const wantFrameSource = !isAudio && canUseFrameSource(absolutePath)
            && (mode === 'accurate' || mode === 'mixed');
        if (wantFrameSource) {
            try {
                const source = new VideoFrameSource({ onDebugLog: addLog });
                await source.open(assetUrl);
                frameSourceRef.current = source;
                setFrameSourceVersion(v => v + 1);
                if (mode === 'accurate') {
                    // Warm the cache around t=0 so the first frame is ready to draw.
                    source.ensureRange(0, Math.min(5, dur), 'trackOpenWarm').catch(() => {});
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                addLog(`[video] frame source unavailable, falling back: ${msg}`, 'error');
                frameSourceRef.current = null;
                setFrameSourceVersion(v => v + 1);
            }
        }
    } catch (err) {
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
        setIsProcessing(false);
    }
  }, [settings.fftSize, installChunkCache]);

  // Mutual exclusion: whenever an example clip starts sounding, park the main
  // transport so the two files never play at once. The main play button shows
  // the existing buffering spinner (a "waiting" state) for the duration. This
  // is a coordination edge between the example player and the transport, so it
  // stays in the orchestrator.
  useEffect(() => {
    if (!exampleAudioActive) return;
    activeTransport()?.pause();
    setIsPlaying(false);
  }, [exampleAudioActive, activeTransport]);

  // Rebuild the cache when what a cached chunk *is* changes underneath it while
  // a track is open: the FFT size (the bins in a chunk) or the subset grain (the
  // stretch of file a chunk covers — see buildTierLadder). Both make every
  // chunk already held unusable, so the cache is replaced rather than trimmed.
  // Threshold edits reshape the subset without changing the grain and are
  // handled below, without discarding anything.
  useEffect(() => {
    if (!trackPath || !sampleRate || !duration) return;
    // Engaging a subset shrinks the axis, and the effect that fits the zoom
    // window to it runs after this one — so fit it here too, or the warm-up
    // prefetch picks a tier for a window wider than the whole subset and
    // fetches chunks the very next draw supersedes.
    const zoom = displayDuration > 0 ? Math.min(zoomSec, displayDuration) : zoomSec;
    installChunkCache(trackPath, sampleRate, duration, zoom);
  }, [settings.fftSize, subsetGrainSec]);

  // Narrow the live cache to the subset's footprint as the spans move (a
  // threshold drag), and widen it back when the subset is turned off.
  useEffect(() => {
    chunkCacheRef.current?.setSubsetRanges(subsetSourceRanges);
    // Not keyed on the cache itself: every path that installs one already
    // applies the current ranges (installChunkCache), so re-running this on a
    // cache swap would only repeat the walk.
  }, [subsetSourceRanges]);

  // The ordered list used for navigation (respects shuffle mode and fileFilter)
  const displayQueue = useMemo(() => {
    const base = shuffleMode ? shuffledFiles : allTracks;
    const filter = project?.preferences.fileFilter ?? 'all';
    if (filter === 'annotated') return base.filter(f => annotatedTracks.has(f));
    if (filter === 'unannotated') return base.filter(f => !annotatedTracks.has(f));
    return base;
  }, [shuffleMode, shuffledFiles, allTracks, project?.preferences.fileFilter, annotatedTracks]);

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

  // Annotation navigation helpers (used by toolbar buttons and keyboard shortcuts)
  const sortedAnnotations = useMemo(() => [...annotations].sort((a, b) => a.start - b.start), [annotations]);
  // Mirror of sortedAnnotations so the playback-time subscriber can read the
  // current list without re-subscribing on every annotation change.
  const sortedAnnotationsRef = useRef(sortedAnnotations);
  useEffect(() => { sortedAnnotationsRef.current = sortedAnnotations; }, [sortedAnnotations]);
  // The same list on the display axis, for the prev/next-annotation enablement
  // below: that's a question about what the user can navigate to on screen, and
  // the playhead it's compared against is a display position. (The source-time
  // ref above stays as-is — persistence and sync must see real file times.)
  const sortedDisplayAnnotations = useMemo(
    () => [...displayAnnotations].sort((a, b) => a.start - b.start),
    [displayAnnotations],
  );
  const sortedDisplayAnnotationsRef = useRef(sortedDisplayAnnotations);
  useEffect(() => { sortedDisplayAnnotationsRef.current = sortedDisplayAnnotations; }, [sortedDisplayAnnotations]);

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
    const anns = sortedDisplayAnnotationsRef.current;
    const prev = anns.some(a => a.start < t - 0.05);
    const next = anns.some(a => a.start > t + 0.05);
    if (prev !== canGoPrevRef.current) { canGoPrevRef.current = prev; setCanGoPrevAnnotation(prev); }
    if (next !== canGoNextRef.current) { canGoNextRef.current = next; setCanGoNextAnnotation(next); }
  }, []);
  // Subscribe once on mount: recompute on every playback tick (cheap, only sets
  // state on an actual boundary crossing).
  useEffect(() => currentTimeStoreRef.current.subscribe(recomputeCanGo), [recomputeCanGo]);
  // Also recompute when the annotation set changes (a new/removed annotation can
  // flip enablement without the playhead moving).
  useEffect(() => { recomputeCanGo(); }, [sortedDisplayAnnotations, recomputeCanGo]);

  // Toggle shuffle: randomise current allTracks order

  // Wall-clock start of the open track, read out of its filename with the
  // project's timestamp pattern. Null (so time readouts stay elapsed) when the
  // project defines no pattern or this particular name doesn't match it.
  const trackStartDate = useMemo(() => {
    const pattern = project.settings.filenameTimeFormat;
    if (!pattern || !trackPath) return null;
    return parseFilenameTime(basename(trackPath), pattern);
  }, [project.settings.filenameTimeFormat, trackPath]);

  // 'datetime' only applies where a start time is known; elsewhere readouts
  // fall back to the last elapsed unit the user chose.
  const shownTimeUnit = effectiveTimeUnit(timeDisplayUnit, trackStartDate, fallbackTimeDisplayUnit);

  // Style for wall-clock datetime readouts, set in the Preferences tab.
  const dateTimeFormat = project.preferences.dateTimeFormat ?? DEFAULT_DATE_TIME_FORMAT;

  // Find Label "Go": target ident + the match (start/end/label) on a track
  // that isn't currently open. Set right before handleOpenTrack fires;
  // consumed by the effect below once that track's annotations finish loading.
  const pendingGoToLabelRef = useRef<{ ident: string } & LabelMatch | null>(null);

  // Select + scroll to an annotation matching `match` on the current track.
  // Shared by the same-track and cross-track ("Go") paths so the two don't
  // diverge on how a match is highlighted. Matches on label too (not just
  // start/end) since a regex/partial search can return several different
  // labels at the same or coincidentally-equal times.
  const goToAnnotationMatch = useCallback((match: LabelMatch) => {
    const found = annotations.find(a => a.start === match.start && a.end === match.end && a.text === match.label);
    if (!found) return;
    setSelectedAnnotationId(found.id);
    // The match carries source times; the view and the playhead are on the
    // display axis.
    const dStart = timeline.toDisplay(match.start);
    seek(dStart);
    spectrogramRef.current?.zoomToRange(dStart, timeline.toDisplay(match.end));
  }, [annotations, seek, timeline]);

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
    pendingGoToLabelRef.current = { ident: matchIdent, ...match };
    handleOpenTrack(targetPath);
  }, [ident, goToAnnotationMatch, allTracks, getIdent, handleOpenTrack]);

  // Finish a cross-track "Go": once the newly-opened track's annotations have
  // loaded and match the pending target ident, select + scroll, then clear.
  useEffect(() => {
    const pending = pendingGoToLabelRef.current;
    if (!pending || !ident || ident !== pending.ident || annotations.length === 0) return;
    pendingGoToLabelRef.current = null;
    goToAnnotationMatch(pending);
  }, [annotations, ident, goToAnnotationMatch]);

  // Band-pass filter state machine (filter tool / band / strength + engine-push
  // and persistence effects, plus its own F / Shift+F hotkeys). Needs engineRef,
  // the activation stack, and the project plumbing for debounced persistence.
  // See hooks/useBandPassFilter.ts.
  const {
    filterToolActive, setFilterToolActive,
    bandPassFilter, setBandPassFilter,
    filterStrength, setFilterStrength,
    handleToggleFilterTool,
    handleToggleFilterState,
    handleDisableBandPassFilter,
    handleEnableBandPassFilter,
    handleBandPassFilterDrawn,
  } = useBandPassFilter({
    project,
    engineRef,
    activationStack,
    projectRef,
    prevProjectIdRef,
    updateProjectPreferences,
    isAudioTrack,
    videoMode: effectiveVideoMode,
    enabled: libraryToolIndex === null,
  });

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
    flushPendingAutosave,
  } = useSyncManagement({
    project,
    projectRef,
    annotations,
    getAnnotationPath,
    autoSaveTimeoutRef,
    trackPathRef,
    loadedAnnotationTrackRef,
    preSyncSnapshotRef,
    addLog,
  });
  useEffect(() => { flushPendingAutosaveRef.current = flushPendingAutosave; }, [flushPendingAutosave]);

  // Custom-commit-message popover: open state + the typed message.
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');

  // Auto-dismiss the sync result toast (manual sync or background auto-pull):
  // fade it out, then clear it, a few seconds after it appears.
  const [syncToastFading, setSyncToastFading] = useState(false);
  useEffect(() => {
    if (!syncSummary && !syncError) return;
    setSyncToastFading(false);
    const fadeTimer = setTimeout(() => setSyncToastFading(true), 4500);
    const clearTimer = setTimeout(() => {
      setSyncSummary(null);
      setSyncError(null);
    }, 5000);
    return () => { clearTimeout(fadeTimer); clearTimeout(clearTimer); };
  }, [syncSummary, syncError, setSyncSummary, setSyncError]);

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
    loadedAnnotationTrackRef,
    annotationsRef: sortedAnnotationsRef,
    syncingRef,
    preSyncSnapshotRef,
    reloadNonce,
    addLog,
  });

  // Initialize state from project prop on mount
  useEffect(() => {
    loadAnnotationTools(project);
    const sg = { ...DEFAULT_SPECTROGRAM_SETTINGS, ...project.preferences.spectrogramSettings };
    setSettings(sg);
    setShuffleMode(project.preferences.shuffleMode ?? false);
    const ui = { ...DEFAULT_UI_SETTINGS, ...project.preferences.uiSettings };
    setVolume(ui.volume);
    setPlaybackSpeed(ui.playbackSpeed);
    setLastDefinedSpeed(
      project.preferences.uiSettings?.lastDefinedSpeed
        ?? (ui.playbackSpeed !== 1 ? ui.playbackSpeed : DEFAULT_UI_SETTINGS.lastDefinedSpeed)
    );
    setZoomSec(ui.zoomSec);
    setVideoMode(migrateVideoMode(ui.videoMode));
    setVideoBrightness(ui.videoBrightness);
    setVideoContrast(ui.videoContrast);
    setBuzzdetectEnabled(project.preferences.uiSettings?.buzzdetectEnabled ?? false);
    setBuzzdetectThresholds(project.preferences.uiSettings?.buzzdetectThresholds ?? {});
    setBuzzdetectSubsetThresholds(project.preferences.uiSettings?.buzzdetectSubsetThresholds ?? {});
    setBuzzdetectHiddenNeurons(project.preferences.uiSettings?.buzzdetectHiddenNeurons ?? []);
    setBuzzdetectNeuronColors(project.preferences.uiSettings?.buzzdetectNeuronColors ?? {});
    setBuzzdetectSeriesMode(project.preferences.uiSettings?.buzzdetectSeriesMode ?? 'activation');
    setBuzzdetectBinWidthOverride(project.preferences.uiSettings?.buzzdetectBinWidthOverride ?? null);
    setBuzzdetectSubsetEnabled(project.preferences.uiSettings?.buzzdetectSubsetEnabled ?? false);
    setBuzzdetectMinDetectionRate(project.preferences.uiSettings?.buzzdetectMinDetectionRate ?? DEFAULT_BUZZDETECT_MIN_DETECTION_RATE);
    setBuzzdetectSubsetBuffer(project.preferences.uiSettings?.buzzdetectSubsetBuffer ?? DEFAULT_BUZZDETECT_SUBSET_BUFFER);
    setBuzzdetectPinnedNeurons(project.preferences.uiSettings?.buzzdetectPinnedNeurons ?? []);
    setBuzzdetectPanelHeight(DEFAULT_BUZZDETECT_PANEL_HEIGHT);
    setBuzzdetectData(null);
    setFilterToolActive(false);
    // Panel layout — restore persisted layout for this project.
    const savedUi = project.preferences.uiSettings;
    setPlayheadLocked(savedUi?.playheadLocked ?? false);
    setTimeDisplayUnit(savedUi?.timeDisplayUnit ?? 'seconds');
    setFallbackTimeDisplayUnit(savedUi?.fallbackTimeDisplayUnit ?? (savedUi?.timeDisplayUnit === 'hms' ? 'hms' : 'seconds'));
    setFilePanelCollapsed(savedUi?.filePanelCollapsed ?? false);
    setVideoCollapsed(savedUi?.videoCollapsed ?? false);
    setSplitRatio(savedUi?.splitRatio ?? DEFAULT_SPLIT_RATIO);
    sidebarSections.setStates(sidebarSectionsFromUiSettings(savedUi?.sidebarSections, savedUi?.leftPanelRatio));
    setLeftPanelWidth(savedUi?.leftPanelWidthRatio != null
      ? savedUi.leftPanelWidthRatio * window.innerWidth
      : DEFAULT_LEFT_PANEL_WIDTH);
    setBandPassFilter(project.preferences.bandPassFilter ?? null);
    setFilterStrength(project.preferences.bandPassFilter?.strength ?? 0.5);
    setShuffledFiles([]);
    setCurrentDirectory(project.mediaDirectoryAbs);
    setAnnotatedFiles(new Set());
    setAnnotations([]);
    setTrackPath(null);
    setVideoSrc(null);
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;

    Promise.all([
      listMediaFilesRecursive(project.mediaDirectoryAbs),
      listNonMediaFilesRecursive(project.mediaDirectoryAbs),
    ])
      .then(([files, nonMedia]) => {
        setAllMediaFiles(files);
        setAllNonMediaFiles(nonMedia);
        let firstFile = files[0];
        if (project.preferences.shuffleMode && files.length > 0) {
          const shuffled = shuffleArray(files);
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
        refreshAnnotatedSet(files, project.mediaDirectoryAbs, project.annotationDirectoryAbs);
      })
      .catch(err => {
        setAllMediaFiles([]);
        setAllNonMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared helper: from a freshly-scanned media file list, compute which
  // entries already have annotation files on disk. Used by both the initial
  // mount scan and the manual-refresh path so the rel-path mapping logic
  // doesn't live in two places.
  const refreshAnnotatedSet = useCallback(async (
    files: string[],
    audioRoot: string,
    annotationDir: string,
  ) => {
    try {
      const relPaths = await listAnnotationFiles(annotationDir, 'txt');
      const relToFull = new Map<string, string>();
      for (const f of files) {
        const rel = stripExt(f.substring(audioRoot.length + 1)).replace(/\\/g, '/');
        relToFull.set(rel, f);
      }
      const annotated = new Set<string>();
      for (const rp of relPaths) {
        const full = relToFull.get(rp);
        if (full) annotated.add(full);
      }
      setAnnotatedFiles(annotated);
    } catch { /* ignore */ }
  }, []);

  const handleRefreshFiles = useCallback(async () => {
    try {
      const [files, nonMedia] = await Promise.all([
        listMediaFilesRecursive(project.mediaDirectoryAbs),
        listNonMediaFilesRecursive(project.mediaDirectoryAbs),
      ]);
      setAllMediaFiles(files);
      setAllNonMediaFiles(nonMedia);
      refreshAnnotatedSet(files, project.mediaDirectoryAbs, project.annotationDirectoryAbs);
    } catch (err) {
      addLog(`Error refreshing files: ${err}`, 'error');
    }
  }, [project, refreshAnnotatedSet]);

  // After a git sync pulls new data, refresh the file tree so freshly-arrived
  // annotation files show as annotated (and any new media files appear).
  // reloadNonce only bumps on a successful pull; skip the initial 0.
  useEffect(() => {
    if (reloadNonce === 0) return;
    handleRefreshFiles();
  }, [reloadNonce, handleRefreshFiles]);

  const handleProjectSettingsSaved = useCallback(async (updatedSettings: ProjectSettings, updatedPreferences: ProjectPreferences) => {
    const prev = project.settings.mediaDirectory;
    const next = updatedSettings.mediaDirectory;
    const mediaDirChanged = prev.kind !== next.kind || prev.path !== next.path;
    const updated = await updateProjectSettings(project.id, updatedSettings);
    if (!updated) {
      setShowProjectSettings(false);
      return;
    }
    await updateProjectPreferences(project.id, updatedPreferences);
    loadAnnotationTools(updated);
    setVideoMode(migrateVideoMode(updated.preferences.uiSettings?.videoMode));
    if (mediaDirChanged) {
      await flushPendingAutosaveRef.current();
      setCurrentDirectory(updated.mediaDirectoryAbs);
      setTrackPath(null);
      setVideoSrc(null);
      setAnnotations([]);
      try {
        const [files, nonMedia] = await Promise.all([
          listMediaFilesRecursive(updated.mediaDirectoryAbs),
          listNonMediaFilesRecursive(updated.mediaDirectoryAbs),
        ]);
        setAllMediaFiles(files);
        setAllNonMediaFiles(nonMedia);
        if (files.length > 0) handleOpenTrack(files[0]);
      } catch (err) {
        setAllMediaFiles([]);
        setAllNonMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      }
    }
    setShowProjectSettings(false);
  }, [project, updateProjectSettings, updateProjectPreferences, handleOpenTrack, loadAnnotationTools]);

  const handleToggleFileFilter = useCallback(() => {
    const current = project.preferences.fileFilter ?? 'all';
    const next = ({ all: 'unannotated', unannotated: 'annotated', annotated: 'all' } as const)[current];
    updateProjectPreferences(project.id, { ...project.preferences, fileFilter: next });
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
    updateProjectPreferences(project.id, { ...project.preferences, findLabelUseRegex: useRegex });
  }, [project, updateProjectPreferences]);

  const handleFindLabelPartialChange = useCallback((partial: boolean) => {
    updateProjectPreferences(project.id, { ...project.preferences, findLabelPartialMatch: partial });
  }, [project, updateProjectPreferences]);

  const handleEnteredFolderChange = useCallback((path: string | null) => {
    updateProjectPreferences(project.id, {
      ...project.preferences,
      enteredFolderPath: path ?? undefined,
    });
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
              const newText = savedText !== undefined ? savedText : (isCustom ? '' : tool.text);
              const updated = annotations.map(a => a.id === boundAnnotationId
                  ? { ...a, text: newText, color: tool.color }
                  : a
              );
              handleAnnotationsCommit(updated);
              setActiveToolKey(key);
              activationStack.pushIfAbsent('annotationTool');
              setFilterToolActive(false);
              activationStack.remove('filterTool');
              if (isCustom && newText === '') {
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
          activationStack.pushIfAbsent('annotationTool');
          setFilterToolActive(false);
          activationStack.remove('filterTool');
      } else {
          setActiveToolKey(prev => {
            if (prev === key) {
              activationStack.remove('annotationTool');
              return null;
            }
            activationStack.pushIfAbsent('annotationTool');
            setFilterToolActive(false);
            activationStack.remove('filterTool');
            return key;
          });
      }
  }, [annotationTools, boundAnnotationId, annotations, activeToolKey, selection, handleAnnotationsCommit, reassignBufferRef, activationStack, selectionToSource]);

  // Global Hotkeys — see hooks/useHotkeys.ts. Handlers close over the latest
  // render's state (the bindings array is read from a ref refreshed each render),
  // so we don't need to manage a dep list here.
  const selectAllOrAnnotateFullTrack = () => {
      if (displayDuration <= 0) return;
      // Under a subset, "everything" means the segment the playhead is sitting
      // in, not the whole concatenated timeline: a selection spanning a cut
      // would cover audio that isn't between its own endpoints in the file.
      const span = {
        start: timeline.clampToSpanOfDisplay(currentTimeRef.current, 0),
        end: timeline.clampToSpanOfDisplay(currentTimeRef.current, displayDuration),
      };
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
  useHotkeys([
      // Help guide — also fires inside text inputs, since help is universal.
      { key: 'F1', allowInInput: true, handler: () => showHelpPage() },

      // Mod+key bindings. Undo/redo (useAnnotationHistory), band-pass filter
      // toggle (useBandPassFilter), spectrogram zoom (useSpectrogramZoomHotkeys),
      // and playback transport (space/arrows/,/./r/m/c, usePlaybackTransport)
      // now register their own hotkeys where their state/handlers live — see
      // those hooks' instantiations above. What's left here is annotation- and
      // file-navigation-specific glue that only this window has.
      { key: 'a', mods: ['mod'], handler: selectAllOrAnnotateFullTrack },
      { key: 'ArrowLeft', mods: ['mod'], handler: () => spectrogramRef.current?.goToTrackStart() },
      { key: 'ArrowRight', mods: ['mod'], handler: () => spectrogramRef.current?.goToTrackEnd() },
      { key: 'ArrowLeft', mods: ['alt'], handler: () => spectrogramRef.current?.goToPrevAnnotation() },
      { key: 'ArrowRight', mods: ['alt'], handler: () => spectrogramRef.current?.goToNextAnnotation() },
      { key: 'ArrowUp', mods: ['mod'], handler: () => navigateFile('prev') },
      { key: 'ArrowDown', mods: ['mod'], handler: () => navigateFile('next') },

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
      { key: 'e', handler: () => {
          if (activeToolKey === null) return;
          const tool = annotationTools.find(t => t.key === activeToolKey);
          if (tool) examplePlayer.toggle(tool);
      }},
      // Escape — universal undo of the most-recently-activated layer. Fires
      // even when a text input has focus. (The guide's own Esc-to-close lives
      // in its own window, so the two never contend.) Layer kinds & clear
      // actions:
      //   annotationTool → setActiveToolKey(null)
      //   selection      → clear selection bounds
      //   filterTool     → setFilterToolActive(false)
      //   filterBand     → setBandPassFilter(null)
      { key: 'Escape', allowInInput: true, handler: () => {
          const top = activationStack.popTop();
          switch (top) {
            case 'annotationTool':
              setActiveToolKey(null);
              break;
            case 'selection':
              setSelection(null);
              frameSourceRef.current?.clearPinnedRange();
              setBoundAnnotationId(null);
              clearSelectionEnd();
              break;
            case 'filterTool':
              setFilterToolActive(false);
              break;
            case 'filterBand':
              setBandPassFilter(null);
              break;
            default:
              // Stack empty → no-op (already at Select baseline).
              break;
          }
      }},
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

  const performExport = async () => {
      if (annotations.length === 0) return;
      const decimals = project?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
      await exportToAudacity(annotations, trackName, trackPath, decimals);
      addLog('Exported annotations as TXT');
  };

  // Wrap setSelection at the prop boundary so any path that sets/clears the
  // selection (Spectrogram drag, Toolbar selection-time edits, etc.) keeps the
  // activation stack synchronised without each caller having to remember to
  // push/remove.
  const handleSelectionChange = useCallback((s: Selection | null) => {
    setSelection(s);
    // Sync synchronously, not just via the state-mirroring effect below: a caller
    // that seeks in the same tick as committing a new selection (e.g. snapping the
    // playhead into a just-created selection) needs seek()'s bounded-restart logic
    // to see the new selection immediately, not the stale one from last render.
    selectionRef.current = s;
    if (s) {
      activationStack.pushIfAbsent('selection');
      // Pin here, not only on commit: every non-null selection (drag, edge
      // resize/move, toolbar time edit, annotation click) flows through this
      // wrapper, whereas the commit callback only fires on a fresh drag-release.
      // Pinning here is what keeps the selection's frames resident across the
      // rolling prefetch's eviction churn so replays hit the cache.
      frameSourceRef.current?.pinSelectionRange(s.start, s.end);
    } else {
      activationStack.remove('selection');
      frameSourceRef.current?.clearPinnedRange();
      // The selection was driving playback's bounded stop — drop it so
      // playback continues through to EOF instead of stopping at the now-stale
      // selection end.
      clearSelectionEnd();
    }
  }, [activationStack, clearSelectionEnd]);

  // Hand the engine the axis it should play, and bring the rest of the view
  // onto it. Fires on every timeline change (subset toggled, threshold edited,
  // track swapped). AudioEngine stops playback rather than remapping audio
  // already scheduled against the old axis.
  //
  // The playhead and any selection are positions on an axis that no longer
  // exists, so both are reset: the selection outright (its endpoints named
  // audio by where it sat, and the cuts have moved), the playhead only where it
  // now points past the end. Skipped on the first run, which is just the empty
  // initial state.
  //
  // Everything here is gated on the timeline object actually changing, not just
  // on the effect running: `seek` and `handleSelectionChange` are callbacks whose
  // identity turns over on unrelated renders, and setTimeline stops playback —
  // so an ungated call would cut the audio at arbitrary moments mid-play.
  const prevTimelineRef = useRef(timeline);
  useEffect(() => {
    const changed = prevTimelineRef.current !== timeline;
    prevTimelineRef.current = timeline;
    if (!changed) return;
    engineRef.current?.setTimeline(timeline);
    handleSelectionChange(null);
    if (currentTimeRef.current > displayDuration) seek(displayDuration);
    // A subset can be a few seconds of a multi-hour file. Fit the window to it
    // rather than leaving the user staring at one narrow band of content in a
    // screen of blank — the same courtesy handleOpenTrack does for short files.
    if (displayDuration > 0 && zoomSecRef.current > displayDuration) {
      setZoomSec(Math.max(MIN_ZOOM_SEC, displayDuration));
    }
  }, [timeline, displayDuration, engineRef, handleSelectionChange, seek, currentTimeRef]);

  // Called by Toolbar time-field edits to sync the bound annotation's bounds.
  const handleToolbarAnnotationBoundsChange = useCallback((start: number, end: number) => {
    if (!boundAnnotationId) return;
    const old = annotations.find(a => a.id === boundAnnotationId);
    // Both times here are display; `old.start` is source, so the comparison is
    // made on the display axis the playhead is also on.
    if (old && Math.abs(currentTimeRef.current - timeline.toDisplay(old.start)) <= 0.5) {
      seek(start, false);
    }
    const src = selectionToSource({ start, end });
    handleAnnotationsCommit(annotations.map(a =>
      a.id === boundAnnotationId ? { ...a, start: src.start, end: src.end } : a
    ));
  }, [boundAnnotationId, annotations, handleAnnotationsCommit, seek, timeline, selectionToSource]);

  const liveSpeedRange = speedRangeFor(isAudioTrack, videoMode);

  // Mirror the toolbar's state into the help guide window and accept control
  // input back from it, so the controls the guide documents are the live ones.
  // Both sides here are the exact values the Toolbar below is given — the
  // guide renders the same components against them.
  useLiveHost(
    {
      hasTrack: !!videoSrc,
      duration,
      isPlaying,
      isBuffering: isBuffering || exampleAudioActive,
      volume,
      muted,
      playbackSpeed,
      lastDefinedSpeed,
      speedMin: liveSpeedRange.min,
      speedMax: liveSpeedRange.max,
      // Source time, like everything else on the bridge — the guide's copy of
      // the from/to fields must read the same file positions the toolbar's do.
      selection: selection && selectionToSource(selection),
      timeDisplayUnit: shownTimeUnit,
      selectedTimeDisplayUnit: timeDisplayUnit,
      trackStartMs: trackStartDate?.getTime() ?? null,
      dateTimeFormat,
      canGoPrevAnnotation,
      canGoNextAnnotation,
      playheadLocked,
      filterToolActive,
      filterUnavailable: !isFilterAvailable(isAudioTrack, videoMode),
      filterEnabled: bandPassFilter !== null,
      filterStrength,
      bandPassFilter,
      buzzdetectAvailable: project.buzzdetectDirectoryAbs !== null,
      buzzdetectEnabled,
      subsetAvailable: buzzdetectSubsetNeurons.length > 0,
      subsetActive,
      spectrogramSettings: settings,
      spectrogramSettingsOpen: showSettings,
      filePanel: {
        fileFilter: (project?.preferences.fileFilter ?? 'all') as 'all' | 'annotated' | 'unannotated',
        shuffleMode,
        anyExpanded: fileTreeAnyExpanded,
      },
      toolPalette: {
        tools: annotationTools,
        activeToolKey,
        playingExampleToolId: examplePlayer.playingToolId,
      },
    },
    {
      play: togglePlay,
      // Times arrive in source time (see LiveSnapshot). One that a subset cut
      // out has no place on the axis, so it goes to the nearest kept moment —
      // the same answer typing it into the toolbar gives.
      seek: (t, scroll) => seek(displayOfNearestKept(timeline, t), scroll),
      skipToStart: () => { seek(0, true); handleSelectionChange(null); setBoundAnnotationId(null); },
      skipToEnd: () => { seek(displayDuration, true); handleSelectionChange(null); setBoundAnnotationId(null); },
      prevAnnotation: () => spectrogramRef.current?.goToPrevAnnotation(),
      nextAnnotation: () => spectrogramRef.current?.goToNextAnnotation(),
      togglePlayheadLock: () => {
        const willLock = !playheadLocked;
        setPlayheadLocked(willLock);
        if (willLock) spectrogramRef.current?.recenterPlayhead();
      },
      setVolume,
      setMuted,
      setPlaybackSpeed,
      setLastDefinedSpeed,
      setTimeDisplayUnit,
      setSelection: s => {
        const d = projectIntervalToDisplay(timeline, s.start, s.end);
        if (!d) return;
        handleSelectionChange(d);
        handleToolbarAnnotationBoundsChange(d.start, d.end);
      },
      toggleFilterTool: handleToggleFilterTool,
      setFilterStrength: s => {
        setFilterStrength(s);
        if (bandPassFilter) setBandPassFilter({ ...bandPassFilter, strength: s });
      },
      enableFilter: handleEnableBandPassFilter,
      disableFilter: () => { handleDisableBandPassFilter(); setFilterStrength(0); },
      toggleBuzzdetect: () => setBuzzdetectEnabled(v => !v),
      toggleSubset: toggleBuzzdetectSubset,
      toggleSpectrogramSettings: () => setShowSettings(s => !s),
      setSpectrogramSettings: patch => setSettings(s => ({ ...s, ...patch })),
      toggleFileExpandCollapse: () => fileTreeHeaderRef.current?.toggleExpandCollapse(),
      refreshFiles: handleRefreshFiles,
      toggleFileFilter: handleToggleFileFilter,
      toggleShuffle: toggleShuffle,
      activateTool: handleToolActivate,
      activateSelectMode: () => { setActiveToolKey(null); activationStack.remove('annotationTool'); },
      openToolSettings: () => setShowToolSettings(true),
      openMassRename: () => setShowMassRename(true),
      openFindLabel: () => setShowFindLabel(true),
      editTool: setPanelEditingToolIndex,
      requestDeleteTool: setPanelDeletingToolIndex,
      playExample: toolId => {
        const tool = annotationTools.find(t => t.id === toolId);
        if (tool) examplePlayer.toggle(tool);
      },
      showExamples: handleShowExamples,
    },
    currentTimeStoreRef.current,
    // Bound, not passed as a bare method reference — Timeline is a class.
    t => timeline.toSource(t),
  );


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
               <div className="relative flex items-center">
                 <button
                    onClick={() => handleSync()}
                    disabled={syncing}
                    className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-50 disabled:cursor-default relative"
                    data-tooltip={
                      syncing ? tooltips.syncing
                      : hasLocalChanges && hasRemoteChanges ? `${tooltips.syncUnpushed} · ${tooltips.syncUnpulled}`
                      : hasLocalChanges ? tooltips.syncUnpushed
                      : hasRemoteChanges ? tooltips.syncUnpulled
                      : tooltips.syncIdle
                    }
                >
                    <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
                    {hasLocalChanges && !syncing && (
                      <span className="absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-green-400/80 pointer-events-none" />
                    )}
                    {hasRemoteChanges && !syncing && (
                      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-400/80 pointer-events-none" />
                    )}
                </button>
                <button
                    onClick={() => setSyncMenuOpen(o => !o)}
                    disabled={syncing}
                    className={`p-1 rounded hover:bg-slate-700 hover:text-white disabled:opacity-50 disabled:cursor-default ${syncMenuOpen ? 'text-white bg-slate-700' : 'text-slate-400'}`}
                    data-tooltip={tooltips.syncWithMessage}
                >
                    <ChevronDown size={14} />
                </button>
                {syncMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 z-[300] w-72 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-3">
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">{annotationWindow.commitLabel}</label>
                    <textarea
                      autoFocus
                      value={commitMessage}
                      onChange={e => setCommitMessage(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          setSyncMenuOpen(false);
                          handleSync(commitMessage);
                          setCommitMessage('');
                        } else if (e.key === 'Escape') {
                          setSyncMenuOpen(false);
                        }
                      }}
                      rows={2}
                      placeholder={annotationWindow.commitPlaceholder}
                      className="w-full text-xs bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-slate-100 placeholder-slate-500 resize-none focus:outline-none focus:border-[#e65161]"
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button
                        onClick={() => setSyncMenuOpen(false)}
                        className="text-xs px-2.5 py-1 rounded text-slate-300 hover:bg-slate-700"
                      >
                        {annotationWindow.syncMenuCancel}
                      </button>
                      <button
                        onClick={() => { setSyncMenuOpen(false); handleSync(commitMessage); setCommitMessage(''); }}
                        className="text-xs px-2.5 py-1 rounded bg-[#e65161] text-white hover:bg-[#d63d4e]"
                      >
                        {annotationWindow.syncMenuConfirm}
                      </button>
                    </div>
                  </div>
                )}
               </div>
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

      {/* Post-sync summary / error toast (non-blocking); fades out and clears itself after a few seconds. */}
      {(syncSummary || syncError) && (
        <div className={`fixed top-20 right-4 z-[300] w-80 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-4 transition-opacity duration-500 ${syncToastFading ? 'opacity-0' : 'opacity-100'}`}>
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              {syncError
                ? (syncError.includes('AUTH_FAILED:') ? annotationWindow.syncFailedAuth : annotationWindow.syncFailed)
                : syncIsAutoPull ? annotationWindow.autoPullComplete : annotationWindow.syncComplete}
            </h3>
            <button
              onClick={() => { setSyncSummary(null); setSyncError(null); }}
              className="text-slate-400 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
          {syncError ? (
            <p className="text-xs text-red-400 mt-2 whitespace-pre-wrap">
              {syncError.replace('AUTH_FAILED:', '').trim()}
            </p>
          ) : syncSummary && (
            <div className="text-xs text-slate-300 mt-2 space-y-1">
              <p>{syncSummary.message}</p>
              {syncSummary.identsUploaded > 0 && (
                <p>
                  Uploaded <span className="text-green-400">+{syncSummary.annotationsUploaded}</span>,{' '}
                  <span className="text-red-400">−{syncSummary.annotationsRemovedOnPush}</span> annotation{syncSummary.annotationsUploaded === 1 && syncSummary.annotationsRemovedOnPush === 0 ? '' : 's'}
                  {' '}across {syncSummary.identsUploaded} recording{syncSummary.identsUploaded === 1 ? '' : 's'}.
                </p>
              )}
              {(syncSummary.annotationsAdded > 0 || syncSummary.annotationsRemoved > 0) && (
                <p>
                  Downloaded <span className="text-green-400">+{syncSummary.annotationsAdded}</span>,{' '}
                  <span className="text-red-400">−{syncSummary.annotationsRemoved}</span> annotations
                  across {syncSummary.recordingsChanged.length} recording{syncSummary.recordingsChanged.length === 1 ? '' : 's'}.
                </p>
              )}
              {syncSummary.recordingsChanged.length > 0 && (
                <ul className="max-h-32 overflow-y-auto mt-1 space-y-0.5">
                  {syncSummary.recordingsChanged.map(p => (
                    <li key={p} className="font-mono text-[10px] text-slate-400 truncate">{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

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
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-5 max-w-md mx-4">
            <h3 className="text-sm font-semibold text-slate-100 mb-2">{annotationWindow.importErrorTitle}</h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">{importError}</p>
            <div className="flex justify-end">
              <button
                className="px-3 py-1.5 text-xs rounded bg-slate-700 text-slate-100 hover:bg-slate-600"
                onClick={() => setImportError(null)}
              >
                {annotationWindow.importOk}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex relative overflow-hidden select-none">
        {/* Left Panel: File Tree (top) + Labels Panel (bottom) */}
        {currentDirectory && (() => {
          const fileTreeProps = {
            rootDirectory: currentDirectory,
            allFiles: displayQueue,
            allFilesUnfiltered: shuffleMode ? shuffledFiles : allTracks,
            currentTrack: trackPath,
            onFileSelect: handleOpenTrack,
            onToggleCollapse: () => setFilePanelCollapsed(c => {
              if (c) setLeftPanelWidth(180);
              return !c;
            }),
            onNavigatePrev: () => navigateFile('prev'),
            onNavigateNext: () => navigateFile('next'),
            canNavigatePrev: currentFileIndex > 0,
            canNavigateNext: currentFileIndex < displayQueue.length - 1,
            shuffleMode,
            onToggleShuffle: toggleShuffle,
            annotatedTracks,
            fileFilter: (project?.preferences.fileFilter ?? 'all') as 'all' | 'annotated' | 'unannotated',
            onToggleFileFilter: handleToggleFileFilter,
            onRevealInFinder: handleRevealInFinder,
            onRevealAnnotations: handleRevealAnnotations,
            onRevealAnnotationsRoot: annotationDirectory
              ? () => revealInFileManager(annotationDirectory).catch(() => {})
              : undefined,
            onImportAnnotations: handleImportAnnotations,
            onRefresh: handleRefreshFiles,
            nonMediaFiles: allNonMediaFiles,
            initialEnteredFolderPath: project?.preferences.enteredFolderPath ?? null,
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
                  onOpenMassRename={() => setShowMassRename(true)}
                  onOpenFindLabel={() => setShowFindLabel(true)}
                  onEditTool={setPanelEditingToolIndex}
                  onRequestDeleteTool={setPanelDeletingToolIndex}
                  playingExampleToolId={examplePlayer.playingToolId}
                  onPlayExample={examplePlayer.toggle}
                  onShowExamples={handleShowExamples}
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
                <NeuronPalette
                  data={buzzdetectData}
                  thresholds={buzzdetectThresholds}
                  subsetThresholds={buzzdetectSubsetThresholds}
                  hiddenNeurons={buzzdetectHiddenNeurons}
                  neuronColors={buzzdetectNeuronColors}
                  subsetNeurons={buzzdetectSubsetNeurons}
                  pinnedNeurons={buzzdetectPinnedNeurons}
                  collapsed={sidebarSections.isCollapsed(SIDEBAR_SECTION_NEURONS)}
                  onToggleCollapsed={() => sidebarSections.toggleCollapsed(SIDEBAR_SECTION_NEURONS)}
                  onToggleNeuron={handleBuzzdetectToggleNeuron}
                  onSetAllNeuronsHidden={(hidden) => handleBuzzdetectSetAllNeuronsHidden(buzzdetectData?.neurons ?? [], hidden)}
                  onSoloNeuron={(n) => handleBuzzdetectSoloNeuron(buzzdetectData?.neurons ?? [], n)}
                  onNeuronColorChange={handleBuzzdetectNeuronColorChange}
                  onThresholdChange={handleBuzzdetectThresholdChange}
                  onSubsetThresholdChange={handleBuzzdetectSubsetThresholdChange}
                  onTogglePinNeuron={handleBuzzdetectTogglePinNeuron}
                  seriesMode={buzzdetectSeriesMode}
                  binWidthOverride={buzzdetectBinWidthOverride}
                  autoBinWidth={buzzdetectAutoBinWidth}
                  autoYRange={buzzdetectAutoYRange}
                  yAxisOverride={buzzdetectYAxisOverride}
                  minDetectionRate={buzzdetectMinDetectionRate}
                  subsetEnabled={subsetActive}
                  onToggleSubset={toggleBuzzdetectSubset}
                  panelOpen={buzzdetectEnabled}
                  onTogglePanel={() => setBuzzdetectEnabled(v => !v)}
                  subsetBuffer={buzzdetectSubsetBuffer}
                  subsetStats={buzzdetectSubsetStats}
                  settingsOpen={buzzdetectSettingsOpen}
                  onSettingsOpenChange={setBuzzdetectSettingsOpen}
                  onSeriesModeChange={setBuzzdetectSeriesMode}
                  onBinWidthOverrideChange={setBuzzdetectBinWidthOverride}
                  onYAxisOverrideChange={setBuzzdetectYAxisOverride}
                  onMinDetectionRateChange={setBuzzdetectMinDetectionRate}
                  onSubsetBufferChange={setBuzzdetectSubsetBuffer}
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
          <>
            <div
              style={{ height: videoCollapsed ? VIDEO_COLLAPSED_BAR_PX : `${splitRatio * 100}%` }}
              className="bg-black relative flex flex-none overflow-hidden"
              data-help-target="video-panel"
            >
              <VideoPane
                frameSource={frameSourceRef.current}
                frameSourceVersion={frameSourceVersion}
                frameSourceDecodeError={frameSourceDecodeError}
                isAudioTrack={isAudioTrack}
                videoSrc={videoSrc}
                isProcessing={isProcessing}
                isBuffering={isBuffering}
                getMediaTime={getMediaTime}
                onDebugLog={addLog}
                onDurationChange={setDuration}
                videoMode={videoMode}
                hasSelection={selection !== null}
                onVideoModeChange={handleVideoModeChange}
                onVideoElement={attachVideoElement}
                brightness={videoBrightness}
                contrast={videoContrast}
                onBrightnessChange={setVideoBrightness}
                onContrastChange={setVideoContrast}
              />
              {videoCollapsed && (
                <div className="absolute inset-0 z-40 bg-slate-900 border-b border-slate-700 flex items-center px-3">
                  <button
                    type="button"
                    onClick={() => setVideoCollapsed(false)}
                    className="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors"
                    data-tooltip={tooltips.expandVideoPanel}
                  >
                    <ChevronDown size={16} />
                    <span className="text-xs font-medium uppercase tracking-wide">{annotationWindow.videoLabel}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Resizer Handle */}
            <div
                className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors z-10 flex justify-center items-center"
                onMouseDown={handleSplitDrag}
            >
                <div className="w-12 h-1 bg-slate-600 rounded-full" />
            </div>
          </>
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
               onTogglePlayheadLock={() => {
                 const willLock = !playheadLocked;
                 setPlayheadLocked(willLock);
                 if (willLock) spectrogramRef.current?.recenterPlayhead();
               }}
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
                cacheVersion={cacheVersion}
                currentTimeStore={currentTimeStoreRef.current}
                duration={displayDuration}
                timeline={timeline}
                isPlaying={isPlaying}
                isProcessing={isProcessing}
                ident={ident}
                settings={settings}
                zoomSec={zoomSec}
                annotations={displayAnnotations}
                selectedAnnotationId={selectedAnnotationId}
                activeAnnotationTool={activeToolKey !== null ? (annotationTools.find(t => t.key === activeToolKey) ?? null) : null}
                annotationTools={annotationTools}
                selection={selection}
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
               <BuzzdetectPanel
                 data={displayBuzzdetectData}
                 viewportStore={viewportStoreRef.current}
                 duration={displayDuration}
                 currentTimeStore={currentTimeStoreRef.current}
                 selection={selection}
                 timeDisplayUnit={shownTimeUnit}
                 trackStartDate={trackStartDate}
                 dateTimeFormat={dateTimeFormat}
                 thresholds={buzzdetectThresholds}
                 hiddenNeurons={buzzdetectHiddenNeurons}
                 neuronColors={buzzdetectNeuronColors}
                 seriesMode={buzzdetectSeriesMode}
                 binWidthOverride={buzzdetectBinWidthOverride}
                 subsetActive={subsetActive}
                 timeline={timeline}
                 yAxisOverride={buzzdetectYAxisOverride}
                 reportAutoValues={buzzdetectSettingsOpen}
                 height={buzzdetectPanelHeight}
                 onAutoBinWidthChange={setBuzzdetectAutoBinWidth}
                 onAutoYRangeChange={setBuzzdetectAutoYRange}
                 onHeightChange={setBuzzdetectPanelHeight}
                 onSelectionChange={handleSelectionChange}
                 onBoundAnnotationChange={setBoundAnnotationId}
                 onSeek={seek}
                 onScrollWheel={(deltaX, deltaY, ctrlKey, metaKey, clientX) =>
                   spectrogramRef.current?.applyWheel(deltaX, deltaY, ctrlKey, metaKey, clientX)
                 }
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
      {showMassRename && (
        <MassRenameModal
          annotations={annotations}
          allTracks={allTracks}
          trackPath={trackPath}
          ident={ident}
          getAnnotationPath={getAnnotationPath}
          getIdent={getIdent}
          onClose={() => setShowMassRename(false)}
          onApply={handleMassRename}
        />
      )}
      {showFindLabel && (
        <FindLabelModal
          annotations={annotations}
          allTracks={allTracks}
          trackPath={trackPath}
          ident={ident}
          getAnnotationPath={getAnnotationPath}
          getIdent={getIdent}
          useRegex={project.preferences.findLabelUseRegex ?? false}
          onUseRegexChange={handleFindLabelUseRegexChange}
          partial={project.preferences.findLabelPartialMatch ?? false}
          onPartialChange={handleFindLabelPartialChange}
          onClose={() => setShowFindLabel(false)}
          onGo={handleGoToLabelMatch}
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
          onSave={(text, color, description) => {
            handleRenameTool(panelEditingToolIndex, text, color, description);
            setPanelEditingToolIndex(null);
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
