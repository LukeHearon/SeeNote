import Toolbar, { type ToolbarProps } from './Toolbar';
import type { usePlaybackTransport } from '../hooks/usePlaybackTransport';
import type { BandPassFilterApi } from '../hooks/useBandPassFilter';

type Derived =
  | 'isPlaying' | 'currentTimeStore' | 'volume' | 'muted' | 'setVolume' | 'setMuted' | 'onPlay' | 'onSeek'
  | 'playbackSpeed' | 'setPlaybackSpeed' | 'lastDefinedSpeed' | 'setLastDefinedSpeed'
  | 'filterToolActive' | 'onToggleFilterTool' | 'bandPassFilter' | 'setBandPassFilter'
  | 'onDisableBandPassFilter' | 'onEnableBandPassFilter' | 'filterStrength' | 'setFilterStrength'
  | 'onRestartAudio' | 'playheadLocked' | 'onTogglePlayheadLock' | 'selectedTimeDisplayUnit' | 'onTimeDisplayUnitChange';

type Props = Omit<ToolbarProps, Derived> & {
  transport: ReturnType<typeof usePlaybackTransport>;
  filter: BandPassFilterApi;
};

/** The Toolbar wired to the playback transport and band-pass filter hooks, as both windows use it. */
export default function TransportToolbar({ transport: t, filter: f, ...rest }: Props) {
  return (
    <Toolbar
      {...rest}
      isPlaying={t.isPlaying}
      currentTimeStore={t.currentTimeStoreRef.current}
      volume={t.volume}
      muted={t.muted}
      setVolume={t.setVolume}
      setMuted={t.setMuted}
      onPlay={t.togglePlay}
      onSeek={t.seek}
      playbackSpeed={t.playbackSpeed}
      setPlaybackSpeed={t.setPlaybackSpeed}
      lastDefinedSpeed={t.lastDefinedSpeed}
      setLastDefinedSpeed={t.setLastDefinedSpeed}
      filterToolActive={f.filterToolActive}
      onToggleFilterTool={f.handleToggleFilterTool}
      bandPassFilter={f.bandPassFilter}
      setBandPassFilter={f.setBandPassFilter}
      onDisableBandPassFilter={f.handleDisableBandPassFilter}
      onEnableBandPassFilter={f.handleEnableBandPassFilter}
      filterStrength={f.filterStrength}
      setFilterStrength={f.setFilterStrength}
      onRestartAudio={() => { t.engineRef.current?.restart(); }}
      playheadLocked={t.playheadLocked}
      onTogglePlayheadLock={t.togglePlayheadLock}
      selectedTimeDisplayUnit={t.timeDisplayUnit}
      onTimeDisplayUnitChange={t.chooseTimeDisplayUnit}
    />
  );
}
