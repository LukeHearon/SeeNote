import React, { useEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { Pin, PinOff, Scissors, Trash2 } from 'lucide-react';
import { BuzzdetectSeriesMode } from '../types';
import DraftNumberInput from './DraftNumberInput';
import { tooltips } from '../copy/tooltips';
import { neuronPalette as copy } from '../copy/ui';

interface NeuronSettingsPopoverProps {
  neuron: string;
  color: string;
  threshold: number;
  /** null = this neuron isn't part of the subset at all. */
  subsetThreshold: number | null;
  seriesMode: BuzzdetectSeriesMode;
  isPinned: boolean;
  onColorChange: (color: string) => void;
  onThresholdChange: (value: number) => void;
  onSubsetThresholdChange: (value: number | null) => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const ROW = 'flex items-center gap-2';
const LABEL = 'flex-1 text-[10px] text-slate-400';
const NUMBER_FIELD = 'w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-right font-mono text-slate-200 outline-none focus:border-[#e65161]';

/**
 * Everything about ONE neuron, in one place: its color, the two thresholds,
 * whether it's pinned, and the way off the list.
 *
 * The palette row it hangs off keeps only what's worth comparing across every
 * neuron at a glance — name, color, the two thresholds — so this is where the
 * settings that are chosen once per neuron live rather than competing for
 * width in a row that has to stay readable at sidebar size.
 *
 * Deliberately the SAME surface for adding and for editing: a neuron just
 * added from the picker opens straight into this, so there's one place to
 * learn instead of an add-modal and a separate edit path that drift apart.
 *
 * Color is the pip beside the name, and clicking it opens a full picker. There
 * is no swatch row: a neuron's color has no meaning of its own to pick from a
 * fixed set — it exists to tell this line apart from the two beside it, so what
 * matters is being able to reach any color, not choosing among suggested ones.
 */
function NeuronSettingsPopover({
  neuron,
  color,
  threshold,
  subsetThreshold,
  seriesMode,
  isPinned,
  onColorChange,
  onThresholdChange,
  onSubsetThresholdChange,
  onTogglePin,
  onRemove,
  onClose,
}: NeuronSettingsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pickingColor, setPickingColor] = useState(false);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Escape backs out of the color picker first, if it's what's open — the
    // popover behind it is still the thing being worked in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pickingColor) setPickingColor(false);
      else onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, pickingColor]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1.5 z-30 w-52 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-2 space-y-2"
    >
      <div className="flex items-center gap-1.5 relative">
        <button
          onClick={() => setPickingColor(v => !v)}
          className={`w-3.5 h-3.5 rounded-full flex-none ring-1 transition-all ${pickingColor ? 'ring-white scale-110' : 'ring-white/25 hover:ring-white/60'}`}
          style={{ backgroundColor: color }}
          data-tooltip={tooltips.buzzdetectNeuronColor}
        />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-100">{neuron}</span>
        {pickingColor && (
          <div
            className="absolute left-0 top-full mt-2 z-10 border border-white/50 rounded-lg overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <HexColorPicker color={color} onChange={onColorChange} />
          </div>
        )}
      </div>

      <div className="border-t border-slate-700 pt-2 space-y-1.5">
        {/* Subset first: it's the field that decides what the track shows, and
            it's shown whether or not this neuron is currently being cut by —
            typing a value here IS how a neuron joins the subset, so a field
            that only appeared once it had joined would be unreachable. Blank
            means this neuron doesn't cut. */}
        <div className={ROW}>
          <span className={LABEL}>{copy.settingsSubsetThreshold}</span>
          {/* Detection-rate mode has no second threshold to set — the cut is
              judged at the detection threshold below and loosened by the min
              rate — so the field becomes a plain pick (see NeuronPalette). */}
          {seriesMode === 'detectionRate' ? (
            <button
              onClick={() => onSubsetThresholdChange(subsetThreshold === null ? threshold : null)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                subsetThreshold !== null ? 'bg-[#e65161]/15 text-[#e65161]' : 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
              }`}
              data-tooltip={tooltips.buzzdetectSubsetPick}
            >
              <Scissors size={10} />
              <span>{subsetThreshold !== null ? copy.settingsSubsetOn : copy.settingsSubsetOff}</span>
            </button>
          ) : (
            <DraftNumberInput
              value={subsetThreshold}
              onCommit={onSubsetThresholdChange}
              allowEmpty
              placeholder={copy.settingsSubsetOff}
              className={`${NUMBER_FIELD} border-[#e65161]/40 text-[#e65161] placeholder:text-[#e65161]/40`}
              tooltip={tooltips.buzzdetectSubsetThreshold}
            />
          )}
        </div>

        <div className={ROW}>
          <span className={LABEL}>{copy.settingsThreshold}</span>
          <DraftNumberInput
            value={threshold}
            onCommit={(v) => { if (v !== null) onThresholdChange(v); }}
            className={NUMBER_FIELD}
            tooltip={tooltips.buzzdetectThreshold}
          />
        </div>
      </div>

      <div className="border-t border-slate-700 pt-2 flex items-center gap-1">
        <button
          onClick={onTogglePin}
          className="flex-1 flex items-center justify-center gap-1 px-1 py-1 rounded text-[10px] text-slate-400 hover:bg-slate-700/60 hover:text-slate-200 transition-colors"
        >
          {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
          <span>{isPinned ? copy.menuUnpin : copy.menuPin}</span>
        </button>
        <button
          onClick={() => { onRemove(); onClose(); }}
          className="flex-1 flex items-center justify-center gap-1 px-1 py-1 rounded text-[10px] text-slate-400 hover:bg-[#e65161]/15 hover:text-[#e65161] transition-colors"
          data-tooltip={copy.removeTooltip}
        >
          <Trash2 size={11} />
          <span>{copy.settingsRemove}</span>
        </button>
      </div>
    </div>
  );
}

export default React.memo(NeuronSettingsPopover);
