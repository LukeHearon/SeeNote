import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, Volume2, VolumeX, Loader2, Settings, Gauge, Filter } from 'lucide-react';
import { Selection, BandPassFilter } from '../types';
import { SpectrogramHandle } from './Spectrogram';

type TimeField = 'time' | 'selStart' | 'selEnd' | 'selDur';

interface ToolbarProps {
  isPlaying: boolean;
  isBuffering: boolean;
  videoSrc: string | null;
  currentTime: number;
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
  showSettings?: boolean;
  onToggleSettings?: () => void;
  playbackSpeed: number;
  setPlaybackSpeed: (s: number) => void;
  filterToolActive: boolean;
  onToggleFilterTool: () => void;
  bandPassFilter: BandPassFilter | null;
  setBandPassFilter: (f: BandPassFilter | null) => void;
  bandPassFilterEnabled: boolean;
  setBandPassFilterEnabled: (v: boolean) => void;
  onDisableBandPassFilter: () => void;
  filterStrength: number;
  setFilterStrength: (s: number) => void;
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

export default function Toolbar({
  isPlaying,
  isBuffering,
  videoSrc,
  currentTime,
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
  showSettings,
  onToggleSettings,
  playbackSpeed,
  setPlaybackSpeed,
  filterToolActive,
  onToggleFilterTool,
  bandPassFilter,
  setBandPassFilter,
  bandPassFilterEnabled,
  setBandPassFilterEnabled,
  onDisableBandPassFilter,
  filterStrength,
  setFilterStrength,
}: ToolbarProps) {
  const [editingTimeField, setEditingTimeField] = useState<TimeField | null>(null);
  const [editingTimeRaw, setEditingTimeRaw] = useState('');

  // Refs for use in the non-React wheel event handler (attached once, reads live values)
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const speedRef = useRef(playbackSpeed);
  const filterStrengthRef = useRef(filterStrength);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { speedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { filterStrengthRef.current = filterStrength; }, [filterStrength]);

  const [volumeControlEl, setVolumeControlEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!volumeControlEl) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = gainToSlider(mutedRef.current ? 0 : volumeRef.current);
      const delta = -Math.sign(e.deltaY) * 0.03;
      const newSlider = Math.max(0, Math.min(1, cur + delta));
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
      let newSlider = Math.max(0, Math.min(1, cur + delta));
      if (Math.abs(newSlider - 0.5) < 0.015) newSlider = 0.5;
      setPlaybackSpeed(sliderToSpeed(newSlider));
    };
    speedControlEl.addEventListener('wheel', handler, { passive: false });
    return () => speedControlEl.removeEventListener('wheel', handler);
  }, [speedControlEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const [editingSpeed, setEditingSpeed] = useState(false);
  const [editingSpeedRaw, setEditingSpeedRaw] = useState('');

  const commitSpeedEdit = () => {
    const parsed = parseFloat(editingSpeedRaw.replace(/x$/i, '').trim());
    if (!isNaN(parsed)) setPlaybackSpeed(Math.max(SPEED_MIN, Math.min(SPEED_MAX, parsed)));
    setEditingSpeed(false);
    setEditingSpeedRaw('');
  };

  const [filterStrengthEl, setFilterStrengthEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!filterStrengthEl) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const next = Math.max(0, Math.min(1, filterStrengthRef.current + Math.sign(e.deltaY) * 0.05));
      setFilterStrength(next);
      if (bandPassFilter) setBandPassFilter({ ...bandPassFilter, strength: next });
    };
    filterStrengthEl.addEventListener('wheel', handler, { passive: false });
    return () => filterStrengthEl.removeEventListener('wheel', handler);
  }, [filterStrengthEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterStrengthPct = Math.max(0, Math.min(1, filterStrength)) * 100;
  const showFilterStrength = filterToolActive || bandPassFilter !== null;

  const handleFilterStrengthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setFilterStrength(v);
    if (bandPassFilter) setBandPassFilter({ ...bandPassFilter, strength: v });
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

    // selDur without selection: allow negative durations (playhead ± dur), handled before parseTimestamp
    if (editingTimeField === 'selDur' && !selection && !isPlaying) {
      const dur = parseFloat(raw.trim());
      if (!isNaN(dur)) {
        const a = Math.max(0, Math.min(duration, Math.min(currentTime, currentTime + dur)));
        const b = Math.max(0, Math.min(duration, Math.max(currentTime, currentTime + dur)));
        if (a !== b) onSelectionChange({ start: a, end: b });
      }
      setEditingTimeField(null);
      setEditingTimeRaw('');
      return;
    }

    const parsed = parseTimestamp(raw);
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(duration, parsed));
      if (editingTimeField === 'time') {
        onSeek(clamped, true);
      } else if (editingTimeField === 'selStart') {
        if (selection) {
          onSelectionChange({ start: clamped, end: Math.max(clamped, selection.end) });
        } else if (!isPlaying) {
          const a = Math.min(clamped, currentTime);
          const b = Math.max(clamped, currentTime);
          if (a !== b) onSelectionChange({ start: a, end: b });
        }
      } else if (editingTimeField === 'selEnd') {
        if (selection) {
          onSelectionChange({ start: selection.start, end: Math.max(selection.start, clamped) });
        } else if (!isPlaying) {
          const a = Math.min(clamped, currentTime);
          const b = Math.max(clamped, currentTime);
          if (a !== b) onSelectionChange({ start: a, end: b });
        }
      } else if (editingTimeField === 'selDur' && selection) {
        onSelectionChange({ start: selection.start, end: Math.min(duration, selection.start + Math.max(0, parsed)) });
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
      <div ref={setVolumeControlEl} className="flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600 ml-1" data-help-target="volume-control">
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
              onClick={() => { setEditingTimeField('time'); setEditingTimeRaw(currentTime.toFixed(2)); }}
            >
              {currentTime.toFixed(2)}s
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
        onClick={onToggleFilterTool}
        className={`p-1.5 rounded transition-colors ml-2 ${filterToolActive ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
        data-tooltip="Filter tool (F)"
        data-help-target="filter-tool"
      >
        <Filter size={16} />
      </button>

      {/* Band on/off toggle — visible only when a band exists. Click clears
          the band, disables filtering, and removes the `filterBand` stack
          entry. To re-engage filtering, draw a new band. */}
      {bandPassFilter !== null && bandPassFilterEnabled && (
        <button
          onClick={onDisableBandPassFilter}
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide transition-colors bg-[#e65161] text-white hover:bg-[#f06575]"
          data-tooltip="Disable filter (clears band)"
          data-help-target="filter-onoff"
        >
          On
        </button>
      )}

      {/* Filter Strength — vertical slider, fixed height matching toolbar */}
      {showFilterStrength && (
        <div
          ref={setFilterStrengthEl}
          className="flex items-center justify-center"
          style={{ width: 20, height: 64, flexShrink: 0 }}
          data-help-target="filter-strength"
        >
          <input
            type="range" min="0" max="1" step="0.005"
            value={filterStrength}
            onChange={handleFilterStrengthChange}
            className="appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#e65161]"
            style={{
              writingMode: 'vertical-lr',
              direction: 'rtl',
              width: 4,
              height: 60,
              background: `linear-gradient(to top, #e65161 0%, #e65161 ${filterStrengthPct}%, #64748b ${filterStrengthPct}%, #64748b 100%)`,
              borderRadius: 2,
            }}
          />
        </div>
      )}

      {/* Playback Speed — text entry */}
      <div
        ref={setSpeedControlEl}
        className="flex items-center gap-1.5 bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600 ml-2"
        data-help-target="playback-speed"
      >
        <Gauge size={16} className="text-slate-300 flex-none" />
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

      {/* Spectrogram Settings */}
      {onToggleSettings !== undefined && (
        <div className="ml-auto flex items-center">
          <button
            onClick={onToggleSettings}
            className={`p-1.5 rounded hover:bg-slate-700 transition-colors ${showSettings ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white'}`}
            data-tooltip="Spectrogram Settings"
            data-help-target="spectrogram-settings"
          >
            <Settings size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
