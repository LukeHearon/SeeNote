import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Volume2, VolumeX, Loader2, Settings, Gauge, Filter, Activity } from 'lucide-react';
import { Selection, BandPassFilter, VideoMode } from '../types';
import { SpectrogramHandle } from './Spectrogram';
import { clamp } from '../utils/helpers';
import type { CurrentTimeStore } from '../utils/currentTimeStore';

type TimeField = 'time' | 'selStart' | 'selEnd' | 'selDur';

// Live playback-time readout. Subscribes to the currentTime store and holds its
// own state so it — and not the whole memoized Toolbar — re-renders per tick.
function TimeDisplay({ currentTimeStore }: { currentTimeStore: CurrentTimeStore }) {
  const [t, setT] = useState(currentTimeStore.get());
  useEffect(() => {
    setT(currentTimeStore.get());
    return currentTimeStore.subscribe(() => setT(currentTimeStore.get()));
  }, [currentTimeStore]);
  return <>{t.toFixed(2)}s</>;
}

interface ToolbarProps {
  isPlaying: boolean;
  isBuffering: boolean;
  videoSrc: string | null;
  // Playback time via the ref-based store so ticks don't re-render the toolbar.
  currentTimeStore: CurrentTimeStore;
  duration: number;
  selection: Selection | null;
  volume: number;
  muted: boolean;
  canGoPrevAnnotation: boolean;
  canGoNextAnnotation: boolean;
  spectrogramRef: React.RefObject<SpectrogramHandle | null>;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  onPlay: () => void;
  onSeek: (time: number, scroll?: boolean) => void;
  onSelectionChange: (s: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onAnnotationBoundsChange?: (start: number, end: number) => void;
  showSettings?: boolean;
  onToggleSettings?: () => void;
  playbackSpeed: number;
  setPlaybackSpeed: (s: number) => void;
  lastDefinedSpeed: number;
  setLastDefinedSpeed: (s: number) => void;
  filterToolActive: boolean;
  onToggleFilterTool: () => void;
  bandPassFilter: BandPassFilter | null;
  setBandPassFilter: (f: BandPassFilter | null) => void;
  onDisableBandPassFilter: () => void;
  onEnableBandPassFilter: (strength: number) => void;
  filterStrength: number;
  setFilterStrength: (s: number) => void;
  videoMode?: VideoMode;
  /** Whether a buzzdetect directory is configured (gates the toggle button). */
  buzzdetectAvailable?: boolean;
  buzzdetectEnabled?: boolean;
  onToggleBuzzdetect?: () => void;
  onRestartAudio?: () => void;
}

// Nonlinear volume mapping: slider [0,1] → gain [0,4], with gain=1.0 at slider=0.5.
// Lower half [0,0.5] covers gain 0→1 (finer resolution for quieting);
// upper half [0.5,1] covers gain 1→4 (coarser resolution for boosting).
const gainToSlider = (gain: number): number =>
  gain <= 1 ? gain / 2 : 0.5 + (gain - 1) / 6;
const sliderToGain = (s: number): number =>
  s <= 0.5 ? s * 2 : 1 + (s - 0.5) * 6;

// Speed: log mapping. slider [0,1] ↔ speed [0.25, 4.0], slider 0.5 ↔ 1.0x.
const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
const speedToSlider = (sp: number): number => {
  const lnMin = Math.log(SPEED_MIN), lnMax = Math.log(SPEED_MAX);
  return (Math.log(sp) - lnMin) / (lnMax - lnMin);
};
const sliderToSpeed = (s: number): number => {
  const lnMin = Math.log(SPEED_MIN), lnMax = Math.log(SPEED_MAX);
  return Math.exp(lnMin + s * (lnMax - lnMin));
};

function Toolbar({
  isPlaying,
  isBuffering,
  videoSrc,
  currentTimeStore,
  duration,
  selection,
  volume,
  muted,
  canGoPrevAnnotation,
  canGoNextAnnotation,
  spectrogramRef,
  setVolume,
  setMuted,
  onPlay,
  onSeek,
  onSelectionChange,
  onBoundAnnotationChange,
  onAnnotationBoundsChange,
  showSettings,
  onToggleSettings,
  playbackSpeed,
  setPlaybackSpeed,
  lastDefinedSpeed,
  setLastDefinedSpeed,
  filterToolActive,
  onToggleFilterTool,
  bandPassFilter,
  setBandPassFilter,
  onDisableBandPassFilter,
  onEnableBandPassFilter,
  filterStrength,
  setFilterStrength,
  videoMode,
  buzzdetectAvailable,
  buzzdetectEnabled,
  onToggleBuzzdetect,
  onRestartAudio,
}: ToolbarProps) {
  const [editingTimeField, setEditingTimeField] = useState<TimeField | null>(null);
  const [editingTimeRaw, setEditingTimeRaw] = useState('');
  const [volumeCtxMenu, setVolumeCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // Refs for use in the non-React wheel event handler (attached once, reads live values)
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const speedRef = useRef(playbackSpeed);
  const filterStrengthRef = useRef(filterStrength);
  const bandPassFilterRef = useRef(bandPassFilter);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { speedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { filterStrengthRef.current = filterStrength; }, [filterStrength]);
  useEffect(() => { bandPassFilterRef.current = bandPassFilter; }, [bandPassFilter]);

  const freeRunning = videoMode === 'fast' || videoMode === 'mixed';
  const effectiveSpeedMin = freeRunning ? 0.5 : SPEED_MIN;
  const effectiveSpeedMax = freeRunning ? 2.0 : SPEED_MAX;
  const filterDisabledByMode = videoMode === 'fast';

  // Clamp speed into the effective range when video mode changes.
  useEffect(() => {
    const clamped = clamp(playbackSpeed, effectiveSpeedMin, effectiveSpeedMax);
    if (clamped !== playbackSpeed) setPlaybackSpeed(clamped);
  }, [videoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const [volumeControlEl, setVolumeControlEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!volumeControlEl) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = gainToSlider(mutedRef.current ? 0 : volumeRef.current);
      const delta = -Math.sign(e.deltaY) * 0.03;
      const newSlider = clamp(cur + delta, 0, 1);
      setVolume(sliderToGain(newSlider));
      setMuted(false);
    };
    volumeControlEl.addEventListener('wheel', handler, { passive: false });
    return () => volumeControlEl.removeEventListener('wheel', handler);
  }, [volumeControlEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const [speedControlEl, setSpeedControlEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!speedControlEl) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = speedToSlider(speedRef.current);
      const delta = -Math.sign(e.deltaY) * 0.03;
      let newSlider = clamp(cur + delta, 0, 1);
      if (Math.abs(newSlider - 0.5) < 0.015) newSlider = 0.5;
      const next = clamp(sliderToSpeed(newSlider), effectiveSpeedMin, effectiveSpeedMax);
      setPlaybackSpeed(next);
      if (next !== 1.0) setLastDefinedSpeed(next);
    };
    speedControlEl.addEventListener('wheel', handler, { passive: false });
    return () => speedControlEl.removeEventListener('wheel', handler);
  }, [speedControlEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const [editingSpeed, setEditingSpeed] = useState(false);
  const [editingSpeedRaw, setEditingSpeedRaw] = useState('');
  const commitSpeedEdit = () => {
    const parsed = parseFloat(editingSpeedRaw.replace(/x$/i, '').trim());
    if (!isNaN(parsed)) {
      const clamped = clamp(parsed, effectiveSpeedMin, effectiveSpeedMax);
      setPlaybackSpeed(clamped);
      if (clamped !== 1.0) setLastDefinedSpeed(clamped);
    }
    setEditingSpeed(false);
    setEditingSpeedRaw('');
  };

  const [filterStrengthEl, setFilterStrengthEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!filterStrengthEl) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      // Wheeling up from disabled re-enables the filter at the new strength.
      if (!bandPassFilterRef.current) {
        if (Math.sign(e.deltaY) >= 0) return; // wheeling down on a disabled filter is a no-op
        const next = clamp(-Math.sign(e.deltaY) * 0.05, 0, 1);
        if (next > 0) onEnableBandPassFilter(next);
        return;
      }
      const next = clamp(filterStrengthRef.current + Math.sign(e.deltaY) * 0.05, 0, 1);
      if (next === 0) { onDisableBandPassFilter(); return; }
      setFilterStrength(next);
      setBandPassFilter({ ...bandPassFilterRef.current, strength: next });
    };
    filterStrengthEl.addEventListener('wheel', handler, { passive: false });
    return () => filterStrengthEl.removeEventListener('wheel', handler);
  }, [filterStrengthEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterEnabled = bandPassFilter !== null;
  // Display 0 when disabled so the slider snaps to bottom; filterStrength is
  // still preserved as the remembered value that F-toggle will restore.
  const displayStrength = filterEnabled ? clamp(filterStrength, 0, 1) : 0;
  const displayStrengthPct = displayStrength * 100;

  const handleFilterStrengthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (v === 0) { onDisableBandPassFilter(); setFilterStrength(0); return; }
    // Dragging up from 0 (filter disabled) re-enables filtering. The handler
    // in AnnotationWindow restores the last band (or falls back to a default).
    if (!bandPassFilter) { onEnableBandPassFilter(v); return; }
    setFilterStrength(v);
    setBandPassFilter({ ...bandPassFilter, strength: v });
  };

  // Handle volume slider change
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let sliderVal = parseFloat(e.target.value);
    // Snap to center (gain=1.0) when close
    if (Math.abs(sliderVal - 0.5) < 0.01) sliderVal = 0.5;
    setVolume(sliderToGain(sliderVal));
    setMuted(false);
  };

  // Calculate volume slider background
  const sliderPct = gainToSlider(muted ? 0 : volume) * 100;
  const isBoosted = !muted && volume > 1;

  // Parse a timestamp string into seconds. Accepts: "83.45", "1:23", "1:23.45", "1:23:45"
  const parseTimestamp = (raw: string): number | null => {
    const s = raw.trim();
    // hh:mm:ss or hh:mm:ss.ff
    const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (hms) return parseInt(hms[1]) * 3600 + parseInt(hms[2]) * 60 + parseFloat(hms[3]);
    // mm:ss or mm:ss.ff
    const ms = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (ms) return parseInt(ms[1]) * 60 + parseFloat(ms[2]);
    // plain seconds
    const plain = parseFloat(s);
    if (!isNaN(plain) && plain >= 0) return plain;
    return null;
  };

  const commitTimeEdit = (raw: string) => {
    if (!editingTimeField) return;

    const applySelection = (s: { start: number; end: number }) => {
      onSelectionChange(s);
      onAnnotationBoundsChange?.(s.start, s.end);
    };

    // selDur accepts negative values (anchor is always selection.start / currentTime),
    // so handle it with parseFloat before parseTimestamp (which rejects negatives).
    if (editingTimeField === 'selDur') {
      const dur = parseFloat(raw.trim());
      if (!isNaN(dur)) {
        const anchor = selection ? selection.start : (!isPlaying ? currentTimeStore.get() : null);
        if (anchor !== null) {
          const a = clamp(Math.min(anchor, anchor + dur), 0, duration);
          const b = clamp(Math.max(anchor, anchor + dur), 0, duration);
          if (a !== b) applySelection({ start: a, end: b });
        }
      }
      setEditingTimeField(null);
      setEditingTimeRaw('');
      return;
    }

    const parsed = parseTimestamp(raw);
    if (parsed !== null) {
      const clamped = clamp(parsed, 0, duration);
      if (editingTimeField === 'time') {
        onSeek(clamped, true);
      } else if (editingTimeField === 'selStart') {
        const other = selection ? selection.end : currentTimeStore.get();
        const a = clamp(Math.min(clamped, other), 0, duration);
        const b = clamp(Math.max(clamped, other), 0, duration);
        if (a !== b) applySelection({ start: a, end: b });
      } else if (editingTimeField === 'selEnd') {
        const other = selection ? selection.start : currentTimeStore.get();
        const a = clamp(Math.min(clamped, other), 0, duration);
        const b = clamp(Math.max(clamped, other), 0, duration);
        if (a !== b) applySelection({ start: a, end: b });
      }
    }
    setEditingTimeField(null);
    setEditingTimeRaw('');
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 bg-slate-800 border-b border-slate-700 select-none z-40" data-help-target="playback-controls">
      {/* Transport controls: [Start] [PrevAnnot] [Play] [NextAnnot] [End] */}
      <div className="flex items-center gap-1" data-help-target="transport-buttons">
        <button
          onClick={() => { onSeek(0, true); onSelectionChange(null); onBoundAnnotationChange(null); }}
          disabled={!videoSrc}
          className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
          data-tooltip="Skip to start"
        >
          <SkipBack size={15} />
        </button>
        <button
          onClick={() => spectrogramRef.current?.goToPrevAnnotation()}
          disabled={!videoSrc || !canGoPrevAnnotation}
          className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
          data-tooltip="Previous annotation (Cmd+←  or  ;)"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          onClick={onPlay}
          disabled={!videoSrc}
          className="p-1.5 rounded-full bg-[#e65161] hover:bg-[#f06575] disabled:opacity-50 text-white transition-all shadow-lg flex-none mx-0.5"
        >
          <span className="flex items-center justify-center w-4 h-4">
            {isBuffering && !isPlaying
              ? <Loader2 size={16} className="animate-spin" />
              : isPlaying
                ? <Pause size={16} fill="currentColor" />
                : <Play size={16} fill="currentColor" />
            }
          </span>
        </button>
        <button
          onClick={() => spectrogramRef.current?.goToNextAnnotation()}
          disabled={!videoSrc || !canGoNextAnnotation}
          className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
          data-tooltip="Next annotation (Cmd+→  or  ')"
        >
          <ChevronRight size={15} />
        </button>
        <button
          onClick={() => { onSeek(duration, true); onSelectionChange(null); onBoundAnnotationChange(null); }}
          disabled={!videoSrc}
          className="p-1.5 rounded hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-white transition-colors flex-none"
          data-tooltip="Skip to end"
        >
          <SkipForward size={15} />
        </button>
      </div>

      {/* Volume Control */}
      <div
        ref={setVolumeControlEl}
        className="relative flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600 ml-1"
        data-help-target="volume-control"
        onContextMenu={onRestartAudio ? (e) => { e.preventDefault(); setVolumeCtxMenu({ x: e.clientX, y: e.clientY }); } : undefined}
      >
        <button onClick={() => setMuted(!muted)} className="text-slate-300 hover:text-white">
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <div className="relative w-20 h-5 flex items-center">
          <input
            type="range" min="0" max="1" step="0.005"
            value={gainToSlider(muted ? 0 : volume)}
            onChange={handleVolumeChange}
            onPointerUp={(e) => {
              const sliderVal = parseFloat((e.target as HTMLInputElement).value);
              if (Math.abs(sliderVal - 0.5) < 0.015) { setVolume(1.0); setMuted(false); }
            }}
            className={`w-full h-1 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${isBoosted ? '[&::-webkit-slider-thumb]:bg-red-500' : '[&::-webkit-slider-thumb]:bg-[#e65161]'}`}
            style={{
              background: isBoosted
                ? `linear-gradient(to right, #e65161 0%, #e65161 50%, #ef4444 50%, #ef4444 ${sliderPct}%, #64748b ${sliderPct}%, #64748b 100%)`
                : `linear-gradient(to right, #e65161 0%, #e65161 ${sliderPct}%, #64748b ${sliderPct}%, #64748b 100%)`
            }}
          />
          {/* Hash mark at center = gain 1.0 (50% of slider range) */}
          <div className="absolute top-0 bottom-0 w-[1px] bg-white/30 pointer-events-none" style={{ left: 'calc((100% - 12px) * 0.5 + 6px)' }}></div>
        </div>
      </div>

      {volumeCtxMenu && onRestartAudio && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setVolumeCtxMenu(null)} />
          <div
            className="fixed z-50 bg-slate-800 border border-slate-600 rounded shadow-lg py-1 min-w-[140px]"
            style={{ left: volumeCtxMenu.x, top: volumeCtxMenu.y }}
          >
            <button
              className="w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
              onClick={() => { setVolumeCtxMenu(null); onRestartAudio(); }}
            >
              Restart Audio
            </button>
          </div>
        </>
      )}

      {/* Time display — current time + selection fields to the right */}
      <div className="flex items-center gap-2 ml-2 tabular-nums" data-help-target="time-display">
        <div data-help-target="current-time">
          {editingTimeField === 'time' ? (
            <input
              autoFocus
              className="text-sm font-mono font-medium text-white bg-slate-700 border border-[#e65161] rounded-md px-2 py-1 w-[5rem] outline-none"
              value={editingTimeRaw}
              onChange={e => setEditingTimeRaw(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(''); }
              }}
              onBlur={() => commitTimeEdit(editingTimeRaw)}
            />
          ) : (
            <button
              className="flex items-center justify-end px-2 py-1 w-[5rem] bg-slate-700/50 rounded-md text-sm font-mono font-medium text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
              data-tooltip="Click to jump to time"
              onClick={() => { setEditingTimeField('time'); setEditingTimeRaw(currentTimeStore.get().toFixed(2)); }}
            >
              <TimeDisplay currentTimeStore={currentTimeStore} />
            </button>
          )}
        </div>

        <div className="w-px bg-slate-600/50 self-stretch my-0.5" />

        {/* Selection fields — always visible, blank when no selection active */}
        {(() => {
          const region = selection ?? { start: 0, end: 0 };
          const has = !!selection;
          // Allow editing when paused and no selection to create one from the playhead
          const canCreate = !has && !isPlaying;
          const fieldInput = (
            <input
              autoFocus
              className="text-xs font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1.5 h-5 w-[4.5rem] outline-none text-right"
              value={editingTimeRaw}
              onChange={e => setEditingTimeRaw(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitTimeEdit(editingTimeRaw); }
                if (e.key === 'Escape') { e.preventDefault(); setEditingTimeField(null); setEditingTimeRaw(''); }
              }}
              onBlur={() => commitTimeEdit(editingTimeRaw)}
            />
          );
          const renderField = (field: TimeField, display: string, label: string, editVal: string) => (
            <div key={field} className="flex items-center gap-1.5">
              {editingTimeField === field ? fieldInput : (
                <button
                  className={`text-xs font-mono px-1.5 h-5 w-[3.8rem] bg-slate-700/50 rounded text-center transition-colors ${has ? 'text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer' : canCreate ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/70 cursor-pointer' : 'text-slate-600 cursor-default'}`}
                  onClick={() => {
                    if (has) { setEditingTimeField(field); setEditingTimeRaw(editVal); }
                    else if (canCreate) { setEditingTimeField(field); setEditingTimeRaw(''); }
                  }}
                  data-tooltip={has ? `Edit selection ${label}` : canCreate ? `Set selection ${label}` : undefined}
                >
                  {has ? display : ''}
                </button>
              )}
              <span className="text-[10px] text-slate-500 select-none w-6">{label}</span>
            </div>
          );
          return (
            <div className="flex flex-col justify-center gap-0.5" data-help-target="selection-time">
              {renderField('selStart', region.start.toFixed(2), 'from', region.start.toFixed(2))}
              {renderField('selEnd', region.end.toFixed(2), 'to', region.end.toFixed(2))}
              {renderField('selDur', (region.end - region.start).toFixed(2), 'dur', (region.end - region.start).toFixed(2))}
            </div>
          );
        })()}
      </div>

      {/* Filter Tool Toggle (readiness for drawing a band — F).
          Active visual binds to filterToolActive only; band on/off lives on the
          adjacent toggle so a band can persist after the tool is unreadied. */}
      <button
        onClick={filterDisabledByMode ? undefined : onToggleFilterTool}
        disabled={filterDisabledByMode}
        className={`p-1.5 rounded transition-colors ml-2 ${filterDisabledByMode ? 'text-slate-600 cursor-not-allowed' : filterToolActive ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
        data-tooltip={filterDisabledByMode ? "Audio filters not available in Fast mode" : "Filter tool (Shift+F)"}
        data-help-target="filter-tool"
      >
        <Filter size={16} />
      </button>


      {/* Filter Strength — vertical slider, always visible */}
      <div
        ref={setFilterStrengthEl}
        className="flex items-center justify-center"
        style={{ width: 20, height: 64, flexShrink: 0 }}
        data-help-target="filter-strength"
      >
        <input
          type="range" min="0" max="1" step="0.005"
          value={displayStrength}
          disabled={filterDisabledByMode}
          onChange={filterDisabledByMode ? undefined : handleFilterStrengthChange}
          className={`appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${filterDisabledByMode ? 'cursor-not-allowed opacity-30 [&::-webkit-slider-thumb]:bg-slate-600' : filterEnabled ? 'cursor-pointer [&::-webkit-slider-thumb]:bg-[#e65161]' : 'cursor-pointer [&::-webkit-slider-thumb]:bg-slate-500'}`}
          style={{
            writingMode: 'vertical-lr',
            direction: 'rtl',
            width: 4,
            height: 60,
            background: filterDisabledByMode ? '#334155'
              : filterEnabled
              ? `linear-gradient(to top, #e65161 0%, #e65161 ${displayStrengthPct}%, #64748b ${displayStrengthPct}%, #64748b 100%)`
              : '#475569',
            borderRadius: 2,
          }}
        />
      </div>

      {/* Playback Speed — text entry */}
      <div
        ref={setSpeedControlEl}
        className="flex items-center gap-1.5 bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600 ml-2"
        data-help-target="playback-speed"
      >
        <button
          type="button"
          onClick={() => setPlaybackSpeed(playbackSpeed === 1 ? lastDefinedSpeed : 1)}
          className="flex-none p-0 leading-none"
          data-tooltip={playbackSpeed !== 1 ? "Click to reset to 1× (click text to set custom speed)" : "Click to restore last speed"}
        >
          <Gauge size={16} className={playbackSpeed > 1 ? 'text-red-400' : playbackSpeed < 1 ? 'text-blue-400' : 'text-slate-300'} />
        </button>
        {editingSpeed ? (
          <input
            autoFocus
            className="text-xs font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1.5 h-5 w-12 outline-none text-center tabular-nums"
            value={editingSpeedRaw}
            onChange={e => setEditingSpeedRaw(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitSpeedEdit(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditingSpeed(false); setEditingSpeedRaw(''); }
            }}
            onBlur={commitSpeedEdit}
          />
        ) : (
          <button
            className="text-xs font-mono text-slate-300 hover:text-white tabular-nums w-10 text-right"
            onClick={() => { setEditingSpeed(true); setEditingSpeedRaw(playbackSpeed.toFixed(2)); }}
            data-tooltip="Click to set playback speed"
          >
            {playbackSpeed.toFixed(2)}x
          </button>
        )}
      </div>

      {/* Right-aligned controls: buzzdetect toggle + spectrogram settings */}
      {(onToggleSettings !== undefined || buzzdetectAvailable) && (
        <div className="ml-auto flex items-center gap-1">
          {buzzdetectAvailable && (
            <button
              onClick={onToggleBuzzdetect}
              className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${buzzdetectEnabled ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
              data-tooltip="buzzdetect activations panel"
              data-help-target="buzzdetect-toggle"
            >
              <Activity size={16} />
            </button>
          )}
          {onToggleSettings !== undefined && (
            <button
              onClick={onToggleSettings}
              className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
              data-tooltip="Spectrogram Settings"
              data-help-target="spectrogram-settings"
            >
              <Settings size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Memoized so playback ticks (which now flow through the currentTime store, not
// props) don't re-render the whole toolbar — only the small TimeDisplay updates.
export default React.memo(Toolbar);
