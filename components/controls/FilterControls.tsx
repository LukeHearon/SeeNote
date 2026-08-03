import { useEffect, useRef, useState } from 'react';
import { Filter } from 'lucide-react';
import { clamp } from '../../utils/helpers';
import { tooltips } from '../../copy/tooltips';

export interface FilterToolButtonProps {
  /** Tool readiness — whether dragging on the spectrogram draws a band. */
  active: boolean;
  /** True in playback modes where filtering isn't possible (free-running video). */
  unavailable: boolean;
  onToggle: () => void;
}

/** Readies the band-drawing tool. Independent of whether a band is engaged. */
export function FilterToolButton({ active, unavailable, onToggle }: FilterToolButtonProps) {
  return (
    <button
      onClick={unavailable ? undefined : onToggle}
      disabled={unavailable}
      className={`p-1.5 rounded transition-colors ${unavailable ? 'text-slate-600 cursor-not-allowed' : active ? 'bg-slate-700 text-[#e65161]' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
      data-tooltip={unavailable ? tooltips.filterDisabledByMode : tooltips.filterTool}
      data-help-target="filter-tool"
    >
      <Filter size={16} />
    </button>
  );
}

export interface FilterStrengthSliderProps {
  /** Remembered strength, 0–1. Displayed as 0 while `enabled` is false. */
  strength: number;
  /** Whether a band is currently engaged. */
  enabled: boolean;
  unavailable: boolean;
  /** Strength moved while a band is engaged. Never called with 0. */
  onSetStrength: (strength: number) => void;
  /** Moved to 0 — turn filtering off, keeping the band for later. */
  onDisable: () => void;
  /** Moved up from 0 while off — engage at this strength, restoring the last band. */
  onEnable: (strength: number) => void;
}

/**
 * Vertical dry/wet slider for the band-pass filter. Bottom of the track means
 * "off", so dragging or wheeling off the bottom is what re-engages filtering —
 * the three outcomes are split across the three callbacks so the toolbar and
 * the help guide's live copy can't diverge on which one a gesture means.
 */
export function FilterStrengthSlider({
  strength,
  enabled,
  unavailable,
  onSetStrength,
  onDisable,
  onEnable,
}: FilterStrengthSliderProps) {
  // Read live values inside the non-React wheel handler, attached once.
  const stateRef = useRef({ strength, enabled });
  useEffect(() => { stateRef.current = { strength, enabled }; }, [strength, enabled]);

  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el || unavailable) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const { strength: cur, enabled: on } = stateRef.current;
      if (!on) {
        // Wheeling down on a disabled filter is a no-op; wheeling up engages it.
        if (Math.sign(e.deltaY) >= 0) return;
        const next = clamp(-Math.sign(e.deltaY) * 0.05, 0, 1);
        if (next > 0) onEnable(next);
        return;
      }
      const next = clamp(cur + Math.sign(e.deltaY) * 0.05, 0, 1);
      if (next === 0) onDisable();
      else onSetStrength(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, unavailable]);

  // Display 0 when disabled so the slider snaps to the bottom; `strength` is
  // still the remembered value that re-engaging restores.
  const shown = enabled ? clamp(strength, 0, 1) : 0;
  const pct = shown * 100;

  return (
    <div
      ref={setEl}
      className="flex items-center justify-center"
      style={{ width: 20, height: 64, flexShrink: 0 }}
      data-help-target="filter-strength"
      data-tooltip={tooltips.filterStrength}
    >
      <input
        type="range" min="0" max="1" step="0.005"
        value={shown}
        disabled={unavailable}
        onChange={unavailable ? undefined : e => {
          const v = parseFloat(e.target.value);
          if (v === 0) onDisable();
          else if (!enabled) onEnable(v);
          else onSetStrength(v);
        }}
        className={`appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full ${unavailable ? 'cursor-not-allowed opacity-30 [&::-webkit-slider-thumb]:bg-slate-600' : enabled ? 'cursor-pointer [&::-webkit-slider-thumb]:bg-[#e65161]' : 'cursor-pointer [&::-webkit-slider-thumb]:bg-slate-500'}`}
        style={{
          writingMode: 'vertical-lr',
          direction: 'rtl',
          width: 4,
          height: 60,
          background: unavailable ? '#334155'
            : enabled
            ? `linear-gradient(to top, #e65161 0%, #e65161 ${pct}%, #64748b ${pct}%, #64748b 100%)`
            : '#475569',
          borderRadius: 2,
        }}
      />
    </div>
  );
}
