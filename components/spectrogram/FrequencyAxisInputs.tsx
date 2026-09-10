import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { SpectrogramSettings } from '../../types';
import { clampFreqRange, formatFreqHz, parseFreqHz } from '../../utils/audioProcessing';

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

  // While a box is focused it holds a free-text draft; otherwise it shows the
  // formatted label derived from props.
  const [editing, setEditing] = useState<null | 'min' | 'max'>(null);
  const [draft, setDraft] = useState('');

  const valueOf = (edge: 'min' | 'max') => (edge === 'min' ? minFreq : maxFreq);
  const limitOf = (edge: 'min' | 'max') => (edge === 'min' ? 0 : nyquist);

  const display = (edge: 'min' | 'max') =>
    editing === edge ? draft : formatFreqHz(valueOf(edge));

  const apply = (edge: 'min' | 'max', typed: number) => {
    const next = clampFreqRange(
      edge === 'min' ? typed : minFreq,
      edge === 'max' ? typed : maxFreq,
      nyquist,
      edge,
    );
    if (next.minFreq !== minFreq || next.maxFreq !== maxFreq) onChange(next);
  };

  const inputClass =
    'w-full h-full bg-transparent text-white/80 text-right pr-[7px] pl-3 ' +
    'font-sans text-[10px] leading-none border border-transparent rounded-sm ' +
    'outline-none group-hover:bg-slate-900/70 group-hover:border-slate-600 ' +
    'focus:bg-slate-900/90 focus:border-[#e65161] focus:text-white';

  const box = (edge: 'min' | 'max', posClass: string) => (
    <div className={`group absolute left-0 right-0 h-4 ${posClass}`}>
      <input
        type="text"
        inputMode="decimal"
        value={display(edge)}
        onFocus={() => { setEditing(edge); setDraft(String(valueOf(edge))); }}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { apply(edge, parseFreqHz(draft)); setEditing(null); }}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setEditing(null); e.currentTarget.blur(); }
          e.stopPropagation();
        }}
        className={inputClass}
        title={edge === 'max'
          ? 'Highest frequency to plot — accepts 8000 or 8k'
          : 'Lowest frequency to plot — accepts 500 or 0.5k'}
      />
      {valueOf(edge) !== limitOf(edge) && (
        <button
          type="button"
          // onMouseDown so it fires before the input's blur.
          onMouseDown={e => { e.preventDefault(); apply(edge, limitOf(edge)); }}
          className="absolute left-0.5 top-1/2 -translate-y-1/2 hidden group-hover:block text-slate-400 hover:text-[#e65161]"
          title={edge === 'max' ? 'Reset to the Nyquist limit' : 'Reset to 0 Hz'}
        >
          <RotateCcw size={9} />
        </button>
      )}
    </div>
  );

  return (
    <>
      {box('max', 'top-0')}
      {box('min', 'bottom-0')}
    </>
  );
}
