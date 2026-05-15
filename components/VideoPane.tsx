import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import VideoPlayer from './VideoPlayer';
import CanvasVideoPlayer from './CanvasVideoPlayer';
import VideoZoomLayer from './VideoZoomLayer';
import { VideoFrameSource } from '../utils/VideoFrameSource';
import {
  DEFAULT_VIEWPORT,
  computeContentRect,
  type Viewport,
} from '../utils/videoZoom';

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
  const usingCanvas = !!frameSource && !isAudioTrack;
  const hasVideo = !isAudioTrack && (usingCanvas || !!videoSrc);

  // ── Zoom state (shared model; reset whenever the track changes) ────────
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [zoomToolActive, setZoomToolActive] = useState(false);

  useEffect(() => {
    setViewport(DEFAULT_VIEWPORT);
    setZoomToolActive(false);
  }, [frameSourceVersion, videoSrc, isAudioTrack]);

  // Canvas path: push the viewport into the frame source (drawAt reads it).
  useEffect(() => {
    if (usingCanvas && frameSource) frameSource.setViewport(viewport);
  }, [usingCanvas, frameSource, viewport]);

  // ── Pane size + media dimensions (for fallback positioning / minimap) ──
  const containerRef = useRef<HTMLDivElement>(null);
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBoxSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [fallbackDims, setFallbackDims] = useState({ w: 0, h: 0 });
  const fallbackVideoRef = useRef<HTMLVideoElement | null>(null);

  const canvasDims = usingCanvas && frameSource ? frameSource.getDimensions() : null;
  const frameW = usingCanvas ? canvasDims?.width ?? 0 : fallbackDims.w;
  const frameH = usingCanvas ? canvasDims?.height ?? 0 : fallbackDims.h;

  const contentRect =
    !usingCanvas && fallbackDims.w > 0 && boxSize.w > 0
      ? computeContentRect(boxSize.w, boxSize.h, fallbackDims.w, fallbackDims.h)
      : null;

  // Minimap thumbnail source — canvas path uses the frame cache; fallback
  // samples the live <video> element. computeContentRect keeps the same
  // letterbox math both paths and the main view use.
  const drawThumbnail = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (usingCanvas && frameSource) {
        frameSource.drawThumbnail(ctx, w, h);
        return;
      }
      const v = fallbackVideoRef.current;
      if (v && v.videoWidth > 0) {
        const r = computeContentRect(w, h, v.videoWidth, v.videoHeight);
        ctx.clearRect(0, 0, w, h);
        try {
          ctx.drawImage(v, r.x, r.y, r.w, r.h);
        } catch {
          /* element not yet drawable */
        }
      }
    },
    [usingCanvas, frameSource],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 relative bg-black flex justify-center items-center"
    >
      {/* MP4/MOV video tracks use the frame-source path: a canvas driven
          by the audio engine clock, with frames decoded via WebCodecs and
          cached by timestamp. All other cases (audio tracks, non-ISOBMFF
          video containers, or a failed frame-source open) fall back to the
          original <video>-element player. */}
      {usingCanvas ? (
        <CanvasVideoPlayer
          key={frameSourceVersion}
          frameSource={frameSource!}
          getMediaTime={getMediaTime}
          onDebugLog={onDebugLog}
        />
      ) : (
        <VideoPlayer
          src={videoSrc}
          isAudio={isAudioTrack}
          onDurationChange={onDurationChange}
          onDebugLog={onDebugLog}
          viewport={viewport}
          contentRect={contentRect}
          onVideoDims={(w, h) => setFallbackDims({ w, h })}
          onVideoElement={(el) => {
            fallbackVideoRef.current = el;
          }}
        />
      )}

      {hasVideo && !isProcessing && (
        <VideoZoomLayer
          viewport={viewport}
          onViewportChange={setViewport}
          frameW={frameW}
          frameH={frameH}
          toolActive={zoomToolActive}
          onToolActiveChange={setZoomToolActive}
          drawThumbnail={drawThumbnail}
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
          className="absolute top-2 left-2 z-30 text-[#e65161] cursor-default"
          data-tooltip="This video format isn't supported by the frame-accurate WebCodecs pipeline. Playback falls back to the browser's <video> element and will not be frame-perfect."
        >
          <AlertCircle size={20} />
        </div>
      )}
    </div>
  );
}
