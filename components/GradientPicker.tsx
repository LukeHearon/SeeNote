import React, { useRef, useCallback, useEffect, useState } from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { MAGMA_MIN_T, interpolateMagmaHex } from '../constants';

interface Props {
  value: [string, string];
  onChange: (colors: [string, string]) => void;
  minT?: number;
}

// Squared-RGB distance above which a hex is considered a custom (non-magma) color.
const CUSTOM_COLOR_THRESHOLD = 150;

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// Infer the closest magma t-value for a given hex color by scanning the colormap.
function hexToMagmaT(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  let bestT = 0;
  let bestDist = Infinity;
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [cr, cg, cb] = hexToRgb(interpolateMagmaHex(t));
    const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (dist < bestDist) { bestDist = dist; bestT = t; }
  }
  return bestT;
}

// A hex round-trips through the magma colormap only if it sits on (or very near)
// the curve. If it's too far, the user picked a custom color we must preserve.
function detectCustom(hex: string): string | null {
  const [r, g, b] = hexToRgb(hex);
  const [cr, cg, cb] = hexToRgb(interpolateMagmaHex(hexToMagmaT(hex)));
  const dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
  return dist > CUSTOM_COLOR_THRESHOLD ? hex : null;
}

export default function GradientPicker({ value, onChange, minT = MAGMA_MIN_T }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const clamp = (t: number) => Math.max(minT, Math.min(1, t));
  const [tStart, setTStart] = useState(() => clamp(hexToMagmaT(value[0])));
  const [tEnd, setTEnd] = useState(() => clamp(hexToMagmaT(value[1])));
  // Per-handle custom-color overrides (null = derive color from the magma t).
  const [customStart, setCustomStart] = useState<string | null>(() => detectCustom(value[0]));
  const [customEnd, setCustomEnd] = useState<string | null>(() => detectCustom(value[1]));
  // Which handle's color popup is open (null = none).
  const [pickerHandle, setPickerHandle] = useState<0 | 1 | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  const color0 = customStart ?? interpolateMagmaHex(tStart);
  const color1 = customEnd ?? interpolateMagmaHex(tEnd);

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    onChange([color0, color1]);
  }, [tStart, tEnd, customStart, customEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map t∈[minT,1] to [0%,100%] of the bar width.
  const tToPercent = (t: number) => `${(((t - minT) / (1 - minT)) * 100).toFixed(1)}%`;

  // Map the pointer's horizontal fraction f∈[0,1] to t∈[minT,1].
  const getBarT = useCallback((clientX: number): number => {
    if (!barRef.current) return minT;
    const rect = barRef.current.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return minT + f * (1 - minT);
  }, [minT]);

  // CSS gradient showing only the [minT, 1] portion of the magma colormap.
  const barGradient = (() => {
    const samples = 12;
    const stops: string[] = [];
    for (let i = 0; i <= samples; i++) {
      const f = i / samples;
      const t = minT + f * (1 - minT);
      stops.push(`${interpolateMagmaHex(t)} ${(f * 100).toFixed(1)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  })();

  // Refs to track active drag listeners so we can remove them on unmount.
  const activeMoveRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const activeUpRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (activeMoveRef.current) window.removeEventListener('mousemove', activeMoveRef.current);
      if (activeUpRef.current) window.removeEventListener('mouseup', activeUpRef.current);
    };
  }, []);

  // Close the color popup on outside click.
  useEffect(() => {
    if (pickerHandle === null) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerHandle(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerHandle]);

  const handleBarMouseDown = useCallback((e: React.MouseEvent, handle: 0 | 1) => {
    e.preventDefault();
    // Dragging reverts a handle to its magma color at the dragged position.
    if (handle === 0) setCustomStart(null);
    else setCustomEnd(null);
    const onMove = (ev: MouseEvent) => {
      const t = getBarT(ev.clientX);
      if (handle === 0) setTStart(t);
      else setTEnd(t);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      activeMoveRef.current = null;
      activeUpRef.current = null;
    };
    activeMoveRef.current = onMove;
    activeUpRef.current = onUp;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [getBarT]);

  const handleContextMenu = useCallback((e: React.MouseEvent, handle: 0 | 1) => {
    e.preventDefault();
    e.stopPropagation();
    setPickerHandle(handle);
  }, []);

  const setCustom = (handle: 0 | 1, hex: string) => {
    if (handle === 0) setCustomStart(hex);
    else setCustomEnd(hex);
  };

  return (
    // py-1.5 gives the nodes (h-5 = 20px) room to extend 5px beyond the bar (h-2.5 = 10px) on each side
    <div className="relative py-1.5">
      <div
        ref={barRef}
        className="h-2.5 rounded-full cursor-crosshair"
        style={{ backgroundImage: barGradient }}
      />
      {/* Start handle — rightward chevron indicates gradient start */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center w-5 h-5 rounded border-2 border-white shadow-md cursor-grab active:cursor-grabbing ring-1 ring-black/50"
        style={{ left: tToPercent(tStart), backgroundColor: color0 }}
        onMouseDown={e => handleBarMouseDown(e, 0)}
        onContextMenu={e => handleContextMenu(e, 0)}
        data-tooltip="Drag to change start color · right-click for a custom color"
      >
        <ChevronRight size={10} strokeWidth={3} style={{ color: 'white', filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.7))' }} />
      </div>
      {/* End handle — leftward chevron indicates gradient end */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center w-5 h-5 rounded border-2 border-white shadow-md cursor-grab active:cursor-grabbing ring-1 ring-black/50"
        style={{ left: tToPercent(tEnd), backgroundColor: color1 }}
        onMouseDown={e => handleBarMouseDown(e, 1)}
        onContextMenu={e => handleContextMenu(e, 1)}
        data-tooltip="Drag to change end color · right-click for a custom color"
      >
        <ChevronLeft size={10} strokeWidth={3} style={{ color: 'white', filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.7))' }} />
      </div>
      {/* Custom-color popup, positioned near the right-clicked handle */}
      {pickerHandle !== null && (
        <div
          ref={pickerRef}
          className="absolute bottom-full mb-2 z-10 -translate-x-1/2 border border-white/50 rounded-lg overflow-hidden"
          style={{ left: tToPercent(pickerHandle === 0 ? tStart : tEnd) }}
        >
          <HexColorPicker
            color={pickerHandle === 0 ? color0 : color1}
            onChange={hex => setCustom(pickerHandle, hex)}
          />
        </div>
      )}
    </div>
  );
}
