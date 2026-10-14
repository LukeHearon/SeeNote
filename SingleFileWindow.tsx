import { useState, useRef, useEffect, useCallback } from 'react';
import { Activity, ArrowLeft, Bug, HelpCircle, X } from 'lucide-react';
import { resolveVideoElementUrl } from './utils/videoUrl';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import { useChunkCacheVersion } from './hooks/useChunkCacheVersion';
import DebugConsole, { type DebugLog } from './components/DebugConsole';
import { HelpHighlightHost } from './components/HelpHighlightHost';
import TransportToolbar from './components/TransportToolbar';
import TrackColumn from './components/TrackColumn';
import { usePopouts } from './hooks/usePopouts';
import { BuzzdetectNeuronPalette, BuzzdetectSettingsBlock, BuzzdetectTrackPanel } from './components/buzzdetect/BuzzdetectViews';
import SidebarStack from './components/SidebarStack';
import MessageDialog from './components/MessageDialog';
import { SpectrogramSettingsPanel } from './components/controls/SpectrogramSettingsPanel';
import TooltipLayer from './components/TooltipLayer';
import { Selection, SpectrogramSettings, VideoMode } from './types';
import { DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_ZOOM_SEC, DEFAULT_SPLIT_RATIO, DEFAULT_LEFT_PANEL_WIDTH, DEFAULT_DATE_TIME_FORMAT, SIDEBAR_SECTION_NEURONS, isVideoFile } from './constants';
import { basename } from './utils/helpers';
import { openFileDialog } from './utils/tauriCommands';
import { showHelpPage } from './utils/helpChannel';
import { createViewportStore } from './utils/viewportStore';
import { useActivationStack, escapeUnwindBinding } from './hooks/useActivationStack';
import { useSelectionControl } from './hooks/useSelectionControl';
import { useExportSelection } from './hooks/useExportSelection';
import { useTrackLoader } from './hooks/useTrackLoader';
import { useWindowLiveHost, NO_PROJECT_LIVE_HANDLERS } from './hooks/useWindowLiveHost';
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
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
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
  const { buzzdetectEnabled, setBuzzdetectEnabled, setBuzzdetectSubsetEnabled, toggleBuzzdetectSubset } = buzzdetect;
  const subset = useSubsetTimeline(buzzdetect, duration, videoMode);
  const {
    timeline, displayDuration,
    subsetGrainSec, subsetSourceRanges,
    effectiveVideoMode, effectiveVideoModeRef, timelineRef, displayDurationRef,
    subsetGrainRef, subsetSourceRangesRef, selectionToSource, selectAllSpanAt,
  } = subset;

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
  const { bumpCacheVersion } = useChunkCacheVersion(chunkCacheRef);

  const spectrogramRef = useRef<SpectrogramHandle>(null);
  const popouts = usePopouts();

  // The spectrogram's live time→pixel transform — read by the arrow keys for
  // their per-pixel fine moves. See AnnotationWindow for why it's a ref store.
  const viewportStoreRef = useRef(createViewportStore());

  const {
    frameSourceRef, frameSourceVersion, frameSourceDecodeError,
    videoPrefetchEndRef, videoPrefetchBusyRef, preZoomExtentRef, prerollVideo,
  } = useVideoFrameSource({
    // Effective, not preferred: a subset closes the frame source outright.
    trackPath: filePath, trackPathRef, isAudioTrack, videoMode: effectiveVideoMode, durationRef, selectionRef,
    timelineRef, addLog,
  });

  // No annotation tools exist in this mode; the example-player mutual-exclusion
  // hook usePlaybackTransport expects is simply inert here.
  const examplePlayer = { playingToolId: null as string | null, toggle: () => {}, stop: () => {} };

  const transport = usePlaybackTransport({
    project: { preferences: {} },
    // The transport runs on the DISPLAY axis, so it gets the display duration and
    // the effective video mode (see AnnotationWindow).
    isAudioTrack, isAudioTrackRef, videoMode: effectiveVideoMode, videoModeRef: effectiveVideoModeRef,
    videoSrc, videoSrcRef, duration: displayDuration, durationRef: displayDurationRef,
    selection, selectionRef, frameSourceRef, videoPrefetchEndRef, videoPrefetchBusyRef,
    prerollVideo, timelineRef, spectrogramRef, examplePlayer, addLog,
  });
  const {
    isPlaying, isBuffering,
    playheadLocked,
    timeDisplayUnit,
    engineRef, currentTimeRef, currentTimeStoreRef,
    togglePlay, seek, clearSelectionEnd, bindSelectionEnd, getMediaTime, attachVideoElement,
  } = transport;
  const getFrameTime = useSourceFrameTime(timelineRef, getMediaTime);

  // Spectrogram zoom-in/out/fit-to-track hotkeys — identical registration to
  // AnnotationWindow's (see hooks/useSpectrogramZoomHotkeys.ts); this window
  // has no viewport store to read for the mod+0 "remember where I was"
  // snapshot, so it falls back to the hook's default (start of window = 0).
  useSpectrogramZoomHotkeys({ spectrogramRef, durationRef: displayDurationRef, zoomSecRef, preZoomExtentRef, selectionRef });

  const bandPassProjectRef = useRef({ id: 'single-file', preferences: {} as { bandPassFilter?: import('./types').BandPassFilter | null } });
  const prevProjectIdRef = useRef<string | null>('single-file');
  const filter = useBandPassFilter({
    project: bandPassProjectRef.current,
    engineRef,
    activationStack,
    prevProjectIdRef,
    updateProjectPreferences: async () => undefined,
    isAudioTrack,
    videoMode: effectiveVideoMode,
  });
  const {
    filterToolActive, setFilterToolActive, bandPassFilter, setBandPassFilter,
    handleBandPassFilterDrawn,
  } = filter;

  // Builds the spectrogram chunk cache (opening the file, changing the FFT size,
  // engaging or re-graining a subset) and keeps it in step with the subset.
  const installChunkCache = useSubsetChunkCache({
    chunkCacheRef, bumpCacheVersion, fftSize: settings.fftSize,
    trackPath: filePath, sampleRate, duration, displayDuration, zoomSec,
    subsetGrainSec, subsetSourceRanges, subsetGrainRef, subsetSourceRangesRef, timelineRef,
  });

  const loadTrack = useTrackLoader({
    engineRef, zoomSecRef, setSampleRate, setDuration, setSettings, setZoomSec, installChunkCache, addLog,
  });

  // Load the file once on mount (this window is scoped to exactly one file —
  // "next/prev" and re-opening a different file both go back through the
  // launch screen, which mounts a fresh instance).
  useEffect(() => {
    let cancelled = false;
    setIsAudioTrack(!isVideoFile(filePath));
    resolveVideoElementUrl(filePath).then(url => { if (!cancelled) setVideoSrc(url); });
    setIsProcessing(true);
    addLog(`Opening: ${trackName}`);
    loadTrack(filePath, () => cancelled)
      .catch(err => {
        if (cancelled) return;
        addLog(`Error opening file: ${err instanceof Error ? err.message : String(err)}`, 'error');
        setVideoSrc(null);
        setDuration(0);
      })
      .finally(() => { if (!cancelled) setIsProcessing(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  const handleSelectionChange = useSelectionControl({
    setSelection, selectionRef, activationStack, frameSourceRef, clearSelectionEnd, bindSelectionEnd, selectionToSource,
  });

  // Hand the engine the subset's axis and bring the view onto it — see
  // hooks/useSubsetSync.ts.
  useTimelineSwap({
    timeline, displayDuration, engineRef, handleSelectionChange, seek, currentTimeRef,
    spectrogramRef, zoomSecRef, setZoomSec,
  });

  const handleExportSelection = useExportSelection({ selection, trackPath: filePath, selectionToSource, addLog });

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
    // B: show/hide the buzzdetect panel (only once a results file is loaded).
    { key: 'b', handler: () => { if (buzzdetectFile !== null) setBuzzdetectEnabled(v => !v); } },
    { key: 'e', mods: ['mod', 'shift'], handler: () => handleExportSelection() },
    escapeUnwindBinding(activationStack, {
      selection: () => { handleSelectionChange(null); setBoundAnnotationId(null); },
      filterTool: () => setFilterToolActive(false),
      filterBand: () => setBandPassFilter(null),
    }),
  ]);

  // Opening the guide from single-file mode gets live controls too.
  useWindowLiveHost({
    transport, filter, buzzdetect, subset,
    hasTrack: !!videoSrc, duration, sampleRate, isAudioTrack, videoMode,
    selection, handleSelectionChange, setBoundAnnotationId,
    settings, setSettings, showSettings, setShowSettings, debugLogs, spectrogramRef,
    snapshot: {
      isBuffering,
      timeDisplayUnit,
      selectedTimeDisplayUnit: timeDisplayUnit,
      // No project, so no filename-timestamp format to read a start from —
      // single-file mode never shows wall-clock times.
      trackStartMs: null,
      dateTimeFormat: DEFAULT_DATE_TIME_FORMAT,
      // Single-file mode has no annotations to step between.
      canGoPrevAnnotation: false,
      canGoNextAnnotation: false,
      buzzdetectAvailable: buzzdetectFile !== null,
      // No file panel and no annotation tools here — the guide's copies of
      // those fall back to their demos rather than to dead buttons.
      filePanel: null,
      toolPalette: null,
    },
    handlers: NO_PROJECT_LIVE_HANDLERS,
  });

  // Where the view's left edge sits, for a spectrogram that a pop-out or pop-in
  // is about to remount in a box of another width.
  const { scrollLeft: viewLeft, pixelsPerSecond: viewPps } = viewportStoreRef.current.get();
  const leftEdgeTime = viewPps > 0 ? viewLeft / viewPps : 0;

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
                  <BuzzdetectNeuronPalette
                    buzzdetect={buzzdetect}
                    subset={subset}
                    toolColors={NO_TOOL_COLORS}
                    collapsed={sidebarSections.isCollapsed(SIDEBAR_SECTION_NEURONS)}
                    onToggleCollapsed={() => sidebarSections.toggleCollapsed(SIDEBAR_SECTION_NEURONS)}
                    onRefresh={refreshBuzzdetect}
                    settingsAway={buzzdetectEnabled && popouts.isPopped('buzzdetect')}
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

        <TrackColumn
          popouts={popouts}
          video={isAudioTrack ? null : {
              collapsed: videoCollapsed,
              splitRatio,
              collapsedBarPx: VIDEO_COLLAPSED_BAR_PX,
              onExpand: () => setVideoCollapsed(false),
              onSplitDrag: handleSplitDrag,
              pane: {
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
                onVideoModeChange: setVideoMode,
                onVideoElement: attachVideoElement,
                brightness: videoBrightness,
                contrast: videoContrast,
                onBrightnessChange: setVideoBrightness,
                onContrastChange: setVideoContrast,
              },
          }}
          spectrogramSettings={{
            open: showSettings,
            onToggle: () => setShowSettings(s => !s),
            panel: <SpectrogramSettingsPanel settings={settings} onChange={patch => setSettings(s => ({ ...s, ...patch }))} />,
          }}
          toolbar={
            <TransportToolbar
              transport={transport}
              filter={filter}
              isBuffering={isBuffering}
              videoSrc={videoSrc}
              duration={displayDuration}
              selection={selection}
              canGoPrevAnnotation={false}
              canGoNextAnnotation={false}
              spectrogramRef={spectrogramRef}
              onSelectionChange={handleSelectionChange}
              onBoundAnnotationChange={setBoundAnnotationId}
              showSettings={showSettings}
              onToggleSettings={() => setShowSettings(s => !s)}
              videoMode={effectiveVideoMode}
              isAudioTrack={isAudioTrack}
              timeDisplayUnit={timeDisplayUnit}
              timeline={timeline}
            />
          }
          spectrogram={
              <Spectrogram
                ref={spectrogramRef}
                chunkCache={chunkCacheRef.current}
                sampleRate={sampleRate}
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
                initialLeftEdgeTime={leftEdgeTime}
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
          }
          buzzdetect={buzzdetectFile !== null && buzzdetectEnabled ? {
            settingsOpen: buzzdetect.buzzdetectSettingsOpen,
            onToggleSettings: () => buzzdetect.setBuzzdetectSettingsOpen(v => !v),
            settings: <BuzzdetectSettingsBlock buzzdetect={buzzdetect} subset={subset} />,
            panel: fill => (
              <BuzzdetectTrackPanel
                fill={fill}
                buzzdetect={buzzdetect}
                subset={subset}
                toolColors={NO_TOOL_COLORS}
                viewportStore={viewportStoreRef.current}
                currentTimeStore={currentTimeStoreRef.current}
                selection={selection}
                timeDisplayUnit={timeDisplayUnit}
                spectrogramRef={spectrogramRef}
                onSelectionChange={handleSelectionChange}
                onBoundAnnotationChange={setBoundAnnotationId}
                onSeek={seek}
              />
            ),
          } : null}
          overlay={!videoSrc && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-slate-600 text-center">
                <p className="text-lg font-medium">{annotationWindow.noMediaTitle}</p>
              </div>
            </div>
          )}
        />
      </div>
      <TooltipLayer />
      <HelpHighlightHost />
    </div>
  );
}
