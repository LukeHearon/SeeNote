import React, { forwardRef, useEffect, useRef } from 'react';
import { Music } from 'lucide-react';

interface VideoPlayerProps {
  src: string | null;
  volume: number; // 0 to 4 (approx 12dB boost max)
  muted: boolean;
  isAudio: boolean;
  onTimeUpdate: (t: number) => void;
  onDurationChange: (d: number) => void;
  onLoadedMetadata: () => void;
  onPlaying?: () => void;
  onWaiting?: () => void;
}

const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ src, volume, muted, isAudio, onTimeUpdate, onDurationChange, onLoadedMetadata, onPlaying, onWaiting }, ref) => {
    
    // Web Audio API refs for boosting.
    // createMediaElementSource permanently binds the element — create it once and reuse.
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
    const gainNodeRef = useRef<GainNode | null>(null);

    // Build the Web Audio graph once, on first canplay. The source node is permanently
    // bound to the video element; only the gain value changes between files.
    useEffect(() => {
        const video = (ref as React.MutableRefObject<HTMLVideoElement>).current;
        if (!video) return;

        const ensureAudioGraph = () => {
            if (sourceNodeRef.current) return; // already built
            try {
                const AC = window.AudioContext || (window as any).webkitAudioContext;
                if (!audioCtxRef.current) audioCtxRef.current = new AC();
                sourceNodeRef.current = audioCtxRef.current.createMediaElementSource(video);
                gainNodeRef.current = audioCtxRef.current.createGain();
                sourceNodeRef.current.connect(gainNodeRef.current);
                gainNodeRef.current.connect(audioCtxRef.current.destination);
            } catch (e) {
                console.error("Audio Context Setup Failed", e);
            }
        };

        const handleCanPlay = () => ensureAudioGraph();

        video.addEventListener('canplay', handleCanPlay);
        // If the element is already ready (e.g. hot-reload), build immediately
        if (video.readyState >= 3) ensureAudioGraph();

        return () => video.removeEventListener('canplay', handleCanPlay);
    }, [ref]); // only depends on the ref — graph is created once

    // Event listeners for playback state forwarding
    useEffect(() => {
        const video = (ref as React.MutableRefObject<HTMLVideoElement>).current;
        if (!video) return;

        const handleTime = () => onTimeUpdate(video.currentTime);
        const handleDuration = () => onDurationChange(video.duration);

        // On play (user gesture context): resume the AudioContext if suspended.
        const handlePlay = () => {
            if (audioCtxRef.current?.state === 'suspended') {
                audioCtxRef.current.resume();
            }
        };

        const handlePlaying = () => onPlaying?.();
        const handleWaiting = () => onWaiting?.();

        video.addEventListener('timeupdate', handleTime);
        video.addEventListener('durationchange', handleDuration);
        video.addEventListener('loadedmetadata', onLoadedMetadata);
        video.addEventListener('play', handlePlay);
        video.addEventListener('playing', handlePlaying);
        video.addEventListener('waiting', handleWaiting);

        return () => {
            video.removeEventListener('timeupdate', handleTime);
            video.removeEventListener('durationchange', handleDuration);
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('playing', handlePlaying);
            video.removeEventListener('waiting', handleWaiting);
        };
    }, [onTimeUpdate, onDurationChange, onLoadedMetadata, onPlaying, onWaiting, ref]);

    // Volume Effect
    useEffect(() => {
        const video = (ref as React.MutableRefObject<HTMLVideoElement>).current;
        if (!video) return;

        // If context isn't ready (e.g. paused at start), standard volume prop is fallback for initial mute
        // But once MediaElementSource is attached, video.volume doesn't affect output loudness (it affects input to node).
        // Best practice with GainNode: Keep video.volume = 1, control GainNode.
        
        video.volume = 1; // Always max input to the node
        video.muted = false; // We handle muting in gain node

        if (gainNodeRef.current) {
            gainNodeRef.current.gain.value = muted ? 0 : volume;
        }
    }, [volume, muted, ref]);

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
            crossOrigin="anonymous" // Important for Web Audio API
            preload="metadata"
        />
      </div>
    );
  }
);

export default VideoPlayer;