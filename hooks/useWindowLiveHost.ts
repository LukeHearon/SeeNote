import type { RefObject } from 'react';
import type { Selection, SpectrogramSettings, VideoMode } from '../types';
import type { DebugLog } from '../components/DebugConsole';
import type { SpectrogramHandle } from '../components/Spectrogram';
import { speedRangeFor } from '../components/Toolbar';
import { useLiveHost, type LiveHandlers, type LiveSnapshot } from '../utils/liveBridge';
import { isFilterAvailable } from '../utils/videoPlaybackMode';
import { displayOfNearestKept, projectIntervalToDisplay } from '../utils/subsetTimeline';
import type { usePlaybackTransport } from './usePlaybackTransport';
import type { BandPassFilterApi } from './useBandPassFilter';
import type { BuzzdetectApi } from './useBuzzdetect';
import type { SubsetTimelineApi } from './useSubsetTimeline';

type WindowSnapshot = Pick<LiveSnapshot,
  'isBuffering' | 'timeDisplayUnit' | 'selectedTimeDisplayUnit' | 'trackStartMs' | 'dateTimeFormat'
  | 'canGoPrevAnnotation' | 'canGoNextAnnotation' | 'buzzdetectAvailable' | 'filePanel' | 'toolPalette'>;

type WindowHandlers = Pick<LiveHandlers,
  'toggleFileExpandCollapse' | 'toggleFileFilter' | 'toggleBuzzdetectFilter'
  | 'activateTool' | 'activateSelectMode' | 'openToolSettings' | 'openFindLabel'
  | 'editTool' | 'requestDeleteTool' | 'playExample' | 'showExamples'>;

/** File-panel and tool-palette handlers for a window that has neither. */
export const NO_PROJECT_LIVE_HANDLERS: WindowHandlers = {
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
};

interface Params {
  transport: ReturnType<typeof usePlaybackTransport>;
  filter: BandPassFilterApi;
  buzzdetect: BuzzdetectApi;
  subset: SubsetTimelineApi;
  hasTrack: boolean;
  /** Source duration (see LiveSnapshot.duration). */
  duration: number;
  sampleRate: number;
  isAudioTrack: boolean;
  /** The preferred mode, which sets the speed range the toolbar offers. */
  videoMode: VideoMode;
  selection: Selection | null;
  handleSelectionChange: (s: Selection | null) => void;
  setBoundAnnotationId: (id: string | null) => void;
  /** Extra work when the guide sets the selection (display time). */
  onSelectionSet?: (s: Selection) => void;
  settings: SpectrogramSettings;
  setSettings: (update: (s: SpectrogramSettings) => SpectrogramSettings) => void;
  showSettings: boolean;
  setShowSettings: (update: (open: boolean) => boolean) => void;
  debugLogs: DebugLog[];
  spectrogramRef: RefObject<SpectrogramHandle | null>;
  snapshot: WindowSnapshot;
  handlers: WindowHandlers;
}

/**
 * Mirror a window's toolbar into the help guide and accept control input back,
 * so the controls the guide documents are the live ones. Both sides are the
 * exact values and handlers the window's Toolbar gets. Only one window is ever
 * mounted, so there's never a second host.
 */
export function useWindowLiveHost({
  transport: t, filter: f, buzzdetect: b, subset, hasTrack, duration, sampleRate, isAudioTrack, videoMode,
  selection, handleSelectionChange, setBoundAnnotationId, onSelectionSet,
  settings, setSettings, showSettings, setShowSettings, debugLogs, spectrogramRef, snapshot, handlers,
}: Params): void {
  const speedRange = speedRangeFor(isAudioTrack, videoMode);
  const { timeline, displayDuration } = subset;
  const clearBound = () => { handleSelectionChange(null); setBoundAnnotationId(null); };
  useLiveHost(
    {
      ...snapshot,
      hasTrack,
      duration,
      isPlaying: t.isPlaying,
      volume: t.volume,
      muted: t.muted,
      playbackSpeed: t.playbackSpeed,
      lastDefinedSpeed: t.lastDefinedSpeed,
      speedMin: speedRange.min,
      speedMax: speedRange.max,
      // Source time, like everything else on the bridge — the guide's copy of
      // the from/to fields must read the same file positions the toolbar's do.
      selection: selection && subset.selectionToSource(selection),
      playheadLocked: t.playheadLocked,
      filterToolActive: f.filterToolActive,
      filterUnavailable: !isFilterAvailable(isAudioTrack, videoMode),
      filterEnabled: f.bandPassFilter !== null,
      filterStrength: f.filterStrength,
      bandPassFilter: f.bandPassFilter,
      buzzdetectEnabled: b.buzzdetectEnabled,
      subsetAvailable: b.buzzdetectSubsetNeurons.length > 0,
      subsetActive: subset.subsetActive,
      isolateAvailable: b.buzzdetectIsolatedNeurons.length > 0,
      isolateActive: subset.activeIsolatedNeurons.length > 0,
      spectrogramSettings: settings,
      spectrogramSettingsOpen: showSettings,
      sampleRate,
      debugLogs,
    },
    {
      ...handlers,
      play: t.togglePlay,
      // Times arrive in source time (see LiveSnapshot). One a subset cut out
      // has no place on the axis, so it goes to the nearest kept moment — the
      // same answer typing it into the toolbar gives.
      seek: (time, scroll) => t.seek(displayOfNearestKept(timeline, time), scroll),
      skipToStart: () => { t.seek(0, true); clearBound(); },
      skipToEnd: () => { t.seek(displayDuration, true); clearBound(); },
      prevAnnotation: () => spectrogramRef.current?.goToPrevAnnotation(),
      nextAnnotation: () => spectrogramRef.current?.goToNextAnnotation(),
      togglePlayheadLock: t.togglePlayheadLock,
      setVolume: t.setVolume,
      setMuted: t.setMuted,
      setPlaybackSpeed: t.setPlaybackSpeed,
      setLastDefinedSpeed: t.setLastDefinedSpeed,
      setTimeDisplayUnit: t.setTimeDisplayUnit,
      setSelection: s => {
        const d = projectIntervalToDisplay(timeline, s.start, s.end);
        if (!d) return;
        handleSelectionChange(d);
        onSelectionSet?.(d);
      },
      toggleFilterTool: f.handleToggleFilterTool,
      setFilterStrength: s => {
        f.setFilterStrength(s);
        if (f.bandPassFilter) f.setBandPassFilter({ ...f.bandPassFilter, strength: s });
      },
      enableFilter: f.handleEnableBandPassFilter,
      disableFilter: () => { f.handleDisableBandPassFilter(); f.setFilterStrength(0); },
      toggleBuzzdetect: () => b.setBuzzdetectEnabled(v => !v),
      toggleSubset: b.toggleBuzzdetectSubset,
      toggleIsolate: b.toggleBuzzdetectIsolate,
      toggleSpectrogramSettings: () => setShowSettings(open => !open),
      setSpectrogramSettings: patch => setSettings(s => ({ ...s, ...patch })),
    },
    t.currentTimeStoreRef.current,
    // Bound, not passed as a bare method reference — Timeline is a class.
    time => timeline.toSource(time),
  );
}
