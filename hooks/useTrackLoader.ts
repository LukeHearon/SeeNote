import { useCallback, type MutableRefObject } from 'react';
import type { SpectrogramSettings } from '../types';
import type { AudioEngine } from '../utils/AudioEngine';
import { getFileInfo } from '../utils/tauriCommands';
import { MIN_ZOOM_SEC } from '../constants';

interface TrackLoaderParams {
  engineRef: MutableRefObject<AudioEngine | null>;
  zoomSecRef: MutableRefObject<number>;
  setSampleRate: (sr: number) => void;
  setDuration: (d: number) => void;
  setSettings: (update: (s: SpectrogramSettings) => SpectrogramSettings) => void;
  setZoomSec: (z: number) => void;
  installChunkCache: (path: string, sampleRate: number, duration: number, zoomSec: number) => void;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * Load a media file into the engine and bring the view onto it: sample rate,
 * duration, the frequency ceiling, the zoom, and a fresh spectrogram chunk
 * cache. Throws on a file that can't be opened; the caller owns the
 * error/teardown policy and the processing flag. `superseded` lets a caller
 * abandon a load that a newer one has overtaken.
 */
export function useTrackLoader({
  engineRef, zoomSecRef, setSampleRate, setDuration, setSettings, setZoomSec, installChunkCache, addLog,
}: TrackLoaderParams) {
  return useCallback(async (path: string, superseded: () => boolean): Promise<void> => {
    // For video files the engine handles the audio; the <video> element (or
    // frame source) shows frames only.
    let sr: number;
    let dur: number;
    let channels: number;
    if (engineRef.current) {
      const info = await engineRef.current.loadFile(path);
      sr = info.sampleRate;
      dur = info.durationSec;
      channels = info.channels;
    } else {
      const info = await getFileInfo(path);
      sr = info.sample_rate;
      dur = info.duration_secs;
      channels = info.channels;
    }
    addLog(`File info: ${dur.toFixed(2)}s, ${sr}Hz, ${channels}ch`);
    if (superseded()) return;

    setSampleRate(sr);
    if (dur > 0) setDuration(dur);
    // Clamp the displayed max frequency to this file's Nyquist, but keep a
    // lower user-chosen ceiling.
    setSettings(s => s.maxFreq > sr / 2 ? { ...s, maxFreq: sr / 2 } : s);

    // Fit zoom to the file if it's shorter than the current window.
    const effectiveZoom = (dur > 0 && dur < zoomSecRef.current) ? Math.max(MIN_ZOOM_SEC, dur) : zoomSecRef.current;
    if (effectiveZoom !== zoomSecRef.current) setZoomSec(effectiveZoom);

    // New multi-tier chunk cache for this file; its first viewport prefetch
    // starts immediately.
    installChunkCache(path, sr, dur, effectiveZoom);
    addLog('Spectrogram loading...');
  }, [engineRef, zoomSecRef, setSampleRate, setDuration, setSettings, setZoomSec, installChunkCache, addLog]);
}
