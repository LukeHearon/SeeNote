import React, { useEffect, useMemo, useRef, useState } from 'react';
import { annotationToolLibrary as copy } from '../copy/ui';
import { tooltips } from '../copy/tooltips';
import { X, Play, Pause } from 'lucide-react';
import { AnnotationTool, SpectrogramSettings } from '../types';
import { AudioEngine } from '../utils/AudioEngine';
import { createCurrentTimeStore } from '../utils/currentTimeStore';
import { audioPeak } from '../utils/tauriCommands';
import { revealInFileManager } from '../utils/projectCommands';
import { normalizationGain } from '../utils/normalizeGain';
import ExampleSpectrogram from './ExampleSpectrogram';
import LevelRangeSlider from './LevelRangeSlider';
import VolumeControl from './VolumeControl';

interface Props {
  tool: AnnotationTool;
  /** Project spectrogram settings used as the starting point. Edits here are
   *  local to the modal and never written back to the project. */
  initialSettings: SpectrogramSettings;
  onClose: () => void;
  /** Fired whenever this modal's playback starts/stops, so the host can keep
   *  the main track's audio from playing over the example. */
  onPlayingChange?: (playing: boolean) => void;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const revealLabel = isMac ? 'Show in Finder' : 'Show in File Explorer';

/**
 * Read-only library for one annotation tool's example clips: a clip list on the
 * left, an inline spectrogram + transport on the right. Playback uses its own
 * AudioEngine instance (sample-accurate, kept in lockstep with the spectrogram
 * playhead via a local currentTimeStore) and is fully independent of the main
 * annotation window's playback. Spectrogram settings are seeded from the
 * project but edited locally and not persisted. Loudness is normalized per clip
 * (with a user volume on top) so quiet/loud examples preview comparably.
 */
export default function AnnotationToolLibrary({ tool, initialSettings, onClose, onPlayingChange, addLog }: Props) {
  const files = useMemo(() => tool.exampleFiles ?? [], [tool.exampleFiles]);
  const [settings, setSettings] = useState<SpectrogramSettings>(initialSettings);
  const [selected, setSelected] = useState<string | null>(files[0] ?? null);
  const [clip, setClip] = useState<{ path: string; sampleRate: number; duration: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // User volume as a linear gain (1.0 = unity, up to 4.0), layered on top of
  // per-clip normalization. Matches the main toolbar's VolumeControl model.
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  // Normalization gain for the loaded clip (1 until its peak is measured).
  const normGainRef = useRef(1);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  volumeRef.current = volume;
  mutedRef.current = muted;
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const storeRef = useRef(createCurrentTimeStore());
  const engineRef = useRef<AudioEngine | null>(null);

  // Notify the host so it can park the main track's audio while we play.
  useEffect(() => { onPlayingChange?.(isPlaying); }, [isPlaying, onPlayingChange]);
  useEffect(() => () => onPlayingChange?.(false), [onPlayingChange]);

  const applyGain = () => engineRef.current?.setGain(normGainRef.current * (mutedRef.current ? 0 : volumeRef.current));

  // One engine for the whole modal lifetime.
  useEffect(() => {
    const engine = new AudioEngine({
      onTimeUpdate: (t) => storeRef.current.set(t),
      onPlaying: () => setIsPlaying(true),
      onPaused: () => setIsPlaying(false),
      onEnded: () => { setIsPlaying(false); storeRef.current.set(0); },
      onBufferUnderrun: () => {},
      onDebugLog: addLog,
    });
    engineRef.current = engine;
    return () => { engine.dispose(); engineRef.current = null; };
  }, [addLog]);

  // Live-apply user volume/mute changes.
  useEffect(() => { applyGain(); }, [volume, muted]);

  // Load the selected clip into the engine and reset the playhead.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !selected) { setClip(null); return; }
    let cancelled = false;
    engine.pause();
    setIsPlaying(false);
    storeRef.current.set(0);
    setClip(null);
    normGainRef.current = 1;
    engine.loadFile(selected)
      .then(info => {
        if (cancelled) return;
        setClip({ path: selected, sampleRate: info.sampleRate, duration: info.durationSec });
        // Default the frequency axis to this clip's FULL range (DC → Nyquist).
        setSettings(s => ({ ...s, minFreq: 0, maxFreq: info.sampleRate / 2 }));
      })
      .catch(err => { if (!cancelled) addLog(`Couldn't load example: ${err}`, 'error'); });
    // Measure peak for normalization in parallel; apply once known.
    audioPeak(selected)
      .then(peak => { if (!cancelled) { normGainRef.current = normalizationGain(peak); applyGain(); } })
      .catch(() => { if (!cancelled) { normGainRef.current = 1; applyGain(); } });
    return () => { cancelled = true; };
  }, [selected, addLog]);

  const togglePlay = () => {
    const engine = engineRef.current;
    if (!engine || !clip) return;
    if (isPlaying) {
      engine.pause();
    } else {
      applyGain();
      const t = storeRef.current.get();
      engine.play(t >= clip.duration ? 0 : t);
    }
  };

  const handleSeek = (t: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    storeRef.current.set(t);
    engine.seek(t);
    if (isPlaying) engine.play(t);
  };

  // Step the clip selection by `delta` (clamped), for Cmd/Ctrl+Up/Down.
  const stepClip = (delta: number) => {
    if (files.length === 0) return;
    const cur = selected ? files.indexOf(selected) : -1;
    const next = Math.max(0, Math.min(files.length - 1, (cur < 0 ? 0 : cur) + delta));
    if (files[next] !== selected) setSelected(files[next]);
  };

  // Key handling for the modal. Space toggles play (unless a text field has
  // focus); Cmd/Ctrl+Up/Down navigate between clips; Esc closes. The host
  // disables its own hotkeys while we're open, so these don't double-fire with
  // the main window.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        stepClip(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (e.key === ' ') {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
        e.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  // Dismiss the context menu on any outside interaction.
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('blur', dismiss);
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('blur', dismiss); };
  }, [menu]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-[860px] h-[600px] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-none">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-3 h-3 rounded-full flex-none" style={{ backgroundColor: tool.color }} />
            <span className="text-sm font-semibold text-white truncate">{tool.text}</span>
            <span className="text-xs text-slate-500">{copy.exampleClipsSubtitle}</span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded text-slate-400 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-row flex-1 min-h-0">
          {/* Clip list */}
          <div className="w-56 border-r border-gray-700 overflow-y-auto flex-none py-2">
            {files.length === 0 && (
              <p className="px-4 py-2 text-xs text-slate-500">{copy.noExampleClips}</p>
            )}
            {files.map(f => (
              <button
                key={f}
                onClick={() => setSelected(f)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path: f }); }}
                className={`w-full text-left px-4 py-1.5 text-xs truncate transition-colors ${
                  selected === f ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                }`}
                data-tooltip={basename(f)}
              >
                {basename(f)}
              </button>
            ))}
          </div>

          {/* Spectrogram + transport */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Transport + spectrogram settings, all on one row */}
            <div className="flex items-end gap-4 px-4 py-2 border-b border-gray-700 flex-none">
              <button
                onClick={togglePlay}
                disabled={!clip}
                className="p-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 disabled:opacity-40 transition-colors flex-none mb-0.5"
                data-tooltip={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              </button>
              <div className="flex-1 min-w-0">
                <LevelRangeSlider
                  floor={settings.displayFloor}
                  ceil={settings.displayCeil}
                  showInputs={false}
                  onChange={(r) => setSettings(s => ({ ...s, ...r }))}
                />
              </div>
              <div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">{copy.frequencyLabel}</div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={settings.minFreq}
                    onChange={(e) => setSettings(s => ({ ...s, minFreq: Math.max(0, parseInt(e.target.value) || 0) }))}
                    className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs focus:border-[#e65161] outline-none"
                  />
                  <span className="text-slate-500 text-xs">–</span>
                  <input
                    type="number"
                    value={settings.maxFreq}
                    onChange={(e) => setSettings(s => ({ ...s, maxFreq: parseInt(e.target.value) || 0 }))}
                    className="w-16 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs focus:border-[#e65161] outline-none"
                  />
                </div>
              </div>
              <div className="flex-none mb-0.5" data-tooltip={tooltips.previewVolume}>
                <VolumeControl volume={volume} muted={muted} setVolume={setVolume} setMuted={setMuted} />
              </div>
            </div>

            {/* Spectrogram */}
            <div className="flex-1 min-h-0">
              {clip ? (
                <ExampleSpectrogram
                  key={clip.path}
                  filePath={clip.path}
                  sampleRate={clip.sampleRate}
                  duration={clip.duration}
                  settings={settings}
                  currentTimeStore={storeRef.current}
                  onSeek={handleSeek}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                  {selected ? 'Loading…' : 'Select a clip'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Reveal-in-file-manager context menu */}
      {menu && (
        <div
          className="fixed z-[60] bg-slate-800 border border-slate-600 rounded-md shadow-xl py-1 text-xs"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-700"
            onClick={() => { revealInFileManager(menu.path).catch(err => addLog(`${err}`, 'error')); setMenu(null); }}
          >
            {revealLabel}
          </button>
        </div>
      )}
    </div>
  );
}
