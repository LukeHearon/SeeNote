import React, { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';

// Rainbow gradient shared by the custom-color swatch fill and its active ring.
const RAINBOW_GRADIENT = 'linear-gradient(to right, #ef4444, #f97316, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7)';

interface Props {
  value: string;
  swatchColors: string[];
  onChange: (color: string) => void;
  customColorTitle?: string;
  // Swatch button side length in px.
  size?: number;
  // Which side of the custom-color swatch the hex-picker popup opens toward.
  popoverPosition?: 'top' | 'bottom';
}

/**
 * A row of fixed color swatches plus a rainbow "custom color" swatch that
 * pops open a full hex picker. Shared by anything that maps a label to a
 * color — annotation tools, buzzdetect neurons.
 */
export default function ColorSwatchPicker({ value, swatchColors, onChange, customColorTitle, size = 24, popoverPosition = 'top' }: Props) {
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Explicit rather than derived from `value`, so dragging the hex picker to a
  // shade that happens to match a fixed swatch doesn't visually snap away
  // from the "custom" selection mid-drag.
  const [customActive, setCustomActive] = useState(!swatchColors.includes(value));

  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPicker]);

  const sizeStyle = { width: size, height: size };

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {swatchColors.map(c => (
        <button
          key={c}
          onClick={() => { setCustomActive(false); onChange(c); }}
          className={`rounded cursor-pointer transition-all border-2 flex-none ${!customActive && value === c ? 'border-white scale-110' : 'border-transparent'}`}
          style={{ backgroundColor: c, ...sizeStyle }}
        />
      ))}
      <div ref={pickerRef} className="relative flex-none">
        {customActive ? (
          // Active: solid selected color inside a rainbow ring (the gradient
          // background shows through the padding around the inner swatch).
          <button
            onClick={() => { setCustomActive(true); setShowPicker(v => !v); }}
            className="rounded cursor-pointer transition-all scale-110 p-[2px]"
            style={{ background: RAINBOW_GRADIENT, ...sizeStyle }}
            title={customColorTitle}
          >
            <span className="block w-full h-full rounded-sm" style={{ backgroundColor: value }} />
          </button>
        ) : (
          // Inactive: plain rainbow fill, no outline.
          <button
            onClick={() => { setCustomActive(true); setShowPicker(v => !v); }}
            className="rounded cursor-pointer transition-all border-2 border-transparent"
            style={{ background: RAINBOW_GRADIENT, ...sizeStyle }}
            title={customColorTitle}
          />
        )}
        {showPicker && (
          <div
            className={`absolute ${popoverPosition === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'} left-1/2 -translate-x-1/2 z-10 border border-white/50 rounded-lg overflow-hidden`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HexColorPicker color={value} onChange={onChange} />
          </div>
        )}
      </div>
    </div>
  );
}
