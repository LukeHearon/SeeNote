import { useCallback, useEffect, useRef, useState } from 'react';
import { AnnotationTool } from '../types';
import { AudioEngine } from '../utils/AudioEngine';
import { audioPeak } from '../utils/tauriCommands';
import { normalizationGain } from '../utils/normalizeGain';

/**
 * Plays a tool's example clips via AudioEngine (PCM streaming, same as the main
 * playback path) so the asset:// protocol is never involved. Each press of a
 * tool's button plays the NEXT clip in that tool's `exampleFiles`, cycling.
 *
 * This is intentionally a lightweight preview path with no spectrogram or
 * playhead — the cornerstone time-axis invariant doesn't apply here.
 */
export interface ExamplePlayer {
  /** id of the tool whose example is currently playing, or null. */
  playingToolId: string | null;
  /** Toggle: start the tool's next example, or stop if it's already playing. */
  toggle: (tool: AnnotationTool) => void;
  /** Stop any current playback. */
  stop: () => void;
}

export function useExamplePlayer(onLog?: (msg: string, type?: 'info' | 'error') => void): ExamplePlayer {
  const [playingToolId, setPlayingToolId] = useState<string | null>(null);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  // Next clip index to play per tool id, so repeated presses cycle through.
  const nextIndexRef = useRef<Map<string, number>>(new Map());
  // Cached per-file normalization gain so we don't re-decode for the peak on
  // every press. Shared concept with the example-library modal (normalizeGain).
  const gainCacheRef = useRef<Map<string, number>>(new Map());
  const playingToolIdRef = useRef<string | null>(null);
  playingToolIdRef.current = playingToolId;

  const engineRef = useRef<AudioEngine | null>(null);
  /** Bumped by every toggle/stop and by unmount. A load in flight compares the
   *  token it captured before touching the engine, so a clip whose metadata
   *  arrives after the user moved on (or after the engine was disposed) never
   *  starts playing. */
  const loadTokenRef = useRef(0);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new AudioEngine({
        onTimeUpdate: () => {},
        onPlaying: () => {},
        onPaused: () => {},
        onEnded: () => setPlayingToolId(null),
        onBufferUnderrun: () => {},
        onBufferRecovered: () => {},
        onDebugLog: (msg, type) => onLogRef.current?.(msg, type),
      });
    }
    return engineRef.current;
  }, []);

  const stop = useCallback(() => {
    loadTokenRef.current++;
    engineRef.current?.pause();
    setPlayingToolId(null);
  }, []);

  const toggle = useCallback((tool: AnnotationTool) => {
    if (playingToolIdRef.current === tool.id) {
      stop();
      return;
    }
    const files = tool.exampleFiles ?? [];
    if (files.length === 0) {
      onLogRef.current?.(`"${tool.text}" has no example clips`);
      return;
    }
    const idx = (nextIndexRef.current.get(tool.id) ?? 0) % files.length;
    nextIndexRef.current.set(tool.id, idx + 1);
    const path = files[idx];
    onLogRef.current?.(`[example] loading clip ${idx + 1}/${files.length} for "${tool.text}": ${path}`);
    const engine = getEngine();
    engine.pause();
    const token = ++loadTokenRef.current;
    engine.loadFile(path)
      .then(async () => {
        if (token !== loadTokenRef.current) return;
        // Normalize loudness (cached per file) so clips preview at a comparable
        // level. Same target as the example-library modal.
        let gain = gainCacheRef.current.get(path);
        if (gain === undefined) {
          try { gain = normalizationGain(await audioPeak(path)); }
          catch { gain = 1; }
          gainCacheRef.current.set(path, gain);
        }
        // The peak measurement is another await — re-check before playing.
        if (token !== loadTokenRef.current) return;
        engine.setGain(gain);
        engine.play(0);
        setPlayingToolId(tool.id);
      })
      .catch(err => {
        // A superseded load (including the one dispose() rejects on unmount)
        // isn't a failure worth reporting.
        if (token !== loadTokenRef.current) return;
        onLogRef.current?.(`[example] failed to load "${path}": ${err}`, 'error');
        setPlayingToolId(null);
      });
  }, [getEngine, stop]);

  useEffect(() => () => {
    loadTokenRef.current++;
    engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  return { playingToolId, toggle, stop };
}
