import { useState } from 'react';
import { Selection } from '../../types';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import { clamp, formatTime, TimeDisplayUnit } from '../../utils/helpers';
import { formatDateTime, maxDateTimeLength, DateTimeFormat } from '../../utils/datetimeDisplay';
import { parseHMS, parseTimestamp } from '../../utils/timeAxis';
import { tooltips } from '../../copy/tooltips';

type Field = 'selStart' | 'selEnd' | 'selDur';

export interface SelectionTimeFieldsProps {
  selection: Selection | null;
  isPlaying: boolean;
  duration: number;
  currentTimeStore: CurrentTimeStore;
  /** Display unit for the bounds — already resolved through effectiveTimeUnit. */
  unit?: TimeDisplayUnit;
  /** Wall-clock start of the track; null when its filename carries no
   *  parseable timestamp, which keeps the fields in elapsed time. */
  trackStartDate?: Date | null;
  dateTimeFormat?: DateTimeFormat;
  /** Apply an edited selection. Called only with a non-empty region. */
  onApply: (selection: Selection) => void;
}

/**
 * The from / to / dur trio beside the running time. Always visible, blank when
 * no selection is active; when paused with no selection, typing into a field
 * creates one anchored at the playhead.
 *
 * Shared by the toolbar and the help guide's live copy of it.
 */
export function SelectionTimeFields({
  selection,
  isPlaying,
  duration,
  currentTimeStore,
  unit = 'seconds',
  trackStartDate = null,
  dateTimeFormat = 'iso',
  onApply,
}: SelectionTimeFieldsProps) {
  const [editing, setEditing] = useState<Field | null>(null);
  const [raw, setRaw] = useState('');

  const region = selection ?? { start: 0, end: 0 };
  const has = !!selection;
  // Allow editing when paused and no selection, to create one from the playhead.
  const canCreate = !has && !isPlaying;

  const datetimeMode = unit === 'datetime' && trackStartDate !== null;

  // Bounds follow the display unit; duration is an interval (there's no
  // datetime equivalent of one), so Date mode falls back to a plain
  // elapsed-seconds reading, while HMS formats it the same way as from/to.
  const formatBound = (t: number): string => {
    if (datetimeMode) return formatDateTime(trackStartDate!, t, 2, dateTimeFormat);
    if (unit === 'hms') return formatTime(t, 2);
    return t.toFixed(2);
  };
  const formatDur = (d: number): string => {
    if (unit === 'hms') return formatTime(d, 2);
    if (unit === 'datetime') return `${d.toFixed(2)}s`;
    return d.toFixed(2);
  };

  // Datetime bounds need more room than the elapsed-seconds readout the fields
  // were sized for. Width is the longest string the format could ever produce,
  // not what today's selection happens to need — an actual instant's length
  // would let a longer month name wrap onto a second line.
  const maxBoundLength = datetimeMode
    ? maxDateTimeLength(dateTimeFormat)
    : unit === 'hms' ? formatTime(duration || 0, 2).length : 0;
  const fieldWidth = maxBoundLength ? `${maxBoundLength + 1}ch` : '3.8rem';
  const inputWidth = maxBoundLength ? `${maxBoundLength + 2}ch` : '4.5rem';

  const apply = (a: number, b: number) => {
    const lo = clamp(Math.min(a, b), 0, duration);
    const hi = clamp(Math.max(a, b), 0, duration);
    if (lo !== hi) onApply({ start: lo, end: hi });
  };

  const commit = () => {
    if (!editing) return;

    // selDur accepts negative values (the anchor is always selection.start /
    // the playhead), so it can't go through parseTimestamp, which rejects them.
    if (editing === 'selDur') {
      const trimmed = raw.trim();
      const dur = parseHMS(trimmed) ?? parseFloat(trimmed);
      if (!isNaN(dur)) {
        const anchor = selection ? selection.start : (!isPlaying ? currentTimeStore.get() : null);
        if (anchor !== null) apply(anchor, anchor + dur);
      }
    } else {
      const parsed = parseTimestamp(raw, datetimeMode ? { start: trackStartDate!, duration } : null);
      if (parsed !== null) {
        const clamped = clamp(parsed, 0, duration);
        const other = editing === 'selStart'
          ? (selection ? selection.end : currentTimeStore.get())
          : (selection ? selection.start : currentTimeStore.get());
        apply(clamped, other);
      }
    }
    setEditing(null);
    setRaw('');
  };

  const input = (
    <input
      autoFocus
      className="text-xs font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1.5 h-5 outline-none text-right"
      style={{ width: inputWidth }}
      value={raw}
      onChange={e => setRaw(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(null); setRaw(''); }
      }}
      onBlur={commit}
    />
  );

  const renderField = (field: Field, display: string, label: string) => (
    <div key={field} className="flex items-center gap-1.5">
      {editing === field ? input : (
        <button
          style={{ width: fieldWidth }}
          className={`text-xs font-mono px-1.5 h-5 bg-slate-700/50 rounded text-center whitespace-nowrap transition-colors ${has ? 'text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer' : canCreate ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/70 cursor-pointer' : 'text-slate-600 cursor-default'}`}
          onClick={() => {
            if (has) { setEditing(field); setRaw(display); }
            else if (canCreate) { setEditing(field); setRaw(''); }
          }}
          data-tooltip={has ? tooltips.editSelection(label) : canCreate ? tooltips.setSelection(label) : undefined}
        >
          {has ? display : ''}
        </button>
      )}
      <span className="text-[10px] text-slate-500 select-none w-6">{label}</span>
    </div>
  );

  return (
    <div className="flex flex-col justify-center gap-0.5" data-help-target="selection-time">
      {renderField('selStart', formatBound(region.start), 'from')}
      {renderField('selEnd', formatBound(region.end), 'to')}
      {renderField('selDur', formatDur(region.end - region.start), 'dur')}
    </div>
  );
}
