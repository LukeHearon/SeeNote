import React, { useState, useEffect, useRef, useCallback, MutableRefObject } from 'react';
import { BandPassFilter, Project, ProjectPreferences } from '../types';
import { DEFAULT_BAND_PASS_FILTER } from '../constants';
import { AudioEngine } from '../utils/AudioEngine';
import { ActivationStackApi } from './useActivationStack';

export interface BandPassFilterApi {
  filterToolActive: boolean;
  setFilterToolActive: React.Dispatch<React.SetStateAction<boolean>>;
  bandPassFilter: BandPassFilter | null;
  setBandPassFilter: React.Dispatch<React.SetStateAction<BandPassFilter | null>>;
  filterStrength: number;
  setFilterStrength: React.Dispatch<React.SetStateAction<number>>;
  handleToggleFilterTool: () => void;
  engageBandPassFilter: (band?: BandPassFilter | null, strengthOverride?: number) => void;
  handleToggleFilterState: () => void;
  handleDisableBandPassFilter: () => void;
  handleEnableBandPassFilter: (strength: number) => void;
  handleBandPassFilterDrawn: (f: BandPassFilter) => void;
}

export interface BandPassFilterParams {
  project: Project;
  engineRef: MutableRefObject<AudioEngine | null>;
  activationStack: ActivationStackApi;
  projectRef: MutableRefObject<Project>;
  // Shared with AnnotationWindow's other persist effects: gates persistence off
  // until the project-change reset has run for this project id.
  prevProjectIdRef: MutableRefObject<string | null>;
  updateProjectPreferences: (id: string, preferences: ProjectPreferences) => Promise<Project | undefined>;
}

/**
 * Self-contained band-pass filter state machine. Holds the filter tool / band /
 * strength state, the engine-push + persistence effects, and every handler that
 * AnnotationWindow wires to Spectrogram and Toolbar. Coupled to the audio engine
 * (engine-push effect) and the project (debounced persistence), so those are
 * passed in.
 */
export function useBandPassFilter({
  project,
  engineRef,
  activationStack,
  projectRef,
  prevProjectIdRef,
  updateProjectPreferences,
}: BandPassFilterParams): BandPassFilterApi {
  const [filterToolActive, setFilterToolActive] = useState(false);
  const [bandPassFilter, setBandPassFilter] = useState<BandPassFilter | null>(project.preferences.bandPassFilter ?? null);
  const [filterStrength, setFilterStrength] = useState(project.preferences.bandPassFilter?.strength ?? 0.5);
  // Last active band saved so F can restore it after toggling off.
  const lastBandPassFilterRef = useRef<BandPassFilter | null>(null);

  // Keep filterStrength and bandPassFilter.strength in lockstep so the strength
  // slider reflects (and can edit) whichever is current. The slider is the
  // single source of truth — if a band exists, copy its strength back into the
  // shared state on creation/edit; the engine sync below picks up the result.
  useEffect(() => {
    if (bandPassFilter && bandPassFilter.strength !== filterStrength) {
      setBandPassFilter({ ...bandPassFilter, strength: filterStrength });
    }
  }, [filterStrength]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push the active band-pass filter into the engine. Non-null = apply;
  // null = bypass. Drawing a band sets it; slider to 0 or Esc clears it.
  useEffect(() => {
    engineRef.current?.setBandPassFilter(bandPassFilter);
  }, [bandPassFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist bandPassFilter changes to the project file (debounced).
  const filterPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (filterPersistRef.current) clearTimeout(filterPersistRef.current);
    filterPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      updateProjectPreferences(projectRef.current.id, { ...projectRef.current.preferences, bandPassFilter: bandPassFilter ?? null });
    }, 600);
    return () => {
      if (filterPersistRef.current) clearTimeout(filterPersistRef.current);
    };
  }, [bandPassFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // `Shift+F` and the filter-tool tile: toggle filter-tool readiness ONLY. Audio
  // filtering is governed by bandPassFilter being non-null.
  const handleToggleFilterTool = useCallback(() => {
    setFilterToolActive(prev => {
      const next = !prev;
      if (next) activationStack.pushIfAbsent('filterTool');
      else activationStack.remove('filterTool');
      return next;
    });
  }, [activationStack]);

  // Canonical "engage filter" path. Every code path that turns the filter on
  // — F key, slider drag-up-from-0, spectrogram drag-draw — funnels through
  // here so the band state, slider value, activation stack, and visualization
  // gate stay in lockstep. Geometry: caller's band if given, else the last
  // band we remember, else the project default. Strength: caller's override
  // if given, else the band's own strength.
  const engageBandPassFilter = useCallback(
    (band?: BandPassFilter | null, strengthOverride?: number) => {
      const base = band ?? lastBandPassFilterRef.current ?? DEFAULT_BAND_PASS_FILTER;
      const next = { ...base, strength: strengthOverride ?? base.strength };
      lastBandPassFilterRef.current = next;
      setBandPassFilter(next);
      setFilterStrength(next.strength);
      activationStack.pushIfAbsent('filterBand');
    },
    [activationStack]
  );

  // `F`: toggle filter state on/off. On-turn engages via the canonical path
  // (restores last band, or falls back to the default); off-turn snapshots
  // and clears. Mirrors the Z key pattern for video zoom.
  const handleToggleFilterState = useCallback(() => {
    if (bandPassFilter !== null) {
      lastBandPassFilterRef.current = bandPassFilter;
      setBandPassFilter(null);
      activationStack.remove('filterBand');
    } else {
      engageBandPassFilter();
    }
  }, [bandPassFilter, engageBandPassFilter, activationStack]);

  // Filter "off" path — snapshots the band to `lastBandPassFilterRef` so it can
  // be restored, clears the band (disabling filtering), and pulls `filterBand`
  // out of the stack. Called by slider-to-0, Esc-on-band, and explicit disable.
  const handleDisableBandPassFilter = useCallback(() => {
    setBandPassFilter(prev => {
      if (prev) lastBandPassFilterRef.current = prev;
      return null;
    });
    activationStack.remove('filterBand');
  }, [activationStack]);

  // Drag-up-from-0 path: slider/wheel re-enabled filtering while the band was
  // off. Engages at the user's chosen strength via the canonical path.
  const handleEnableBandPassFilter = useCallback((strength: number) => {
    engageBandPassFilter(undefined, strength);
  }, [engageBandPassFilter]);

  // Called by Spectrogram when a band-drag completes (new band drawn).
  const handleBandPassFilterDrawn = useCallback((f: BandPassFilter) => {
    engageBandPassFilter(f);
  }, [engageBandPassFilter]);

  return {
    filterToolActive,
    setFilterToolActive,
    bandPassFilter,
    setBandPassFilter,
    filterStrength,
    setFilterStrength,
    handleToggleFilterTool,
    engageBandPassFilter,
    handleToggleFilterState,
    handleDisableBandPassFilter,
    handleEnableBandPassFilter,
    handleBandPassFilterDrawn,
  };
}
