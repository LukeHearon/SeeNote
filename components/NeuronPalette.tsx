import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Palette, Pin, PinOff, RotateCcw, Scissors, Sliders } from 'lucide-react';
import { BuzzdetectData, BuzzdetectSeriesMode } from '../types';
import { BUZZDETECT_PALETTE, DEFAULT_BUZZDETECT_THRESHOLD, buzzdetectNeuronColor } from '../constants';
import { clamp } from '../utils/helpers';
import ToolCell from './ToolCell';
import SidebarSection from './SidebarSection';
import ColorSwatchPicker from './ColorSwatchPicker';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import DraftNumberInput from './DraftNumberInput';
import { tooltips } from '../copy/tooltips';
import { neuronPalette as copy } from '../copy/ui';

const FIELD_CLASS = 'w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-slate-200 outline-none focus:border-[#e65161]';

interface NeuronPaletteProps {
  data: BuzzdetectData | null;
  thresholds: Record<string, number>;
  hiddenNeurons: string[];
  neuronColors: Record<string, string>;
  subsetNeurons: string[];
  pinnedNeurons: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleNeuron: (neuron: string, wasEnabled: boolean) => void;
  onSetAllNeuronsHidden: (hidden: boolean) => void;
  onSoloNeuron: (neuron: string) => void;
  onNeuronColorChange: (neuron: string, color: string) => void;
  onThresholdChange: (neuron: string, value: number) => void;
  onToggleSubsetNeuron: (neuron: string, willSubset: boolean) => void;
  onTogglePinNeuron: (neuron: string) => void;
  // ── Graph-wide settings ────────────────────────────────────────────────────
  seriesMode: BuzzdetectSeriesMode;
  binWidthOverride: number | null;
  /** Bin width / Y-range the graph picked for itself, shown when nothing is pinned. */
  autoBinWidth: number;
  autoYRange: { min: number; max: number } | null;
  yAxisOverride: { min: number; max: number } | null;
  minDetectionRate: number;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onSeriesModeChange: (mode: BuzzdetectSeriesMode) => void;
  onBinWidthOverrideChange: (binWidth: number | null) => void;
  onYAxisOverrideChange: (range: { min: number; max: number } | null) => void;
  onMinDetectionRateChange: (rate: number) => void;
}

/**
 * The buzzdetect neuron palette — one cell per neuron, in the left sidebar
 * beside the annotation-tool palette it deliberately mirrors.
 *
 * The cell carries only what's worth reading at a glance across every neuron
 * at once: whether it's plotted (the cell's own active state, exactly the tool
 * palette's convention), its color, its threshold, and whether the track is
 * subset to it. Everything rarer is on the right-click menu, where there's room
 * for a full label instead of an unlabelled control competing for the row.
 *
 * The graph-wide settings sit in a disclosure above the list rather than in a
 * popover over the graph: the series being plotted and the bin width decide
 * what a threshold below even means, so they belong next to the thresholds.
 *
 * Plotting and subsetting stay independent, as they were in the old settings
 * popover: a neuron can define which frames survive while another is merely
 * plotted alongside it to see what it did there. Several scissors OR together.
 */
function NeuronPalette({
  data,
  thresholds,
  hiddenNeurons,
  neuronColors: neuronColorOverrides,
  subsetNeurons,
  pinnedNeurons,
  collapsed,
  onToggleCollapsed,
  onToggleNeuron,
  onSetAllNeuronsHidden,
  onSoloNeuron,
  onNeuronColorChange,
  onThresholdChange,
  onToggleSubsetNeuron,
  onTogglePinNeuron,
  seriesMode,
  binWidthOverride,
  autoBinWidth,
  autoYRange,
  yAxisOverride,
  minDetectionRate,
  settingsOpen,
  onSettingsOpenChange,
  onSeriesModeChange,
  onBinWidthOverrideChange,
  onYAxisOverrideChange,
  onMinDetectionRateChange,
}: NeuronPaletteProps) {
  // Which neuron's color popover is open (null = none). Closed on outside click.
  const [openColorNeuron, setOpenColorNeuron] = useState<string | null>(null);
  const colorPopoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openColorNeuron) return;
    const handler = (e: MouseEvent) => {
      if (colorPopoverRef.current && !colorPopoverRef.current.contains(e.target as Node)) {
        setOpenColorNeuron(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openColorNeuron]);

  const [contextNeuron, setContextNeuron] = useState<{ neuron: string; x: number; y: number } | null>(null);

  const neurons = useMemo(() => data?.neurons ?? [], [data]);
  const hidden = useMemo(() => new Set(hiddenNeurons), [hiddenNeurons]);
  const colorOf = useCallback(
    (n: string) => neuronColorOverrides[n] ?? buzzdetectNeuronColor(neurons.indexOf(n)),
    [neuronColorOverrides, neurons],
  );

  // Pinned first, in the order they were pinned; the rest in the file's own
  // order. Pins are persisted per project and outlive the file, so a pin naming
  // a neuron this file doesn't have simply drops out here rather than showing
  // an empty row.
  const { pinned, unpinned } = useMemo(() => {
    const pinnedSet = new Set(pinnedNeurons);
    return {
      pinned: pinnedNeurons.filter(n => neurons.includes(n)),
      unpinned: neurons.filter(n => !pinnedSet.has(n)),
    };
  }, [neurons, pinnedNeurons]);

  // One button whose action flips with the current state: while every neuron is
  // plotted the only useful next step is hiding them all, so the label always
  // names what a click is about to do.
  const allShown = neurons.length > 0 && neurons.every(n => !hidden.has(n));

  const menuItems = (n: string): ContextMenuItem[] => {
    const isPinned = pinnedNeurons.includes(n);
    const isSubset = subsetNeurons.includes(n);
    const plotted = !hidden.has(n);
    return [
      {
        label: isPinned ? copy.menuUnpin : copy.menuPin,
        icon: isPinned ? <PinOff size={12} /> : <Pin size={12} />,
        onSelect: () => onTogglePinNeuron(n),
      },
      {
        label: plotted ? copy.menuHide : copy.menuShow,
        icon: plotted ? <EyeOff size={12} /> : <Eye size={12} />,
        onSelect: () => onToggleNeuron(n, plotted),
      },
      { label: copy.menuIsolate, icon: <Eye size={12} />, onSelect: () => onSoloNeuron(n) },
      { label: copy.menuPlotAll, icon: <Eye size={12} />, onSelect: () => onSetAllNeuronsHidden(false) },
      {
        label: isSubset ? copy.menuUnsubset : copy.menuSubset,
        icon: <Scissors size={12} />,
        onSelect: () => onToggleSubsetNeuron(n, !isSubset),
        separatorBefore: true,
      },
      {
        label: copy.menuChangeColor,
        icon: <Palette size={12} />,
        onSelect: () => setOpenColorNeuron(n),
        separatorBefore: true,
      },
    ];
  };

  const renderCell = (n: string) => {
    const color = colorOf(n);
    const plotted = !hidden.has(n);
    const isSubset = subsetNeurons.includes(n);
    const isPinned = pinnedNeurons.includes(n);
    return (
      <div
        key={n}
        className="relative"
        onContextMenu={(e) => { e.preventDefault(); setContextNeuron({ neuron: n, x: e.clientX, y: e.clientY }); }}
      >
        <ToolCell
          isActive={plotted}
          color={color}
          dotColor={color}
          label={n}
          onClick={() => onToggleNeuron(n, plotted)}
          tooltip={plotted ? copy.hideFromGraph : copy.showInGraph}
          onDotClick={() => setOpenColorNeuron(v => (v === n ? null : n))}
          dotTooltip={tooltips.buzzdetectNeuronColor}
          trailing={(
            <span className="flex items-center gap-1 flex-none pointer-events-auto">
              {isPinned && <Pin size={9} className="text-slate-500 flex-none" />}
              <DraftNumberInput
                value={thresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD}
                onCommit={(v) => { if (v !== null) onThresholdChange(n, v); }}
                className="w-11 bg-slate-900/70 border border-slate-700/70 rounded px-1 py-px text-[11px] text-right font-mono outline-none focus:border-[#e65161] hover:border-slate-500 transition-colors"
                style={{ color }}
              />
              <button
                onClick={() => onToggleSubsetNeuron(n, !isSubset)}
                className={`p-0.5 rounded transition-colors ${isSubset ? 'text-[#e65161] bg-[#e65161]/15' : 'text-slate-600 hover:text-slate-300 hover:bg-slate-700/60'}`}
                data-tooltip={tooltips.buzzdetectSubsetNeuron}
              >
                <Scissors size={11} />
              </button>
            </span>
          )}
        />
        {openColorNeuron === n && (
          <div
            ref={colorPopoverRef}
            className="absolute left-0 top-full mt-1.5 z-30 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-2 w-40"
          >
            <ColorSwatchPicker
              value={color}
              swatchColors={BUZZDETECT_PALETTE}
              onChange={(c) => onNeuronColorChange(n, c)}
              customColorTitle={copy.customColorTitle}
              size={14}
              popoverPosition="bottom"
            />
          </div>
        )}
      </div>
    );
  };

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

  const settingsBlock = data && (
    <div className="px-1.5 pt-1.5 pb-2 space-y-2 border-b border-slate-700 bg-slate-800/40">
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
          min={data.binWidth}
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
            {/* The auto bin width changes with zoom, so subsetting by it would
                silently redefine the subset every time the view moved. A bin is
                kept whole, on the pinned width instead. */}
            <p className="text-slate-500 text-[10px]">{copy.subsetPinBinWidth}</p>
          </>
        )}
      </div>
    </div>
  );

  return (
    <SidebarSection
      title={<span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium">{copy.header}</span>}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      helpTarget="neuron-palette"
      actions={(
        <div className="flex items-center gap-1.5 flex-none">
          {neurons.length > 0 && (
            <button
              onClick={() => onSetAllNeuronsHidden(allShown)}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors underline decoration-dotted"
            >
              {allShown ? copy.selectNone : copy.selectAll}
            </button>
          )}
          <button
            onClick={() => onSettingsOpenChange(!settingsOpen)}
            className={`p-0.5 rounded transition-colors ${settingsOpen ? 'bg-slate-700 text-[#e65161]' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700'}`}
            data-tooltip={copy.settingsTitle}
          >
            <Sliders size={12} />
          </button>
        </div>
      )}
    >
      {settingsOpen && settingsBlock}

      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1">
        {neurons.length === 0 && (
          <p className="text-slate-600 text-[11px] px-1 py-2">{copy.noData}</p>
        )}
        {pinned.map(renderCell)}
        {pinned.length > 0 && unpinned.length > 0 && (
          <div className="border-t border-slate-700 mx-1 my-0.5" />
        )}
        {unpinned.map(renderCell)}
      </div>

      {contextNeuron && (
        <ContextMenu
          x={contextNeuron.x}
          y={contextNeuron.y}
          items={menuItems(contextNeuron.neuron)}
          onClose={() => setContextNeuron(null)}
        />
      )}
    </SidebarSection>
  );
}

export default React.memo(NeuronPalette);
