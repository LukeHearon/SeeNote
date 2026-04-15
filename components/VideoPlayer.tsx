import React, { forwardRef, useEffect } from 'react';
import { Music } from 'lucide-react';

interface VideoPlayerProps {
  src: string | null;
  volume: number;    // retained for API compatibility; audio is handled by AudioEngine
  muted: boolean;    // always true — AudioEngine handles all audio output
  isAudio: boolean;
  onTimeUpdate: (t: number) => void;
  onDurationChange: (d: number) => void;
  onLoadedMetadata: () => void;
  onPlaying?: () => void;
  onWaiting?: () => void;
  /** Optional debug logger, surfaces <video> load errors to the app's debug panel. */
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
}

// VideoPlayer renders the <video> element for frame display only.
// All audio output is handled by AudioEngine (utils/AudioEngine.ts), which
// decodes PCM via Rust and schedules AudioBufferSourceNodes directly.
// The video element is always muted; its native audio pipeline is bypassed.
const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ src, isAudio, onDurationChange, onLoadedMetadata, onDebugLog }, ref) => {

    // Keep the video element muted so its audio never reaches the output.
    // AudioEngine owns the audio clock; video.currentTime is synced to it
    // by the frame-sync rAF loop in App.tsx.
    useEffect(() => {
      const video = (ref as React.MutableRefObject<HTMLVideoElement>).current;
      if (!video) return;
      video.muted = true;
      video.volume = 0;
    }, [ref, src]);

    useEffect(() => {
      const video = (ref as React.MutableRefObject<HTMLVideoElement>).current;
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
        onLoadedMetadata();
      };
      video.addEventListener('durationchange', handleDuration);
      video.addEventListener('loadedmetadata', handleLoaded);
      video.addEventListener('error', handleError);

      return () => {
        video.removeEventListener('durationchange', handleDuration);
        video.removeEventListener('loadedmetadata', handleLoaded);
        video.removeEventListener('error', handleError);
      };
    }, [onDurationChange, onLoadedMetadata, onDebugLog, ref]);

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
          ref={ref}
          src={src}
          className={`w-full h-full object-contain ${isAudio ? 'opacity-0' : ''}`}
          controls={false}
          muted
          preload="metadata"
        />
      </div>
    );
  }
);

export default VideoPlayer;
