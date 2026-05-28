import React, { useEffect, useRef } from 'react';
import { Music } from 'lucide-react';

import { isZoomed } from '../utils/videoZoom';
import type { Rect, Viewport } from '../utils/videoZoom';

interface VideoPlayerProps {
  src: string | null;
  isAudio: boolean;
  /** When true, the element should be advancing; mirrors the audio engine state. */
  isPlaying: boolean;
  /** Pitch-preserving speed from the engine — mapped to video.playbackRate so
   *  the picture advances naturally between drift corrections. */
  playbackSpeed: number;
  /** Authoritative media clock (driven by AudioEngine). The element is eased
   *  toward this clock by the drift controller below (rate-nudge for small
   *  drift, a one-shot seek only on a genuine jump). */
  getMediaTime: () => number;
  onDurationChange: (d: number) => void;
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
  /** Zoom/pan viewport. When zoomed, the <video> is positioned to the
   *  content rect and a CSS transform exposes the visible region — kept
   *  equivalent to the canvas path so both stay in lockstep. */
  viewport?: Viewport;
  /** Letterbox rect (CSS px, relative to the pane) the video should occupy.
   *  Supplied by the parent once intrinsic dimensions are known. */
  contentRect?: Rect | null;
  /** Reports intrinsic video dimensions once metadata loads. */
  onVideoDims?: (w: number, h: number) => void;
  /** Exposes the underlying element so the parent can sample it (minimap). */
  onVideoElement?: (el: HTMLVideoElement | null) => void;
}

// VideoPlayer renders a <video> element for two cases:
//   1. Audio tracks — shows a music-icon overlay; the element itself is hidden.
//   2. Video shown through the browser <video> element — either a non-ISOBMFF
//      container (.webm, .avi, …) that the WebCodecs frame-source can't demux,
//      or any MP4/MOV in "Fast" mode (and "Mixed" before a selection exists),
//      where we deliberately trade frame-accuracy for cheapness.
// The frame-accurate CanvasVideoPlayer renders instead in "High" mode (and
// "Mixed" once a selection exists) for MP4/MOV.
// All audio output comes from AudioEngine; this element is always muted.

export default function VideoPlayer({
  src,
  isAudio,
  isPlaying,
  playbackSpeed,
  getMediaTime,
  onDurationChange,
  onDebugLog,
  viewport,
  contentRect,
  onVideoDims,
  onVideoElement,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    onVideoElement?.(videoRef.current);
    return () => onVideoElement?.(null);
  }, [onVideoElement, src]);

  // Live refs so the single rAF loop below always reads fresh values without
  // tearing down and re-registering every render (which would reset the drift
  // state and re-attach the 'seeked' listener each time).
  const isPlayingRef = useRef(isPlaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  const getMediaTimeRef = useRef(getMediaTime);
  const onDebugLogRef = useRef(onDebugLog);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { getMediaTimeRef.current = getMediaTime; }, [getMediaTime]);
  useEffect(() => { onDebugLogRef.current = onDebugLog; }, [onDebugLog]);

  // Drive the <video> from the AudioEngine clock. The canvas/WebCodecs path
  // does this natively; this loop is the equivalent for the fallback element.
  //
  // Mid-playback seeks (currentTime = …) re-decode from the prior keyframe and,
  // fired per rAF tick, cascade into multi-second freezes on long-GOP codecs —
  // the next tick sees stale currentTime and stacks another overlapping seek.
  // So we NEVER seek to fix accumulated drift while playing. Instead, a
  // three-zone controller:
  //   • small drift     → leave the picture alone (rate = speed)
  //   • moderate drift  → ease playbackRate toward the clock (cheap, no
  //                       re-decode), with HYSTERESIS: start correcting once
  //                       drift exceeds NUDGE_START_SEC, then keep correcting
  //                       until it's driven back under NUDGE_STOP_SEC.
  //   • drift > HARD_SEEK_SEC → a genuine discontinuity (user click, selection
  //                       replay, loop). Snap once, gated on 'seeked' so seeks
  //                       never stack.
  // The hysteresis matters: if we released the instant drift dipped under the
  // start threshold, the picture would park right at that edge — both clocks
  // then run at 1.0, drift stays pinned just below the threshold, and the
  // slightest scheduler/decode jitter re-trips it. That produced a constant
  // 1.0↔1.05 sawtooth (visible as stutter). Correcting fully back toward zero
  // parks us clear of the trip point, so corrections stay rare and gentle.
  // Video here is a supporting cue for sound ID, not a frame-accurate surface
  // (that's "High" mode), so the thresholds are generous.
  useEffect(() => {
    if (isAudio) return;
    const video = videoRef.current;
    if (!video) return;

    const NUDGE_START_SEC = 0.1;   // begin rate-correcting once drift exceeds this
    const NUDGE_STOP_SEC = 0.025;  // …and keep correcting until it's back under this
    const HARD_SEEK_SEC = 0.5;     // above this: a jump — snap once
    const MAX_RATE_DELTA = 0.05;   // ±5% clamp on the speed nudge
    const CORRECTION_GAIN = 0.5;   // drift(s) → fractional rate delta

    let rAF: number | null = null;
    let hardSeekInFlight = false;
    let correcting = false;
    const onSeeked = () => { hardSeekInFlight = false; };
    video.addEventListener('seeked', onSeeked);

    const tick = () => {
      const target = getMediaTimeRef.current();
      const playing = isPlayingRef.current;
      const speed = playbackSpeedRef.current;

      // Mirror play/pause. Muted autoplay is permitted; swallow the rejected
      // promise so a stale play() during teardown doesn't surface as an error.
      if (playing && video.paused) {
        void video.play().catch(() => { /* */ });
      } else if (!playing && !video.paused) {
        video.pause();
      }

      // readyState < HAVE_METADATA means currentTime isn't seekable yet.
      if (video.readyState >= 1) {
        const drift = target - video.currentTime; // >0: picture behind audio
        const absDrift = Math.abs(drift);

        if (absDrift > HARD_SEEK_SEC) {
          // Discontinuity: snap once, gated on 'seeked' so we never issue an
          // overlapping seek while the previous one is still decoding.
          if (!hardSeekInFlight) {
            hardSeekInFlight = true;
            video.playbackRate = speed;
            video.currentTime = target;
            correcting = false;
          }
        } else if (!playing) {
          // Paused: a seek can't stutter (nothing decodes continuously), so
          // snap to show the exact frame once drift clears the start threshold.
          if (absDrift > NUDGE_START_SEC && !hardSeekInFlight) {
            hardSeekInFlight = true;
            video.currentTime = target;
          }
        } else {
          // Playing: ease the speed toward the clock instead of seeking.
          // Enter correction at NUDGE_START_SEC; stay in it until drift is
          // driven back under NUDGE_STOP_SEC (hysteresis — see header note).
          if (!correcting && absDrift > NUDGE_START_SEC) {
            correcting = true;
            onDebugLogRef.current?.(
              `[video] drift ${(drift * 1000).toFixed(0)}ms — resyncing picture via playbackRate`,
            );
          }
          if (correcting && absDrift < NUDGE_STOP_SEC) {
            correcting = false;
          }
          if (correcting) {
            const delta = Math.max(
              -MAX_RATE_DELTA,
              Math.min(MAX_RATE_DELTA, drift * CORRECTION_GAIN),
            );
            const targetRate = speed * (1 + delta);
            if (Math.abs(video.playbackRate - targetRate) > 0.002) {
              video.playbackRate = targetRate;
            }
          } else if (video.playbackRate !== speed) {
            video.playbackRate = speed;
          }
        }
      }

      rAF = requestAnimationFrame(tick);
    };
    rAF = requestAnimationFrame(tick);
    return () => {
      if (rAF !== null) cancelAnimationFrame(rAF);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [isAudio, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleDuration = () => onDurationChange(video.duration);
    const handleError = () => {
      const err = video.error;
      const codeMap: Record<number, string> = {
        1: 'MEDIA_ERR_ABORTED',
        2: 'MEDIA_ERR_NETWORK',
        3: 'MEDIA_ERR_DECODE',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
      };
      const label = err ? (codeMap[err.code] ?? `code=${err.code}`) : 'unknown';
      const msg = err?.message ? ` — ${err.message}` : '';
      onDebugLog?.(`[video] load error: ${label}${msg} src=${video.currentSrc || video.src}`, 'error');
    };
    const handleLoaded = () => {
      onDebugLog?.(
        `[video] loadedmetadata dur=${video.duration.toFixed(2)}s size=${video.videoWidth}x${video.videoHeight}`,
      );
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        onVideoDims?.(video.videoWidth, video.videoHeight);
      }
    };

    video.addEventListener('durationchange', handleDuration);
    video.addEventListener('loadedmetadata', handleLoaded);
    video.addEventListener('error', handleError);
    // If metadata is already available (src swapped on a warm element),
    // fire immediately so the parent can compute the content rect.
    if (video.readyState >= 1 && video.videoWidth > 0) {
      onVideoDims?.(video.videoWidth, video.videoHeight);
    }
    return () => {
      video.removeEventListener('durationchange', handleDuration);
      video.removeEventListener('loadedmetadata', handleLoaded);
      video.removeEventListener('error', handleError);
    };
  }, [onDurationChange, onDebugLog, onVideoDims, src]);

  if (!src) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black text-gray-500">
        <p>No Media Loaded</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-black">
      {isAudio && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 z-10 pointer-events-none">
          <Music size={64} className="mb-4 opacity-50" />
          <p className="text-xl font-medium">Audio File Active</p>
          <p className="text-sm opacity-70">Visualization below</p>
        </div>
      )}
      {(() => {
        // One stable element tree (no remount on zoom toggle, which would
        // reload src and flash). When zoomed we position the wrapper exactly
        // to the letterbox rect so the box *is* the content — making the CSS
        // transform mathematically equivalent to the canvas path's source
        // sub-rect, keeping both render paths in lockstep.
        const zoomed =
          !!viewport && !!contentRect && isZoomed(viewport) && !isAudio;
        const wrapperStyle: React.CSSProperties =
          zoomed && contentRect
            ? {
                position: 'absolute',
                left: contentRect.x,
                top: contentRect.y,
                width: contentRect.w,
                height: contentRect.h,
                overflow: 'hidden',
              }
            : { position: 'absolute', inset: 0 };
        const videoStyle: React.CSSProperties =
          zoomed && viewport
            ? {
                transformOrigin: '50% 50%',
                transform: `scale(${viewport.zoom}) translate(${(0.5 - viewport.cx) * 100}%, ${(0.5 - viewport.cy) * 100}%)`,
              }
            : {};
        return (
          <div style={wrapperStyle}>
            <video
              ref={videoRef}
              src={src}
              className={`w-full h-full ${zoomed ? '' : 'object-contain'} ${isAudio ? 'opacity-0' : ''}`}
              style={videoStyle}
              controls={false}
              muted
              preload="auto"
            />
          </div>
        );
      })()}
    </div>
  );
}
