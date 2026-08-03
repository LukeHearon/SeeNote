import { useEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { clamp, speedToSlider, sliderToSpeed } from '../../utils/helpers';
import { tooltips } from '../../copy/tooltips';

export interface PlaybackSpeedControlProps {
  speed: number;
  /** The speed the gauge button restores when speed is 1.0x. */
  lastDefinedSpeed: number;
  /** Effective range — narrower in free-running video modes. */
  min: number;
  max: number;
  onSpeedChange: (speed: number) => void;
  onLastDefinedSpeedChange: (speed: number) => void;
}

/**
 * Speed readout with click-to-type and scroll-to-nudge, plus the gauge button
 * that toggles 1.0x against the last speed you chose.
 *
 * Shared by the toolbar and the help guide's live copy of it.
 */
export function PlaybackSpeedControl({
  speed,
  lastDefinedSpeed,
  min,
  max,
  onSpeedChange,
  onLastDefinedSpeedChange,
}: PlaybackSpeedControlProps) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');

  // Read live values inside the non-React wheel handler, which is attached once.
  const speedRef = useRef(speed);
  const rangeRef = useRef({ min, max });
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { rangeRef.current = { min, max }; }, [min, max]);

  const commit = (next: number) => {
    const clamped = clamp(next, min, max);
    onSpeedChange(clamped);
    if (clamped !== 1.0) onLastDefinedSpeedChange(clamped);
  };

  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = speedToSlider(speedRef.current);
      let slider = clamp(cur - Math.sign(e.deltaY) * 0.03, 0, 1);
      // Snap to exactly 1.0x when the wheel lands close to center.
      if (Math.abs(slider - 0.5) < 0.015) slider = 0.5;
      const { min: lo, max: hi } = rangeRef.current;
      const next = clamp(sliderToSpeed(slider), lo, hi);
      onSpeedChange(next);
      if (next !== 1.0) onLastDefinedSpeedChange(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  return (
    <div
      ref={setEl}
      className="flex items-center gap-1.5 bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600"
      data-help-target="playback-speed"
    >
      <button
        type="button"
        onClick={() => onSpeedChange(speed === 1 ? lastDefinedSpeed : 1)}
        className="flex-none p-0 leading-none"
        data-tooltip={speed !== 1 ? tooltips.resetSpeed : tooltips.restoreSpeed}
      >
        <Gauge size={16} className={speed > 1 ? 'text-red-400' : speed < 1 ? 'text-blue-400' : 'text-slate-300'} />
      </button>
      {editing ? (
        <input
          autoFocus
          className="text-xs font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1.5 h-5 w-12 outline-none text-center tabular-nums"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const parsed = parseFloat(raw.replace(/x$/i, '').trim());
              if (!isNaN(parsed)) commit(parsed);
              setEditing(false); setRaw('');
            }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setRaw(''); }
          }}
          onBlur={() => {
            const parsed = parseFloat(raw.replace(/x$/i, '').trim());
            if (!isNaN(parsed)) commit(parsed);
            setEditing(false); setRaw('');
          }}
        />
      ) : (
        <button
          className="text-xs font-mono text-slate-300 hover:text-white tabular-nums w-10 text-right"
          onClick={() => { setEditing(true); setRaw(speed.toFixed(2)); }}
          data-tooltip={tooltips.setSpeed}
        >
          {speed.toFixed(2)}x
        </button>
      )}
    </div>
  );
}
