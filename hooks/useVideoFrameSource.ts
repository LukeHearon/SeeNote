import { useState, useRef, useEffect, useCallback } from 'react';
import { VideoFrameSource, canUseFrameSource } from '../utils/VideoFrameSource';
import { toAssetUrl } from '../utils/tauriCommands';
import { VideoMode, Selection } from '../types';

interface UseVideoFrameSourceArgs {
  // Track identity / mode mirrors, read inside async opens & the mode-change effect.
  trackPath: string | null;
  trackPathRef: React.MutableRefObject<string | null>;
  isAudioTrack: boolean;
  videoMode: VideoMode;
  durationRef: React.MutableRefObject<number>;
  selectionRef: React.MutableRefObject<Selection | null>;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

// Owns the VideoFrameSource lifecycle for frame-perfect MP4/MOV playback: the
// source handle ref, its rolling-prefetch bookkeeping refs, the version counter
// that re-renders the video pane on create/teardown, the pre-roll helper, and
// the unmount + videoMode-change effects. The frame source itself is held in a
// ref (not state) because it owns mutable GPU resources; `frameSourceVersion`
// is the simple counter consumers re-render on.
//
// `preZoomExtentRef` rides along here: it's reset on track change alongside the
// frame source, and the hotkey zoom handlers (kept in AnnotationWindow) read it.
export function useVideoFrameSource({
  trackPath,
  trackPathRef,
  isAudioTrack,
  videoMode,
  durationRef,
  selectionRef,
  addLog,
}: UseVideoFrameSourceArgs) {
  // VideoFrameSource for frame-perfect playback on MP4/MOV video tracks.
  // When non-null, CanvasVideoPlayer drives the display; the <video> element
  // is not used. For audio tracks or non-ISOBMFF containers, this stays null
  // and we fall back to the legacy <video>-based path.
  const frameSourceRef = useRef<VideoFrameSource | null>(null);
  // Rolling prefetch state for the frame-source path. Tracks how far ahead
  // frames have been decoded so onTimeUpdate knows when to fetch the next chunk.
  const videoPrefetchEndRef = useRef(0);
  const videoPrefetchBusyRef = useRef(false);
  // Trigger re-render of the video pane when frameSource is created/torn down.
  // We don't put the VideoFrameSource itself in state because it owns mutable
  // GPU resources; a simple version counter is enough to switch components.
  const [frameSourceVersion, setFrameSourceVersion] = useState(0);
  const preZoomExtentRef = useRef<{ startTime: number; endTime: number } | null>(null);
  // True once the current frame source's decoder has reported it has no
  // decoder for this file's codec (see VideoFrameSource.onDecoderUnsupported).
  // On some platforms this is the *only* place a WebCodecs failure surfaces —
  // open() already resolved successfully by the time decode() fails.
  const [frameSourceDecodeError, setFrameSourceDecodeError] = useState(false);

  // Pre-roll the frame-source cache so the first frame at startSec is decoded
  // before the audio engine begins emitting samples. Critical for short-selection
  // replays: without this the engine starts audio ~200ms ahead of the first
  // rendered frame, so a ~1s selection ends before most frames appear.
  const prerollVideo = useCallback(async (startSec: number, endSec?: number): Promise<void> => {
    const source = frameSourceRef.current;
    if (!source) return;
    const end = endSec ?? Math.min(startSec + 5, durationRef.current || startSec + 5);
    const t0 = performance.now();
    addLog(`[preroll] start ${startSec.toFixed(3)}-${end.toFixed(3)}s`);
    try { await source.ensureRange(startSec, end, 'prerollVideo'); } catch { /* canvas shows stale frame on error */ }
    addLog(`[preroll] done in ${(performance.now() - t0).toFixed(0)}ms`);
    videoPrefetchEndRef.current = end;
  }, [addLog, durationRef]);

  // Tear down frame source on unmount — VideoFrame handles hold GPU memory.
  useEffect(() => () => {
    if (frameSourceRef.current) {
      frameSourceRef.current.close();
      frameSourceRef.current = null;
    }
  }, []);

  // React to videoMode changes for the currently-loaded track. Toggling
  // off/fast ↔ mixed/accurate without this would leave a stale frame source open
  // (memory + decoder) or, conversely, leave the canvas dark with no decoder.
  // The track itself doesn't need to be reloaded — only the frame source.
  useEffect(() => {
    if (!trackPath || isAudioTrack) return;
    const wantsFrameSource =
      (videoMode === 'accurate' || videoMode === 'mixed') && canUseFrameSource(trackPath);
    const has = !!frameSourceRef.current;

    if (wantsFrameSource && !has) {
      const url = toAssetUrl(trackPath);
      const expectedTrack = trackPath;
      setFrameSourceDecodeError(false);
      (async () => {
        try {
          const source = new VideoFrameSource({
            onDebugLog: addLog,
            onDecoderUnsupported: () => {
              if (trackPathRef.current === expectedTrack) setFrameSourceDecodeError(true);
            },
          });
          await source.open(url);
          if (trackPathRef.current !== expectedTrack) { source.close(); return; }
          frameSourceRef.current = source;
          setFrameSourceVersion(v => v + 1);
          if (videoMode === 'accurate') {
            const dur = durationRef.current;
            source.ensureRange(0, Math.min(5, dur || 5), 'modeChangeWarm').catch(() => {});
          } else if (videoMode === 'mixed' && selectionRef.current) {
            // Mode switched on with an existing selection — warm it now.
            const sel = selectionRef.current;
            source.ensureRange(sel.start, sel.end, 'modeChangeWarmSel').catch(() => {});
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          addLog(`[video] frame source unavailable: ${msg}`, 'error');
        }
      })();
    } else if (!wantsFrameSource && has) {
      frameSourceRef.current?.close();
      frameSourceRef.current = null;
      setFrameSourceVersion(v => v + 1);
      videoPrefetchEndRef.current = 0;
      videoPrefetchBusyRef.current = false;
      setFrameSourceDecodeError(false);
    }
  }, [videoMode, trackPath, isAudioTrack, addLog, trackPathRef, durationRef, selectionRef]);

  // Reset whenever the open track changes — a decode error belongs to the
  // file that produced it, not to whatever opens next.
  useEffect(() => {
    setFrameSourceDecodeError(false);
  }, [trackPath]);

  return {
    frameSourceRef,
    videoPrefetchEndRef,
    videoPrefetchBusyRef,
    preZoomExtentRef,
    frameSourceVersion,
    setFrameSourceVersion,
    frameSourceDecodeError,
    prerollVideo,
  };
}
