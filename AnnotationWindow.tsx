import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Settings, Keyboard, HelpCircle, Bug, ArrowLeft } from 'lucide-react';
import VideoPane from './components/VideoPane';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import GradientProjectName from './components/GradientProjectName';
import { HelpPanel } from './components/HelpPanel';
import { Annotation, SpectrogramSettings, AnnotationTool, FrequencyScale, Project, ProjectSettings, Selection, BandPassFilter, ProjectUiSettings, BuzzdetectData, VideoMode, PlaybackTransport } from './types';
import { DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_ANNOTATION_TOOLS, DEFAULT_BAND_PASS_FILTER, DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_UI_SETTINGS, DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_BUZZDETECT_PANEL_HEIGHT, isSupportedMediaFile, migrateVideoMode, getExt } from './constants';
import { exportToAudacity, generateAudacityContent, makeAnnotationFromTool, stripExt, shuffleArray } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, readTextFile, writeTextFile, removeFile, toAssetUrl, readBuzzdetect } from './utils/tauriCommands';
import { createViewportStore } from './utils/viewportStore';
import { createCurrentTimeStore } from './utils/currentTimeStore';
import { useHotkeys } from './hooks/useHotkeys';
import { useActivationStack } from './hooks/useActivationStack';
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
import DeleteToolConfirmDialog from './components/DeleteToolConfirmDialog';
import Toolbar from './components/Toolbar';
import BuzzdetectPanel from './components/BuzzdetectPanel';

export interface AnnotationWindowProps {
  project: Project;
  onClose: () => void;
  updateProjectSettings: (id: string, settings: ProjectSettings) => Promise<Project | undefined>;
  touchLastOpened: (id: string) => void;
}

export default function AnnotationWindow({ project, onClose, updateProjectSettings, touchLastOpened }: AnnotationWindowProps) {
  // Track State
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [trackName, setTrackName] = useState<string>("video");
  const [trackPath, setTrackPath] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [isAudioTrack, setIsAudioTrack] = useState(false);
  const [sampleRate, setSampleRate] = useState(44100);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [allTracks, setAllMediaFiles] = useState<string[]>([]);
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);

  // Project settings modal
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showToolSettings, setShowToolSettings] = useState(false);
  // Edit/delete triggered from the palette right-click context menu (outside the settings modal).
  const [panelEditingToolIndex, setPanelEditingToolIndex] = useState<number | null>(null);
  const [panelDeletingToolIndex, setPanelDeletingToolIndex] = useState<number | null>(null);

  // Derived from project prop
  const annotationDirectory = project.annotationDirectoryAbs ?? null;
  // Queue / shuffle
  const [shuffleMode, setShuffleMode] = useState(false);
  const [shuffledFiles, setShuffledFiles] = useState<string[]>([]);

  // Undo/redo history for annotations
  const annotationsHistoryRef = useRef<Annotation[][]>([[]]);
  const historyIndexRef = useRef<number>(0);

  // Chunk cache ref — not state, to avoid re-renders on every chunk load
  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  // Volume: 0 to 4 (400% or +12dB approx)
  const [volume, setVolume] = useState(project.settings.uiSettings?.volume ?? DEFAULT_UI_SETTINGS.volume);
  const [muted, setMuted] = useState(false);

  // Pitch-preserving playback speed (0.25–4.0, persisted per-project).
  const [playbackSpeed, setPlaybackSpeed] = useState(project.settings.uiSettings?.playbackSpeed ?? DEFAULT_UI_SETTINGS.playbackSpeed);
  // Last non-1.0 speed picked by the user; restored by the gauge-icon toggle.
  const [lastDefinedSpeed, setLastDefinedSpeed] = useState(
    project.settings.uiSettings?.lastDefinedSpeed
      ?? (project.settings.uiSettings?.playbackSpeed && project.settings.uiSettings.playbackSpeed !== 1
            ? project.settings.uiSettings.playbackSpeed
            : DEFAULT_UI_SETTINGS.lastDefinedSpeed)
  );

  // Band-pass filter — two independent pieces of state, coordinated via the
  // activation stack (see useActivationStack).
  //   - `filterToolActive`: filter tool is readied for vertical drag. Pure
  //     drawing state; does NOT gate audio.
  //   - `bandPassFilter`:  the band itself, persisted on the project so cutoffs
  //     survive restart. Non-null = filter active; null = filter disabled.
  //     Slider dragged to 0 clears the band (disables); drawing a new band
  //     sets it (enables).
  //   - `filterStrength`: lets the strength slider work even before a band is
  //     drawn; mirrored into `bandPassFilter.strength` when a band exists.
  const [filterToolActive, setFilterToolActive] = useState(false);
  const [bandPassFilter, setBandPassFilter] = useState<BandPassFilter | null>(project.settings.bandPassFilter ?? null);
  const [filterStrength, setFilterStrength] = useState(project.settings.bandPassFilter?.strength ?? 0.5);
  // Last active band saved so F can restore it after toggling off.
  const lastBandPassFilterRef = useRef<BandPassFilter | null>(null);

  // Layer activation stack — single source of truth for Esc unwinding order
  // and cursor-mode selection. See hooks/useActivationStack.ts.
  const activationStack = useActivationStack();

  // Annotation State
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [annotationTools, setAnnotationTools] = useState<AnnotationTool[]>(DEFAULT_ANNOTATION_TOOLS);
  // Mirror of annotationTools for use inside the annotation-load effect without
  // making it depend on (and re-run on) tool changes — re-running it would
  // re-read the on-disk file before the debounced autosave has written renames,
  // clobbering them. See the sync effect below.
  const annotationToolsRef = useRef(annotationTools);
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

  // Ref that stays in sync with project prop — avoids stale-closure bugs in persist effects
  const projectRef = useRef<Project>(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  // Ref to Spectrogram imperative handle (prev/next annotation navigation)
  const spectrogramRef = useRef<SpectrogramHandle>(null);

  const engineRef = useRef<AudioEngine | null>(null);
  // Alternate transport for Fast / Mixed-without-selection: the <video> element
  // plays its own audio. Exactly one of these two engines is "active" at a time
  // (see activeTransport); the orchestrator drives them through one interface.
  const videoEngineRef = useRef<VideoElementEngine | null>(null);
  // Ref so the onEnded closure (created once on mount) can read current isAudioTrack
  const isAudioTrackRef = useRef(false);
  // Ref so the onEnded closure (created once on mount) can read the latest seek function
  const seekRef = useRef<typeof seek | null>(null);

  // Create engine on mount, destroy on unmount
  useEffect(() => {
    // Kick a video prefetch chunk starting at prevBufferedTo. Chains immediately
    // when the chunk finishes so decode pipelines ahead of the playhead even when
    // VideoToolbox takes longer than the chunk's playback duration (dense GOPs).
    const kickVideoPrefetch = (prevBufferedTo: number) => {
      const src = frameSourceRef.current;
      if (!src || videoPrefetchBusyRef.current) return;
      const t = currentTimeRef.current;
      // Always start from the buffer edge, not max(edge, t). Starting from t
      // when t > prevBufferedTo causes ensureRange to overlap the just-completed
      // chunk, forcing a re-decode of already-cached frames through VideoToolbox.
      // The allCached fast-path in ensureRange handles the case where frames
      // at prevBufferedTo are already in cache.
      const chunkStart = prevBufferedTo;
      const dur = durationRef.current || chunkStart + 5;
      const chunkEnd = Math.min(chunkStart + 5, dur);
      if (chunkStart >= chunkEnd) return;
      videoPrefetchBusyRef.current = true;
      videoPrefetchEndRef.current = chunkEnd;
      src.ensureRange(chunkStart, chunkEnd, 'rollingPrefetch')
        .catch(() => { videoPrefetchEndRef.current = prevBufferedTo; })
        .finally(() => {
          videoPrefetchBusyRef.current = false;
          // Chain immediately: don't wait for the next onTimeUpdate tick.
          // If the decode took longer than playback, the playhead may already
          // be close to the new buffer edge — kick the next chunk now.
          const buf = videoPrefetchEndRef.current;
          if (currentTimeRef.current + 6 >= buf) kickVideoPrefetch(buf);
        });
    };

    // Shared playback callbacks — both transports (AudioEngine and
    // VideoElementEngine) report through these so play/pause/EOF behave
    // identically regardless of which one is active.
    const setPlayhead = (t: number) => {
      currentTimeRef.current = t;
      currentTimeStoreRef.current.set(t);
    };
    const onPlaying = () => { setIsPlaying(true); setIsBuffering(false); };
    const onPaused = () => setIsPlaying(false);
    const onEnded = () => {
      // Return playhead to selection start. Do NOT auto-scroll — when playing
      // within a selection the user positioned the canvas intentionally; jumping
      // it on every loop is disorienting.
      const sel = selectionRef.current;
      if (sel) seekRef.current?.(sel.start, false);
      setIsPlaying(false);
    };

    engineRef.current = new AudioEngine({
      onTimeUpdate: (t) => {
        setPlayhead(t);
        // Rolling video prefetch: keep frames decoded 5 s ahead of the playhead.
        // Only run when the canvas path is the live renderer; in `mixed` without
        // a selection (showing the <video> fallback) and in `fast`/`off`, this
        // would just waste decode CPU on hardware that already can't keep up.
        // Refs read current values inside this once-mounted closure.
        const mode = videoModeRef.current;
        const canvasLive =
          mode === 'accurate' || (mode === 'mixed' && selectionRef.current !== null);
        if (canvasLive && !videoPrefetchBusyRef.current) {
          const bufferedTo = videoPrefetchEndRef.current;
          if (t + 6 >= bufferedTo) kickVideoPrefetch(bufferedTo);
        }
      },
      onPlaying,
      onPaused,
      onEnded,
      onBufferUnderrun: () => setIsBuffering(true),
      onDebugLog: (msg, type = 'info') => addLog(msg, type),
    });

    // The <video>-element transport. No prefetch (the element decodes itself);
    // no buffer-underrun signal (the browser handles its own buffering).
    videoEngineRef.current = new VideoElementEngine({
      onTimeUpdate: setPlayhead,
      onPlaying,
      onPaused,
      onEnded,
    });

    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      videoEngineRef.current?.dispose();
      videoEngineRef.current = null;
    };
  }, []);

  // UI State
  // VideoFrameSource for frame-perfect playback on MP4/MOV video tracks.
  // When non-null, CanvasVideoPlayer drives the display; the <video> element
  // is not used. For audio tracks or non-ISOBMFF containers, this stays null
  // and we fall back to the legacy <video>-based path.
  const frameSourceRef = useRef<VideoFrameSource | null>(null);
  // Rolling prefetch state for the frame-source path. Tracks how far ahead
  // frames have been decoded so onTimeUpdate knows when to fetch the next chunk.
  const videoPrefetchEndRef = useRef(0);
  const videoPrefetchBusyRef = useRef(false);
  // Trigger re-render of the video pane when frameSource is created/torn down.
  // We don't put the VideoFrameSource itself in state because it owns mutable
  // GPU resources; a simple version counter is enough to switch components.
  const [frameSourceVersion, setFrameSourceVersion] = useState(0);
  // Monotonic token invalidated whenever user interrupts playback. Async
  // preroll awaits check this so stale resolutions don't start the engine
  // after the user has pressed pause or triggered a new play.
  const playTokenRef = useRef(0);
  const [splitRatio, setSplitRatio] = useState(project.settings.uiSettings?.splitRatio ?? DEFAULT_UI_SETTINGS.splitRatio);
  const [leftPanelRatio, setLeftPanelRatio] = useState(project.settings.uiSettings?.leftPanelRatio ?? DEFAULT_UI_SETTINGS.leftPanelRatio);
  const [leftPanelWidth, setLeftPanelWidth] = useState(project.settings.uiSettings?.leftPanelWidth ?? DEFAULT_UI_SETTINGS.leftPanelWidth);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<'guide' | 'annotations' | 'shortcuts'>('guide');
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);

  const [zoomSec, setZoomSec] = useState(project.settings.uiSettings?.zoomSec ?? DEFAULT_UI_SETTINGS.zoomSec);

  // Video-rendering mode (off / fast / mixed / accurate). Drives which player
  // VideoPane mounts and whether handleOpenTrack opens / warms a frame source.
  // Refs let async closures (engine onTimeUpdate, selection commit) read the
  // current mode without being recreated on every render.
  const [videoMode, setVideoMode] = useState<VideoMode>(
    migrateVideoMode(project.settings.uiSettings?.videoMode),
  );
  const videoModeRef = useRef(videoMode);
  useEffect(() => { videoModeRef.current = videoMode; }, [videoMode]);

  // Mirror of videoSrc for the synchronous transport predicate below.
  const videoSrcRef = useRef<string | null>(null);
  useEffect(() => { videoSrcRef.current = videoSrc; }, [videoSrc]);

  // buzzdetect activations panel — all UI fields persisted in uiSettings.
  const [buzzdetectEnabled, setBuzzdetectEnabled] = useState(project.settings.uiSettings?.buzzdetectEnabled ?? false);
  const [buzzdetectThresholds, setBuzzdetectThresholds] = useState<Record<string, number>>(project.settings.uiSettings?.buzzdetectThresholds ?? {});
  const [buzzdetectHiddenNeurons, setBuzzdetectHiddenNeurons] = useState<string[]>(project.settings.uiSettings?.buzzdetectHiddenNeurons ?? []);
  const [buzzdetectPanelHeight, setBuzzdetectPanelHeight] = useState(project.settings.uiSettings?.buzzdetectPanelHeight ?? DEFAULT_BUZZDETECT_PANEL_HEIGHT);
  const [buzzdetectData, setBuzzdetectData] = useState<BuzzdetectData | null>(null);
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
      ...project.settings.spectrogramSettings,
  });
  // Draft strings for the display-range inputs — let the user type freely;
  // only parse and validate when they blur or press Enter.
  const [displayFloorDraft, setDisplayFloorDraft] = useState(String(project.settings.spectrogramSettings?.displayFloor ?? DEFAULT_SPECTROGRAM_SETTINGS.displayFloor));
  const [displayCeilDraft, setDisplayCeilDraft] = useState(String(project.settings.spectrogramSettings?.displayCeil ?? DEFAULT_SPECTROGRAM_SETTINGS.displayCeil));

  // Set of audio file paths that have an annotation file
  const [annotatedTracks, setAnnotatedFiles] = useState<Set<string>>(new Set());

  // Memoized so children whose effects depend on it (e.g. CanvasVideoPlayer's
  // rAF loop) don't tear down on every parent re-render.
  const addLog = useCallback((msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  }, []);

  // Keep selectionRef in sync with state (for use in rAF loop without stale closure)
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  // Keep annotationToolsRef in sync so the load effect can look up current tools
  // for color/toolKey matching without depending on annotationTools.
  useEffect(() => { annotationToolsRef.current = annotationTools; }, [annotationTools]);

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

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  const zoomSecRef = useRef(DEFAULT_ZOOM_SEC);
  useEffect(() => { zoomSecRef.current = zoomSec; }, [zoomSec]);

  const preZoomExtentRef = useRef<{ startTime: number; endTime: number } | null>(null);

  // Keep trackPathRef in sync so async callbacks can guard against stale closures
  const trackPathRef = useRef<string | null>(null);
  useEffect(() => {
    trackPathRef.current = trackPath;
    preZoomExtentRef.current = null;
  }, [trackPath]);

  const currentTimeRef = useRef(0);
  // Ref-based pub/sub for playback time. Updated ~50/sec by the engine's
  // onTimeUpdate; canvas consumers (spectrogram playhead, buzzdetect line,
  // toolbar readout) subscribe and redraw imperatively instead of re-rendering
  // the whole window tree. Set ONLY from the media clock — same place the old
  // currentTime state was set — so the playhead stays sample-locked to playback.
  const currentTimeStoreRef = useRef(createCurrentTimeStore());

  // Keep isAudioTrackRef in sync so the onEnded closure (created once on mount) reads the current value
  useEffect(() => { isAudioTrackRef.current = isAudioTrack; }, [isAudioTrack]);

  // Pre-roll the frame-source cache so the first frame at startSec is decoded
  // before the audio engine begins emitting samples. Critical for short-selection
  // replays: without this the engine starts audio ~200ms ahead of the first
  // rendered frame, so a ~1s selection ends before most frames appear.
  const prerollVideo = useCallback(async (startSec: number, endSec?: number): Promise<void> => {
    const source = frameSourceRef.current;
    if (!source) return;
    const end = endSec ?? Math.min(startSec + 5, durationRef.current || startSec + 5);
    const t0 = performance.now();
    addLog(`[preroll] start ${startSec.toFixed(3)}-${end.toFixed(3)}s`);
    try { await source.ensureRange(startSec, end, 'prerollVideo'); } catch { /* canvas shows stale frame on error */ }
    addLog(`[preroll] done in ${(performance.now() - t0).toFixed(0)}ms`);
    videoPrefetchEndRef.current = end;
  }, [addLog]);

  // Open a track by absolute path (called from button or file panel)
  const handleOpenTrack = useCallback(async (absolutePath: string) => {
    // Guard: never attempt to open a file whose extension we can't decode.
    // Both the tree and nav paths already filter these out; this is a belt-and-suspenders
    // check so a stray caller can't put us into a half-loaded state.
    if (!isSupportedMediaFile(absolutePath)) {
      addLog(`Skipped unsupported file: ${absolutePath.split('/').pop() ?? absolutePath}`, 'error');
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

    const fileName = absolutePath.split('/').pop() ?? absolutePath;
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

  // Tear down frame source on unmount — VideoFrame handles hold GPU memory.
  useEffect(() => () => {
    if (frameSourceRef.current) {
      frameSourceRef.current.close();
      frameSourceRef.current = null;
    }
  }, []);

  // React to videoMode changes for the currently-loaded track. Toggling
  // off/fast ↔ mixed/accurate without this would leave a stale frame source open
  // (memory + decoder) or, conversely, leave the canvas dark with no decoder.
  // The track itself doesn't need to be reloaded — only the frame source.
  useEffect(() => {
    if (!trackPath || isAudioTrack) return;
    const wantsFrameSource =
      (videoMode === 'accurate' || videoMode === 'mixed') && canUseFrameSource(trackPath);
    const has = !!frameSourceRef.current;

    if (wantsFrameSource && !has) {
      const url = toAssetUrl(trackPath);
      const expectedTrack = trackPath;
      (async () => {
        try {
          const source = new VideoFrameSource({ onDebugLog: addLog });
          await source.open(url);
          if (trackPathRef.current !== expectedTrack) { source.close(); return; }
          frameSourceRef.current = source;
          setFrameSourceVersion(v => v + 1);
          if (videoMode === 'accurate') {
            const dur = durationRef.current;
            source.ensureRange(0, Math.min(5, dur || 5), 'modeChangeWarm').catch(() => {});
          } else if (videoMode === 'mixed' && selectionRef.current) {
            // Mode switched on with an existing selection — warm it now.
            const sel = selectionRef.current;
            source.ensureRange(sel.start, sel.end, 'modeChangeWarmSel').catch(() => {});
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLog(`[video] frame source unavailable: ${msg}`, 'error');
        }
      })();
    } else if (!wantsFrameSource && has) {
      frameSourceRef.current?.close();
      frameSourceRef.current = null;
      setFrameSourceVersion(v => v + 1);
      videoPrefetchEndRef.current = 0;
      videoPrefetchBusyRef.current = false;
    }
  }, [videoMode, trackPath, isAudioTrack, addLog]);

  // Whether the <video> element — not the AudioEngine — is the active transport:
  // a video file shown through the element (Fast, or Mixed before a selection).
  // Audio-only files and the canvas-backed modes always use the AudioEngine.
  const usesVideoTransport = useCallback((): boolean => {
    if (isAudioTrackRef.current || !videoSrcRef.current) return false;
    const mode = videoModeRef.current;
    return mode === 'fast' || (mode === 'mixed' && selectionRef.current === null);
  }, []);

  // The active transport. AudioEngine and VideoElementEngine expose the same
  // play/pause/seek/getMediaTime/setGain/setPlaybackSpeed/isPlaying surface, so
  // callers never branch on which one is live.
  const activeTransport = useCallback(
    (): PlaybackTransport | null => (usesVideoTransport() ? videoEngineRef.current : engineRef.current),
    [usesVideoTransport],
  );

  // Stable callback passed to CanvasVideoPlayer's rAF loop. Reading from the
  // engine directly (rather than the currentTime state) avoids a frame of
  // lag: React commits on rAF, so currentTime is always one tick behind.
  const getMediaTime = useCallback((): number => {
    return activeTransport()?.getMediaTime() ?? 0;
  }, [activeTransport]);

  // Stable: bind the <video> element to its transport. Must not change identity
  // per-render, or VideoPlayer's exposure effect churns and detaches mid-play.
  const attachVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoEngineRef.current?.attach(el);
  }, []);

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
    const filter = project?.settings.fileFilter ?? 'all';
    if (filter === 'annotated') return base.filter(f => annotatedTracks.has(f));
    if (filter === 'unannotated') return base.filter(f => !annotatedTracks.has(f));
    return base;
  }, [shuffleMode, shuffledFiles, allTracks, project?.settings.fileFilter, annotatedTracks]);

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
  const toggleShuffle = useCallback(() => {
    setShuffleMode(prev => {
      const next = !prev;
      if (next) {
        const shuffled = shuffleArray(allTracks);
        // Pin the currently open file at the front of the queue
        const cur = trackPathRef.current;
        if (cur) {
          const idx = shuffled.indexOf(cur);
          if (idx > 0) { shuffled.splice(idx, 1); shuffled.unshift(cur); }
        }
        setShuffledFiles(shuffled);
      }
      if (projectRef.current) {
        updateProjectSettings(projectRef.current.id, { ...projectRef.current.settings, shuffleMode: next });
      }
      return next;
    });
  }, [allTracks, updateProjectSettings]);

  // Ident: relative path from audio root to track, without extension
  const ident = useMemo(() => {
    if (!trackPath || !currentDirectory) return null;
    const rel = trackPath.substring(currentDirectory.length + 1);
    return stripExt(rel);
  }, [trackPath, currentDirectory]);

  // Load buzzdetect activations for the current track, located by ident under
  // the configured buzzdetect directory. `cancelled` guards against the track
  // changing while the read is in flight.
  useEffect(() => {
    const dir = project.buzzdetectDirectoryAbs;
    if (!dir || !ident) { setBuzzdetectData(null); return; }
    let cancelled = false;
    setBuzzdetectData(null);
    readBuzzdetect(dir, ident)
      .then(d => { if (!cancelled) setBuzzdetectData(d); })
      .catch(err => { if (!cancelled) { setBuzzdetectData(null); addLog(`buzzdetect load error: ${err}`, 'error'); } });
    return () => { cancelled = true; };
  }, [ident, project.buzzdetectDirectoryAbs]);

  // Annotation history helpers
  const pushAnnotationsToHistory = useCallback((newAnnotations: Annotation[]) => {
    annotationsHistoryRef.current = annotationsHistoryRef.current.slice(0, historyIndexRef.current + 1);
    annotationsHistoryRef.current.push(newAnnotations);
    historyIndexRef.current = annotationsHistoryRef.current.length - 1;
  }, []);

  // Final update — pushes to history (called on mouse release, delete, etc.)
  const handleAnnotationsCommit = useCallback((newAnnotations: Annotation[]) => {
    setAnnotations(newAnnotations);
    pushAnnotationsToHistory(newAnnotations);
  }, [pushAnnotationsToHistory]);

  const undoAnnotations = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    setAnnotations(annotationsHistoryRef.current[historyIndexRef.current]);
  }, []);

  const redoAnnotations = useCallback(() => {
    if (historyIndexRef.current >= annotationsHistoryRef.current.length - 1) return;
    historyIndexRef.current++;
    setAnnotations(annotationsHistoryRef.current[historyIndexRef.current]);
  }, []);

  // Persist annotation tools and spectrogram settings to project whenever they change
  const toolPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Skip persistence when switching projects (avoids overwriting with stale tools)
    if (prevProjectIdRef.current !== project.id) {
      prevProjectIdRef.current = project.id;
      return;
    }
    if (toolPersistRef.current) clearTimeout(toolPersistRef.current);
    toolPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      updateProjectSettings(projectRef.current.id, { ...projectRef.current.settings, annotationTools });
    }, 500);
    return () => {
      if (toolPersistRef.current) clearTimeout(toolPersistRef.current);
    };
  }, [annotationTools]);

  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    settingsPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      updateProjectSettings(projectRef.current.id, { ...projectRef.current.settings, spectrogramSettings: settings });
    }, 800);
    return () => {
      if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    };
  }, [settings]);

  // Consolidated UI persistence — every persisted UI field flows through this
  // single debounced effect, so the project file only gets one write per
  // settling burst regardless of which slider/handle moved.
  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (uiPersistRef.current) clearTimeout(uiPersistRef.current);
    uiPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      // Store the active track relative to the media directory so the saved
      // value survives the user moving or renaming the project root.
      const cur = trackPathRef.current;
      const audioRoot = projectRef.current.mediaDirectoryAbs;
      const activeTrackPath = cur && audioRoot && cur.startsWith(audioRoot + '/')
        ? cur.substring(audioRoot.length + 1)
        : null;
      const uiSettings: ProjectUiSettings = {
        leftPanelWidth,
        splitRatio,
        leftPanelRatio,
        volume,
        playbackSpeed,
        lastDefinedSpeed,
        zoomSec,
        activeTrackPath,
        buzzdetectEnabled,
        buzzdetectThresholds,
        buzzdetectHiddenNeurons,
        buzzdetectPanelHeight,
        videoMode,
      };
      updateProjectSettings(projectRef.current.id, { ...projectRef.current.settings, uiSettings });
    }, 600);
    return () => {
      if (uiPersistRef.current) clearTimeout(uiPersistRef.current);
    };
  }, [leftPanelWidth, splitRatio, leftPanelRatio, volume, playbackSpeed, lastDefinedSpeed, zoomSec, trackPath, buzzdetectEnabled, buzzdetectThresholds, buzzdetectHiddenNeurons, buzzdetectPanelHeight, videoMode]);

  // Compute annotation file path: mirrors audio dir structure into annotation dir
  const getAnnotationPath = useCallback((trackFilePath: string): string | null => {
    if (!annotationDirectory || !currentDirectory) return null;
    const rel = trackFilePath.substring(currentDirectory.length);
    const withoutExt = stripExt(rel);
    return annotationDirectory + withoutExt + '.txt';
  }, [annotationDirectory, currentDirectory]);

  // Auto-save annotations whenever they change
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutoSaveRef = useRef(false);
  useEffect(() => {
    if (!trackPath || !annotationDirectory) return;
    const annotPath = getAnnotationPath(trackPath);
    if (!annotPath) return;
    // Snapshot the identity at effect time so the async callback can verify
    // it's still relevant after the debounce delay.
    const savedTrackPath = trackPath;
    const savedAnnotPath = annotPath;

    // Debounce saves by 300ms
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (skipAutoSaveRef.current) return;
      // Guard: bail if the track changed while we were waiting.
      if (savedTrackPath !== trackPathRef.current) return;
      try {
        if (annotations.length === 0) {
          await removeFile(savedAnnotPath);
          setAnnotatedFiles(prev => {
            const next = new Set(prev);
            next.delete(savedTrackPath);
            return next;
          });
          return;
        }
        const decimals = projectRef.current?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
        const content = generateAudacityContent(annotations, decimals);
        await writeTextFile(savedAnnotPath, content);
        setAnnotatedFiles(prev => {
            const next = new Set(prev);
            next.add(savedTrackPath);
            return next;
          });
      } catch (err) {
        addLog(`Auto-save error: ${err}`, 'error');
      }
    }, 300);

    return () => {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    };
  }, [annotations, trackPath, annotationDirectory, getAnnotationPath]);

  // Auto-load annotations when the current track or annotation directory changes
  useEffect(() => {
    if (!trackPath || !annotationDirectory || !currentDirectory) return;
    const annotPath = getAnnotationPath(trackPath);
    if (!annotPath) return;
    // Snapshot identity at effect-schedule time so async resolution can verify
    // the track hasn't changed while we were awaiting I/O.
    const expectedTrackPath = trackPath;

    (async () => {
      try {
        const content = await readTextFile(annotPath);
        // Drop result if the user switched tracks while we were reading.
        if (trackPathRef.current !== expectedTrackPath) return;
        if (!content) return;

        const loaded: Annotation[] = [];

        // Audacity .txt
        const lines = content.trim().split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const start = parseFloat(parts[0]);
            const end = parseFloat(parts[1]);
            const text = parts.slice(2).join('\t');
            if (!isNaN(start) && !isNaN(end)) {
              const matchedTool = annotationToolsRef.current.find(t => t.text === text);
              loaded.push({ id: Math.random().toString(36).substring(2, 9), toolKey: matchedTool?.key ?? '0', start, end, text, color: matchedTool?.color ?? '#ffffff' });
            }
          }
        }

        if (loaded.length > 0) {
          skipAutoSaveRef.current = true;
          setAnnotations(loaded);
          annotationsHistoryRef.current = [loaded];
          historyIndexRef.current = 0;
          addLog(`Loaded ${loaded.length} annotations`);
          setTimeout(() => { skipAutoSaveRef.current = false; }, 500);
        }
      } catch (err) {
        addLog(`Error loading annotations: ${err}`, 'error');
      }
    })();
  }, [trackPath, annotationDirectory, currentDirectory]);

  // Initialize state from project prop on mount
  useEffect(() => {
    setAnnotationTools(project.settings.annotationTools.length > 0 ? project.settings.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    const sg = { ...DEFAULT_SPECTROGRAM_SETTINGS, ...project.settings.spectrogramSettings };
    setSettings(sg);
    setDisplayFloorDraft(String(sg.displayFloor));
    setDisplayCeilDraft(String(sg.displayCeil));
    setShuffleMode(project.settings.shuffleMode ?? false);
    const ui = { ...DEFAULT_UI_SETTINGS, ...project.settings.uiSettings };
    setSplitRatio(ui.splitRatio);
    setLeftPanelRatio(ui.leftPanelRatio);
    setLeftPanelWidth(ui.leftPanelWidth);
    setVolume(ui.volume);
    setPlaybackSpeed(ui.playbackSpeed);
    setLastDefinedSpeed(
      project.settings.uiSettings?.lastDefinedSpeed
        ?? (ui.playbackSpeed !== 1 ? ui.playbackSpeed : DEFAULT_UI_SETTINGS.lastDefinedSpeed)
    );
    setZoomSec(ui.zoomSec);
    setVideoMode(migrateVideoMode(ui.videoMode));
    setBuzzdetectEnabled(project.settings.uiSettings?.buzzdetectEnabled ?? false);
    setBuzzdetectThresholds(project.settings.uiSettings?.buzzdetectThresholds ?? {});
    setBuzzdetectHiddenNeurons(project.settings.uiSettings?.buzzdetectHiddenNeurons ?? []);
    setBuzzdetectPanelHeight(project.settings.uiSettings?.buzzdetectPanelHeight ?? DEFAULT_BUZZDETECT_PANEL_HEIGHT);
    setBuzzdetectData(null);
    setFilterToolActive(false);
    setBandPassFilter(project.settings.bandPassFilter ?? null);
    setFilterStrength(project.settings.bandPassFilter?.strength ?? 0.5);
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
        if (project.settings.shuffleMode && files.length > 0) {
          const shuffled = shuffleArray(files);
          setShuffledFiles(shuffled);
          firstFile = shuffled[0];
        }
        // Prefer the project's saved active track (resolved relative to the
        // current audio root, so it survives the project root being renamed
        // or moved). Falls through to the first file if the saved track no
        // longer exists.
        const savedRel = project.settings.uiSettings?.activeTrackPath;
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

  const handleProjectSettingsSaved = useCallback(async (updatedSettings: ProjectSettings) => {
    const prev = project.settings.mediaDirectory;
    const next = updatedSettings.mediaDirectory;
    const mediaDirChanged = prev.kind !== next.kind || prev.path !== next.path;
    const updated = await updateProjectSettings(project.id, updatedSettings);
    if (!updated) {
      setShowProjectSettings(false);
      return;
    }
    setAnnotationTools(updated.settings.annotationTools.length > 0 ? updated.settings.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    setVideoMode(migrateVideoMode(updated.settings.uiSettings?.videoMode));
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
  }, [project, updateProjectSettings, handleOpenTrack]);

  const handleToggleFileFilter = useCallback(() => {
    const current = project.settings.fileFilter ?? 'all';
    const next = ({ all: 'unannotated', unannotated: 'annotated', annotated: 'all' } as const)[current];
    updateProjectSettings(project.id, { ...project.settings, fileFilter: next });
  }, [project, updateProjectSettings]);

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

  const togglePlay = useCallback(async () => {
      const transport = activeTransport();
      if (isPlaying || isBuffering) {
          // Invalidate any in-flight preroll so its resolution can't start playback
          playTokenRef.current += 1;
          transport?.pause();
          setIsPlaying(false);
          setIsBuffering(false);
          return;
      }
      const sel = selectionRef.current;
      const curTime = currentTimeRef.current;
      let startSec = curTime;
      // If there's a selection and the playhead is outside it, restart from selection start
      if (sel && (curTime >= sel.end - 0.05 || curTime < sel.start)) {
          startSec = sel.start;
          seek(sel.start, true);
      } else if (!sel && duration > 0 && curTime >= duration - 0.05) {
          // At end of track with no selection — return to beginning
          startSec = 0;
          seek(0, true);
      }
      setIsBuffering(true);
      const token = ++playTokenRef.current;
      addLog(`[togglePlay] playToken=${token} startSec=${startSec.toFixed(3)} sel=${sel ? `${sel.start.toFixed(3)}-${sel.end.toFixed(3)}` : 'none'} isAudioTrack=${isAudioTrack}`);
      // Canvas path only: pre-roll so the first frame at startSec is decoded
      // BEFORE the engine schedules audio (short selections could otherwise end
      // before any frame renders). The <video>-element transport decodes itself,
      // and audio-only tracks have no frames, so both skip the wait.
      if (frameSourceRef.current && !usesVideoTransport()) {
          await prerollVideo(startSec, sel?.end);
          if (token !== playTokenRef.current) return; // user interrupted
      }
      // isPlaying is set to true only when onPlaying fires. endSec enables the
      // bounded selection stop on whichever transport is active.
      transport?.play(startSec, sel ? sel.end : undefined);
  }, [isPlaying, isBuffering, isAudioTrack, duration, prerollVideo, addLog, activeTransport, usesVideoTransport]);

  const seek = useCallback(async (time: number, scrollView = false) => {
      const transport = activeTransport();
      const wasPlaying = transport?.isPlaying ?? false;
      // AudioEngine.seek() cancels its scheduled audio (we restart below if it
      // was playing); VideoElementEngine.seek() just moves currentTime and keeps
      // the element playing — so the element needs no restart.
      const prevTime = currentTimeRef.current;
      transport?.seek(time);
      currentTimeRef.current = time;
      currentTimeStoreRef.current.set(time);
      // Notify the frame source so its eviction window follows the scrub position.
      // Kick a small ensureRange while paused so a scrub shows the correct frame
      // (rather than a stale one from the prior window). On the canvas path,
      // freeze the canvas at the pre-seek frame synchronously — this prevents
      // the GOP decode animation from being visible before the React overlay
      // renders (which is async and can lag several rAF ticks behind).
      if (!isAudioTrack && frameSourceRef.current) {
          frameSourceRef.current.notifyPlayhead(time);
          if (!wasPlaying && !usesVideoTransport()) {
              frameSourceRef.current.freezeDisplayAt(prevTime);
              setIsBuffering(true);
              const token = ++playTokenRef.current;
              frameSourceRef.current.ensureRange(time, Math.min(time + 0.5, durationRef.current || time + 0.5), 'seekScrub')
                .then(() => {
                    if (token === playTokenRef.current) {
                        frameSourceRef.current?.clearDisplayFreeze();
                        setIsBuffering(false);
                    }
                })
                .catch(() => {
                    if (token === playTokenRef.current) {
                        frameSourceRef.current?.clearDisplayFreeze();
                        setIsBuffering(false);
                    }
                });
          } else if (!wasPlaying) {
              frameSourceRef.current.ensureRange(time, Math.min(time + 0.5, durationRef.current || time + 0.5), 'seekScrub')
                .catch(() => {});
          }
      }
      if (scrollView) spectrogramRef.current?.scrollToTime(time);
      // Restart the AudioEngine from the new position if it was playing. The
      // <video>-element transport plays straight through a currentTime write, so
      // it's excluded here.
      if (wasPlaying && !usesVideoTransport()) {
          if (time < durationRef.current) {
              const sel = selectionRef.current;
              setIsBuffering(true);
              const token = ++playTokenRef.current;
              if (frameSourceRef.current) {
                  await prerollVideo(time, sel?.end);
                  if (token !== playTokenRef.current) return;
              }
              engineRef.current?.play(time, sel ? sel.end : undefined);
          } else {
              // Seeked to/past end — stop cleanly rather than hanging
              setIsPlaying(false);
          }
      }
  }, [isAudioTrack, prerollVideo, activeTransport, usesVideoTransport]);

  // Keep seekRef in sync with seek so the mount-time onEnded closure always calls the latest version
  useEffect(() => { seekRef.current = seek; }, [seek]);

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
          }
      } else if (activeToolKey === null && selection !== null) {
          const newAnnotation = makeAnnotationFromTool(tool, selection.start, selection.end);
          handleAnnotationsCommit([...annotations, newAnnotation]);
          setSelectedAnnotationId(newAnnotation.id);
          setBoundAnnotationId(newAnnotation.id);
          setActiveToolKey(key);
          activationStack.pushIfAbsent('annotationTool');
      } else {
          setActiveToolKey(prev => {
            if (prev === key) {
              activationStack.remove('annotationTool');
              return null;
            }
            activationStack.pushIfAbsent('annotationTool');
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
      { key: 'f', mods: ['shift'], handler: () => { if (videoMode !== 'fast') handleToggleFilterTool(); } },
      { key: 'f', handler: () => { if (videoMode !== 'fast') handleToggleFilterState(); } },
      { key: 'm', handler: () => setMuted(prev => !prev), preventDefault: false },
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
  ]);

  const performExport = async () => {
      if (annotations.length === 0) return;
      const decimals = project?.settings.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS;
      await exportToAudacity(annotations, trackName, trackPath, decimals);
      addLog('Exported annotations as TXT');
  };

  const handleCreateTool = useCallback((text: string, color: string, key?: string | null) => {
    setAnnotationTools(prev => [...prev, { key: key ?? null, text, color }]);
  }, []);

  // Atomically restore tools + annotations for the Annotation Tool Settings
  // modal's own undo/redo (e.g. undeleting a tool, which must also put back the
  // annotations that delete reassigned to Custom). Annotations go through the
  // shared commit path so the global annotation history stays consistent.
  const handleRestoreToolsState = useCallback((tools: AnnotationTool[], restoredAnnotations: Annotation[]) => {
    setAnnotationTools(tools);
    handleAnnotationsCommit(restoredAnnotations);
  }, [handleAnnotationsCommit]);

  const handleRenameTool = useCallback((toolIndex: number, newText: string, newColor: string, newDescription?: string) => {
    const tool = annotationTools[toolIndex];
    if (!tool) return;
    const oldText = tool.text;

    setAnnotationTools(prev => prev.map((t, i) => i === toolIndex ? { ...t, text: newText, color: newColor, description: newDescription } : t));
    setAnnotations(prev => prev.map(a => {
      if (a.toolKey === tool.key && a.toolKey !== '0') {
        return { ...a, text: newText, color: newColor };
      }
      if (a.toolKey === '0' && a.text === newText && tool.key !== null) {
        return { ...a, toolKey: tool.key!, color: newColor };
      }
      return a;
    }));

    // If only the color changed, no file text updates are needed.
    if (oldText === newText) return;

    // Rename matching annotations in every other track's annotation file on disk.
    // The current track's file will be updated by the auto-save triggered above.
    for (const t of allTracks) {
      if (t === trackPath) continue;
      const annotPath = getAnnotationPath(t);
      if (!annotPath) continue;
      (async () => {
        try {
          const content = await readTextFile(annotPath);
          if (!content) return;
          let changed = false;
          const updated = content.split('\n').map(line => {
            const parts = line.split('\t');
            if (parts.length >= 3 && parts.slice(2).join('\t') === oldText) {
              changed = true;
              return `${parts[0]}\t${parts[1]}\t${newText}`;
            }
            return line;
          });
          if (changed) await writeTextFile(annotPath, updated.join('\n'));
        } catch {
          // No annotation file for this track — nothing to update.
        }
      })();
    }
  }, [annotationTools, allTracks, trackPath, getAnnotationPath]);

  const handleDeleteTool = useCallback((toolIndex: number, mode: 'unlink' | 'delete') => {
    const tool = annotationTools[toolIndex];
    if (!tool) return;
    setAnnotations(prev => mode === 'delete'
      // Remove the tool's linked annotations entirely.
      ? prev.filter(a => a.toolKey !== tool.key)
      // Reassign the tool's linked annotations to Custom.
      : prev.map(a => a.toolKey === tool.key ? { ...a, toolKey: '0', color: '#ffffff' } : a)
    );
    setAnnotationTools(prev => prev.filter((_, i) => i !== toolIndex));
    if (activeToolKey === tool.key) setActiveToolKey(null);
  }, [annotationTools, activeToolKey]);

  // Transient live preview while the user drags a color in the edit modal.
  // Updates ONLY the tool's color and its linked (non-Custom) annotations'
  // colors via the raw setters — no history push, no Custom reassociation. The
  // settings list and spectrogram both read these from state, so they update
  // live; the real commit (with history) happens on Save via handleRenameTool.
  const handlePreviewToolColor = useCallback((toolIndex: number, color: string) => {
    const tool = annotationToolsRef.current[toolIndex];
    if (!tool) return;
    setAnnotationTools(prev => prev.map((t, i) => i === toolIndex ? { ...t, color } : t));
    setAnnotations(prev => prev.map(a =>
      a.toolKey === tool.key && a.toolKey !== '0' ? { ...a, color } : a
    ));
  }, []);

  const handleReorderTools = useCallback((newTools: AnnotationTool[]) => {
    const snapshot = annotationTools;
    if (newTools.length !== snapshot.length) return;

    // Build old→new key remap (by stable index — newTools must preserve indices).
    const keyRemap = new Map<string, string>();
    const unassignedKeys = new Set<string>();
    for (let i = 0; i < snapshot.length; i++) {
      const oldKey = snapshot[i].key;
      const newKey = newTools[i].key;
      if (oldKey && newKey && oldKey !== newKey) keyRemap.set(oldKey, newKey);
      if (oldKey && !newKey) unassignedKeys.add(oldKey);
    }

    setAnnotationTools(newTools);
    setAnnotations(prev => prev.map(a => {
      if (unassignedKeys.has(a.toolKey)) return { ...a, toolKey: '0', color: '#ffffff' };
      const remapped = keyRemap.get(a.toolKey);
      return remapped ? { ...a, toolKey: remapped } : a;
    }));
    if (activeToolKey && (unassignedKeys.has(activeToolKey) || keyRemap.has(activeToolKey))) {
      setActiveToolKey(unassignedKeys.has(activeToolKey) ? null : keyRemap.get(activeToolKey)!);
    }
  }, [annotationTools, activeToolKey]);

  // Shared window-drag scaffold: wires a mousemove listener and a one-shot
  // mouseup that tears both down. Each handler supplies only its delta math.
  const startDragSession = (onMove: (e: MouseEvent) => void) => {
      const move = (e: MouseEvent) => onMove(e);
      const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
  };

  const handleSplitDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = splitRatio;
      startDragSession((moveEvent) => {
          const delta = moveEvent.clientY - startY;
          const totalHeight = window.innerHeight - 64;
          const newRatio = Math.max(0.2, Math.min(0.8, startRatio + (delta / totalHeight)));
          setSplitRatio(newRatio);
      });
  };

  const handleLeftPanelDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = leftPanelRatio;
      startDragSession((moveEvent) => {
          const delta = moveEvent.clientY - startY;
          const totalHeight = window.innerHeight - 64;
          let newRatio = Math.max(0.15, Math.min(0.85, startRatio + (delta / totalHeight)));
          // Soft snap: shift up by one divider height (h-2 = 8px) so tops align visually
          const dividerOffset = 8 / totalHeight;
          if (Math.abs(newRatio - (splitRatio - dividerOffset)) < 0.025) newRatio = splitRatio - dividerOffset;
          setLeftPanelRatio(newRatio);
      });
  };

  const LEFT_PANEL_COLLAPSE_THRESHOLD = 120;
  const handleLeftPanelWidthDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = filePanelCollapsed ? 40 : leftPanelWidth;
      startDragSession((moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const newWidth = startWidth + delta;
          if (newWidth < LEFT_PANEL_COLLAPSE_THRESHOLD) {
              setFilePanelCollapsed(true);
          } else {
              setFilePanelCollapsed(false);
              setLeftPanelWidth(Math.max(LEFT_PANEL_COLLAPSE_THRESHOLD, Math.min(480, newWidth)));
          }
      });
  };

  // Keep both transports' gain in sync with the volume slider and mute button.
  // VideoElementEngine clamps to the element's 0–1 range (no boost above unity).
  useEffect(() => {
    const gain = muted ? 0 : volume;
    engineRef.current?.setGain(gain);
    videoEngineRef.current?.setGain(gain);
  }, [volume, muted]);

  // Sync playback speed to both transports. AudioEngine preserves pitch; the
  // <video> element does not (an accepted limitation of Fast mode).
  useEffect(() => {
    engineRef.current?.setPlaybackSpeed(playbackSpeed);
    videoEngineRef.current?.setPlaybackSpeed(playbackSpeed);
  }, [playbackSpeed]);

  // Switching the active transport mid-play (mode change, or committing/clearing
  // a selection in Mixed) would otherwise leave the previous one running. Stop
  // both cleanly whenever the active transport flips.
  const prevUsesVideoRef = useRef(false);
  useEffect(() => {
    const now = usesVideoTransport();
    if (now === prevUsesVideoRef.current) return;
    prevUsesVideoRef.current = now;
    playTokenRef.current += 1;
    engineRef.current?.pause();
    videoEngineRef.current?.pause();
    setIsPlaying(false);
    setIsBuffering(false);
  }, [videoMode, isAudioTrack, videoSrc, selection, usesVideoTransport]);

  // Keep filterStrength and bandPassFilter.strength in lockstep so the strength
  // slider reflects (and can edit) whichever is current. The slider is the
  // single source of truth — if a band exists, copy its strength back into the
  // shared state on creation/edit; the engine sync below picks up the result.
  useEffect(() => {
    if (bandPassFilter && bandPassFilter.strength !== filterStrength) {
      setBandPassFilter({ ...bandPassFilter, strength: filterStrength });
    }
  }, [filterStrength]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push the active band-pass filter into the engine. Non-null = apply;
  // null = bypass. Drawing a band sets it; slider to 0 or Esc clears it.
  useEffect(() => {
    engineRef.current?.setBandPassFilter(bandPassFilter);
  }, [bandPassFilter]);

  // Persist bandPassFilter changes to the project file (debounced).
  const filterPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (filterPersistRef.current) clearTimeout(filterPersistRef.current);
    filterPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      updateProjectSettings(projectRef.current.id, { ...projectRef.current.settings, bandPassFilter: bandPassFilter ?? null });
    }, 600);
    return () => {
      if (filterPersistRef.current) clearTimeout(filterPersistRef.current);
    };
  }, [bandPassFilter]);

  // `Shift+F` and the filter-tool tile: toggle filter-tool readiness ONLY. Audio
  // filtering is governed by bandPassFilter being non-null.
  const handleToggleFilterTool = useCallback(() => {
    setFilterToolActive(prev => {
      const next = !prev;
      if (next) activationStack.pushIfAbsent('filterTool');
      else activationStack.remove('filterTool');
      return next;
    });
  }, [activationStack]);

  // Canonical "engage filter" path. Every code path that turns the filter on
  // — F key, slider drag-up-from-0, spectrogram drag-draw — funnels through
  // here so the band state, slider value, activation stack, and visualization
  // gate stay in lockstep. Geometry: caller's band if given, else the last
  // band we remember, else the project default. Strength: caller's override
  // if given, else the band's own strength.
  const engageBandPassFilter = useCallback(
    (band?: BandPassFilter | null, strengthOverride?: number) => {
      const base = band ?? lastBandPassFilterRef.current ?? DEFAULT_BAND_PASS_FILTER;
      const next = { ...base, strength: strengthOverride ?? base.strength };
      lastBandPassFilterRef.current = next;
      setBandPassFilter(next);
      setFilterStrength(next.strength);
      activationStack.pushIfAbsent('filterBand');
    },
    [activationStack]
  );

  // `Shift+F` and the filter-tool tile: toggle filter-tool readiness ONLY. Audio
  // filtering is governed by bandPassFilter being non-null.
  // (Defined above; this comment kept for orientation — see handleToggleFilterTool.)

  // `F`: toggle filter state on/off. On-turn engages via the canonical path
  // (restores last band, or falls back to the default); off-turn snapshots
  // and clears. Mirrors the Z key pattern for video zoom.
  const handleToggleFilterState = useCallback(() => {
    if (bandPassFilter !== null) {
      lastBandPassFilterRef.current = bandPassFilter;
      setBandPassFilter(null);
      activationStack.remove('filterBand');
    } else {
      engageBandPassFilter();
    }
  }, [bandPassFilter, engageBandPassFilter, activationStack]);

  // Filter "off" path — snapshots the band to `lastBandPassFilterRef` so it can
  // be restored, clears the band (disabling filtering), and pulls `filterBand`
  // out of the stack. Called by slider-to-0, Esc-on-band, and explicit disable.
  const handleDisableBandPassFilter = useCallback(() => {
    setBandPassFilter(prev => {
      if (prev) lastBandPassFilterRef.current = prev;
      return null;
    });
    activationStack.remove('filterBand');
  }, [activationStack]);

  // Drag-up-from-0 path: slider/wheel re-enabled filtering while the band was
  // off. Engages at the user's chosen strength via the canonical path.
  const handleEnableBandPassFilter = useCallback((strength: number) => {
    engageBandPassFilter(undefined, strength);
  }, [engageBandPassFilter]);

  // Called by Spectrogram when a band-drag completes (new band drawn).
  const handleBandPassFilterDrawn = useCallback((f: BandPassFilter) => {
    engageBandPassFilter(f);
  }, [engageBandPassFilter]);

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

  // buzzdetect panel callbacks.
  const handleBuzzdetectThresholdChange = useCallback((neuron: string, value: number) => {
    setBuzzdetectThresholds(prev => ({ ...prev, [neuron]: value }));
  }, []);
  const handleBuzzdetectToggleNeuron = useCallback((neuron: string, wasEnabled: boolean) => {
    setBuzzdetectHiddenNeurons(prev => wasEnabled ? [...prev, neuron] : prev.filter(n => n !== neuron));
  }, []);

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
                data-tooltip="Back to projects"
            >
                <ArrowLeft size={18} />
            </button>
            <button
                onClick={() => setShowProjectSettings(true)}
                className="flex items-center space-x-2 px-2 py-1.5 rounded hover:bg-slate-700 transition-colors group"
                data-tooltip="Project Settings"
                data-help-target="project-settings-btn"
            >
                <h1 className="text-xl font-bold">
                    <GradientProjectName name={project.settings.name} nameGradientColors={project.settings.nameGradientColors} />
                </h1>
                <Settings size={15} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0" />
            </button>
        </div>

        <div />

        <div className="flex items-center space-x-3">
             <button
                onClick={() => setShowDebug(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                data-tooltip="Debug Console"
            >
                <Bug size={18} />
            </button>
             <button
                onClick={() => { setHelpTab('guide'); setShowHelp(prev => !prev); }}
                className={`p-2 rounded hover:bg-slate-700 transition-colors ${showHelp ? 'text-[#e65161] bg-slate-700' : 'text-slate-400 hover:text-white'}`}
                data-tooltip="Help Guide (F1)"
            >
                <HelpCircle size={18} />
            </button>
             <button
                onClick={() => { setHelpTab('shortcuts'); setShowHelp(true); }}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                data-tooltip="Keyboard Shortcuts"
            >
                <Keyboard size={18} />
            </button>
        </div>
      </header>

      <DebugConsole open={showDebug} onClose={() => setShowDebug(false)} logs={debugLogs} />

      <HelpPanel
        open={showHelp}
        tab={helpTab}
        onTabChange={setHelpTab}
        onClose={() => setShowHelp(false)}
      />

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
            fileFilter: (project?.settings.fileFilter ?? 'all') as 'all' | 'annotated' | 'unannotated',
            onToggleFileFilter: handleToggleFileFilter,
            onRevealInFinder: handleRevealInFinder,
            onRevealAnnotations: handleRevealAnnotations,
            onRevealAnnotationsRoot: annotationDirectory
              ? () => revealInFileManager(annotationDirectory).catch(() => {})
              : undefined,
            onRefresh: handleRefreshFiles,
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

        {/* Video Pane */}
        <div style={{ height: `${splitRatio * 100}%` }} className="bg-black relative flex" data-help-target="video-panel">
          <VideoPane
            frameSource={frameSourceRef.current}
            frameSourceVersion={frameSourceVersion}
            isAudioTrack={isAudioTrack}
            videoSrc={videoSrc}
            isProcessing={isProcessing}
            isBuffering={isBuffering}
            getMediaTime={getMediaTime}
            onDebugLog={addLog}
            onDurationChange={setDuration}
            videoMode={videoMode}
            hasSelection={selection !== null}
            onVideoModeChange={setVideoMode}
            onVideoElement={attachVideoElement}
          />
        </div>

        {/* Resizer Handle */}
        <div
            className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors z-10 flex justify-center items-center"
            onMouseDown={handleSplitDrag}
        >
            <div className="w-12 h-1 bg-slate-600 rounded-full" />
        </div>

        {/* Spectrogram Pane */}
        <div style={{ height: `${(1 - splitRatio) * 100}%` }} className="relative bg-slate-900 border-t border-slate-700 flex flex-col" data-help-target="spectrogram-canvas">

             {/* Settings Panel (Absolute, relative to spectrogram pane) */}
             {showSettings && (
                <div className="absolute top-10 right-4 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                    <div className="p-4 space-y-6">
                        {/* Level Range */}
                        <div className="space-y-2">
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">Level Range (dBFS)</h4>
                            {/* Dual-thumb slider — two range inputs share the same track.
                                Layering (bottom→top): base track → active-range fill → the two
                                inputs (both with transparent tracks so only their thumbs show on
                                top of the fill). */}
                            <div className="relative h-5 flex items-center">
                                {/* Base track */}
                                <div className="absolute w-full h-1 rounded bg-slate-600 pointer-events-none" />
                                {/* Active range: the selected dBFS band between the two thumbs.
                                    Range is [-160, 40] dBFS → span 200. */}
                                <div
                                    className="absolute h-1 rounded bg-[#e65161] pointer-events-none"
                                    style={{
                                        left: `${((settings.displayFloor + 160) / 200) * 100}%`,
                                        width: `${((settings.displayCeil - settings.displayFloor) / 200) * 100}%`,
                                    }}
                                />
                                <input
                                    type="range"
                                    min={-160} max={40}
                                    value={settings.displayFloor}
                                    onChange={(e) => {
                                        const v = Math.min(parseInt(e.target.value), settings.displayCeil - 1);
                                        setSettings(s => ({...s, displayFloor: v}));
                                        setDisplayFloorDraft(String(v));
                                    }}
                                    className="absolute w-full appearance-none h-1 rounded bg-transparent pointer-events-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#e65161] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:pointer-events-auto"
                                />
                                <input
                                    type="range"
                                    min={-160} max={40}
                                    value={settings.displayCeil}
                                    onChange={(e) => {
                                        const v = Math.max(parseInt(e.target.value), settings.displayFloor + 1);
                                        setSettings(s => ({...s, displayCeil: v}));
                                        setDisplayCeilDraft(String(v));
                                    }}
                                    className="absolute w-full appearance-none h-1 rounded bg-transparent pointer-events-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#e65161] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:pointer-events-auto"
                                />
                            </div>
                            <div className="flex justify-between">
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={displayFloorDraft}
                                    onChange={(e) => setDisplayFloorDraft(e.target.value)}
                                    onBlur={() => {
                                        const v = parseInt(displayFloorDraft);
                                        const clamped = isNaN(v) ? settings.displayFloor : Math.max(-160, Math.min(settings.displayCeil - 1, v));
                                        setSettings(s => ({...s, displayFloor: clamped}));
                                        setDisplayFloorDraft(String(clamped));
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-center focus:border-[#e65161] outline-none"
                                />
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={displayCeilDraft}
                                    onChange={(e) => setDisplayCeilDraft(e.target.value)}
                                    onBlur={() => {
                                        const v = parseInt(displayCeilDraft);
                                        const clamped = isNaN(v) ? settings.displayCeil : Math.max(settings.displayFloor + 1, Math.min(40, v));
                                        setSettings(s => ({...s, displayCeil: clamped}));
                                        setDisplayCeilDraft(String(clamped));
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                    className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-center focus:border-[#e65161] outline-none"
                                />
                            </div>
                        </div>

                        {/* Frequency */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">Frequency (Hz)</h4>
                            <div className="flex space-x-2 pt-2">
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Min</label>
                                    <input
                                        type="number"
                                        value={settings.minFreq}
                                        onChange={(e) => setSettings(s => ({...s, minFreq: Math.max(0, parseInt(e.target.value))}))}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Max</label>
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
                            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">FFT</h4>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">Window Size</label>
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
                                <label className="text-xs text-slate-400 mb-1 block">Scale</label>
                                <select
                                    value={settings.frequencyScale}
                                    onChange={(e) => setSettings(s => ({...s, frequencyScale: e.target.value as FrequencyScale}))}
                                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none text-white"
                                >
                                    <option value="linear">Linear</option>
                                    <option value="log">Logarithmic</option>
                                    <option value="mel">Mel</option>
                                </select>
                            </div>
                        </div>

                    </div>
                </div>
             )}

             <Toolbar
               isPlaying={isPlaying}
               isBuffering={isBuffering}
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
             />
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
                         <p className="text-lg font-medium">No Media Loaded</p>
                         <p className="text-sm">Open a video or audio file to begin annotating</p>
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
        />
      )}
      {panelEditingToolIndex !== null && (
        <AnnotationToolEditModal
          tool={annotationTools[panelEditingToolIndex]}
          toolIndex={panelEditingToolIndex}
          annotations={annotations}
          onClose={() => setPanelEditingToolIndex(null)}
          onPreviewColor={handlePreviewToolColor}
          onSave={(idx, text, color, description) => {
            handleRenameTool(idx, text, color, description);
            setPanelEditingToolIndex(null);
          }}
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
