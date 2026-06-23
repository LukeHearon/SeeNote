import { useCallback, useEffect, useRef, useState } from 'react';
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
import { videoPane as videoP } from '../copy/ui';

interface VideoPaneProps {
  frameSource: VideoFrameSource | null;
  frameSourceVersion: number;
  isAudioTrack: boolean;
  videoSrc: string | null;
  isProcessing: boolean;
  isBuffering: boolean;
  getMediaTime: () => number;
  onDebugLog: (msg: string, type?: 'info' | 'error') => void;
  onDurationChange?: (d: number) => void;
  /** Active video-rendering mode. Determines which player is mounted and
   *  what the inaccuracy warning says. */
  videoMode: VideoMode;
  /** Whether the user has an active selection. Used by `mixed` mode to flip
   *  to the frame-accurate canvas path. */
  hasSelection: boolean;
  /** Persist a mode change picked from the corner picker. */
  onVideoModeChange: (mode: VideoMode) => void;
  /** Exposes the fallback <video> element to the parent so VideoElementEngine
   *  can drive transport on it (Fast / Mixed-without-selection). */
  onVideoElement?: (el: HTMLVideoElement | null) => void;
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
  videoMode,
  hasSelection,
  onVideoModeChange,
  onVideoElement,
}: VideoPaneProps) {
  // Pick the renderer based on mode.
  //   off:   custom "Video Disabled" placeholder (no element to drive)
  //   fast:  <video> displays the picture and plays its own audio (free-running)
  //   mixed: <video> by default; canvas (frame-accurate) once a selection exists
  //   accurate: canvas whenever a frame source is available
  const canvasAvailable = !!frameSource && !isAudioTrack;
  const wantsCanvas =
    videoMode === 'accurate' ||
    (videoMode === 'mixed' && hasSelection);
  const usingCanvas = canvasAvailable && wantsCanvas;
  // True when mode=off but the active track is a video — the pane displays a
  // "Video Disabled" placeholder instead of routing through <video>.
  const showDisabledPlaceholder = videoMode === 'off' && !isAudioTrack && !!videoSrc;
  const hasVideo = !isAudioTrack && videoMode !== 'off' && (usingCanvas || !!videoSrc);
  // The <video> element is the active sound source exactly when it's the live
  // renderer for a video file (Fast, and Mixed before a selection). Then it
  // plays its own audio and must not be muted; VideoElementEngine drives it.
  const videoElementIsTransport =
    !isAudioTrack && !usingCanvas && !showDisabledPlaceholder && !!videoSrc;

  // Pick the warning shown in the top-left corner.
  //   fast                                 → always: "not frame-accurate"
  //   mixed + no selection                 → "not frame-accurate until you select"
  //   mixed + selection but no frameSource → "not frame-accurate (this format)"
  //   accurate + videoSrc but no frameSource → "format not supported by frame-accurate pipeline"
  let warning: string | null = null;
  if (videoSrc && !isAudioTrack && videoMode !== 'off') {
    if (videoMode === 'fast') {
      warning = 'Fast mode: video plays independently — the playhead is approximate and audio filters are disabled. Playback rate works (0.5–2×).';
    } else if (videoMode === 'mixed') {
      if (!hasSelection) {
        warning = 'Mixed mode: audio filters only apply inside a selection. Outside a selection the video plays independently (0.5–2× rate still works).';
      } else if (!frameSource) {
        warning = "Mixed mode: this file's format doesn't support frame-accurate playback, so the picture may not stay perfectly in sync even inside a selection.";
      }
    } else if (videoMode === 'accurate' && !frameSource) {
      warning = "This file's format doesn't support frame-accurate playback. The picture may not stay perfectly in sync with the audio.";
    }
  }

  // ── Video-mode picker expand/collapse on hover ──────────────────────────
  const [modePickerExpanded, setModePickerExpanded] = useState(false);
  const modePickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleModePickerEnter = useCallback(() => {
    if (isAudioTrack) return;
    modePickerTimerRef.current = setTimeout(() => setModePickerExpanded(true), 200);
  }, [isAudioTrack]);
  const handleModePickerLeave = useCallback(() => {
    if (modePickerTimerRef.current) clearTimeout(modePickerTimerRef.current);
    setModePickerExpanded(false);
  }, []);

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

  // Stable so VideoPlayer's element-exposure effect (keyed on this callback's
  // identity) only fires on real mount/unmount/src-change — not on every render.
  // An unstable callback here re-runs that effect each render, and its cleanup
  // detaches the element from VideoElementEngine mid-playback (killing the
  // playhead rAF) before immediately re-attaching.
  const handleVideoElement = useCallback((el: HTMLVideoElement | null) => {
    fallbackVideoRef.current = el;
    onVideoElement?.(el);
  }, [onVideoElement]);
  const handleVideoDims = useCallback((w: number, h: number) => {
    setFallbackDims({ w, h });
  }, []);

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
          <p className="text-lg font-medium">{videoP.videoDisabled}</p>
          <p className="text-xs text-slate-600 mt-1">{videoP.switchModesHint}</p>
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
          onDurationChange={onDurationChange}
          onDebugLog={onDebugLog}
          viewport={viewport}
          contentRect={contentRect}
          playsOwnAudio={videoElementIsTransport}
          onVideoDims={handleVideoDims}
          onVideoElement={handleVideoElement}
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
          <p className="text-[#e65161] font-medium">{videoP.processingMedia}</p>
          <p className="text-slate-400 text-sm mt-1">{videoP.loadingFile}</p>
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

      {/* Bottom-left video-mode picker. Collapsed to current mode label until hovered. */}
      <div
        className="absolute left-2 bottom-2 z-30 pointer-events-auto group"
        onMouseEnter={handleModePickerEnter}
        onMouseLeave={handleModePickerLeave}
      >
        {/* Collapsed view — fades out when expanded */}
        <div
          className={`flex flex-col items-start gap-1 transition-all duration-150 ${
            modePickerExpanded ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <span className="text-[10px] font-medium text-white leading-none px-1">{videoP.modeLabel}</span>
          <div className="bg-slate-900/70 backdrop-blur-sm border border-slate-700 group-hover:border-slate-500 rounded-md p-1 transition-colors duration-150">
            <span className="block px-2 py-0.5 rounded text-[11px] font-medium bg-slate-700 text-slate-300">
              {isAudioTrack ? 'Off' : videoMode.charAt(0).toUpperCase() + videoMode.slice(1)}
            </span>
          </div>
        </div>

        {/* Expanded picker — slides up and fades in from the pill's position */}
        <div
          className={`absolute bottom-0 left-0 flex flex-col transition-all duration-200 ${
            modePickerExpanded
              ? 'opacity-100 translate-y-0 pointer-events-auto'
              : 'opacity-0 translate-y-2 pointer-events-none'
          }`}
        >
          <div className="self-start bg-slate-900/70 backdrop-blur-sm border border-b-0 border-slate-500 rounded-t-md px-2 pt-0 pb-px">
            <span className="text-[9px] font-semibold tracking-widest text-slate-400 uppercase leading-none">{videoP.videoModeLabel}</span>
          </div>
          <div className="flex gap-1 rounded-b-md rounded-tr-md bg-slate-900/70 backdrop-blur-sm border border-slate-500 p-1">
            {(['off', 'fast', 'mixed', 'accurate'] as VideoMode[]).map(mode => {
              const tooltips: Record<VideoMode, string> = {
                off: 'No video display. Audio only — lightest on the CPU.',
                fast: "Smooth playback, but video runs independently — audio filters disabled, playhead approximate. Rate adjustable 0.5–2×. Best for slow machines.",
                mixed: 'Outside a selection, video plays independently (rate 0.5–2×). Inside a selection, audio filters apply and the picture locks to the audio clock.',
                accurate: 'Full frame-accurate sync throughout. Heaviest on the CPU. MP4/MOV only — other formats fall back automatically.',
              };
              const active = isAudioTrack ? mode === 'off' : videoMode === mode;
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
      </div>
    </div>
  );
}
