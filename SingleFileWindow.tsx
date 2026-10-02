import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Activity, ArrowLeft, Bug, ChevronDown, HelpCircle, X } from 'lucide-react';
import VideoPane from './components/VideoPane';
import { resolveVideoElementUrl } from './utils/videoUrl';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import { useChunkCacheVersion } from './hooks/useChunkCacheVersion';
import DebugConsole from './components/DebugConsole';
import { HelpHighlightHost } from './components/HelpHighlightHost';
import Toolbar, { speedRangeFor } from './components/Toolbar';
import BuzzdetectPanel from './components/BuzzdetectPanel';
import NeuronPalette from './components/NeuronPalette';
import SidebarStack from './components/SidebarStack';
import MessageDialog from './components/MessageDialog';
import { SpectrogramSettingsPanel } from './components/controls/SpectrogramSettingsPanel';
import TooltipLayer from './components/TooltipLayer';
import { Selection, SpectrogramSettings, VideoMode } from './types';
import { DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_SPLIT_RATIO, DEFAULT_LEFT_PANEL_WIDTH, DEFAULT_DATE_TIME_FORMAT, SIDEBAR_SECTION_NEURONS, isVideoFile } from './constants';
import { basename } from './utils/helpers';
import { suggestExportFilename, audioExportExtensions } from './utils/filenameTime';
import { getFileInfo, saveFileDialog, exportAudioRange, openFileDialog } from './utils/tauriCommands';
import { displayOfNearestKept, projectIntervalToDisplay } from './utils/subsetTimeline';
import { showHelpPage } from './utils/helpChannel';
import { useLiveHost } from './utils/liveBridge';
import { isFilterAvailable } from './utils/videoPlaybackMode';
import { createCurrentTimeStore } from './utils/currentTimeStore';
import { createViewportStore } from './utils/viewportStore';
import { useActivationStack } from './hooks/useActivationStack';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useBandPassFilter } from './hooks/useBandPassFilter';
import { useVideoFrameSource } from './hooks/useVideoFrameSource';
import { usePlaybackTransport } from './hooks/usePlaybackTransport';
import { useArrowKeys } from './hooks/useArrowKeys';
import { useShiftSweep } from './hooks/useShiftSweep';
import { useSpectrogramZoomHotkeys } from './hooks/useSpectrogramZoomHotkeys';
import { useHotkeys } from './hooks/useHotkeys';
import { useBuzzdetect } from './hooks/useBuzzdetect';
import { useSubsetTimeline } from './hooks/useSubsetTimeline';
import { useSubsetChunkCache, useTimelineSwap, useSourceFrameTime } from './hooks/useSubsetSync';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { annotationWindow, singleFileWindow } from './copy/ui';
import { tooltips } from './copy/tooltips';

// Stable identity: there are no annotation tools here for a neuron to take a color from.
const NO_TOOL_COLORS: Record<string, string> = {};

export interface SingleFileWindowProps {
  filePath: string;
  onClose: () => void;
}

// Lean viewer for a single audio/video file opened via "Open File" on the
// launch screen — no project, no file tree, no annotation tooling. The one
// extra is buzzdetect: a results CSV can be imported by hand (there is no
// project directory to look one up in), which brings the neuron palette, the
// activations panel and subset mode, all sharing AnnotationWindow's hooks. Reuses the
// same playback/spectrogram/video plumbing as AnnotationWindow (none of that
// is actually project-coupled — see useBandPassFilter/usePlaybackTransport/
// useVideoFrameSource, which all take plain shapes, not the Project type) but
// skips AnnotationWindow's own JSX shell, which hardcodes the file-tree +
// annotation-tools layout with no seam to opt out of.
export default function SingleFileWindow({ filePath, onClose }: SingleFileWindowProps) {
  const trackName = basename(filePath);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const videoSrcRef = useRef<string | null>(null);
  useEffect(() => { videoSrcRef.current = videoSrc; }, [videoSrc]);
  const [isAudioTrack, setIsAudioTrack] = useState(!isVideoFile(filePath));
  const [sampleRate, setSampleRate] = useState(44100);
  const [duration, setDuration] = useState(0);
  const [isProcessing, setIsProcessing] = useState(true);

  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  const trackPathRef = useRef<string | null>(filePath);
  const isAudioTrackRef = useRef(isAudioTrack);
  useEffect(() => { isAudioTrackRef.current = isAudioTrack; }, [isAudioTrack]);

  const [showDebug, setShowDebug] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{ time: string, msg: string, type: 'info' | 'error' }[]>([]);
  const addLog = useCallback((msg: string, type: 'info' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString();
    setDebugLogs(prev => [...prev, { time, msg, type }]);
  }, []);

  const activationStack = useActivationStack();

  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  const [boundAnnotationId, setBoundAnnotationId] = useState<string | null>(null);
  const [sweepStart, setSweepStart] = useState<number | null>(null);

  const [zoomSec, setZoomSec] = useState(DEFAULT_ZOOM_SEC);
  const zoomSecRef = useRef(DEFAULT_ZOOM_SEC);
  useEffect(() => { zoomSecRef.current = zoomSec; }, [zoomSec]);

  const [videoMode, setVideoMode] = useState<VideoMode>('fast');
  const videoModeRef = useRef(videoMode);
  useEffect(() => { videoModeRef.current = videoMode; }, [videoMode]);

  // ── buzzdetect ──────────────────────────────────────────────────────────────
  // Results come from one CSV picked by hand; nothing is persisted, so every
  // setting here is session state. Instantiated ahead of the frame source and
  // the transport for the same reason as in AnnotationWindow: the subset's
  // timeline decides the display duration and the effective video mode.
  const [buzzdetectFile, setBuzzdetectFile] = useState<string | null>(null);
  const [buzzdetectReloadNonce, setBuzzdetectReloadNonce] = useState(0);
  const [buzzdetectError, setBuzzdetectError] = useState<string | null>(null);
  const buzzdetect = useBuzzdetect({
    initialUi: undefined,
    dir: null,
    ident: null,
    file: buzzdetectFile,
    frameLength: undefined,
    trimActivationPrefix: undefined,
    reloadNonce: buzzdetectReloadNonce,
    addLog,
    onLoadError: msg => { setBuzzdetectFile(null); setBuzzdetectError(msg); },
  });
  const {
    buzzdetectEnabled, setBuzzdetectEnabled,
    buzzdetectThresholds, buzzdetectSubsetThresholds, setBuzzdetectSubsetEnabled,
    buzzdetectHiddenNeurons, buzzdetectNeuronColors,
    buzzdetectSeriesMode, setBuzzdetectSeriesMode,
    buzzdetectBinWidthOverride, setBuzzdetectBinWidthOverride,
    buzzdetectSubsetNeurons,
    buzzdetectMinDetectionRate, setBuzzdetectMinDetectionRate,
    buzzdetectSubsetBuffer, setBuzzdetectSubsetBuffer,
    buzzdetectPinnedNeurons,
    buzzdetectPanelHeight, setBuzzdetectPanelHeight,
    buzzdetectData,
    buzzdetectSettingsOpen, setBuzzdetectSettingsOpen,
    buzzdetectYAxisOverride, setBuzzdetectYAxisOverride,
    buzzdetectBaselineAdjusted, setBuzzdetectBaselineAdjusted,
    buzzdetectAutoBinWidth, setBuzzdetectAutoBinWidth,
    buzzdetectAutoYRange, setBuzzdetectAutoYRange,
    handleBuzzdetectThresholdChange,
    handleBuzzdetectSubsetThresholdChange,
    handleBuzzdetectToggleNeuron,
    handleBuzzdetectNeuronColorChange,
    handleBuzzdetectNeuronColorReset,
    handleBuzzdetectTogglePinNeuron,
    buzzdetectIsolatedNeurons,
    handleBuzzdetectToggleIsolateNeuron,
    buzzdetectIsolateEnabled,
    toggleBuzzdetectIsolate,
    toggleBuzzdetectSubset,
    handleBuzzdetectSetAllNeuronsHidden,
  } = buzzdetect;
  const {
    timeline, displayDuration, subsetActive, activeIsolatedNeurons,
    subsetGrainSec, subsetSourceRanges, subsetStats: buzzdetectSubsetStats, displayBuzzdetectData,
    effectiveVideoMode, effectiveVideoModeRef, timelineRef, displayDurationRef,
    subsetGrainRef, subsetSourceRangesRef, selectionToSource, selectAllSpanAt,
  } = useSubsetTimeline(buzzdetect, duration, videoMode);

  // Pick a CSV and load it. Every import opens the panel, including a replace:
  // an import that leaves nothing visible reads as a failure.
  const handleImportBuzzdetect = useCallback(async () => {
    const path = await openFileDialog(buzzdetectFile ?? filePath, [
      { name: singleFileWindow.importBuzzdetectFilter, extensions: ['csv'] },
    ]);
    if (!path) return;
    setBuzzdetectFile(path);
    setBuzzdetectReloadNonce(n => n + 1);
    setBuzzdetectEnabled(true);
    addLog(`Importing buzzdetect results: ${basename(path)}`);
  }, [buzzdetectFile, filePath, addLog, setBuzzdetectEnabled]);
  // Dropping the results also drops the subset: with nothing loaded there is
  // nothing for it to cut by, and the picks would otherwise sit engaged.
  const handleRemoveBuzzdetect = useCallback(() => {
    setBuzzdetectFile(null);
    setBuzzdetectSubsetEnabled(false);
  }, [setBuzzdetectSubsetEnabled]);
  const refreshBuzzdetect = useCallback(() => setBuzzdetectReloadNonce(n => n + 1), []);

  // No project to persist against in single-file mode — plain session state.
  const [videoBrightness, setVideoBrightness] = useState(100);
  const [videoContrast, setVideoContrast] = useState(100);

  const [settings, setSettings] = useState<SpectrogramSettings>(DEFAULT_SPECTROGRAM_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  // The left panel holds only the neuron palette, so it exists (and is
  // resizable, without the file panel's drag-to-collapse) once results are loaded.
  const {
    splitRatio, videoCollapsed, setVideoCollapsed,
    hideLabels, VIDEO_COLLAPSED_BAR_PX, handleSplitDrag,
    sidebarSections, leftPanelWidth, handleLeftPanelWidthDrag,
  } = usePanelLayout({
    splitRatio: DEFAULT_SPLIT_RATIO, sidebarSections: {},
    leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH, leftPanelCollapsible: false, findPanelWidth: 0,
  });

  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const { cacheVersion, bumpCacheVersion } = useChunkCacheVersion();

  const spectrogramRef = useRef<SpectrogramHandle>(null);

  // The spectrogram's live time→pixel transform — read by the arrow keys for
  // their per-pixel fine moves. See AnnotationWindow for why it's a ref store.
  const viewportStoreRef = useRef(createViewportStore());

  const {
    frameSourceRef, frameSourceVersion, setFrameSourceVersion, frameSourceDecodeError,
    videoPrefetchEndRef, videoPrefetchBusyRef, preZoomExtentRef, prerollVideo,
  } = useVideoFrameSource({
    // Effective, not preferred: a subset closes the frame source outright.
    trackPath: filePath, trackPathRef, isAudioTrack, videoMode: effectiveVideoMode, durationRef, selectionRef,
    timelineRef, addLog,
  });

  // No annotation tools exist in this mode; the example-player mutual-exclusion
  // hook usePlaybackTransport expects is simply inert here.
  const examplePlayer = { playingToolId: null as string | null, toggle: () => {}, stop: () => {} };

  const {
    isPlaying, isBuffering, playbackSpeed, setPlaybackSpeed, lastDefinedSpeed, setLastDefinedSpeed,
    volume, setVolume, muted, setMuted, playheadLocked, setPlayheadLocked,
    timeDisplayUnit, setTimeDisplayUnit,
    engineRef, currentTimeRef, currentTimeStoreRef,
    togglePlay, seek, clearSelectionEnd, getMediaTime, attachVideoElement,
  } = usePlaybackTransport({
    project: { preferences: {} },
    // The transport runs on the DISPLAY axis, so it gets the display duration and
    // the effective video mode (see AnnotationWindow).
    isAudioTrack, isAudioTrackRef, videoMode: effectiveVideoMode, videoModeRef: effectiveVideoModeRef,
    videoSrc, videoSrcRef, duration: displayDuration, durationRef: displayDurationRef,
    selection, selectionRef, frameSourceRef, videoPrefetchEndRef, videoPrefetchBusyRef,
    prerollVideo, timelineRef, spectrogramRef, examplePlayer, addLog,
  });
  const getFrameTime = useSourceFrameTime(timelineRef, getMediaTime);

  // Spectrogram zoom-in/out/fit-to-track hotkeys — identical registration to
  // AnnotationWindow's (see hooks/useSpectrogramZoomHotkeys.ts); this window
  // has no viewport store to read for the mod+0 "remember where I was"
  // snapshot, so it falls back to the hook's default (start of window = 0).
  useSpectrogramZoomHotkeys({ spectrogramRef, durationRef: displayDurationRef, zoomSecRef, preZoomExtentRef, selectionRef });

  const bandPassProjectRef = useRef({ id: 'single-file', preferences: {} as { bandPassFilter?: import('./types').BandPassFilter | null } });
  const prevProjectIdRef = useRef<string | null>('single-file');
  const {
    filterToolActive, setFilterToolActive, bandPassFilter, setBandPassFilter, filterStrength, setFilterStrength,
    handleToggleFilterTool, handleToggleFilterState, handleDisableBandPassFilter,
    handleEnableBandPassFilter, handleBandPassFilterDrawn,
  } = useBandPassFilter({
    project: bandPassProjectRef.current,
    engineRef,
    activationStack,
    projectRef: bandPassProjectRef,
    prevProjectIdRef,
    updateProjectPreferences: async () => undefined,
    isAudioTrack,
    videoMode: effectiveVideoMode,
  });

  // Builds the spectrogram chunk cache (opening the file, changing the FFT size,
  // engaging or re-graining a subset) and keeps it in step with the subset.
  const installChunkCache = useSubsetChunkCache({
    chunkCacheRef, bumpCacheVersion, fftSize: settings.fftSize,
    trackPath: filePath, sampleRate, duration, displayDuration, zoomSec,
    subsetGrainSec, subsetSourceRanges, subsetGrainRef, subsetSourceRangesRef, timelineRef,
  });

  // Load the file once on mount (this window is scoped to exactly one file —
  // "next/prev" and re-opening a different file both go back through the
  // launch screen, which mounts a fresh instance).
  useEffect(() => {
    let cancelled = false;
    const isAudio = !isVideoFile(filePath);
    setIsAudioTrack(isAudio);
    resolveVideoElementUrl(filePath).then(url => { if (!cancelled) setVideoSrc(url); });
    setIsProcessing(true);
    addLog(`Opening: ${trackName}`);

    (async () => {
      try {
        let sr: number, dur: number;
        if (engineRef.current) {
          const info = await engineRef.current.loadFile(filePath);
          sr = info.sampleRate;
          dur = info.durationSec;
          addLog(`File info: ${dur.toFixed(2)}s, ${sr}Hz, ${info.channels}ch`);
        } else {
          const info = await getFileInfo(filePath);
          sr = info.sample_rate;
          dur = info.duration_secs;
          addLog(`File info: ${dur.toFixed(2)}s, ${sr}Hz, ${info.channels}ch`);
        }
        if (cancelled) return;
        setSampleRate(sr);
        if (dur > 0) setDuration(dur);
        setSettings(s => s.maxFreq > sr / 2 ? { ...s, maxFreq: sr / 2 } : s);
        const effectiveZoom = (dur > 0 && dur < zoomSecRef.current) ? Math.max(MIN_ZOOM_SEC, dur) : zoomSecRef.current;
        if (effectiveZoom !== zoomSecRef.current) setZoomSec(effectiveZoom);

        installChunkCache(filePath, sr, dur, effectiveZoom);
        addLog('Spectrogram loading...');
      } catch (err) {
        if (cancelled) return;
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog(`Error opening file: ${errMsg}`, 'error');
        setVideoSrc(null);
        setDuration(0);
      } finally {
        if (!cancelled) setIsProcessing(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const handleSelectionChange = useCallback((s: Selection | null) => {
    setSelection(s);
    // Sync synchronously, not just via the state-mirroring effect below: a caller
    // that seeks in the same tick as committing a new selection (e.g. snapping the
    // playhead into a just-created selection) needs seek()'s bounded-restart logic
    // to see the new selection immediately, not the stale one from last render.
    selectionRef.current = s;
    if (s) {
      activationStack.pushIfAbsent('selection');
      frameSourceRef.current?.pinSelectionRange(s.start, s.end);
    } else {
      activationStack.remove('selection');
      frameSourceRef.current?.clearPinnedRange();
      // The selection was driving playback's bounded stop — drop it so
      // playback continues through to EOF instead of stopping at the now-stale
      // selection end.
      clearSelectionEnd();
    }
  }, [activationStack, frameSourceRef, clearSelectionEnd]);

  // Hand the engine the subset's axis and bring the view onto it — see
  // hooks/useSubsetSync.ts.
  useTimelineSwap({
    timeline, displayDuration, engineRef, handleSelectionChange, seek, currentTimeRef,
    spectrogramRef, zoomSecRef, setZoomSec,
  });

  // Export the current selection's audio to a file. The selection is display
  // time; the file is read at its source time (selectionToSource), which under
  // a subset is not the same thing. No project here, so no filename-timestamp
  // scheme to reuse — suggestExportFilename falls back to its "_s<offset>" default.
  const handleExportSelection = useCallback(async () => {
    if (!selection) return;
    const src = selectionToSource(selection);
    const filename = basename(filePath);
    const dir = filePath.slice(0, filePath.length - filename.length);
    const suggested = suggestExportFilename(filename, src.start);
    const chosenPath = await saveFileDialog(`${dir}${suggested}`, [
      { name: 'Audio File', extensions: audioExportExtensions(filename) },
    ]);
    if (!chosenPath) return;
    try {
      await exportAudioRange(filePath, src.start, src.end - src.start, chosenPath);
      addLog(`Exported selection to ${basename(chosenPath)}`);
    } catch (err) {
      addLog(`Error exporting audio: ${err}`, 'error');
    }
  }, [selection, filePath, selectionToSource, addLog]);

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
    onSelectionChange: handleSelectionChange,
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
  });

  // Everything else (playback transport, spectrogram zoom, band-pass filter,
  // undo/redo) registers its own hotkeys inside the hook that owns its
  // state/handlers — see usePlaybackTransport, useSpectrogramZoomHotkeys, and
  // useBandPassFilter above. What's left here is specific to this window.
  useHotkeys([
    // Help guide — also fires inside text inputs, since help is universal.
    { key: 'F1', allowInInput: true, handler: () => showHelpPage('single-file') },
    { key: 'a', mods: ['mod'], handler: () => { if (displayDuration > 0) handleSelectionChange(selectAllSpanAt(currentTimeRef.current)); } },
    // No annotations here, so these walk the subset's segment starts.
    { key: 'ArrowLeft', mods: ['alt'], handler: () => spectrogramRef.current?.goToPrevAnnotation() },
    { key: 'ArrowRight', mods: ['alt'], handler: () => spectrogramRef.current?.goToNextAnnotation() },
    // Shift+S: subset the track to the picked neurons' detections, and back.
    { key: 's', mods: ['shift'], handler: toggleBuzzdetectSubset },
    { key: 'e', mods: ['mod', 'shift'], handler: () => handleExportSelection() },
    { key: 'Escape', allowInInput: true, handler: () => {
        const top = activationStack.popTop();
        switch (top) {
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
            break;
        }
    }},
  ]);

  const liveSpeedRange = speedRangeFor(isAudioTrack, videoMode);

  // Mirror the toolbar into the help guide window, same as AnnotationWindow —
  // opening the guide from single-file mode gets live controls too. Only one of
  // the two windows is ever mounted, so there's never a second host.
  useLiveHost(
    {
      hasTrack: !!videoSrc,
      duration,
      isPlaying,
      isBuffering,
      volume,
      muted,
      playbackSpeed,
      lastDefinedSpeed,
      speedMin: liveSpeedRange.min,
      speedMax: liveSpeedRange.max,
      // Source time, like everything else on the bridge (see LiveSnapshot).
      selection: selection && selectionToSource(selection),
      timeDisplayUnit,
      selectedTimeDisplayUnit: timeDisplayUnit,
      // No project, so no filename-timestamp format to read a start from —
      // single-file mode never shows wall-clock times.
      trackStartMs: null,
      dateTimeFormat: DEFAULT_DATE_TIME_FORMAT,
      // Single-file mode has no annotations to step between.
      canGoPrevAnnotation: false,
      canGoNextAnnotation: false,
      playheadLocked,
      filterToolActive,
      filterUnavailable: !isFilterAvailable(isAudioTrack, videoMode),
      filterEnabled: bandPassFilter !== null,
      filterStrength,
      bandPassFilter,
      buzzdetectAvailable: buzzdetectFile !== null,
      buzzdetectEnabled,
      subsetAvailable: buzzdetectSubsetNeurons.length > 0,
      subsetActive,
      isolateAvailable: buzzdetectIsolatedNeurons.length > 0,
      isolateActive: activeIsolatedNeurons.length > 0,
      spectrogramSettings: settings,
      spectrogramSettingsOpen: showSettings,
      sampleRate,
      // No file panel and no annotation tools in single-file mode — the guide's
      // copies of those fall back to their demos rather than to dead buttons.
      filePanel: null,
      toolPalette: null,
      debugLogs,
    },
    {
      play: togglePlay,
      // A time a subset cut out has no place on the axis, so it goes to the
      // nearest kept moment — the same answer typing it into the toolbar gives.
      seek: (t, scroll) => seek(displayOfNearestKept(timeline, t), scroll),
      skipToStart: () => { seek(0, true); handleSelectionChange(null); setBoundAnnotationId(null); },
      skipToEnd: () => { seek(displayDuration, true); handleSelectionChange(null); setBoundAnnotationId(null); },
      prevAnnotation: () => {},
      nextAnnotation: () => {},
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
        if (d) handleSelectionChange(d);
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
      toggleIsolate: toggleBuzzdetectIsolate,
      toggleSpectrogramSettings: () => setShowSettings(s => !s),
      setSpectrogramSettings: patch => setSettings(s => ({ ...s, ...patch })),
      toggleFileExpandCollapse: () => {},
      toggleFileFilter: () => {},
      toggleBuzzdetectFilter: () => {},
      activateTool: () => {},
      activateSelectMode: () => {},
      openToolSettings: () => {},
      openFindLabel: () => {},
      editTool: () => {},
      requestDeleteTool: () => {},
      playExample: () => {},
      showExamples: () => {},
    },
    currentTimeStoreRef.current,
    // Bound, not passed as a bare method reference — Timeline is a class.
    t => timeline.toSource(t),
  );

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-200">
      <header className="flex-none h-16 bg-slate-800 border-b border-slate-700 flex items-center px-4 justify-between select-none z-50 relative">
        <div className="flex items-center space-x-4 min-w-0">
          <button
            onClick={onClose}
            className="flex items-center space-x-1 text-slate-400 hover:text-white hover:bg-slate-700 px-2 py-1.5 rounded transition-colors flex-none"
            data-tooltip={tooltips.backToProjects}
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-lg font-semibold truncate">{trackName}</h1>
          {/* Single-file mode has no results directory to find a track's buzzdetect
              file in, so it's picked by hand. Once loaded the same button replaces it. */}
          <div className="flex items-center flex-none min-w-0">
            <button
              onClick={handleImportBuzzdetect}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded transition-colors min-w-0 ${buzzdetectFile ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:bg-slate-700 hover:text-white'}`}
              data-tooltip={buzzdetectFile ? tooltips.replaceBuzzdetect : tooltips.importBuzzdetect}
            >
              <Activity size={16} className="flex-none" />
              <span className="text-xs font-medium">{singleFileWindow.importBuzzdetectLabel}</span>
              {buzzdetectFile && (
                <span className="text-xs text-slate-400 truncate max-w-[14rem]">{basename(buzzdetectFile)}</span>
              )}
            </button>
            {buzzdetectFile && (
              <button
                onClick={handleRemoveBuzzdetect}
                className="p-1.5 rounded text-slate-500 hover:bg-slate-700 hover:text-white transition-colors"
                data-tooltip={tooltips.removeBuzzdetect}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowDebug(true)}
            className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
          >
            <Bug size={18} />
          </button>
          <button
            onClick={() => showHelpPage('single-file')}
            className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
            data-tooltip={tooltips.helpGuide}
          >
            <HelpCircle size={18} />
          </button>
        </div>
      </header>

      <DebugConsole open={showDebug} onClose={() => setShowDebug(false)} logs={debugLogs} />

      {buzzdetectError && (
        <MessageDialog
          title={singleFileWindow.importBuzzdetectErrorTitle}
          message={buzzdetectError}
          okLabel={singleFileWindow.importBuzzdetectErrorOk}
          onClose={() => setBuzzdetectError(null)}
        />
      )}

      <div className="flex-1 flex min-h-0 relative overflow-hidden">
        {/* Left: the neuron palette, alone, once results are loaded. It's a stack
            of one so it takes the same collapse/sizing as AnnotationWindow's. */}
        {buzzdetectFile !== null && (
          <div
            className="flex-none bg-slate-900 border-r border-slate-700 flex flex-col h-full relative"
            style={{ width: leftPanelWidth }}
          >
            <SidebarStack
              sections={sidebarSections}
              items={[{
                id: SIDEBAR_SECTION_NEURONS,
                node: (
                  <NeuronPalette
                    data={buzzdetectData}
                    onRefreshBuzzdetect={refreshBuzzdetect}
                    thresholds={buzzdetectThresholds}
                    subsetThresholds={buzzdetectSubsetThresholds}
                    hiddenNeurons={buzzdetectHiddenNeurons}
                    neuronColors={buzzdetectNeuronColors}
                    toolColors={NO_TOOL_COLORS}
                    subsetNeurons={buzzdetectSubsetNeurons}
                    pinnedNeurons={buzzdetectPinnedNeurons}
                    collapsed={sidebarSections.isCollapsed(SIDEBAR_SECTION_NEURONS)}
                    onToggleCollapsed={() => sidebarSections.toggleCollapsed(SIDEBAR_SECTION_NEURONS)}
                    onToggleNeuron={handleBuzzdetectToggleNeuron}
                    onSetAllNeuronsHidden={(hidden) => handleBuzzdetectSetAllNeuronsHidden(buzzdetectData?.neurons ?? [], hidden)}
                    isolatedNeurons={buzzdetectIsolatedNeurons}
                    onToggleIsolateNeuron={handleBuzzdetectToggleIsolateNeuron}
                    isolateEnabled={buzzdetectIsolateEnabled}
                    onToggleIsolate={toggleBuzzdetectIsolate}
                    onNeuronColorChange={handleBuzzdetectNeuronColorChange}
                    onNeuronColorReset={handleBuzzdetectNeuronColorReset}
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
              }]}
            />
            {/* Right-edge width resize handle — sits on the outer face of the border */}
            <div
              className="absolute top-0 bottom-0 cursor-col-resize hover:bg-[#e65161]/60 transition-colors z-50"
              style={{ right: '-6px', width: '6px' }}
              onMouseDown={handleLeftPanelWidthDrag}
            />
          </div>
        )}

        <div className="flex-1 flex flex-col relative overflow-hidden">
          {!isAudioTrack && (
            <>
              <div
                style={{ height: videoCollapsed ? VIDEO_COLLAPSED_BAR_PX : `${splitRatio * 100}%` }}
                className="bg-black relative flex flex-none overflow-hidden"
              >
                <VideoPane
                  frameSource={frameSourceRef.current}
                  frameSourceVersion={frameSourceVersion}
                  frameSourceDecodeError={frameSourceDecodeError}
                  isAudioTrack={isAudioTrack}
                  videoSrc={videoSrc}
                  isProcessing={isProcessing}
                  isBuffering={isBuffering}
                  getFrameTime={getFrameTime}
                  onDebugLog={addLog}
                  onDurationChange={setDuration}
                  videoMode={videoMode}
                  hasSelection={selection !== null}
                  onVideoModeChange={setVideoMode}
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

              <div
                className="h-2 bg-slate-800 border-y border-slate-700 cursor-row-resize hover:bg-[#e65161]/50 transition-colors z-10 flex justify-center items-center"
                onMouseDown={handleSplitDrag}
              >
                <div className="w-12 h-1 bg-slate-600 rounded-full" />
              </div>
            </>
          )}

          <div className="relative flex-1 min-h-0 bg-slate-900 border-t border-slate-700 flex flex-col">
            {showSettings && (
              <div className="absolute top-10 right-4 z-50 bg-slate-800 border border-slate-600 shadow-xl rounded-lg w-72 max-h-[calc(100%-4rem)] overflow-y-auto custom-scrollbar flex flex-col">
                <SpectrogramSettingsPanel settings={settings} onChange={patch => setSettings(s => ({ ...s, ...patch }))} />
              </div>
            )}

            <Toolbar
              isPlaying={isPlaying}
              isBuffering={isBuffering}
              videoSrc={videoSrc}
              currentTimeStore={currentTimeStoreRef.current}
              duration={displayDuration}
              selection={selection}
              volume={volume}
              muted={muted}
              canGoPrevAnnotation={false}
              canGoNextAnnotation={false}
              spectrogramRef={spectrogramRef}
              setVolume={setVolume}
              setMuted={setMuted}
              onPlay={togglePlay}
              onSeek={seek}
              onSelectionChange={handleSelectionChange}
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
              timeDisplayUnit={timeDisplayUnit}
              onTimeDisplayUnitChange={setTimeDisplayUnit}
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
                ident={null}
                settings={settings}
                onSettingsChange={patch => setSettings(s => ({ ...s, ...patch }))}
                zoomSec={zoomSec}
                annotations={[]}
                selectedAnnotationId={null}
                activeAnnotationTool={null}
                annotationTools={[]}
                selection={selection}
                sweepStart={sweepStart}
                boundAnnotationId={boundAnnotationId}
                onSeek={seek}
                onAnnotationsChange={() => {}}
                onAnnotationsCommit={() => {}}
                onSelectAnnotation={() => {}}
                onSelectionChange={handleSelectionChange}
                onBoundAnnotationChange={setBoundAnnotationId}
                onZoomChange={setZoomSec}
                onViewportChange={v => viewportStoreRef.current.set(v)}
                filterToolActive={filterToolActive}
                bandPassFilter={bandPassFilter}
                onBandPassFilterChange={setBandPassFilter}
                onBandPassFilterDrawn={handleBandPassFilterDrawn}
                topTool={activationStack.topOf(['filterTool']) as 'filterTool' | null}
                videoMode={effectiveVideoMode}
                isAudioTrack={isAudioTrack}
                playheadLocked={playheadLocked}
                hideLabels={hideLabels}
                onExportSelection={handleExportSelection}
                onCreateTool={() => {}}
                onBindHotkey={() => {}}
                onListenExample={() => {}}
              />
            </div>

            {buzzdetectFile !== null && buzzdetectEnabled && (
              <BuzzdetectPanel
                data={displayBuzzdetectData}
                viewportStore={viewportStoreRef.current}
                duration={displayDuration}
                currentTimeStore={currentTimeStoreRef.current}
                selection={selection}
                timeDisplayUnit={timeDisplayUnit}
                thresholds={buzzdetectThresholds}
                hiddenNeurons={buzzdetectHiddenNeurons}
                isolatedNeurons={activeIsolatedNeurons}
                neuronColors={buzzdetectNeuronColors}
                toolColors={NO_TOOL_COLORS}
                seriesMode={buzzdetectSeriesMode}
                binWidthOverride={buzzdetectBinWidthOverride}
                subsetActive={subsetActive}
                timeline={timeline}
                yAxisOverride={buzzdetectYAxisOverride}
                baselineAdjusted={buzzdetectBaselineAdjusted}
                onBaselineAdjustedChange={setBuzzdetectBaselineAdjusted}
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
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <TooltipLayer />
      <HelpHighlightHost />
    </div>
  );
}
