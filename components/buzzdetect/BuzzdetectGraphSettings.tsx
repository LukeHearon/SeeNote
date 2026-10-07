import { RotateCcw, X } from 'lucide-react';
import type { BuzzdetectData, BuzzdetectSeriesMode } from '../../types';
import type { SubsetStats } from '../../utils/buzzdetectStats';
import { clamp, formatTime } from '../../utils/helpers';
import DraftNumberInput from '../DraftNumberInput';
import { tooltips } from '../../copy/tooltips';
import { neuronPalette as copy } from '../../copy/ui';

const FIELD_CLASS = 'w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-slate-200 outline-none focus:border-[#e65161]';

export interface BuzzdetectGraphSettingsProps {
  data: BuzzdetectData;
  seriesMode: BuzzdetectSeriesMode;
  binWidthOverride: number | null;
  /** Bin width / Y-range the graph picked for itself, shown when nothing is pinned. */
  autoBinWidth: number;
  autoYRange: { min: number; max: number } | null;
  yAxisOverride: { min: number; max: number } | null;
  minDetectionRate: number;
  /** Every neuron with a Subset at value, and the ones of those this file has a column for. */
  subsetNeurons: string[];
  cuttingNeurons: string[];
  subsetBuffer: number;
  /** What the current subset came to, or null when nothing is subset. */
  subsetStats: SubsetStats | null;
  /** Layout classes for the block's container; where it sits is the caller's business. */
  className?: string;
  onSeriesModeChange: (mode: BuzzdetectSeriesMode) => void;
  onBinWidthOverrideChange: (binWidth: number | null) => void;
  onYAxisOverrideChange: (range: { min: number; max: number } | null) => void;
  onMinDetectionRateChange: (rate: number) => void;
  onSubsetThresholdChange: (neuron: string, value: number | null) => void;
  onSubsetBufferChange: (seconds: number) => void;
}

/**
 * The buzzdetect graph-wide settings: series, bin width, Y range and the subset
 * controls. Lives in the neuron palette, or — while the results panel is popped
 * out — in the popout beside the graph it configures.
 */
export default function BuzzdetectGraphSettings({
  data, seriesMode, binWidthOverride, autoBinWidth, autoYRange, yAxisOverride, minDetectionRate,
  subsetNeurons, cuttingNeurons, subsetBuffer, subsetStats, className,
  onSeriesModeChange, onBinWidthOverrideChange, onYAxisOverrideChange, onMinDetectionRateChange,
  onSubsetThresholdChange, onSubsetBufferChange,
}: BuzzdetectGraphSettingsProps) {
  const fieldLabel = (text: string, reset?: { onReset: () => void; tooltip: string }) => (
    <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-slate-500">
      <span>{text}</span>
      {reset && (
        <button onClick={reset.onReset} className="text-slate-500 hover:text-[#e65161]" data-tooltip={reset.tooltip}>
          <RotateCcw size={10} />
        </button>
      )}
    </div>
  );

  return (
    <div className={className ?? 'flex-none overflow-y-auto px-1.5 pt-1.5 pb-2 space-y-2 border-b border-slate-700 bg-slate-800/40'}>
      <div className="space-y-1">
        {fieldLabel(copy.seriesHeader)}
        <div className="flex gap-1">
          {(['activation', 'detectionRate'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => onSeriesModeChange(mode)}
              className={`flex-1 px-1 py-0.5 rounded text-[10px] transition-colors ${seriesMode === mode ? 'bg-[#e65161] text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
            >
              {mode === 'activation' ? copy.seriesActivation : copy.seriesDetectionRate}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        {fieldLabel(copy.binWidthHeader, binWidthOverride !== null
          ? { onReset: () => onBinWidthOverrideChange(null), tooltip: tooltips.buzzdetectBinWidthReset }
          : undefined)}
        <DraftNumberInput
          value={binWidthOverride ?? autoBinWidth}
          onCommit={(v) => { if (v !== null) onBinWidthOverrideChange(v); }}
          min={data.frameHop}
          className={FIELD_CLASS}
        />
      </div>

      {autoYRange && (
        <div className="space-y-1">
          {fieldLabel(copy.yAxisHeader, yAxisOverride
            ? { onReset: () => onYAxisOverrideChange(null), tooltip: tooltips.buzzdetectYAxisReset }
            : undefined)}
          <div className="flex items-center gap-1">
            <DraftNumberInput
              value={yAxisOverride?.min ?? autoYRange.min}
              onCommit={(v) => { if (v !== null) onYAxisOverrideChange({ min: v, max: yAxisOverride?.max ?? autoYRange.max }); }}
              className={FIELD_CLASS}
            />
            <span className="text-slate-500 text-[10px] flex-none">–</span>
            <DraftNumberInput
              value={yAxisOverride?.max ?? autoYRange.max}
              onCommit={(v) => { if (v !== null) onYAxisOverrideChange({ min: yAxisOverride?.min ?? autoYRange.min, max: v }); }}
              className={FIELD_CLASS}
            />
          </div>
        </div>
      )}

      <div className="space-y-1">
        {fieldLabel(copy.subsetHeader)}
        {subsetNeurons.length === 0 ? (
          <p className="text-slate-500 text-[10px]">{copy.subsetNoNeurons}</p>
        ) : (
          <>
            {/* Exactly which neurons are cutting, with a way to drop each. The
                picks outlive a file and a neuron can be picked while not
                plotted — so without this the cut could be keyed to a neuron
                with no row anywhere in the palette, and nothing on screen would
                say so or offer a way to clear it. */}
            <div className="flex flex-wrap gap-1">
              {subsetNeurons.map(n => {
                const cutting = cuttingNeurons.includes(n);
                return (
                  <button
                    key={n}
                    onClick={() => onSubsetThresholdChange(n, null)}
                    className={`flex items-center gap-1 max-w-full pl-1.5 pr-1 py-px rounded text-[10px] transition-colors ${
                      cutting
                        ? 'bg-[#e65161]/15 text-[#e65161] hover:bg-[#e65161]/25'
                        : 'bg-slate-700/40 text-slate-500 line-through hover:bg-slate-700/70'
                    }`}
                    data-tooltip={cutting ? tooltips.buzzdetectSubsetUnpick : tooltips.buzzdetectSubsetAbsent}
                  >
                    <span className="truncate">{n}</span>
                    <X size={9} className="flex-none" />
                  </button>
                );
              })}
            </div>
            {seriesMode === 'detectionRate' && (
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[10px] text-slate-300">{copy.subsetMinRateLabel}</span>
                <DraftNumberInput
                  value={minDetectionRate}
                  onCommit={(v) => { if (v !== null) onMinDetectionRateChange(clamp(v, 0, 1)); }}
                  min={0}
                  className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-right text-slate-200 outline-none focus:border-[#e65161]"
                />
              </div>
            )}
            {/* Context around each kept bin. Global rather than per-neuron:
                bins are judged with the picked neurons OR'd together, so what
                gets padded is the kept REGION, which no single neuron owns.
                Activation mode only — in detection-rate mode the kept thing is
                a bin the user sized themselves, and padding it by some other
                amount would blur the boundary they set. */}
            {seriesMode === 'activation' && (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[10px] text-slate-300">{copy.subsetBufferLabel}</span>
              <DraftNumberInput
                value={subsetBuffer}
                onCommit={(v) => { if (v !== null) onSubsetBufferChange(Math.max(0, v)); }}
                min={0}
                className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-right text-slate-200 outline-none focus:border-[#e65161]"
                tooltip={tooltips.buzzdetectSubsetBuffer}
              />
            </div>
            )}
            {/* The auto bin width changes with zoom, so subsetting by it would
                silently redefine the subset every time the view moved. A bin is
                kept whole, on the pinned width instead. */}
            <p className="text-slate-500 text-[10px]">{copy.subsetPinBinWidth}</p>
            {/* What the cut actually came to. This is the number the user is
                steering by while dragging a threshold — and it has nowhere
                else to live: the spectrogram shows the kept audio but not how
                much of the file that is, and the graph is already full. */}
            {subsetStats && (
              <div className="pt-0.5">
                <div className="font-mono text-[11px] text-slate-200">
                  {copy.statsKept(
                    formatTime(subsetStats.keptSeconds, 0),
                    formatTime(subsetStats.sourceSeconds, 0),
                    `${(subsetStats.fraction * 100).toFixed(subsetStats.fraction < 0.01 ? 2 : 1)}%`,
                  )}
                </div>
                <div className="text-slate-500 text-[10px]">
                  {copy.statsBreakdown(subsetStats.regions, subsetStats.frames)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
