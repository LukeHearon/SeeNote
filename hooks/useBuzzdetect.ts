import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { BuzzdetectData, BuzzdetectSeriesMode, Project, ProjectUiSettings } from '../types';
import {
  DEFAULT_BUZZDETECT_PANEL_HEIGHT,
  DEFAULT_BUZZDETECT_MIN_DETECTION_RATE,
  DEFAULT_BUZZDETECT_SUBSET_BUFFER,
  DEFAULT_BUZZDETECT_THRESHOLD,
} from '../constants';
import { readBuzzdetect } from '../utils/tauriCommands';

/**
 * Subset picks used to be a list of neuron labels beside an optional per-neuron
 * subset threshold; they're now the KEYS of that threshold map, so there's one
 * place a pick can live. Projects saved before the change carry the old list,
 * so fold it in: a picked neuron with no subset threshold of its own inherits
 * the detection threshold it was previously cut at.
 */
function migrateSubsetThresholds(ui: ProjectUiSettings | undefined): Record<string, number> {
  const subset = { ...(ui?.buzzdetectSubsetThresholds ?? {}) };
  for (const n of ui?.buzzdetectSubsetNeurons ?? []) {
    if (!(n in subset)) subset[n] = ui?.buzzdetectThresholds?.[n] ?? DEFAULT_BUZZDETECT_THRESHOLD;
  }
  return subset;
}

export interface BuzzdetectApi {
  buzzdetectEnabled: boolean;
  setBuzzdetectEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  buzzdetectThresholds: Record<string, number>;
  setBuzzdetectThresholds: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  /**
   * Per-neuron threshold the SUBSET is cut at — the palette's "Subset at" box.
   * An entry here is what makes a neuron part of the subset, so this map's keys
   * are the picked neurons and there is no second list to keep in step with it.
   * Separate from the detection threshold, which stays about the graph.
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
  /** Neuron labels the subset is keyed to — the keys of buzzdetectSubsetThresholds. */
  buzzdetectSubsetNeurons: string[];
  buzzdetectMinDetectionRate: number;
  setBuzzdetectMinDetectionRate: React.Dispatch<React.SetStateAction<number>>;
  /** Seconds of context kept either side of each subset bin. 0 = none. */
  buzzdetectSubsetBuffer: number;
  setBuzzdetectSubsetBuffer: React.Dispatch<React.SetStateAction<number>>;
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
  /** null clears the value, taking the neuron out of the subset entirely. */
  handleBuzzdetectSubsetThresholdChange: (neuron: string, value: number | null) => void;
  handleBuzzdetectToggleNeuron: (neuron: string, wasEnabled: boolean) => void;
  handleBuzzdetectNeuronColorChange: (neuron: string, color: string) => void;
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
  const [buzzdetectSubsetThresholds, setBuzzdetectSubsetThresholds] = useState<Record<string, number>>(
    () => migrateSubsetThresholds(project.preferences.uiSettings),
  );
  const [buzzdetectHiddenNeurons, setBuzzdetectHiddenNeurons] = useState<string[]>(project.preferences.uiSettings?.buzzdetectHiddenNeurons ?? []);
  const [buzzdetectNeuronColors, setBuzzdetectNeuronColors] = useState<Record<string, string>>(project.preferences.uiSettings?.buzzdetectNeuronColors ?? {});
  const [buzzdetectSeriesMode, setBuzzdetectSeriesMode] = useState<BuzzdetectSeriesMode>(project.preferences.uiSettings?.buzzdetectSeriesMode ?? 'activation');
  const [buzzdetectBinWidthOverride, setBuzzdetectBinWidthOverride] = useState<number | null>(project.preferences.uiSettings?.buzzdetectBinWidthOverride ?? null);
  // Subset mode's master toggle — "subset by everything" vs "subset by
  // nothing". Kept apart from the picks (the subset thresholds above) so
  // flipping the subset off and on again doesn't cost the user their selection.
  const [buzzdetectSubsetEnabled, setBuzzdetectSubsetEnabled] = useState(project.preferences.uiSettings?.buzzdetectSubsetEnabled ?? false);
  const [buzzdetectMinDetectionRate, setBuzzdetectMinDetectionRate] = useState<number>(project.preferences.uiSettings?.buzzdetectMinDetectionRate ?? DEFAULT_BUZZDETECT_MIN_DETECTION_RATE);
  const [buzzdetectSubsetBuffer, setBuzzdetectSubsetBuffer] = useState<number>(project.preferences.uiSettings?.buzzdetectSubsetBuffer ?? DEFAULT_BUZZDETECT_SUBSET_BUFFER);
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
  // Typing a subset threshold IS picking the neuron, so the first one engages
  // the subset outright: naming what you want to see is the whole decision, and
  // making the user then find a second switch would be a step with nothing in
  // it. Clearing the box un-picks the neuron.
  const handleBuzzdetectSubsetThresholdChange = useCallback((neuron: string, value: number | null) => {
    setBuzzdetectSubsetThresholds(prev => {
      if (value === null) {
        if (!(neuron in prev)) return prev;
        const next = { ...prev };
        delete next[neuron];
        return next;
      }
      setBuzzdetectSubsetEnabled(true);
      return { ...prev, [neuron]: value };
    });
  }, []);
  const handleBuzzdetectToggleNeuron = useCallback((neuron: string, wasEnabled: boolean) => {
    setBuzzdetectHiddenNeurons(prev => wasEnabled ? [...prev, neuron] : prev.filter(n => n !== neuron));
  }, []);
  const handleBuzzdetectNeuronColorChange = useCallback((neuron: string, color: string) => {
    setBuzzdetectNeuronColors(prev => ({ ...prev, [neuron]: color }));
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
  // The picks are the threshold map's keys — one place a pick can live, so a
  // typed "Subset at" value and the neuron being cut by can never disagree.
  const buzzdetectSubsetNeurons = useMemo(
    () => Object.keys(buzzdetectSubsetThresholds),
    [buzzdetectSubsetThresholds],
  );
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
    buzzdetectMinDetectionRate,
    setBuzzdetectMinDetectionRate,
    buzzdetectSubsetBuffer,
    setBuzzdetectSubsetBuffer,
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
    handleBuzzdetectTogglePinNeuron,
    handleBuzzdetectSoloNeuron,
    toggleBuzzdetectSubset,
    handleBuzzdetectSetAllNeuronsHidden,
  };
}
