import type { RefObject } from 'react';
import NeuronPalette from '../NeuronPalette';
import BuzzdetectPanel from '../BuzzdetectPanel';
import type { BuzzdetectApi } from '../../hooks/useBuzzdetect';
import type { SubsetTimelineApi } from '../../hooks/useSubsetTimeline';
import type { SpectrogramHandle } from '../Spectrogram';
import type { ViewportStore } from '../../utils/viewportStore';
import type { CurrentTimeStore } from '../../utils/currentTimeStore';
import type { Selection } from '../../types';
import type { TimeDisplayUnit } from '../../utils/helpers';
import type { DateTimeFormat } from '../../utils/datetimeDisplay';

// The buzzdetect palette and activations panel wired straight to useBuzzdetect
// and useSubsetTimeline, so the annotation and single-file windows render the
// same views from the same hook state without restating ~40 props each.

interface PaletteProps {
  buzzdetect: BuzzdetectApi;
  subset: SubsetTimelineApi;
  toolColors: Record<string, string>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRefresh: () => void;
}

export function BuzzdetectNeuronPalette({ buzzdetect: b, subset, toolColors, collapsed, onToggleCollapsed, onRefresh }: PaletteProps) {
  return (
    <NeuronPalette
      data={b.buzzdetectData}
      onRefreshBuzzdetect={onRefresh}
      thresholds={b.buzzdetectThresholds}
      subsetThresholds={b.buzzdetectSubsetThresholds}
      hiddenNeurons={b.buzzdetectHiddenNeurons}
      neuronColors={b.buzzdetectNeuronColors}
      toolColors={toolColors}
      subsetNeurons={b.buzzdetectSubsetNeurons}
      pinnedNeurons={b.buzzdetectPinnedNeurons}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      onToggleNeuron={b.handleBuzzdetectToggleNeuron}
      onSetAllNeuronsHidden={hidden => b.handleBuzzdetectSetAllNeuronsHidden(b.buzzdetectData?.neurons ?? [], hidden)}
      isolatedNeurons={b.buzzdetectIsolatedNeurons}
      onToggleIsolateNeuron={b.handleBuzzdetectToggleIsolateNeuron}
      isolateEnabled={b.buzzdetectIsolateEnabled}
      onToggleIsolate={b.toggleBuzzdetectIsolate}
      onNeuronColorChange={b.handleBuzzdetectNeuronColorChange}
      onNeuronColorReset={b.handleBuzzdetectNeuronColorReset}
      onThresholdChange={b.handleBuzzdetectThresholdChange}
      onSubsetThresholdChange={b.handleBuzzdetectSubsetThresholdChange}
      onTogglePinNeuron={b.handleBuzzdetectTogglePinNeuron}
      seriesMode={b.buzzdetectSeriesMode}
      binWidthOverride={b.buzzdetectBinWidthOverride}
      autoBinWidth={b.buzzdetectAutoBinWidth}
      autoYRange={b.buzzdetectAutoYRange}
      yAxisOverride={b.buzzdetectYAxisOverride}
      minDetectionRate={b.buzzdetectMinDetectionRate}
      subsetEnabled={subset.subsetActive}
      onToggleSubset={b.toggleBuzzdetectSubset}
      panelOpen={b.buzzdetectEnabled}
      onTogglePanel={() => b.setBuzzdetectEnabled(v => !v)}
      subsetBuffer={b.buzzdetectSubsetBuffer}
      subsetStats={subset.subsetStats}
      settingsOpen={b.buzzdetectSettingsOpen}
      onSettingsOpenChange={b.setBuzzdetectSettingsOpen}
      onSeriesModeChange={b.setBuzzdetectSeriesMode}
      onBinWidthOverrideChange={b.setBuzzdetectBinWidthOverride}
      onYAxisOverrideChange={b.setBuzzdetectYAxisOverride}
      onMinDetectionRateChange={b.setBuzzdetectMinDetectionRate}
      onSubsetBufferChange={b.setBuzzdetectSubsetBuffer}
    />
  );
}

interface TrackPanelProps {
  buzzdetect: BuzzdetectApi;
  subset: SubsetTimelineApi;
  toolColors: Record<string, string>;
  viewportStore: ViewportStore;
  currentTimeStore: CurrentTimeStore;
  selection: Selection | null;
  timeDisplayUnit: TimeDisplayUnit;
  trackStartDate?: Date | null;
  dateTimeFormat?: DateTimeFormat;
  spectrogramRef: RefObject<SpectrogramHandle | null>;
  onSelectionChange: (s: Selection | null) => void;
  onBoundAnnotationChange: (id: string | null) => void;
  onSeek: (time: number) => void;
}

export function BuzzdetectTrackPanel({
  buzzdetect: b, subset, toolColors, viewportStore, currentTimeStore, selection, timeDisplayUnit,
  trackStartDate, dateTimeFormat, spectrogramRef, onSelectionChange, onBoundAnnotationChange, onSeek,
}: TrackPanelProps) {
  return (
    <BuzzdetectPanel
      data={subset.displayBuzzdetectData}
      viewportStore={viewportStore}
      duration={subset.displayDuration}
      currentTimeStore={currentTimeStore}
      selection={selection}
      timeDisplayUnit={timeDisplayUnit}
      trackStartDate={trackStartDate}
      dateTimeFormat={dateTimeFormat}
      thresholds={b.buzzdetectThresholds}
      hiddenNeurons={b.buzzdetectHiddenNeurons}
      isolatedNeurons={subset.activeIsolatedNeurons}
      neuronColors={b.buzzdetectNeuronColors}
      toolColors={toolColors}
      seriesMode={b.buzzdetectSeriesMode}
      binWidthOverride={b.buzzdetectBinWidthOverride}
      subsetActive={subset.subsetActive}
      timeline={subset.timeline}
      yAxisOverride={b.buzzdetectYAxisOverride}
      baselineAdjusted={b.buzzdetectBaselineAdjusted}
      onBaselineAdjustedChange={b.setBuzzdetectBaselineAdjusted}
      reportAutoValues={b.buzzdetectSettingsOpen}
      height={b.buzzdetectPanelHeight}
      onAutoBinWidthChange={b.setBuzzdetectAutoBinWidth}
      onAutoYRangeChange={b.setBuzzdetectAutoYRange}
      onHeightChange={b.setBuzzdetectPanelHeight}
      onSelectionChange={onSelectionChange}
      onBoundAnnotationChange={onBoundAnnotationChange}
      onSeek={onSeek}
      onScrollWheel={(deltaX, deltaY, ctrlKey, metaKey, clientX) =>
        spectrogramRef.current?.applyWheel(deltaX, deltaY, ctrlKey, metaKey, clientX)
      }
    />
  );
}
