import React, { useRef, useCallback, useEffect, useState } from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import { MAGMA_STOPS, interpolateMagmaHex } from '../constants';

interface Props {
  value: [string, string];
  onChange: (colors: [string, string]) => void;
  minT?: number;
}

// Build the CSS gradient string for the magma colormap bar.
const MAGMA_CSS = `linear-gradient(to right, ${MAGMA_STOPS.map(s => {
  const hex = `#${s.r.toString(16).padStart(2, '0')}${s.g.toString(16).padStart(2, '0')}${s.b.toString(16).padStart(2, '0')}`;
  return `${hex} ${s.pos * 100}%`;
}).join(', ')})`;

// Infer the closest magma t-value for a given hex color by scanning the colormap.
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

export default function GradientPicker({ value, onChange, minT = 0 }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [tStart, setTStart] = useState(() => Math.max(minT, hexToMagmaT(value[0])));
  const [tEnd, setTEnd] = useState(() => hexToMagmaT(value[1]));
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    onChange([interpolateMagmaHex(tStart), interpolateMagmaHex(tEnd)]);
  }, [tStart, tEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  const tToPercent = (t: number) => `${(t * 100).toFixed(1)}%`;

  const getBarT = useCallback((clientX: number): number => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  // Refs to track active drag listeners so we can remove them on unmount.
  const activeMoveRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const activeUpRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (activeMoveRef.current) window.removeEventListener('mousemove', activeMoveRef.current);
      if (activeUpRef.current) window.removeEventListener('mouseup', activeUpRef.current);
    };
  }, []);

  const handleBarMouseDown = useCallback((e: React.MouseEvent, handle: 0 | 1) => {
    e.preventDefault();
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

  const color0 = interpolateMagmaHex(tStart);
  const color1 = interpolateMagmaHex(tEnd);

  return (
    // py-1.5 gives the nodes (h-5 = 20px) room to extend 5px beyond the bar (h-2.5 = 10px) on each side
    <div className="relative py-1.5">
      <div
        ref={barRef}
        className="h-2.5 rounded-full cursor-crosshair"
        style={{ backgroundImage: MAGMA_CSS }}
      />
      {/* Start handle — rightward chevron indicates gradient start */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center w-5 h-5 rounded border-2 border-white shadow-md cursor-grab active:cursor-grabbing ring-1 ring-black/50"
        style={{ left: tToPercent(tStart), backgroundColor: color0 }}
        onMouseDown={e => handleBarMouseDown(e, 0)}
        data-tooltip="Drag to change start color"
      >
        <ChevronRight size={10} strokeWidth={3} style={{ color: 'white', filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.7))' }} />
      </div>
      {/* End handle — leftward chevron indicates gradient end */}
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center w-5 h-5 rounded border-2 border-white shadow-md cursor-grab active:cursor-grabbing ring-1 ring-black/50"
        style={{ left: tToPercent(tEnd), backgroundColor: color1 }}
        onMouseDown={e => handleBarMouseDown(e, 1)}
        data-tooltip="Drag to change end color"
      >
        <ChevronLeft size={10} strokeWidth={3} style={{ color: 'white', filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.7))' }} />
      </div>
    </div>
  );
}
