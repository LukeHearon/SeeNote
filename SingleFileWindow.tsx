import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, Bug, ChevronDown } from 'lucide-react';
import VideoPane from './components/VideoPane';
import Spectrogram, { SpectrogramHandle } from './components/Spectrogram';
import DebugConsole from './components/DebugConsole';
import Toolbar from './components/Toolbar';
import LevelRangeSlider from './components/LevelRangeSlider';
import TooltipLayer from './components/TooltipLayer';
import { FrequencyScale, Selection, SpectrogramSettings, VideoMode } from './types';
import { DEFAULT_SPECTROGRAM_SETTINGS, DEFAULT_ZOOM_SEC, MIN_ZOOM_SEC, DEFAULT_SPLIT_RATIO, isVideoFile } from './constants';
import { basename } from './utils/helpers';
import { getFileInfo, toAssetUrl } from './utils/tauriCommands';
import { createCurrentTimeStore } from './utils/currentTimeStore';
import { useActivationStack } from './hooks/useActivationStack';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useBandPassFilter } from './hooks/useBandPassFilter';
import { useVideoFrameSource } from './hooks/useVideoFrameSource';
import { usePlaybackTransport } from './hooks/usePlaybackTransport';
import { useSpectrogramZoomHotkeys } from './hooks/useSpectrogramZoomHotkeys';
import { useHotkeys } from './hooks/useHotkeys';
import { MultiTierSpectrogramCache } from './MultiTierSpectrogramCache';
import { annotationWindow } from './copy/ui';
import { tooltips } from './copy/tooltips';

export interface SingleFileWindowProps {
  filePath: string;
  onClose: () => void;
}

// Lean viewer for a single audio/video file opened via "Open File" on the
// launch screen — no project, no file tree, no annotation tooling. Reuses the
// same playback/spectrogram/video plumbing as AnnotationWindow (none of that
// is actually project-coupled — see useBandPassFilter/usePlaybackTransport/
// useVideoFrameSource, which all take plain shapes, not the Project type) but
// skips AnnotationWindow's own JSX shell, which hardcodes the file-tree +
// annotation-tools layout with no seam to opt out of.
export default function SingleFileWindow({ filePath, onClose }: SingleFileWindowProps) {
  const trackName = basename(filePath);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
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

  const [zoomSec, setZoomSec] = useState(DEFAULT_ZOOM_SEC);
  const zoomSecRef = useRef(DEFAULT_ZOOM_SEC);
  useEffect(() => { zoomSecRef.current = zoomSec; }, [zoomSec]);

  const [videoMode, setVideoMode] = useState<VideoMode>('fast');
  const videoModeRef = useRef(videoMode);
  useEffect(() => { videoModeRef.current = videoMode; }, [videoMode]);

  // No project to persist against in single-file mode — plain session state.
  const [videoBrightness, setVideoBrightness] = useState(100);
  const [videoContrast, setVideoContrast] = useState(100);

  const [settings, setSettings] = useState<SpectrogramSettings>(DEFAULT_SPECTROGRAM_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  const {
    splitRatio, videoCollapsed, setVideoCollapsed,
    hideLabels, VIDEO_COLLAPSED_BAR_PX, handleSplitDrag,
  } = usePanelLayout({ splitRatio: DEFAULT_SPLIT_RATIO, leftPanelRatio: 0, leftPanelWidth: 0 });

  const chunkCacheRef = useRef<MultiTierSpectrogramCache | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  const spectrogramRef = useRef<SpectrogramHandle>(null);

  const {
    frameSourceRef, frameSourceVersion, setFrameSourceVersion, frameSourceDecodeError,
    videoPrefetchEndRef, videoPrefetchBusyRef, preZoomExtentRef, prerollVideo,
  } = useVideoFrameSource({
    trackPath: filePath, trackPathRef, isAudioTrack, videoMode, durationRef, selectionRef, addLog,
  });

  // No annotation tools exist in this mode; the example-player mutual-exclusion
  // hook usePlaybackTransport expects is simply inert here.
  const examplePlayer = { playingToolId: null as string | null, toggle: () => {}, stop: () => {} };

  const {
    isPlaying, isBuffering, playbackSpeed, setPlaybackSpeed, lastDefinedSpeed, setLastDefinedSpeed,
    volume, setVolume, muted, setMuted, playheadLocked, setPlayheadLocked,
    engineRef, currentTimeRef, currentTimeStoreRef,
    togglePlay, seek, getMediaTime, attachVideoElement,
  } = usePlaybackTransport({
    project: { preferences: {} },
    isAudioTrack, isAudioTrackRef, videoMode, videoModeRef,
    videoSrc, videoSrcRef: useRef(videoSrc), duration, durationRef,
    selection, selectionRef, frameSourceRef, videoPrefetchEndRef, videoPrefetchBusyRef,
    prerollVideo, spectrogramRef, examplePlayer, addLog, zoomSecRef,
  });

  // Spectrogram zoom-in/out/fit-to-track hotkeys — identical registration to
  // AnnotationWindow's (see hooks/useSpectrogramZoomHotkeys.ts); this window
  // has no viewport store to read for the mod+0 "remember where I was"
  // snapshot, so it falls back to the hook's default (start of window = 0).
  useSpectrogramZoomHotkeys({ spectrogramRef, durationRef, zoomSecRef, preZoomExtentRef });

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
    videoMode,
  });

  // Load the file once on mount (this window is scoped to exactly one file —
  // "next/prev" and re-opening a different file both go back through the
  // launch screen, which mounts a fresh instance).
  useEffect(() => {
    let cancelled = false;
    const isAudio = !isVideoFile(filePath);
    setIsAudioTrack(isAudio);
    setVideoSrc(toAssetUrl(filePath));
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

        const cache = new MultiTierSpectrogramCache(filePath, settings.fftSize, sr, dur, () => setCacheVersion(v => v + 1));
        chunkCacheRef.current = cache;
        setCacheVersion(0);
        cache.prefetchViewport(0, effectiveZoom, cache.selectTier(effectiveZoom, 1200).tier);
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

  // Rebuild cache when FFT size changes.
  useEffect(() => {
    if (!sampleRate || !duration) return;
    const cache = new MultiTierSpectrogramCache(filePath, settings.fftSize, sampleRate, duration, () => setCacheVersion(v => v + 1));
    chunkCacheRef.current = cache;
    setCacheVersion(0);
    cache.prefetchViewport(0, zoomSec, cache.selectTier(zoomSec, 1200).tier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fftSize]);

  const handleSelectionChange = useCallback((s: Selection | null) => {
    setSelection(s);
    if (s) {
      activationStack.pushIfAbsent('selection');
      frameSourceRef.current?.pinSelectionRange(s.start, s.end);
    } else {
      activationStack.remove('selection');
      frameSourceRef.current?.clearPinnedRange();
    }
  }, [activationStack, frameSourceRef]);

  // Everything else (playback transport, spectrogram zoom, band-pass filter,
  // undo/redo) registers its own hotkeys inside the hook that owns its
  // state/handlers — see usePlaybackTransport, useSpectrogramZoomHotkeys, and
  // useBandPassFilter above. What's left here is specific to this window.
  useHotkeys([
    { key: 'a', mods: ['mod'], handler: () => { if (duration > 0) handleSelectionChange({ start: 0, end: duration }); } },
    { key: 'Escape', allowInInput: true, handler: () => {
        const top = activationStack.popTop();
        switch (top) {
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
            break;
        }
    }},
  ]);

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
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowDebug(true)}
            className="p-2 rounded hover:bg-slate-700 text-slate-400 hover:text-white"
          >
            <Bug size={18} />
          </button>
        </div>
      </header>

      <DebugConsole open={showDebug} onClose={() => setShowDebug(false)} logs={debugLogs} />

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
                getMediaTime={getMediaTime}
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
              <div className="p-4 space-y-6">
                <LevelRangeSlider
                  floor={settings.displayFloor}
                  ceil={settings.displayCeil}
                  onChange={(r) => setSettings(s => ({ ...s, ...r }))}
                />
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{annotationWindow.freqHeader}</h4>
                  <div className="flex space-x-2 pt-2">
                    <div className="flex-1">
                      <label className="text-xs text-slate-400">{annotationWindow.freqMin}</label>
                      <input
                        type="number"
                        value={settings.minFreq}
                        onChange={(e) => setSettings(s => ({ ...s, minFreq: Math.max(0, parseInt(e.target.value)) }))}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-slate-400">{annotationWindow.freqMax}</label>
                      <input
                        type="number"
                        value={settings.maxFreq}
                        onChange={(e) => setSettings(s => ({ ...s, maxFreq: parseInt(e.target.value) }))}
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm focus:border-[#e65161] outline-none"
                      />
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{annotationWindow.fftHeader}</h4>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">{annotationWindow.windowSize}</label>
                    <select
                      value={settings.fftSize}
                      onChange={(e) => setSettings(s => ({ ...s, fftSize: parseInt(e.target.value) }))}
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
                      onChange={(e) => setSettings(s => ({ ...s, frequencyScale: e.target.value as FrequencyScale }))}
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
            isBuffering={isBuffering}
            videoSrc={videoSrc}
            currentTimeStore={currentTimeStoreRef.current}
            duration={duration}
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
            videoMode={videoMode}
            isAudioTrack={isAudioTrack}
            onRestartAudio={() => { engineRef.current?.restart(); }}
            playheadLocked={playheadLocked}
            onTogglePlayheadLock={() => {
              const willLock = !playheadLocked;
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
              ident={null}
              settings={settings}
              zoomSec={zoomSec}
              annotations={[]}
              selectedAnnotationId={null}
              activeAnnotationTool={null}
              annotationTools={[]}
              selection={selection}
              boundAnnotationId={boundAnnotationId}
              onSeek={seek}
              onAnnotationsChange={() => {}}
              onAnnotationsCommit={() => {}}
              onSelectAnnotation={() => {}}
              onSelectionChange={handleSelectionChange}
              onBoundAnnotationChange={setBoundAnnotationId}
              onZoomChange={setZoomSec}
              filterToolActive={filterToolActive}
              bandPassFilter={bandPassFilter}
              onBandPassFilterChange={setBandPassFilter}
              onBandPassFilterDrawn={handleBandPassFilterDrawn}
              topTool={activationStack.topOf(['filterTool']) as 'filterTool' | null}
              videoMode={videoMode}
              isAudioTrack={isAudioTrack}
              playheadLocked={playheadLocked}
              hideLabels={hideLabels}
            />
          </div>

          {!videoSrc && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-slate-600 text-center">
                <p className="text-lg font-medium">{annotationWindow.noMediaTitle}</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <TooltipLayer />
    </div>
  );
}
