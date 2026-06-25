import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Settings, Keyboard, HelpCircle, Bug, ArrowLeft, ChevronDown, RefreshCw, X } from 'lucide-react';
import VideoPane from './components/VideoPane';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import GradientProjectName from './components/GradientProjectName';
import { HelpPanel } from './components/HelpPanel';
import { Annotation, SpectrogramSettings, FrequencyScale, Project, ProjectSettings, ProjectPreferences, Selection, VideoMode } from './types';
import { DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_UI_SETTINGS, DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_BUZZDETECT_PANEL_HEIGHT, DEFAULT_LEFT_PANEL_WIDTH, DEFAULT_SPLIT_RATIO, DEFAULT_LEFT_PANEL_RATIO, isSupportedMediaFile, migrateVideoMode, getExt } from './constants';
import { exportToAudacity, makeAnnotationFromTool, stripExt, shuffleArray, basename } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, toAssetUrl } from './utils/tauriCommands';
import { createViewportStore } from './utils/viewportStore';
import { createCurrentTimeStore } from './utils/currentTimeStore';
import { useHotkeys } from './hooks/useHotkeys';
import { useExamplePlayer } from './hooks/useExamplePlayer';
import { useActivationStack } from './hooks/useActivationStack';
import { useAnnotationHistory } from './hooks/useAnnotationHistory';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useBandPassFilter } from './hooks/useBandPassFilter';
import { useBuzzdetect } from './hooks/useBuzzdetect';
import { useProjectPersistence } from './hooks/useProjectPersistence';
import { useSyncManagement } from './hooks/useSyncManagement';
import { useAnnotationTools } from './hooks/useAnnotationTools';
import { useImportAnnotations } from './hooks/useImportAnnotations';
import { useFileNavigation } from './hooks/useFileNavigation';
import { useVideoFrameSource } from './hooks/useVideoFrameSource';
import { usePlaybackTransport } from './hooks/usePlaybackTransport';
import { useAnnotationLoad } from './hooks/useAnnotationLoad';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { revealInFileManager, listAnnotationFiles } from './utils/projectCommands';
import { AudioEngine } from './utils/AudioEngine';
import { VideoElementEngine } from './utils/VideoElementEngine';
import { VideoFrameSource, canUseFrameSource } from './utils/VideoFrameSource';
import TooltipLayer from './components/TooltipLayer';
import DebugConsole from './components/DebugConsole';
import AnnotationToolsPanel from './components/AnnotationToolsPanel';
import AnnotationToolsSettingsModal from './components/AnnotationToolsSettingsModal';
import AnnotationToolEditModal from './components/AnnotationToolEditModal';
import AnnotationToolLibrary from './components/AnnotationToolLibrary';
import DeleteToolConfirmDialog from './components/DeleteToolConfirmDialog';
import Toolbar from './components/Toolbar';
import LevelRangeSlider from './components/LevelRangeSlider';
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

  // Git sync state, the manual sync handler, and the sync-status effects live in
  // useSyncManagement (set up below, once its dependencies are declared).
  // Annotation-tool palette state, refs, and CRUD handlers live in
  // useAnnotationTools (instantiated below, after its dependencies exist).

  // Derived from project prop
  const annotationDirectory = project.annotationDirectoryAbs ?? null;

  // Chunk cache ref — not state, to avoid re-renders on every chunk load
  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

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
  // track-open / annotation-load / project-change paths below.
  const {
    annotationsHistoryRef,
    historyIndexRef,
    handleAnnotationsCommit,
    undoAnnotations,
    redoAnnotations,
  } = useAnnotationHistory(setAnnotations);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  // null = Selection Mode (no annotation tool active); string key of the active tool otherwise.
  const [activeToolKey, setActiveToolKey] = useState<string | null>(null);

  // Selection region for Selection Mode playback and UI
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);

  // Annotation currently bound to the selection region (null = free selection or no selection)
  const [boundAnnotationId, setBoundAnnotationId] = useState<string | null>(null);

  // Per-session text buffer for annotation tool reassignment: saves each toolKey's text while an
  // annotation is bound, so switching back to a prior tool restores the previously-entered text.
  // Cleared when the bound annotation is deselected.
  const reassignBufferRef = useRef<Record<string, string>>({});

  // Ref to Spectrogram imperative handle (prev/next annotation navigation)
  const spectrogramRef = useRef<SpectrogramHandle>(null);

  // Panel sizing + drag handling (video/spectrogram split, left-panel height &
  // width) plus the H-held hide-labels toggle. See hooks/usePanelLayout.ts.
  const {
    splitRatio, setSplitRatio,
    leftPanelRatio, setLeftPanelRatio,
    leftPanelWidth, setLeftPanelWidth,
    filePanelCollapsed, setFilePanelCollapsed,
    videoCollapsed, setVideoCollapsed,
    hideLabels,
    VIDEO_COLLAPSED_BAR_PX,
    handleSplitDrag,
    handleLeftPanelDrag,
    handleLeftPanelWidthDrag,
  } = usePanelLayout({
    splitRatio: project.preferences.uiSettings?.splitRatio ?? DEFAULT_SPLIT_RATIO,
    leftPanelRatio: project.preferences.uiSettings?.leftPanelRatio ?? DEFAULT_LEFT_PANEL_RATIO,
    leftPanelWidth: project.preferences.uiSettings?.leftPanelWidthRatio != null
      ? project.preferences.uiSettings.leftPanelWidthRatio * window.innerWidth
      : DEFAULT_LEFT_PANEL_WIDTH,
  });
  const [playheadLocked, setPlayheadLocked] = useState(project.preferences.uiSettings?.playheadLocked ?? false);
  const playheadLockedRef = useRef(false);
  useEffect(() => { playheadLockedRef.current = playheadLocked; }, [playheadLocked]);

  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<'guide' | 'annotations' | 'shortcuts'>('guide');
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);

  const [zoomSec, setZoomSec] = useState(project.preferences.uiSettings?.zoomSec ?? DEFAULT_UI_SETTINGS.zoomSec);

  // Video-rendering mode (off / fast / mixed / accurate). Drives which player
  // VideoPane mounts and whether handleOpenTrack opens / warms a frame source.
  // Refs let async closures (engine onTimeUpdate, selection commit) read the
  // current mode without being recreated on every render.
  const [videoMode, setVideoMode] = useState<VideoMode>(
    migrateVideoMode(project.preferences.uiSettings?.videoMode),
  );
  const videoModeRef = useRef(videoMode);
  useEffect(() => { videoModeRef.current = videoMode; }, [videoMode]);

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

  // Memoized so children whose effects depend on it (e.g. CanvasVideoPlayer's
  // rAF loop) don't tear down on every parent re-render.
  const addLog = useCallback((msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  }, []);

  // Shared example-clip player for the tool-chip play buttons (palette + tool
  // settings). Independent of the main track's AudioEngine.
  const examplePlayer = useExamplePlayer(addLog);
  // Annotation-tool palette + import-annotations hooks are instantiated below,
  // after trackPathRef exists; `libraryPlaying` / `exampleAudioActive` come from
  // there.

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
    prerollVideo,
  } = useVideoFrameSource({
    trackPath,
    trackPathRef,
    isAudioTrack,
    videoMode,
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
    engineRef,
    currentTimeRef,
    currentTimeStoreRef,
    togglePlay,
    seek,
    activeTransport,
    getMediaTime,
    attachVideoElement,
  } = usePlaybackTransport({
    project,
    isAudioTrack,
    isAudioTrackRef,
    videoMode,
    videoModeRef,
    videoSrc,
    videoSrcRef,
    duration,
    durationRef,
    selection,
    selectionRef,
    frameSourceRef,
    videoPrefetchEndRef,
    videoPrefetchBusyRef,
    prerollVideo,
    spectrogramRef,
    examplePlayer,
    addLog,
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

  const zoomSecRef = useRef(DEFAULT_ZOOM_SEC);
  useEffect(() => { zoomSecRef.current = zoomSec; }, [zoomSec]);

  // Clear the saved pre-zoom extent on every track change. trackPathRef mirroring
  // lives in useFileNavigation; preZoomExtentRef is owned by useVideoFrameSource,
  // so the reset stays here in the orchestrator where both are in scope.
  useEffect(() => { preZoomExtentRef.current = null; }, [trackPath]);

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

  // Annotation-tool palette: tool array + mirror ref, the folder-reconcile
  // persistence effect, and every tool CRUD/import handler. See
  // hooks/useAnnotationTools.ts.
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

  // An example clip is sounding via either path (chip preview or the modal).
  // While true the main track's audio is parked so the two never overlap, and
  // the spectrogram shows a dimmed "example audio is playing" veil.
  const exampleAudioActive = examplePlayer.playingToolId !== null || libraryPlaying;

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
    const audioExts = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma'];
    const ext = getExt(fileName);
    const isAudio = audioExts.includes(ext);
    setIsAudioTrack(isAudio);
    setTrackName(fileName);

    const assetUrl = toAssetUrl(absolutePath);
    setVideoSrc(assetUrl);

    addLog(`Opening: ${fileName}`);
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

        // Create new multi-tier chunk cache for this file
        const cache = new MultiTierSpectrogramCache(
            absolutePath,
            settings.fftSize,
            sr,
            dur,
            () => setCacheVersion(v => v + 1),
        );
        chunkCacheRef.current = cache;
        setCacheVersion(0);

        // Kick off first viewport prefetch immediately
        cache.prefetchViewport(0, effectiveZoom, cache.selectTier(effectiveZoom, 1200).tier);
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
        chunkCacheRef.current = null;
        setCacheVersion(v => v + 1);
        if (frameSourceRef.current) {
            frameSourceRef.current.close();
            frameSourceRef.current = null;
            setFrameSourceVersion(v => v + 1);
        }
    } finally {
        setIsProcessing(false);
    }
  }, [settings.fftSize]);

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

  // Rebuild cache when FFT size changes while a track is open
  useEffect(() => {
    if (!trackPath || !sampleRate || !duration) return;
    const cache = new MultiTierSpectrogramCache(
      trackPath,
      settings.fftSize,
      sampleRate,
      duration,
      () => setCacheVersion(v => v + 1),
    );
    chunkCacheRef.current = cache;
    setCacheVersion(0);
    cache.prefetchViewport(0, zoomSec, cache.selectTier(zoomSec, 1200).tier);
  }, [settings.fftSize]);

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
    const anns = sortedAnnotationsRef.current;
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
  useEffect(() => { recomputeCanGo(); }, [sortedAnnotations, recomputeCanGo]);

  // Toggle shuffle: randomise current allTracks order
  // Ident: relative path from audio root to track, without extension
  const ident = useMemo(() => {
    if (!trackPath || !currentDirectory) return null;
    const rel = trackPath.substring(currentDirectory.length + 1);
    return stripExt(rel);
  }, [trackPath, currentDirectory]);

  // buzzdetect activations panel UI state + load-by-ident effect.
  const {
    buzzdetectEnabled, setBuzzdetectEnabled,
    buzzdetectThresholds, setBuzzdetectThresholds,
    buzzdetectHiddenNeurons, setBuzzdetectHiddenNeurons,
    buzzdetectPanelHeight, setBuzzdetectPanelHeight,
    buzzdetectData, setBuzzdetectData,
    handleBuzzdetectThresholdChange,
    handleBuzzdetectToggleNeuron,
  } = useBuzzdetect({ project, ident, addLog });

  // Band-pass filter state machine (filter tool / band / strength + engine-push
  // and persistence effects). Needs engineRef, the activation stack, and the
  // project plumbing for debounced persistence. See hooks/useBandPassFilter.ts.
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
    buzzdetectHiddenNeurons,
    videoMode,
    playheadLocked,
    filePanelCollapsed,
    videoCollapsed,
    splitRatio,
    leftPanelRatio,
    leftPanelWidth,
  });

  // Pending-save timer for the annotation autosave. Created here because both
  // useSyncManagement (flushes it before sync) and useAnnotationLoad (sets it)
  // need it — shared boundary, owned by neither hook.
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Git sync — owns sync state, the manual handler, and status effects.
  // `setHasLocalChanges` is consumed by the autosave effect below; `reloadNonce`
  // by the annotation auto-load effect.
  const {
    syncing,
    syncSummary,
    setSyncSummary,
    syncError,
    setSyncError,
    hasLocalChanges,
    setHasLocalChanges,
    hasRemoteChanges,
    reloadNonce,
    handleSync,
  } = useSyncManagement({
    project,
    projectRef,
    annotations,
    getAnnotationPath,
    autoSaveTimeoutRef,
    trackPathRef,
    addLog,
  });

  // Custom-commit-message popover: open state + the typed message.
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');

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
    setBuzzdetectEnabled(project.preferences.uiSettings?.buzzdetectEnabled ?? false);
    setBuzzdetectThresholds(project.preferences.uiSettings?.buzzdetectThresholds ?? {});
    setBuzzdetectHiddenNeurons(project.preferences.uiSettings?.buzzdetectHiddenNeurons ?? []);
    setBuzzdetectPanelHeight(DEFAULT_BUZZDETECT_PANEL_HEIGHT);
    setBuzzdetectData(null);
    setFilterToolActive(false);
    // Panel layout — restore persisted layout for this project.
    const savedUi = project.preferences.uiSettings;
    setPlayheadLocked(savedUi?.playheadLocked ?? false);
    setFilePanelCollapsed(savedUi?.filePanelCollapsed ?? false);
    setVideoCollapsed(savedUi?.videoCollapsed ?? false);
    setSplitRatio(savedUi?.splitRatio ?? DEFAULT_SPLIT_RATIO);
    setLeftPanelRatio(savedUi?.leftPanelRatio ?? DEFAULT_LEFT_PANEL_RATIO);
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

    listMediaFilesRecursive(project.mediaDirectoryAbs)
      .then(files => {
        setAllMediaFiles(files);
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
      const files = await listMediaFilesRecursive(project.mediaDirectoryAbs);
      setAllMediaFiles(files);
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
      setCurrentDirectory(updated.mediaDirectoryAbs);
      setTrackPath(null);
      setVideoSrc(null);
      setAnnotations([]);
      try {
        const files = await listMediaFilesRecursive(updated.mediaDirectoryAbs);
        setAllMediaFiles(files);
        if (files.length > 0) handleOpenTrack(files[0]);
      } catch (err) {
        setAllMediaFiles([]);
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
              reassignBufferRef.current = {
                  ...reassignBufferRef.current,
                  [currentAnnotation.toolKey]: currentAnnotation.text,
              };
              const savedText = reassignBufferRef.current[tool.key ?? ''];
              const newText = savedText !== undefined ? savedText : (isCustom ? '' : tool.text);
              const updated = annotations.map(a => a.id === boundAnnotationId
                  ? { ...a, toolKey: tool.key, text: newText, color: tool.color }
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
          const newAnnotation = makeAnnotationFromTool(tool, selection.start, selection.end);
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
  }, [annotationTools, boundAnnotationId, annotations, activeToolKey, selection, handleAnnotationsCommit, reassignBufferRef, activationStack]);

  // Global Hotkeys — see hooks/useHotkeys.ts. Handlers close over the latest
  // render's state (the bindings array is read from a ref refreshed each render),
  // so we don't need to manage a dep list here.
  const selectAllOrAnnotateFullTrack = () => {
      if (duration <= 0) return;
      if (activeToolKey !== null) {
          const tool = annotationTools.find(t => t.key === activeToolKey);
          if (tool) {
              const newAnnotation = makeAnnotationFromTool(tool, 0, duration);
              handleAnnotationsCommit([...annotations, newAnnotation]);
              setSelectedAnnotationId(newAnnotation.id);
              setBoundAnnotationId(newAnnotation.id);
              handleSelectionChange({ start: 0, end: duration });
          }
      } else {
          handleSelectionChange({ start: 0, end: duration });
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
      // Help panel — also fires inside text inputs, since help is universal.
      { key: 'F1', allowInInput: true, handler: () => setShowHelp(prev => !prev) },

      // Mod+key bindings. Order matters: more specific (mod+shift+z) before mod+z.
      { key: 'a', mods: ['mod'], handler: selectAllOrAnnotateFullTrack },
      { key: 'z', mods: ['mod', 'shift'], handler: () => redoAnnotations() },
      { key: 'z', mods: ['mod'], handler: () => undoAnnotations() },
      { key: 'y', mods: ['mod'], handler: () => redoAnnotations() },
      { key: 'ArrowLeft', mods: ['mod'], handler: () => spectrogramRef.current?.goToPrevAnnotation() },
      { key: 'ArrowRight', mods: ['mod'], handler: () => spectrogramRef.current?.goToNextAnnotation() },
      { key: 'ArrowUp', mods: ['mod'], handler: () => navigateFile('prev') },
      { key: 'ArrowDown', mods: ['mod'], handler: () => navigateFile('next') },
      { key: '=', mods: ['mod'], handler: () => { spectrogramRef.current?.zoomIn(); preZoomExtentRef.current = null; } },
      { key: '+', mods: ['mod', 'shift'], handler: () => { spectrogramRef.current?.zoomIn(); preZoomExtentRef.current = null; } },
      { key: '-', mods: ['mod'], handler: () => { spectrogramRef.current?.zoomOut(); preZoomExtentRef.current = null; } },
      { key: '0', mods: ['mod'], handler: () => {
          const dur = durationRef.current;
          if (!dur) return;
          const { scrollLeft: sl, pixelsPerSecond: pps } = viewportStoreRef.current.get();
          const startTime = pps > 0 ? sl / pps : 0;
          const isAtFullExtent = zoomSecRef.current >= dur;
          if (isAtFullExtent && preZoomExtentRef.current) {
            const saved = preZoomExtentRef.current;
            spectrogramRef.current?.zoomToRange(saved.startTime, saved.endTime);
            preZoomExtentRef.current = null;
          } else {
            preZoomExtentRef.current = { startTime, endTime: startTime + zoomSecRef.current };
            spectrogramRef.current?.zoomToRange(0, dur);
          }
      }},

      // Plain arrow keys: scrub playhead ±10% of visible window.
      { key: 'ArrowLeft', handler: () => seek(Math.max(0, currentTimeRef.current - zoomSecRef.current * 0.1)) },
      { key: 'ArrowRight', handler: () => seek(Math.min(durationRef.current, currentTimeRef.current + zoomSecRef.current * 0.1)) },
      // Frame scrub: step back/forward one frame (video tracks only).
      { key: ',', handler: () => {
        if (isAudioTrackRef.current) return;
        const frameDuration = frameSourceRef.current?.getFrameDuration() ?? (1 / 30);
        seek(Math.max(0, currentTimeRef.current - frameDuration));
      }},
      { key: '.', handler: () => {
        if (isAudioTrackRef.current) return;
        const frameDuration = frameSourceRef.current?.getFrameDuration() ?? (1 / 30);
        seek(Math.min(durationRef.current, currentTimeRef.current + frameDuration));
      }},

      // Plain keys.
      { key: ' ', handler: togglePlay },
      { key: 'r', handler: () => setPlaybackSpeed(playbackSpeed === 1 ? lastDefinedSpeed : 1) },
      // `S`: select tool (no annotation tool readied). Stack-equivalent to
      // removing the `annotationTool` entry — does not touch selection, filter
      // tool, or band.
      { key: 's', handler: () => {
          setActiveToolKey(null);
          activationStack.remove('annotationTool');
      }},
      // `Shift+F`: ready the filter tool (click-drag to define band).
      // `F`: toggle filter state on/off (restore last band). Must come after shift binding.
      { key: 'e', handler: () => {
          if (activeToolKey === null) return;
          const tool = annotationTools.find(t => t.key === activeToolKey);
          if (tool) examplePlayer.toggle(tool);
      }},
      { key: 'f', mods: ['shift'], handler: () => { if (videoMode !== 'fast') handleToggleFilterTool(); } },
      { key: 'f', handler: () => { if (videoMode !== 'fast') handleToggleFilterState(); } },
      { key: 'm', handler: () => setMuted(prev => !prev), preventDefault: false },
      // `C`: recenter the visible window on the playhead (no zoom change).
      { key: 'c', handler: () => {
          const willLock = !playheadLockedRef.current;
          setPlayheadLocked(willLock);
          if (willLock) spectrogramRef.current?.recenterPlayhead();
      }},
      // Escape — universal undo of the most-recently-activated layer. Fires
      // even when a text input has focus (HelpPanel's `stop:true` Esc handler
      // still wins when help is open). Layer kinds & clear actions:
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
      // handleToolActivate so palette clicks and hotkeys agree.
      { key: 'Digit', handler: (e) => {
          const tool = annotationTools.find(t => t.key === e.key);
          if (tool) handleToolActivate(e.key);
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
    }
  }, [activationStack]);

  // Called by Toolbar time-field edits to sync the bound annotation's bounds.
  const handleToolbarAnnotationBoundsChange = useCallback((start: number, end: number) => {
    if (!boundAnnotationId) return;
    const old = annotations.find(a => a.id === boundAnnotationId);
    if (old && Math.abs(currentTimeRef.current - old.start) <= 0.5) {
      seek(start, false);
    }
    handleAnnotationsCommit(annotations.map(a =>
      a.id === boundAnnotationId ? { ...a, start, end } : a
    ));
  }, [boundAnnotationId, annotations, handleAnnotationsCommit, seek]);


  return (
    <div
      className="flex flex-col h-screen bg-slate-900 text-slate-200"
      style={{ marginRight: showHelp ? '320px' : '0', transition: 'margin-right 300ms ease-in-out' }}
    >
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
                onClick={() => { setHelpTab('guide'); setShowHelp(prev => !prev); }}
                className={`p-2 rounded hover:bg-slate-700 transition-colors ${showHelp ? 'text-[#e65161] bg-slate-700' : 'text-slate-400 hover:text-white'}`}
                data-tooltip={tooltips.helpGuide}
            >
                <HelpCircle size={18} />
            </button>
             <button
                onClick={() => { setHelpTab('shortcuts'); setShowHelp(true); }}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                data-tooltip={tooltips.keyboardShortcuts}
            >
                <Keyboard size={18} />
            </button>
        </div>
      </header>

      {/* Post-sync summary / error toast (non-blocking). */}
      {(syncSummary || syncError) && (
        <div className="fixed top-20 right-4 z-[300] w-80 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              {syncError
                ? (syncError.includes('AUTH_FAILED:') ? annotationWindow.syncFailedAuth : annotationWindow.syncFailed)
                : annotationWindow.syncComplete}
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

      <HelpPanel
        open={showHelp}
        tab={helpTab}
        onTabChange={setHelpTab}
        onClose={() => setShowHelp(false)}
      />

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
            initialEnteredFolderPath: project?.preferences.enteredFolderPath ?? null,
            onEnteredFolderChange: handleEnteredFolderChange,
          };

          if (filePanelCollapsed) {
            return (
              <div className="flex-none w-10 bg-slate-900 border-r border-slate-700 flex flex-col h-full relative">
                <FileTree {...fileTreeProps} collapsed={true} />
                <div
                  className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
                  style={{ right: '-6px', width: '6px' }}
                  onMouseDown={handleLeftPanelWidthDrag}
                />
              </div>
            );
          }

          return (
            <div
              className="flex-none bg-slate-900 border-r border-slate-700 flex flex-col h-full relative"
              style={{ width: leftPanelWidth }}
              data-help-target="file-panel"
            >
              {/* File Tree portion */}
              <div style={{ height: `${leftPanelRatio * 100}%` }} className="min-h-0 overflow-hidden flex flex-col">
                <FileTree {...fileTreeProps} collapsed={false} />
              </div>

              {/* Horizontal divider — matches video/spectrogram divider */}
              <div
                className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors flex-none z-10 flex justify-center items-center"
                onMouseDown={handleLeftPanelDrag}
              >
                <div className="w-12 h-1 bg-slate-600 rounded-full" />
              </div>

              <AnnotationToolsPanel
                annotationTools={annotationTools}
                activeToolKey={activeToolKey}
                onToolActivate={handleToolActivate}
                onSelectModeActivate={() => { setActiveToolKey(null); activationStack.remove('annotationTool'); }}
                onOpenSettings={() => setShowToolSettings(true)}
                onEditTool={setPanelEditingToolIndex}
                onRequestDeleteTool={setPanelDeletingToolIndex}
                playingExampleToolId={examplePlayer.playingToolId}
                onPlayExample={examplePlayer.toggle}
                onShowExamples={handleShowExamples}
              />

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

        {/* Video Pane — kept mounted when collapsed (the <video> element is the
            audio transport in Fast/Mixed mode) but squished behind an opaque bar. */}
        <div
          style={{ height: videoCollapsed ? VIDEO_COLLAPSED_BAR_PX : `${splitRatio * 100}%` }}
          className="bg-black relative flex flex-none overflow-hidden"
          data-help-target="video-panel"
        >
          <VideoPane
            frameSource={frameSourceRef.current}
            frameSourceVersion={frameSourceVersion}
            isAudioTrack={isAudioTrack}
            videoSrc={videoSrc}
            isProcessing={isProcessing}
            isBuffering={isBuffering}
            getMediaTime={getMediaTime}
            onDebugLog={addLog}
            onDurationChange={isAudioTrack ? undefined : setDuration}
            videoMode={videoMode}
            hasSelection={selection !== null}
            onVideoModeChange={setVideoMode}
            onVideoElement={attachVideoElement}
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

        {/* Spectrogram Pane */}
        <div className="relative flex-1 min-h-0 bg-slate-900 border-t border-slate-700 flex flex-col" data-help-target="spectrogram-canvas">

             {/* Settings Panel (Absolute, relative to spectrogram pane) */}
             {showSettings && (
                <div className="absolute top-10 right-4 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                    <div className="p-4 space-y-6">
                        {/* Level Range */}
                        <LevelRangeSlider
                            floor={settings.displayFloor}
                            ceil={settings.displayCeil}
                            onChange={(r) => setSettings(s => ({ ...s, ...r }))}
                        />

                        {/* Frequency */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{annotationWindow.freqHeader}</h4>
                            <div className="flex space-x-2 pt-2">
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">{annotationWindow.freqMin}</label>
                                    <input
                                        type="number"
                                        value={settings.minFreq}
                                        onChange={(e) => setSettings(s => ({...s, minFreq: Math.max(0, parseInt(e.target.value))}))}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">{annotationWindow.freqMax}</label>
                                    <input
                                        type="number"
                                        value={settings.maxFreq}
                                        onChange={(e) => setSettings(s => ({...s, maxFreq: parseInt(e.target.value)}))}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* FFT */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{annotationWindow.fftHeader}</h4>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">{annotationWindow.windowSize}</label>
                                <select
                                    value={settings.fftSize}
                                    onChange={(e) => setSettings(s => ({...s, fftSize: parseInt(e.target.value)}))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none text-white"
                                >
                                    {[256, 512, 1024, 2048, 4096, 8192].map(n => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">{annotationWindow.scaleLabel}</label>
                                <select
                                    value={settings.frequencyScale}
                                    onChange={(e) => setSettings(s => ({...s, frequencyScale: e.target.value as FrequencyScale}))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none text-white"
                                >
                                    <option value="linear">{annotationWindow.scaleLinear}</option>
                                    <option value="log">{annotationWindow.scaleLog}</option>
                                    <option value="mel">{annotationWindow.scaleMel}</option>
                                </select>
                            </div>
                        </div>

                    </div>
                </div>
             )}

             <Toolbar
               isPlaying={isPlaying}
               isBuffering={isBuffering || exampleAudioActive}
               videoSrc={videoSrc}
               currentTimeStore={currentTimeStoreRef.current}
               duration={duration}
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
               videoMode={videoMode}
               buzzdetectAvailable={project.buzzdetectDirectoryAbs !== null}
               buzzdetectEnabled={buzzdetectEnabled}
               onToggleBuzzdetect={() => setBuzzdetectEnabled(v => !v)}
               onRestartAudio={() => { engineRef.current?.restart(); }}
               playheadLocked={playheadLocked}
               onTogglePlayheadLock={() => {
                 const willLock = !playheadLockedRef.current;
                 setPlayheadLocked(willLock);
                 if (willLock) spectrogramRef.current?.recenterPlayhead();
               }}
             />

             <div className="flex-1 relative overflow-hidden">
             <Spectrogram
                ref={spectrogramRef}
                chunkCache={chunkCacheRef.current}
                sampleRate={sampleRate}
                cacheVersion={cacheVersion}
                currentTimeStore={currentTimeStoreRef.current}
                duration={duration}
                isPlaying={isPlaying}
                isProcessing={isProcessing}
                ident={ident}
                settings={settings}
                zoomSec={zoomSec}
                annotations={annotations}
                selectedAnnotationId={selectedAnnotationId}
                activeAnnotationTool={activeToolKey !== null ? (annotationTools.find(t => t.key === activeToolKey) ?? null) : null}
                annotationTools={annotationTools}
                selection={selection}
                boundAnnotationId={boundAnnotationId}
                onSeek={seek}
                onAnnotationsChange={setAnnotations}
                onAnnotationsCommit={handleAnnotationsCommit}
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
                videoMode={videoMode}
                isAudioTrack={isAudioTrack}
                playheadLocked={playheadLocked}
                hideLabels={hideLabels}
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

             {buzzdetectEnabled && (
               <BuzzdetectPanel
                 data={buzzdetectData}
                 viewportStore={viewportStoreRef.current}
                 duration={duration}
                 currentTimeStore={currentTimeStoreRef.current}
                 selection={selection}
                 thresholds={buzzdetectThresholds}
                 hiddenNeurons={buzzdetectHiddenNeurons}
                 height={buzzdetectPanelHeight}
                 onThresholdChange={handleBuzzdetectThresholdChange}
                 onToggleNeuron={handleBuzzdetectToggleNeuron}
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
      {panelEditingToolIndex !== null && (
        <AnnotationToolEditModal
          tool={annotationTools[panelEditingToolIndex]}
          toolIndex={panelEditingToolIndex}
          annotations={annotations}
          onClose={() => setPanelEditingToolIndex(null)}
          onPreviewColor={handlePreviewToolColor}
          onImportExamples={handleImportExamplesToTool}
          onShowExamples={(idx) => { setPanelEditingToolIndex(null); handleShowExamples(idx); }}
          onSave={(idx, text, color, description) => {
            handleRenameTool(idx, text, color, description);
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
