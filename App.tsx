import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Pause, Settings, Loader2, Volume2, VolumeX, Keyboard, Plus, X, HelpCircle, AudioWaveform, Bug, Pencil, ArrowLeft, ChevronLeft, ChevronRight, SkipBack, SkipForward } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import LaunchScreen from './components/LaunchScreen';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import { Annotation, SpectrogramSettings, AnnotationTool, FrequencyScale, Project } from './types';
import { DEFAULT_ZOOM_SEC, DEFAULT_ANNOTATION_TOOLS, HOTKEY_COLORS, isSupportedMediaFile } from './constants';
import { formatTime, exportToCSV, exportToAudacity, exportToJSON, generateAudacityContent, generateCSVContent, generateJSONContent, makeAnnotationFromTool } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, readTextFile, writeTextFile, removeFile, toAssetUrl } from './utils/tauriCommands';
import { useProjects } from './hooks/useProjects';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { revealInFileManager, listAnnotationFiles } from './utils/projectCommands';
import { AudioEngine } from './utils/AudioEngine';

// Compact tool button used in the left-panel tool grid.
// Always renders w-full — callers are responsible for constraining the container width.
function ToolCell({
  isActive, color, dotColor, label, hotkey, onClick, dotted,
}: {
  isActive: boolean; color: string; dotColor: string; label: string;
  hotkey: string; onClick: () => void; dotted?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs transition-all border
        ${isActive ? 'opacity-100' : 'opacity-60 hover:opacity-100'}
        ${!dotted && isActive ? 'ring-1 ring-white/50' : ''}
        ${dotted ? 'border-dashed' : 'border-transparent hover:border-slate-600'}`}
      style={{
        backgroundColor: isActive ? color + '40' : color + '18',
        // dotted: brighten border when active instead of adding a ring
        borderColor: dotted
          ? (isActive ? 'rgba(255,255,255,0.6)' : '#6b7280')
          : (isActive ? color : undefined),
      }}
      title={label}
    >
      <span className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: dotColor }} />
      <span className="flex-1 min-w-0 truncate text-left text-slate-100 leading-tight">{label}</span>
      <span className="font-mono text-slate-500 text-[10px] flex-none">{hotkey}</span>
    </button>
  );
}

export default function App() {
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
  const [allMediaFiles, setAllMediaFiles] = useState<string[]>([]);
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);

  // Project state
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const { projects, isLoading, loadError, projectsFilePath, createProject, updateProject, deleteProject, touchLastOpened } = useProjects();

  // Derived from active project
  const annotationDirectory = activeProject?.annotationDirectory ?? null;
  const exportFormat = activeProject?.outputFormat ?? 'txt';

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
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Annotation State
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [annotationTools, setAnnotationTools] = useState<AnnotationTool[]>(DEFAULT_ANNOTATION_TOOLS);
  // null = Selection Mode (no annotation tool active); string key of the active tool otherwise.
  const [activeToolKey, setActiveToolKey] = useState<string | null>(null);

  // Selection region for Selection Mode playback and UI
  const [selectionRegion, setSelectionRegion] = useState<{ start: number; end: number } | null>(null);
  const selectionRegionRef = useRef<{ start: number; end: number } | null>(null);

  // Annotation currently bound to the selection region (null = free selection or no selection)
  const [boundAnnotationId, setBoundAnnotationId] = useState<string | null>(null);

  // Per-session text buffer for annotation tool reassignment: saves each toolKey's text while an
  // annotation is bound, so switching back to a prior tool restores the previously-entered text.
  // Cleared when the bound annotation is deselected.
  const reassignBufferRef = useRef<Record<string, string>>({});

  // Annotation Tool Editing State
  const [editingToolIndex, setEditingToolIndex] = useState<number | null>(null);
  const [editingToolText, setEditingToolText] = useState("");

  // Toolbar timestamp editing state
  type TimeField = 'time' | 'selStart' | 'selEnd' | 'selDur';
  const [editingTimeField, setEditingTimeField] = useState<TimeField | null>(null);
  const [editingTimeRaw, setEditingTimeRaw] = useState("");
  
  // Ref that stays in sync with activeProject — avoids stale-closure bugs in persist effects
  const activeProjectRef = useRef<typeof activeProject>(null);
  useEffect(() => { activeProjectRef.current = activeProject; }, [activeProject]);

  // Keep activeProject in sync with the projects list so that activeProjectRef.current
  // always has the latest saved data. Without this, interleaved persist effects (annotationTools
  // vs spectrogramSettings) each spread a stale activeProjectRef and clobber each other's saves.
  useEffect(() => {
    if (!activeProject) return;
    const synced = projects.find(p => p.id === activeProject.id);
    if (synced && synced !== activeProject) {
      setActiveProject(synced);
    }
  }, [projects]);

  // Ref to Spectrogram imperative handle (prev/next annotation navigation)
  const spectrogramRef = useRef<SpectrogramHandle>(null);

  const engineRef = useRef<AudioEngine | null>(null);
  // Ref so the onEnded closure (created once on mount) can read current isAudioTrack
  const isAudioTrackRef = useRef(false);

  // Create engine on mount, destroy on unmount
  useEffect(() => {
    engineRef.current = new AudioEngine({
      onTimeUpdate: (t) => setCurrentTime(t),
      onPlaying: () => { setIsPlaying(true); setIsBuffering(false); },
      onPaused: () => setIsPlaying(false),
      onEnded: () => {
        // Stop playback and return playhead to selection start (matching old behavior).
        // For video files, also pause the video element (which plays frames).
        const sel = selectionRegionRef.current;
        if (!isAudioTrackRef.current) {
          videoRef.current?.pause();
        }
        if (sel) {
          seek(sel.start, true);
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [leftPanelRatio, setLeftPanelRatio] = useState(0.6);
  const [leftPanelWidth, setLeftPanelWidth] = useState(224);
  const [showSettings, setShowSettings] = useState(false);
  const [showHotkeysHelp, setShowHotkeysHelp] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);
  const [isAddingTool, setIsAddingTool] = useState(false);
  const [newToolText, setNewToolText] = useState("");
  
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
  const [annotatedFiles, setAnnotatedFiles] = useState<Set<string>>(new Set());

  const addLog = (msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  };

  // Keep selectionRegionRef in sync with state (for use in rAF loop without stale closure)
  useEffect(() => { selectionRegionRef.current = selectionRegion; }, [selectionRegion]);

  // Clear the reassign buffer whenever the bound annotation changes (released or switched to another)
  useEffect(() => { reassignBufferRef.current = {}; }, [boundAnnotationId]);

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Keep isAudioTrackRef in sync so the onEnded closure (created once on mount) reads the current value
  useEffect(() => { isAudioTrackRef.current = isAudioTrack; }, [isAudioTrack]);

  // Video-frame sync loop — video tracks only.
  //
  // The AudioEngine is the canonical clock. Instead of seeking the <video>
  // element whenever it drifts (which triggers an expensive keyframe decode
  // and can cascade into multi-second freezes), we nudge playbackRate
  // proportionally to the drift. A hard seek is only used as a last resort
  // when drift exceeds HARD_SEEK_THRESHOLD, and is gated on 'seeked' so we
  // never issue overlapping seeks.
  useEffect(() => {
    if (isAudioTrack || !isPlaying) return;
    const video = videoRef.current;
    const engine = engineRef.current;
    if (!video || !engine) return;

    // s — below this drift we let the clocks be; above it we correct via rate
    const DEADBAND_SEC = 0.005;
    // s — if drift exceeds this we give up on rate correction and hard-seek
    const HARD_SEEK_THRESHOLD = 0.5;
    // ± fraction — clamp on playbackRate delta (|rate - 1|)
    const MAX_RATE_DELTA = 0.05;
    // Gain on proportional controller: drift(s) * gain = rate delta
    const CORRECTION_GAIN = 0.5;

    let rAF: number | null = null;
    let hardSeekInFlight = false;
    const onSeeked = () => { hardSeekInFlight = false; };
    video.addEventListener('seeked', onSeeked);

    const loop = () => {
      const engineTime = engine.getMediaTime();
      const drift = engineTime - video.currentTime; // >0: video behind audio

      if (Math.abs(drift) > HARD_SEEK_THRESHOLD) {
        if (!hardSeekInFlight) {
          hardSeekInFlight = true;
          video.playbackRate = 1;
          video.currentTime = engineTime;
        }
      } else if (Math.abs(drift) > DEADBAND_SEC) {
        const delta = Math.max(
          -MAX_RATE_DELTA,
          Math.min(MAX_RATE_DELTA, drift * CORRECTION_GAIN),
        );
        const target = 1 + delta;
        if (Math.abs(video.playbackRate - target) > 0.002) {
          video.playbackRate = target;
        }
      } else if (video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
      rAF = requestAnimationFrame(loop);
    };
    rAF = requestAnimationFrame(loop);

    return () => {
      if (rAF !== null) cancelAnimationFrame(rAF);
      video.removeEventListener('seeked', onSeeked);
      video.playbackRate = 1;
    };
  }, [isPlaying, isAudioTrack]);

  // Open a track by absolute path (called from button or file panel)
  const handleOpenFile = useCallback(async (absolutePath: string) => {
    // Guard: never attempt to open a file whose extension we can't decode.
    // Both the tree and nav paths already filter these out; this is a belt-and-suspenders
    // check so a stray caller can't put us into a half-loaded state.
    if (!isSupportedMediaFile(absolutePath)) {
      addLog(`Skipped unsupported file: ${absolutePath.split('/').pop() ?? absolutePath}`, 'error');
      return;
    }

    setAnnotations([]);
    setIsPlaying(false);
    setIsBuffering(false);
    setSelectedAnnotationId(null);
    setSelectionRegion(null);
    setBoundAnnotationId(null);
    setDebugLogs([]);
    setTrackPath(absolutePath);
    // Reset playhead to beginning of track
    setCurrentTime(0);
    if (videoRef.current) videoRef.current.currentTime = 0;
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
        cache.prefetchViewport(0, zoomSec, cache.selectTier(zoomSec, 1200).tier);
        addLog('Spectrogram loading...');
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
    } finally {
        setIsProcessing(false);
    }
  }, [settings.fftSize]);

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

  // The ordered list used for navigation (respects shuffle mode and hideAnnotated filter)
  const displayQueue = useMemo(() => {
    const base = shuffleMode ? shuffledFiles : allMediaFiles;
    if (activeProject?.hideAnnotated) return base.filter(f => !annotatedFiles.has(f));
    return base;
  }, [shuffleMode, shuffledFiles, allMediaFiles, activeProject?.hideAnnotated, annotatedFiles]);

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
        handleOpenFile(displayQueue[idx]);
    }
  }, [displayQueue, currentFileIndex, trackPath, handleOpenFile]);

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

  // Toggle shuffle: randomise current allMediaFiles order
  const toggleShuffle = useCallback(() => {
    setShuffleMode(prev => {
      if (!prev) {
        const shuffled = [...allMediaFiles];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        setShuffledFiles(shuffled);
      }
      return !prev;
    });
  }, [allMediaFiles]);

  // Ident: relative path from audio root to track, without extension
  const fileIdent = useMemo(() => {
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

  // Intermediate update — no history entry (called during drags/resizes/text edits)
  const handleAnnotationsChange = useCallback((newAnnotations: Annotation[]) => {
    setAnnotations(newAnnotations);
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

  // Persist annotation tools and spectrogram settings to active project whenever they change
  const toolPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProject) return;
    // Skip persistence when switching projects (avoids overwriting with stale tools)
    if (prevProjectIdRef.current !== activeProject.id) {
      prevProjectIdRef.current = activeProject.id;
      return;
    }
    if (toolPersistRef.current) clearTimeout(toolPersistRef.current);
    toolPersistRef.current = setTimeout(() => {
      if (!activeProjectRef.current) return;
      updateProject({ ...activeProjectRef.current, annotationTools });
    }, 500);
    return () => {
      if (toolPersistRef.current) clearTimeout(toolPersistRef.current);
    };
  }, [annotationTools]);

  useEffect(() => {
    if (!activeProject) return;
    if (prevProjectIdRef.current !== activeProject.id) return;
    if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    settingsPersistRef.current = setTimeout(() => {
      if (!activeProjectRef.current) return;
      updateProject({ ...activeProjectRef.current, spectrogramSettings: settings });
    }, 800);
    return () => {
      if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    };
  }, [settings]);

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

    // Debounce saves by 300ms
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (skipAutoSaveRef.current) return;
      try {
        if (annotations.length === 0) {
          await removeFile(annotPath);
          setAnnotatedFiles(prev => {
            const next = new Set(prev);
            next.delete(trackPath);
            return next;
          });
          return;
        }
        let content: string;
        if (exportFormat === 'json') content = generateJSONContent(annotations);
        else if (exportFormat === 'csv') content = generateCSVContent(annotations);
        else content = generateAudacityContent(annotations);
        await writeTextFile(annotPath, content);
        setAnnotatedFiles(prev => {
            const next = new Set(prev);
            next.add(trackPath);
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

    (async () => {
      try {
        const content = await readTextFile(annotPath);
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
          const lines = content.trim().split('\n').slice(1); // skip header
          for (const line of lines) {
            const match = line.match(/^"?(.*?)"?,([0-9.]+),([0-9.]+)$/);
            if (match) {
              const text = match[1].replace(/""/g, '"');
              const start = parseFloat(match[2]);
              const end = parseFloat(match[3]);
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
  }, [trackPath, annotationDirectory]);

  const handleOpenProject = useCallback(async (project: Project) => {
    await touchLastOpened(project.id);
    // Set activeProject in the same React batch as annotationTools/settings so the
    // persist-effect guard (prevProjectIdRef) sees the new project immediately and
    // correctly skips the load-triggered changes.
    setActiveProject(project);
    setAnnotationTools(project.annotationTools.length > 0 ? project.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    if (project.spectrogramSettings) {
      setSettings(project.spectrogramSettings);
    }
    setCurrentDirectory(project.audioDirectory);
    setAnnotatedFiles(new Set());
    setAnnotations([]);
    setTrackPath(null);
    setVideoSrc(null);
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;
    try {
      const files = await listMediaFilesRecursive(project.audioDirectory);
      setAllMediaFiles(files);
      if (files.length > 0) handleOpenFile(files[0]);
      // Load annotation file existence in the background
      listAnnotationFiles(project.annotationDirectory, project.outputFormat)
        .then(relPaths => {
          const audioRoot = project.audioDirectory;
          // Build a map from rel path (no ext) → full audio path for O(1) lookup
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
      setAllMediaFiles([]);
      addLog(`Error scanning audio directory: ${err}`, 'error');
    }
  }, [touchLastOpened, handleOpenFile]);

  const handleRefreshFiles = useCallback(async () => {
    if (!activeProject) return;
    try {
      const files = await listMediaFilesRecursive(activeProject.audioDirectory);
      setAllMediaFiles(files);
      listAnnotationFiles(activeProject.annotationDirectory, activeProject.outputFormat)
        .then(relPaths => {
          const audioRoot = activeProject.audioDirectory;
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
  }, [activeProject]);

  const handleProjectSettingsSaved = useCallback(async (updated: Project) => {
    await updateProject(updated);
    const audioDirChanged = updated.audioDirectory !== activeProject?.audioDirectory;
    setAnnotationTools(updated.annotationTools.length > 0 ? updated.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    if (audioDirChanged) {
      setCurrentDirectory(updated.audioDirectory);
      setTrackPath(null);
      setVideoSrc(null);
      setAnnotations([]);
      try {
        const files = await listMediaFilesRecursive(updated.audioDirectory);
        setAllMediaFiles(files);
        if (files.length > 0) handleOpenFile(files[0]);
      } catch (err) {
        setAllMediaFiles([]);
        addLog(`Error scanning audio directory: ${err}`, 'error');
      }
    }
    setActiveProject(updated);
    setShowProjectSettings(false);
  }, [activeProject, updateProject, handleOpenFile]);

  const handleCloseProject = useCallback(() => {
    engineRef.current?.pause();
    setIsPlaying(false);
    setIsBuffering(false);
    setActiveProject(null);
  }, []);

  const handleToggleHideAnnotated = useCallback(() => {
    if (!activeProject) return;
    updateProject({ ...activeProject, hideAnnotated: !activeProject.hideAnnotated });
  }, [activeProject, updateProject]);

  const handleRevealInFinder = useCallback((path: string) => {
    revealInFileManager(path).catch(err => addLog(`reveal_in_file_manager error: ${err}`, 'error'));
  }, []);

  const handleRevealAnnotations = useCallback((audioFilePath: string) => {
    // If path is not in the known audio files list, treat as a directory
    if (!allMediaFiles.includes(audioFilePath)) {
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
  }, [allMediaFiles, getAnnotationPath, annotationDirectory]);

  const togglePlay = useCallback(() => {
      if (isPlaying || isBuffering) {
          engineRef.current?.pause();
          setIsPlaying(false);
          setIsBuffering(false);
          // For video files, also pause the video element (audio engine fires onPaused
          // which sets isPlaying=false; we stop the frame track here).
          if (!isAudioTrack) videoRef.current?.pause();
      } else {
          const sel = selectionRegionRef.current;
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
          // isPlaying is set to true only when onPlaying fires (first sample emitted).
          // endSec enables sample-accurate selection stop.
          engineRef.current?.play(startSec, sel ? sel.end : undefined);
          // For video files, start the video element for frame display (muted — audio
          // comes from the engine). Seek it to startSec first for frame sync.
          if (!isAudioTrack && videoRef.current) {
              videoRef.current.currentTime = startSec;
              videoRef.current.play().catch(() => {});
          }
      }
  }, [isPlaying, isBuffering, isAudioTrack, currentTime, duration]);

  const seek = useCallback((time: number, scrollView = false) => {
      const wasPlaying = engineRef.current?.isPlaying ?? false;
      engineRef.current?.seek(time);
      setCurrentTime(time);
      // Keep video frames in sync for video tracks
      if (!isAudioTrack && videoRef.current) {
          videoRef.current.currentTime = time;
      }
      if (scrollView) spectrogramRef.current?.scrollToTime(time);
      // If playback was active, restart from the new position (stop if at/past end)
      if (wasPlaying) {
          if (time < durationRef.current) {
              const sel = selectionRegionRef.current;
              setIsBuffering(true);
              engineRef.current?.play(time, sel ? sel.end : undefined);
              if (!isAudioTrack && videoRef.current) {
                  videoRef.current.currentTime = time;
                  videoRef.current.play().catch(() => {});
              }
          } else {
              // Seeked to/past end — stop cleanly rather than hanging
              setIsPlaying(false);
              if (!isAudioTrack) videoRef.current?.pause();
          }
      }
  }, [isAudioTrack]);

  // Global Hotkeys
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;

          // Undo / Redo
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
              e.preventDefault();
              if (e.shiftKey) redoAnnotations();
              else undoAnnotations();
              return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
              e.preventDefault();
              redoAnnotations();
              return;
          }

          // CMD+Arrow: annotation navigation and file navigation
          if (e.metaKey || e.ctrlKey) {
              if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  spectrogramRef.current?.goToPrevAnnotation();
                  return;
              }
              if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  spectrogramRef.current?.goToNextAnnotation();
                  return;
              }
              if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  navigateFile('prev');
                  return;
              }
              if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  navigateFile('next');
                  return;
              }
          }

          // Arrow keys: scrub playhead ±10% of visible window
          if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              seek(Math.max(0, currentTime - zoomSec * 0.1));
              return;
          }
          if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              seek(Math.min(duration, currentTime + zoomSec * 0.1));
              return;
          }

          switch(e.key.toLowerCase()) {
              case ' ':
                  e.preventDefault();
                  togglePlay();
                  break;
              case 'm':
                  setMuted(prev => !prev);
                  break;
              case 'escape':
                  setActiveToolKey(null);
                  break;
              case 'delete':
              case 'backspace':
                  if (selectedAnnotationId) {
                      handleAnnotationsCommit(annotations.filter(a => a.id !== selectedAnnotationId));
                      setSelectedAnnotationId(null);
                  }
                  break;
          }

          // Hotkey Numbers (0-9): select or switch active annotation tool
          if (/^[0-9]$/.test(e.key)) {
              const key = e.key;
              const tool = annotationTools.find(t => t.key === key);
              if (tool) {
                  e.preventDefault(); // Prevent the digit from being typed into the new custom tool input
                  const isCustom = tool.key === '0';
                  // If a bound annotation is selected: reassign its tool, don't create a new one
                  if (boundAnnotationId !== null) {
                      const currentAnnotation = annotations.find(a => a.id === boundAnnotationId);
                      if (currentAnnotation) {
                          // Save the annotation's current text before overwriting, so it can be
                          // restored if the user switches back to this toolKey later.
                          reassignBufferRef.current = {
                              ...reassignBufferRef.current,
                              [currentAnnotation.toolKey]: currentAnnotation.text,
                          };
                          // Restore saved text for the new toolKey, or fall back to the default.
                          const savedText = reassignBufferRef.current[tool.key];
                          const newText = savedText !== undefined ? savedText : (isCustom ? '' : tool.text);
                          const updated = annotations.map(a => a.id === boundAnnotationId
                              ? { ...a, toolKey: tool.key, text: newText, color: tool.color }
                              : a
                          );
                          handleAnnotationsCommit(updated);
                          setActiveToolKey(key);
                      }
                  }
                  // If in selection mode with a free selection, drop a new annotation onto it
                  else if (activeToolKey === null && selectionRegion !== null) {
                      const newAnnotation = makeAnnotationFromTool(tool, selectionRegion.start, selectionRegion.end);
                      handleAnnotationsCommit([...annotations, newAnnotation]);
                      setSelectedAnnotationId(newAnnotation.id);
                      setBoundAnnotationId(newAnnotation.id);
                      // Selection stays — now bound to the new annotation
                      setActiveToolKey(key);
                  } else {
                      setActiveToolKey(prev => prev === key ? null : key);
                  }
              }
          }

      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, selectedAnnotationId, annotationTools, navigateFile, undoAnnotations, redoAnnotations, handleAnnotationsCommit, annotations, activeToolKey, selectionRegion, boundAnnotationId, seek, currentTime, zoomSec, duration]);

  const performExport = async () => {
      if (annotations.length === 0) return;
      if (exportFormat === 'json') {
          await exportToJSON(annotations, trackName, trackPath);
      } else if (exportFormat === 'csv') {
          await exportToCSV(annotations, trackName, trackPath);
      } else {
          await exportToAudacity(annotations, trackName, trackPath);
      }
      addLog(`Exported annotations as ${exportFormat.toUpperCase()}`);
  };

  const handleAddTool = () => {
      if (newToolText.trim() === "") {
          setIsAddingTool(false);
          return;
      }

      const nextIndex = annotationTools.length;
      if (nextIndex >= 10) {
          alert("Maximum of 10 annotation tools (0-9) allowed.");
          setIsAddingTool(false);
          setNewToolText("");
          return;
      }

      const newTool: AnnotationTool = {
          key: nextIndex.toString(),
          text: newToolText,
          color: HOTKEY_COLORS[nextIndex]
      };

      setAnnotationTools([...annotationTools, newTool]);
      setIsAddingTool(false);
      setNewToolText("");
      // Auto-select the newly created annotation tool
      setActiveToolKey(newTool.key);
      addLog(`Added tool: ${newToolText} (${nextIndex})`);
  };

  const startEditingTool = (idx: number) => {
      setEditingToolIndex(idx);
      setEditingToolText(annotationTools[idx].text);
  };

  const saveEditingTool = () => {
      if (editingToolIndex === null) return;

      const idx = editingToolIndex;
      const tool = annotationTools[idx];
      const newName = editingToolText.trim();

      if (newName && newName !== tool.text) {
          // Update tool
          const updatedTools = [...annotationTools];
          updatedTools[idx] = { ...tool, text: newName };
          setAnnotationTools(updatedTools);

          // Update ALL annotations created with this tool
          const updatedAnnotations = annotations.map(a => {
              if (a.toolKey === tool.key) {
                  return { ...a, text: newName };
              }
              return a;
          });
          setAnnotations(updatedAnnotations);
          addLog(`Renamed tool ${tool.text} -> ${newName}. Updated linked annotations.`);
      }

      setEditingToolIndex(null);
      setEditingToolText("");
  };

  const handleDeleteTool = (idx: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (idx === 0) return; // Cannot delete the Custom Annotation Tool

      const tool = annotationTools[idx];
      const linkedAnnotations = annotations.filter(a => a.toolKey === tool.key);

      if (linkedAnnotations.length > 0) {
          // Prompt
          const choice = confirm(
              `Deleting tool "${tool.text}" which is used by ${linkedAnnotations.length} annotations.\n\n` +
              `OK: Convert annotations to Custom (White)\n` +
              `Cancel: Delete all ${linkedAnnotations.length} annotations`
          );

          if (choice) {
              // Convert
              const updatedAnnotations = annotations.map(a => {
                  if (a.toolKey === tool.key) {
                      return { ...a, toolKey: "0", color: "#ffffff" };
                  }
                  return a;
              });
              setAnnotations(updatedAnnotations);
              addLog(`Deleted tool ${tool.text}. Converted annotations to Custom.`);
          } else {
              // Delete
              const updatedAnnotations = annotations.filter(a => a.toolKey !== tool.key);
              setAnnotations(updatedAnnotations);
              addLog(`Deleted tool ${tool.text} and all linked annotations.`);
          }
      } else {
          addLog(`Deleted tool ${tool.text} (unused).`);
      }

      // Remove tool and re-index hotkeys (0-9)
      const newTools = annotationTools.filter((_, i) => i !== idx);
      const reindexed = newTools.map((t, i) => ({ ...t, key: i.toString(), color: HOTKEY_COLORS[i] }));

      setAnnotationTools(reindexed);
      setActiveToolKey('0');
  };

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

  // Handle volume slider change
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = parseFloat(e.target.value);
      // Snap to 1.0 if close (tighter detent during drag)
      if (val > 0.97 && val < 1.03) val = 1.0;
      setVolume(val);
      setMuted(false);
  };

  // Calculate volume slider background
  const volPercent = Math.min(100, (volume / 4) * 100);
  const isBoosted = volume > 1;

  // Parse a timestamp string into seconds. Accepts: "83.45", "1:23", "1:23.45", "1:23:45"
  const parseTimestamp = (raw: string): number | null => {
    const s = raw.trim();
    // hh:mm:ss or hh:mm:ss.ff
    const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (hms) return parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseFloat(hms[3]);
    // mm:ss or mm:ss.ff
    const ms = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (ms) return parseInt(ms[1]) * 60 + parseFloat(ms[2]);
    // plain seconds
    const plain = parseFloat(s);
    if (!isNaN(plain) && plain >= 0) return plain;
    return null;
  };

  const commitTimeEdit = (raw: string) => {
    if (!editingTimeField) return;
    const parsed = parseTimestamp(raw);
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(duration, parsed));
      if (editingTimeField === 'time') {
        seek(clamped, true);
      } else if (editingTimeField === 'selStart' && selectionRegion) {
        setSelectionRegion({ start: clamped, end: Math.max(clamped, selectionRegion.end) });
      } else if (editingTimeField === 'selEnd' && selectionRegion) {
        setSelectionRegion({ start: selectionRegion.start, end: Math.max(selectionRegion.start, clamped) });
      } else if (editingTimeField === 'selDur' && selectionRegion) {
        setSelectionRegion({ start: selectionRegion.start, end: Math.min(duration, selectionRegion.start + Math.max(0, parsed)) });
      }
    }
    setEditingTimeField(null);
    setEditingTimeRaw("");
  };

  if (!activeProject) {
    return (
      <LaunchScreen
        projects={projects}
        isLoading={isLoading}
        loadError={loadError}
        projectsFilePath={projectsFilePath}
        onOpenProject={handleOpenProject}
        createProject={createProject}
        updateProject={updateProject}
        deleteProject={deleteProject}
      />
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      {/* Header */}
      <header className="flex-none h-16 bg-slate-800 border-b border-slate-700 flex items-center px-4 justify-between select-none z-50 relative">
        <div className="flex items-center space-x-4">
            <button
                onClick={handleCloseProject}
                className="flex items-center space-x-1 text-slate-400 hover:text-white hover:bg-slate-700 px-2 py-1.5 rounded transition-colors"
                title="Back to projects"
            >
                <ArrowLeft size={18} />
            </button>
            <button
                onClick={() => setShowProjectSettings(true)}
                className="flex items-center space-x-2 px-2 py-1.5 rounded hover:bg-slate-700 transition-colors group"
                title="Project Settings"
            >
                <h1
                    className="text-xl font-bold bg-clip-text text-transparent"
                    style={{
                      backgroundImage: `linear-gradient(to right, ${(activeProject.nameGradientColors ?? ['#e65161', '#f9c387'])[0]}, ${(activeProject.nameGradientColors ?? ['#e65161', '#f9c387'])[1]})`
                    }}
                >
                    {activeProject.name}
                </h1>
                <Settings size={15} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0" />
            </button>
        </div>

        <div />

        <div className="flex items-center space-x-3">
             <button
                onClick={() => setShowDebug(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Debug Console"
            >
                <Bug size={18} />
            </button>
             <button
                onClick={() => setShowHelp(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Help Guide"
            >
                <HelpCircle size={18} />
            </button>
             <button
                onClick={() => setShowHotkeysHelp(true)}
                className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
                title="Keyboard Shortcuts"
            >
                <Keyboard size={18} />
            </button>
        </div>
      </header>
      
      {/* Debug Modal */}
      {showDebug && (
          <div 
             className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
             onClick={() => setShowDebug(false)}
          >
              <div 
                  className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-2xl w-full h-[600px] flex flex-col p-6 relative"
                  onClick={(e) => e.stopPropagation()}
              >
                   <div className="flex justify-between items-center mb-4">
                       <h3 className="text-xl font-bold flex items-center gap-2"><Bug size={20} className="text-[#e65161]" /> Debug Console</h3>
                       <button onClick={() => setShowDebug(false)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                   </div>
                   <div className="flex-1 bg-slate-900 rounded p-4 overflow-y-auto font-mono text-sm border border-slate-700">
                       {debugLogs.length === 0 ? <span className="text-slate-500 italic">No logs yet...</span> : (
                           debugLogs.map((log, i) => (
                               <div key={i} className={`mb-1 ${log.type === 'error' ? 'text-red-400' : 'text-slate-300'}`}>
                                   <span className="text-slate-500 mr-2">[{log.time}]</span>
                                   {log.msg}
                               </div>
                           ))
                       )}
                   </div>
              </div>
          </div>
      )}

      {/* Help Modal */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-2xl w-full flex flex-col relative"
            style={{ maxHeight: '90vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex-none flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-700">
              <h3 className="text-xl font-bold text-[#e65161]">SeeNote Guide</h3>
              <button onClick={() => setShowHelp(false)} className="text-slate-400 hover:text-white">
                <X size={20} />
              </button>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 text-sm text-slate-300">

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Projects</h4>
                <p>
                  SeeNote is organized around <span className="text-white">projects</span>. Each project links an
                  <span className="text-white"> audio/video directory</span> (the files you want to annotate) to an
                  <span className="text-white"> annotation output directory</span> where label files are saved.
                </p>
                <p>
                  Create a project from the launch screen. You can configure the output format (Audacity .txt, CSV, or JSON) and
                  label categories in <span className="font-mono bg-slate-700 px-1 rounded">Project → Settings</span>.
                  All settings—including annotation tools and spectrogram display—persist per project.
                </p>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">File Panel</h4>
                <p>
                  The left panel lists every audio/video track in the project directory. Tracks with existing annotations show a
                  count badge. Click any track to open it, or use <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd+↑</kbd> /
                  <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd+↓</kbd> to step through tracks in order.
                  Right-click a track for options: reveal in Finder, reveal annotation file, or toggle shuffle mode.
                </p>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Spectrogram Navigation</h4>
                <ul className="space-y-1 list-none">
                  <li><span className="text-white">Pan:</span> Right-click &amp; drag, or scroll wheel.</li>
                  <li><span className="text-white">Zoom:</span> Cmd/Ctrl + scroll wheel.</li>
                  <li><span className="text-white">Seek:</span> Left-click on the spectrogram (in Selection Mode) to move the playhead.</li>
                  <li><span className="text-white">Play/Pause:</span> <kbd className="font-mono bg-slate-700 px-1 rounded">Space</kbd>.</li>
                </ul>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Two Modes: Selection vs. Annotation Tool</h4>
                <p>
                  The active annotation tool in the right-side palette controls the current mode.
                </p>
                <ul className="space-y-1.5 list-none">
                  <li>
                    <span className="text-white">Selection Mode</span> (no tool active — press <kbd className="font-mono bg-slate-700 px-1 rounded">Esc</kbd> to enter):
                    left-click &amp; drag creates a <span className="italic">selection region</span> shown as a shaded band.
                    Playback is bounded to that region. While a selection is active, pressing a tool key
                    (<kbd className="font-mono bg-slate-700 px-1 rounded">0</kbd>–<kbd className="font-mono bg-slate-700 px-1 rounded">9</kbd>) instantly
                    drops an annotation onto it.
                  </li>
                  <li>
                    <span className="text-white">Annotation Tool Mode</span> (a tool is active):
                    left-click &amp; drag directly creates an annotation with that tool's color and name.
                    Press a number key to switch tools, or <kbd className="font-mono bg-slate-700 px-1 rounded">Esc</kbd> to return to Selection Mode.
                  </li>
                </ul>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Annotations</h4>
                <ul className="space-y-1.5 list-none">
                  <li><span className="text-white">Create:</span> drag on the spectrogram while a category is active.</li>
                  <li><span className="text-white">Resize:</span> drag the left or right edge handle of any annotation.</li>
                  <li>
                    <span className="text-white">Bound selection:</span> click the center of an annotation to bind the selection region to it.
                    The playhead will loop within that annotation. Use <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd+←</kbd> /
                    <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd+→</kbd> (or the ‹ › buttons on the spectrogram) to jump between annotations.
                  </li>
                  <li><span className="text-white">Rename:</span> click the annotation's text to edit it inline. Key 0 (Custom Annotation Tool) annotations open for editing automatically.</li>
                  <li><span className="text-white">Delete:</span> select an annotation and press <kbd className="font-mono bg-slate-700 px-1 rounded">Delete</kbd> / <kbd className="font-mono bg-slate-700 px-1 rounded">Backspace</kbd>, or middle-click it directly.</li>
                  <li><span className="text-white">Undo/Redo:</span> <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd/Ctrl+Z</kbd> / <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd/Ctrl+Shift+Z</kbd>.</li>
                </ul>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Annotation Tools</h4>
                <p>
                  Annotation tools are named instruments bound to hotkeys <kbd className="font-mono bg-slate-700 px-1 rounded">0</kbd>–<kbd className="font-mono bg-slate-700 px-1 rounded">9</kbd>.
                  Key <kbd className="font-mono bg-slate-700 px-1 rounded">0</kbd> is always the Custom Annotation Tool—
                  annotations created with it open immediately for you to type a one-off name.
                </p>
                <p>
                  Click a tool name in the palette to rename it; all existing annotations created with that tool update automatically.
                  Use the <span className="font-mono bg-slate-700 px-1 rounded">+</span> button to add a tool, or the trash icon to remove one
                  (you can choose to convert its annotations to Custom or delete them outright).
                  Annotation tool configuration is saved per project.
                </p>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Auto-save &amp; Export</h4>
                <p>
                  Annotations are saved automatically to the project's annotation directory every time you make a change.
                  The file structure mirrors the audio directory. You can also export manually via the export button, which
                  writes the current file's annotations in the project's chosen format (Audacity .txt, CSV, or JSON).
                  Clearing all annotations from a file removes its annotation file.
                </p>
              </section>

            </div>

            {/* Footer */}
            <div className="flex-none px-6 py-3 border-t border-slate-700 flex justify-end">
              <button
                onClick={() => { setShowHelp(false); setShowHotkeysHelp(true); }}
                className="text-xs text-slate-400 hover:text-white transition-colors"
              >
                View keyboard shortcuts →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hotkey Help Modal */}
      {showHotkeysHelp && (
          <div
            className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
            onClick={() => setShowHotkeysHelp(false)}
          >
              <div
                className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-sm w-full flex flex-col relative"
                onClick={(e) => e.stopPropagation()}
              >
                  <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-slate-700">
                    <h3 className="text-lg font-bold">Keyboard Shortcuts</h3>
                    <button onClick={() => setShowHotkeysHelp(false)} className="text-slate-400 hover:text-white">
                      <X size={20} />
                    </button>
                  </div>

                  <div className="px-6 py-4 space-y-4 text-sm">
                    <div className="space-y-1.5">
                      <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Playback</p>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Space</span><span>Play / Pause</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">M</span><span>Mute / Unmute</span></div>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Spectrogram</p>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Right-drag / Scroll</span><span>Pan</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Cmd/Ctrl + Scroll</span><span>Zoom</span></div>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Navigation</p>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">← / →</span><span>Scrub playhead ±10% zoom</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Cmd+← / →</span><span>Previous / Next annotation</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Cmd+↑ / ↓</span><span>Previous / Next file</span></div>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Annotations</p>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">0 – 9</span><span>Set active annotation tool</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Esc</span><span>Selection Mode / clear selection</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Delete / Backspace</span><span>Delete selected annotation</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Middle-click</span><span>Delete annotation instantly</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Cmd/Ctrl+Z</span><span>Undo</span></div>
                      <div className="flex justify-between"><span className="font-mono text-slate-400">Cmd/Ctrl+Shift+Z</span><span>Redo</span></div>
                    </div>
                  </div>

                  <div className="px-6 py-3 border-t border-slate-700 flex justify-end">
                    <button
                      onClick={() => { setShowHotkeysHelp(false); setShowHelp(true); }}
                      className="text-xs text-slate-400 hover:text-white transition-colors"
                    >
                      Guide →
                    </button>
                  </div>
              </div>
          </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex relative overflow-hidden">
        {/* Left Panel: File Tree (top) + Labels Panel (bottom) */}
        {currentDirectory && (() => {
          const canAddTool = annotationTools.length < 10 && !isAddingTool;

          const fileTreeProps = {
            rootDirectory: currentDirectory,
            allFiles: displayQueue,
            currentFile: trackPath,
            onFileSelect: handleOpenFile,
            onToggleCollapse: () => setFilePanelCollapsed(c => !c),
            onNavigatePrev: () => navigateFile('prev'),
            onNavigateNext: () => navigateFile('next'),
            canNavigatePrev: currentFileIndex > 0,
            canNavigateNext: currentFileIndex < displayQueue.length - 1,
            shuffleMode,
            onToggleShuffle: toggleShuffle,
            annotatedFiles,
            hideAnnotated: activeProject?.hideAnnotated ?? false,
            onToggleHideAnnotated: handleToggleHideAnnotated,
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

              {/* Tool Panel */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center px-2 py-1.5 bg-slate-800 border-b border-slate-700 flex-none">
                  <span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium">Labels</span>
                </div>

                {/* Tool Grid */}
                <div className="flex-1 overflow-y-auto p-1.5 space-y-1">

                  {/* Row 1: Select (top-left) + Custom (top-right) — always 50:50 */}
                  <div className="flex gap-1">
                    {/* Select — wrapper provides the flex-1 so ToolCell's w-full fills half */}
                    <div className="flex-1 min-w-0">
                      <ToolCell
                        isActive={activeToolKey === null}
                        color="#374151"
                        dotColor="#94a3b8"
                        label="Select"
                        hotkey="Esc"
                        dotted
                        onClick={() => setActiveToolKey(null)}
                      />
                    </div>
                    {/* Custom (annotationTools[0]) */}
                    {(() => {
                      const custom = annotationTools[0];
                      const isActive = custom.key === activeToolKey;
                      const isEditing = editingToolIndex === 0;
                      if (isEditing) {
                        return (
                          <div className="flex-1 min-w-0 flex flex-col bg-slate-800 p-1 rounded border border-slate-600">
                            <input
                              autoFocus
                              className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded w-full outline-none border border-slate-600 focus:border-[#e65161]"
                              value={editingToolText}
                              onChange={e => setEditingToolText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEditingTool();
                                if (e.key === 'Escape') setEditingToolIndex(null);
                              }}
                              onBlur={saveEditingTool}
                            />
                            <span className="text-[8px] text-orange-400 mt-0.5">Updates all matching</span>
                          </div>
                        );
                      }
                      return (
                        <div className="flex-1 min-w-0">
                          <ToolCell
                            isActive={isActive}
                            color={custom.color}
                            dotColor="#94a3b8"
                            label="Custom"
                            hotkey={custom.key}
                            onClick={() => setActiveToolKey(prev => prev === custom.key ? null : custom.key)}
                          />
                        </div>
                      );
                    })()}
                  </div>

                  {/* Defined labels — single scrollable column */}
                  <div className="flex flex-col gap-1">
                    {annotationTools.slice(1).map((tool, i) => {
                      const idx = i + 1;
                      const isActive = tool.key === activeToolKey;
                      const isEditing = editingToolIndex === idx;

                      if (isEditing) {
                        return (
                          <div key={tool.key} className="flex flex-col bg-slate-800 p-1 rounded border border-slate-600">
                            <input
                              autoFocus
                              className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded w-full outline-none border border-slate-600 focus:border-[#e65161]"
                              value={editingToolText}
                              onChange={e => setEditingToolText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEditingTool();
                                if (e.key === 'Escape') setEditingToolIndex(null);
                              }}
                              onBlur={saveEditingTool}
                            />
                            <span className="text-[8px] text-orange-400 mt-0.5">Updates all matching</span>
                          </div>
                        );
                      }

                      return (
                        <div key={tool.key} className="relative group/cell overflow-hidden">
                          <ToolCell
                            isActive={isActive}
                            color={tool.color}
                            dotColor={tool.color}
                            label={tool.text}
                            hotkey={tool.key}
                            onClick={() => setActiveToolKey(prev => prev === tool.key ? null : tool.key)}
                          />
                          <div className="absolute top-0 right-0 flex opacity-0 group-hover/cell:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditingTool(idx); }}
                              className="text-blue-400 hover:text-blue-300 bg-slate-900/90 p-0.5 rounded-bl"
                              title="Rename"
                            >
                              <Pencil size={9} />
                            </button>
                            <button
                              onClick={(e) => handleDeleteTool(idx, e)}
                              className="text-red-500 hover:text-red-400 bg-slate-900/90 p-0.5 rounded-tr"
                              title="Delete"
                            >
                              <X size={9} />
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {/* Add label */}
                    {isAddingTool ? (
                      <div className="flex items-center bg-slate-800 rounded border border-slate-600 px-1.5 py-1 gap-1">
                        <div
                          className="w-3 h-3 rounded-full flex-none flex items-center justify-center"
                          style={{ backgroundColor: HOTKEY_COLORS[annotationTools.length] }}
                        >
                          <span className="text-white text-[8px] font-bold">{annotationTools.length}</span>
                        </div>
                        <input
                          autoFocus
                          type="text"
                          className="bg-transparent text-white text-xs outline-none flex-1 min-w-0"
                          placeholder="Name…"
                          value={newToolText}
                          onChange={(e) => setNewToolText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddTool();
                            if (e.key === 'Escape') setIsAddingTool(false);
                          }}
                          onBlur={handleAddTool}
                        />
                      </div>
                    ) : canAddTool ? (
                      <button
                        onClick={() => setIsAddingTool(true)}
                        className="w-full flex items-center justify-center py-1 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-400 transition-all opacity-50 hover:opacity-100"
                        title="Add Label"
                      >
                        <Plus size={11} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Right-edge width resize handle */}
              <div
                className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-20"
                onMouseDown={handleLeftPanelWidthDrag}
              />
            </div>
          );
        })()}

        {/* Right: video + spectrogram stacked */}
        <div className="flex-1 flex flex-col relative overflow-hidden">

        {/* Video Pane */}
        <div style={{ height: `${splitRatio * 100}%` }} className="bg-black relative flex">
             <div className="flex-1 relative bg-black flex justify-center items-center">
                 <VideoPlayer
                    ref={videoRef}
                    src={videoSrc}
                    volume={volume}
                    muted={true}          // engine handles all audio; video element is frames-only
                    isAudio={isAudioTrack}
                    onTimeUpdate={() => {}}
                    onDurationChange={setDuration}
                    onLoadedMetadata={() => {}}
                    onPlaying={() => {}}
                    onWaiting={() => {}}
                    onDebugLog={addLog}
                 />
                 {isProcessing && (
                     <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
                         <Loader2 className="animate-spin text-[#e65161] mb-2" size={48} />
                         <p className="text-[#e65161] font-medium">Processing Media...</p>
                         <p className="text-slate-400 text-sm mt-1">Generating Spectrogram</p>
                     </div>
                 )}
             </div>

        </div>

        {/* Resizer Handle */}
        <div 
            className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors z-10 flex justify-center items-center"
            onMouseDown={handleSplitDrag}
        >
            <div className="w-12 h-1 bg-slate-600 rounded-full" />
        </div>

        {/* Spectrogram Pane */}
        <div style={{ height: `${(1 - splitRatio) * 100}%` }} className="relative bg-slate-900 border-t border-slate-700 flex flex-col">
             
             {/* Settings Panel (Absolute, relative to spectrogram pane) */}
             {showSettings && (
                <div className="absolute top-10 right-4 z-40 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                    <div className="p-4 border-b border-slate-700 flex justify-between items-center sticky top-0 bg-slate-800 z-10">
                        <h3 className="font-semibold text-slate-200 flex items-center gap-2">
                            <AudioWaveform size={16} /> Spectrogram Settings
                        </h3>
                    </div>
                    
                    <div className="p-4 space-y-6">
                        {/* Visuals */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase">Visuals</h4>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">Brightness</label>
                                <input
                                    type="range" min="0.2" max="3.0" step="0.1"
                                    value={settings.intensity}
                                    onChange={(e) => setSettings({...settings, intensity: parseFloat(e.target.value)})}
                                    className="w-full accent-[#e65161]"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">Contrast</label>
                                <input
                                    type="range" min="0.4" max="2.4" step="0.1"
                                    value={settings.contrast}
                                    onChange={(e) => setSettings({...settings, contrast: parseFloat(e.target.value)})}
                                    className="w-full accent-[#e65161]"
                                />
                            </div>
                        </div>

                        {/* Frequency */}
                        <div className="space-y-3">
                            <h4 className="text-xs font-bold text-slate-500 uppercase">Frequency</h4>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">FFT Window Size</label>
                                <select
                                    value={settings.fftSize}
                                    onChange={(e) => setSettings({...settings, fftSize: parseInt(e.target.value)})}
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
                                    onChange={(e) => setSettings({...settings, frequencyScale: e.target.value as FrequencyScale})}
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
                                        onChange={(e) => setSettings({...settings, minFreq: Math.max(0, parseInt(e.target.value))})}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-xs text-slate-400">Max (Hz)</label>
                                    <input
                                        type="number"
                                        value={settings.maxFreq}
                                        onChange={(e) => setSettings({...settings, maxFreq: parseInt(e.target.value)})}
                                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
             )}

             {/* Playback toolbar */}
             <div className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 border-b border-slate-700 select-none z-40">
                 {/* Transport controls: [Start] [PrevAnnot] [Play] [NextAnnot] [End] */}
                 <button
                    onClick={() => seek(0, true)}
                    disabled={!videoSrc}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    title="Skip to start"
                >
                    <SkipBack size={15} />
                </button>
                <button
                    onClick={() => spectrogramRef.current?.goToPrevAnnotation()}
                    disabled={!videoSrc || !canGoPrevAnnotation}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    title="Previous annotation (Cmd+←  or  ;)"
                >
                    <ChevronLeft size={15} />
                </button>
                <button
                    onClick={togglePlay}
                    disabled={!videoSrc}
                    className="p-1.5 rounded-full bg-[#e65161] hover:bg-[#f06575] disabled:opacity-50 text-white transition-all shadow-lg flex-none mx-0.5"
                >
                    <span className="flex items-center justify-center w-4 h-4">
                        {isBuffering && !isPlaying
                            ? <Loader2 size={16} className="animate-spin" />
                            : isPlaying
                                ? <Pause size={16} fill="currentColor" />
                                : <Play size={16} fill="currentColor" />
                        }
                    </span>
                </button>
                <button
                    onClick={() => spectrogramRef.current?.goToNextAnnotation()}
                    disabled={!videoSrc || !canGoNextAnnotation}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    title="Next annotation (Cmd+→  or  ')"
                >
                    <ChevronRight size={15} />
                </button>
                <button
                    onClick={() => seek(duration, true)}
                    disabled={!videoSrc}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    title="Skip to end"
                >
                    <SkipForward size={15} />
                </button>

                {/* Volume Control */}
                <div className="flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600 ml-1">
                    <button onClick={() => setMuted(!muted)} className="text-slate-300 hover:text-white">
                        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <div className="relative w-20 h-5 flex items-center">
                        <input
                            type="range" min="0" max="4" step="0.05"
                            value={muted ? 0 : volume}
                            onChange={handleVolumeChange}
                            onPointerUp={(e) => {
                                const val = parseFloat((e.target as HTMLInputElement).value);
                                if (val > 0.9 && val < 1.1) { setVolume(1.0); setMuted(false); }
                            }}
                            className={`w-full h-1 bg-slate-500 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${isBoosted ? '[&::-webkit-slider-thumb]:bg-red-500' : '[&::-webkit-slider-thumb]:bg-[#e65161]'}`}
                            style={{
                                background: `linear-gradient(to right, ${isBoosted ? '#ef4444' : '#e65161'} 0%, ${isBoosted ? '#ef4444' : '#e65161'} ${(Math.min(1, volume) / 4) * 100}%, ${isBoosted ? '#ef4444' : 'transparent'} ${(Math.min(1, volume) / 4) * 100}%, ${isBoosted ? '#ef4444' : 'transparent'} ${(volume / 4) * 100}%, #64748b ${(volume / 4) * 100}%, #64748b 100%)`
                            }}
                        />
                        {/* Hash mark at 1.0 (default volume). Positioned to match the thumb center:
                            left = (1/4) * (trackWidth - thumbWidth) + thumbRadius
                                 = (trackWidth - 12px) * 0.25 + 6px = calc(25% - 3px + 6px) */}
                        <div className="absolute top-0 bottom-0 w-[1px] bg-white/30 pointer-events-none" style={{ left: 'calc((100% - 12px) * 0.25 + 6px)' }}></div>
                    </div>
                </div>

                {/* Time display — click any value to edit */}
                <div className="flex flex-col justify-center flex-none ml-2 tabular-nums leading-tight gap-0.5">
                    {editingTimeField === 'time' ? (
                        <input
                            autoFocus
                            className="text-sm font-mono font-medium text-white bg-slate-700 border border-[#e65161] rounded px-1 w-20 outline-none"
                            value={editingTimeRaw}
                            onChange={e => setEditingTimeRaw(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                                if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(""); }
                            }}
                            onBlur={() => commitTimeEdit(editingTimeRaw)}
                        />
                    ) : (
                        <button
                            className="text-sm font-mono font-medium text-slate-300 hover:text-white text-left"
                            title="Click to jump to time"
                            onClick={() => { setEditingTimeField('time'); setEditingTimeRaw(currentTime.toFixed(2)); }}
                        >
                            {currentTime.toFixed(2)}s
                        </button>
                    )}
                    {selectionRegion && (
                        <div className="flex items-center gap-1 text-[10px] font-mono text-slate-400">
                            {editingTimeField === 'selStart' ? (
                                <input
                                    autoFocus
                                    className="text-[10px] font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1 w-14 outline-none"
                                    value={editingTimeRaw}
                                    onChange={e => setEditingTimeRaw(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                                        if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(""); }
                                    }}
                                    onBlur={() => commitTimeEdit(editingTimeRaw)}
                                />
                            ) : (
                                <button className="hover:text-white" title="Edit selection start" onClick={() => { setEditingTimeField('selStart'); setEditingTimeRaw(selectionRegion.start.toFixed(2)); }}>
                                    {selectionRegion.start.toFixed(2)}
                                </button>
                            )}
                            <span>→</span>
                            {editingTimeField === 'selEnd' ? (
                                <input
                                    autoFocus
                                    className="text-[10px] font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1 w-14 outline-none"
                                    value={editingTimeRaw}
                                    onChange={e => setEditingTimeRaw(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                                        if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(""); }
                                    }}
                                    onBlur={() => commitTimeEdit(editingTimeRaw)}
                                />
                            ) : (
                                <button className="hover:text-white" title="Edit selection end" onClick={() => { setEditingTimeField('selEnd'); setEditingTimeRaw(selectionRegion.end.toFixed(2)); }}>
                                    {selectionRegion.end.toFixed(2)}
                                </button>
                            )}
                            <span>(</span>
                            {editingTimeField === 'selDur' ? (
                                <input
                                    autoFocus
                                    className="text-[10px] font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1 w-14 outline-none"
                                    value={editingTimeRaw}
                                    onChange={e => setEditingTimeRaw(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                                        if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(""); }
                                    }}
                                    onBlur={() => commitTimeEdit(editingTimeRaw)}
                                />
                            ) : (
                                <button className="hover:text-white" title="Edit selection duration" onClick={() => { setEditingTimeField('selDur'); setEditingTimeRaw((selectionRegion.end - selectionRegion.start).toFixed(2)); }}>
                                    {(selectionRegion.end - selectionRegion.start).toFixed(2)}s
                                </button>
                            )}
                            <span>)</span>
                        </div>
                    )}
                </div>

                {/* Spectrogram Settings */}
                <div className="ml-auto">
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
                        title="Spectrogram Settings"
                    >
                        <Settings size={16} />
                    </button>
                </div>
             </div>

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
                fileIdent={fileIdent}
                settings={settings}
                zoomSec={zoomSec}
                annotations={annotations}
                selectedAnnotationId={selectedAnnotationId}
                activeAnnotationTool={activeToolKey !== null ? (annotationTools.find(t => t.key === activeToolKey) ?? null) : null}
                annotationTools={annotationTools}
                selectionRegion={selectionRegion}
                boundAnnotationId={boundAnnotationId}
                onSeek={seek}
                onAnnotationsChange={handleAnnotationsChange}
                onAnnotationsCommit={handleAnnotationsCommit}
                onSelectAnnotation={setSelectedAnnotationId}
                onSelectionChange={setSelectionRegion}
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
          project={activeProject}
          onSave={handleProjectSettingsSaved}
          onClose={() => setShowProjectSettings(false)}
        />
      )}
    </div>
  );
}