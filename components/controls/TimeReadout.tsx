import { useEffect, useState } from 'react';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import { clamp, formatTimeForUnit, TimeDisplayUnit } from '../../utils/helpers';
import { parseTimestamp } from '../../utils/timeAxis';
import { tooltips } from '../../copy/tooltips';

// Live playback-time readout. Subscribes to the currentTime store and holds its
// own state so it — and not its whole parent — re-renders per tick.
function LiveTime({ currentTimeStore, unit }: { currentTimeStore: CurrentTimeStore; unit: TimeDisplayUnit }) {
  const [t, setT] = useState(currentTimeStore.get());
  useEffect(() => {
    setT(currentTimeStore.get());
    return currentTimeStore.subscribe(() => setT(currentTimeStore.get()));
  }, [currentTimeStore]);
  return <>{formatTimeForUnit(t, unit)}</>;
}

export interface TimeReadoutProps {
  currentTimeStore: CurrentTimeStore;
  duration: number;
  unit: TimeDisplayUnit;
  onSeek: (time: number, scroll?: boolean) => void;
  onUnitChange: (unit: TimeDisplayUnit) => void;
}

/**
 * Running playhead time, click-to-type to jump, with the Seconds/HMS toggle
 * beneath it. Shared by the toolbar and the help guide's live copy of it.
 */
export function TimeReadout({ currentTimeStore, duration, unit, onSeek, onUnitChange }: TimeReadoutProps) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');

  // The box grows to fit long durations (e.g. >100,000s) instead of truncating —
  // width in ch matches the monospace readout, sized off the longest string the
  // box will ever need to show (time at full duration).
  const width = `${Math.max(formatTimeForUnit(duration || 0, unit).length + 3, 7)}ch`;

  const commit = () => {
    const parsed = parseTimestamp(raw);
    if (parsed !== null) onSeek(clamp(parsed, 0, duration), true);
    setEditing(false);
    setRaw('');
  };

  const unitButton = (value: TimeDisplayUnit, label: string, tooltip: string) => (
    <button
      className={`text-[9px] leading-none px-1.5 py-0.5 rounded transition-colors ${unit === value ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
      onClick={() => onUnitChange(value)}
      data-tooltip={tooltip}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-1" data-help-target="current-time">
      {editing ? (
        <input
          autoFocus
          className="text-sm font-mono font-medium text-white bg-slate-700 border border-[#e65161] rounded-md px-2 py-1 outline-none"
          style={{ width }}
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setRaw(''); }
          }}
          onBlur={commit}
        />
      ) : (
        <button
          className="flex items-center justify-end px-2 py-1 bg-slate-700/50 rounded-md text-sm font-mono font-medium text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
          style={{ width }}
          data-tooltip={tooltips.jumpToTime}
          onClick={() => { setEditing(true); setRaw(formatTimeForUnit(currentTimeStore.get(), unit)); }}
        >
          <LiveTime currentTimeStore={currentTimeStore} unit={unit} />
        </button>
      )}

      {/* Unit toggle — Seconds vs HMS, minimal highlight on the active side */}
      <div className="flex items-center gap-0.5" data-help-target="time-unit-toggle">
        {unitButton('seconds', 'Seconds', tooltips.timeUnitSeconds)}
        {unitButton('hms', 'HMS', tooltips.timeUnitHms)}
      </div>
    </div>
  );
}
