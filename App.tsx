import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Pause, Settings, Loader2, Volume2, VolumeX, Keyboard, Plus, X, HelpCircle, AudioWaveform, Bug, Pencil, ArrowLeft } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import Spectrogram from './components/Spectrogram';
import FileTree from './components/FileTree';
import LaunchScreen from './components/LaunchScreen';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import { Label, SpectrogramSettings, LabelConfig, FrequencyScale, Project } from './types';
import { DEFAULT_ZOOM_SEC, DEFAULT_LABEL_CONFIGS, HOTKEY_COLORS } from './constants';
import { formatTime, exportToCSV, exportToAudacity, exportToJSON, generateAudacityContent, generateCSVContent, generateJSONContent } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, readTextFile, writeTextFile, toAssetUrl } from './utils/tauriCommands';
import { useProjects } from './hooks/useProjects';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { revealInFinder, countAnnotationEntries } from './utils/projectCommands';

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
  const [isProcessing, setIsProcessing] = useState(false);
  const [allMediaFiles, setAllMediaFiles] = useState<string[]>([]);
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false);

  // Project state
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const { updateProject, touchLastOpened } = useProjects();

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
  const [activeLabelIndex, setActiveLabelIndex] = useState(0); // 0 is Default

  // Label Editing State
  const [editingLabelIndex, setEditingLabelIndex] = useState<number | null>(null);
  const [editingLabelText, setEditingLabelText] = useState("");
  
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
  
  const [settings, setSettings] = useState<SpectrogramSettings>({
      minFreq: 0,
      maxFreq: 22050,
      intensity: 0.7,
      contrast: 1.0,
      fftSize: 2048,
      windowSize: DEFAULT_ZOOM_SEC,
      frequencyScale: 'mel',
  });

  // Annotation counts: audio file path → number of annotations
  const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});

  const addLog = (msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  };

  // Smooth Scrolling Logic via RequestAnimationFrame
  useEffect(() => {
    let rAF: number;
    const loop = () => {
        if (videoRef.current && !videoRef.current.paused) {
            setCurrentTime(videoRef.current.currentTime);
            rAF = requestAnimationFrame(loop);
        }
    };
    
    if (isPlaying) {
        loop();
    }
    
    return () => {
        if (rAF) cancelAnimationFrame(rAF);
    };
  }, [isPlaying]);

  // Open a file by absolute path (called from button or FileBrowser)
  const handleOpenFile = useCallback(async (absolutePath: string) => {
    setLabels([]);
    setIsPlaying(false);
    setSelectedLabelId(null);
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
    setIsAudioFile(audioExts.includes(ext));
    setVideoFileName(fileName);

    const assetUrl = toAssetUrl(absolutePath);
    setVideoSrc(assetUrl);

    addLog(`Opening: ${fileName}`);
    setIsProcessing(true);

    try {
        const info = await getFileInfo(absolutePath);
        addLog(`File info: ${info.duration_secs.toFixed(2)}s, ${info.sample_rate}Hz, ${info.channels}ch`);

        setSampleRate(info.sample_rate);
        if (info.duration_secs > 0) setDuration(info.duration_secs);
        setSettings(s => ({ ...s, maxFreq: info.sample_rate / 2 }));

        // Create new multi-tier chunk cache for this file
        const cache = new MultiTierSpectrogramCache(
            absolutePath,
            settings.fftSize,
            info.sample_rate,
            info.duration_secs,
            () => setCacheVersion(v => v + 1),
        );
        chunkCacheRef.current = cache;
        setCacheVersion(0);

        // Kick off first viewport prefetch immediately
        cache.prefetchViewport(0, settings.windowSize, cache.selectTier(settings.windowSize, 1200).tier);
        addLog('Spectrogram loading...');
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog(`Error opening file: ${errMsg}`, 'error');
    } finally {
        setIsProcessing(false);
    }
  }, [settings.fftSize]);


  // The ordered list used for navigation (respects shuffle mode)
  const displayQueue = useMemo(
    () => (shuffleMode ? shuffledFiles : allMediaFiles),
    [shuffleMode, shuffledFiles, allMediaFiles]
  );

  // Navigation: next/prev file in the display queue
  const currentFileIndex = useMemo(() => {
    if (!currentFilePath || displayQueue.length === 0) return -1;
    return displayQueue.indexOf(currentFilePath);
  }, [currentFilePath, displayQueue]);

  const navigateFile = useCallback((direction: 'prev' | 'next') => {
    if (displayQueue.length === 0) return;
    let idx = currentFileIndex;
    if (direction === 'prev') idx = Math.max(0, idx - 1);
    else idx = Math.min(displayQueue.length - 1, idx + 1);
    if (idx >= 0 && idx < displayQueue.length && displayQueue[idx] !== currentFilePath) {
        handleOpenFile(displayQueue[idx]);
    }
  }, [displayQueue, currentFileIndex, currentFilePath, handleOpenFile]);

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
      updateProject({ ...activeProject, labelConfigs });
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
      updateProject({ ...activeProject, spectrogramSettings: settings });
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
        if (labels.length === 0) return;
        let content: string;
        if (exportFormat === 'json') content = generateJSONContent(labels);
        else if (exportFormat === 'csv') content = generateCSVContent(labels);
        else content = generateAudacityContent(labels);
        await writeTextFile(annotPath, content);
        setAnnotationCounts(prev => ({ ...prev, [currentFilePath]: labels.length }));
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
    setLabelConfigs(project.labelConfigs.length > 0 ? project.labelConfigs : DEFAULT_LABEL_CONFIGS);
    if (project.spectrogramSettings) {
      setSettings(project.spectrogramSettings);
    }
    setCurrentDirectory(project.audioDirectory);
    setAnnotationCounts({});
    setLabels([]);
    setCurrentFilePath(null);
    setVideoSrc(null);
    labelsHistoryRef.current = [[]];
    historyIndexRef.current = 0;
    try {
      const files = await listMediaFilesRecursive(project.audioDirectory);
      setAllMediaFiles(files);
      setActiveProject(project);
      if (files.length > 0) handleOpenFile(files[0]);
      // Load annotation counts in the background
      countAnnotationEntries(project.annotationDirectory, project.outputFormat)
        .then(entries => {
          const counts: Record<string, number> = {};
          const audioRoot = project.audioDirectory;
          for (const { rel_path, count } of entries) {
            const match = files.find(f => {
              const rel = f.substring(audioRoot.length + 1).replace(/\.[^/.]+$/, '').replace(/\\/g, '/');
              return rel === rel_path;
            });
            if (match) counts[match] = count;
          }
          setAnnotationCounts(counts);
        })
        .catch(() => {});
    } catch (err) {
      setAllMediaFiles([]);
      setActiveProject(project);
      addLog(`Error scanning audio directory: ${err}`, 'error');
    }
  }, [touchLastOpened, handleOpenFile]);

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
      if (videoRef.current) {
          if (isPlaying) videoRef.current.pause();
          else videoRef.current.play();
          setIsPlaying(!isPlaying);
      }
  }, [isPlaying]);

  const seek = useCallback((time: number) => {
      if (videoRef.current) {
          videoRef.current.currentTime = time;
          setCurrentTime(time);
      }
  }, []);

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

          switch(e.key.toLowerCase()) {
              case ' ':
                  e.preventDefault();
                  togglePlay();
                  break;
              case 'm':
                  setMuted(prev => !prev);
                  break;
              case 'delete':
              case 'backspace':
                  if (selectedLabelId) {
                      handleLabelsCommit(labels.filter(l => l.id !== selectedLabelId));
                      setSelectedLabelId(null);
                  }
                  break;
          }

          // Hotkey Numbers (0-9) - Set Active Label Index
          if (/^[0-9]$/.test(e.key)) {
              const idx = parseInt(e.key);
              if (idx < labelConfigs.length) {
                  setActiveLabelIndex(idx);
              }
          }

          // File navigation: [ = prev, ] = next
          if (e.key === '[') {
              e.preventDefault();
              navigateFile('prev');
          } else if (e.key === ']') {
              e.preventDefault();
              navigateFile('next');
          }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, selectedLabelId, labelConfigs, navigateFile, undoLabels, redoLabels, handleLabelsCommit, labels]);

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
      setActiveLabelIndex(nextIndex);
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
      setActiveLabelIndex(0);
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

  // Handle volume slider change
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = parseFloat(e.target.value);
      // Snap to 1.0 if close
      if (val > 0.95 && val < 1.05) val = 1.0;
      setVolume(val);
      setMuted(false);
  };

  // Calculate volume slider background
  const volPercent = Math.min(100, (volume / 4) * 100); 
  const isBoosted = volume > 1;

  if (!activeProject) {
    return <LaunchScreen onOpenProject={handleOpenProject} />;
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
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r
  from-[#e65161]
  to-[rgb(249,195,135)]">
                {activeProject.name}
            </h1>
        </div>

        <div className="flex items-center space-x-4">
            <div className="text-mono text-lg font-medium w-24 text-center">
                {formatTime(currentTime)}
            </div>
            <div className="flex items-center space-x-2">
                 <button 
                    onClick={togglePlay}
                    disabled={!videoSrc}
                    className="p-2 rounded-full bg-[#e65161] hover:bg-[#f06575] disabled:opacity-50 text-white transition-all shadow-lg"
                >
                    {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
                </button>
            </div>
            
            {/* Volume Control */}
            <div className="flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-1 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600">
                <button onClick={() => setMuted(!muted)} className="text-slate-300 hover:text-white">
                    {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
                <div className="relative w-24 h-5 flex items-center">
                    <input 
                        type="range" min="0" max="4" step="0.05"
                        value={muted ? 0 : volume}
                        onChange={handleVolumeChange}
                        className={`w-full h-1 bg-slate-500 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${isBoosted ? '[&::-webkit-slider-thumb]:bg-red-500' : '[&::-webkit-slider-thumb]:bg-[#e65161]'}`}
                        style={{
                            background: `linear-gradient(to right, ${isBoosted ? '#ef4444' : '#e65161'} 0%, ${isBoosted ? '#ef4444' : '#e65161'} ${(Math.min(1, volume) / 4) * 100}%, ${isBoosted ? '#ef4444' : 'transparent'} ${(Math.min(1, volume) / 4) * 100}%, ${isBoosted ? '#ef4444' : 'transparent'} ${(volume / 4) * 100}%, #64748b ${(volume / 4) * 100}%, #64748b 100%)`
                        }}
                    />
                    {/* Tick for 100% */}
                    <div className="absolute left-[25%] top-0 bottom-0 w-[1px] bg-white/30 pointer-events-none"></div>
                </div>
            </div>
        </div>

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
            <button
                onClick={() => setShowProjectSettings(true)}
                className="flex items-center space-x-2 px-3 py-1.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                title="Project Settings"
            >
                <Settings size={18} />
                <span className="text-sm">Project</span>
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
                  className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-lg w-full p-6 relative"
                  onClick={(e) => e.stopPropagation()}
             >
                  <button 
                    onClick={() => setShowHelp(false)}
                    className="absolute top-4 right-4 text-slate-400 hover:text-white"
                  >
                      <X size={20} />
                  </button>
                  <h3 className="text-xl font-bold mb-4 text-[#e65161]">How to use SeeNote</h3>
                  
                  <div className="space-y-4 text-sm text-slate-300">
                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">1. Get Started</h4>
                      <p>Upload a video or audio file. The app will visualize the spectrogram below.</p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">2. Navigation</h4>
                      <p>
                        <span className="text-white">Pan:</span> Right-Click & Drag or use Scroll Wheel.<br/>
                        <span className="text-white">Zoom:</span> Ctrl + Scroll Wheel to zoom in/out of time.<br/>
                        <span className="text-white">Play/Pause:</span> Press Spacebar.
                      </p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">3. Creating Labels</h4>
                      <p>Click and drag anywhere on the spectrogram to create a new label segment. The label will inherit the currently active category (bottom right).</p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">4. Managing Categories</h4>
                      <p>Use the panel on the right to add named categories. Press numbers <span className="font-mono bg-slate-700 px-1 rounded">0-9</span> on your keyboard to quickly switch between them.</p>
                      <p>Click a category name to rename it (updates all labels).</p>
                    </div>

                    <div className="space-y-1">
                      <h4 className="font-semibold text-white">5. Editing & Deleting</h4>
                      <p>
                        Drag the left/right edges of a label to resize.<br/>
                        Click the label text to rename. <span className="text-orange-400">Note:</span> Renaming a colored label converts it to a generic "Custom Label".<br/>
                        <span className="text-red-400">Middle Click</span> any label to delete it instantly.
                      </p>
                    </div>
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
                  className="bg-slate-800 rounded-lg shadow-xl border border-slate-700 max-w-sm w-full p-6 relative"
                  onClick={(e) => e.stopPropagation()}
              >
                  <button 
                    onClick={() => setShowHotkeysHelp(false)}
                    className="absolute top-4 right-4 text-slate-400 hover:text-white"
                  >
                      <X size={20} />
                  </button>
                  <h3 className="text-lg font-bold mb-4">Keyboard Shortcuts</h3>
                  <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-400">Space</span> <span>Play / Pause</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">M</span> <span>Mute / Unmute</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Delete / Backspace</span> <span>Delete Selected</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Middle Click</span> <span>Delete Label</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">0 - 9</span> <span>Set Active Label</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Ctrl/Cmd + Scroll</span> <span>Zoom Spectrogram</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Scroll / Right Click</span> <span>Pan Spectrogram</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">[ / ]</span> <span>Previous / Next File</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Escape</span> <span>Exit Label Edit</span></div>
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
                onFileSelect={(path) => handleOpenFile(path)}
                collapsed={fileTreeCollapsed}
                onToggleCollapse={() => setFileTreeCollapsed(c => !c)}
                onNavigatePrev={() => navigateFile('prev')}
                onNavigateNext={() => navigateFile('next')}
                canNavigatePrev={currentFileIndex > 0}
                canNavigateNext={currentFileIndex < displayQueue.length - 1}
                shuffleMode={shuffleMode}
                onToggleShuffle={toggleShuffle}
                annotationCounts={annotationCounts}
                onRevealInFinder={handleRevealInFinder}
                onRevealAnnotations={handleRevealAnnotations}
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
                    muted={muted}
                    isAudio={isAudioFile}
                    onTimeUpdate={(t) => {
                        // Only update from event if NOT playing (to avoid jitter with RAF)
                        if (!isPlaying) setCurrentTime(t);
                    }}
                    onDurationChange={setDuration}
                    onLoadedMetadata={() => {}}
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
             {/* Adjusted to handle varying label widths and better button placement */}
             <div className="absolute top-4 right-4 bottom-4 w-64 flex flex-col items-end pointer-events-none z-30 space-y-2">
                 {/* Label List */}
                 <div className="w-full flex flex-col items-end space-y-2 pointer-events-auto overflow-y-auto pr-2 custom-scrollbar max-h-full py-2">
                     {labelConfigs.map((cfg, idx) => {
                         const isActive = idx === activeLabelIndex;
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
                                    onClick={() => setActiveLabelIndex(idx)}
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
        <div style={{ height: `${(1 - splitRatio) * 100}%` }} className="relative bg-slate-900 border-t border-slate-700">
             
             {/* Settings Button (Top Right) */}
             <div className="absolute top-4 right-4 z-50">
                <button 
                    onClick={() => setShowSettings(!showSettings)}
                    className={`p-2 rounded hover:bg-slate-700 ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
                    title="Spectrogram Settings"
                >
                    <Settings size={20} />
                </button>
             </div>

             {/* Settings Panel (Absolute, relative to this pane) */}
             {showSettings && (
                <div className="absolute top-14 right-4 z-40 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
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
                                    type="range" min="0.1" max="2.0" step="0.1"
                                    value={settings.intensity}
                                    onChange={(e) => setSettings({...settings, intensity: parseFloat(e.target.value)})}
                                    className="w-full accent-[#e65161]"
                                />
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 mb-1 block">Contrast</label>
                                <input
                                    type="range" min="0.5" max="2.0" step="0.1"
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

             <Spectrogram
                chunkCache={chunkCacheRef.current}
                sampleRate={sampleRate}
                cacheVersion={cacheVersion}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                isProcessing={isProcessing}
                fileIdent={fileIdent}
                settings={settings}
                labels={labels}
                selectedLabelId={selectedLabelId}
                activeLabelConfig={labelConfigs[activeLabelIndex]}
                labelConfigs={labelConfigs}
                onSeek={seek}
                onLabelsChange={handleLabelsChange}
                onLabelsCommit={handleLabelsCommit}
                onSelectLabel={setSelectedLabelId}
                onZoomChange={(z) => setSettings(s => ({...s, windowSize: z}))}
             />
             
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