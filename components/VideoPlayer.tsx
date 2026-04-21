import React, { useEffect, useRef } from 'react';
import { Music } from 'lucide-react';

interface VideoPlayerProps {
  src: string | null;
  isAudio: boolean;
  onDurationChange: (d: number) => void;
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
}

// VideoPlayer renders a <video> element for two cases:
//   1. Audio tracks — shows a music-icon overlay; the element itself is hidden.
//   2. Non-ISOBMFF video containers (.webm, .avi, …) that can't be handled by
//      the WebCodecs frame-source path.
// For MP4/MOV tracks the CanvasVideoPlayer renders instead; this component is
// never mounted for those files.
// All audio output comes from AudioEngine; this element is always muted.
export default function VideoPlayer({ src, isAudio, onDurationChange, onDebugLog }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

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
    };

    video.addEventListener('durationchange', handleDuration);
    video.addEventListener('loadedmetadata', handleLoaded);
    video.addEventListener('error', handleError);
    return () => {
      video.removeEventListener('durationchange', handleDuration);
      video.removeEventListener('loadedmetadata', handleLoaded);
      video.removeEventListener('error', handleError);
    };
  }, [onDurationChange, onDebugLog]);

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
      <video
        ref={videoRef}
        src={src}
        className={`w-full h-full object-contain ${isAudio ? 'opacity-0' : ''}`}
        controls={false}
        muted
        preload="auto"
      />
    </div>
  );
}
