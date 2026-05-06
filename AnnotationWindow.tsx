import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Settings, Keyboard, HelpCircle, Bug, ArrowLeft } from 'lucide-react';
import VideoPane from './components/VideoPane';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import GradientProjectName from './components/GradientProjectName';
import { HelpPanel } from './components/HelpPanel';
import { Annotation, SpectrogramSettings, AnnotationTool, FrequencyScale, Project, Selection } from './types';
import { DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_ANNOTATION_TOOLS, HOTKEY_COLORS, isSupportedMediaFile } from './constants';
import { exportToCSV, exportToAudacity, exportToJSON, generateAudacityContent, generateCSVContent, generateJSONContent, makeAnnotationFromTool } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, readTextFile, writeTextFile, removeFile, toAssetUrl } from './utils/tauriCommands';
import { useHotkeys } from './hooks/useHotkeys';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { revealInFileManager, listAnnotationFiles } from './utils/projectCommands';
import { AudioEngine } from './utils/AudioEngine';
import { VideoFrameSource, canUseFrameSource } from './utils/VideoFrameSource';
import TooltipLayer from './components/TooltipLayer';
import BrightnessContrastPad from './components/BrightnessContrastPad';
import DebugConsole from './components/DebugConsole';
import AnnotationToolsPanel from './components/AnnotationToolsPanel';
import AnnotationToolsSettingsModal from './components/AnnotationToolsSettingsModal';
import Toolbar from './components/Toolbar';

export interface AnnotationWindowProps {
  project: Project;
  onClose: () => void;
  updateProject: (p: Project) => Promise<void> | void;
  touchLastOpened: (id: string) => void;
}

export default function AnnotationWindow({ project, onClose, updateProject, touchLastOpened }: AnnotationWindowProps) {
  // Track State
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [trackName, setTrackName] = useState<string>("video");
  const [trackPath, setTrackPath] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [isAudioTrack, setIsAudioTrack] = useState(false);
  const [sampleRate, setSampleRate] = useState(44100);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [allTracks, setAllMediaFiles] = useState<string[]>([]);
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);

  // Project settings modal
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showToolSettings, setShowToolSettings] = useState(false);

  // Derived from project prop
  const annotationDirectory = project.annotationDirectory ?? null;
  const exportFormat = project.outputFormat ?? 'txt';

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
  const [volume, setVolume] = useState(project.uiSettings?.volume ?? 1);
  const [muted, setMuted] = useState(false);

  // Annotation State
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [annotationTools, setAnnotationTools] = useState<AnnotationTool[]>(DEFAULT_ANNOTATION_TOOLS);
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
      src.ensureRange(chunkStart, chunkEnd)
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

    engineRef.current = new AudioEngine({
      onTimeUpdate: (t) => {
        setCurrentTime(t);
        currentTimeRef.current = t;
        // Rolling video prefetch: keep frames decoded 5 s ahead of the playhead.
        // We use refs (stable objects) so this closure — captured once at mount —
        // always reads current values without being recreated on every render.
        if (!videoPrefetchBusyRef.current) {
          const bufferedTo = videoPrefetchEndRef.current;
          if (t + 6 >= bufferedTo) kickVideoPrefetch(bufferedTo);
        }
      },
      onPlaying: () => { setIsPlaying(true); setIsBuffering(false); },
      onPaused: () => setIsPlaying(false),
      onEnded: () => {
        // Return playhead to selection start. Do NOT auto-scroll — when playing
        // within a selection the user positioned the canvas intentionally; jumping
        // it on every loop is disorienting.
        const sel = selectionRef.current;
        if (sel) {
          seekRef.current?.(sel.start, false);
        }
        setIsPlaying(false);
      },
      onBufferUnderrun: () => setIsBuffering(true),
      onDebugLog: (msg, type = 'info') => addLog(msg, type),
    });
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
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
  const [splitRatio, setSplitRatio] = useState(project.uiSettings?.splitRatio ?? 0.5);
  const [leftPanelRatio, setLeftPanelRatio] = useState(project.uiSettings?.leftPanelRatio ?? 0.6);
  const [leftPanelWidth, setLeftPanelWidth] = useState(project.uiSettings?.leftPanelWidth ?? 224);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<'guide' | 'annotations' | 'shortcuts'>('guide');
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);

  const [zoomSec, setZoomSec] = useState(DEFAULT_ZOOM_SEC);
  const [settings, setSettings] = useState<SpectrogramSettings>({
      minFreq: 0,
      maxFreq: 22050,
      intensity: 1.6,
      contrast: 1.4,
      fftSize: 1024,
      frequencyScale: 'mel',
  });

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

  // Warm the frame-source cache whenever the selection region changes so
  // frames inside the range are decoded ahead of play. Cheap to call — if
  // the range is already cached, ensureRange returns without re-decoding.
  useEffect(() => {
    const source = frameSourceRef.current;
    if (!source || !selection) return;
    source.ensureRange(selection.start, selection.end).catch(() => {});
  }, [selection, frameSourceVersion]);

  // Pre-decode PCM for the selection so repeat plays are instant. AudioEngine
  // skips the call if the range is already covered by its cache.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !selection) return;
    engine.preloadRange(selection.start, selection.end).catch(() => {});
  }, [selection]);

  // Clear the reassign buffer whenever the bound annotation changes (released or switched to another)
  useEffect(() => { reassignBufferRef.current = {}; }, [boundAnnotationId]);

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  const zoomSecRef = useRef(DEFAULT_ZOOM_SEC);
  useEffect(() => { zoomSecRef.current = zoomSec; }, [zoomSec]);

  // Keep trackPathRef in sync so async callbacks can guard against stale closures
  const trackPathRef = useRef<string | null>(null);
  useEffect(() => { trackPathRef.current = trackPath; }, [trackPath]);

  const currentTimeRef = useRef(0);

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
    try { await source.ensureRange(startSec, end); } catch { /* canvas shows stale frame on error */ }
    // Always reset to the preroll end so the rolling prefetch restarts from
    // here after a seek. Math.max caused the pointer to stay at the old
    // far-ahead position after seeking backward, so kickVideoPrefetch never
    // triggered and video frames ran out seconds into playback.
    videoPrefetchEndRef.current = end;
  }, []);

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
    setBoundAnnotationId(null);
    setDebugLogs([]);
    setTrackPath(absolutePath);
    // Reset playhead to beginning of track
    setCurrentTime(0);
    // Reset undo/redo history for new track
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;

    const fileName = absolutePath.split('/').pop() ?? absolutePath;
    const audioExts = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma'];
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
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
        setSettings(s => ({ ...s, maxFreq: sr / 2 }));

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
        if (!isAudio && canUseFrameSource(absolutePath)) {
            try {
                const source = new VideoFrameSource({ onDebugLog: addLog });
                await source.open(assetUrl);
                frameSourceRef.current = source;
                setFrameSourceVersion(v => v + 1);
                // Warm the cache around t=0 so the first frame is ready to draw.
                source.ensureRange(0, Math.min(5, dur)).catch(() => {});
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

  // Stable callback passed to CanvasVideoPlayer's rAF loop. Reading from the
  // engine directly (rather than the currentTime state) avoids a frame of
  // lag: React commits on rAF, so currentTime is always one tick behind.
  const getMediaTime = useCallback((): number => {
    return engineRef.current?.getMediaTime() ?? 0;
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
    const filter = project?.fileFilter ?? (project?.hideAnnotated ? 'unannotated' : 'all');
    if (filter === 'annotated') return base.filter(f => annotatedTracks.has(f));
    if (filter === 'unannotated') return base.filter(f => !annotatedTracks.has(f));
    return base;
  }, [shuffleMode, shuffledFiles, allTracks, project?.fileFilter, project?.hideAnnotated, annotatedTracks]);

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
  const canGoPrevAnnotation = useMemo(
    () => sortedAnnotations.some(a => a.start < currentTime - 0.05),
    [sortedAnnotations, currentTime]
  );
  const canGoNextAnnotation = useMemo(
    () => sortedAnnotations.some(a => a.start > currentTime + 0.05),
    [sortedAnnotations, currentTime]
  );

  // Toggle shuffle: randomise current allTracks order
  const toggleShuffle = useCallback(() => {
    setShuffleMode(prev => {
      const next = !prev;
      if (next) {
        const shuffled = [...allTracks];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        // Pin the currently open file at the front of the queue
        const cur = trackPathRef.current;
        if (cur) {
          const idx = shuffled.indexOf(cur);
          if (idx > 0) { shuffled.splice(idx, 1); shuffled.unshift(cur); }
        }
        setShuffledFiles(shuffled);
      }
      if (projectRef.current) {
        updateProject({ ...projectRef.current, shuffleMode: next });
      }
      return next;
    });
  }, [allTracks, updateProject]);

  // Ident: relative path from audio root to track, without extension
  const ident = useMemo(() => {
    if (!trackPath || !currentDirectory) return null;
    const rel = trackPath.substring(currentDirectory.length + 1);
    return rel.replace(/\.[^/.]+$/, '');
  }, [trackPath, currentDirectory]);

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
      updateProject({ ...projectRef.current, annotationTools });
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
      updateProject({ ...projectRef.current, spectrogramSettings: settings });
    }, 800);
    return () => {
      if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    };
  }, [settings]);

  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (uiPersistRef.current) clearTimeout(uiPersistRef.current);
    uiPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      updateProject({ ...projectRef.current, uiSettings: { leftPanelWidth, splitRatio, leftPanelRatio, volume } });
    }, 600);
    return () => {
      if (uiPersistRef.current) clearTimeout(uiPersistRef.current);
    };
  }, [leftPanelWidth, splitRatio, leftPanelRatio, volume]);

  // Compute annotation file path: mirrors audio dir structure into annotation dir
  const getAnnotationPath = useCallback((trackFilePath: string): string | null => {
    if (!annotationDirectory || !currentDirectory) return null;
    const rel = trackFilePath.substring(currentDirectory.length);
    const withoutExt = rel.replace(/\.[^/.]+$/, '');
    const ext = exportFormat === 'json' ? '.json' : exportFormat === 'csv' ? '.csv' : '.txt';
    return annotationDirectory + withoutExt + ext;
  }, [annotationDirectory, currentDirectory, exportFormat]);

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
        const decimals = projectRef.current?.outputRoundingDecimals ?? 4;
        let content: string;
        if (exportFormat === 'json') content = generateJSONContent(annotations, decimals);
        else if (exportFormat === 'csv') content = generateCSVContent(annotations, decimals);
        else content = generateAudacityContent(annotations, decimals);
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
  }, [annotations, trackPath, annotationDirectory, exportFormat, getAnnotationPath]);

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

        if (exportFormat === 'json') {
          const parsed = JSON.parse(content) as Annotation[];
          parsed.forEach(a => {
            const matchedTool = annotationTools.find(t => t.text === a.text);
            loaded.push({
              ...a,
              id: Math.random().toString(36).substring(2, 9),
              toolKey: matchedTool?.key ?? a.toolKey ?? '0',
              color: matchedTool?.color ?? a.color ?? '#ffffff',
            });
          });
        } else if (exportFormat === 'csv') {
          // Proper CSV tokenizer: handles commas and newlines inside quoted fields
          // and "" as an escaped double-quote (RFC 4180 compatible).
          const parseCSVRow = (row: string): string[] => {
            const fields: string[] = [];
            let field = '';
            let inQuotes = false;
            for (let i = 0; i < row.length; i++) {
              const ch = row[i];
              if (inQuotes) {
                if (ch === '"') {
                  // Peek ahead: "" = escaped quote
                  if (i + 1 < row.length && row[i + 1] === '"') {
                    field += '"';
                    i++;
                  } else {
                    inQuotes = false;
                  }
                } else {
                  field += ch;
                }
              } else {
                if (ch === '"') {
                  inQuotes = true;
                } else if (ch === ',') {
                  fields.push(field);
                  field = '';
                } else {
                  field += ch;
                }
              }
            }
            fields.push(field);
            return fields;
          };
          // Re-join lines that belong to a single quoted field (embedded newlines).
          const reassembleRows = (raw: string): string[] => {
            const rows: string[] = [];
            let current = '';
            let openQuotes = 0;
            for (const ch of raw) {
              if (ch === '"') openQuotes ^= 1;
              if (ch === '\n' && openQuotes === 0) {
                rows.push(current);
                current = '';
              } else {
                current += ch;
              }
            }
            if (current) rows.push(current);
            return rows;
          };
          const allRows = reassembleRows(content.trim());
          // Skip header row
          for (const row of allRows.slice(1)) {
            if (!row.trim()) continue;
            const fields = parseCSVRow(row);
            if (fields.length >= 3) {
              const text = fields[0];
              const start = parseFloat(fields[1]);
              const end = parseFloat(fields[2]);
              if (!isNaN(start) && !isNaN(end)) {
                const matchedTool = annotationTools.find(t => t.text === text);
                loaded.push({ id: Math.random().toString(36).substring(2, 9), toolKey: matchedTool?.key ?? '0', start, end, text, color: matchedTool?.color ?? '#ffffff' });
              }
            }
          }
        } else {
          // Audacity .txt
          const lines = content.trim().split('\n');
          for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length >= 3) {
              const start = parseFloat(parts[0]);
              const end = parseFloat(parts[1]);
              const text = parts.slice(2).join('\t');
              if (!isNaN(start) && !isNaN(end)) {
                const matchedTool = annotationTools.find(t => t.text === text);
                loaded.push({ id: Math.random().toString(36).substring(2, 9), toolKey: matchedTool?.key ?? '0', start, end, text, color: matchedTool?.color ?? '#ffffff' });
              }
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
  }, [trackPath, annotationDirectory, exportFormat, annotationTools]);

  // Initialize state from project prop on mount
  useEffect(() => {
    setAnnotationTools(project.annotationTools.length > 0 ? project.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    if (project.spectrogramSettings) {
      setSettings(project.spectrogramSettings);
    }
    setShuffleMode(project.shuffleMode ?? false);
    setSplitRatio(project.uiSettings?.splitRatio ?? 0.5);
    setLeftPanelRatio(project.uiSettings?.leftPanelRatio ?? 0.6);
    setLeftPanelWidth(project.uiSettings?.leftPanelWidth ?? 224);
    setVolume(project.uiSettings?.volume ?? 1);
    setShuffledFiles([]);
    setCurrentDirectory(project.audioDirectory);
    setAnnotatedFiles(new Set());
    setAnnotations([]);
    setTrackPath(null);
    setVideoSrc(null);
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;
    listMediaFilesRecursive(project.audioDirectory)
      .then(files => {
        setAllMediaFiles(files);
        let firstFile = files[0];
        if (project.shuffleMode && files.length > 0) {
          const shuffled = [...files];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          setShuffledFiles(shuffled);
          firstFile = shuffled[0];
        }
        if (firstFile) handleOpenTrack(firstFile);
        listAnnotationFiles(project.annotationDirectory, project.outputFormat)
          .then(relPaths => {
            const audioRoot = project.audioDirectory;
            const relToFull = new Map<string, string>();
            for (const f of files) {
              const rel = f.substring(audioRoot.length + 1).replace(/\.[^/.]+$/, '').replace(/\\/g, '/');
              relToFull.set(rel, f);
            }
            const annotated = new Set<string>();
            for (const rp of relPaths) {
              const full = relToFull.get(rp);
              if (full) annotated.add(full);
            }
            setAnnotatedFiles(annotated);
          })
          .catch(() => {});
      })
      .catch(err => {
        setAllMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefreshFiles = useCallback(async () => {
    try {
      const files = await listMediaFilesRecursive(project.audioDirectory);
      setAllMediaFiles(files);
      listAnnotationFiles(project.annotationDirectory, project.outputFormat)
        .then(relPaths => {
          const audioRoot = project.audioDirectory;
          const relToFull = new Map<string, string>();
          for (const f of files) {
            const rel = f.substring(audioRoot.length + 1).replace(/\.[^/.]+$/, '').replace(/\\/g, '/');
            relToFull.set(rel, f);
          }
          const annotated = new Set<string>();
          for (const rp of relPaths) {
            const full = relToFull.get(rp);
            if (full) annotated.add(full);
          }
          setAnnotatedFiles(annotated);
        })
        .catch(() => {});
    } catch (err) {
      addLog(`Error refreshing files: ${err}`, 'error');
    }
  }, [project]);

  const handleProjectSettingsSaved = useCallback(async (updated: Project) => {
    await updateProject(updated);
    const audioDirChanged = updated.audioDirectory !== project.audioDirectory;
    setAnnotationTools(updated.annotationTools.length > 0 ? updated.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    if (audioDirChanged) {
      setCurrentDirectory(updated.audioDirectory);
      setTrackPath(null);
      setVideoSrc(null);
      setAnnotations([]);
      try {
        const files = await listMediaFilesRecursive(updated.audioDirectory);
        setAllMediaFiles(files);
        if (files.length > 0) handleOpenTrack(files[0]);
      } catch (err) {
        setAllMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      }
    }
    setShowProjectSettings(false);
  }, [project, updateProject, handleOpenTrack]);

  const handleToggleFileFilter = useCallback(() => {
    const current = project.fileFilter ?? (project.hideAnnotated ? 'unannotated' : 'all');
    const next = ({ all: 'unannotated', unannotated: 'annotated', annotated: 'all' } as const)[current];
    updateProject({ ...project, fileFilter: next, hideAnnotated: next === 'unannotated' });
  }, [project, updateProject]);

  const handleRevealInFinder = useCallback((path: string) => {
    revealInFileManager(path).catch(err => addLog(`reveal_in_file_manager error: ${err}`, 'error'));
  }, []);

  const handleRevealAnnotations = useCallback((audioFilePath: string) => {
    // If path is not in the known audio files list, treat as a directory
    if (!allTracks.includes(audioFilePath)) {
      if (annotationDirectory) revealInFileManager(annotationDirectory).catch(() => {});
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
  }, [allTracks, getAnnotationPath, annotationDirectory]);

  const togglePlay = useCallback(async () => {
      if (isPlaying || isBuffering) {
          // Invalidate any in-flight preroll so its resolution can't start engine
          playTokenRef.current += 1;
          engineRef.current?.pause();
          setIsPlaying(false);
          setIsBuffering(false);
      } else {
          const sel = selectionRef.current;
          let startSec = currentTime;
          // If there's a selection and the playhead is outside it, restart from selection start
          if (sel && (currentTime >= sel.end - 0.05 || currentTime < sel.start)) {
              startSec = sel.start;
              seek(sel.start, true);
          } else if (!sel && duration > 0 && currentTime >= duration - 0.05) {
              // At end of track with no selection — return to beginning
              startSec = 0;
              seek(0, true);
          }
          setIsBuffering(true);
          const token = ++playTokenRef.current;
          // For video tracks, pre-roll so the first frame at startSec is decoded
          // BEFORE the engine schedules audio. Otherwise short selections may end
          // before any frames render. Audio tracks skip the wait entirely.
          if (!isAudioTrack) {
              await prerollVideo(startSec, sel?.end);
              if (token !== playTokenRef.current) return; // user interrupted
          }
          // isPlaying is set to true only when onPlaying fires (first sample emitted).
          // endSec enables sample-accurate selection stop.
          engineRef.current?.play(startSec, sel ? sel.end : undefined);
      }
  }, [isPlaying, isBuffering, isAudioTrack, currentTime, duration, prerollVideo]);

  const seek = useCallback(async (time: number, scrollView = false) => {
      const wasPlaying = engineRef.current?.isPlaying ?? false;
      engineRef.current?.seek(time);
      currentTimeRef.current = time;
      setCurrentTime(time);
      // Notify the frame source so its eviction window follows the scrub position.
      // Kick a small ensureRange while paused so a scrub shows the correct frame
      // (rather than a stale one from the prior window).
      if (!isAudioTrack && frameSourceRef.current) {
          frameSourceRef.current.notifyPlayhead(time);
          if (!wasPlaying) {
              frameSourceRef.current.ensureRange(time, Math.min(time + 0.5, durationRef.current || time + 0.5))
                .catch(() => {});
          }
      }
      if (scrollView) spectrogramRef.current?.scrollToTime(time);
      // If playback was active, restart from the new position (stop if at/past end)
      if (wasPlaying) {
          if (time < durationRef.current) {
              const sel = selectionRef.current;
              setIsBuffering(true);
              const token = ++playTokenRef.current;
              if (!isAudioTrack) {
                  await prerollVideo(time, sel?.end);
                  if (token !== playTokenRef.current) return;
              }
              engineRef.current?.play(time, sel ? sel.end : undefined);
          } else {
              // Seeked to/past end — stop cleanly rather than hanging
              setIsPlaying(false);
          }
      }
  }, [isAudioTrack, prerollVideo]);

  // Keep seekRef in sync with seek so the mount-time onEnded closure always calls the latest version
  useEffect(() => { seekRef.current = seek; }, [seek]);

  // Shared handler for activating an annotation tool by key — used by both number hotkeys and palette clicks.
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
          }
      } else if (activeToolKey === null && selection !== null) {
          const newAnnotation = makeAnnotationFromTool(tool, selection.start, selection.end);
          handleAnnotationsCommit([...annotations, newAnnotation]);
          setSelectedAnnotationId(newAnnotation.id);
          setBoundAnnotationId(newAnnotation.id);
          setActiveToolKey(key);
      } else {
          setActiveToolKey(prev => prev === key ? null : key);
      }
  }, [annotationTools, boundAnnotationId, annotations, activeToolKey, selection, handleAnnotationsCommit, reassignBufferRef]);

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
              setSelection({ start: 0, end: duration });
          }
      } else {
          setSelection({ start: 0, end: duration });
      }
  };
  const deleteSelectedAnnotation = () => {
      if (!selectedAnnotationId) return;
      handleAnnotationsCommit(annotations.filter(a => a.id !== selectedAnnotationId));
      const wasBound = selectedAnnotationId === boundAnnotationId;
      setSelectedAnnotationId(null);
      if (wasBound) {
          setSelection(null);
          setBoundAnnotationId(null);
      }
  };
  useHotkeys([
      // Help panel — also fires inside text inputs, since help is universal.
      { key: 'F1', allowInInput: true, handler: () => setShowHelp(prev => !prev) },
      { key: '?', mods: ['shift'], allowInInput: true, handler: () => setShowHelp(prev => !prev) },

      // Mod+key bindings. Order matters: more specific (mod+shift+z) before mod+z.
      { key: 'a', mods: ['mod'], handler: selectAllOrAnnotateFullTrack },
      { key: 'z', mods: ['mod', 'shift'], handler: () => redoAnnotations() },
      { key: 'z', mods: ['mod'], handler: () => undoAnnotations() },
      { key: 'y', mods: ['mod'], handler: () => redoAnnotations() },
      { key: 'ArrowLeft', mods: ['mod'], handler: () => spectrogramRef.current?.goToPrevAnnotation() },
      { key: 'ArrowRight', mods: ['mod'], handler: () => spectrogramRef.current?.goToNextAnnotation() },
      { key: 'ArrowUp', mods: ['mod'], handler: () => navigateFile('prev') },
      { key: 'ArrowDown', mods: ['mod'], handler: () => navigateFile('next') },

      // Plain arrow keys: scrub playhead ±10% of visible window.
      { key: 'ArrowLeft', handler: () => seek(Math.max(0, currentTimeRef.current - zoomSecRef.current * 0.1)) },
      { key: 'ArrowRight', handler: () => seek(Math.min(durationRef.current, currentTimeRef.current + zoomSecRef.current * 0.1)) },

      // Plain keys.
      { key: ' ', handler: togglePlay },
      { key: 'm', handler: () => setMuted(prev => !prev), preventDefault: false },
      // Escape fires even when a text input has focus — see CLAUDE.md / fix:
      // the legacy `tagName === 'INPUT'` guard meant Esc was swallowed any time
      // an annotation-text input was auto-focused, so the Select tool couldn't
      // be activated during playback. Local input onKeyDown handlers can still
      // run first (and call stopImmediatePropagation if they want to suppress
      // this).
      { key: 'Escape', allowInInput: true, handler: () => setActiveToolKey(null) },
      { key: 'Delete', handler: deleteSelectedAnnotation, preventDefault: false },
      { key: 'Backspace', handler: deleteSelectedAnnotation, preventDefault: false },

      // 0-9: activate annotation tool by key, if defined.
      { key: 'Digit', handler: (e) => {
          const tool = annotationTools.find(t => t.key === e.key);
          if (tool) handleToolActivate(e.key);
      }},
  ]);

  const performExport = async () => {
      if (annotations.length === 0) return;
      const decimals = project?.outputRoundingDecimals ?? 4;
      if (exportFormat === 'json') {
          await exportToJSON(annotations, trackName, trackPath, decimals);
      } else if (exportFormat === 'csv') {
          await exportToCSV(annotations, trackName, trackPath, decimals);
      } else {
          await exportToAudacity(annotations, trackName, trackPath, decimals);
      }
      addLog(`Exported annotations as ${exportFormat.toUpperCase()}`);
  };

  const handleCreateTool = useCallback((text: string, color: string) => {
    setAnnotationTools(prev => [...prev, { key: null, text, color }]);
  }, []);

  const handleRenameTool = useCallback((toolIndex: number, newText: string, newColor: string) => {
    setAnnotationTools(prev => prev.map((t, i) => i === toolIndex ? { ...t, text: newText, color: newColor } : t));
    setAnnotations(prev => prev.map(a => {
      const tool = annotationTools[toolIndex];
      if (!tool) return a;
      // Update text for annotations linked to this tool
      if (a.toolKey === tool.key && a.toolKey !== '0') {
        return { ...a, text: newText, color: newColor };
      }
      // Reassociate Custom annotations matching the new name to this tool
      if (a.toolKey === '0' && a.text === newText && tool.key !== null) {
        return { ...a, toolKey: tool.key!, color: newColor };
      }
      return a;
    }));
  }, [annotationTools]);

  const handleDeleteTool = useCallback((toolIndex: number) => {
    const tool = annotationTools[toolIndex];
    if (!tool) return;
    setAnnotations(prev => prev.map(a =>
      a.toolKey === tool.key ? { ...a, toolKey: '0', color: '#ffffff' } : a
    ));
    setAnnotationTools(prev => prev.filter((_, i) => i !== toolIndex));
    if (activeToolKey === tool.key) setActiveToolKey(null);
  }, [annotationTools, activeToolKey]);

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

  const handleSplitDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = splitRatio;

      const onMove = (moveEvent: MouseEvent) => {
          const delta = moveEvent.clientY - startY;
          const totalHeight = window.innerHeight - 64;
          const newRatio = Math.max(0.2, Math.min(0.8, startRatio + (delta / totalHeight)));
          setSplitRatio(newRatio);
      };

      const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  };

  const handleLeftPanelDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = leftPanelRatio;

      const onMove = (moveEvent: MouseEvent) => {
          const delta = moveEvent.clientY - startY;
          const totalHeight = window.innerHeight - 64;
          let newRatio = Math.max(0.15, Math.min(0.85, startRatio + (delta / totalHeight)));
          // Soft snap: shift up by one divider height (h-2 = 8px) so tops align visually
          const dividerOffset = 8 / totalHeight;
          if (Math.abs(newRatio - (splitRatio - dividerOffset)) < 0.025) newRatio = splitRatio - dividerOffset;
          setLeftPanelRatio(newRatio);
      };

      const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  };

  const handleLeftPanelWidthDrag = (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = leftPanelWidth;

      const onMove = (moveEvent: MouseEvent) => {
          const delta = moveEvent.clientX - startX;
          setLeftPanelWidth(Math.max(160, Math.min(480, startWidth + delta)));
      };

      const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
  };

  // Keep the engine's gain in sync with the volume slider and mute button
  useEffect(() => {
    engineRef.current?.setGain(muted ? 0 : volume);
  }, [volume, muted]);

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
                    <GradientProjectName name={project.name} nameGradientColors={project.nameGradientColors} />
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
            onToggleCollapse: () => setFilePanelCollapsed(c => !c),
            onNavigatePrev: () => navigateFile('prev'),
            onNavigateNext: () => navigateFile('next'),
            canNavigatePrev: currentFileIndex > 0,
            canNavigateNext: currentFileIndex < displayQueue.length - 1,
            shuffleMode,
            onToggleShuffle: toggleShuffle,
            annotatedTracks,
            fileFilter: (project?.fileFilter ?? (project?.hideAnnotated ? 'unannotated' : 'all')) as 'all' | 'annotated' | 'unannotated',
            onToggleFileFilter: handleToggleFileFilter,
            onRevealInFinder: handleRevealInFinder,
            onRevealAnnotations: handleRevealAnnotations,
            onRefresh: handleRefreshFiles,
          };

          if (filePanelCollapsed) {
            return (
              <div className="flex-none w-10 bg-slate-900 border-r border-slate-700 flex flex-col h-full">
                <FileTree {...fileTreeProps} collapsed={true} />
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
                onSelectModeActivate={() => setActiveToolKey(null)}
                onOpenSettings={() => setShowToolSettings(true)}
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
                <div className="absolute top-10 right-4 z-40 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                    <div className="p-4 space-y-6">
                        {/* Visuals */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase">Visuals</h4>
                            <BrightnessContrastPad
                                brightness={settings.intensity}
                                contrast={settings.contrast}
                                onChange={(b, c) => setSettings(s => ({...s, intensity: b, contrast: c}))}
                            />
                        </div>

                        {/* Frequency */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase">Frequency</h4>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">FFT Window Size</label>
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

                            <div className="flex space-x-2 pt-2">
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Min (Hz)</label>
                                    <input
                                        type="number"
                                        value={settings.minFreq}
                                        onChange={(e) => setSettings(s => ({...s, minFreq: Math.max(0, parseInt(e.target.value))}))}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Max (Hz)</label>
                                    <input
                                        type="number"
                                        value={settings.maxFreq}
                                        onChange={(e) => setSettings(s => ({...s, maxFreq: parseInt(e.target.value)}))}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
             )}

             <Toolbar
               isPlaying={isPlaying}
               isBuffering={isBuffering}
               videoSrc={videoSrc}
               currentTime={currentTime}
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
               onSelectionChange={setSelection}
               onBoundAnnotationChange={setBoundAnnotationId}
               showSettings={showSettings}
               onToggleSettings={() => setShowSettings(s => !s)}
             />

             <div className="flex-1 relative overflow-hidden">
             <Spectrogram
                ref={spectrogramRef}
                chunkCache={chunkCacheRef.current}
                sampleRate={sampleRate}
                cacheVersion={cacheVersion}
                currentTime={currentTime}
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
                onSelectionChange={setSelection}
                onBoundAnnotationChange={setBoundAnnotationId}
                onZoomChange={setZoomSec}
             />
             </div>

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
          onCreateTool={handleCreateTool}
        />
      )}
      <TooltipLayer />
    </div>
  );
}
