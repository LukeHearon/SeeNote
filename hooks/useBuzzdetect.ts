import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BuzzdetectData, BuzzdetectSeriesMode, Project } from '../types';
import { DEFAULT_BUZZDETECT_PANEL_HEIGHT, DEFAULT_BUZZDETECT_MIN_DETECTION_RATE } from '../constants';
import { readBuzzdetect } from '../utils/tauriCommands';

export interface BuzzdetectApi {
  buzzdetectEnabled: boolean;
  setBuzzdetectEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  buzzdetectThresholds: Record<string, number>;
  setBuzzdetectThresholds: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  /**
   * Per-neuron threshold the SUBSET is cut at, where it differs from the
   * detection threshold above. Absent = the same value; the setting exists to
   * be set looser, so the cut keeps the audio around a detection while the
   * graph still marks detections strictly. activation mode only.
   */
  buzzdetectSubsetThresholds: Record<string, number>;
  setBuzzdetectSubsetThresholds: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  buzzdetectHiddenNeurons: string[];
  setBuzzdetectHiddenNeurons: React.Dispatch<React.SetStateAction<string[]>>;
  buzzdetectNeuronColors: Record<string, string>;
  setBuzzdetectNeuronColors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  buzzdetectSeriesMode: BuzzdetectSeriesMode;
  setBuzzdetectSeriesMode: React.Dispatch<React.SetStateAction<BuzzdetectSeriesMode>>;
  buzzdetectBinWidthOverride: number | null;
  setBuzzdetectBinWidthOverride: React.Dispatch<React.SetStateAction<number | null>>;
  buzzdetectSubsetEnabled: boolean;
  setBuzzdetectSubsetEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  buzzdetectSubsetNeurons: string[];
  setBuzzdetectSubsetNeurons: React.Dispatch<React.SetStateAction<string[]>>;
  buzzdetectMinDetectionRate: number;
  setBuzzdetectMinDetectionRate: React.Dispatch<React.SetStateAction<number>>;
  /** Neuron labels pinned to the top of the palette, in the order they were pinned. */
  buzzdetectPinnedNeurons: string[];
  setBuzzdetectPinnedNeurons: React.Dispatch<React.SetStateAction<string[]>>;
  buzzdetectPanelHeight: number;
  setBuzzdetectPanelHeight: React.Dispatch<React.SetStateAction<number>>;
  // ── Graph-wide settings shown in the neuron palette ────────────────────────
  /** Whether the palette's settings block is open. Gates the panel's reporting below. */
  buzzdetectSettingsOpen: boolean;
  setBuzzdetectSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * User-pinned Y-axis range, or null to use the auto range. Transient, not
   * persisted: it's reset per file (each file gets its own auto range rather
   * than inheriting a stale override) and on a series-mode flip, since the two
   * modes plot in units that aren't comparable.
   */
  buzzdetectYAxisOverride: { min: number; max: number } | null;
  setBuzzdetectYAxisOverride: React.Dispatch<React.SetStateAction<{ min: number; max: number } | null>>;
  /**
   * The auto values the graph is currently drawing with, reported back up by
   * BuzzdetectPanel at draw time so the palette's fields can show them as
   * placeholders. Both change with zoom, so the panel only reports while the
   * settings block is open.
   */
  buzzdetectAutoBinWidth: number;
  setBuzzdetectAutoBinWidth: React.Dispatch<React.SetStateAction<number>>;
  buzzdetectAutoYRange: { min: number; max: number } | null;
  setBuzzdetectAutoYRange: React.Dispatch<React.SetStateAction<{ min: number; max: number } | null>>;
  buzzdetectData: BuzzdetectData | null;
  setBuzzdetectData: React.Dispatch<React.SetStateAction<BuzzdetectData | null>>;
  handleBuzzdetectThresholdChange: (neuron: string, value: number) => void;
  /** null clears the override, putting the cut back on the detection threshold. */
  handleBuzzdetectSubsetThresholdChange: (neuron: string, value: number | null) => void;
  handleBuzzdetectToggleNeuron: (neuron: string, wasEnabled: boolean) => void;
  handleBuzzdetectNeuronColorChange: (neuron: string, color: string) => void;
  handleBuzzdetectToggleSubsetNeuron: (neuron: string, willSubset: boolean) => void;
  /** Pin a neuron to the top of the palette, or unpin it. Newly pinned goes last among the pinned. */
  handleBuzzdetectTogglePinNeuron: (neuron: string) => void;
  /** Plot only this neuron, hiding every other one in `neurons`. */
  handleBuzzdetectSoloNeuron: (neurons: string[], neuron: string) => void;
  /** Toggle subset mode. No-op when no neuron is picked — there'd be nothing to subset by. */
  toggleBuzzdetectSubset: () => void;
  /**
   * Show/hide every neuron in the graph at once. `neurons` is the file's own
   * list (from the loaded data) — hiding-all sets exactly that list, so a
   * label from a previously loaded file never lingers in `hiddenNeurons`.
   */
  handleBuzzdetectSetAllNeuronsHidden: (neurons: string[], hidden: boolean) => void;
}

export interface BuzzdetectParams {
  project: Project;
  // Ident of the active track (relative path without extension), or null.
  ident: string | null;
  addLog: (msg: string, type?: 'info' | 'error') => void;
}

/**
 * Buzzdetect activations panel UI state. Holds the persisted UI fields
 * (enabled/thresholds/hiddenNeurons — still persisted by AnnotationWindow's
 * consolidated UI-persistence effect, which reads these returned values), the
 * transient panel height + loaded data, and the load effect that reads
 * activations by ident under the configured buzzdetect directory.
 */
export function useBuzzdetect({ project, ident, addLog }: BuzzdetectParams): BuzzdetectApi {
  // buzzdetect activations panel — UI fields persisted in uiSettings.
  const [buzzdetectEnabled, setBuzzdetectEnabled] = useState(project.preferences.uiSettings?.buzzdetectEnabled ?? false);
  const [buzzdetectThresholds, setBuzzdetectThresholds] = useState<Record<string, number>>(project.preferences.uiSettings?.buzzdetectThresholds ?? {});
  const [buzzdetectSubsetThresholds, setBuzzdetectSubsetThresholds] = useState<Record<string, number>>(project.preferences.uiSettings?.buzzdetectSubsetThresholds ?? {});
  const [buzzdetectHiddenNeurons, setBuzzdetectHiddenNeurons] = useState<string[]>(project.preferences.uiSettings?.buzzdetectHiddenNeurons ?? []);
  const [buzzdetectNeuronColors, setBuzzdetectNeuronColors] = useState<Record<string, string>>(project.preferences.uiSettings?.buzzdetectNeuronColors ?? {});
  const [buzzdetectSeriesMode, setBuzzdetectSeriesMode] = useState<BuzzdetectSeriesMode>(project.preferences.uiSettings?.buzzdetectSeriesMode ?? 'activation');
  const [buzzdetectBinWidthOverride, setBuzzdetectBinWidthOverride] = useState<number | null>(project.preferences.uiSettings?.buzzdetectBinWidthOverride ?? null);
  // Subset mode. The neuron picks are kept separately from the master toggle so
  // flipping the subset off and on again doesn't cost the user their selection.
  const [buzzdetectSubsetEnabled, setBuzzdetectSubsetEnabled] = useState(project.preferences.uiSettings?.buzzdetectSubsetEnabled ?? false);
  const [buzzdetectSubsetNeurons, setBuzzdetectSubsetNeurons] = useState<string[]>(project.preferences.uiSettings?.buzzdetectSubsetNeurons ?? []);
  const [buzzdetectMinDetectionRate, setBuzzdetectMinDetectionRate] = useState<number>(project.preferences.uiSettings?.buzzdetectMinDetectionRate ?? DEFAULT_BUZZDETECT_MIN_DETECTION_RATE);
  const [buzzdetectPinnedNeurons, setBuzzdetectPinnedNeurons] = useState<string[]>(project.preferences.uiSettings?.buzzdetectPinnedNeurons ?? []);
  const [buzzdetectPanelHeight, setBuzzdetectPanelHeight] = useState(DEFAULT_BUZZDETECT_PANEL_HEIGHT);
  const [buzzdetectData, setBuzzdetectData] = useState<BuzzdetectData | null>(null);
  const [buzzdetectSettingsOpen, setBuzzdetectSettingsOpen] = useState(false);
  const [buzzdetectYAxisOverride, setBuzzdetectYAxisOverride] = useState<{ min: number; max: number } | null>(null);
  const [buzzdetectAutoBinWidth, setBuzzdetectAutoBinWidth] = useState(0);
  const [buzzdetectAutoYRange, setBuzzdetectAutoYRange] = useState<{ min: number; max: number } | null>(null);

  // Each file starts from its own auto Y-range rather than inheriting a manual
  // override typed against a different file's activations.
  useEffect(() => { setBuzzdetectYAxisOverride(null); }, [buzzdetectData]);

  // A series-mode flip resets both overrides: an activation and a detection
  // rate aren't in comparable units, so neither a pinned Y-range nor a pinned
  // bin width carries over meaningfully. Skipped on mount, so loading a project
  // with a persisted bin width doesn't immediately wipe it.
  const seriesModeMountedRef = useRef(false);
  useEffect(() => {
    if (!seriesModeMountedRef.current) { seriesModeMountedRef.current = true; return; }
    setBuzzdetectYAxisOverride(null);
    setBuzzdetectBinWidthOverride(null);
  }, [buzzdetectSeriesMode]);

  // Load buzzdetect activations for the current track, located by ident under
  // the configured buzzdetect directory. `cancelled` guards against the track
  // changing while the read is in flight.
  useEffect(() => {
    const dir = project.buzzdetectDirectoryAbs;
    if (!dir || !ident) { setBuzzdetectData(null); return; }
    let cancelled = false;
    setBuzzdetectData(null);
    readBuzzdetect(dir, ident, project.settings.buzzdetectFrameLength)
      .then(d => { if (!cancelled) setBuzzdetectData(d); })
      .catch(err => { if (!cancelled) { setBuzzdetectData(null); addLog(`buzzdetect load error: ${err}`, 'error'); } });
    return () => { cancelled = true; };
  }, [ident, project.buzzdetectDirectoryAbs, project.settings.buzzdetectFrameLength]); // eslint-disable-line react-hooks/exhaustive-deps

  // buzzdetect panel callbacks.
  const handleBuzzdetectThresholdChange = useCallback((neuron: string, value: number) => {
    setBuzzdetectThresholds(prev => ({ ...prev, [neuron]: value }));
  }, []);
  const handleBuzzdetectSubsetThresholdChange = useCallback((neuron: string, value: number | null) => {
    setBuzzdetectSubsetThresholds(prev => {
      if (value === null) {
        if (!(neuron in prev)) return prev;
        const next = { ...prev };
        delete next[neuron];
        return next;
      }
      return { ...prev, [neuron]: value };
    });
  }, []);
  const handleBuzzdetectToggleNeuron = useCallback((neuron: string, wasEnabled: boolean) => {
    setBuzzdetectHiddenNeurons(prev => wasEnabled ? [...prev, neuron] : prev.filter(n => n !== neuron));
  }, []);
  const handleBuzzdetectNeuronColorChange = useCallback((neuron: string, color: string) => {
    setBuzzdetectNeuronColors(prev => ({ ...prev, [neuron]: color }));
  }, []);
  // Ticking the first neuron engages the subset outright: picking one is the
  // user saying what they want to see, and making them then find a second
  // switch would be a step with no decision in it.
  const handleBuzzdetectToggleSubsetNeuron = useCallback((neuron: string, willSubset: boolean) => {
    setBuzzdetectSubsetNeurons(prev => {
      const next = willSubset ? [...prev, neuron] : prev.filter(n => n !== neuron);
      if (next.length > 0) setBuzzdetectSubsetEnabled(true);
      return next;
    });
  }, []);
  const handleBuzzdetectSetAllNeuronsHidden = useCallback((neurons: string[], hidden: boolean) => {
    setBuzzdetectHiddenNeurons(hidden ? neurons : []);
  }, []);
  // Appended rather than prepended, so the pinned block reads in the order the
  // user built it up rather than reshuffling every time they pin one more.
  const handleBuzzdetectTogglePinNeuron = useCallback((neuron: string) => {
    setBuzzdetectPinnedNeurons(prev => prev.includes(neuron) ? prev.filter(n => n !== neuron) : [...prev, neuron]);
  }, []);
  // Hides exactly the file's own neurons, so a label from a previously loaded
  // file never lingers in hiddenNeurons (same reason as setAllNeuronsHidden).
  const handleBuzzdetectSoloNeuron = useCallback((neurons: string[], neuron: string) => {
    setBuzzdetectHiddenNeurons(neurons.filter(n => n !== neuron));
  }, []);
  const toggleBuzzdetectSubset = useCallback(() => {
    setBuzzdetectSubsetEnabled(prev => {
      if (!prev && buzzdetectSubsetNeurons.length === 0) return false;
      return !prev;
    });
  }, [buzzdetectSubsetNeurons.length]);

  return {
    buzzdetectEnabled,
    setBuzzdetectEnabled,
    buzzdetectThresholds,
    setBuzzdetectThresholds,
    buzzdetectSubsetThresholds,
    setBuzzdetectSubsetThresholds,
    buzzdetectHiddenNeurons,
    setBuzzdetectHiddenNeurons,
    buzzdetectNeuronColors,
    setBuzzdetectNeuronColors,
    buzzdetectSeriesMode,
    setBuzzdetectSeriesMode,
    buzzdetectBinWidthOverride,
    setBuzzdetectBinWidthOverride,
    buzzdetectSubsetEnabled,
    setBuzzdetectSubsetEnabled,
    buzzdetectSubsetNeurons,
    setBuzzdetectSubsetNeurons,
    buzzdetectMinDetectionRate,
    setBuzzdetectMinDetectionRate,
    buzzdetectPinnedNeurons,
    setBuzzdetectPinnedNeurons,
    buzzdetectPanelHeight,
    setBuzzdetectPanelHeight,
    buzzdetectData,
    setBuzzdetectData,
    buzzdetectSettingsOpen,
    setBuzzdetectSettingsOpen,
    buzzdetectYAxisOverride,
    setBuzzdetectYAxisOverride,
    buzzdetectAutoBinWidth,
    setBuzzdetectAutoBinWidth,
    buzzdetectAutoYRange,
    setBuzzdetectAutoYRange,
    handleBuzzdetectThresholdChange,
    handleBuzzdetectSubsetThresholdChange,
    handleBuzzdetectToggleNeuron,
    handleBuzzdetectNeuronColorChange,
    handleBuzzdetectToggleSubsetNeuron,
    handleBuzzdetectTogglePinNeuron,
    handleBuzzdetectSoloNeuron,
    toggleBuzzdetectSubset,
    handleBuzzdetectSetAllNeuronsHidden,
  };
}
