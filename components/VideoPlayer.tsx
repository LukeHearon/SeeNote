import React, { useEffect, useRef } from 'react';
import { Music } from 'lucide-react';

import { isZoomed } from '../utils/videoZoom';
import type { Rect, Viewport } from '../utils/videoZoom';

interface VideoPlayerProps {
  src: string | null;
  isAudio: boolean;
  onDurationChange?: (d: number) => void;
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
  /** Exposes the underlying element so the parent can sample it (minimap) and
   *  drive playback through VideoElementEngine. */
  onVideoElement?: (el: HTMLVideoElement | null) => void;
  /** True when this element is the active sound source (Fast, and Mixed before a
   *  selection): it plays its own audio track and must not be muted. Audio
   *  tracks and the canvas-backed modes route sound through AudioEngine, so the
   *  element stays muted. */
  playsOwnAudio?: boolean;
}

// VideoPlayer renders the browser <video> element for two cases:
//   1. Audio tracks — a music-icon overlay; the element itself is hidden+muted.
//   2. Video in Fast mode (and Mixed before a selection), where the element both
//      displays the picture AND plays its own audio track (cheap, free-running,
//      not frame-accurate with the spectrogram). Transport — play/pause/seek/
//      clock — is driven externally by VideoElementEngine via the element handed
//      up through onVideoElement; this component is purely presentational.
// The frame-accurate CanvasVideoPlayer renders instead in Accurate mode (and Mixed
// once a selection exists) for MP4/MOV, with audio from AudioEngine.

export default function VideoPlayer({
  src,
  isAudio,
  onDurationChange,
  onDebugLog,
  viewport,
  contentRect,
  onVideoDims,
  onVideoElement,
  playsOwnAudio = false,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    onVideoElement?.(videoRef.current);
    return () => onVideoElement?.(null);
  }, [onVideoElement, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleDuration = () => onDurationChange?.(video.duration);
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
          <p className="text-xl font-medium">Audio Track Active</p>
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
              // Fast / Mixed-without-selection play the element's own audio;
              // audio tracks and the canvas modes route sound through AudioEngine.
              muted={!playsOwnAudio}
              preload="auto"
            />
          </div>
        );
      })()}
    </div>
  );
}
