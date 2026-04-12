import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Pause, Settings, Loader2, Volume2, VolumeX, Keyboard, Plus, X, HelpCircle, AudioWaveform, Bug, Pencil, ArrowLeft, ChevronLeft, ChevronRight, SkipBack, SkipForward } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import LaunchScreen from './components/LaunchScreen';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import { Label, SpectrogramSettings, LabelConfig, FrequencyScale, Project } from './types';
import { DEFAULT_ZOOM_SEC, DEFAULT_LABEL_CONFIGS, HOTKEY_COLORS } from './constants';
import { formatTime, exportToCSV, exportToAudacity, exportToJSON, generateAudacityContent, generateCSVContent, generateJSONContent } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, readTextFile, writeTextFile, removeFile, toAssetUrl } from './utils/tauriCommands';
import { useProjects } from './hooks/useProjects';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { revealInFinder, listAnnotationFiles } from './utils/projectCommands';
import { AudioEngine } from './utils/AudioEngine';

export default function App() {
  // Media State
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFileName, setVideoFileName] = useState<string>("video");
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState<string | null>(null);
  const [isAudioFile, setIsAudioFile] = useState(false);
  const [sampleRate, setSampleRate] = useState(44100);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [allMediaFiles, setAllMediaFiles] = useState<string[]>([]);
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);

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

  // Undo/redo history for labels
  const labelsHistoryRef = useRef<Label[][]>([[]]);
  const historyIndexRef = useRef<number>(0);

  // Chunk cache ref — not state, to avoid re-renders on every chunk load
  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  
  // Volume: 0 to 4 (400% or +12dB approx)
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Annotation State
  const [labels, setLabels] = useState<Label[]>([]);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const [labelConfigs, setLabelConfigs] = useState<LabelConfig[]>(DEFAULT_LABEL_CONFIGS);
  // null = Selection Mode (no label config active); string key of the active config otherwise.
  const [activeLabelKey, setActiveLabelKey] = useState<string | null>(null);

  // Selection region for Selection Mode playback and UI
  const [selectionRegion, setSelectionRegion] = useState<{ start: number; end: number } | null>(null);
  const selectionRegionRef = useRef<{ start: number; end: number } | null>(null);

  // Label Editing State
  const [editingLabelIndex, setEditingLabelIndex] = useState<number | null>(null);
  const [editingLabelText, setEditingLabelText] = useState("");

  // Toolbar timestamp editing state
  type TimeField = 'time' | 'selStart' | 'selEnd' | 'selDur';
  const [editingTimeField, setEditingTimeField] = useState<TimeField | null>(null);
  const [editingTimeRaw, setEditingTimeRaw] = useState("");
  
  // Ref that stays in sync with activeProject — avoids stale-closure bugs in persist effects
  const activeProjectRef = useRef<typeof activeProject>(null);
  useEffect(() => { activeProjectRef.current = activeProject; }, [activeProject]);

  // Keep activeProject in sync with the projects list so that activeProjectRef.current
  // always has the latest saved data. Without this, interleaved persist effects (labelConfigs
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
  // Ref so the onEnded closure (created once on mount) can read current isAudioFile
  const isAudioFileRef = useRef(false);

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
        if (!isAudioFileRef.current) {
          videoRef.current?.pause();
        }
        if (sel) {
          engineRef.current?.seek(sel.start);
          setCurrentTime(sel.start);
        }
        setIsPlaying(false);
      },
      onBufferUnderrun: () => setIsBuffering(true),
    });
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // UI State
  const videoRef = useRef<HTMLVideoElement>(null);
  const [splitRatio, setSplitRatio] = useState(0.5); 
  const [showSettings, setShowSettings] = useState(false);
  const [showHotkeysHelp, setShowHotkeysHelp] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);
  const [isAddingLabel, setIsAddingLabel] = useState(false);
  const [newLabelText, setNewLabelText] = useState("");
  
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

  // Keep isAudioFileRef in sync so the onEnded closure (created once on mount) reads the current value
  useEffect(() => { isAudioFileRef.current = isAudioFile; }, [isAudioFile]);

  // Video-frame sync loop — video files only.
  // The AudioEngine's onTimeUpdate callback drives setCurrentTime for all files.
  // This loop keeps video.currentTime in sync with the engine's audio clock so
  // that video frames align with the audio the engine is producing.
  useEffect(() => {
    if (isAudioFile || !isPlaying) return;

    let rAF: number;
    const loop = () => {
        if (!videoRef.current || !engineRef.current) return;
        const engineTime = engineRef.current.getMediaTime();
        if (Math.abs(videoRef.current.currentTime - engineTime) > 0.05) {
            videoRef.current.currentTime = engineTime;
        }
        rAF = requestAnimationFrame(loop);
    };

    loop();

    return () => {
        if (rAF) cancelAnimationFrame(rAF);
    };
  }, [isPlaying, isAudioFile]);

  // Open a file by absolute path (called from button or FileBrowser)
  const handleOpenFile = useCallback(async (absolutePath: string) => {
    setLabels([]);
    setIsPlaying(false);
    setSelectedLabelId(null);
    setSelectionRegion(null);
    setDebugLogs([]);
    setCurrentFilePath(absolutePath);
    // Reset playhead to beginning of file
    setCurrentTime(0);
    if (videoRef.current) videoRef.current.currentTime = 0;
    // Reset undo/redo history for new file
    labelsHistoryRef.current = [[]];
    historyIndexRef.current = 0;

    const fileName = absolutePath.split('/').pop() ?? absolutePath;
    const audioExts = ['mp3', 'flac', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'wma'];
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    const isAudio = audioExts.includes(ext);
    setIsAudioFile(isAudio);
    setVideoFileName(fileName);

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
    } finally {
        setIsProcessing(false);
    }
  }, [settings.fftSize]);

  // Rebuild cache when FFT size changes while a file is open
  useEffect(() => {
    if (!currentFilePath || !sampleRate || !duration) return;
    const cache = new MultiTierSpectrogramCache(
      currentFilePath,
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
    if (!currentFilePath) return -1;
    return displayQueueIndex.get(currentFilePath) ?? -1;
  }, [currentFilePath, displayQueueIndex]);

  const navigateFile = useCallback((direction: 'prev' | 'next') => {
    if (displayQueue.length === 0) return;
    let idx = currentFileIndex;
    if (direction === 'prev') idx = Math.max(0, idx - 1);
    else idx = Math.min(displayQueue.length - 1, idx + 1);
    if (idx >= 0 && idx < displayQueue.length && displayQueue[idx] !== currentFilePath) {
        handleOpenFile(displayQueue[idx]);
    }
  }, [displayQueue, currentFileIndex, currentFilePath, handleOpenFile]);

  // Annotation navigation helpers (used by toolbar buttons and keyboard shortcuts)
  const sortedLabels = useMemo(() => [...labels].sort((a, b) => a.start - b.start), [labels]);
  const canGoPrevAnnotation = useMemo(
    () => sortedLabels.some(l => l.start < currentTime - 0.05),
    [sortedLabels, currentTime]
  );
  const canGoNextAnnotation = useMemo(
    () => sortedLabels.some(l => l.start > currentTime + 0.05),
    [sortedLabels, currentTime]
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

  // Ident: relative path from audio root to file, without extension
  const fileIdent = useMemo(() => {
    if (!currentFilePath || !currentDirectory) return null;
    const rel = currentFilePath.substring(currentDirectory.length + 1);
    return rel.replace(/\.[^/.]+$/, '');
  }, [currentFilePath, currentDirectory]);

  // Label history helpers
  const pushToHistory = useCallback((newLabels: Label[]) => {
    labelsHistoryRef.current = labelsHistoryRef.current.slice(0, historyIndexRef.current + 1);
    labelsHistoryRef.current.push(newLabels);
    historyIndexRef.current = labelsHistoryRef.current.length - 1;
  }, []);

  // Intermediate update — no history entry (called during drags/resizes/text edits)
  const handleLabelsChange = useCallback((newLabels: Label[]) => {
    setLabels(newLabels);
  }, []);

  // Final update — pushes to history (called on mouse release, delete, etc.)
  const handleLabelsCommit = useCallback((newLabels: Label[]) => {
    setLabels(newLabels);
    pushToHistory(newLabels);
  }, [pushToHistory]);

  const undoLabels = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    setLabels(labelsHistoryRef.current[historyIndexRef.current]);
  }, []);

  const redoLabels = useCallback(() => {
    if (historyIndexRef.current >= labelsHistoryRef.current.length - 1) return;
    historyIndexRef.current++;
    setLabels(labelsHistoryRef.current[historyIndexRef.current]);
  }, []);

  // Persist label configs and spectrogram settings to active project whenever they change
  const labelConfigPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeProject) return;
    // Skip persistence when switching projects (avoids overwriting with stale configs)
    if (prevProjectIdRef.current !== activeProject.id) {
      prevProjectIdRef.current = activeProject.id;
      return;
    }
    if (labelConfigPersistRef.current) clearTimeout(labelConfigPersistRef.current);
    labelConfigPersistRef.current = setTimeout(() => {
      if (!activeProjectRef.current) return;
      updateProject({ ...activeProjectRef.current, labelConfigs });
    }, 500);
    return () => {
      if (labelConfigPersistRef.current) clearTimeout(labelConfigPersistRef.current);
    };
  }, [labelConfigs]);

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
  const getAnnotationPath = useCallback((audioPath: string): string | null => {
    if (!annotationDirectory || !currentDirectory) return null;
    const rel = audioPath.substring(currentDirectory.length);
    const withoutExt = rel.replace(/\.[^/.]+$/, '');
    const ext = exportFormat === 'json' ? '.json' : exportFormat === 'csv' ? '.csv' : '.txt';
    return annotationDirectory + withoutExt + ext;
  }, [annotationDirectory, currentDirectory, exportFormat]);

  // Auto-save annotations on every label change
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutoSaveRef = useRef(false);
  useEffect(() => {
    if (!currentFilePath || !annotationDirectory) return;
    const annotPath = getAnnotationPath(currentFilePath);
    if (!annotPath) return;

    // Debounce saves by 300ms
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = setTimeout(async () => {
      if (skipAutoSaveRef.current) return;
      try {
        if (labels.length === 0) {
          await removeFile(annotPath);
          setAnnotatedFiles(prev => {
            const next = new Set(prev);
            next.delete(currentFilePath);
            return next;
          });
          return;
        }
        let content: string;
        if (exportFormat === 'json') content = generateJSONContent(labels);
        else if (exportFormat === 'csv') content = generateCSVContent(labels);
        else content = generateAudacityContent(labels);
        await writeTextFile(annotPath, content);
        setAnnotatedFiles(prev => {
            const next = new Set(prev);
            next.add(currentFilePath);
            return next;
          });
      } catch (err) {
        addLog(`Auto-save error: ${err}`, 'error');
      }
    }, 300);

    return () => {
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    };
  }, [labels, currentFilePath, annotationDirectory, getAnnotationPath]);

  // Auto-load annotations when the current file or annotation directory changes
  useEffect(() => {
    if (!currentFilePath || !annotationDirectory || !currentDirectory) return;
    const annotPath = getAnnotationPath(currentFilePath);
    if (!annotPath) return;

    (async () => {
      try {
        const content = await readTextFile(annotPath);
        if (!content) return;

        const loaded: Label[] = [];

        if (exportFormat === 'json') {
          const parsed = JSON.parse(content) as Label[];
          parsed.forEach(l => {
            const matchedConfig = labelConfigs.find(c => c.text === l.text);
            loaded.push({
              ...l,
              id: Math.random().toString(36).substring(2, 9),
              configId: matchedConfig?.key ?? l.configId ?? '0',
              color: matchedConfig?.color ?? l.color ?? '#ffffff',
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
                const matchedConfig = labelConfigs.find(c => c.text === text);
                loaded.push({ id: Math.random().toString(36).substring(2, 9), configId: matchedConfig?.key ?? '0', start, end, text, color: matchedConfig?.color ?? '#ffffff' });
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
                const matchedConfig = labelConfigs.find(c => c.text === text);
                loaded.push({ id: Math.random().toString(36).substring(2, 9), configId: matchedConfig?.key ?? '0', start, end, text, color: matchedConfig?.color ?? '#ffffff' });
              }
            }
          }
        }

        if (loaded.length > 0) {
          skipAutoSaveRef.current = true;
          setLabels(loaded);
          labelsHistoryRef.current = [loaded];
          historyIndexRef.current = 0;
          addLog(`Loaded ${loaded.length} annotations`);
          setTimeout(() => { skipAutoSaveRef.current = false; }, 500);
        }
      } catch (err) {
        addLog(`Error loading annotations: ${err}`, 'error');
      }
    })();
  }, [currentFilePath, annotationDirectory]);

  const handleOpenProject = useCallback(async (project: Project) => {
    await touchLastOpened(project.id);
    // Set activeProject in the same React batch as labelConfigs/settings so the
    // persist-effect guard (prevProjectIdRef) sees the new project immediately and
    // correctly skips the load-triggered changes.
    setActiveProject(project);
    setLabelConfigs(project.labelConfigs.length > 0 ? project.labelConfigs : DEFAULT_LABEL_CONFIGS);
    if (project.spectrogramSettings) {
      setSettings(project.spectrogramSettings);
    }
    setCurrentDirectory(project.audioDirectory);
    setAnnotatedFiles(new Set());
    setLabels([]);
    setCurrentFilePath(null);
    setVideoSrc(null);
    labelsHistoryRef.current = [[]];
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
    setLabelConfigs(updated.labelConfigs.length > 0 ? updated.labelConfigs : DEFAULT_LABEL_CONFIGS);
    if (audioDirChanged) {
      setCurrentDirectory(updated.audioDirectory);
      setCurrentFilePath(null);
      setVideoSrc(null);
      setLabels([]);
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

  const handleToggleHideAnnotated = useCallback(() => {
    if (!activeProject) return;
    updateProject({ ...activeProject, hideAnnotated: !activeProject.hideAnnotated });
  }, [activeProject, updateProject]);

  const handleRevealInFinder = useCallback((path: string) => {
    revealInFinder(path).catch(err => addLog(`reveal_in_finder error: ${err}`, 'error'));
  }, []);

  const handleRevealAnnotations = useCallback((audioFilePath: string) => {
    // If path is not in the known audio files list, treat as a directory
    if (!allMediaFiles.includes(audioFilePath)) {
      if (annotationDirectory) revealInFinder(annotationDirectory).catch(() => {});
      return;
    }
    const annotPath = getAnnotationPath(audioFilePath);
    if (annotPath) {
      revealInFinder(annotPath).catch(() => {
        if (annotationDirectory) revealInFinder(annotationDirectory).catch(() => {});
      });
    } else if (annotationDirectory) {
      revealInFinder(annotationDirectory).catch(() => {});
    }
  }, [allMediaFiles, getAnnotationPath, annotationDirectory]);

  const togglePlay = useCallback(() => {
      if (isPlaying || isBuffering) {
          engineRef.current?.pause();
          // For video files, also pause the video element (audio engine fires onPaused
          // which sets isPlaying=false; we stop the frame track here).
          if (!isAudioFile) videoRef.current?.pause();
      } else {
          const sel = selectionRegionRef.current;
          let startSec = currentTime;
          // If there's a selection and the playhead is outside it, restart from selection start
          if (sel && (currentTime >= sel.end - 0.05 || currentTime < sel.start)) {
              startSec = sel.start;
              setCurrentTime(sel.start);
          }
          setIsBuffering(true);
          // isPlaying is set to true only when onPlaying fires (first sample emitted).
          // endSec enables sample-accurate selection stop.
          engineRef.current?.play(startSec, sel ? sel.end : undefined);
          // For video files, start the video element for frame display (muted — audio
          // comes from the engine). Seek it to startSec first for frame sync.
          if (!isAudioFile && videoRef.current) {
              videoRef.current.currentTime = startSec;
              videoRef.current.play().catch(() => {});
          }
      }
  }, [isPlaying, isBuffering, isAudioFile, currentTime]);

  const seek = useCallback((time: number) => {
      engineRef.current?.seek(time);
      setCurrentTime(time);
      // Keep video frames in sync for video files
      if (!isAudioFile && videoRef.current) {
          videoRef.current.currentTime = time;
      }
  }, [isAudioFile]);

  // Global Hotkeys
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;

          // Undo / Redo
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
              e.preventDefault();
              if (e.shiftKey) redoLabels();
              else undoLabels();
              return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
              e.preventDefault();
              redoLabels();
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
                  setActiveLabelKey(null);
                  break;
              case 'delete':
              case 'backspace':
                  if (selectedLabelId) {
                      handleLabelsCommit(labels.filter(l => l.id !== selectedLabelId));
                      setSelectedLabelId(null);
                  }
                  break;
          }

          // Hotkey Numbers (0-9)
          if (/^[0-9]$/.test(e.key)) {
              const key = e.key;
              const config = labelConfigs.find(c => c.key === key);
              if (config) {
                  // If in selection mode with an active selection, drop a label onto it
                  if (activeLabelKey === null && selectionRegion !== null) {
                      const id = Math.random().toString(36).substr(2, 9);
                      const isCustom = config.key === '0';
                      const newLabel: Label = {
                          id,
                          configId: config.key,
                          start: selectionRegion.start,
                          end: selectionRegion.end,
                          text: isCustom ? '' : config.text,
                          color: config.color,
                      };
                      handleLabelsCommit([...labels, newLabel]);
                      setSelectedLabelId(id);
                      setSelectionRegion(null);
                      setActiveLabelKey(key);
                  } else {
                      setActiveLabelKey(prev => prev === key ? null : key);
                  }
              }
          }

      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, selectedLabelId, labelConfigs, navigateFile, undoLabels, redoLabels, handleLabelsCommit, labels, activeLabelKey, selectionRegion, seek, currentTime, zoomSec, duration]);

  const performExport = async () => {
      if (labels.length === 0) return;
      if (exportFormat === 'json') {
          await exportToJSON(labels, videoFileName, currentFilePath);
      } else if (exportFormat === 'csv') {
          await exportToCSV(labels, videoFileName, currentFilePath);
      } else {
          await exportToAudacity(labels, videoFileName, currentFilePath);
      }
      addLog(`Exported annotations as ${exportFormat.toUpperCase()}`);
  };

  const handleAddLabelConfig = () => {
      if (newLabelText.trim() === "") {
          setIsAddingLabel(false);
          return;
      }
      
      const nextIndex = labelConfigs.length;
      if (nextIndex >= 10) {
          alert("Maximum of 10 hotkey labels (0-9) allowed.");
          setIsAddingLabel(false);
          setNewLabelText("");
          return;
      }
      
      const newConfig: LabelConfig = {
          key: nextIndex.toString(),
          text: newLabelText,
          color: HOTKEY_COLORS[nextIndex]
      };
      
      setLabelConfigs([...labelConfigs, newConfig]);
      setIsAddingLabel(false);
      setNewLabelText("");
      // Auto-select the newly created label config
      setActiveLabelKey(newConfig.key);
      addLog(`Added category: ${newLabelText} (${nextIndex})`);
  };

  const startEditingCategory = (idx: number) => {
      setEditingLabelIndex(idx);
      setEditingLabelText(labelConfigs[idx].text);
  };

  const saveEditingCategory = () => {
      if (editingLabelIndex === null) return;
      
      const idx = editingLabelIndex;
      const config = labelConfigs[idx];
      const newName = editingLabelText.trim();
      
      if (newName && newName !== config.text) {
          // Update Config
          const updatedConfigs = [...labelConfigs];
          updatedConfigs[idx] = { ...config, text: newName };
          setLabelConfigs(updatedConfigs);

          // Update ALL labels with this configId
          const updatedLabels = labels.map(l => {
              if (l.configId === config.key) {
                  return { ...l, text: newName };
              }
              return l;
          });
          setLabels(updatedLabels);
          addLog(`Renamed category ${config.text} -> ${newName}. Updated linked events.`);
      }

      setEditingLabelIndex(null);
      setEditingLabelText("");
  };

  const handleDeleteCategory = (idx: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (idx === 0) return; // Cannot delete Custom Label

      const config = labelConfigs[idx];
      const linkedLabels = labels.filter(l => l.configId === config.key);
      
      if (linkedLabels.length > 0) {
          // Prompt
          const choice = confirm(
              `Deleting category "${config.text}" which is used by ${linkedLabels.length} events.\n\n` +
              `OK: Convert events to Custom Labels (White)\n` +
              `Cancel: Delete all ${linkedLabels.length} events`
          );
          
          if (choice) {
              // Convert
              const updatedLabels = labels.map(l => {
                  if (l.configId === config.key) {
                      return { ...l, configId: "0", color: "#ffffff" };
                  }
                  return l;
              });
              setLabels(updatedLabels);
              addLog(`Deleted category ${config.text}. Converted events to Custom.`);
          } else {
              // Delete
              const updatedLabels = labels.filter(l => l.configId !== config.key);
              setLabels(updatedLabels);
              addLog(`Deleted category ${config.text} and all linked events.`);
          }
      } else {
          addLog(`Deleted category ${config.text} (unused).`);
      }

      // Remove Config
      const newConfigs = labelConfigs.filter((_, i) => i !== idx);
      // Re-index keys? No, keeping keys stable is safer for now, but UI shows 0-9. 
      // Re-indexing is expected behavior for "Hotkeys 0-9".
      const reindexed = newConfigs.map((c, i) => ({ ...c, key: i.toString(), color: HOTKEY_COLORS[i] }));
      
      setLabelConfigs(reindexed);
      setActiveLabelKey('0');
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
        seek(clamped);
        spectrogramRef.current?.scrollToTime(clamped);
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
                onClick={() => setActiveProject(null)}
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
                  All settings—including label categories and spectrogram display—persist per project.
                </p>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">File Tree</h4>
                <p>
                  The left sidebar lists every audio/video file in the project directory. Files with existing annotations show a
                  count badge. Click any file to open it, or use <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd+↑</kbd> /
                  <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd+↓</kbd> to step through files in order.
                  Right-click a file for options: reveal in Finder, reveal annotation file, or toggle shuffle mode.
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
                <h4 className="font-semibold text-white text-base">Two Modes: Selection vs. Label</h4>
                <p>
                  The active label category in the right-side palette controls the current mode.
                </p>
                <ul className="space-y-1.5 list-none">
                  <li>
                    <span className="text-white">Selection Mode</span> (no category active — press <kbd className="font-mono bg-slate-700 px-1 rounded">Esc</kbd> to enter):
                    left-click &amp; drag creates a <span className="italic">selection region</span> shown as a shaded band.
                    Playback is bounded to that region. While a selection is active, pressing a category key
                    (<kbd className="font-mono bg-slate-700 px-1 rounded">0</kbd>–<kbd className="font-mono bg-slate-700 px-1 rounded">9</kbd>) instantly
                    drops an annotation onto it.
                  </li>
                  <li>
                    <span className="text-white">Label Mode</span> (a category is active):
                    left-click &amp; drag directly creates an annotation with that category's color and name.
                    Press a number key to switch categories, or <kbd className="font-mono bg-slate-700 px-1 rounded">Esc</kbd> to return to Selection Mode.
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
                  <li><span className="text-white">Rename:</span> click the annotation's text label to edit it inline. Key 0 (Custom Label) annotations open for editing automatically.</li>
                  <li><span className="text-white">Delete:</span> select an annotation and press <kbd className="font-mono bg-slate-700 px-1 rounded">Delete</kbd> / <kbd className="font-mono bg-slate-700 px-1 rounded">Backspace</kbd>, or middle-click it directly.</li>
                  <li><span className="text-white">Undo/Redo:</span> <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd/Ctrl+Z</kbd> / <kbd className="font-mono bg-slate-700 px-1 rounded">Cmd/Ctrl+Shift+Z</kbd>.</li>
                </ul>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold text-white text-base">Label Categories</h4>
                <p>
                  Categories are named classes bound to hotkeys <kbd className="font-mono bg-slate-700 px-1 rounded">0</kbd>–<kbd className="font-mono bg-slate-700 px-1 rounded">9</kbd>.
                  Key <kbd className="font-mono bg-slate-700 px-1 rounded">0</kbd> is always "Custom Label"—
                  annotations created with it open immediately for you to type a one-off name.
                </p>
                <p>
                  Click a category name in the palette to rename it; all existing annotations with that category update automatically.
                  Use the <span className="font-mono bg-slate-700 px-1 rounded">+</span> button to add a category, or the trash icon to remove one
                  (you can choose to convert its annotations to Custom Labels or delete them outright).
                  Category configuration is saved per project.
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
                      <div className="flex justify-between"><span className="font-mono text-slate-400">0 – 9</span><span>Set active label category</span></div>
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
        {/* File Tree Sidebar */}
        {currentDirectory && (
            <FileTree
                rootDirectory={currentDirectory}
                allFiles={displayQueue}
                currentFile={currentFilePath}
                onFileSelect={handleOpenFile}
                collapsed={fileTreeCollapsed}
                onToggleCollapse={() => setFileTreeCollapsed(c => !c)}
                onNavigatePrev={() => navigateFile('prev')}
                onNavigateNext={() => navigateFile('next')}
                canNavigatePrev={currentFileIndex > 0}
                canNavigateNext={currentFileIndex < displayQueue.length - 1}
                shuffleMode={shuffleMode}
                onToggleShuffle={toggleShuffle}
                annotatedFiles={annotatedFiles}
                hideAnnotated={activeProject?.hideAnnotated ?? false}
                onToggleHideAnnotated={handleToggleHideAnnotated}
                onRevealInFinder={handleRevealInFinder}
                onRevealAnnotations={handleRevealAnnotations}
                onRefresh={handleRefreshFiles}
            />
        )}

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
                    isAudio={isAudioFile}
                    onTimeUpdate={() => {}}
                    onDurationChange={setDuration}
                    onLoadedMetadata={() => {}}
                    onPlaying={() => {}}
                    onWaiting={() => {}}
                 />
                 {isProcessing && (
                     <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
                         <Loader2 className="animate-spin text-[#e65161] mb-2" size={48} />
                         <p className="text-[#e65161] font-medium">Processing Media...</p>
                         <p className="text-slate-400 text-sm mt-1">Generating Spectrogram</p>
                     </div>
                 )}
             </div>

             {/* Right-Side Label Palette Overlay */}
             <div className="absolute top-4 right-4 bottom-4 w-64 flex flex-col items-end pointer-events-none z-30 space-y-2">
                 {/* Label List */}
                 <div className="w-full flex flex-col items-end space-y-2 pointer-events-auto overflow-y-auto pr-2 custom-scrollbar max-h-full py-2">
                     {labelConfigs.map((cfg, idx) => {
                         const isActive = cfg.key === activeLabelKey;
                         const isDefault = idx === 0;
                         const isEditing = editingLabelIndex === idx;

                         if (isEditing) {
                            return (
                                <div key={cfg.key} className="flex flex-col items-end animate-in fade-in slide-in-from-right-2 mb-2 bg-slate-800 p-2 rounded border border-slate-600 shadow-xl z-50 w-full max-w-[220px]">
                                    <input 
                                       autoFocus
                                       className="bg-slate-700 text-white text-sm px-2 py-1 rounded w-full outline-none border border-slate-600 focus:border-[#e65161]" 
                                       value={editingLabelText}
                                       onChange={e => setEditingLabelText(e.target.value)}
                                       onKeyDown={(e) => {
                                           if (e.key === 'Enter') saveEditingCategory();
                                           if (e.key === 'Escape') setEditingLabelIndex(null);
                                       }}
                                       onBlur={saveEditingCategory}
                                    />
                                    <span className="text-[10px] text-orange-400 mt-1 w-full text-right font-medium">Renaming updates all matching labels</span>
                                </div>
                            );
                         }

                         return (
                            <div key={cfg.key} className="flex items-center justify-end group/item gap-2 w-full">
                                {/* Buttons container - appear to the left of label */}
                                {!isDefault && (
                                     <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                                         <button 
                                            onClick={(e) => handleDeleteCategory(idx, e)}
                                            className="text-red-500 hover:text-red-400 bg-black/80 rounded-full p-1.5 shadow-md hover:scale-110 transition-transform"
                                            title="Delete Category"
                                        >
                                            <X size={14} />
                                        </button>
                                         <button 
                                            onClick={(e) => { e.stopPropagation(); startEditingCategory(idx); }}
                                            className="text-blue-400 hover:text-blue-300 bg-black/80 rounded-full p-1.5 shadow-md hover:scale-110 transition-transform"
                                            title="Rename Category"
                                        >
                                            <Pencil size={14} />
                                        </button>
                                    </div>
                                )}
                                
                                <button
                                    onClick={() => setActiveLabelKey(prev => prev === cfg.key ? null : cfg.key)}
                                    className={`
                                        relative flex items-center justify-between px-3 py-1.5 rounded-lg transition-all border
                                        ${isActive ? 'opacity-100 ring-2 ring-white scale-105' : 'opacity-70 hover:opacity-100'}
                                    `}
                                    style={{ 
                                        backgroundColor: cfg.color, 
                                        borderColor: isDefault ? '#4b5563' : cfg.color, 
                                        minWidth: '100px', // Minimum width for touch target
                                        maxWidth: '100%'     // Allow growing based on text
                                    }}
                                >
                                    <span 
                                        className={`text-sm font-medium ${isDefault ? 'text-black' : 'text-white'} truncate text-left mr-2`}
                                        title={isDefault ? "Custom Label" : cfg.text}
                                    >
                                        {cfg.text}
                                    </span>
                                    <span className={`text-xs font-mono opacity-80 ${isDefault ? 'text-black' : 'text-white'}`}>
                                        {cfg.key}
                                    </span>
                                </button>
                            </div>
                         );
                     })}

                     {/* Add Label Button */}
                     {labelConfigs.length < 10 && (
                         <div className="flex items-center justify-end w-full pt-2">
                             {isAddingLabel ? (
                                 <div className="flex items-center bg-slate-800 rounded-full border border-slate-600 p-1 shadow-lg animate-in fade-in slide-in-from-right-4">
                                     <div 
                                        className="w-6 h-6 rounded-full flex items-center justify-center mr-2"
                                        style={{ backgroundColor: HOTKEY_COLORS[labelConfigs.length] }}
                                     >
                                        <span className="text-white text-xs font-bold">{labelConfigs.length}</span>
                                     </div>
                                     <input 
                                        autoFocus
                                        type="text"
                                        className="bg-transparent text-white text-sm outline-none w-24 mr-2"
                                        placeholder="Label Name"
                                        value={newLabelText}
                                        onChange={(e) => setNewLabelText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if(e.key === 'Enter') handleAddLabelConfig();
                                            if(e.key === 'Escape') setIsAddingLabel(false);
                                        }}
                                        onBlur={handleAddLabelConfig}
                                     />
                                 </div>
                             ) : (
                                 <button 
                                    onClick={() => setIsAddingLabel(true)}
                                    className="flex items-center space-x-2 group"
                                 >
                                    <span className="text-slate-400 text-sm font-medium group-hover:text-white transition-colors">Add Label</span>
                                    <div 
                                        className="w-8 h-8 rounded-full flex items-center justify-center transition-transform group-hover:scale-110 shadow-lg"
                                        style={{ backgroundColor: HOTKEY_COLORS[labelConfigs.length] }}
                                    >
                                        <Plus size={16} className="text-white" />
                                    </div>
                                 </button>
                             )}
                         </div>
                     )}
                 </div>
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
                    onClick={() => { seek(0); spectrogramRef.current?.scrollToTime(0); }}
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
                    onClick={() => { seek(duration); spectrogramRef.current?.scrollToTime(duration); }}
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
                labels={labels}
                selectedLabelId={selectedLabelId}
                activeLabelConfig={activeLabelKey !== null ? (labelConfigs.find(c => c.key === activeLabelKey) ?? null) : null}
                labelConfigs={labelConfigs}
                selectionRegion={selectionRegion}
                onSeek={seek}
                onLabelsChange={handleLabelsChange}
                onLabelsCommit={handleLabelsCommit}
                onSelectLabel={setSelectedLabelId}
                onSelectionChange={setSelectionRegion}
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