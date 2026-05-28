import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, VideoOff } from 'lucide-react';
import VideoPlayer from './VideoPlayer';
import CanvasVideoPlayer from './CanvasVideoPlayer';
import VideoZoomLayer from './VideoZoomLayer';
import { VideoFrameSource } from '../utils/VideoFrameSource';
import { useHotkeys } from '../hooks/useHotkeys';
import type { VideoMode } from '../types';
import {
  DEFAULT_VIEWPORT,
  computeContentRect,
  drawLetterboxed,
  isZoomed,
  panViewport,
  type Viewport,
} from '../utils/videoZoom';

interface VideoPaneProps {
  frameSource: VideoFrameSource | null;
  frameSourceVersion: number;
  isAudioTrack: boolean;
  videoSrc: string | null;
  isProcessing: boolean;
  isBuffering: boolean;
  isPlaying: boolean;
  playbackSpeed: number;
  getMediaTime: () => number;
  onDebugLog: (msg: string, type?: 'info' | 'error') => void;
  onDurationChange: (d: number) => void;
  /** Active video-rendering mode. Determines which player is mounted and
   *  what the inaccuracy warning says. */
  videoMode: VideoMode;
  /** Whether the user has an active selection. Used by `mixed` mode to flip
   *  to the frame-accurate canvas path. */
  hasSelection: boolean;
  /** Persist a mode change picked from the corner picker. */
  onVideoModeChange: (mode: VideoMode) => void;
}

export default function VideoPane({
  frameSource,
  frameSourceVersion,
  isAudioTrack,
  videoSrc,
  isProcessing,
  isBuffering,
  isPlaying,
  playbackSpeed,
  getMediaTime,
  onDebugLog,
  onDurationChange,
  videoMode,
  hasSelection,
  onVideoModeChange,
}: VideoPaneProps) {
  // Pick the renderer based on mode.
  //   off:   custom "Video Disabled" placeholder (no element to drive)
  //   fast:  always <video> (cheap, ~100 ms drift vs audio clock)
  //   mixed: <video> by default; canvas (frame-accurate) once a selection exists
  //   high:  canvas whenever a frame source is available
  const canvasAvailable = !!frameSource && !isAudioTrack;
  const wantsCanvas =
    videoMode === 'high' ||
    (videoMode === 'mixed' && hasSelection);
  const usingCanvas = canvasAvailable && wantsCanvas;
  // True when mode=off but the active track is a video — the pane displays a
  // "Video Disabled" placeholder instead of routing through <video>.
  const showDisabledPlaceholder = videoMode === 'off' && !isAudioTrack && !!videoSrc;
  const hasVideo = !isAudioTrack && videoMode !== 'off' && (usingCanvas || !!videoSrc);

  // Pick the warning shown in the top-left corner.
  //   fast                                 → always: "not frame-accurate"
  //   mixed + no selection                 → "not frame-accurate until you select"
  //   mixed + selection but no frameSource → "not frame-accurate (this format)"
  //   high + videoSrc but no frameSource   → "format not supported by frame-accurate pipeline"
  let warning: string | null = null;
  if (videoSrc && !isAudioTrack && videoMode !== 'off') {
    if (videoMode === 'fast') {
      warning = 'Fast video mode: the picture is not frame-accurate with the audio. Switch to High in Project Settings for frame-perfect playback.';
    } else if (videoMode === 'mixed') {
      if (!hasSelection) {
        warning = 'Mixed video mode: the picture is not frame-accurate until you make a selection. Selected regions are decoded frame-by-frame.';
      } else if (!frameSource) {
        warning = "Mixed video mode: this file's format isn't supported by the frame-accurate pipeline, so playback stays in the <video> fallback even inside a selection.";
      }
    } else if (videoMode === 'high' && !frameSource) {
      warning = "This video format isn't supported by the frame-accurate WebCodecs pipeline. Playback falls back to the browser's <video> element and will not be frame-perfect.";
    }
  }

  // ── Zoom state (shared model; reset whenever the track changes) ────────
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [zoomToolActive, setZoomToolActive] = useState(false);
  // Remembers the last zoomed-in viewport so Z can restore it.
  const lastZoomViewport = useRef<Viewport | null>(null);

  useEffect(() => {
    setViewport(DEFAULT_VIEWPORT);
    setZoomToolActive(false);
    lastZoomViewport.current = null;
  }, [frameSourceVersion, videoSrc, isAudioTrack]);

  // Z key toggles zoom state: saves/restores lastZoomViewport without
  // touching the tool. Shift+Z (in VideoZoomLayer) toggles the drawing tool.
  const handleToggleZoomState = useCallback(() => {
    setViewport(prev => {
      if (isZoomed(prev)) {
        lastZoomViewport.current = prev;
        return DEFAULT_VIEWPORT;
      } else {
        return lastZoomViewport.current ?? DEFAULT_VIEWPORT;
      }
    });
  }, []);

  useHotkeys([
    {
      key: 'z',
      handler: handleToggleZoomState,
    },
  ]);

  // Toggling the zoom tool does not affect the viewport.
  const handleZoomToolActiveChange = useCallback((active: boolean) => {
    setZoomToolActive(active);
  }, []);

  // Viewport changes from the zoom layer (buttons, marquee) update
  // lastZoomViewport so Z can restore them later.
  const handleViewportChange = useCallback((vp: Viewport) => {
    if (isZoomed(vp)) lastZoomViewport.current = vp;
    setViewport(vp);
  }, []);

  // Canvas path: push the viewport into the frame source (drawAt reads it).
  useEffect(() => {
    if (usingCanvas && frameSource) frameSource.setViewport(viewport);
  }, [usingCanvas, frameSource, viewport]);

  // Change 3b: scroll-to-pan — keep a ref so the non-reactive wheel handler
  // always sees the latest viewport without re-registering the listener.
  const viewportRef = useRef(viewport);
  useEffect(() => { viewportRef.current = viewport; }, [viewport]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!isZoomed(viewportRef.current)) return;
      e.preventDefault();
      const dx = e.deltaX / 1500;
      const dy = e.deltaY / 1500;
      setViewport(prev => panViewport(prev, dx, dy));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        drawLetterboxed(ctx, v, w, h, v.videoWidth, v.videoHeight);
      }
    },
    [usingCanvas, frameSource],
  );

  return (
    <div
      ref={containerRef}
      className="flex-1 relative bg-black flex justify-center items-center"
    >
      {/* Renderer selection:
       *    - "Video Disabled" placeholder when mode=off on a video track
       *    - canvas: frame-accurate WebCodecs path for MP4/MOV
       *    - <video>: cheap, drifts ~100 ms vs the audio clock */}
      {showDisabledPlaceholder ? (
        <div className="w-full h-full flex flex-col items-center justify-center bg-black text-slate-500 select-none">
          <VideoOff size={48} className="mb-3 opacity-50" />
          <p className="text-lg font-medium">Video Disabled</p>
          <p className="text-xs text-slate-600 mt-1">Switch modes with the picker in the bottom-left</p>
        </div>
      ) : usingCanvas ? (
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
          isPlaying={isPlaying}
          playbackSpeed={playbackSpeed}
          getMediaTime={getMediaTime}
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
          onViewportChange={handleViewportChange}
          frameW={frameW}
          frameH={frameH}
          toolActive={zoomToolActive}
          onToolActiveChange={handleZoomToolActiveChange}
          onToggleZoomState={handleToggleZoomState}
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
      {warning && (
        <div
          className="absolute top-2 left-2 z-30 text-[#e65161] cursor-default"
          data-tooltip={warning}
        >
          <AlertCircle size={20} />
        </div>
      )}

      {/* Bottom-left video-mode picker. Bottom-right is taken by the zoom
          minimap when zoomed; this corner is clear. */}
      <div
        className="absolute left-2 bottom-2 z-30 flex gap-1 rounded-md bg-slate-900/70 backdrop-blur-sm border border-slate-700 p-1 pointer-events-auto"
      >
        {(['off', 'fast', 'mixed', 'high'] as VideoMode[]).map(mode => {
          const tooltips: Record<VideoMode, string> = {
            off: 'No video display. Audio only — lightest on the CPU.',
            fast: "Browser <video> element. Cheap, but the picture drifts up to ~100 ms from the audio.",
            mixed: 'Cheap <video> until you make a selection, then frame-accurate decoding for that region.',
            high: 'Frame-accurate WebCodecs decoding throughout. Heaviest on the CPU. MP4/MOV only — other formats fall back automatically.',
          };
          const active = videoMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onVideoModeChange(mode)}
              data-tooltip={tooltips[mode]}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-[#e65161] text-white'
                  : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
