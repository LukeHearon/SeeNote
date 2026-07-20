import { useEffect, useRef } from 'react';
import { Project, ProjectPreferences, SpectrogramSettings, ProjectUiSettings, VideoMode } from '../types';

interface UseProjectPersistenceArgs {
  project: Project;
  projectRef: React.MutableRefObject<Project>;
  prevProjectIdRef: React.MutableRefObject<string | null>;
  trackPathRef: React.MutableRefObject<string | null>;
  updateProjectPreferences: (id: string, preferences: ProjectPreferences) => Promise<Project | undefined>;
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
  buzzdetectHiddenNeurons: string[];
  videoMode: VideoMode;
  videoBrightness: number;
  videoContrast: number;
  // Panel layout.
  playheadLocked: boolean;
  filePanelCollapsed: boolean;
  videoCollapsed: boolean;
  splitRatio: number;
  leftPanelRatio: number;
  leftPanelWidth: number;
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
  buzzdetectHiddenNeurons,
  videoMode,
  videoBrightness,
  videoContrast,
  playheadLocked,
  filePanelCollapsed,
  videoCollapsed,
  splitRatio,
  leftPanelRatio,
  leftPanelWidth,
}: UseProjectPersistenceArgs) {
  const settingsPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiPersistRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    settingsPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      updateProjectPreferences(projectRef.current.id, { ...projectRef.current.preferences, spectrogramSettings: settings });
    }, 800);
    return () => {
      if (settingsPersistRef.current) clearTimeout(settingsPersistRef.current);
    };
  }, [settings]);

  // Consolidated UI persistence — every persisted UI field flows through this
  // single debounced effect, so the project file only gets one write per
  // settling burst regardless of which slider/handle moved.
  useEffect(() => {
    if (prevProjectIdRef.current !== project.id) return;
    if (uiPersistRef.current) clearTimeout(uiPersistRef.current);
    uiPersistRef.current = setTimeout(() => {
      if (!projectRef.current) return;
      // Store the active track relative to the media directory so the saved
      // value survives the user moving or renaming the project root.
      const cur = trackPathRef.current;
      const audioRoot = projectRef.current.mediaDirectoryAbs;
      const activeTrackPath = cur && audioRoot && cur.startsWith(audioRoot + '/')
        ? cur.substring(audioRoot.length + 1)
        : null;
      const uiSettings: ProjectUiSettings = {
        volume,
        playbackSpeed,
        lastDefinedSpeed,
        zoomSec,
        activeTrackPath,
        buzzdetectEnabled,
        buzzdetectThresholds,
        buzzdetectHiddenNeurons,
        videoMode,
        videoBrightness,
        videoContrast,
        playheadLocked,
        filePanelCollapsed,
        videoCollapsed,
        splitRatio,
        leftPanelRatio,
        leftPanelWidthRatio: window.innerWidth > 0 ? leftPanelWidth / window.innerWidth : undefined,
      };
      updateProjectPreferences(projectRef.current.id, { ...projectRef.current.preferences, uiSettings });
    }, 600);
    return () => {
      if (uiPersistRef.current) clearTimeout(uiPersistRef.current);
    };
  }, [volume, playbackSpeed, lastDefinedSpeed, zoomSec, trackPath, buzzdetectEnabled, buzzdetectThresholds, buzzdetectHiddenNeurons, videoMode, videoBrightness, videoContrast, playheadLocked, filePanelCollapsed, videoCollapsed, splitRatio, leftPanelRatio, leftPanelWidth]);
}
