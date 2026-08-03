import { useState } from 'react';
import { Selection } from '../../types';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import { clamp } from '../../utils/helpers';
import { parseHMS, parseTimestamp } from '../../utils/timeAxis';
import { tooltips } from '../../copy/tooltips';

type Field = 'selStart' | 'selEnd' | 'selDur';

export interface SelectionTimeFieldsProps {
  selection: Selection | null;
  isPlaying: boolean;
  duration: number;
  currentTimeStore: CurrentTimeStore;
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
  onApply,
}: SelectionTimeFieldsProps) {
  const [editing, setEditing] = useState<Field | null>(null);
  const [raw, setRaw] = useState('');

  const region = selection ?? { start: 0, end: 0 };
  const has = !!selection;
  // Allow editing when paused and no selection, to create one from the playhead.
  const canCreate = !has && !isPlaying;

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
      const parsed = parseTimestamp(raw);
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
      className="text-xs font-mono text-white bg-slate-700 border border-[#e65161] rounded px-1.5 h-5 w-[4.5rem] outline-none text-right"
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
          className={`text-xs font-mono px-1.5 h-5 w-[3.8rem] bg-slate-700/50 rounded text-center transition-colors ${has ? 'text-slate-300 hover:text-white hover:bg-slate-700 cursor-pointer' : canCreate ? 'text-slate-500 hover:text-slate-300 hover:bg-slate-700/70 cursor-pointer' : 'text-slate-600 cursor-default'}`}
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
      {renderField('selStart', region.start.toFixed(2), 'from')}
      {renderField('selEnd', region.end.toFixed(2), 'to')}
      {renderField('selDur', (region.end - region.start).toFixed(2), 'dur')}
    </div>
  );
}
