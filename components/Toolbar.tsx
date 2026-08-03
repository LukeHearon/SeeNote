import React, { useEffect, useState } from 'react';
import { Selection, BandPassFilter, VideoMode } from '../types';
import { SpectrogramHandle } from './Spectrogram';
import { clamp, SPEED_MIN, SPEED_MAX, TimeDisplayUnit } from '../utils/helpers';
import { isFilterAvailable } from '../utils/videoPlaybackMode';
import VolumeControl from './VolumeControl';
import { TransportButtons } from './controls/TransportButtons';
import { TimeReadout } from './controls/TimeReadout';
import { SelectionTimeFields } from './controls/SelectionTimeFields';
import { PlaybackSpeedControl } from './controls/PlaybackSpeedControl';
import { FilterToolButton, FilterStrengthSlider } from './controls/FilterControls';
import { BuzzdetectToggle, SubsetToggle, SpectrogramSettingsButton } from './controls/ToolbarToggles';
import type { CurrentTimeStore } from '../utils/currentTimeStore';
import { DateTimeFormat } from '../utils/datetimeDisplay';
import { Timeline } from '../utils/subsetTimeline';
import { DEFAULT_DATE_TIME_FORMAT } from '../constants';
import { tooltips } from '../copy/tooltips';

interface ToolbarProps {
  isPlaying: boolean;
  isBuffering: boolean;
  videoSrc: string | null;
  // Playback time via the ref-based store so ticks don't re-render the toolbar.
  currentTimeStore: CurrentTimeStore;
  duration: number;
  selection: Selection | null;
  volume: number;
  muted: boolean;
  canGoPrevAnnotation: boolean;
  canGoNextAnnotation: boolean;
  spectrogramRef: React.RefObject<SpectrogramHandle | null>;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  onPlay: () => void;
  onSeek: (time: number, scroll?: boolean) => void;
  onSelectionChange: (s: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onAnnotationBoundsChange?: (start: number, end: number) => void;
  showSettings?: boolean;
  onToggleSettings?: () => void;
  playbackSpeed: number;
  setPlaybackSpeed: (s: number) => void;
  lastDefinedSpeed: number;
  setLastDefinedSpeed: (s: number) => void;
  filterToolActive: boolean;
  onToggleFilterTool: () => void;
  bandPassFilter: BandPassFilter | null;
  setBandPassFilter: (f: BandPassFilter | null) => void;
  onDisableBandPassFilter: () => void;
  onEnableBandPassFilter: (strength: number) => void;
  filterStrength: number;
  setFilterStrength: (s: number) => void;
  videoMode?: VideoMode;
  /** Audio-only tracks always play through AudioEngine (pitch-preserving,
   *  filterable) regardless of videoMode — the Fast-mode restrictions below
   *  only apply when a <video> element is actually driving playback. */
  isAudioTrack?: boolean;
  /** Whether a buzzdetect directory is configured (gates the toggle button). */
  buzzdetectAvailable?: boolean;
  buzzdetectEnabled?: boolean;
  onToggleBuzzdetect?: () => void;
  /**
   * Subset mode (utils/subsetTimeline.ts). `subsetAvailable` is whether any
   * neuron has been ticked to subset by — without one there's nothing the
   * button could do, so it isn't shown rather than shown-and-inert.
   */
  subsetAvailable?: boolean;
  subsetActive?: boolean;
  onToggleSubset?: () => void;
  /**
   * The display↔source map. Every time in this toolbar is READ and WRITTEN in
   * source time — the seek/selection callbacks still speak display time, so the
   * conversion happens inside the readouts. Identity when no subset is on.
   */
  timeline?: Timeline;
  onRestartAudio?: () => void;
  playheadLocked?: boolean;
  onTogglePlayheadLock?: () => void;
  /** The unit actually in force — already resolved through effectiveTimeUnit. */
  timeDisplayUnit?: TimeDisplayUnit;
  /** The unit the user picked, which may be 'datetime' on a track that can't show it. */
  selectedTimeDisplayUnit?: TimeDisplayUnit;
  onTimeDisplayUnitChange?: (u: TimeDisplayUnit) => void;
  /** Wall-clock start of the track; null when its filename carries no parseable timestamp. */
  trackStartDate?: Date | null;
  /** Style for wall-clock datetime readouts (ruler, running time, From/To fields). */
  dateTimeFormat?: DateTimeFormat;
}

/**
 * Effective speed range: free-running video (a `<video>` element playing its
 * own audio) can't be stretched as far as the audio engine can.
 */
export function speedRangeFor(isAudioTrack: boolean, videoMode: VideoMode): { min: number; max: number } {
  const freeRunning = !isAudioTrack && (videoMode === 'fast' || videoMode === 'mixed');
  return freeRunning ? { min: 0.5, max: 2.0 } : { min: SPEED_MIN, max: SPEED_MAX };
}

function Toolbar({
  isPlaying,
  isBuffering,
  videoSrc,
  currentTimeStore,
  duration,
  selection,
  volume,
  muted,
  canGoPrevAnnotation,
  canGoNextAnnotation,
  spectrogramRef,
  setVolume,
  setMuted,
  onPlay,
  onSeek,
  onSelectionChange,
  onBoundAnnotationChange,
  onAnnotationBoundsChange,
  showSettings,
  onToggleSettings,
  playbackSpeed,
  setPlaybackSpeed,
  lastDefinedSpeed,
  setLastDefinedSpeed,
  filterToolActive,
  onToggleFilterTool,
  bandPassFilter,
  setBandPassFilter,
  onDisableBandPassFilter,
  onEnableBandPassFilter,
  filterStrength,
  setFilterStrength,
  videoMode,
  isAudioTrack,
  buzzdetectAvailable,
  buzzdetectEnabled,
  onToggleBuzzdetect,
  subsetAvailable,
  subsetActive,
  onToggleSubset,
  timeline,
  onRestartAudio,
  playheadLocked = false,
  onTogglePlayheadLock,
  timeDisplayUnit = 'seconds',
  selectedTimeDisplayUnit = timeDisplayUnit,
  onTimeDisplayUnitChange,
  trackStartDate = null,
  dateTimeFormat = DEFAULT_DATE_TIME_FORMAT,
}: ToolbarProps) {
  const [volumeCtxMenu, setVolumeCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const { min: speedMin, max: speedMax } = speedRangeFor(isAudioTrack ?? false, videoMode ?? 'fast');
  const filterUnavailable = !isFilterAvailable(isAudioTrack ?? false, videoMode ?? 'fast');

  // Clamp speed into the effective range when video mode changes.
  useEffect(() => {
    const clamped = clamp(playbackSpeed, speedMin, speedMax);
    if (clamped !== playbackSpeed) setPlaybackSpeed(clamped);
  }, [videoMode, isAudioTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearToEdge = (time: number) => {
    onSeek(time, true);
    onSelectionChange(null);
    onBoundAnnotationChange(null);
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 border-b border-slate-700 select-none z-40" data-help-target="playback-controls">
      <TransportButtons
        enabled={!!videoSrc}
        isPlaying={isPlaying}
        isBuffering={isBuffering}
        canGoPrevAnnotation={canGoPrevAnnotation}
        canGoNextAnnotation={canGoNextAnnotation}
        playheadLocked={playheadLocked}
        onSkipToStart={() => clearToEdge(0)}
        onSkipToEnd={() => clearToEdge(duration)}
        onPrevAnnotation={() => spectrogramRef.current?.goToPrevAnnotation()}
        onNextAnnotation={() => spectrogramRef.current?.goToNextAnnotation()}
        onPlay={onPlay}
        onTogglePlayheadLock={() => onTogglePlayheadLock?.()}
      />

      {/* Volume Control */}
      <div className="ml-1">
        <VolumeControl
          volume={volume}
          muted={muted}
          setVolume={setVolume}
          setMuted={setMuted}
          helpTarget="volume-control"
          onContextMenu={onRestartAudio ? (e) => { e.preventDefault(); setVolumeCtxMenu({ x: e.clientX, y: e.clientY }); } : undefined}
        />
      </div>

      {volumeCtxMenu && onRestartAudio && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setVolumeCtxMenu(null)} />
          <div
            className="fixed z-50 bg-slate-800 border border-slate-600 rounded shadow-lg py-1 min-w-[140px]"
            style={{ left: volumeCtxMenu.x, top: volumeCtxMenu.y }}
          >
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
              onClick={() => { setVolumeCtxMenu(null); onRestartAudio(); }}
            >
              {tooltips.restartAudio}
            </button>
          </div>
        </>
      )}

      {/* Time display — current time + selection fields to the right */}
      <div className="flex items-center gap-2 ml-2 tabular-nums" data-help-target="time-display">
        <TimeReadout
          currentTimeStore={currentTimeStore}
          duration={duration}
          unit={timeDisplayUnit}
          selectedUnit={selectedTimeDisplayUnit}
          trackStartDate={trackStartDate}
          dateTimeFormat={dateTimeFormat}
          timeline={timeline}
          onSeek={onSeek}
          onUnitChange={u => onTimeDisplayUnitChange?.(u)}
        />

        <div className="w-px bg-slate-600/50 self-stretch my-0.5" />

        <SelectionTimeFields
          selection={selection}
          isPlaying={isPlaying}
          duration={duration}
          currentTimeStore={currentTimeStore}
          unit={timeDisplayUnit}
          trackStartDate={trackStartDate}
          dateTimeFormat={dateTimeFormat}
          timeline={timeline}
          onApply={s => { onSelectionChange(s); onAnnotationBoundsChange?.(s.start, s.end); }}
        />
      </div>

      {/* Filter tool readiness (Shift+F). Band on/off lives on the adjacent
          strength slider, so a band can persist after the tool is unreadied. */}
      <div className="ml-2">
        <FilterToolButton active={filterToolActive} unavailable={filterUnavailable} onToggle={onToggleFilterTool} />
      </div>

      <FilterStrengthSlider
        strength={filterStrength}
        enabled={bandPassFilter !== null}
        unavailable={filterUnavailable}
        onSetStrength={s => {
          setFilterStrength(s);
          if (bandPassFilter) setBandPassFilter({ ...bandPassFilter, strength: s });
        }}
        onDisable={() => { onDisableBandPassFilter(); setFilterStrength(0); }}
        onEnable={onEnableBandPassFilter}
      />

      <div className="ml-2">
        <PlaybackSpeedControl
          speed={playbackSpeed}
          lastDefinedSpeed={lastDefinedSpeed}
          min={speedMin}
          max={speedMax}
          onSpeedChange={setPlaybackSpeed}
          onLastDefinedSpeedChange={setLastDefinedSpeed}
        />
      </div>

      {/* Right-aligned controls: subset + buzzdetect toggles, spectrogram settings */}
      {(onToggleSettings !== undefined || buzzdetectAvailable || subsetAvailable) && (
        <div className="ml-auto flex items-center gap-1">
          {subsetAvailable && (
            <SubsetToggle active={!!subsetActive} onToggle={() => onToggleSubset?.()} />
          )}
          {buzzdetectAvailable && (
            <BuzzdetectToggle enabled={!!buzzdetectEnabled} onToggle={() => onToggleBuzzdetect?.()} />
          )}
          {onToggleSettings !== undefined && (
            <SpectrogramSettingsButton open={!!showSettings} onToggle={onToggleSettings} />
          )}
        </div>
      )}
    </div>
  );
}

// Memoized so playback ticks (which flow through the currentTime store, not
// props) don't re-render the whole toolbar — only the small time readout updates.
export default React.memo(Toolbar);
