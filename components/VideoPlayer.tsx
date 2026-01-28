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
}

const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ src, volume, muted, isAudio, onTimeUpdate, onDurationChange, onLoadedMetadata }, ref) => {
    
    // Web Audio API refs for boosting
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
    const gainNodeRef = useRef<GainNode | null>(null);
    const initializedRef = useRef(false);

    useEffect(() => {
        const video = (ref as React.MutableRefObject<HTMLVideoElement>).current;
        if(!video) return;

        // Clean up previous context if src changes
        if (src) {
            initializedRef.current = false;
        }

        const handleTime = () => onTimeUpdate(video.currentTime);
        const handleDuration = () => onDurationChange(video.duration);

        // Initialize AudioContext on play to avoid autoplay policy issues
        const handlePlay = () => {
             if (!initializedRef.current && video.src) {
                try {
                    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
                    if (!audioCtxRef.current) {
                        audioCtxRef.current = new AudioContext();
                    }
                    
                    if (audioCtxRef.current?.state === 'suspended') {
                        audioCtxRef.current.resume();
                    }

                    if (!sourceNodeRef.current) {
                         // Note: creating a MediaElementSource will mute the video element effectively,
                         // routing audio through the graph.
                         sourceNodeRef.current = audioCtxRef.current.createMediaElementSource(video);
                         gainNodeRef.current = audioCtxRef.current.createGain();
                         
                         sourceNodeRef.current.connect(gainNodeRef.current);
                         gainNodeRef.current.connect(audioCtxRef.current.destination);
                    }
                    initializedRef.current = true;
                    
                    // Apply current volume
                    if (gainNodeRef.current) {
                        gainNodeRef.current.gain.value = muted ? 0 : volume;
                    }
                } catch (e) {
                    console.error("Audio Context Setup Failed", e);
                }
             }
        };

        video.addEventListener('timeupdate', handleTime);
        video.addEventListener('durationchange', handleDuration);
        video.addEventListener('loadedmetadata', onLoadedMetadata);
        video.addEventListener('play', handlePlay);

        return () => {
            video.removeEventListener('timeupdate', handleTime);
            video.removeEventListener('durationchange', handleDuration);
            video.removeEventListener('loadedmetadata', onLoadedMetadata);
            video.removeEventListener('play', handlePlay);
        };
    }, [onTimeUpdate, onDurationChange, onLoadedMetadata, ref, src, volume, muted]);

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
        />
      </div>
    );
  }
);

export default VideoPlayer;