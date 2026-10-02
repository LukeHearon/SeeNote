import { useEffect, useRef } from 'react';
import type { VideoFrameSource } from '../utils/VideoFrameSource';

interface CanvasVideoPlayerProps {
  /** Frame source to draw from. The component does not own this — the caller
   *  is responsible for opening and closing it. */
  frameSource: VideoFrameSource;
  /** Called every rAF tick for the playhead's position in the file, in
   *  seconds. The canvas draws whichever cached frame is ≤ this value.
   *  SOURCE time, not display time: frames are indexed by where they sit in
   *  the file, so a caller running a subset timeline converts before passing
   *  this in (see utils/subsetTimeline). */
  getFrameTime: () => number;
  /** Optional debug logger. One-shot logs emit on mount + first successful draw. */
  onDebugLog?: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * Renders video frames from a VideoFrameSource onto a canvas. The canvas is
 * sized to its container (CSS-driven); each rAF tick we match the backing
 * store to the displayed size and call frameSource.drawAt(ctx, t).
 *
 * Ticking every frame is cheap: frameSource.drawAt is an O(log N) cache lookup
 * and only draws when the frame, size or zoom changed. The container's size
 * comes from a ResizeObserver rather than a layout read per tick. The decode
 * pipeline runs independently in the frame source.
 */
export default function CanvasVideoPlayer({ frameSource, getFrameTime, onDebugLog }: CanvasVideoPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      onDebugLog?.(`[canvasvp] mount: canvas=${!!canvas} container=${!!container}`, 'error');
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      onDebugLog?.('[canvasvp] getContext(2d) returned null', 'error');
      return;
    }
    onDebugLog?.('[canvasvp] rAF loop starting');

    let rAF: number | null = null;
    let lastW = 0;
    let lastH = 0;
    let ticks = 0;
    let rect = container.getBoundingClientRect();
    const ro = new ResizeObserver(() => { rect = container.getBoundingClientRect(); });
    ro.observe(container);

    const tick = () => {
      // Match the canvas backing store to its displayed size (devicePixelRatio-aware).
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.floor(rect.width * dpr));
      const targetH = Math.max(1, Math.floor(rect.height * dpr));
      if (targetW !== lastW || targetH !== lastH) {
        canvas.width = targetW;
        canvas.height = targetH;
        lastW = targetW;
        lastH = targetH;
        onDebugLog?.(`[canvasvp] canvas sized ${targetW}x${targetH} (container=${rect.width}x${rect.height} dpr=${dpr})`);
      }
      frameSource.drawAt(ctx, getFrameTime());
      ticks++;
      rAF = requestAnimationFrame(tick);
    };
    rAF = requestAnimationFrame(tick);

    return () => {
      ro.disconnect();
      if (rAF !== null) cancelAnimationFrame(rAF);
      onDebugLog?.(`[canvasvp] rAF loop stopped after ${ticks} ticks`);
    };
  }, [frameSource, getFrameTime, onDebugLog]);

  return (
    <div ref={containerRef} className="w-full h-full relative bg-black">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: 'block' }}
      />
    </div>
  );
}
