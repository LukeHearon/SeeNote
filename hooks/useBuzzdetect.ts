import React, { useState, useEffect, useCallback } from 'react';
import { BuzzdetectData, Project } from '../types';
import { DEFAULT_BUZZDETECT_PANEL_HEIGHT } from '../constants';
import { readBuzzdetect } from '../utils/tauriCommands';

export interface BuzzdetectApi {
  buzzdetectEnabled: boolean;
  setBuzzdetectEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  buzzdetectThresholds: Record<string, number>;
  setBuzzdetectThresholds: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  buzzdetectHiddenNeurons: string[];
  setBuzzdetectHiddenNeurons: React.Dispatch<React.SetStateAction<string[]>>;
  buzzdetectPanelHeight: number;
  setBuzzdetectPanelHeight: React.Dispatch<React.SetStateAction<number>>;
  buzzdetectData: BuzzdetectData | null;
  setBuzzdetectData: React.Dispatch<React.SetStateAction<BuzzdetectData | null>>;
  handleBuzzdetectThresholdChange: (neuron: string, value: number) => void;
  handleBuzzdetectToggleNeuron: (neuron: string, wasEnabled: boolean) => void;
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

  return {
    buzzdetectEnabled,
    setBuzzdetectEnabled,
    buzzdetectThresholds,
    setBuzzdetectThresholds,
    buzzdetectHiddenNeurons,
    setBuzzdetectHiddenNeurons,
    buzzdetectPanelHeight,
    setBuzzdetectPanelHeight,
    buzzdetectData,
    setBuzzdetectData,
    handleBuzzdetectThresholdChange,
    handleBuzzdetectToggleNeuron,
  };
}
