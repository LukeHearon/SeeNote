import React, { useState, useEffect, useCallback } from 'react';
import { BuzzdetectData, BuzzdetectSeriesMode, Project } from '../types';
import { DEFAULT_BUZZDETECT_PANEL_HEIGHT, DEFAULT_BUZZDETECT_MIN_DETECTION_RATE } from '../constants';
import { readBuzzdetect } from '../utils/tauriCommands';

export interface BuzzdetectApi {
  buzzdetectEnabled: boolean;
  setBuzzdetectEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  buzzdetectThresholds: Record<string, number>;
  setBuzzdetectThresholds: React.Dispatch<React.SetStateAction<Record<string, number>>>;
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
  buzzdetectPanelHeight: number;
  setBuzzdetectPanelHeight: React.Dispatch<React.SetStateAction<number>>;
  buzzdetectData: BuzzdetectData | null;
  setBuzzdetectData: React.Dispatch<React.SetStateAction<BuzzdetectData | null>>;
  handleBuzzdetectThresholdChange: (neuron: string, value: number) => void;
  handleBuzzdetectToggleNeuron: (neuron: string, wasEnabled: boolean) => void;
  handleBuzzdetectNeuronColorChange: (neuron: string, color: string) => void;
  handleBuzzdetectToggleSubsetNeuron: (neuron: string, willSubset: boolean) => void;
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
  const [buzzdetectHiddenNeurons, setBuzzdetectHiddenNeurons] = useState<string[]>(project.preferences.uiSettings?.buzzdetectHiddenNeurons ?? []);
  const [buzzdetectNeuronColors, setBuzzdetectNeuronColors] = useState<Record<string, string>>(project.preferences.uiSettings?.buzzdetectNeuronColors ?? {});
  const [buzzdetectSeriesMode, setBuzzdetectSeriesMode] = useState<BuzzdetectSeriesMode>(project.preferences.uiSettings?.buzzdetectSeriesMode ?? 'activation');
  const [buzzdetectBinWidthOverride, setBuzzdetectBinWidthOverride] = useState<number | null>(project.preferences.uiSettings?.buzzdetectBinWidthOverride ?? null);
  // Subset mode. The neuron picks are kept separately from the master toggle so
  // flipping the subset off and on again doesn't cost the user their selection.
  const [buzzdetectSubsetEnabled, setBuzzdetectSubsetEnabled] = useState(project.preferences.uiSettings?.buzzdetectSubsetEnabled ?? false);
  const [buzzdetectSubsetNeurons, setBuzzdetectSubsetNeurons] = useState<string[]>(project.preferences.uiSettings?.buzzdetectSubsetNeurons ?? []);
  const [buzzdetectMinDetectionRate, setBuzzdetectMinDetectionRate] = useState<number>(project.preferences.uiSettings?.buzzdetectMinDetectionRate ?? DEFAULT_BUZZDETECT_MIN_DETECTION_RATE);
  const [buzzdetectPanelHeight, setBuzzdetectPanelHeight] = useState(DEFAULT_BUZZDETECT_PANEL_HEIGHT);
  const [buzzdetectData, setBuzzdetectData] = useState<BuzzdetectData | null>(null);

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
    buzzdetectPanelHeight,
    setBuzzdetectPanelHeight,
    buzzdetectData,
    setBuzzdetectData,
    handleBuzzdetectThresholdChange,
    handleBuzzdetectToggleNeuron,
    handleBuzzdetectNeuronColorChange,
    handleBuzzdetectToggleSubsetNeuron,
    toggleBuzzdetectSubset,
    handleBuzzdetectSetAllNeuronsHidden,
  };
}
