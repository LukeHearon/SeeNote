import React, { useRef, useCallback, useEffect, useState } from 'react';
import { MAGMA_STOPS, interpolateMagmaHex } from '../constants';

interface Props {
  value: [string, string];
  onChange: (colors: [string, string]) => void;
}

// Build the CSS gradient string for the magma colormap bar.
const MAGMA_CSS = `linear-gradient(to right, ${MAGMA_STOPS.map(s => {
  const hex = `#${s.r.toString(16).padStart(2, '0')}${s.g.toString(16).padStart(2, '0')}${s.b.toString(16).padStart(2, '0')}`;
  return `${hex} ${s.pos * 100}%`;
}).join(', ')})`;

// Infer the closest magma t-value for a given hex color by scanning the colormap.
// Returns a float in [0, 1]. If the color is not on the magma gradient, returns 0.5.
function hexToMagmaT(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let bestT = 0;
  let bestDist = Infinity;
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ch = interpolateMagmaHex(t);
    const cr = parseInt(ch.slice(1, 3), 16);
    const cg = parseInt(ch.slice(3, 5), 16);
    const cb = parseInt(ch.slice(5, 7), 16);
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; bestT = t; }
  }
  return bestT;
}

export default function GradientPicker({ value, onChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [tStart, setTStart] = useState(() => hexToMagmaT(value[0]));
  const [tEnd, setTEnd] = useState(() => hexToMagmaT(value[1]));
  // Which handle is currently being dragged: 0 = start, 1 = end, null = none
  const draggingRef = useRef<0 | 1 | null>(null);
  // Color wheel input refs for the two handles
  const colorInput0Ref = useRef<HTMLInputElement>(null);
  const colorInput1Ref = useRef<HTMLInputElement>(null);
  // Track whether a handle's color is custom (not on the magma gradient)
  const [customColor0, setCustomColor0] = useState(value[0]);
  const [customColor1, setCustomColor1] = useState(value[1]);
  // Whether the color for each handle is custom (off the magma ramp)
  const [useCustom0, setUseCustom0] = useState(false);
  const [useCustom1, setUseCustom1] = useState(false);

  // Propagate to parent whenever tStart/tEnd or custom colors change
  useEffect(() => {
    const c0 = useCustom0 ? customColor0 : interpolateMagmaHex(tStart);
    const c1 = useCustom1 ? customColor1 : interpolateMagmaHex(tEnd);
    onChange([c0, c1]);
  }, [tStart, tEnd, useCustom0, useCustom1, customColor0, customColor1]);

  // Initialize t values from the incoming value prop on mount
  useEffect(() => {
    setTStart(hexToMagmaT(value[0]));
    setTEnd(hexToMagmaT(value[1]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tToPercent = (t: number) => `${(t * 100).toFixed(1)}%`;

  const getBarT = useCallback((clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handleBarMouseDown = useCallback((e: React.MouseEvent, handle: 0 | 1) => {
    e.preventDefault();
    draggingRef.current = handle;

    const onMove = (ev: MouseEvent) => {
      const t = getBarT(ev.clientX);
      if (handle === 0) { setTStart(t); setUseCustom0(false); }
      else { setTEnd(t); setUseCustom1(false); }
    };
    const onUp = () => {
      draggingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [getBarT]);

  const color0 = useCustom0 ? customColor0 : interpolateMagmaHex(tStart);
  const color1 = useCustom1 ? customColor1 : interpolateMagmaHex(tEnd);

  return (
    <div className="space-y-3">
      {/* Live preview of the selected gradient */}
      <div
        className="h-6 rounded-md"
        style={{ backgroundImage: `linear-gradient(to right, ${color0}, ${color1})` }}
      />

      {/* Magma ramp bar with draggable handles */}
      <div className="relative">
        <div
          ref={barRef}
          className="h-6 rounded-md cursor-crosshair"
          style={{ backgroundImage: MAGMA_CSS }}
        />
        {/* Start handle */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md cursor-grab active:cursor-grabbing ring-1 ring-black/50"
          style={{ left: tToPercent(tStart), backgroundColor: color0 }}
          onMouseDown={e => handleBarMouseDown(e, 0)}
          title="Drag to change start color"
        />
        {/* End handle */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md cursor-grab active:cursor-grabbing ring-1 ring-black/50"
          style={{ left: tToPercent(tEnd), backgroundColor: color1 }}
          onMouseDown={e => handleBarMouseDown(e, 1)}
          title="Drag to change end color"
        />
      </div>

      {/* Color wheel buttons */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 flex-1">
          <span className="text-gray-400 text-xs">Start</span>
          <div
            className="w-5 h-5 rounded-full border border-gray-600 cursor-pointer"
            style={{ backgroundColor: color0 }}
            title="Custom color for start"
            onClick={() => colorInput0Ref.current?.click()}
          />
          <input
            ref={colorInput0Ref}
            type="color"
            value={color0}
            onChange={e => { setCustomColor0(e.target.value); setUseCustom0(true); }}
            className="sr-only"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-1">
          <span className="text-gray-400 text-xs">End</span>
          <div
            className="w-5 h-5 rounded-full border border-gray-600 cursor-pointer"
            style={{ backgroundColor: color1 }}
            title="Custom color for end"
            onClick={() => colorInput1Ref.current?.click()}
          />
          <input
            ref={colorInput1Ref}
            type="color"
            value={color1}
            onChange={e => { setCustomColor1(e.target.value); setUseCustom1(true); }}
            className="sr-only"
          />
        </div>
        {(useCustom0 || useCustom1) && (
          <button
            type="button"
            onClick={() => { setUseCustom0(false); setUseCustom1(false); }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            title="Reset to magma gradient"
          >
            Reset to magma
          </button>
        )}
      </div>
    </div>
  );
}
