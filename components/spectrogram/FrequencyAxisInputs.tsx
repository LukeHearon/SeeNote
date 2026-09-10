import React, { useEffect, useState } from 'react';
import { SpectrogramSettings } from '../../types';
import { clampFreqRange } from '../../utils/audioProcessing';

// Two number boxes docked on the frequency axis — max at the top of the scale,
// min at the bottom — so the value typed is read right where it takes effect.
// Replaces the min/max fields that used to live in the settings popover.
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

  // Local text state so a half-typed number ("1", "12") doesn't get clamped
  // mid-keystroke; committed on blur / Enter.
  const [draftMin, setDraftMin] = useState(String(minFreq));
  const [draftMax, setDraftMax] = useState(String(maxFreq));
  useEffect(() => { setDraftMin(String(minFreq)); }, [minFreq]);
  useEffect(() => { setDraftMax(String(maxFreq)); }, [maxFreq]);

  const commit = (edited: 'min' | 'max') => {
    const next = clampFreqRange(
      edited === 'min' ? parseFloat(draftMin) : minFreq,
      edited === 'max' ? parseFloat(draftMax) : maxFreq,
      nyquist,
      edited,
    );
    setDraftMin(String(next.minFreq));
    setDraftMax(String(next.maxFreq));
    if (next.minFreq !== minFreq || next.maxFreq !== maxFreq) onChange(next);
  };

  const inputClass =
    'absolute left-0.5 right-0.5 bg-slate-900/85 text-white text-right ' +
    'border border-slate-700 rounded px-1 py-px font-mono text-[10px] leading-tight ' +
    'outline-none focus:border-[#e65161] [appearance:textfield] ' +
    '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';

  const handlers = (edited: 'min' | 'max') => ({
    type: 'number' as const,
    min: 0,
    max: nyquist,
    step: 100,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      (edited === 'min' ? setDraftMin : setDraftMax)(e.target.value),
    onBlur: () => commit(edited),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') e.currentTarget.blur();
      if (e.key === 'Escape') {
        (edited === 'min' ? setDraftMin : setDraftMax)(String(edited === 'min' ? minFreq : maxFreq));
        e.currentTarget.blur();
      }
      e.stopPropagation();
    },
  });

  return (
    <>
      <input
        {...handlers('max')}
        value={draftMax}
        className={`${inputClass} top-0.5`}
        title="Highest frequency to plot (Hz)"
      />
      <input
        {...handlers('min')}
        value={draftMin}
        className={`${inputClass} bottom-0.5`}
        title="Lowest frequency to plot (Hz)"
      />
    </>
  );
}
