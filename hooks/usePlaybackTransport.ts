import { useState, useRef, useEffect, useCallback } from 'react';
import { AudioEngine } from '../utils/AudioEngine';
import { VideoElementEngine } from '../utils/VideoElementEngine';
import { VideoFrameSource } from '../utils/VideoFrameSource';
import { wantsCanvasRenderer } from '../utils/videoPlaybackMode';
import { createCurrentTimeStore } from '../utils/currentTimeStore';
import { SpectrogramHandle } from '../components/Spectrogram';
import { Selection, VideoMode, PlaybackTransport } from '../types';
import { DEFAULT_UI_SETTINGS } from '../constants';
import type { useExamplePlayer } from './useExamplePlayer';
import { useHotkeys } from './useHotkeys';

interface UsePlaybackTransportArgs {
  project: { preferences: { uiSettings?: { volume?: number; playbackSpeed?: number; lastDefinedSpeed?: number } } };
  // Track / mode / selection mirrors driving transport selection & playback.
  isAudioTrack: boolean;
  isAudioTrackRef: React.MutableRefObject<boolean>;
  videoMode: VideoMode;
  videoModeRef: React.MutableRefObject<VideoMode>;
  videoSrc: string | null;
  videoSrcRef: React.MutableRefObject<string | null>;
  duration: number;
  durationRef: React.MutableRefObject<number>;
  selection: Selection | null;
  selectionRef: React.MutableRefObject<Selection | null>;
  // Frame-source plumbing (owned by useVideoFrameSource).
  frameSourceRef: React.MutableRefObject<VideoFrameSource | null>;
  videoPrefetchEndRef: React.MutableRefObject<number>;
  videoPrefetchBusyRef: React.MutableRefObject<boolean>;
  prerollVideo: (startSec: number, endSec?: number) => Promise<void>;
  spectrogramRef: React.RefObject<SpectrogramHandle>;
  examplePlayer: ReturnType<typeof useExamplePlayer>;
  addLog: (msg: string, type?: 'info' | 'error') => void;
  // Visible-window width in seconds, for the arrow-key ±10%-of-window scrub.
  zoomSecRef: React.MutableRefObject<number>;
  // Mirrors useHotkeys's own `enabled`: false while a modal (e.g. the example
  // library) owns the keyboard, so these bindings must not fire.
  enabled?: boolean;
}

// Dual-transport abstraction over AudioEngine and VideoElementEngine. Owns the
// playback state (isPlaying/isBuffering/speed/volume/mute), the playback-clock
// refs (currentTime + its store), the play-token guard, the seek mirror ref,
// and both engine refs. Exposes one transport interface (togglePlay/seek/
// getMediaTime/...) so callers never branch on which engine is live.
export function usePlaybackTransport({
  project,
  isAudioTrack,
  isAudioTrackRef,
  videoMode,
  videoModeRef,
  videoSrc,
  videoSrcRef,
  duration,
  durationRef,
  selection,
  selectionRef,
  frameSourceRef,
  videoPrefetchEndRef,
  videoPrefetchBusyRef,
  prerollVideo,
  spectrogramRef,
  examplePlayer,
  addLog,
  zoomSecRef,
  enabled = true,
}: UsePlaybackTransportArgs) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);

  // Whether the spectrogram auto-scrolls to keep the playhead centered.
  // Toggled by the 'c' shortcut below; read via ref inside that handler so it
  // always sees the latest value without re-registering the binding.
  const [playheadLocked, setPlayheadLocked] = useState(false);
  const playheadLockedRef = useRef(false);
  useEffect(() => { playheadLockedRef.current = playheadLocked; }, [playheadLocked]);

  // Volume: 0 to 4 (400% or +12dB approx)
  const [volume, setVolume] = useState(project.preferences.uiSettings?.volume ?? DEFAULT_UI_SETTINGS.volume);
  const [muted, setMuted] = useState(false);

  // Pitch-preserving playback speed (0.25–4.0, persisted per-project).
  const [playbackSpeed, setPlaybackSpeed] = useState(project.preferences.uiSettings?.playbackSpeed ?? DEFAULT_UI_SETTINGS.playbackSpeed);
  // Last non-1.0 speed picked by the user; restored by the gauge-icon toggle.
  const [lastDefinedSpeed, setLastDefinedSpeed] = useState(
    project.preferences.uiSettings?.lastDefinedSpeed
      ?? (project.preferences.uiSettings?.playbackSpeed && project.preferences.uiSettings.playbackSpeed !== 1
            ? project.preferences.uiSettings.playbackSpeed
            : DEFAULT_UI_SETTINGS.lastDefinedSpeed)
  );

  const engineRef = useRef<AudioEngine | null>(null);
  // Alternate transport for Fast / Mixed-without-selection: the <video> element
  // plays its own audio. Exactly one of these two engines is "active" at a time
  // (see activeTransport); the orchestrator drives them through one interface.
  const videoEngineRef = useRef<VideoElementEngine | null>(null);
  // Ref so the onEnded closure (created once on mount) can read the latest seek function
  const seekRef = useRef<typeof seek | null>(null);

  const currentTimeRef = useRef(0);
  // Ref-based pub/sub for playback time. Updated ~50/sec by the engine's
  // onTimeUpdate; canvas consumers (spectrogram playhead, buzzdetect line,
  // toolbar readout) subscribe and redraw imperatively instead of re-rendering
  // the whole window tree. Set ONLY from the media clock — same place the old
  // currentTime state was set — so the playhead stays sample-locked to playback.
  const currentTimeStoreRef = useRef(createCurrentTimeStore());

  // Monotonic token invalidated whenever user interrupts playback. Async
  // preroll awaits check this so stale resolutions don't start the engine
  // after the user has pressed pause or triggered a new play.
  const playTokenRef = useRef(0);

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
      src.ensureRange(chunkStart, chunkEnd, 'rollingPrefetch')
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

    // Shared playback callbacks — both transports (AudioEngine and
    // VideoElementEngine) report through these so play/pause/EOF behave
    // identically regardless of which one is active.
    const setPlayhead = (t: number) => {
      currentTimeRef.current = t;
      currentTimeStoreRef.current.set(t);
    };
    const onPlaying = () => { setIsPlaying(true); setIsBuffering(false); };
    const onPaused = () => setIsPlaying(false);
    const onEnded = () => {
      // Return playhead to selection start. Do NOT auto-scroll — when playing
      // within a selection the user positioned the canvas intentionally; jumping
      // it on every loop is disorienting.
      const sel = selectionRef.current;
      if (sel) seekRef.current?.(sel.start, false);
      setIsPlaying(false);
    };

    engineRef.current = new AudioEngine({
      onTimeUpdate: (t) => {
        setPlayhead(t);
        // Rolling video prefetch: keep frames decoded 5 s ahead of the playhead.
        // Only run when the canvas path is the live renderer; in `mixed` without
        // a selection (showing the <video> fallback) and in `fast`/`off`, this
        // would just waste decode CPU on hardware that already can't keep up.
        // Refs read current values inside this once-mounted closure.
        const mode = videoModeRef.current;
        const canvasLive = wantsCanvasRenderer(mode, selectionRef.current !== null);
        if (canvasLive && !videoPrefetchBusyRef.current) {
          const bufferedTo = videoPrefetchEndRef.current;
          if (t + 6 >= bufferedTo) kickVideoPrefetch(bufferedTo);
        }
      },
      onPlaying,
      onPaused,
      onEnded,
      onBufferUnderrun: () => setIsBuffering(true),
      onDebugLog: (msg, type = 'info') => addLog(msg, type),
    });

    // The <video>-element transport. No prefetch (the element decodes itself);
    // no buffer-underrun signal (the browser handles its own buffering).
    videoEngineRef.current = new VideoElementEngine({
      onTimeUpdate: setPlayhead,
      onPlaying,
      onPaused,
      onEnded,
    });

    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      videoEngineRef.current?.dispose();
      videoEngineRef.current = null;
    };
  }, []);

  // Whether the <video> element — not the AudioEngine — is the active transport:
  // true whenever VideoPane isn't actually rendering the canvas (Fast, Mixed
  // before a selection, or a canvas-wanting mode whose format has no
  // VideoFrameSource, e.g. WEBM). Must mirror VideoPane's own canvas/element
  // choice via the shared `wantsCanvasRenderer` predicate — otherwise the
  // rendered element and the transport driving it can disagree, leaving the
  // <video> element mounted but never played/seeked (frozen on frame 1).
  const usesVideoTransport = useCallback((): boolean => {
    if (isAudioTrackRef.current || !videoSrcRef.current) return false;
    const mode = videoModeRef.current;
    if (mode === 'off') return false;
    const canvasAvailable = !!frameSourceRef.current;
    return !(canvasAvailable && wantsCanvasRenderer(mode, selectionRef.current !== null));
  }, [isAudioTrackRef, videoSrcRef, videoModeRef, selectionRef, frameSourceRef]);

  // The active transport. AudioEngine and VideoElementEngine expose the same
  // play/pause/seek/getMediaTime/setGain/setPlaybackSpeed/isPlaying surface, so
  // callers never branch on which one is live.
  const activeTransport = useCallback(
    (): PlaybackTransport | null => (usesVideoTransport() ? videoEngineRef.current : engineRef.current),
    [usesVideoTransport],
  );

  // Stable callback passed to CanvasVideoPlayer's rAF loop. Reading from the
  // engine directly (rather than the currentTime state) avoids a frame of
  // lag: React commits on rAF, so currentTime is always one tick behind.
  const getMediaTime = useCallback((): number => {
    return activeTransport()?.getMediaTime() ?? 0;
  }, [activeTransport]);

  // Stable: bind the <video> element to its transport. Must not change identity
  // per-render, or VideoPlayer's exposure effect churns and detaches mid-play.
  const attachVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoEngineRef.current?.attach(el);
  }, []);

  const togglePlay = useCallback(async () => {
      const transport = activeTransport();
      if (isPlaying || isBuffering) {
          // Invalidate any in-flight preroll so its resolution can't start playback
          playTokenRef.current += 1;
          transport?.pause();
          setIsPlaying(false);
          setIsBuffering(false);
          return;
      }
      // Starting main playback stops any example clip — they can't both sound.
      examplePlayer.stop();
      const sel = selectionRef.current;
      const curTime = currentTimeRef.current;
      let startSec = curTime;
      // If there's a selection and the playhead is outside it, restart from selection start
      if (sel && (curTime >= sel.end - 0.05 || curTime < sel.start)) {
          startSec = sel.start;
          seek(sel.start, true);
      } else if (!sel && duration > 0 && curTime >= duration - 0.05) {
          // At end of track with no selection — return to beginning
          startSec = 0;
          seek(0, true);
      }
      setIsBuffering(true);
      const token = ++playTokenRef.current;
      addLog(`[togglePlay] playToken=${token} startSec=${startSec.toFixed(3)} sel=${sel ? `${sel.start.toFixed(3)}-${sel.end.toFixed(3)}` : 'none'} isAudioTrack=${isAudioTrack}`);
      // Canvas path only: pre-roll so the first frame at startSec is decoded
      // BEFORE the engine schedules audio (short selections could otherwise end
      // before any frame renders). The <video>-element transport decodes itself,
      // and audio-only tracks have no frames, so both skip the wait.
      if (frameSourceRef.current && !usesVideoTransport()) {
          await prerollVideo(startSec, sel?.end);
          if (token !== playTokenRef.current) return; // user interrupted
      }
      // isPlaying is set to true only when onPlaying fires. endSec enables the
      // bounded selection stop on whichever transport is active.
      transport?.play(startSec, sel ? sel.end : undefined);
  }, [isPlaying, isBuffering, isAudioTrack, duration, prerollVideo, addLog, activeTransport, usesVideoTransport, examplePlayer, selectionRef, frameSourceRef]);

  const seek = useCallback(async (time: number, scrollView = false) => {
      const transport = activeTransport();
      const wasPlaying = transport?.isPlaying ?? false;
      // AudioEngine.seek() cancels its scheduled audio (we restart below if it
      // was playing); VideoElementEngine.seek() just moves currentTime and keeps
      // the element playing — so the element needs no restart.
      const prevTime = currentTimeRef.current;
      transport?.seek(time);
      currentTimeRef.current = time;
      currentTimeStoreRef.current.set(time);
      // Notify the frame source so its eviction window follows the scrub position.
      // Kick a small ensureRange while paused so a scrub shows the correct frame
      // (rather than a stale one from the prior window). On the canvas path,
      // freeze the canvas at the pre-seek frame synchronously — this prevents
      // the GOP decode animation from being visible before the React overlay
      // renders (which is async and can lag several rAF ticks behind).
      if (!isAudioTrack && frameSourceRef.current) {
          frameSourceRef.current.notifyPlayhead(time);
          if (!wasPlaying && !usesVideoTransport()) {
              frameSourceRef.current.freezeDisplayAt(prevTime);
              setIsBuffering(true);
              const token = ++playTokenRef.current;
              frameSourceRef.current.ensureRange(time, Math.min(time + 0.5, durationRef.current || time + 0.5), 'seekScrub')
                .then(() => {
                    if (token === playTokenRef.current) {
                        frameSourceRef.current?.clearDisplayFreeze();
                        setIsBuffering(false);
                    }
                })
                .catch(() => {
                    if (token === playTokenRef.current) {
                        frameSourceRef.current?.clearDisplayFreeze();
                        setIsBuffering(false);
                    }
                });
          } else if (!wasPlaying) {
              frameSourceRef.current.ensureRange(time, Math.min(time + 0.5, durationRef.current || time + 0.5), 'seekScrub')
                .catch(() => {});
          }
      }
      if (scrollView) spectrogramRef.current?.scrollToTime(time);
      // Restart the AudioEngine from the new position if it was playing. The
      // <video>-element transport plays straight through a currentTime write, so
      // it's excluded here.
      if (wasPlaying && !usesVideoTransport()) {
          if (time < durationRef.current) {
              const sel = selectionRef.current;
              setIsBuffering(true);
              const token = ++playTokenRef.current;
              if (frameSourceRef.current) {
                  await prerollVideo(time, sel?.end);
                  if (token !== playTokenRef.current) return;
              }
              engineRef.current?.play(time, sel ? sel.end : undefined);
          } else {
              // Seeked to/past end — stop cleanly rather than hanging
              setIsPlaying(false);
          }
      }
  }, [isAudioTrack, prerollVideo, activeTransport, usesVideoTransport, durationRef, selectionRef, frameSourceRef, spectrogramRef]);

  // Keep seekRef in sync with seek so the mount-time onEnded closure always calls the latest version
  useEffect(() => { seekRef.current = seek; }, [seek]);

  // Keep both transports' gain in sync with the volume slider and mute button.
  // VideoElementEngine clamps to the element's 0–1 range (no boost above unity).
  useEffect(() => {
    const gain = muted ? 0 : volume;
    engineRef.current?.setGain(gain);
    videoEngineRef.current?.setGain(gain);
  }, [volume, muted]);

  // Sync playback speed to both transports. AudioEngine preserves pitch; the
  // <video> element does not (an accepted limitation of Fast mode).
  useEffect(() => {
    engineRef.current?.setPlaybackSpeed(playbackSpeed);
    videoEngineRef.current?.setPlaybackSpeed(playbackSpeed);
  }, [playbackSpeed]);

  // Switching the active transport mid-play (mode change, or committing/clearing
  // a selection in Mixed) would otherwise leave the previous one running. Stop
  // both cleanly whenever the active transport flips.
  const prevUsesVideoRef = useRef(false);
  useEffect(() => {
    const now = usesVideoTransport();
    if (now === prevUsesVideoRef.current) return;
    prevUsesVideoRef.current = now;
    playTokenRef.current += 1;
    engineRef.current?.pause();
    videoEngineRef.current?.pause();
    setIsPlaying(false);
    setIsBuffering(false);
  }, [videoMode, isAudioTrack, videoSrc, selection, usesVideoTransport]);

  useHotkeys([
    { key: 'ArrowLeft', handler: () => seek(Math.max(0, currentTimeRef.current - zoomSecRef.current * 0.1)) },
    { key: 'ArrowRight', handler: () => seek(Math.min(durationRef.current, currentTimeRef.current + zoomSecRef.current * 0.1)) },
    { key: ',', handler: () => {
      if (isAudioTrackRef.current) return;
      const frameDuration = frameSourceRef.current?.getFrameDuration() ?? (1 / 30);
      seek(Math.max(0, currentTimeRef.current - frameDuration));
    }},
    { key: '.', handler: () => {
      if (isAudioTrackRef.current) return;
      const frameDuration = frameSourceRef.current?.getFrameDuration() ?? (1 / 30);
      seek(Math.min(durationRef.current, currentTimeRef.current + frameDuration));
    }},
    { key: ' ', handler: togglePlay },
    { key: 'r', handler: () => setPlaybackSpeed(playbackSpeed === 1 ? lastDefinedSpeed : 1) },
    { key: 'm', handler: () => setMuted(prev => !prev), preventDefault: false },
    { key: 'c', handler: () => {
        const willLock = !playheadLockedRef.current;
        setPlayheadLocked(willLock);
        if (willLock) spectrogramRef.current?.recenterPlayhead();
    }},
  ], enabled);

  return {
    isPlaying, setIsPlaying,
    isBuffering, setIsBuffering,
    playbackSpeed, setPlaybackSpeed,
    lastDefinedSpeed, setLastDefinedSpeed,
    volume, setVolume,
    muted, setMuted,
    playheadLocked, setPlayheadLocked,
    engineRef,
    videoEngineRef,
    seekRef,
    playTokenRef,
    currentTimeRef,
    currentTimeStoreRef,
    togglePlay,
    seek,
    usesVideoTransport,
    activeTransport,
    getMediaTime,
    attachVideoElement,
  };
}
