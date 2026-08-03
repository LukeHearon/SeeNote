import { useEffect, useMemo, useState } from 'react';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import { clamp, formatTimeForUnit, TimeDisplayUnit } from '../../utils/helpers';
import { maxDateTimeLength, DateTimeFormat } from '../../utils/datetimeDisplay';
import { parseTimestamp } from '../../utils/timeAxis';
import { Timeline, identityTimeline, displayOfNearestKept } from '../../utils/subsetTimeline';
import { tooltips } from '../../copy/tooltips';

// Live playback-time readout. Subscribes to the currentTime store and holds its
// own state so it — and not its whole parent — re-renders per tick.
// The store is in display time; the readout is in source time, because a time
// the user might write down or search for has to be a position in the file.
function LiveTime({ currentTimeStore, unit, trackStartDate, dateTimeFormat, timeline }: {
  currentTimeStore: CurrentTimeStore;
  unit: TimeDisplayUnit;
  trackStartDate: Date | null;
  dateTimeFormat: DateTimeFormat;
  timeline: Timeline;
}) {
  const [t, setT] = useState(currentTimeStore.get());
  useEffect(() => {
    setT(currentTimeStore.get());
    return currentTimeStore.subscribe(() => setT(currentTimeStore.get()));
  }, [currentTimeStore]);
  return <>{formatTimeForUnit(timeline.toSource(t), unit, 2, trackStartDate, dateTimeFormat)}</>;
}

export interface TimeReadoutProps {
  currentTimeStore: CurrentTimeStore;
  duration: number;
  /** The unit actually in force — already resolved through effectiveTimeUnit. */
  unit: TimeDisplayUnit;
  /** The unit the user picked, which may be 'datetime' on a track that can't
   *  show it; the Date button stays lit so the choice isn't silently lost. */
  selectedUnit?: TimeDisplayUnit;
  /** Wall-clock start of the track; null when its filename carries no
   *  parseable timestamp, which disables the Date button. */
  trackStartDate?: Date | null;
  dateTimeFormat?: DateTimeFormat;
  /** The display↔source map. The readout is read and written in SOURCE time,
   *  while onSeek still speaks display time, so the conversion happens here at
   *  the edge. Identity (or omitted) when no subset is on. */
  timeline?: Timeline;
  onSeek: (time: number, scroll?: boolean) => void;
  onUnitChange: (unit: TimeDisplayUnit) => void;
}

/**
 * Running playhead time, click-to-type to jump, with the Seconds/HMS/Date
 * toggle beneath it. Shared by the toolbar and the help guide's live copy of it.
 */
export function TimeReadout({
  currentTimeStore,
  duration,
  unit,
  selectedUnit = unit,
  trackStartDate = null,
  dateTimeFormat = 'iso',
  timeline,
  onSeek,
  onUnitChange,
}: TimeReadoutProps) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');

  // Memoised in the identity case so it isn't a fresh object per render.
  const fallbackTimeline = useMemo(() => identityTimeline(duration), [duration]);
  const tl = timeline ?? fallbackTimeline;

  const datetimeMode = unit === 'datetime' && trackStartDate !== null;

  // The box grows to fit long durations (e.g. >100,000s) instead of truncating —
  // width in ch matches the monospace readout. In datetime mode it's sized off
  // the longest string the format could ever produce (a specific instant's
  // length isn't a safe upper bound — month names vary), otherwise off the
  // reading at full duration.
  // Sized off the longest SOURCE time it can show — under a subset that's the
  // whole file's duration, not the shortened axis's.
  const width = datetimeMode
    ? `${maxDateTimeLength(dateTimeFormat) + 3}ch`
    : `${Math.max(formatTimeForUnit(tl.sourceDuration || 0, unit, 2, trackStartDate, dateTimeFormat).length + 3, 7)}ch`;

  // A typed time is a source time. One that was cut out of the subset has no
  // position on the axis, so it goes to the nearest kept one — the same answer
  // clicking there gives.
  const commit = () => {
    const parsed = parseTimestamp(raw, datetimeMode ? { start: trackStartDate!, duration: tl.sourceDuration } : null);
    if (parsed !== null) onSeek(clamp(displayOfNearestKept(tl, parsed), 0, duration), true);
    setEditing(false);
    setRaw('');
  };

  // Seconds/HMS key off the effective unit, so a 'datetime' choice that a
  // startless track can't honour still lights the unit actually being shown;
  // Date keys off the choice itself, so it stays lit where it is honoured.
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
          onClick={() => { setEditing(true); setRaw(formatTimeForUnit(tl.toSource(currentTimeStore.get()), unit, 2, trackStartDate, dateTimeFormat)); }}
        >
          <LiveTime currentTimeStore={currentTimeStore} unit={unit} trackStartDate={trackStartDate} dateTimeFormat={dateTimeFormat} timeline={tl} />
        </button>
      )}

      {/* Unit toggle — Seconds vs HMS vs wall-clock Date, minimal highlight on
          the active side. Date is inert on a track with no parseable start. */}
      <div className="flex items-center gap-0.5" data-help-target="time-unit-toggle">
        {unitButton('seconds', 'Seconds', tooltips.timeUnitSeconds)}
        {unitButton('hms', 'HMS', tooltips.timeUnitHms)}
        <button
          disabled={!trackStartDate}
          className={`text-[9px] leading-none px-1.5 py-0.5 rounded transition-colors ${!trackStartDate ? 'text-slate-700 cursor-default' : selectedUnit === 'datetime' ? 'bg-slate-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
          onClick={() => onUnitChange('datetime')}
          data-tooltip={trackStartDate ? tooltips.timeUnitDatetime : tooltips.timeUnitDatetimeUnavailable}
        >
          Date
        </button>
      </div>
    </div>
  );
}
