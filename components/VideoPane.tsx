import React from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import VideoPlayer from './VideoPlayer';
import CanvasVideoPlayer from './CanvasVideoPlayer';
import { VideoFrameSource } from '../utils/VideoFrameSource';

interface VideoPaneProps {
  frameSource: VideoFrameSource | null;
  frameSourceVersion: number;
  isAudioTrack: boolean;
  videoSrc: string | null;
  isProcessing: boolean;
  isBuffering: boolean;
  getMediaTime: () => number;
  onDebugLog: (msg: string, type?: 'info' | 'error') => void;
  onDurationChange: (d: number) => void;
}

export default function VideoPane({
  frameSource,
  frameSourceVersion,
  isAudioTrack,
  videoSrc,
  isProcessing,
  isBuffering,
  getMediaTime,
  onDebugLog,
  onDurationChange,
}: VideoPaneProps) {
  return (
    <div className="flex-1 relative bg-black flex justify-center items-center">
      {/* MP4/MOV video tracks use the frame-source path: a canvas driven
          by the audio engine clock, with frames decoded via WebCodecs and
          cached by timestamp. All other cases (audio tracks, non-ISOBMFF
          video containers, or a failed frame-source open) fall back to the
          original <video>-element player. */}
      {frameSource && !isAudioTrack ? (
        <CanvasVideoPlayer
          key={frameSourceVersion}
          frameSource={frameSource}
          getMediaTime={getMediaTime}
          onDebugLog={onDebugLog}
        />
      ) : (
        <VideoPlayer
          src={videoSrc}
          isAudio={isAudioTrack}
          onDurationChange={onDurationChange}
          onDebugLog={onDebugLog}
        />
      )}
      {isProcessing && (
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20">
          <Loader2 className="animate-spin text-[#e65161] mb-2" size={48} />
          <p className="text-[#e65161] font-medium">Processing Media...</p>
          <p className="text-slate-400 text-sm mt-1">Loading file...</p>
        </div>
      )}
      {isBuffering && videoSrc && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-20 pointer-events-none">
          <Loader2 className="animate-spin text-white" size={40} />
        </div>
      )}
      {videoSrc && !isAudioTrack && !frameSource && (
        <div
          className="absolute top-2 right-2 z-30 text-[#e65161] cursor-default"
          data-tooltip="This video format isn't supported by the frame-accurate WebCodecs pipeline. Playback falls back to the browser's <video> element and will not be frame-perfect."
        >
          <AlertCircle size={20} />
        </div>
      )}
    </div>
  );
}
