import React from 'react';
import { RotateCcw } from 'lucide-react';
import { SpectrogramSettings } from '../../types';
import { clampFreqRange, formatFreqHz, parseFreqHz } from '../../utils/audioProcessing';
import { useDraftField } from '../../hooks/useDraftField';
import { frequencyAxisInputs as copy } from '../../copy/ui';

// Two number boxes docked on the frequency axis — max at the top of the scale,
// min at the bottom — so the value typed is read right where it takes effect.
// Replaces the min/max fields that used to live in the settings popover.
//
// Idle, each box shows the same label the axis ticks use ("6k", "5.5k", "800").
// Focused, it shows the raw Hz for editing and accepts either form on the way
// back in: "8000" or "8k". A reset arrow appears on hover once the edge is off
// its limit (0 Hz for min, nyquist for max).
export default function FrequencyAxisInputs({
  minFreq,
  maxFreq,
  sampleRate,
  onChange,
}: {
  minFreq: number;
  maxFreq: number;
  /** Current track's sample rate; its nyquist is the hard ceiling. */
  sampleRate: number;
  onChange: (patch: Partial<SpectrogramSettings>) => void;
}) {
  const nyquist = Math.floor(sampleRate / 2);

  const valueOf = (edge: 'min' | 'max') => (edge === 'min' ? minFreq : maxFreq);
  const limitOf = (edge: 'min' | 'max') => (edge === 'min' ? 0 : nyquist);

  // While a box is focused it holds a free-text draft; otherwise it shows the
  // formatted label derived from props.
  const draft = useDraftField<'min' | 'max'>((edge, raw) => apply(edge, parseFreqHz(raw)), { stopPropagation: true });

  const display = (edge: 'min' | 'max') =>
    draft.editing === edge ? draft.raw : formatFreqHz(valueOf(edge));

  const apply = (edge: 'min' | 'max', typed: number) => {
    const next = clampFreqRange(
      edge === 'min' ? typed : minFreq,
      edge === 'max' ? typed : maxFreq,
      nyquist,
      edge,
    );
    if (next.minFreq !== minFreq || next.maxFreq !== maxFreq) onChange(next);
  };

  const wrapClass =
    'group absolute left-0 right-0 h-4 flex items-center rounded-sm ' +
    'border border-slate-500/40 group-hover:bg-slate-900/70 group-hover:border-slate-600 ' +
    'focus-within:bg-slate-900/90 focus-within:border-[#e65161]';

  const box = (edge: 'min' | 'max', posClass: string) => (
    <div className={`${wrapClass} ${posClass}`}>
      <button
        type="button"
        // onMouseDown so it fires before the input's blur.
        onMouseDown={e => { e.preventDefault(); apply(edge, limitOf(edge)); }}
        className={`shrink-0 pl-0.5 text-slate-400 hover:text-[#e65161] ${
          valueOf(edge) !== limitOf(edge) ? 'hidden group-hover:flex' : 'hidden'
        }`}
        title={edge === 'max' ? copy.resetMax : copy.resetMin}
      >
        <RotateCcw size={9} />
      </button>
      <input
        type="text"
        inputMode="decimal"
        value={display(edge)}
        onFocus={() => draft.begin(edge, String(valueOf(edge)))}
        {...draft.fieldProps()}
        className="flex-1 min-w-0 bg-transparent text-white/80 text-right pr-[7px] font-sans text-[10px] leading-none border-0 outline-none focus:text-white"
        title={edge === 'max' ? copy.maxTitle : copy.minTitle}
      />
    </div>
  );

  return (
    <>
      {box('max', 'top-0')}
      {box('min', 'bottom-0')}
    </>
  );
}
