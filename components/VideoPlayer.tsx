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
  /** Authoritative media clock (driven by AudioEngine). The element's
   *  currentTime is reconciled to this when drift exceeds DRIFT_THRESHOLD_SEC. */
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
//   2. Non-ISOBMFF video containers (.webm, .avi, …) that can't be handled by
//      the WebCodecs frame-source path.
// For MP4/MOV tracks the CanvasVideoPlayer renders instead; this component is
// never mounted for those files.
// All audio output comes from AudioEngine; this element is always muted.
// Max tolerated drift between the muted <video> and the audio engine clock
// before we hard-set currentTime. 100ms is well under perceptual sync threshold
// while large enough to avoid thrashing the decoder on every rAF tick.
const DRIFT_THRESHOLD_SEC = 0.1;

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

  // Drive the <video> from the AudioEngine clock. The canvas/WebCodecs path
  // does this natively; this loop is the equivalent for the fallback element
  // on platforms without VideoDecoder (older macOS WKWebView) or with
  // non-ISOBMFF containers. Not frame-perfect — sync is bounded by
  // DRIFT_THRESHOLD_SEC — but matches the tooltip's promise.
  useEffect(() => {
    if (isAudio) return;
    const video = videoRef.current;
    if (!video) return;

    let rAF: number | null = null;
    const tick = () => {
      const target = getMediaTime();
      // Mirror play/pause. Muted autoplay is permitted; swallow the rejected
      // promise so a stale play() during teardown doesn't surface as an error.
      if (isPlaying && video.paused) {
        void video.play().catch(() => { /* */ });
      } else if (!isPlaying && !video.paused) {
        video.pause();
      }
      if (video.playbackRate !== playbackSpeed) {
        video.playbackRate = playbackSpeed;
      }
      // Reconcile drift. readyState < HAVE_METADATA means currentTime hasn't
      // been seekable yet — skip until metadata loads.
      if (video.readyState >= 1 && Math.abs(video.currentTime - target) > DRIFT_THRESHOLD_SEC) {
        video.currentTime = target;
      }
      rAF = requestAnimationFrame(tick);
    };
    rAF = requestAnimationFrame(tick);
    return () => {
      if (rAF !== null) cancelAnimationFrame(rAF);
    };
  }, [isAudio, isPlaying, playbackSpeed, getMediaTime]);

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
