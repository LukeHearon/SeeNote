import { ReactNode, useEffect, useRef, useState } from 'react';
import { Selection } from '../../types';
import { CurrentTimeStore, createCurrentTimeStore } from '../../utils/currentTimeStore';
import { LiveClient, LiveSnapshot } from '../../utils/liveBridge';
import { SPEED_MIN, SPEED_MAX, TimeDisplayUnit } from '../../utils/helpers';
import { help } from '../../copy/help';
import { TransportButtons } from '../controls/TransportButtons';
import { TimeReadout } from '../controls/TimeReadout';
import { SelectionTimeFields } from '../controls/SelectionTimeFields';
import { PlaybackSpeedControl } from '../controls/PlaybackSpeedControl';
import { FilterToolButton, FilterStrengthSlider } from '../controls/FilterControls';
import VolumeControl from '../VolumeControl';

/** Which control a `live` block renders. */
export type LiveControlId =
  | 'transport'
  | 'time'
  | 'selection'
  | 'speed'
  | 'volume'
  | 'filter';

// ---------------------------------------------------------------------------
// Demo state
//
// With no project open there's nothing to mirror, so the controls run against
// local state instead. They stay fully interactive — the point is that the
// reader can work out what a control does by driving it, project or no project.
// ---------------------------------------------------------------------------

const DEMO_DURATION = 137.5;

function useDemoState(): { snapshot: LiveSnapshot; set: (patch: Partial<LiveSnapshot>) => void; store: CurrentTimeStore } {
  const storeRef = useRef<CurrentTimeStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createCurrentTimeStore();
    storeRef.current.set(42.5);
  }
  const [snapshot, setSnapshot] = useState<LiveSnapshot>({
    trackName: null,
    hasTrack: true,
    duration: DEMO_DURATION,
    isPlaying: false,
    isBuffering: false,
    volume: 0.8,
    muted: false,
    playbackSpeed: 1,
    lastDefinedSpeed: 0.5,
    speedMin: SPEED_MIN,
    speedMax: SPEED_MAX,
    selection: { start: 30, end: 46.25 },
    timeDisplayUnit: 'seconds',
    canGoPrevAnnotation: true,
    canGoNextAnnotation: true,
    playheadLocked: false,
    filterToolActive: false,
    filterUnavailable: false,
    filterEnabled: true,
    filterStrength: 0.6,
    bandPassFilter: null,
    buzzdetectAvailable: false,
    buzzdetectEnabled: false,
  });
  const set = (patch: Partial<LiveSnapshot>) => setSnapshot(s => ({ ...s, ...patch }));
  return { snapshot, set, store: storeRef.current };
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

function Frame({ connected, trackName, children }: { connected: boolean; trackName: string | null; children: ReactNode }) {
  return (
    <div className="my-3 rounded-lg border border-slate-700 bg-slate-800/60 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-700/70">
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {connected
            ? (trackName ? help.live.connectedTo(trackName) : help.live.connected)
            : help.live.demo}
        </span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5 flex-wrap">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiveControl
// ---------------------------------------------------------------------------

/**
 * A working copy of one of the app's controls, embedded in the guide.
 *
 * When a project is open it drives the real thing across the window boundary
 * (utils/liveBridge.ts) — moving the speed here moves playback over there, and
 * the time readout counts up with the project's playhead. Otherwise it falls
 * back to local demo state so the page still demonstrates something.
 *
 * The controls themselves are the same components the toolbar builds from
 * (components/controls/*), not reimplementations.
 */
export function LiveControl({ id, client }: { id: LiveControlId; client: LiveClient }) {
  const demo = useDemoState();
  const connected = client.state !== null;
  const s = client.state ?? demo.snapshot;
  const store = connected ? client.currentTimeStore : demo.store;

  // Demo playback: with no project to follow, the readout still needs to move
  // for the control to mean anything, so run a local clock while "playing".
  useEffect(() => {
    if (connected || !demo.snapshot.isPlaying) return;
    const id = setInterval(() => {
      const next = demo.store.get() + 0.05 * demo.snapshot.playbackSpeed;
      demo.store.set(next > DEMO_DURATION ? 0 : next);
    }, 50);
    return () => clearInterval(id);
  }, [connected, demo.snapshot.isPlaying, demo.snapshot.playbackSpeed, demo.store]);

  // Drive the project if there is one, else the demo. Both branches are written
  // out at each call site so `client.call` keeps its per-action argument types.
  const act = (live: () => void, fallback: () => void) => (connected ? live() : fallback());

  const body = () => {
    switch (id) {
      case 'transport':
        return (
          <TransportButtons
            enabled={s.hasTrack}
            isPlaying={s.isPlaying}
            isBuffering={s.isBuffering}
            canGoPrevAnnotation={s.canGoPrevAnnotation}
            canGoNextAnnotation={s.canGoNextAnnotation}
            playheadLocked={s.playheadLocked}
            onPlay={() => act(() => client.call('play'), () => demo.set({ isPlaying: !demo.snapshot.isPlaying }))}
            onSkipToStart={() => act(() => client.call('skipToStart'), () => demo.store.set(0))}
            onSkipToEnd={() => act(() => client.call('skipToEnd'), () => demo.store.set(DEMO_DURATION))}
            onPrevAnnotation={() => act(() => client.call('prevAnnotation'), () => demo.store.set(30))}
            onNextAnnotation={() => act(() => client.call('nextAnnotation'), () => demo.store.set(96))}
            onTogglePlayheadLock={() => act(() => client.call('togglePlayheadLock'), () => demo.set({ playheadLocked: !demo.snapshot.playheadLocked }))}
          />
        );
      case 'time':
        return (
          <TimeReadout
            currentTimeStore={store}
            duration={s.duration}
            unit={s.timeDisplayUnit}
            onSeek={(t, scroll) => act(() => client.call('seek', t, scroll), () => demo.store.set(t))}
            onUnitChange={(u: TimeDisplayUnit) => act(() => client.call('setTimeDisplayUnit', u), () => demo.set({ timeDisplayUnit: u }))}
          />
        );
      case 'selection':
        return (
          <SelectionTimeFields
            selection={s.selection}
            isPlaying={s.isPlaying}
            duration={s.duration}
            currentTimeStore={store}
            onApply={(sel: Selection) => act(() => client.call('setSelection', sel), () => demo.set({ selection: sel }))}
          />
        );
      case 'speed':
        return (
          <PlaybackSpeedControl
            speed={s.playbackSpeed}
            lastDefinedSpeed={s.lastDefinedSpeed}
            min={s.speedMin}
            max={s.speedMax}
            onSpeedChange={v => act(() => client.call('setPlaybackSpeed', v), () => demo.set({ playbackSpeed: v }))}
            onLastDefinedSpeedChange={v => act(() => client.call('setLastDefinedSpeed', v), () => demo.set({ lastDefinedSpeed: v }))}
          />
        );
      case 'volume':
        return (
          <VolumeControl
            volume={s.volume}
            muted={s.muted}
            setVolume={v => act(() => client.call('setVolume', v), () => demo.set({ volume: v }))}
            setMuted={m => act(() => client.call('setMuted', m), () => demo.set({ muted: m }))}
          />
        );
      case 'filter':
        return (
          <>
            <FilterToolButton
              active={s.filterToolActive}
              unavailable={s.filterUnavailable}
              onToggle={() => act(() => client.call('toggleFilterTool'), () => demo.set({ filterToolActive: !demo.snapshot.filterToolActive }))}
            />
            <FilterStrengthSlider
              strength={s.filterStrength}
              enabled={s.filterEnabled}
              unavailable={s.filterUnavailable}
              onSetStrength={v => act(() => client.call('setFilterStrength', v), () => demo.set({ filterStrength: v }))}
              onDisable={() => act(() => client.call('disableFilter'), () => demo.set({ filterEnabled: false }))}
              onEnable={v => act(() => client.call('enableFilter', v), () => demo.set({ filterEnabled: true, filterStrength: v }))}
            />
          </>
        );
    }
  };

  return <Frame connected={connected} trackName={s.trackName}>{body()}</Frame>;
}
