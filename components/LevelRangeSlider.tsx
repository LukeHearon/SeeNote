import React, { useEffect, useState } from 'react';

interface Props {
  /** dBFS lower display bound. */
  floor: number;
  /** dBFS upper display bound. */
  ceil: number;
  onChange: (next: { displayFloor: number; displayCeil: number }) => void;
  /** Optional section heading; omit to render just the control. */
  label?: string;
  /** Show the numeric floor/ceil text inputs below the slider. Default true. */
  showInputs?: boolean;
}

// dBFS display range covered by the slider track.
const MIN_DB = -160;
const MAX_DB = 40;
const SPAN = MAX_DB - MIN_DB; // 200

/**
 * Dual-thumb dBFS level-range control: two range inputs share one track with an
 * active-range fill, plus numeric text inputs that accept free typing and only
 * commit on blur/Enter. Extracted so the main spectrogram settings panel and
 * the example-clip library use the exact same control.
 *
 * Layering (bottom→top): base track → active-range fill → the two inputs (both
 * with transparent tracks so only their thumbs show on top of the fill).
 */
export default function LevelRangeSlider({ floor, ceil, onChange, label = 'Level Range (dBFS)', showInputs = true }: Props) {
  const [floorDraft, setFloorDraft] = useState(String(floor));
  const [ceilDraft, setCeilDraft] = useState(String(ceil));
  // Keep drafts in sync when the values change from outside (e.g. preset load).
  useEffect(() => { setFloorDraft(String(floor)); }, [floor]);
  useEffect(() => { setCeilDraft(String(ceil)); }, [ceil]);

  const commitFloor = (raw: string) => {
    const v = parseInt(raw);
    const clamped = isNaN(v) ? floor : Math.max(MIN_DB, Math.min(ceil - 1, v));
    onChange({ displayFloor: clamped, displayCeil: ceil });
    setFloorDraft(String(clamped));
  };
  const commitCeil = (raw: string) => {
    const v = parseInt(raw);
    const clamped = isNaN(v) ? ceil : Math.max(floor + 1, Math.min(MAX_DB, v));
    onChange({ displayFloor: floor, displayCeil: clamped });
    setCeilDraft(String(clamped));
  };

  const thumb = '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#e65161] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:pointer-events-auto';

  return (
    <div className="space-y-2">
      {label && (
        <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider pb-1 border-b border-slate-700">{label}</h4>
      )}
      <div className="relative h-5 flex items-center">
        <div className="absolute w-full h-1 rounded bg-slate-600 pointer-events-none" />
        <div
          className="absolute h-1 rounded bg-[#e65161] pointer-events-none"
          style={{
            left: `${((floor - MIN_DB) / SPAN) * 100}%`,
            width: `${((ceil - floor) / SPAN) * 100}%`,
          }}
        />
        <input
          type="range"
          min={MIN_DB} max={MAX_DB}
          value={floor}
          onChange={(e) => {
            const v = Math.min(parseInt(e.target.value), ceil - 1);
            onChange({ displayFloor: v, displayCeil: ceil });
            setFloorDraft(String(v));
          }}
          className={`absolute w-full appearance-none h-1 rounded bg-transparent pointer-events-none ${thumb}`}
        />
        <input
          type="range"
          min={MIN_DB} max={MAX_DB}
          value={ceil}
          onChange={(e) => {
            const v = Math.max(parseInt(e.target.value), floor + 1);
            onChange({ displayFloor: floor, displayCeil: v });
            setCeilDraft(String(v));
          }}
          className={`absolute w-full appearance-none h-1 rounded bg-transparent pointer-events-none ${thumb}`}
        />
      </div>
      {showInputs && (
        <div className="flex justify-between">
          <input
            type="text"
            inputMode="numeric"
            value={floorDraft}
            onChange={(e) => setFloorDraft(e.target.value)}
            onBlur={() => commitFloor(floorDraft)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-center focus:border-[#e65161] outline-none"
          />
          <input
            type="text"
            inputMode="numeric"
            value={ceilDraft}
            onChange={(e) => setCeilDraft(e.target.value)}
            onBlur={() => commitCeil(ceilDraft)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-xs text-center focus:border-[#e65161] outline-none"
          />
        </div>
      )}
    </div>
  );
}
