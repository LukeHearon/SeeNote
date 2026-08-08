import React, { useEffect, useRef } from 'react';
import { Pin, PinOff, Scissors, Trash2 } from 'lucide-react';
import { BuzzdetectSeriesMode } from '../types';
import { BUZZDETECT_PALETTE, DEFAULT_BUZZDETECT_THRESHOLD } from '../constants';
import ColorSwatchPicker from './ColorSwatchPicker';
import DraftNumberInput from './DraftNumberInput';
import { tooltips } from '../copy/tooltips';
import { neuronPalette as copy } from '../copy/ui';

interface NeuronSettingsPopoverProps {
  neuron: string;
  color: string;
  threshold: number;
  /** null = follows `threshold`; the field shows that value as its placeholder. */
  subsetThreshold: number | null;
  isSubset: boolean;
  isPinned: boolean;
  seriesMode: BuzzdetectSeriesMode;
  onColorChange: (color: string) => void;
  onThresholdChange: (value: number) => void;
  onSubsetThresholdChange: (value: number | null) => void;
  onToggleSubset: () => void;
  onTogglePin: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const ROW = 'flex items-center gap-2';
const LABEL = 'flex-1 text-[10px] text-slate-400';
const NUMBER_FIELD = 'w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-right font-mono text-slate-200 outline-none focus:border-[#e65161]';

/**
 * Everything about ONE neuron, in one place: its color, the two thresholds,
 * whether it cuts the subset, whether it's pinned, and the way off the list.
 *
 * The palette row it hangs off keeps only what's worth comparing across every
 * neuron at a glance — name, color, detection threshold — so this is where the
 * settings that are chosen once per neuron live rather than competing for
 * width in a row that has to stay readable at sidebar size.
 *
 * Deliberately the SAME surface for adding and for editing: a neuron just
 * added from the picker opens straight into this, so there's one place to
 * learn instead of an add-modal and a separate edit path that drift apart.
 */
function NeuronSettingsPopover({
  neuron,
  color,
  threshold,
  subsetThreshold,
  isSubset,
  isPinned,
  seriesMode,
  onColorChange,
  onThresholdChange,
  onSubsetThresholdChange,
  onToggleSubset,
  onTogglePin,
  onRemove,
  onClose,
}: NeuronSettingsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1.5 z-30 w-52 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-2 space-y-2"
    >
      <div className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-full flex-none ring-1 ring-white/25" style={{ backgroundColor: color }} />
        <span className="flex-1 min-w-0 truncate text-[11px] text-slate-100">{neuron}</span>
      </div>

      <ColorSwatchPicker
        value={color}
        swatchColors={BUZZDETECT_PALETTE}
        onChange={onColorChange}
        customColorTitle={copy.customColorTitle}
        size={14}
        popoverPosition="bottom"
      />

      <div className="border-t border-slate-700 pt-2 space-y-1.5">
        <div className={ROW}>
          <span className={LABEL}>{copy.settingsThreshold}</span>
          <DraftNumberInput
            value={threshold}
            onCommit={(v) => { if (v !== null) onThresholdChange(v); }}
            className={NUMBER_FIELD}
            tooltip={tooltips.buzzdetectThreshold}
          />
        </div>

        <button
          onClick={onToggleSubset}
          className={`w-full flex items-center gap-2 px-1 py-1 rounded text-[10px] transition-colors ${
            isSubset ? 'bg-[#e65161]/15 text-[#e65161]' : 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
          }`}
          data-tooltip={tooltips.buzzdetectSubsetNeuron}
        >
          <Scissors size={11} className="flex-none" />
          <span className="flex-1 text-left">{isSubset ? copy.menuUnsubset : copy.menuSubset}</span>
        </button>

        {/* Only where it applies: on a neuron the subset is keyed to, in
            activation mode. Blank means it follows the detection threshold
            above — the placeholder names that value — so the field only holds
            a number once the two have deliberately been pulled apart. */}
        {isSubset && seriesMode === 'activation' && (
          <div className={ROW}>
            <span className={LABEL}>{copy.settingsSubsetThreshold}</span>
            <DraftNumberInput
              value={subsetThreshold}
              onCommit={onSubsetThresholdChange}
              allowEmpty
              placeholder={String(threshold ?? DEFAULT_BUZZDETECT_THRESHOLD)}
              className={`${NUMBER_FIELD} border-[#e65161]/40 text-[#e65161] placeholder:text-[#e65161]/40`}
              tooltip={tooltips.buzzdetectSubsetThreshold}
            />
          </div>
        )}
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
