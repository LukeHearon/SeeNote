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

  // Styled to sit flush with the canvas-drawn axis labels: same 10px sans-serif,
  // same right edge (7px inset), transparent until hovered/focused so it reads
  // as just another axis label that happens to be editable.
  const inputClass =
    'absolute left-0 right-0 h-4 bg-transparent text-white/80 text-right ' +
    'pr-[7px] font-sans text-[10px] leading-none border border-transparent rounded-sm ' +
    'outline-none hover:bg-slate-900/70 hover:border-slate-600 ' +
    'focus:bg-slate-900/90 focus:border-[#e65161] focus:text-white [appearance:textfield] ' +
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
        className={`${inputClass} top-0`}
        title="Highest frequency to plot (Hz)"
      />
      <input
        {...handlers('min')}
        value={draftMin}
        className={`${inputClass} bottom-0`}
        title="Lowest frequency to plot (Hz)"
      />
    </>
  );
}
