import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Pause, Settings, Loader2, AlertCircle, Volume2, VolumeX, Keyboard, Plus, X, HelpCircle, Bug, Pencil, ArrowLeft, ChevronLeft, ChevronRight, SkipBack, SkipForward, Copy, Check, FolderOpen } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import CanvasVideoPlayer from './components/CanvasVideoPlayer';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import FileTree from './components/FileTree';
import LaunchScreen from './components/LaunchScreen';
import ProjectSettingsModal from './components/ProjectSettingsModal';
import GradientProjectName from './components/GradientProjectName';
import { HelpPanel } from './components/HelpPanel';
import { Annotation, SpectrogramSettings, AnnotationTool, FrequencyScale, Project } from './types';
import { DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_ANNOTATION_TOOLS, HOTKEY_COLORS, isSupportedMediaFile } from './constants';
import { formatTime, exportToCSV, exportToAudacity, exportToJSON, generateAudacityContent, generateCSVContent, generateJSONContent, makeAnnotationFromTool } from './utils/helpers';
import { getFileInfo, listMediaFilesRecursive, listDirectory, openDirectoryDialog, openDirectoryDialogAt, readTextFile, writeTextFile, removeFile, toAssetUrl } from './utils/tauriCommands';
import { useProjects } from './hooks/useProjects';
import { useHotkeys } from './hooks/useHotkeys';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { revealInFileManager, listAnnotationFiles } from './utils/projectCommands';
import { AudioEngine } from './utils/AudioEngine';
import { VideoFrameSource, canUseFrameSource } from './utils/VideoFrameSource';
import TooltipLayer from './components/TooltipLayer';
import BrightnessContrastPad from './components/BrightnessContrastPad';

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
      data-tooltip={label}
    >
      <span className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: dotColor }} />
      <span className="flex-1 min-w-0 truncate text-left text-slate-100 leading-tight">{label}</span>
      <span className="font-mono text-slate-500 text-[10px] flex-none">{hotkey}</span>
    </button>
  );
}

type RepairProjectState = {
  project: Project;
  audioMissing: boolean;
  annotationMissing: boolean;
  repairedAudio: string;
  repairedAnnotation: string;
};

function RepairProjectModal({
  repairProject,
  setRepairProject,
  updateProject,
  onOpenProject,
}: {
  repairProject: RepairProjectState;
  setRepairProject: React.Dispatch<React.SetStateAction<RepairProjectState | null>>;
  updateProject: (p: Project) => Promise<void> | void;
  onOpenProject: (p: Project) => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 shadow-2xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertCircle size={20} className="text-amber-400 flex-none mt-0.5" />
          <div>
            <h3 className="text-white font-semibold text-base">Project directory not found</h3>
            <p className="text-slate-400 text-sm mt-1">
              One or more directories for <span className="text-white">{repairProject.project.name}</span> no longer exist. Please choose new paths.
            </p>
          </div>
        </div>

        {repairProject.audioMissing && (
          <div>
            <label className="text-slate-400 text-xs block mb-1">Audio Directory <span className="text-amber-400">(missing)</span></label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repairProject.repairedAudio}
                onChange={e => setRepairProject(r => r ? { ...r, repairedAudio: e.target.value } : r)}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#e65161]"
              />
              <button
                onClick={async () => {
                  const startDir = await findFirstValidAncestor(repairProject.repairedAudio);
                  const dir = await (startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog());
                  if (dir) setRepairProject(r => r ? { ...r, repairedAudio: dir } : r);
                }}
                className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>
        )}

        {repairProject.annotationMissing && (
          <div>
            <label className="text-slate-400 text-xs block mb-1">Annotation Directory <span className="text-amber-400">(missing)</span></label>
            <div className="flex gap-2">
              <input
                type="text"
                value={repairProject.repairedAnnotation}
                onChange={e => setRepairProject(r => r ? { ...r, repairedAnnotation: e.target.value } : r)}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#e65161]"
              />
              <button
                onClick={async () => {
                  const startDir = await findFirstValidAncestor(repairProject.repairedAnnotation);
                  const dir = await (startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog());
                  if (dir) setRepairProject(r => r ? { ...r, repairedAnnotation: dir } : r);
                }}
                className="bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <button
            onClick={() => setRepairProject(null)}
            className="px-4 py-2 text-slate-400 hover:text-white transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              const updated = {
                ...repairProject.project,
                audioDirectory: repairProject.repairedAudio,
                annotationDirectory: repairProject.repairedAnnotation,
              };
              await updateProject(updated);
              setRepairProject(null);
              onOpenProject(updated);
            }}
            className="px-4 py-2 bg-[#e65161] hover:bg-[#f06575] text-white rounded-lg text-sm transition-colors"
          >
            Save & Open
          </button>
        </div>
      </div>
    </div>
  );
}

async function findFirstValidAncestor(path: string): Promise<string> {
  const sep = path.includes('/') ? '/' : '\\';
  let current = path;
  while (true) {
    const exists = await listDirectory(current).then(() => true).catch(() => false);
    if (exists) return current;
    const lastSep = current.lastIndexOf(sep);
    if (lastSep <= 0) return '';
    current = current.substring(0, lastSep);
  }
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

  // Broken-path repair modal: set when a project's audio/annotation dir is missing
  const [repairProject, setRepairProject] = useState<{
    project: Project;
    audioMissing: boolean;
    annotationMissing: boolean;
    repairedAudio: string;
    repairedAnnotation: string;
  } | null>(null);

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
        const sel = selectionRegionRef.current;
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
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [leftPanelRatio, setLeftPanelRatio] = useState(0.6);
  const [leftPanelWidth, setLeftPanelWidth] = useState(224);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<'guide' | 'annotations' | 'shortcuts'>('guide');
  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{time: string, msg: string, type: 'info'|'error'}[]>([]);
  const [debugCopied, setDebugCopied] = useState(false);
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

  // Memoized so children whose effects depend on it (e.g. CanvasVideoPlayer's
  // rAF loop) don't tear down on every parent re-render.
  const addLog = useCallback((msg: string, type: 'info'|'error' = 'info') => {
      const time = new Date().toLocaleTimeString();
      setDebugLogs(prev => [...prev, { time, msg, type }]);
  }, []);

  // Keep selectionRegionRef in sync with state (for use in rAF loop without stale closure)
  useEffect(() => { selectionRegionRef.current = selectionRegion; }, [selectionRegion]);

  // Warm the frame-source cache whenever the selection region changes so
  // frames inside the range are decoded ahead of play. Cheap to call — if
  // the range is already cached, ensureRange returns without re-decoding.
  useEffect(() => {
    const source = frameSourceRef.current;
    if (!source || !selectionRegion) return;
    source.ensureRange(selectionRegion.start, selectionRegion.end).catch(() => {});
  }, [selectionRegion, frameSourceVersion]);

  // Pre-decode PCM for the selection so repeat plays are instant. AudioEngine
  // skips the call if the range is already covered by its cache.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !selectionRegion) return;
    engine.preloadRange(selectionRegion.start, selectionRegion.end).catch(() => {});
  }, [selectionRegion]);

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
  const handleOpenFile = useCallback(async (absolutePath: string) => {
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
    setSelectionRegion(null);
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
    const base = shuffleMode ? shuffledFiles : allMediaFiles;
    const filter = activeProject?.fileFilter ?? (activeProject?.hideAnnotated ? 'unannotated' : 'all');
    if (filter === 'annotated') return base.filter(f => annotatedFiles.has(f));
    if (filter === 'unannotated') return base.filter(f => !annotatedFiles.has(f));
    return base;
  }, [shuffleMode, shuffledFiles, allMediaFiles, activeProject?.fileFilter, activeProject?.hideAnnotated, annotatedFiles]);

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
      const next = !prev;
      if (next) {
        const shuffled = [...allMediaFiles];
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
      if (activeProjectRef.current) {
        updateProject({ ...activeProjectRef.current, shuffleMode: next });
      }
      return next;
    });
  }, [allMediaFiles, updateProject]);

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
        const decimals = activeProjectRef.current?.outputRoundingDecimals ?? 4;
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

  const handleOpenProject = useCallback(async (project: Project) => {
    const touched = await touchLastOpened(project.id) ?? project;

    // Check that both directories still exist before opening.
    const audioExists = await listDirectory(touched.audioDirectory).then(() => true).catch(() => false);
    const annotationExists = await listDirectory(touched.annotationDirectory).then(() => true).catch(() => false);
    if (!audioExists || !annotationExists) {
      setRepairProject({
        project: touched,
        audioMissing: !audioExists,
        annotationMissing: !annotationExists,
        repairedAudio: touched.audioDirectory,
        repairedAnnotation: touched.annotationDirectory,
      });
      return;
    }

    // Set activeProject in the same React batch as annotationTools/settings so the
    // persist-effect guard (prevProjectIdRef) sees the new project immediately and
    // correctly skips the load-triggered changes.
    setActiveProject(touched);
    setAnnotationTools(touched.annotationTools.length > 0 ? touched.annotationTools : DEFAULT_ANNOTATION_TOOLS);
    if (touched.spectrogramSettings) {
      setSettings(touched.spectrogramSettings);
    }
    setShuffleMode(touched.shuffleMode ?? false);
    setShuffledFiles([]);
    setCurrentDirectory(touched.audioDirectory);
    setAnnotatedFiles(new Set());
    setAnnotations([]);
    setTrackPath(null);
    setVideoSrc(null);
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;
    try {
      const files = await listMediaFilesRecursive(touched.audioDirectory);
      setAllMediaFiles(files);
      let firstFile = files[0];
      if (touched.shuffleMode && files.length > 0) {
        const shuffled = [...files];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        setShuffledFiles(shuffled);
        firstFile = shuffled[0];
      }
      if (firstFile) handleOpenFile(firstFile);
      // Load annotation file existence in the background
      listAnnotationFiles(touched.annotationDirectory, touched.outputFormat)
        .then(relPaths => {
          const audioRoot = touched.audioDirectory;
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
    setShuffleMode(false);
    setShuffledFiles([]);
    setAllMediaFiles([]);
    setTrackPath(null);
    setTrackName("video");
    setVideoSrc(null);
    setCurrentTime(0);
    setCurrentDirectory(null);
    setAnnotations([]);
    setSelectedAnnotationId(null);
    setSelectionRegion(null);
    setBoundAnnotationId(null);
    setAnnotatedFiles(new Set());
    annotationsHistoryRef.current = [[]];
    historyIndexRef.current = 0;
    setActiveProject(null);
  }, []);

  const handleToggleFileFilter = useCallback(() => {
    if (!activeProject) return;
    const current = activeProject.fileFilter ?? (activeProject.hideAnnotated ? 'unannotated' : 'all');
    const next = ({ all: 'unannotated', unannotated: 'annotated', annotated: 'all' } as const)[current];
    updateProject({ ...activeProject, fileFilter: next, hideAnnotated: next === 'unannotated' });
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

  const togglePlay = useCallback(async () => {
      if (isPlaying || isBuffering) {
          // Invalidate any in-flight preroll so its resolution can't start engine
          playTokenRef.current += 1;
          engineRef.current?.pause();
          setIsPlaying(false);
          setIsBuffering(false);
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
              const sel = selectionRegionRef.current;
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
              const savedText = reassignBufferRef.current[tool.key];
              const newText = savedText !== undefined ? savedText : (isCustom ? '' : tool.text);
              const updated = annotations.map(a => a.id === boundAnnotationId
                  ? { ...a, toolKey: tool.key, text: newText, color: tool.color }
                  : a
              );
              handleAnnotationsCommit(updated);
              setActiveToolKey(key);
          }
      } else if (activeToolKey === null && selectionRegion !== null) {
          const newAnnotation = makeAnnotationFromTool(tool, selectionRegion.start, selectionRegion.end);
          handleAnnotationsCommit([...annotations, newAnnotation]);
          setSelectedAnnotationId(newAnnotation.id);
          setBoundAnnotationId(newAnnotation.id);
          setActiveToolKey(key);
      } else {
          setActiveToolKey(prev => prev === key ? null : key);
      }
  }, [annotationTools, boundAnnotationId, annotations, activeToolKey, selectionRegion, handleAnnotationsCommit, reassignBufferRef]);

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
              setSelectionRegion({ start: 0, end: duration });
          }
      } else {
          setSelectionRegion({ start: 0, end: duration });
      }
  };
  const deleteSelectedAnnotation = () => {
      if (!selectedAnnotationId) return;
      handleAnnotationsCommit(annotations.filter(a => a.id !== selectedAnnotationId));
      const wasBound = selectedAnnotationId === boundAnnotationId;
      setSelectedAnnotationId(null);
      if (wasBound) {
          setSelectionRegion(null);
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
      const decimals = activeProject?.outputRoundingDecimals ?? 4;
      if (exportFormat === 'json') {
          await exportToJSON(annotations, trackName, trackPath, decimals);
      } else if (exportFormat === 'csv') {
          await exportToCSV(annotations, trackName, trackPath, decimals);
      } else {
          await exportToAudacity(annotations, trackName, trackPath, decimals);
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
          handleAnnotationsCommit(updatedAnnotations);
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
              handleAnnotationsCommit(updatedAnnotations);
              addLog(`Deleted tool ${tool.text}. Converted annotations to Custom.`);
          } else {
              // Delete
              const updatedAnnotations = annotations.filter(a => a.toolKey !== tool.key);
              handleAnnotationsCommit(updatedAnnotations);
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

  // Nonlinear volume mapping: slider [0,1] → gain [0,4], with gain=1.0 at slider=0.5.
  // Lower half [0,0.5] covers gain 0→1 (finer resolution for quieting);
  // upper half [0.5,1] covers gain 1→4 (coarser resolution for boosting).
  const gainToSlider = (gain: number): number =>
    gain <= 1 ? gain / 2 : 0.5 + (gain - 1) / 6;
  const sliderToGain = (s: number): number =>
    s <= 0.5 ? s * 2 : 1 + (s - 0.5) * 6;

  // Refs for use in the non-React wheel event handler (attached once, reads live values)
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const [volumeControlEl, setVolumeControlEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!volumeControlEl) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = gainToSlider(mutedRef.current ? 0 : volumeRef.current);
      const delta = -Math.sign(e.deltaY) * 0.03;
      const newSlider = Math.max(0, Math.min(1, cur + delta));
      setVolume(sliderToGain(newSlider));
      setMuted(false);
    };
    volumeControlEl.addEventListener('wheel', handler, { passive: false });
    return () => volumeControlEl.removeEventListener('wheel', handler);
  }, [volumeControlEl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle volume slider change
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let sliderVal = parseFloat(e.target.value);
      // Snap to center (gain=1.0) when close
      if (Math.abs(sliderVal - 0.5) < 0.01) sliderVal = 0.5;
      setVolume(sliderToGain(sliderVal));
      setMuted(false);
  };

  // Calculate volume slider background
  const sliderPct = gainToSlider(muted ? 0 : volume) * 100;
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

    // selDur without selection: allow negative durations (playhead ± dur), handled before parseTimestamp
    if (editingTimeField === 'selDur' && !selectionRegion && !isPlaying) {
      const dur = parseFloat(raw.trim());
      if (!isNaN(dur)) {
        const a = Math.max(0, Math.min(duration, Math.min(currentTime, currentTime + dur)));
        const b = Math.max(0, Math.min(duration, Math.max(currentTime, currentTime + dur)));
        if (a !== b) setSelectionRegion({ start: a, end: b });
      }
      setEditingTimeField(null);
      setEditingTimeRaw("");
      return;
    }

    const parsed = parseTimestamp(raw);
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(duration, parsed));
      if (editingTimeField === 'time') {
        seek(clamped, true);
      } else if (editingTimeField === 'selStart') {
        if (selectionRegion) {
          setSelectionRegion({ start: clamped, end: Math.max(clamped, selectionRegion.end) });
        } else if (!isPlaying) {
          const a = Math.min(clamped, currentTime);
          const b = Math.max(clamped, currentTime);
          if (a !== b) setSelectionRegion({ start: a, end: b });
        }
      } else if (editingTimeField === 'selEnd') {
        if (selectionRegion) {
          setSelectionRegion({ start: selectionRegion.start, end: Math.max(selectionRegion.start, clamped) });
        } else if (!isPlaying) {
          const a = Math.min(clamped, currentTime);
          const b = Math.max(clamped, currentTime);
          if (a !== b) setSelectionRegion({ start: a, end: b });
        }
      } else if (editingTimeField === 'selDur' && selectionRegion) {
        setSelectionRegion({ start: selectionRegion.start, end: Math.min(duration, selectionRegion.start + Math.max(0, parsed)) });
      }
    }
    setEditingTimeField(null);
    setEditingTimeRaw("");
  };

  if (!activeProject) {
    return (
      <>
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
        {repairProject && (
          <RepairProjectModal
            repairProject={repairProject}
            setRepairProject={setRepairProject}
            updateProject={updateProject}
            onOpenProject={handleOpenProject}
          />
        )}
        <TooltipLayer />
      </>
    );
  }

  return (
    <div
      className="flex flex-col h-screen bg-slate-900 text-slate-200"
      style={{ marginRight: showHelp ? '320px' : '0', transition: 'margin-right 300ms ease-in-out' }}
    >
      {/* Header */}
      <header className="flex-none h-16 bg-slate-800 border-b border-slate-700 flex items-center px-4 justify-between select-none z-50 relative" data-help-target="toolbar">
        <div className="flex items-center space-x-4">
            <button
                onClick={handleCloseProject}
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
                    <GradientProjectName name={activeProject.name} nameGradientColors={activeProject.nameGradientColors} />
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
                       <div className="flex items-center gap-2">
                           <button
                               onClick={() => {
                                   const text = debugLogs.map(l => `[${l.time}] ${l.msg}`).join('\n');
                                   navigator.clipboard.writeText(text);
                                   setDebugCopied(true);
                                   setTimeout(() => setDebugCopied(false), 1500);
                               }}
                               className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors"
                               data-tooltip="Copy logs"
                               disabled={debugLogs.length === 0}
                           >
                               {debugCopied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                           </button>
                           <button onClick={() => setShowDebug(false)} className="text-slate-400 hover:text-white"><X size={20}/></button>
                       </div>
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

      <HelpPanel
        open={showHelp}
        tab={helpTab}
        onTabChange={setHelpTab}
        onClose={() => setShowHelp(false)}
      />

      {/* Broken project dir repair modal */}
      {repairProject && (
        <RepairProjectModal
          repairProject={repairProject}
          setRepairProject={setRepairProject}
          updateProject={updateProject}
          onOpenProject={handleOpenProject}
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex relative overflow-hidden select-none">
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
            fileFilter: (activeProject?.fileFilter ?? (activeProject?.hideAnnotated ? 'unannotated' : 'all')) as 'all' | 'annotated' | 'unannotated',
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

              {/* Tool Panel */}
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden" data-help-target="tool-palette">
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
                            onClick={() => handleToolActivate(custom.key)}
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
                            onClick={() => handleToolActivate(tool.key)}
                          />
                          <div className="absolute top-0 right-0 flex opacity-0 group-hover/cell:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditingTool(idx); }}
                              className="text-blue-400 hover:text-blue-300 bg-slate-900/90 p-0.5 rounded-bl"
                              data-tooltip="Rename"
                            >
                              <Pencil size={9} />
                            </button>
                            <button
                              onClick={(e) => handleDeleteTool(idx, e)}
                              className="text-red-500 hover:text-red-400 bg-slate-900/90 p-0.5 rounded-tr"
                              data-tooltip="Delete"
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
                        data-tooltip="Add Label"
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
        <div style={{ height: `${splitRatio * 100}%` }} className="bg-black relative flex" data-help-target="video-panel">
             <div className="flex-1 relative bg-black flex justify-center items-center">
                 {/* MP4/MOV video tracks use the frame-source path: a canvas driven
                     by the audio engine clock, with frames decoded via WebCodecs and
                     cached by timestamp. All other cases (audio tracks, non-ISOBMFF
                     video containers, or a failed frame-source open) fall back to the
                     original <video>-element player. */}
                 {frameSourceRef.current && !isAudioTrack ? (
                    <CanvasVideoPlayer
                       key={frameSourceVersion}
                       frameSource={frameSourceRef.current}
                       getMediaTime={getMediaTime}
                       onDebugLog={addLog}
                    />
                 ) : (
                    <VideoPlayer
                       src={videoSrc}
                       isAudio={isAudioTrack}
                       onDurationChange={setDuration}
                       onDebugLog={addLog}
                    />
                 )}
                 {isProcessing && (
                     <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
                         <Loader2 className="animate-spin text-[#e65161] mb-2" size={48} />
                         <p className="text-[#e65161] font-medium">Processing Media...</p>
                         <p className="text-slate-400 text-sm mt-1">Loading file...</p>
                     </div>
                 )}
                 {isBuffering && videoSrc && (
                     <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-20 pointer-events-none">
                         <Loader2 className="animate-spin text-white" size={40} />
                     </div>
                 )}
                 {videoSrc && !isAudioTrack && !frameSourceRef.current && (
                     <div
                         className="absolute top-2 right-2 z-30 text-[#e65161] cursor-default"
                         data-tooltip="This video format isn't supported by the frame-accurate WebCodecs pipeline. Playback falls back to the browser's <video> element and will not be frame-perfect."
                     >
                         <AlertCircle size={20} />
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

             {/* Playback toolbar */}
             <div className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 border-b border-slate-700 select-none z-40" data-help-target="playback-controls">
                 {/* Transport controls: [Start] [PrevAnnot] [Play] [NextAnnot] [End] */}
                 <div className="flex items-center gap-1" data-help-target="transport-buttons">
                 <button
                    onClick={() => { seek(0, true); setSelectionRegion(null); setBoundAnnotationId(null); }}
                    disabled={!videoSrc}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    data-tooltip="Skip to start"
                >
                    <SkipBack size={15} />
                </button>
                <button
                    onClick={() => spectrogramRef.current?.goToPrevAnnotation()}
                    disabled={!videoSrc || !canGoPrevAnnotation}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    data-tooltip="Previous annotation (Cmd+←  or  ;)"
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
                    data-tooltip="Next annotation (Cmd+→  or  ')"
                >
                    <ChevronRight size={15} />
                </button>
                <button
                    onClick={() => { seek(duration, true); setSelectionRegion(null); setBoundAnnotationId(null); }}
                    disabled={!videoSrc}
                    className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
                    data-tooltip="Skip to end"
                >
                    <SkipForward size={15} />
                </button>
                </div>

                {/* Volume Control */}
                <div ref={setVolumeControlEl} className="flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600 ml-1" data-help-target="volume-control">
                    <button onClick={() => setMuted(!muted)} className="text-slate-300 hover:text-white">
                        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    </button>
                    <div className="relative w-20 h-5 flex items-center">
                        <input
                            type="range" min="0" max="1" step="0.005"
                            value={gainToSlider(muted ? 0 : volume)}
                            onChange={handleVolumeChange}
                            onPointerUp={(e) => {
                                const sliderVal = parseFloat((e.target as HTMLInputElement).value);
                                if (Math.abs(sliderVal - 0.5) < 0.015) { setVolume(1.0); setMuted(false); }
                            }}
                            className={`w-full h-1 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${isBoosted ? '[&::-webkit-slider-thumb]:bg-red-500' : '[&::-webkit-slider-thumb]:bg-[#e65161]'}`}
                            style={{
                                background: isBoosted
                                  ? `linear-gradient(to right, #e65161 0%, #e65161 50%, #ef4444 50%, #ef4444 ${sliderPct}%, #64748b ${sliderPct}%, #64748b 100%)`
                                  : `linear-gradient(to right, #e65161 0%, #e65161 ${sliderPct}%, #64748b ${sliderPct}%, #64748b 100%)`
                            }}
                        />
                        {/* Hash mark at center = gain 1.0 (50% of slider range) */}
                        <div className="absolute top-0 bottom-0 w-[1px] bg-white/30 pointer-events-none" style={{ left: 'calc((100% - 12px) * 0.5 + 6px)' }}></div>
                    </div>
                </div>

                {/* Time display — current time + selection fields to the right */}
                <div className="flex items-center gap-2 ml-2 tabular-nums" data-help-target="time-display">
                    <div data-help-target="current-time">
                    {editingTimeField === 'time' ? (
                        <input
                            autoFocus
                            className="text-sm font-mono font-medium text-white bg-slate-700 border border-[#e65161] rounded-md px-2 py-1 w-[5rem] outline-none"
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
                            className="flex items-center justify-end px-2 py-1 w-[5rem] bg-slate-700/50 rounded-md text-sm font-mono font-medium text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
                            data-tooltip="Click to jump to time"
                            onClick={() => { setEditingTimeField('time'); setEditingTimeRaw(currentTime.toFixed(2)); }}
                        >
                            {currentTime.toFixed(2)}s
                        </button>
                    )}
                    </div>

                    <div className="w-px bg-slate-600/50 self-stretch my-0.5" />

                    {/* Selection fields — always visible, blank when no selection active */}
                    {(() => {
                        const region = selectionRegion ?? { start: 0, end: 0 };
                        const has = !!selectionRegion;
                        // Allow editing when paused and no selection to create one from the playhead
                        const canCreate = !has && !isPlaying;
                        const fieldInput = (
                            <input
                                autoFocus
                                className="text-xs font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1.5 h-5 w-[4.5rem] outline-none text-right"
                                value={editingTimeRaw}
                                onChange={e => setEditingTimeRaw(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                                    if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(""); }
                                }}
                                onBlur={() => commitTimeEdit(editingTimeRaw)}
                            />
                        );
                        const renderField = (field: TimeField, display: string, label: string, editVal: string) => (
                            <div key={field} className="flex items-center gap-1.5">
                                {editingTimeField === field ? fieldInput : (
                                    <button
                                        className={`text-xs font-mono px-1.5 h-5 w-[3.8rem] bg-slate-700/50 rounded text-center transition-colors ${has ? 'text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer' : canCreate ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/70 cursor-pointer' : 'text-slate-600 cursor-default'}`}
                                        onClick={() => {
                                            if (has) { setEditingTimeField(field); setEditingTimeRaw(editVal); }
                                            else if (canCreate) { setEditingTimeField(field); setEditingTimeRaw(''); }
                                        }}
                                        data-tooltip={has ? `Edit selection ${label}` : canCreate ? `Set selection ${label}` : undefined}
                                    >
                                        {has ? display : ''}
                                    </button>
                                )}
                                <span className="text-[10px] text-slate-500 select-none w-6">{label}</span>
                            </div>
                        );
                        return (
                            <div className="flex flex-col justify-center gap-0.5" data-help-target="selection-time">
                                {renderField('selStart', region.start.toFixed(2), 'from', region.start.toFixed(2))}
                                {renderField('selEnd', region.end.toFixed(2), 'to', region.end.toFixed(2))}
                                {renderField('selDur', (region.end - region.start).toFixed(2), 'dur', (region.end - region.start).toFixed(2))}
                            </div>
                        );
                    })()}
                </div>

                {/* Spectrogram Settings */}
                <div className="ml-auto">
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
                        data-tooltip="Spectrogram Settings"
                        data-help-target="spectrogram-settings"
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
                onAnnotationsChange={setAnnotations}
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
      <TooltipLayer />
    </div>
  );
}