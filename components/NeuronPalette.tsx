import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff, Plus, Pin, PinOff, RotateCcw, Scissors, Search, Settings2, Sliders } from 'lucide-react';
import { BuzzdetectData, BuzzdetectSeriesMode } from '../types';
import { DEFAULT_BUZZDETECT_THRESHOLD, buzzdetectNeuronColor } from '../constants';
import { SubsetStats } from '../utils/buzzdetectStats';
import { clamp, formatTime } from '../utils/helpers';
import ToolCell from './ToolCell';
import SidebarSection from './SidebarSection';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import DraftNumberInput from './DraftNumberInput';
import NeuronSettingsPopover from './NeuronSettingsPopover';
import { tooltips } from '../copy/tooltips';
import { neuronPalette as copy } from '../copy/ui';

const FIELD_CLASS = 'w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-slate-200 outline-none focus:border-[#e65161]';

interface NeuronPaletteProps {
  data: BuzzdetectData | null;
  thresholds: Record<string, number>;
  /** Per-neuron subset threshold override; absent entries follow `thresholds`. */
  subsetThresholds: Record<string, number>;
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
  /** null clears the override, putting the cut back on the detection threshold. */
  onSubsetThresholdChange: (neuron: string, value: number | null) => void;
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
  /** What the current subset came to, or null when nothing is subset. */
  subsetStats: SubsetStats | null;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onSeriesModeChange: (mode: BuzzdetectSeriesMode) => void;
  onBinWidthOverrideChange: (binWidth: number | null) => void;
  onYAxisOverrideChange: (range: { min: number; max: number } | null) => void;
  onMinDetectionRateChange: (rate: number) => void;
}

/**
 * The buzzdetect neuron palette — one cell per PLOTTED neuron, in the left
 * sidebar beside the annotation-tool palette it deliberately mirrors.
 *
 * Only plotted neurons get a row. A model carries a dozen or more neurons and
 * a given investigation uses two or three, so listing them all spent most of
 * the sidebar on rows whose only job was to be ignored. The rest live behind
 * the picker at the foot of the list, and removing a neuron only takes its row
 * away — its color and thresholds are kept, so putting it back restores what
 * it was.
 *
 * The row carries what's worth comparing ACROSS neurons at a glance: color,
 * name, detection threshold, and whether the track is subset to it. Everything
 * chosen once per neuron is in its settings popover (NeuronSettingsPopover),
 * reached from the color dot — one surface, whether the neuron was just added
 * or has been there all along.
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
  subsetThresholds,
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
  onSubsetThresholdChange,
  onToggleSubsetNeuron,
  onTogglePinNeuron,
  seriesMode,
  binWidthOverride,
  autoBinWidth,
  autoYRange,
  yAxisOverride,
  minDetectionRate,
  subsetStats,
  settingsOpen,
  onSettingsOpenChange,
  onSeriesModeChange,
  onBinWidthOverrideChange,
  onYAxisOverrideChange,
  onMinDetectionRateChange,
}: NeuronPaletteProps) {
  // Which neuron's settings popover is open (null = none). The popover closes
  // itself on an outside click or Escape.
  const [openSettingsNeuron, setOpenSettingsNeuron] = useState<string | null>(null);
  const [contextNeuron, setContextNeuron] = useState<{ neuron: string; x: number; y: number } | null>(null);
  // The add-neuron picker, and its search box.
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    const handler = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);
  // Reopening the picker should offer the whole list again, not the last search.
  useEffect(() => { if (!addOpen) setAddQuery(''); }, [addOpen]);

  const neurons = useMemo(() => data?.neurons ?? [], [data]);
  const hidden = useMemo(() => new Set(hiddenNeurons), [hiddenNeurons]);
  // Colors are indexed against the FILE's neuron order, not the plotted list,
  // so removing a neuron never recolors the ones left behind.
  const colorOf = useCallback(
    (n: string) => neuronColorOverrides[n] ?? buzzdetectNeuronColor(neurons.indexOf(n)),
    [neuronColorOverrides, neurons],
  );

  // Plotted neurons only: pinned first, in the order they were pinned, then the
  // rest in the file's own order. Pins are persisted per project and outlive
  // the file, so a pin naming a neuron this file doesn't have (or one that's
  // been removed from the graph) simply drops out here rather than showing an
  // empty row.
  const { pinned, unpinned } = useMemo(() => {
    const plotted = neurons.filter(n => !hidden.has(n));
    const pinnedSet = new Set(pinnedNeurons);
    return {
      pinned: pinnedNeurons.filter(n => plotted.includes(n)),
      unpinned: plotted.filter(n => !pinnedSet.has(n)),
    };
  }, [neurons, hidden, pinnedNeurons]);
  const plottedCount = pinned.length + unpinned.length;

  // What the picker can offer, filtered by its search box.
  const addable = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    const rest = neurons.filter(n => hidden.has(n));
    return q ? rest.filter(n => n.toLowerCase().includes(q)) : rest;
  }, [neurons, hidden, addQuery]);
  const anyAddable = neurons.some(n => hidden.has(n));

  // One button whose action flips with the current state: while every neuron is
  // plotted the only useful next step is clearing them all, so the label always
  // names what a click is about to do.
  const allShown = neurons.length > 0 && !anyAddable;

  const menuItems = (n: string): ContextMenuItem[] => {
    const isPinned = pinnedNeurons.includes(n);
    const isSubset = subsetNeurons.includes(n);
    return [
      {
        label: isPinned ? copy.menuUnpin : copy.menuPin,
        icon: isPinned ? <PinOff size={12} /> : <Pin size={12} />,
        onSelect: () => onTogglePinNeuron(n),
      },
      { label: copy.menuIsolate, icon: <Scissors size={12} />, onSelect: () => onSoloNeuron(n) },
      {
        label: isSubset ? copy.menuUnsubset : copy.menuSubset,
        icon: <Scissors size={12} />,
        onSelect: () => onToggleSubsetNeuron(n, !isSubset),
        separatorBefore: true,
      },
      {
        label: copy.menuSettings,
        icon: <Settings2 size={12} />,
        onSelect: () => setOpenSettingsNeuron(n),
        separatorBefore: true,
      },
      {
        label: copy.settingsRemove,
        icon: <EyeOff size={12} />,
        onSelect: () => onToggleNeuron(n, true),
      },
    ];
  };

  const renderCell = (n: string) => {
    const color = colorOf(n);
    const isSubset = subsetNeurons.includes(n);
    const isPinned = pinnedNeurons.includes(n);
    return (
      <div
        key={n}
        className="relative"
        onContextMenu={(e) => { e.preventDefault(); setContextNeuron({ neuron: n, x: e.clientX, y: e.clientY }); }}
      >
        {/* Every row here is plotted, so the cell's active state carries the
            thing that actually varies between them: whether this neuron is
            cutting the subset. The scissors stays as its own control too —
            it's what the state means, and the cell is a wide, forgiving
            target for a toggle flipped this often. */}
        <ToolCell
          isActive={isSubset}
          color={color}
          dotColor={color}
          label={n}
          onClick={() => onToggleSubsetNeuron(n, !isSubset)}
          tooltip={tooltips.buzzdetectSubsetNeuron}
          onDotClick={() => setOpenSettingsNeuron(v => (v === n ? null : n))}
          dotTooltip={tooltips.buzzdetectNeuronSettings}
          trailing={(
            <span className="flex items-center gap-1 flex-none pointer-events-auto">
              {isPinned && <Pin size={9} className="text-slate-500 flex-none" />}
              <DraftNumberInput
                value={thresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD}
                onCommit={(v) => { if (v !== null) onThresholdChange(n, v); }}
                className="w-11 bg-slate-900/70 border border-slate-700/70 rounded px-1 py-px text-[11px] text-right font-mono outline-none focus:border-[#e65161] hover:border-slate-500 transition-colors"
                style={{ color }}
                tooltip={tooltips.buzzdetectThreshold}
              />
              <button
                onClick={() => setOpenSettingsNeuron(v => (v === n ? null : n))}
                className={`p-0.5 rounded transition-colors ${openSettingsNeuron === n ? 'text-[#e65161] bg-[#e65161]/15' : 'text-slate-600 hover:text-slate-300 hover:bg-slate-700/60'}`}
                data-tooltip={tooltips.buzzdetectNeuronSettings}
              >
                <Settings2 size={11} />
              </button>
            </span>
          )}
        />
        {openSettingsNeuron === n && (
          <NeuronSettingsPopover
            neuron={n}
            color={color}
            threshold={thresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD}
            subsetThreshold={subsetThresholds[n] ?? null}
            isSubset={isSubset}
            isPinned={isPinned}
            seriesMode={seriesMode}
            onColorChange={(c) => onNeuronColorChange(n, c)}
            onThresholdChange={(v) => onThresholdChange(n, v)}
            onSubsetThresholdChange={(v) => onSubsetThresholdChange(n, v)}
            onToggleSubset={() => onToggleSubsetNeuron(n, !isSubset)}
            onTogglePin={() => onTogglePinNeuron(n)}
            onRemove={() => onToggleNeuron(n, true)}
            onClose={() => setOpenSettingsNeuron(null)}
          />
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
        {neurons.length > 0 && plottedCount === 0 && (
          <p className="text-slate-600 text-[11px] px-1 py-2">{copy.noneShown}</p>
        )}
        {pinned.map(renderCell)}
        {pinned.length > 0 && unpinned.length > 0 && (
          <div className="border-t border-slate-700 mx-1 my-0.5" />
        )}
        {unpinned.map(renderCell)}

        {/* The model's other neurons, one click away rather than occupying a
            row each. Adding one opens its settings straight away, so the
            thresholds and color can be set while the neuron is still the thing
            being thought about. */}
        {neurons.length > 0 && (
          <div className="relative mt-0.5" ref={addRef}>
            <button
              onClick={() => setAddOpen(v => !v)}
              disabled={!anyAddable}
              className={`w-full flex items-center justify-center gap-1 px-1.5 py-1 rounded border border-dashed text-[11px] transition-colors ${
                anyAddable
                  ? 'border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-200 hover:bg-slate-800/60'
                  : 'border-slate-800 text-slate-700 cursor-default'
              }`}
              data-tooltip={anyAddable ? tooltips.buzzdetectAddNeuron : copy.addAllShown}
            >
              <Plus size={11} className="flex-none" />
              <span>{copy.addNeuron}</span>
            </button>
            {/* Downward, like every other popover here: the list scrolls, and
                overflow BELOW a scroll container is reachable by scrolling
                while overflow above it is simply clipped away. */}
            {addOpen && anyAddable && (
              <div className="absolute left-0 right-0 top-full mt-1.5 z-30 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-1.5">
                <div className="relative mb-1">
                  <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    autoFocus
                    value={addQuery}
                    onChange={(e) => setAddQuery(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={copy.addSearchPlaceholder}
                    className="w-full bg-slate-900 border border-slate-700 rounded pl-6 pr-1.5 py-0.5 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-[#e65161]"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
                  {addable.length === 0 && (
                    <p className="text-slate-600 text-[10px] px-1 py-1">{copy.addNoMatches}</p>
                  )}
                  {addable.map(n => (
                    <button
                      key={n}
                      onClick={() => {
                        onToggleNeuron(n, false);
                        setAddOpen(false);
                        setOpenSettingsNeuron(n);
                      }}
                      className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] text-slate-300 hover:bg-slate-700/70 hover:text-slate-100 transition-colors"
                    >
                      <span className="w-2 h-2 rounded-full flex-none" style={{ backgroundColor: colorOf(n) }} />
                      <span className="flex-1 min-w-0 truncate text-left">{n}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
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
