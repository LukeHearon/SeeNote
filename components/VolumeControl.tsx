import React, { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { clamp } from '../utils/helpers';

// Nonlinear volume mapping: slider [0,1] → gain [0,4], with gain=1.0 at slider=0.5.
// Lower half [0,0.5] covers gain 0→1 (finer resolution for quieting);
// upper half [0.5,1] covers gain 1→4 (coarser resolution for boosting).
export const gainToSlider = (gain: number): number =>
  gain <= 1 ? gain / 2 : 0.5 + (gain - 1) / 6;
export const sliderToGain = (s: number): number =>
  s <= 0.5 ? s * 2 : 1 + (s - 0.5) * 6;

interface Props {
  /** Linear gain (1.0 = unity, up to 4.0). */
  volume: number;
  muted: boolean;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  /** Right-click handler (e.g. the main toolbar's "restart audio" menu). */
  onContextMenu?: (e: React.MouseEvent) => void;
  helpTarget?: string;
}

/**
 * The pill-shaped volume control used by the main annotation toolbar and the
 * example-clip library: a mute toggle + nonlinear slider (unity at center, red
 * thumb when boosted above unity) with scroll-to-adjust. Extracted so both
 * places stay visually and behaviourally identical.
 */
export default function VolumeControl({ volume, muted, setVolume, setMuted, onContextMenu, helpTarget }: Props) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // Scroll over the control to nudge volume (non-passive so we can preventDefault).
  useEffect(() => {
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = gainToSlider(mutedRef.current ? 0 : volumeRef.current);
      const delta = -Math.sign(e.deltaY) * 0.03;
      setVolume(sliderToGain(clamp(cur + delta, 0, 1)));
      setMuted(false);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [el]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(sliderToGain(parseFloat(e.target.value)));
    setMuted(false);
  };
  const sliderPct = gainToSlider(muted ? 0 : volume) * 100;
  const isBoosted = !muted && volume > 1;

  return (
    <div
      ref={setEl}
      className="relative flex items-center space-x-2 group bg-slate-700/50 rounded-full px-3 py-0.5 hover:bg-slate-700 transition-all border border-transparent hover:border-slate-600"
      data-help-target={helpTarget}
      onContextMenu={onContextMenu}
    >
      <button onClick={() => setMuted(!muted)} className="text-slate-300 hover:text-white">
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
      <div className="relative w-20 h-5 flex items-center">
        <input
          type="range" min="0" max="1" step="0.005"
          value={gainToSlider(muted ? 0 : volume)}
          onChange={handleChange}
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
        <div className="absolute top-0 bottom-0 w-[1px] bg-white/30 pointer-events-none" style={{ left: 'calc((100% - 12px) * 0.5 + 6px)' }} />
      </div>
    </div>
  );
}
