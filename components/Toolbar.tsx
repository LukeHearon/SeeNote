import React, { useEffect, useState } from 'react';
import { Selection, BandPassFilter, VideoMode } from '../types';
import { SpectrogramHandle } from './Spectrogram';
import { clamp, SPEED_MIN, SPEED_MAX, TimeDisplayUnit } from '../utils/helpers';
import { isFilterAvailable } from '../utils/videoPlaybackMode';
import { useOverflowCollapseLevel } from '../hooks/useOverflowCollapseLevel';
import VolumeControl, { VolumeMuteButton } from './VolumeControl';
import { TransportButtons } from './controls/TransportButtons';
import { TimeReadout } from './controls/TimeReadout';
import { SelectionTimeFields } from './controls/SelectionTimeFields';
import { PlaybackSpeedControl, PlaybackSpeedIcon } from './controls/PlaybackSpeedControl';
import { FilterToolButton, FilterStrengthSlider } from './controls/FilterControls';
import { SpectrogramSettingsButton } from './controls/ToolbarToggles';
import { HoverReveal } from './controls/HoverReveal';
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

  // Priority-ordered collapse as the toolbar narrows: the least-used controls
  // give up their slider/entry box first, retreating to an icon with the same
  // control on a hover-revealed panel (see HoverReveal); the selection-time
  // fields go last, and transport and the running time never give. Widening
  // hands each one back in reverse. The level is derived from actual overflow
  // (content width vs. available width), not fixed breakpoints — see
  // useOverflowCollapseLevel.
  //
  // The deps are the props that change how wide the row's content wants to be
  // without changing how wide the row is — a longer track, wall-clock units,
  // a subset — so the level is re-derived rather than staying where the old
  // content left it.
  const [toolbarRef, collapseLevel] = useOverflowCollapseLevel<HTMLDivElement>(4, [
    timeDisplayUnit,
    dateTimeFormat,
    duration,
    timeline?.sourceDuration,
    trackStartDate?.getTime() ?? null,
  ]);
  const compactSpeed = collapseLevel >= 1;
  const compactFilterStrength = collapseLevel >= 2;
  const compactVolume = collapseLevel >= 3;
  const hideSelectionFields = collapseLevel >= 4;

  const { min: speedMin, max: speedMax } = speedRangeFor(isAudioTrack ?? false, videoMode ?? 'fast');
  const filterUnavailable = !isFilterAvailable(isAudioTrack ?? false, videoMode ?? 'fast');

  // Clamp speed into the effective range when video mode changes.
  useEffect(() => {
    const clamped = clamp(playbackSpeed, speedMin, speedMax);
    if (clamped !== playbackSpeed) setPlaybackSpeed(clamped);
  }, [videoMode, isAudioTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each collapsing control is built once here and placed by the JSX below in
  // whichever of its two forms the current level calls for — the collapsed and
  // expanded rows must not drift apart.
  const volumeContextMenu = onRestartAudio
    ? (e: React.MouseEvent) => { e.preventDefault(); setVolumeCtxMenu({ x: e.clientX, y: e.clientY }); }
    : undefined;
  const volumeSlider = (hideIcon: boolean, helpTarget?: string) => (
    <VolumeControl
      volume={volume}
      muted={muted}
      setVolume={setVolume}
      setMuted={setMuted}
      hideIcon={hideIcon}
      helpTarget={helpTarget}
      onContextMenu={volumeContextMenu}
    />
  );

  const filterToolButton = (
    <FilterToolButton active={filterToolActive} unavailable={filterUnavailable} onToggle={onToggleFilterTool} />
  );
  const filterStrengthSlider = (
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
  );

  const speedControl = (hideIcon: boolean) => (
    <PlaybackSpeedControl
      speed={playbackSpeed}
      lastDefinedSpeed={lastDefinedSpeed}
      min={speedMin}
      max={speedMax}
      onSpeedChange={setPlaybackSpeed}
      onLastDefinedSpeedChange={setLastDefinedSpeed}
      hideIcon={hideIcon}
    />
  );

  const clearToEdge = (time: number) => {
    onSeek(time, true);
    onSelectionChange(null);
    onBoundAnnotationChange(null);
  };

  return (
    <div ref={toolbarRef} className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 border-b border-slate-700 select-none z-40 overflow-hidden" data-help-target="playback-controls">
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

      {/* Volume — the full pill while there's room; the slider is the widest of
          the low-priority groups, so under pressure it retreats behind the mute
          icon and comes back on hover. */}
      <div className="ml-1">
        {compactVolume ? (
          <HoverReveal
            helpTarget="volume-control"
            trigger={<VolumeMuteButton muted={muted} setMuted={setMuted} className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-slate-700" />}
          >
            {volumeSlider(true)}
          </HoverReveal>
        ) : volumeSlider(false, 'volume-control')}
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

        {!hideSelectionFields && (
          <>
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
          </>
        )}
      </div>

      {/* Filter tool readiness (Shift+F) beside its strength slider. Band on/off
          lives on the slider, so a band can persist after the tool is unreadied.
          The slider is the first of the pair to give way — it moves onto a hover
          panel behind the tool button, which stays put along with Shift+F. */}
      <div className="ml-2 flex items-center gap-1">
        {compactFilterStrength ? (
          <HoverReveal helpTarget="filter-strength" trigger={filterToolButton}>
            {filterStrengthSlider}
          </HoverReveal>
        ) : (
          <>
            {filterToolButton}
            {filterStrengthSlider}
          </>
        )}
      </div>

      {/* Playback speed — the gauge plus its numeric entry box, the first thing
          to give up its readout: the gauge alone stays, revealing the entry box
          on hover. */}
      <div className="ml-2">
        {compactSpeed ? (
          <HoverReveal
            helpTarget="playback-speed"
            trigger={<PlaybackSpeedIcon speed={playbackSpeed} lastDefinedSpeed={lastDefinedSpeed} onSpeedChange={setPlaybackSpeed} />}
          >
            {speedControl(true)}
          </HoverReveal>
        ) : speedControl(false)}
      </div>

      {/* Right-aligned controls: spectrogram settings. The buzzdetect panel
          toggle and the subset scissors live in the Neurons section header,
          beside the neurons they act on. */}
      {onToggleSettings !== undefined && (
        <div className="ml-auto flex items-center gap-1">
          <SpectrogramSettingsButton open={!!showSettings} onToggle={onToggleSettings} />
        </div>
      )}
    </div>
  );
}

// Memoized so playback ticks (which flow through the currentTime store, not
// props) don't re-render the whole toolbar — only the small time readout updates.
export default React.memo(Toolbar);
