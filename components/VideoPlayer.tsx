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
}

// VideoPlayer renders the <video> element for frame display only.
// All audio output is handled by AudioEngine (utils/AudioEngine.ts), which
// decodes PCM via Rust and schedules AudioBufferSourceNodes directly.
// The video element is always muted; its native audio pipeline is bypassed.
const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ src, isAudio, onDurationChange, onLoadedMetadata }, ref) => {

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
      video.addEventListener('durationchange', handleDuration);
      video.addEventListener('loadedmetadata', onLoadedMetadata);

      return () => {
        video.removeEventListener('durationchange', handleDuration);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
      };
    }, [onDurationChange, onLoadedMetadata, ref]);

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
