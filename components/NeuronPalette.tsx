import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Palette, Pin, PinOff, RotateCcw, Scissors, Settings, X } from 'lucide-react';
import { BuzzdetectData, BuzzdetectSeriesMode } from '../types';
import { BUZZDETECT_PALETTE, DEFAULT_BUZZDETECT_THRESHOLD, buzzdetectNeuronColor } from '../constants';
import { SubsetStats } from '../utils/buzzdetectStats';
import { pickedNeuronsIn } from '../utils/buzzdetectSubset';
import { clamp, formatTime } from '../utils/helpers';
import ToolCell from './ToolCell';
import { BuzzdetectToggle, SubsetToggle } from './controls/ToolbarToggles';
import SidebarSection from './SidebarSection';
import ContextMenu, { ContextMenuItem } from './ContextMenu';
import DraftNumberInput from './DraftNumberInput';
import ColorSwatchPicker from './ColorSwatchPicker';
import { tooltips } from '../copy/tooltips';
import { neuronPalette as copy } from '../copy/ui';

const FIELD_CLASS = 'w-full bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] text-slate-200 outline-none focus:border-[#e65161]';

interface NeuronPaletteProps {
  data: BuzzdetectData | null;
  /** Per-neuron detection thresholds; null = this neuron never detects. */
  thresholds: Record<string, number | null>;
  /** Per-neuron "Subset at" values. An entry here is what picks a neuron for the subset. */
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
  /** null clears the threshold, so the neuron stops detecting anything. */
  onThresholdChange: (neuron: string, value: number | null) => void;
  /** null clears the value, taking the neuron out of the subset entirely. */
  onSubsetThresholdChange: (neuron: string, value: number | null) => void;
  onTogglePinNeuron: (neuron: string) => void;
  // ── Graph-wide settings ────────────────────────────────────────────────────
  seriesMode: BuzzdetectSeriesMode;
  binWidthOverride: number | null;
  /** Bin width / Y-range the graph picked for itself, shown when nothing is pinned. */
  autoBinWidth: number;
  autoYRange: { min: number; max: number } | null;
  yAxisOverride: { min: number; max: number } | null;
  minDetectionRate: number;
  /** Master subset toggle — "subset by everything the boxes name" vs "by nothing". */
  subsetEnabled: boolean;
  onToggleSubset: () => void;
  /** Whether the buzzdetect results panel is showing below the spectrogram. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Seconds of context the subset keeps either side of each kept bin. */
  subsetBuffer: number;
  /** What the current subset came to, or null when nothing is subset. */
  subsetStats: SubsetStats | null;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onSeriesModeChange: (mode: BuzzdetectSeriesMode) => void;
  onBinWidthOverrideChange: (binWidth: number | null) => void;
  onYAxisOverrideChange: (range: { min: number; max: number } | null) => void;
  onMinDetectionRateChange: (rate: number) => void;
  onSubsetBufferChange: (seconds: number) => void;
}

/**
 * The buzzdetect neuron palette — one cell per neuron in the file, in the left
 * sidebar beside the annotation-tool palette it deliberately mirrors.
 *
 * Every neuron the results carry gets a row, and its COLOR DOT is the plot
 * switch: click it to start or stop plotting that neuron. Plotting is the one
 * per-neuron decision made often enough to deserve a click of its own rather
 * than a trip through the settings popover, and it's reversible in place —
 * a neuron that isn't plotted keeps its color and thresholds and sits, dimmed,
 * at the foot of the list, where it's still a row to read rather than a name to
 * go looking for.
 *
 * The row carries what's worth comparing ACROSS neurons at a glance: color,
 * name, and the two thresholds — what counts as a detection, and what the
 * track is subset at. Everything rarer — pin, isolate, color — is in the row's
 * right-click menu. There is no per-neuron settings popover: every setting it
 * held is either a control on the row already or a menu item, and a second
 * surface repeating them was a place for the two to disagree.
 *
 * The graph-wide settings sit in a disclosure above the list rather than in a
 * popover over the graph: the series being plotted and the bin width decide
 * what a threshold below even means, so they belong next to the thresholds.
 *
 * Plotting and subsetting stay independent: a neuron can define which frames
 * survive while another is merely plotted alongside it to see what it did
 * there. Which neurons cut is said by the "Subset at" boxes — a number in one
 * picks that neuron, an empty one doesn't — and several picks OR together.
 * There is no separate tick: the threshold and the pick are the same statement,
 * so they're the same control. In detection-rate mode there is no threshold to
 * type — the cut is judged at the DETECTION threshold and loosened by the min
 * rate — so the same slot becomes a plain scissors that only picks. The
 * scissors that turns the whole cut on and off is in this section's header,
 * beside the rows that key it.
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
  onTogglePinNeuron,
  seriesMode,
  binWidthOverride,
  autoBinWidth,
  autoYRange,
  yAxisOverride,
  minDetectionRate,
  subsetEnabled,
  onToggleSubset,
  panelOpen,
  onTogglePanel,
  subsetBuffer,
  subsetStats,
  settingsOpen,
  onSettingsOpenChange,
  onSeriesModeChange,
  onBinWidthOverrideChange,
  onYAxisOverrideChange,
  onMinDetectionRateChange,
  onSubsetBufferChange,
}: NeuronPaletteProps) {
  // Which neuron's color picker is open (null = none) — the one per-neuron
  // setting that needs a surface of its own, since a color can't be typed into
  // a row. Everything else about a neuron is either on the row or in its
  // right-click menu.
  const [colorNeuron, setColorNeuron] = useState<string | null>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colorNeuron) return;
    const onDown = (e: MouseEvent) => {
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) setColorNeuron(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setColorNeuron(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [colorNeuron]);
  const [contextNeuron, setContextNeuron] = useState<{ neuron: string; x: number; y: number } | null>(null);

  const neurons = useMemo(() => data?.neurons ?? [], [data]);
  const hidden = useMemo(() => new Set(hiddenNeurons), [hiddenNeurons]);
  // Colors are indexed against the FILE's neuron order, not the plotted list,
  // so removing a neuron never recolors the ones left behind.
  const colorOf = useCallback(
    (n: string) => neuronColorOverrides[n] ?? buzzdetectNeuronColor(neurons.indexOf(n)),
    [neuronColorOverrides, neurons],
  );

  // Three blocks, in this order: pinned, then the rest of the plotted ones in
  // the file's own order, then everything not plotted. Unplotted rows sink to
  // the bottom so the list reads as what the graph is showing, with the rest
  // still there to switch on. Pins are persisted per project and outlive the
  // file, so a pin naming a neuron this file doesn't have simply drops out here
  // rather than showing an empty row.
  const { pinned, unpinned, unplotted } = useMemo(() => {
    const pinnedSet = new Set(pinnedNeurons);
    const plotted = neurons.filter(n => !hidden.has(n));
    return {
      pinned: pinnedNeurons.filter(n => plotted.includes(n)),
      unpinned: plotted.filter(n => !pinnedSet.has(n)),
      unplotted: neurons.filter(n => hidden.has(n)),
    };
  }, [neurons, hidden, pinnedNeurons]);

  // The picks that are actually cutting: the ones this file's results have a
  // column for. The rest stay in the list below, marked, so a setting that
  // isn't doing anything here says so rather than looking like it is.
  const cuttingNeurons = useMemo(
    () => pickedNeuronsIn(subsetThresholds, data?.neurons ?? null),
    [subsetThresholds, data],
  );

  // One button whose action flips with the current state: while every neuron is
  // plotted the only useful next step is clearing them all, so the label always
  // names what a click is about to do.
  const allShown = neurons.length > 0 && unplotted.length === 0;

  const menuItems = (n: string): ContextMenuItem[] => {
    const isPinned = pinnedNeurons.includes(n);
    return [
      {
        label: isPinned ? copy.menuUnpin : copy.menuPin,
        icon: isPinned ? <PinOff size={12} /> : <Pin size={12} />,
        onSelect: () => onTogglePinNeuron(n),
      },
      { label: copy.menuIsolate, icon: <Scissors size={12} />, onSelect: () => onSoloNeuron(n) },
      {
        label: copy.menuColor,
        icon: <Palette size={12} />,
        onSelect: () => setColorNeuron(n),
        separatorBefore: true,
      },
      {
        label: hidden.has(n) ? copy.menuPlot : copy.menuUnplot,
        icon: hidden.has(n) ? <Eye size={12} /> : <EyeOff size={12} />,
        onSelect: () => onToggleNeuron(n, !hidden.has(n)),
      },
    ];
  };

  // How a neuron says it cuts. In activation mode that's a threshold to type,
  // and typing one IS the pick. In detection-rate mode there's no second
  // threshold to set (see utils/buzzdetectSubset.ts), so the same slot is a
  // plain scissors — picking still writes the neuron's detection threshold into
  // the map, so the pick lives in one place either way and switching back to
  // activation mode finds a sensible starting value already there.
  const renderSubsetControl = (n: string, isSubset: boolean) => {
    if (seriesMode === 'detectionRate') {
      return (
        <button
          onClick={() => onSubsetThresholdChange(n, isSubset ? null : (thresholds[n] ?? DEFAULT_BUZZDETECT_THRESHOLD))}
          className={`p-0.5 rounded transition-colors ${isSubset ? 'text-[#e65161] bg-[#e65161]/15' : 'text-slate-600 hover:text-slate-300 hover:bg-slate-700/60'}`}
          data-tooltip={tooltips.buzzdetectSubsetPick}
        >
          <Scissors size={11} />
        </button>
      );
    }
    return (
      <DraftNumberInput
        value={subsetThresholds[n] ?? null}
        onCommit={(v) => onSubsetThresholdChange(n, v)}
        allowEmpty
        placeholder={copy.settingsSubsetOff}
        className={`w-10 bg-slate-900/70 border rounded px-1 py-px text-[11px] text-right font-mono text-[#e65161] placeholder:text-[#e65161]/40 outline-none focus:border-[#e65161] transition-colors ${isSubset ? 'border-[#e65161]/50' : 'border-slate-700/70 hover:border-slate-500'}`}
        tooltip={tooltips.buzzdetectSubsetThreshold}
      />
    );
  };

  const renderCell = (n: string) => {
    const color = colorOf(n);
    const isSubset = subsetNeurons.includes(n);
    const isPinned = pinnedNeurons.includes(n);
    const isPlotted = !hidden.has(n);
    return (
      <div
        key={n}
        className="relative"
        onContextMenu={(e) => { e.preventDefault(); setContextNeuron({ neuron: n, x: e.clientX, y: e.clientY }); }}
      >
        {/* The whole row is the plot switch — dot included, since a click
            anywhere on a neuron means the same thing. Active = plotted, and a
            hollow dot is one that isn't. Whether it also cuts the subset is
            said by its "Subset at" box holding a number, in the accent
            colour. */}
        <ToolCell
          isActive={isPlotted}
          color={color}
          dotColor={color}
          dotHollow={!isPlotted}
          label={n}
          onClick={() => onToggleNeuron(n, isPlotted)}
          tooltip={isPlotted ? tooltips.buzzdetectUnplotNeuron : tooltips.buzzdetectPlotNeuron}
          onDotClick={() => onToggleNeuron(n, isPlotted)}
          dotTooltip={isPlotted ? tooltips.buzzdetectUnplotNeuron : tooltips.buzzdetectPlotNeuron}
          trailing={(
            <span className="flex items-center gap-1 flex-none pointer-events-auto">
              {isPinned && <Pin size={9} className="text-slate-500 flex-none" />}
              {/* The subset control first, in the accent colour, so what
                  decides the TRACK reads apart from what only decides how the
                  graph is drawn. */}
              {renderSubsetControl(n, isSubset)}
              {/* Emptying this box is a real setting, not a missing one: the
                  neuron then never reaches a detection, so its dots all draw
                  open and it keeps nothing in a detection-rate subset. */}
              <DraftNumberInput
                value={n in thresholds ? thresholds[n] : DEFAULT_BUZZDETECT_THRESHOLD}
                onCommit={(v) => onThresholdChange(n, v)}
                allowEmpty
                placeholder={copy.settingsThresholdOff}
                className="w-10 bg-slate-900/70 border border-slate-700/70 rounded px-1 py-px text-[11px] text-right font-mono outline-none focus:border-[#e65161] hover:border-slate-500 transition-colors placeholder:text-slate-600"
                style={{ color }}
                tooltip={tooltips.buzzdetectThreshold}
              />
            </span>
          )}
        />
        {/* Color, on demand from the right-click menu: it's the one thing
            about a neuron that can't be a control on the row, and it's set
            once and then left alone. */}
        {colorNeuron === n && (
          <div
            ref={colorRef}
            className="absolute left-0 right-0 top-full mt-1 z-30 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-1.5"
          >
            <ColorSwatchPicker
              value={color}
              swatchColors={BUZZDETECT_PALETTE}
              onChange={(c) => onNeuronColorChange(n, c)}
              customColorTitle={copy.customColorTitle}
              size={16}
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

  // Capped at half the section so a long settings block can never squeeze the
  // neuron list out of existence — past that it scrolls on its own.
  const settingsBlock = data && (
    <div className="flex-none max-h-[50%] overflow-y-auto px-1.5 pt-1.5 pb-2 space-y-2 border-b border-slate-700 bg-slate-800/40">
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

  return (
    <SidebarSection
      title={<span className="text-[10px] text-slate-400 uppercase tracking-wider font-medium">{copy.header}</span>}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      keepActionsWhenCollapsed
      helpTarget="neuron-palette"
      actions={(
        <div className="flex items-center gap-1 flex-none">
          {/* All / None is the one header control that acts on the rows
              themselves, so it goes with them — and the collapsed header has
              no width to spare for it. */}
          {neurons.length > 0 && !collapsed && (
            <button
              onClick={() => onSetAllNeuronsHidden(allShown)}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors underline decoration-dotted mr-0.5"
            >
              {allShown ? copy.selectNone : copy.selectAll}
            </button>
          )}
          {/* The two buzzdetect switches sit with the neurons rather than in
              the toolbar: the scissors is keyed to the Subset at boxes right
              below it, and the graph the other one opens is what these rows
              describe. Both are reachable exactly when this section is — i.e.
              when the project names a buzzdetect directory. */}
          {cuttingNeurons.length > 0 && (
            <SubsetToggle compact active={subsetEnabled} onToggle={onToggleSubset} />
          )}
          <BuzzdetectToggle compact enabled={panelOpen} onToggle={onTogglePanel} />
          <button
            onClick={() => onSettingsOpenChange(!settingsOpen)}
            className={`p-0.5 rounded transition-colors ${settingsOpen ? 'bg-slate-700 text-[#e65161]' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-700'}`}
            data-tooltip={copy.settingsTitle}
          >
            <Settings size={12} />
          </button>
        </div>
      )}
    >
      {settingsOpen && settingsBlock}

      {/* min-h-0 is what makes this scroll rather than push past the section:
          a flex item's automatic minimum size is its content, so without it the
          list refuses to shrink and overflow-y-auto never engages. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1">
        {neurons.length === 0 && (
          <p className="text-slate-600 text-[11px] px-1 py-2">{copy.noData}</p>
        )}
        {pinned.map(renderCell)}
        {pinned.length > 0 && unpinned.length > 0 && (
          <div className="border-t border-slate-700 mx-1 my-0.5" />
        )}
        {unpinned.map(renderCell)}
        {/* Not plotted, at the foot of the list behind a rule: still rows, with
            their colors and thresholds intact, one dot-click from the graph. */}
        {unplotted.length > 0 && (
          <>
            {(pinned.length > 0 || unpinned.length > 0) && (
              <div className="border-t border-slate-700 mx-1 mt-1 mb-0.5" />
            )}
            {unplotted.map(renderCell)}
          </>
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
