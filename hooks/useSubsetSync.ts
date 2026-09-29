import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { MultiTierSpectrogramCache, swapChunkCache } from '../MultiTierSpectrogramCache';
import { MIN_ZOOM_SEC } from '../constants';
import { Selection } from '../types';
import type { AudioEngine } from '../utils/AudioEngine';
import { displayOfNearestKept, sourceRangesForDisplayRange, type Timeline } from '../utils/subsetTimeline';
import type { SpectrogramHandle } from '../components/Spectrogram';

export interface SubsetChunkCacheParams {
  chunkCacheRef: MutableRefObject<MultiTierSpectrogramCache | null>;
  bumpCacheVersion: () => void;
  fftSize: number;
  /** Open track's path, or null when none is open (nothing to rebuild). */
  trackPath: string | null;
  sampleRate: number;
  /** The file's own length. */
  duration: number;
  displayDuration: number;
  zoomSec: number;
  subsetGrainSec: number | undefined;
  subsetSourceRanges: { start: number; end: number }[] | null;
  subsetGrainRef: MutableRefObject<number | undefined>;
  subsetSourceRangesRef: MutableRefObject<{ start: number; end: number }[] | null>;
  timelineRef: MutableRefObject<Timeline>;
}

/**
 * Builds the spectrogram chunk cache and keeps it in step with the subset.
 * Returns `installChunkCache`, the one place a cache is built: shared by every
 * path that has to (re)build one — opening a track, changing the FFT size, and
 * engaging or re-graining a subset — so the tier grain and the subset footprint
 * can't be wired up at one call site and forgotten at another.
 *
 * Two clocks, as in useSubsetTimeline: the grain rebuilds the cache outright
 * (every chunk held becomes unusable), while the kept ranges just narrow the
 * live one without dropping anything.
 */
export function useSubsetChunkCache({
  chunkCacheRef, bumpCacheVersion, fftSize, trackPath, sampleRate, duration, displayDuration, zoomSec,
  subsetGrainSec, subsetSourceRanges, subsetGrainRef, subsetSourceRangesRef, timelineRef,
}: SubsetChunkCacheParams) {
  const installChunkCache = useCallback((
    path: string, sr: number, dur: number, zoom: number,
  ) => {
    const cache = new MultiTierSpectrogramCache(
      path, fftSize, sr, dur, bumpCacheVersion, subsetGrainRef.current,
    );
    cache.setSubsetRanges(subsetSourceRangesRef.current);
    swapChunkCache(chunkCacheRef, cache);
    bumpCacheVersion();
    // The warm-up viewport is the first `zoom` seconds of the DISPLAY axis,
    // which under a subset is several stretches scattered through the file, not
    // the file's first `zoom` seconds — those may not be on the axis at all.
    cache.prefetchRanges(
      sourceRangesForDisplayRange(timelineRef.current, 0, zoom),
      cache.selectTier(zoom, 1200).tier,
    );
    return cache;
  }, [fftSize, bumpCacheVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebuild the cache when what a cached chunk *is* changes underneath it while
  // a track is open: the FFT size (the bins in a chunk) or the subset grain (the
  // stretch of file a chunk covers — see buildTierLadder).
  useEffect(() => {
    if (!trackPath || !sampleRate || !duration) return;
    // Engaging a subset shrinks the axis, and the effect that fits the zoom
    // window to it runs after this one — so fit it here too, or the warm-up
    // prefetch picks a tier for a window wider than the whole subset and
    // fetches chunks the very next draw supersedes.
    const zoom = displayDuration > 0 ? Math.min(zoomSec, displayDuration) : zoomSec;
    installChunkCache(trackPath, sampleRate, duration, zoom);
  }, [fftSize, subsetGrainSec]); // eslint-disable-line react-hooks/exhaustive-deps

  // Narrow the live cache to the subset's footprint as the spans move (a
  // threshold drag), and widen it back when the subset is turned off.
  useEffect(() => {
    chunkCacheRef.current?.setSubsetRanges(subsetSourceRanges);
    // Not keyed on the cache itself: every path that installs one already
    // applies the current ranges (installChunkCache), so re-running this on a
    // cache swap would only repeat the walk.
  }, [subsetSourceRanges]); // eslint-disable-line react-hooks/exhaustive-deps

  return installChunkCache;
}

export interface TimelineSwapParams {
  timeline: Timeline;
  displayDuration: number;
  engineRef: MutableRefObject<AudioEngine | null>;
  handleSelectionChange: (s: Selection | null) => void;
  seek: (t: number, scroll?: boolean) => void;
  currentTimeRef: MutableRefObject<number>;
  spectrogramRef: MutableRefObject<SpectrogramHandle | null>;
  zoomSecRef: MutableRefObject<number>;
  setZoomSec: (zoom: number) => void;
}

/**
 * Hands the engine the axis it should play, and brings the rest of the view
 * onto it. Fires on every timeline change (subset toggled, threshold edited,
 * track swapped). AudioEngine stops playback rather than remapping audio
 * already scheduled against the old axis.
 *
 * The selection is reset outright: its endpoints named audio by where they
 * sat, and the cuts have moved. The playhead instead follows the source
 * time it was actually at — read it off the OLD timeline before that
 * timeline is replaced, then land on the nearest point the NEW timeline can
 * express (exact, unless subsetting just hid that source time). That's what
 * keeps "unclick subset" landing back on the real spot in the full track
 * rather than reinterpreting the old display number under the new axis.
 * Skipped on the first run, which is just the empty initial state.
 *
 * Everything here is gated on the timeline object actually changing, not just
 * on the effect running: `seek` and `handleSelectionChange` are callbacks whose
 * identity turns over on unrelated renders, and setTimeline stops playback —
 * so an ungated call would cut the audio at arbitrary moments mid-play.
 */
export function useTimelineSwap({
  timeline, displayDuration, engineRef, handleSelectionChange, seek, currentTimeRef, spectrogramRef,
  zoomSecRef, setZoomSec,
}: TimelineSwapParams) {
  const prevTimelineRef = useRef(timeline);
  useEffect(() => {
    const prevTimeline = prevTimelineRef.current;
    const changed = prevTimeline !== timeline;
    prevTimelineRef.current = timeline;
    if (!changed) return;
    engineRef.current?.setTimeline(timeline);
    handleSelectionChange(null);
    const sourceTime = prevTimeline.toSource(currentTimeRef.current);
    const newDisplayTime = displayOfNearestKept(timeline, sourceTime);
    if (newDisplayTime !== currentTimeRef.current) seek(newDisplayTime);
    // Always recenter, even when the display time itself didn't change: the
    // timeline swap can redraw entirely different content under the same
    // playhead position, so the view still needs to follow it.
    spectrogramRef.current?.scrollToTime(newDisplayTime);
    // A subset can be a few seconds of a multi-hour file. Fit the window to it
    // rather than leaving the user staring at one narrow band of content in a
    // screen of blank — the same courtesy opening a short file gets.
    if (displayDuration > 0 && zoomSecRef.current > displayDuration) {
      setZoomSec(Math.max(MIN_ZOOM_SEC, displayDuration));
    }
  }, [timeline, displayDuration, engineRef, handleSelectionChange, seek, currentTimeRef, spectrogramRef]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The canvas video player's draw clock. `getMediaTime` is display time (the
 * transport's axis); the frame cache is indexed by position in the file, so
 * every rAF tick converts. Read off the ref rather than closing over `timeline`
 * so the rAF loop isn't torn down and rebuilt on every threshold nudge.
 */
export function useSourceFrameTime(
  timelineRef: MutableRefObject<Timeline>,
  getMediaTime: () => number,
): () => number {
  return useCallback(() => timelineRef.current.toSource(getMediaTime()), [timelineRef, getMediaTime]);
}
