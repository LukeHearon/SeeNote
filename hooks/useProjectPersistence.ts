import { useEffect } from 'react';
import { useFlushableDebounce } from './useFlushableDebounce';
import { Project, SpectrogramSettings, ProjectUiSettings, VideoMode, BuzzdetectSeriesMode } from '../types';
import type { TimeDisplayUnit, ElapsedTimeDisplayUnit } from '../utils/helpers';
import type { UpdateProjectPreferences } from '../utils/projectPreferences';

interface UseProjectPersistenceArgs {
  project: Project;
  projectRef: React.MutableRefObject<Project>;
  prevProjectIdRef: React.MutableRefObject<string | null>;
  trackPathRef: React.MutableRefObject<string | null>;
  updateProjectPreferences: UpdateProjectPreferences;
  // Spectrogram settings persist input.
  settings: SpectrogramSettings;
  // Consolidated UI persist inputs.
  volume: number;
  playbackSpeed: number;
  lastDefinedSpeed: number;
  zoomSec: number;
  trackPath: string | null;
  buzzdetectEnabled: boolean;
  buzzdetectThresholds: Record<string, number>;
  buzzdetectSubsetThresholds: Record<string, number>;
  buzzdetectHiddenNeurons: string[];
  buzzdetectNeuronColors: Record<string, string>;
  buzzdetectSeriesMode: BuzzdetectSeriesMode;
  buzzdetectBinWidthOverride: number | null;
  buzzdetectSubsetEnabled: boolean;
  buzzdetectMinDetectionRate: number;
  buzzdetectSubsetBuffer: number;
  buzzdetectPinnedNeurons: string[];
  videoMode: VideoMode;
  videoBrightness: number;
  videoContrast: number;
  // Panel layout.
  playheadLocked: boolean;
  timeDisplayUnit: TimeDisplayUnit;
  fallbackTimeDisplayUnit: ElapsedTimeDisplayUnit;
  filePanelCollapsed: boolean;
  videoCollapsed: boolean;
  splitRatio: number;
  sidebarSections: Record<string, { weight: number; collapsed: boolean }>;
  leftPanelWidth: number;
  findPanelWidth: number;
}

// Owns the two debounced "persist UI/settings to the project file" effects that
// used to live in AnnotationWindow. Side-effect-only — both effects keep their
// original debounce durations and dependency arrays so write batching is
// unchanged. The project-switch guard (`prevProjectIdRef`) stays external and is
// shared with the tool-folder reconcile effect.
export function useProjectPersistence({
  project,
  projectRef,
  prevProjectIdRef,
  trackPathRef,
  updateProjectPreferences,
  settings,
  volume,
  playbackSpeed,
  lastDefinedSpeed,
  zoomSec,
  trackPath,
  buzzdetectEnabled,
  buzzdetectThresholds,
  buzzdetectSubsetThresholds,
  buzzdetectHiddenNeurons,
  buzzdetectNeuronColors,
  buzzdetectSeriesMode,
  buzzdetectBinWidthOverride,
  buzzdetectSubsetEnabled,
  buzzdetectMinDetectionRate,
  buzzdetectSubsetBuffer,
  buzzdetectPinnedNeurons,
  videoMode,
  videoBrightness,
  videoContrast,
  playheadLocked,
  timeDisplayUnit,
  fallbackTimeDisplayUnit,
  filePanelCollapsed,
  videoCollapsed,
  splitRatio,
  sidebarSections,
  leftPanelWidth,
  findPanelWidth,
}: UseProjectPersistenceArgs) {
  const settingsDebounce = useFlushableDebounce();
  const uiDebounce = useFlushableDebounce();

  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    // Id captured now: the write must not follow projectRef to a different project.
    const id = project.id;
    settingsDebounce.schedule(() => {
      updateProjectPreferences(id, { spectrogramSettings: settings });
    }, 800);
  }, [settings]);

  // Consolidated UI persistence — every persisted UI field flows through this
  // single debounced effect, so the project file only gets one write per
  // settling burst regardless of which slider/handle moved.
  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    const id = project.id;
    uiDebounce.schedule(() => {
      if (!projectRef.current) return;
      // Store the active track relative to the media directory so the saved
      // value survives the user moving or renaming the project root. Left out
      // (not written as null) while no track is open: before the initial open
      // resolves — slow on external drives — that would erase the saved track.
      const cur = trackPathRef.current;
      const audioRoot = projectRef.current.mediaDirectoryAbs;
      const activeTrackPath = cur && audioRoot && cur.startsWith(audioRoot + '/')
        ? cur.substring(audioRoot.length + 1)
        : undefined;
      const uiSettings: ProjectUiSettings = {
        volume,
        playbackSpeed,
        lastDefinedSpeed,
        zoomSec,
        ...(activeTrackPath !== undefined ? { activeTrackPath } : {}),
        buzzdetectEnabled,
        buzzdetectThresholds,
        buzzdetectSubsetThresholds,
        buzzdetectHiddenNeurons,
        buzzdetectNeuronColors,
        buzzdetectSeriesMode,
        buzzdetectBinWidthOverride,
        buzzdetectSubsetEnabled,
        buzzdetectMinDetectionRate,
        buzzdetectSubsetBuffer,
        buzzdetectPinnedNeurons,
        videoMode,
        videoBrightness,
        videoContrast,
        playheadLocked,
        timeDisplayUnit,
        fallbackTimeDisplayUnit,
        filePanelCollapsed,
        videoCollapsed,
        splitRatio,
        sidebarSections,
        leftPanelWidthRatio: window.innerWidth > 0 ? leftPanelWidth / window.innerWidth : undefined,
        findPanelWidthRatio: window.innerWidth > 0 ? findPanelWidth / window.innerWidth : undefined,
      };
      updateProjectPreferences(id, { uiSettings });
    }, 600);
  }, [volume, playbackSpeed, lastDefinedSpeed, zoomSec, trackPath, buzzdetectEnabled, buzzdetectThresholds, buzzdetectSubsetThresholds, buzzdetectHiddenNeurons, buzzdetectNeuronColors, buzzdetectSeriesMode, buzzdetectBinWidthOverride, buzzdetectSubsetEnabled, buzzdetectMinDetectionRate, buzzdetectSubsetBuffer, buzzdetectPinnedNeurons, videoMode, videoBrightness, videoContrast, playheadLocked, timeDisplayUnit, fallbackTimeDisplayUnit, filePanelCollapsed, videoCollapsed, splitRatio, sidebarSections, leftPanelWidth, findPanelWidth]);
}
